/**
 * Approvals: the queue of requests a person may decide, one request with its
 * diff, and turning one down with a reason.
 *
 * The base gate is a signed-in session; who may see or decide each request is
 * per row (the item's visibility and every permission the operation needs),
 * enforced by the approvals services. A decision that arrives here comes from
 * a person's session, never from the credential that filed the request.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { AssistantPendingActionId } from '@quackback/ids'
import { requireAuth, policyActorFromAuth } from './auth-helpers'

const ApprovalInput = z.object({ approvalId: z.string() })

export const listApprovalsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ limit: z.number().int().min(1).max(100).optional() }))
  .handler(async ({ data }) => {
    const auth = await requireAuth()
    const actor = await policyActorFromAuth(auth)
    const { listApprovalsForViewer } =
      await import('@/lib/server/domains/assistant/approvals.queue')
    return listApprovalsForViewer(actor, { limit: data.limit })
  })

export const getApprovalFn = createServerFn({ method: 'GET' })
  .validator(ApprovalInput)
  .handler(async ({ data }) => {
    const auth = await requireAuth()
    const actor = await policyActorFromAuth(auth)
    const { getApprovalForViewer } = await import('@/lib/server/domains/assistant/approvals.queue')
    return getApprovalForViewer(actor, data.approvalId as AssistantPendingActionId)
  })

export const rejectApprovalFn = createServerFn({ method: 'POST' })
  .validator(
    ApprovalInput.extend({
      contentHash: z.string().min(1).max(128),
      reason: z.string().max(500).optional(),
    })
  )
  .handler(async ({ data }) => {
    const auth = await requireAuth()
    const actor = await policyActorFromAuth(auth)
    const { rejectApproval } = await import('@/lib/server/domains/assistant/approvals.service')
    const row = await rejectApproval(actor, data.approvalId as AssistantPendingActionId, {
      contentHash: data.contentHash,
      reason: data.reason,
      via: 'app',
    })
    return { id: row.id, status: row.status, decisionReason: row.decisionReason }
  })
