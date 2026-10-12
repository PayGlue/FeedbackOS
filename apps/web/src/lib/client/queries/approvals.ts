/**
 * Query options for the Approvals page, its rail count and Home's list.
 *
 * `waiting` is one read for the rail's badge and Home's "Waiting on you": the
 * admin layout warms it with the document, so neither asks again as the
 * viewer moves between pages. A decision refreshes it, and so does a new
 * approval notification (see useWaitingApprovals); it has no poll of its own.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  getApprovalFn,
  getWaitingApprovalsFn,
  listApprovalsFn,
} from '@/lib/server/functions/approvals'

export type ApprovalsView = 'waiting' | 'decided'

export const approvalKeys = {
  all: ['approvals'] as const,
  waiting: () => ['approvals', 'waiting'] as const,
  list: (view: ApprovalsView) => ['approvals', 'list', view] as const,
  detail: (id: string) => ['approvals', 'detail', id] as const,
}

export const approvalQueries = {
  /** How many requests wait on the viewer, and the newest few. */
  waiting: () =>
    queryOptions({
      queryKey: approvalKeys.waiting(),
      queryFn: () => getWaitingApprovalsFn(),
      staleTime: 30 * 1000,
    }),
  list: (view: ApprovalsView) =>
    queryOptions({
      queryKey: approvalKeys.list(view),
      queryFn: () => listApprovalsFn({ data: { view } }),
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: approvalKeys.detail(id),
      queryFn: () => getApprovalFn({ data: { approvalId: id } }),
    }),
}
