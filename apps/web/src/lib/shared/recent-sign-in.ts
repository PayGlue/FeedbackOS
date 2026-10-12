/**
 * A sensitive decision needs a person who signed in recently. This is the
 * vocabulary both sides share: how recent, the code a refusal carries, and the
 * shape that refusal takes on its way to the browser.
 *
 * A server function reports the refusal as a returned value,
 * `{ ok: false, code: 'RECENT_SIGN_IN_REQUIRED', message }`, rather than as a
 * thrown error. A thrown error reaches the browser as a plain `Error` with its
 * message only (its `code` and `statusCode` are dropped on the wire), so the
 * client could not tell this refusal from any other failure. Server code
 * throws `RecentSignInRequiredError`; the server function's boundary turns it
 * into the value with `toRecentSignInRefusal`; the client checks the result
 * with `isRecentSignInRequired`.
 */
import { ForbiddenError } from './errors'

/** How long after signing in a person may approve a sensitive change. */
export const RECENT_SIGN_IN_WINDOW_MS = 10 * 60 * 1000

/** The code a refusal for a stale sign-in carries. */
export const RECENT_SIGN_IN_REQUIRED = 'RECENT_SIGN_IN_REQUIRED'

/** A server function's answer when the person has to sign in again first. */
export interface RecentSignInRefusal {
  ok: false
  code: typeof RECENT_SIGN_IN_REQUIRED
  message: string
}

/** Thrown by server code when the person did not sign in recently. */
export class RecentSignInRequiredError extends ForbiddenError {
  constructor() {
    super(RECENT_SIGN_IN_REQUIRED, 'Sign in again to continue.')
  }
}

/** The refusal value for a stale sign-in, or null for any other error. */
export function toRecentSignInRefusal(error: unknown): RecentSignInRefusal | null {
  if (!(error instanceof RecentSignInRequiredError)) return null
  return { ok: false, code: RECENT_SIGN_IN_REQUIRED, message: error.message }
}

/** Whether a server function's result asks the person to sign in again. */
export function isRecentSignInRequired(value: unknown): value is RecentSignInRefusal {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { ok?: unknown; code?: unknown }
  return candidate.ok === false && candidate.code === RECENT_SIGN_IN_REQUIRED
}
