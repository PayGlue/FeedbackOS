/**
 * How an approval reads to the agents and API clients that follow it: one
 * status word per state, and the in-app page a person opens to decide it.
 */
import { isValidTypeId } from '@quackback/ids'

/**
 * The states an approval moves through, as clients read them. `pending` waits
 * for a person; `approved` and `rejected` are decisions; `applied` and
 * `failed` are how an approved change ran; `expired` timed out; `superseded`
 * was replaced by a newer request that combines it.
 */
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'superseded',
  'applied',
  'failed',
] as const

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

const APPROVALS_PATH = '/admin/approvals/'

/** The in-app page a person opens to decide an approval. */
export function approvalPath(approvalId: string): string {
  return `${APPROVALS_PATH}${approvalId}`
}

/**
 * The approval id in a reference to one: the id itself, or the url (or path)
 * of its page. Null for anything else.
 */
export function approvalIdFromReference(reference: string): string | null {
  let candidate = reference.trim()
  if (/^https?:\/\//i.test(candidate) || candidate.startsWith('/')) {
    let path: string
    try {
      path = new URL(candidate, 'http://localhost').pathname
    } catch {
      return null
    }
    if (!path.startsWith(APPROVALS_PATH)) return null
    candidate = path.slice(APPROVALS_PATH.length).replace(/\/$/, '')
  }
  return isValidTypeId(candidate, 'assistant_action') ? candidate : null
}
