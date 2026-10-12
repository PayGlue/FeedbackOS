/**
 * The REST API's boundary audit: one `api.write` row for every write an API
 * key makes under /api/v1, whatever the route does on its own.
 *
 * The row names the method, the route pattern (ids replaced by `:id`), the
 * resource the path points at or the one a create returned, and the status
 * with the error code of a refusal. It never holds the request body, the query
 * string or a credential. It costs one insert and no read: the route already
 * authenticated the key and stated it as the request's attribution
 * (domains/api/auth.ts), and the response is already in hand.
 *
 * A request no key authenticated is not recorded: it changed nothing, and
 * anyone can send one.
 */
import { isUuid, isValidTypeId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'
import { getAuditAttribution, getAuditBoundaryActor } from './attribution'
import { recordAuditEvent, type AuditTarget } from './log'
import { typeIdTarget } from './targets'

const log = logger.child({ component: 'audit' })

const API_PREFIX = '/api/v1/'
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const ERROR_CODE_MAX_LEN = 100

/** A write to the REST API: anything but a read under /api/v1. */
export function isApiWrite(request: Request): boolean {
  if (READ_METHODS.has(request.method.toUpperCase())) return false
  return new URL(request.url).pathname.startsWith(API_PREFIX)
}

function isIdSegment(segment: string): boolean {
  return segment !== '' && (isValidTypeId(segment) || isUuid(segment))
}

/** The path with each id segment replaced by `:id`, so one route reads as one route. */
export function apiRoutePattern(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ':id' : segment))
    .join('/')
}

/** The most specific resource a path names: its last TypeID segment. */
export function apiPathTarget(pathname: string): AuditTarget | null {
  const segments = pathname.split('/')
  for (let i = segments.length - 1; i >= 0; i--) {
    const target = typeIdTarget(segments[i])
    if (target) return target
  }
  return null
}

/** A JSON response body, read from a clone so the client still gets it. */
async function jsonBody(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.headers.get('content-type')?.includes('application/json')) return null
  try {
    const body: unknown = await response.clone().json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
}

/**
 * Record the write, given the response the route produced, or null when the
 * handler threw (reported as a 500). Never throws: a failure is logged and
 * the response goes out regardless.
 */
export async function recordApiWrite(request: Request, response: Response | null): Promise<void> {
  try {
    const attribution = getAuditAttribution()
    if (attribution?.channel !== 'api') return

    const pathname = new URL(request.url).pathname
    const status = response?.status ?? 500
    const failed = status >= 400

    let target = apiPathTarget(pathname)
    let errorCode: string | null = null
    if (response && (status === 201 || failed)) {
      const body = await jsonBody(response)
      if (status === 201) target ??= typeIdTarget(field(field(body, 'data'), 'id'))
      const code = field(field(body, 'error'), 'code')
      if (failed && typeof code === 'string') errorCode = code.slice(0, ERROR_CODE_MAX_LEN)
    }

    await recordAuditEvent({
      event: 'api.write',
      outcome: failed ? 'failure' : 'success',
      actor: getAuditBoundaryActor() ?? { authMethod: 'api_key' },
      headers: request.headers,
      target: target ?? undefined,
      metadata: {
        method: request.method.toUpperCase(),
        route: apiRoutePattern(pathname),
        status,
        ...(errorCode ? { errorCode } : {}),
      },
    })
  } catch (error) {
    log.error({ err: error }, 'api write audit failed')
  }
}
