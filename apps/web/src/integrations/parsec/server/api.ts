/**
 * Parsec REST client. A self-hosted tracker, so every call takes the instance's
 * API origin from the connection instead of a fixed host. Authenticates with a
 * personal API key in the `x-api-key` header.
 */
import { integrationFetch } from '@/lib/server/integrations/sync/transport'
import { issueError } from '@/lib/server/integrations/message-utils'

export interface ParsecProject {
  id: number
  /** `<team>.<KEY>`, the unambiguous name routes take. */
  ref: string
  key: string
  name: string
}

export interface ParsecColumn {
  id: number
  name: string
  stateType: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
  position: number
}

export interface ParsecIssueType {
  id: number
  name: string
  isDefault: boolean
}

export interface ParsecAssignee {
  userId: string
  name: string
  kind: string
}

export interface ParsecProjectSetup {
  columns: ParsecColumn[]
  issueTypes: ParsecIssueType[]
  assignees: ParsecAssignee[]
}

export function normalizeOrigin(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:') throw new Error('Use an https:// address')
  return url.origin
}

export async function parsecRequest<T>(
  auth: { apiUrl: unknown; accessToken: unknown },
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await integrationFetch(`${String(auth.apiUrl)}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'x-api-key': String(auth.accessToken),
      'Content-Type': 'application/json',
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  if (!response.ok) {
    const status = response.status
    if (status === 401) throw issueError('Unauthorized', { status })
    if (status === 429) throw issueError('Rate limited', { status, retryable: true })
    throw issueError(`HTTP ${status}`, { status, retryable: status >= 500 })
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export function listParsecProjects(auth: { apiUrl: unknown; accessToken: unknown }) {
  return parsecRequest<ParsecProject[]>(auth, '/projects')
}

export function getParsecProjectSetup(
  auth: { apiUrl: unknown; accessToken: unknown },
  projectRef: string
): Promise<ParsecProjectSetup> {
  return parsecRequest<ParsecProjectSetup>(auth, `/projects/${encodeURIComponent(projectRef)}`)
}

/**
 * For calls that follow a created issue. The issue already exists, so a failure
 * here must not reach the sync transport, which would report the creation as
 * uncertain and leave it open to a duplicate.
 */
export async function parsecFollowUp(
  auth: { apiUrl: unknown; accessToken: unknown },
  path: string,
  method: 'PUT' | 'POST',
  body?: unknown
): Promise<void> {
  const response = await fetch(`${String(auth.apiUrl)}${path}`, {
    method,
    headers: {
      'x-api-key': String(auth.accessToken),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}
