/**
 * Parsec issue-tracker capability. The externalId namespace is the issue's
 * identifier (e.g. "PROJ-42"), the same value the inbound webhook carries, so a
 * pasted reference and a created issue both land where status sync finds them.
 */
import type { IssueTrackerCapability, ParsedIssueRef } from '@/lib/server/integrations/types'
import { issueError } from '@/lib/server/integrations/message-utils'
import { ValidationError } from '@/lib/shared/errors'
import { logger } from '@/lib/server/logger'
import {
  getParsecProjectSetup,
  parsecFollowUp,
  parsecRequest,
} from '@/integrations/parsec/server/api'

const log = logger.child({ component: 'parsec' })

const PRIORITIES = ['urgent', 'high', 'medium', 'low']

const ISSUE_URL_RE =
  /^https?:\/\/([^/\s]+)\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)\/?(?:[?#].*)?$/
const KEY_RE = /^([A-Za-z][A-Za-z0-9]*-\d+)$/
const NUMBER_RE = /^#?(\d+)$/

function issueUrl(config: Record<string, unknown>, identifier: string): string | null {
  const { webUrl, projectRef } = config
  if (typeof webUrl !== 'string' || !webUrl || typeof projectRef !== 'string') return null
  return `${webUrl}/${projectRef.split('.')[0]}/issue/${identifier}`
}

/**
 * Parsec mails a watcher about comments, not about the issue being created, so
 * the note after subscribing is what tells them it exists. Best effort: the
 * issue is the part that matters and it is already there.
 */
async function subscribeWatcher(
  auth: Record<string, unknown>,
  issueId: number,
  userId: string
): Promise<void> {
  const client = { apiUrl: auth.apiUrl, accessToken: auth.accessToken }
  try {
    await parsecFollowUp(client, `/issues/${issueId}/watchers/${encodeURIComponent(userId)}`, 'PUT')
    await parsecFollowUp(client, `/issues/${issueId}/comments`, 'POST', {
      body: 'Opened from a ticket.',
    })
  } catch (err) {
    log.warn({ err, issue_id: issueId }, 'could not subscribe the watcher')
  }
}

export const parsecIssues: IssueTrackerCapability = {
  parseRef(input: string, config: Record<string, unknown>): ParsedIssueRef | null {
    const trimmed = input.trim()
    const urlMatch = ISSUE_URL_RE.exec(trimmed)
    const projectKey = typeof config.projectRef === 'string' ? config.projectRef.split('.')[1] : ''
    // The connection pins one project, so a bare number can only mean an issue in it.
    const number = projectKey ? NUMBER_RE.exec(trimmed)?.[1] : undefined
    const key = (
      urlMatch?.[2] ??
      KEY_RE.exec(trimmed)?.[1] ??
      (number ? `${projectKey}-${number}` : undefined)
    )?.toUpperCase()
    if (!key) return null

    if (urlMatch && typeof config.webUrl === 'string') {
      const host = new URL(config.webUrl).host.toLowerCase()
      if (urlMatch[1].toLowerCase() !== host)
        throw new ValidationError(
          'SITE_MISMATCH',
          `Issue must belong to the connected instance (${host})`
        )
    }
    // Issue numbers are only unique per project, and inbound sync is fenced to
    // the connected one, so a foreign key would link and then never update.
    if (projectKey && !key.startsWith(`${projectKey.toUpperCase()}-`))
      throw new ValidationError(
        'PROJECT_MISMATCH',
        `Issue must belong to the connected project (${projectKey})`
      )

    return { externalId: key, externalDisplayId: key, externalUrl: issueUrl(config, key) }
  },

  async create({ auth, title, bodyMarkdown }): Promise<ParsedIssueRef> {
    const projectRef = auth.projectRef
    if (typeof projectRef !== 'string' || !projectRef)
      throw issueError('No Parsec project configured', { retryable: false })

    const client = { apiUrl: auth.apiUrl, accessToken: auth.accessToken }
    const { columns, issueTypes } = await getParsecProjectSetup(client, projectRef)
    const column = [...columns]
      .sort((a, b) => a.position - b.position)
      .find((c) => c.stateType === 'backlog' || c.stateType === 'unstarted')
    if (!column) throw issueError('The Parsec project has no open column', { retryable: false })

    // A type removed since it was chosen falls back to the project's default.
    const type =
      issueTypes.find((t) => String(t.id) === auth.issueTypeId) ??
      issueTypes.find((t) => t.isDefault)
    const priority = PRIORITIES.includes(auth.issuePriority as string)
      ? auth.issuePriority
      : undefined

    const issue = await parsecRequest<{ id: number; identifier: string }>(
      client,
      `/projects/${encodeURIComponent(projectRef)}/issues`,
      {
        method: 'POST',
        body: {
          columnId: column.id,
          title,
          description: bodyMarkdown,
          ...(type ? { typeId: type.id } : {}),
          ...(priority ? { priority } : {}),
        },
      }
    )
    if (typeof auth.watcherUserId === 'string' && auth.watcherUserId)
      await subscribeWatcher(auth, issue.id, auth.watcherUserId)

    return {
      externalId: issue.identifier,
      externalDisplayId: issue.identifier,
      externalUrl: issueUrl(auth, issue.identifier),
    }
  },
}
