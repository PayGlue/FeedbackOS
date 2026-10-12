import { createFileRoute } from '@tanstack/react-router'
import { isValidTypeId } from '@quackback/ids'
import { ApprovalsPage } from '@/components/admin/approvals/approvals-page'
import { adminPageHead } from '@/lib/client/admin-head'
import { warmQuery } from '@/lib/client/queries/warm-query'
import { approvalQueries } from '@/lib/client/queries/approvals'

interface ApprovalsSearch {
  view?: 'decided'
  /** The request open beside the list. */
  id?: string
}

export const Route = createFileRoute('/admin/approvals')({
  head: adminPageHead('Approvals'),
  validateSearch: (search: Record<string, unknown>): ApprovalsSearch => ({
    view: search.view === 'decided' ? 'decided' : undefined,
    id:
      typeof search.id === 'string' && isValidTypeId(search.id, 'assistant_action')
        ? search.id
        : undefined,
  }),
  // Every teammate may open the page: each sees only the requests they may
  // decide. The list arrives with the page; a failed read is left to the
  // page's own query.
  loader: async ({ context }) => {
    await warmQuery(context.queryClient, approvalQueries.list('waiting'))
  },
  component: ApprovalsPage,
})
