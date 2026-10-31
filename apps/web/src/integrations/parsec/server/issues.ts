/**
 * Parsec issue-tracker capability. The externalId namespace is the issue's
 * identifier (e.g. "PROJ-42"), the same value the inbound webhook carries, so a
 * pasted reference and a created issue both land where status sync finds them.
 */
import type { IssueTrackerCapability, ParsedIssueRef } from '@/lib/server/integrations/types'
import { issueError } from '@/lib/server/integrations/message-utils'
import { ValidationError } from '@/lib/shared/errors'
import { listParsecColumns, parsecRequest } from '@/integrations/parsec/server/api'

const ISSUE_URL_RE =
  /^https?:\/\/([^/\s]+)\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)\/?(?:[?#].*)?$/
const KEY_RE = /^([A-Za-z][A-Za-z0-9]*-\d+)$/

function issueUrl(config: Record<string, unknown>, identifier: string): string | null {
  const { webUrl, projectRef } = config
  if (typeof webUrl !== 'string' || !webUrl || typeof projectRef !== 'string') return null
  return `${webUrl}/${projectRef.split('.')[0]}/issue/${identifier}`
}

export const parsecIssues: IssueTrackerCapability = {
  parseRef(input: string, config: Record<string, unknown>): ParsedIssueRef | null {
    const trimmed = input.trim()
    const urlMatch = ISSUE_URL_RE.exec(trimmed)
    const key = (urlMatch?.[2] ?? KEY_RE.exec(trimmed)?.[1])?.toUpperCase()
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
    const projectKey = typeof config.projectRef === 'string' ? config.projectRef.split('.')[1] : ''
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

    const columns = await listParsecColumns(
      { apiUrl: auth.apiUrl, accessToken: auth.accessToken },
      projectRef
    )
    const column = [...columns]
      .sort((a, b) => a.position - b.position)
      .find((c) => c.stateType === 'backlog' || c.stateType === 'unstarted')
    if (!column) throw issueError('The Parsec project has no open column', { retryable: false })

    const issue = await parsecRequest<{ identifier: string }>(
      { apiUrl: auth.apiUrl, accessToken: auth.accessToken },
      `/projects/${encodeURIComponent(projectRef)}/issues`,
      { method: 'POST', body: { columnId: column.id, title, description: bodyMarkdown } }
    )
    return {
      externalId: issue.identifier,
      externalDisplayId: issue.identifier,
      externalUrl: issueUrl(auth, issue.identifier),
    }
  },
}
