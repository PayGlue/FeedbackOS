/**
 * `POST /api/v1/setup`: the HTTP face of {@link runHeadlessSetup}.
 *
 * Order matters. The rate limit comes first so a guessing run is throttled
 * before it costs a database read; the token comes next so nobody without it
 * learns anything about the install's state; and only a caller holding the
 * token is told the install is already set up (409).
 */
import { getClientIp } from '@/lib/server/domains/api/rate-limit'
import {
  badRequestResponse,
  createdResponse,
  errorResponse,
  handleDomainError,
  notFoundResponse,
  rateLimitedResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from '@/lib/server/domains/api/responses'
import { recordAuditEvent } from '@/lib/server/audit/log'
import { bucketRetryAfter, incrementBuckets } from '@/lib/server/utils/rate-bucket'
import { logger } from '@/lib/server/logger'
import {
  headlessSetupSchema,
  runHeadlessSetup,
  verifySetupToken,
} from '@/lib/server/domains/onboarding/headless-setup'

const log = logger.child({ component: 'headless-setup' })

const WINDOW_SECONDS = 60
/** Attempts per address per window, whatever their outcome. */
const MAX_PER_ADDRESS = 10
/** Attempts from everywhere per window: a spread-out guessing run still meets a ceiling. */
const MAX_OVERALL = 60

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

async function throttled(ip: string): Promise<number | null> {
  const perAddress = { key: `setup:rl:ip:${ip}`, windowSeconds: WINDOW_SECONDS }
  const overall = { key: 'setup:rl:all', windowSeconds: WINDOW_SECONDS }
  const [addressCount, overallCount] = await incrementBuckets([perAddress, overall])
  if (addressCount !== null && addressCount > MAX_PER_ADDRESS) {
    return bucketRetryAfter(perAddress)
  }
  if (overallCount !== null && overallCount > MAX_OVERALL) {
    return bucketRetryAfter(overall)
  }
  return null
}

export async function handleSetupRequest(request: Request): Promise<Response> {
  try {
    const retryAfter = await throttled(getClientIp(request))
    if (retryAfter !== null) return rateLimitedResponse(retryAfter)

    const presented = bearerToken(request)
    const check = presented ? await verifySetupToken(presented) : null
    // With no token configured the endpoint does not exist, whatever was sent.
    if (check === 'not_configured') return notFoundResponse('Endpoint')
    if (check !== 'ok') {
      log.warn('setup request refused: missing or wrong setup token')
      await recordAuditEvent({
        event: 'workspace.setup.rejected',
        outcome: 'failure',
        actor: { type: 'anonymous' },
        headers: request.headers,
        metadata: { reason: presented ? 'wrong_token' : 'missing_token' },
      })
      return unauthorizedResponse('A valid setup token is required')
    }

    let json: unknown
    try {
      json = await request.json()
    } catch {
      return badRequestResponse('Request body must be JSON')
    }
    const parsed = headlessSetupSchema.safeParse(json)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error.issues[0]?.message ?? 'Invalid request body', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    const result = await runHeadlessSetup(parsed.data, request.headers)
    if (!result.ok) {
      await recordAuditEvent({
        event: 'workspace.setup.rejected',
        outcome: 'failure',
        actor: { type: 'anonymous' },
        headers: request.headers,
        metadata: { reason: 'already_set_up' },
      })
      return errorResponse(
        'SETUP_ALREADY_COMPLETE',
        'This workspace already has an admin, so the setup token no longer opens anything.',
        409
      )
    }
    return createdResponse({
      workspace: result.workspace,
      admin: result.admin,
      apiKey: result.apiKey,
    })
  } catch (error) {
    return handleDomainError(error)
  }
}
