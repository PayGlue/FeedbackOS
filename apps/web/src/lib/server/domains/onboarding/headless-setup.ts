/**
 * First-run setup without a browser.
 *
 * An operator who can reach the server but not click through the wizard sets a
 * `SETUP_TOKEN` (or reads the one the server prints on first boot) and calls
 * `POST /api/v1/setup` once. The request creates the first admin and the
 * workspace through the same code the wizard's workspace step runs
 * ({@link setupWorkspaceForUser}), then mints that admin's first API key.
 *
 * The token is the operator's word that they own the install, so it works only
 * while there is nobody to own it yet: the moment a human admin exists, or the
 * workspace belongs to a control plane, the endpoint answers "already set up"
 * and the token opens nothing.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { PrincipalId, UserId } from '@quackback/ids'
import { db, eq, principal, user } from '@/lib/server/db'
import { recordAuditEvent } from '@/lib/server/audit/log'
import { createApiKey } from '@/lib/server/domains/api-keys/api-key.service'
import { API_KEY_SCOPES } from '@/lib/server/domains/api-keys/api-key-scopes'
import {
  findHumanAdmin,
  isOpenToBootstrapClaim,
  isSetupOpenToClaim,
} from '@/lib/server/domains/principals/bootstrap-admin'
import { createPortalUser } from '@/lib/server/domains/users/user.create'
import { setupWorkspaceForUser } from '@/lib/server/domains/onboarding/setup-workspace'
import { kvGet, kvSetNx } from '@/lib/server/kv/pg-kv'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'headless-setup' })

/** Where the hash of a server-generated token lives until setup finishes. */
const GENERATED_TOKEN_KEY = 'setup:generated-token-hash'
const GENERATED_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365
const GENERATED_TOKEN_PREFIX = 'qbs_'

/** An operator-chosen token shorter than this is ignored: it would be guessable. */
export const MIN_SETUP_TOKEN_LENGTH = 16

export const headlessSetupSchema = z.object({
  workspaceName: z
    .string()
    .trim()
    .min(2, 'workspaceName must be at least 2 characters')
    .max(100, 'workspaceName must be 100 characters or less'),
  adminEmail: z.string().trim().toLowerCase().email('adminEmail must be an email address').max(320),
  adminName: z
    .string()
    .trim()
    .min(2, 'adminName must be at least 2 characters')
    .max(100, 'adminName must be 100 characters or less'),
})

export type HeadlessSetupInput = z.infer<typeof headlessSetupSchema>

const sha256 = (value: string) => createHash('sha256').update(value).digest()

/** The token the operator put in the environment, or null when unset or too short. */
function configuredToken(): string | null {
  const raw = process.env.SETUP_TOKEN?.trim()
  if (!raw) return null
  return raw.length >= MIN_SETUP_TOKEN_LENGTH ? raw : null
}

/**
 * Constant-time comparison. Both sides are hashed first so the comparison runs
 * over equal-length digests whatever the caller sent: neither the content nor
 * the length of the real token is observable through timing.
 */
function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

export type SetupTokenCheck = 'ok' | 'invalid' | 'not_configured'

/**
 * Checks a presented bearer token against the environment's `SETUP_TOKEN`
 * and, failing that, the token the server generated on first boot.
 * `not_configured` means neither exists, so the endpoint should not exist.
 */
export async function verifySetupToken(presented: string): Promise<SetupTokenCheck> {
  const presentedDigest = sha256(presented)
  const fromEnv = configuredToken()
  const stored = await kvGet<string>(GENERATED_TOKEN_KEY)
  if (!fromEnv && !stored) return 'not_configured'

  // Evaluate both so the time taken does not say which source matched.
  const envMatch = fromEnv ? digestsEqual(presentedDigest, sha256(fromEnv)) : false
  const storedMatch = stored ? digestsEqual(presentedDigest, Buffer.from(stored, 'hex')) : false
  return envMatch || storedMatch ? 'ok' : 'invalid'
}

/** Is this install still waiting for its first admin? */
export async function isAwaitingFirstAdmin(): Promise<boolean> {
  if (await findHumanAdmin(db)) return false
  if (!(await isOpenToBootstrapClaim(db))) return false
  return isSetupOpenToClaim(db)
}

/**
 * On the first boot of an install that is still awaiting its first admin and
 * has no `SETUP_TOKEN`, generates a token and writes it to the log once. Only
 * its hash is stored, so a restart cannot print it again and a database
 * reader cannot recover it. An install that is already set up, or provisioned
 * by a control plane, gets nothing.
 */
export async function ensureBootSetupToken(): Promise<void> {
  if (configuredToken()) {
    if (await isAwaitingFirstAdmin()) {
      log.info('SETUP_TOKEN is set: POST /api/v1/setup can create the first admin')
    }
    return
  }
  if (process.env.SETUP_TOKEN?.trim()) {
    log.warn(
      { min_length: MIN_SETUP_TOKEN_LENGTH },
      'SETUP_TOKEN is shorter than the minimum and is ignored'
    )
  }
  if (!(await isAwaitingFirstAdmin())) return

  const token = `${GENERATED_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`
  const stored = await kvSetNx(
    GENERATED_TOKEN_KEY,
    sha256(token).toString('hex'),
    GENERATED_TOKEN_TTL_SECONDS
  )
  if (!stored) return
  log.info(
    `First-run setup token (shown once, valid until the first admin exists): ${token}. ` +
      'Send it as "Authorization: Bearer <token>" to POST /api/v1/setup, or set SETUP_TOKEN to choose your own.'
  )
}

export type HeadlessSetupResult =
  | {
      ok: true
      workspace: { id: string; name: string; slug: string }
      admin: { userId: UserId; principalId: PrincipalId; email: string; name: string }
      apiKey: { id: string; name: string; key: string }
    }
  | { ok: false; reason: 'already_set_up' }

/**
 * Creates the first admin and the workspace, and mints the admin's first API
 * key. The caller has already verified the setup token.
 */
export async function runHeadlessSetup(
  input: HeadlessSetupInput,
  headers?: Headers
): Promise<HeadlessSetupResult> {
  if (!(await isAwaitingFirstAdmin())) return { ok: false, reason: 'already_set_up' }

  // The person may already have an account (they signed up in the browser and
  // gave up on the wizard). Otherwise the operator vouches for the address,
  // which is what an admin-created account means everywhere else.
  const existing = await db.query.user.findFirst({
    where: eq(user.email, input.adminEmail),
    columns: { id: true },
  })
  const userId: UserId = existing
    ? (existing.id as UserId)
    : (await createPortalUser({ name: input.adminName, email: input.adminEmail })).userId

  const saved = await setupWorkspaceForUser({
    userId,
    data: { workspaceName: input.workspaceName, userName: input.adminName },
    locale: undefined,
    operatorAuthorized: true,
  })
  if (!saved.ok) return { ok: false, reason: 'already_set_up' }

  const admin = await db.query.principal.findFirst({
    where: eq(principal.userId, userId),
    columns: { id: true },
  })
  if (!admin) throw new Error('Setup finished without an admin principal')
  const principalId = admin.id as PrincipalId

  const { apiKey, plainTextKey } = await createApiKey(
    { name: 'Setup key', scopes: API_KEY_SCOPES },
    principalId
  )

  await recordAuditEvent({
    event: 'workspace.setup.completed',
    actor: { userId, email: input.adminEmail, role: 'admin', type: 'user' },
    headers,
    target: { type: 'workspace', id: saved.id },
    metadata: { via: 'setup_token', apiKeyId: apiKey.id },
  })
  log.info({ workspace_id: saved.id, user_id: userId }, 'first admin created through setup token')

  return {
    ok: true,
    workspace: { id: saved.id, name: saved.name, slug: saved.slug },
    admin: { userId, principalId, email: input.adminEmail, name: input.adminName },
    apiKey: { id: apiKey.id, name: apiKey.name, key: plainTextKey },
  }
}
