/**
 * Keeps Jira status sync receiving events by extending its dynamic webhooks.
 *
 * Atlassian expires a dynamic webhook 30 days after it was created or last
 * refreshed, and nothing else extends it. Left alone, status sync stops with no
 * error surfaced anywhere, so each webhook is refreshed ten days before its
 * expiry, and a replacement is registered when Jira reports the webhook gone.
 *
 * ## Scheduling
 *
 * This is the deadline pattern from `jobs/deadlines.ts`, the one the snooze and
 * SLA sweeps use. The cron is per-minute and gated on a refresh being due, and
 * the deadline provider reports when the next refresh falls due. A workspace
 * whose webhooks are weeks from their refresh writes nothing and is not woken
 * for them, and a dormant workspace is woken at its refresh time rather than
 * lapsing while idle.
 *
 * ## State
 *
 * Everything lives in the integration's config, which is where the webhook id
 * already is:
 * - `externalWebhookId`: written at registration.
 * - `externalWebhookExpiresAt`: read back from the refresh response. Absent
 *   until the first refresh, which makes the webhook due at once.
 * - `externalWebhookRetryAt`: set after a failure, so a broken connection is
 *   retried hourly rather than on every tick.
 */
import type { IntegrationId } from '@quackback/ids'
import { and, db, eq, integrations } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import { dueWithin, registerWorkspaceDeadline } from '@/lib/server/jobs/deadlines'
import {
  deleteJiraWebhook,
  jiraProjectRef,
  refreshJiraWebhooks,
  registerJiraWebhook,
} from '@/integrations/jira/server/webhook-registration'
import { getIntegrationAuth } from './token-refresh'
import {
  buildWebhookCallbackUrl,
  clearIntegrationLastError,
  recordIntegrationLastError,
} from './webhook-registration'

const log = logger.child({ component: 'jira-webhook-refresh' })

const QUEUE = 'jira-webhook-refresh'
const DAY_MS = 86_400_000
/** The lifetime Atlassian gives a dynamic webhook after creation or refresh. */
const JIRA_WEBHOOK_LIFETIME_MS = 30 * DAY_MS
/** Refresh this far ahead of the expiry, which leaves room for retries. */
const REFRESH_LEAD_MS = 10 * DAY_MS
const RETRY_BACKOFF_MS = 60 * 60_000
/** Prefixes the error this job records, so it can clear only its own. */
const ERROR_PREFIX = 'Webhook refresh failed: '

export interface JiraStatusSyncRow {
  id: IntegrationId
  config: Record<string, unknown>
  lastError: string | null
}

export type RefreshOutcome = 'refreshed' | 'reregistered' | 'superseded'

export interface RefreshSummary {
  due: number
  refreshed: number
  reregistered: number
  superseded: number
  failed: number
}

function lifetimeFrom(now: Date): Date {
  return new Date(now.getTime() + JIRA_WEBHOOK_LIFETIME_MS)
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : time
}

/**
 * When this integration's webhook next needs a refresh, or null while status
 * sync is off. The epoch means "at the next run": the expiry is not known yet,
 * or there is no webhook id to refresh.
 */
export function jiraWebhookRefreshDueAt(config: Record<string, unknown>): Date | null {
  if (config.statusSyncEnabled !== true) return null
  const retryAt = parseTime(config.externalWebhookRetryAt) ?? 0
  if (nonEmpty(config.externalWebhookId) === null) return new Date(retryAt)
  const expiresAt = parseTime(config.externalWebhookExpiresAt)
  const fromExpiry = expiresAt === null ? 0 : expiresAt - REFRESH_LEAD_MS
  return new Date(Math.max(fromExpiry, retryAt))
}

async function readJiraStatusSyncRows(): Promise<JiraStatusSyncRow[]> {
  const rows = await db
    .select({
      id: integrations.id,
      config: integrations.config,
      lastError: integrations.lastError,
    })
    .from(integrations)
    .where(and(eq(integrations.integrationType, 'jira'), eq(integrations.status, 'active')))
  return rows.filter((row) => jiraWebhookRefreshDueAt(row.config) !== null)
}

async function nextJiraWebhookRefreshAt(): Promise<Date | null> {
  let earliest: Date | null = null
  for (const row of await readJiraStatusSyncRows()) {
    const due = jiraWebhookRefreshDueAt(row.config)
    if (due && (!earliest || due < earliest)) earliest = due
  }
  return earliest
}

registerWorkspaceDeadline(QUEUE, nextJiraWebhookRefreshAt)

/** The cron gate: is a webhook due inside the next slot? */
export function isJiraWebhookRefreshDue(): Promise<boolean> {
  return dueWithin(QUEUE, 60_000)
}

export async function runJiraWebhookRefresh(): Promise<void> {
  const summary = await refreshDueJiraWebhooks(await readJiraStatusSyncRows(), new Date())
  if (summary.due > 0) log.info(summary, 'jira webhook refresh complete')
}

/**
 * Refresh every row whose webhook is due at `now`. One integration's failure is
 * recorded against that integration and the loop moves on, so it cannot hold the
 * others back.
 */
export async function refreshDueJiraWebhooks(
  rows: readonly JiraStatusSyncRow[],
  now: Date,
  refresh: (row: JiraStatusSyncRow, now: Date) => Promise<RefreshOutcome> = refreshJiraWebhook
): Promise<RefreshSummary> {
  const summary: RefreshSummary = {
    due: 0,
    refreshed: 0,
    reregistered: 0,
    superseded: 0,
    failed: 0,
  }
  for (const row of rows) {
    const due = jiraWebhookRefreshDueAt(row.config)
    if (due === null || due.getTime() > now.getTime()) continue
    summary.due += 1
    try {
      const outcome = await refresh(row, now)
      summary[outcome] += 1
      if (outcome !== 'superseded' && row.lastError?.startsWith(ERROR_PREFIX)) {
        await clearIntegrationLastError(row.id)
      }
    } catch (err) {
      summary.failed += 1
      log.error({ err, integration_id: row.id }, 'jira webhook refresh failed')
      await recordFailure(row, now, err).catch((recordErr) =>
        log.error({ err: recordErr, integration_id: row.id }, 'could not record refresh failure')
      )
    }
  }
  return summary
}

async function refreshJiraWebhook(row: JiraStatusSyncRow, now: Date): Promise<RefreshOutcome> {
  const webhookId = nonEmpty(row.config.externalWebhookId)
  const auth = await getIntegrationAuth(row.id)
  const cloudId = nonEmpty(auth.config.cloudId)
  if (!cloudId) throw new Error('No Jira Cloud ID configured')
  if (!auth.accessToken) throw new Error('Reconnect the integration to refresh its Jira webhook')

  if (webhookId) {
    const refreshed = await refreshJiraWebhooks(auth.accessToken, cloudId, [webhookId])
    if (!refreshed.invalidWebhookIds.includes(webhookId)) {
      // An expiry that is not in the future would make the webhook due on every
      // tick, so it is not believed; the documented lifetime is used instead.
      const reported = refreshed.expiresAt
      const expiresAt =
        reported && reported.getTime() > now.getTime() ? reported : lifetimeFrom(now)
      const applied = await writeWebhookState(row.id, webhookId, { expiresAt, retryAt: null })
      return applied ? 'refreshed' : 'superseded'
    }
  }

  // Missing or gone: register a replacement the same way enabling status sync does.
  // A new webhook carries the documented lifetime, so it is not due again at once.
  const created = await registerJiraWebhook(
    auth.accessToken,
    cloudId,
    buildWebhookCallbackUrl('jira'),
    jiraProjectRef(auth.config.channelId)
  )
  const applied = await writeWebhookState(row.id, webhookId, {
    webhookId: created.webhookId,
    expiresAt: lifetimeFrom(now),
    retryAt: null,
  })
  if (applied) return 'reregistered'

  await deleteJiraWebhook(auth.accessToken, cloudId, created.webhookId).catch((err) =>
    log.warn({ err, integration_id: row.id }, 'could not delete a superseded jira webhook')
  )
  return 'superseded'
}

async function recordFailure(row: JiraStatusSyncRow, now: Date, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  const applied = await writeWebhookState(row.id, nonEmpty(row.config.externalWebhookId), {
    retryAt: new Date(now.getTime() + RETRY_BACKOFF_MS),
  })
  if (applied) await recordIntegrationLastError(row.id, `${ERROR_PREFIX}${message}`)
}

interface WebhookStateChange {
  webhookId?: string
  /** `null` removes the stored value; `undefined` leaves it alone. */
  expiresAt?: Date | null
  retryAt?: Date | null
}

function setOrRemove(config: Record<string, unknown>, key: string, value: Date | null | undefined) {
  if (value === undefined) return
  if (value === null) delete config[key]
  else config[key] = value.toISOString()
}

/**
 * Apply a change only while the webhook it was computed from is still the stored
 * one and status sync is still on. Returns false when nothing was written, so a
 * refresh that raced a reconnect or a disable cannot resurrect the old state.
 */
async function writeWebhookState(
  integrationId: IntegrationId,
  expectedWebhookId: string | null,
  change: WebhookStateChange
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ config: integrations.config })
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .for('update')
    if (!current) return false
    const config = (current.config ?? {}) as Record<string, unknown>
    if (config.statusSyncEnabled !== true) return false
    if (nonEmpty(config.externalWebhookId) !== expectedWebhookId) return false

    const next: Record<string, unknown> = { ...config }
    if (change.webhookId !== undefined) next.externalWebhookId = change.webhookId
    setOrRemove(next, 'externalWebhookExpiresAt', change.expiresAt)
    setOrRemove(next, 'externalWebhookRetryAt', change.retryAt)
    await tx
      .update(integrations)
      .set({ config: next, updatedAt: new Date() })
      .where(eq(integrations.id, integrationId))
    return true
  })
}
