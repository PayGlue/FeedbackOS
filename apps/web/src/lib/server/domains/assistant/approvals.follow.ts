/**
 * Following approvals from outside the app: the reads an API key or an
 * assistant client uses to see where a request stands, and the shape it reads
 * them in. Nothing here decides. A person decides in the app, on the page an
 * approval's `url` names.
 *
 * Who follows what. A caller reads:
 * - every request it filed: its credential (an API key; for an assistant
 *   client many people sign in through, that client together with the
 *   person signed in), and
 * - the requests the person it acts for could decide, judged with that
 *   person's current permissions narrowed to what the credential may do.
 * Anything else reads as not found, the same as a request that does not
 * exist, so an id tells a caller nothing about requests it may not read.
 *
 * Every title and summary is written by the server. A settings request lists
 * its changes; an assistant action is shown by its label and lists none,
 * because its content can quote what a customer wrote.
 */
import {
  db,
  and,
  or,
  eq,
  gt,
  lt,
  lte,
  desc,
  like,
  sql,
  inArray,
  principal,
  assistantPendingActions,
  type ApprovalDecisionChannel,
  type ApprovalRequestChannel,
  type ApprovalRisk,
} from '@/lib/server/db'
import type { AssistantPendingActionId, PrincipalId } from '@quackback/ids'
import type { Actor } from '@/lib/server/policy/types'
import { permissionsForPrincipal, resolveActorPermissions } from '@/lib/server/policy/permissions'
import { getBaseUrl } from '@/lib/server/config'
import {
  API_KEY_SCOPES,
  permissionsWithinScopes,
  type ApiKeyScope,
} from '@/lib/shared/api-key-scopes'
import { isTeamMember } from '@/lib/shared/roles'
import { approvalPath, type ApprovalStatus } from '@/lib/shared/assistant/approvals'
import { settingsProposalSchema } from '@/lib/shared/assistant/settings-proposals'
import type { JsonValue } from '@/lib/shared/json'
import { SETTINGS_PROPOSAL_TOOL, summarizeSettingsProposal } from './approval-policy'
import { approvalNotFound, approvalRiskOf, isDecidableApproval } from './approvals.service'
import { approvalRequirements, parentVisible, qualifiesToDecide } from './approvals.queue'

type PendingActionRow = typeof assistantPendingActions.$inferSelect

/** One field a settings request changes. */
export interface ApprovalChange {
  /** The setting, such as `messenger.enabled`. */
  field: string
  from: JsonValue
  to: JsonValue
}

/** An approval as API and MCP clients read it. */
export interface PublicApproval {
  id: string
  status: ApprovalStatus
  risk: ApprovalRisk
  toolName: string
  title: string
  summary: string
  changes: ApprovalChange[]
  conversationId: string | null
  ticketId: string | null
  requestedVia: ApprovalRequestChannel
  requestedById: string | null
  onBehalfOfPrincipalId: string | null
  clientName: string | null
  createdAt: string
  expiresAt: string
  decidedById: string | null
  decidedAt: string | null
  decidedVia: ApprovalDecisionChannel | null
  /** Why the person rejected it. */
  reason: string | null
  /** The in-app page a person opens to decide it. */
  url: string
}

/** A page of approvals, newest first. */
export interface ApprovalPage {
  items: PublicApproval[]
  /** The id to pass as `cursor` for the next page, or null on the last one. */
  nextCursor: string | null
  hasMore: boolean
}

/** Who is following, and through what. */
export interface ApprovalFollower {
  /**
   * The requests this caller filed: those its credential filed, and, when
   * many people share the credential (an assistant client), only those filed
   * for the person signed in. Null when the caller has no credential to match.
   */
  filed: { credentialId: string; onBehalfOfPrincipalId?: PrincipalId } | null
  /**
   * The person the caller acts for, with their current permissions narrowed
   * to what the credential may do. Null when that person is no longer a
   * teammate, so the caller reads only what it filed.
   */
  decider: Actor | null
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
/** Rows read per round before the per-row permission check. */
const SCAN_BATCH = 200
/** The disposition prefix of a request a newer, combined one replaced. */
const SUPERSEDED = 'superseded'

/** The in-app page a person opens to decide this approval, as an absolute url. */
export function approvalUrl(id: string): string {
  return `${getBaseUrl().replace(/\/$/, '')}${approvalPath(id)}`
}

/** An approval's state as clients read it. */
export function approvalStatusOf(
  row: Pick<PendingActionRow, 'status' | 'expiresAt' | 'disposition'>,
  now: number = Date.now()
): ApprovalStatus {
  switch (row.status) {
    case 'proposed':
      return row.expiresAt.getTime() > now ? 'pending' : 'expired'
    case 'expired':
      return row.disposition?.startsWith(SUPERSEDED) ? 'superseded' : 'expired'
    case 'executed':
      return 'applied'
    case 'approved':
    case 'rejected':
    case 'failed':
      return row.status
  }
}

/** Rows in one client-facing state, matching approvalStatusOf. */
function statusFilter(status: ApprovalStatus | undefined, now: Date) {
  const table = assistantPendingActions
  switch (status) {
    case undefined:
      return undefined
    case 'pending':
      return and(eq(table.status, 'proposed'), gt(table.expiresAt, now))
    case 'expired':
      return or(
        and(eq(table.status, 'proposed'), lte(table.expiresAt, now)),
        and(
          eq(table.status, 'expired'),
          sql`coalesce(${table.disposition}, '') NOT LIKE ${`${SUPERSEDED}%`}`
        )
      )
    case 'superseded':
      return and(eq(table.status, 'expired'), like(table.disposition, `${SUPERSEDED}%`))
    case 'applied':
      return eq(table.status, 'executed')
    case 'approved':
    case 'rejected':
    case 'failed':
      return eq(table.status, status)
  }
}

const REQUESTED_BY: Record<ApprovalRequestChannel, string> = {
  assistant: 'by the assistant',
  ui: 'in the app',
  api: 'through the API',
  mcp: 'through MCP',
  workflow: 'by a workflow',
}

/** The title, summary and changes of a request, all written by the server. */
async function describeRequest(
  row: PendingActionRow
): Promise<Pick<PublicApproval, 'title' | 'summary' | 'changes'>> {
  if (row.toolName === SETTINGS_PROPOSAL_TOOL) {
    const parsed = settingsProposalSchema.safeParse(row.args)
    if (parsed.success)
      return {
        title: 'Settings change',
        summary: summarizeSettingsProposal(parsed.data),
        changes: parsed.data.changes.map((change) => ({
          field: change.id,
          from: change.before as JsonValue,
          to: change.after as JsonValue,
        })),
      }
  }
  const { getToolSpecByName } = await import('./assistant.toolspec')
  const where = row.conversationId ? ' in a conversation' : row.ticketId ? ' on a ticket' : ''
  return {
    title: getToolSpecByName(row.toolName)?.label ?? 'Assistant action',
    summary: `Proposed ${REQUESTED_BY[row.requestedVia ?? 'assistant']}${where}.`,
    changes: [],
  }
}

/** One approval as clients read it. Never the stored content beyond a settings diff. */
export async function toPublicApproval(row: PendingActionRow): Promise<PublicApproval> {
  return {
    id: row.id,
    status: approvalStatusOf(row),
    risk: approvalRiskOf(row),
    toolName: row.toolName,
    ...(await describeRequest(row)),
    conversationId: row.conversationId,
    ticketId: row.ticketId,
    // A request filed before its channel was recorded came from the assistant.
    requestedVia: row.requestedVia ?? 'assistant',
    requestedById: row.requestedById,
    onBehalfOfPrincipalId: row.onBehalfOfPrincipalId,
    clientName: row.clientName,
    createdAt: row.proposedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedById: row.decidedById,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedVia: row.decidedVia,
    reason: row.decisionReason,
    url: approvalUrl(row.id),
  }
}

/**
 * A person narrowed to what a credential may do: its scopes (null holds them
 * all), and the stricter of the person's role and the credential's own, so a
 * member's credential never reaches what only an admin may decide.
 */
export function narrowToCredential(
  actor: Actor,
  credential: { scopes: readonly ApiKeyScope[] | null; role: Actor['role'] }
): Actor {
  const held = actor.permissions ?? resolveActorPermissions(actor.role)
  return {
    ...actor,
    role: actor.role === 'admin' && credential.role === 'admin' ? 'admin' : 'member',
    permissions: permissionsWithinScopes(held, new Set(credential.scopes ?? API_KEY_SCOPES)),
  }
}

/**
 * What an API key follows: what it filed, and what its creator could decide
 * with the key's authority (the creator's current permissions, the key's own
 * role, and its scopes). A creator who left the team decides nothing here.
 */
export async function approvalFollowerForApiKey(key: {
  id: string
  principalId: PrincipalId
  createdById: PrincipalId | null
  scopes: readonly ApiKeyScope[] | null
}): Promise<ApprovalFollower> {
  return { filed: { credentialId: key.id }, decider: await keyCreatorActor(key) }
}

function isTeamRole(role: string): role is 'admin' | 'member' {
  return isTeamMember(role)
}

async function keyCreatorActor(key: {
  principalId: PrincipalId
  createdById: PrincipalId | null
  scopes: readonly ApiKeyScope[] | null
}): Promise<Actor | null> {
  if (!key.createdById) return null
  const people = await db
    .select({ id: principal.id, role: principal.role, type: principal.type })
    .from(principal)
    .where(inArray(principal.id, [key.createdById, key.principalId]))
  const creator = people.find((person) => person.id === key.createdById)
  const holder = people.find((person) => person.id === key.principalId)
  if (!creator || creator.type !== 'user' || !isTeamRole(creator.role)) return null
  if (!holder || !isTeamRole(holder.role)) return null
  const [creatorHolds, keyHolds] = await Promise.all([
    permissionsForPrincipal(creator.id, creator.role),
    permissionsForPrincipal(holder.id, holder.role),
  ])
  return narrowToCredential(
    {
      principalId: creator.id,
      role: creator.role,
      principalType: 'user',
      segmentIds: new Set(),
      permissions: new Set([...creatorHolds].filter((permission) => keyHolds.has(permission))),
    },
    { scopes: key.scopes, role: holder.role }
  )
}

function filedBy(row: PendingActionRow, filed: ApprovalFollower['filed']): boolean {
  return (
    !!filed &&
    row.credentialId === filed.credentialId &&
    (!filed.onBehalfOfPrincipalId || row.onBehalfOfPrincipalId === filed.onBehalfOfPrincipalId)
  )
}

/** The rows a follower might read, before the per-row permission check; null for none. */
function followerScope(follower: ApprovalFollower) {
  const { filed, decider } = follower
  const own = filed
    ? and(
        eq(assistantPendingActions.credentialId, filed.credentialId),
        filed.onBehalfOfPrincipalId
          ? eq(assistantPendingActions.onBehalfOfPrincipalId, filed.onBehalfOfPrincipalId)
          : undefined
      )
    : undefined
  const decidable = decider ? parentVisible(decider) : undefined
  if (own && decidable) return or(own, decidable)
  return own ?? decidable ?? null
}

async function follows(
  row: PendingActionRow,
  follower: ApprovalFollower,
  requirementsOf: ReturnType<typeof approvalRequirements>
): Promise<boolean> {
  if (filedBy(row, follower.filed)) return true
  const decider = follower.decider
  if (!decider || !isDecidableApproval(row)) return false
  const required = await requirementsOf(row)
  return !!required && qualifiesToDecide(row, decider, required)
}

/** One approval this caller follows; anything else reads as not found. */
export async function getApprovalForFollower(
  follower: ApprovalFollower,
  id: AssistantPendingActionId
): Promise<PublicApproval> {
  const scope = followerScope(follower)
  if (!scope) throw approvalNotFound()
  const [row] = await db
    .select()
    .from(assistantPendingActions)
    .where(and(eq(assistantPendingActions.id, id), scope))
    .limit(1)
  if (!row || !(await follows(row, follower, approvalRequirements()))) throw approvalNotFound()
  return toPublicApproval(row)
}

/** The approvals this caller follows, newest first, optionally in one state. */
export async function listApprovalsForFollower(
  follower: ApprovalFollower,
  options: { status?: ApprovalStatus; limit?: number; cursor?: AssistantPendingActionId }
): Promise<ApprovalPage> {
  const scope = followerScope(follower)
  if (!scope) return { items: [], nextCursor: null, hasMore: false }
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  const now = new Date()
  const requirementsOf = approvalRequirements()
  const matched: PendingActionRow[] = []
  let after = options.cursor
  for (;;) {
    const rows = await db
      .select()
      .from(assistantPendingActions)
      .where(
        and(
          scope,
          statusFilter(options.status, now),
          after ? lt(assistantPendingActions.id, after) : undefined
        )
      )
      .orderBy(desc(assistantPendingActions.id))
      .limit(SCAN_BATCH)
    for (const row of rows) {
      if (matched.length > limit) break
      if (await follows(row, follower, requirementsOf)) matched.push(row)
    }
    if (matched.length > limit || rows.length < SCAN_BATCH) break
    after = rows[rows.length - 1]!.id
  }
  const page = matched.slice(0, limit)
  const hasMore = matched.length > limit
  return {
    items: await Promise.all(page.map(toPublicApproval)),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
    hasMore,
  }
}
