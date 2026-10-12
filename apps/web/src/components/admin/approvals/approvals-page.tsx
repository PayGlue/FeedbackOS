import { useMemo, useState } from 'react'
import { useIntl } from 'react-intl'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import type { ApprovalView } from '@/lib/server/domains/assistant/approvals.queue'
import { approvalQueries, type ApprovalsView } from '@/lib/client/queries/approvals'
import { PageHeader } from '@/components/shared/page-header'
import { Spinner } from '@/components/shared/spinner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getTimeAgo } from '@/components/ui/time-ago'
import { cn } from '@/lib/shared/utils'
import { approvalMessages } from './approval-messages'
import { requesterOf } from './approval-people'
import { ApprovalRiskChip } from './approval-risk-chip'
import { ApprovalDetail } from './approval-detail'

const route = getRouteApi('/admin/approvals')

/** Newest first; ids are time-ordered, so they settle a tie. */
function newestFirst(a: ApprovalView, b: ApprovalView): number {
  return b.proposedAt.localeCompare(a.proposedAt) || b.id.localeCompare(a.id)
}

function useStatusLabel() {
  const intl = useIntl()
  return (approval: ApprovalView): string | null => {
    if (approval.status === 'proposed') return null
    if (approval.status === 'rejected') return intl.formatMessage(approvalMessages.statusRejected)
    if (approval.status === 'failed') return intl.formatMessage(approvalMessages.statusFailed)
    if (approval.status === 'executed')
      return intl.formatMessage(
        approval.undone ? approvalMessages.statusUndone : approvalMessages.statusApplied
      )
    if (approval.status === 'approved') return intl.formatMessage(approvalMessages.statusApproved)
    return null
  }
}

export interface ApprovalsListProps {
  items: ApprovalView[]
  selectedId: string | null
  view: ApprovalsView
  onSelect: (id: string) => void
}

/** The requests in a tab: title, risk, who asked and when. */
export function ApprovalsList({ items, selectedId, view, onSelect }: ApprovalsListProps) {
  const intl = useIntl()
  const statusOf = useStatusLabel()
  if (items.length === 0)
    return (
      <p className="px-3.5 py-10 text-center text-sm text-muted-foreground">
        {intl.formatMessage(
          view === 'waiting' ? approvalMessages.emptyWaiting : approvalMessages.emptyDecided
        )}
      </p>
    )
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const status = statusOf(item)
        const on = item.id === selectedId
        return (
          <li key={item.id}>
            <button
              type="button"
              aria-current={on ? 'true' : undefined}
              onClick={() => onSelect(item.id)}
              className={cn(
                'block w-full rounded-lg px-3.5 py-3 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on && 'bg-muted hover:bg-muted'
              )}
            >
              <span className="block text-sm font-medium leading-snug text-foreground">
                {item.summary}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <ApprovalRiskChip risk={item.risk} />
                <span>{requesterOf(item, intl)}</span>
                <span>· {getTimeAgo(item.proposedAt, intl.locale)}</span>
                {status && <span>· {status}</span>}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The Approvals page: what waits on the viewer and what was decided, with the
 * selected request beside the list. A request decided here stays in the
 * Waiting list with its outcome, so the result stays on screen.
 */
export function ApprovalsPage() {
  const intl = useIntl()
  const navigate = route.useNavigate()
  const search = route.useSearch()
  const view: ApprovalsView = search.view === 'decided' ? 'decided' : 'waiting'
  const waitingQuery = useQuery(approvalQueries.list('waiting'))
  const decidedQuery = useQuery({ ...approvalQueries.list('decided'), enabled: view === 'decided' })
  // Requests as they stand after a decision or a refresh on this page, and
  // which of them were decided here.
  const [latest, setLatest] = useState<ReadonlyMap<string, ApprovalView>>(new Map())
  const [decidedHere, setDecidedHere] = useState<ReadonlySet<string>>(new Set())

  const waiting = useMemo(() => {
    const listed = (waitingQuery.data ?? []).map((item) => latest.get(item.id) ?? item)
    const listedIds = new Set(listed.map((item) => item.id))
    const kept = [...decidedHere]
      .filter((id) => !listedIds.has(id))
      .map((id) => latest.get(id))
      .filter((item): item is ApprovalView => !!item)
    return [...listed, ...kept].sort(newestFirst)
  }, [waitingQuery.data, latest, decidedHere])
  const decided = useMemo(
    () => (decidedQuery.data ?? []).map((item) => latest.get(item.id) ?? item),
    [decidedQuery.data, latest]
  )
  const items = view === 'waiting' ? waiting : decided
  const waitingCount = waiting.filter((item) => item.status === 'proposed').length
  const listed = items.find((item) => item.id === search.id)
  // A request opened by link that this tab does not list, such as one just decided elsewhere.
  const linked = useQuery({
    ...approvalQueries.detail(search.id ?? ''),
    enabled: !!search.id && !listed,
  })
  const selected =
    listed ??
    (search.id && linked.data ? (latest.get(linked.data.id) ?? linked.data) : undefined) ??
    items[0]
  const loading = view === 'waiting' ? waitingQuery.isPending : decidedQuery.isPending

  const select = (id: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, id }), replace: true })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-4 sm:px-6">
        <PageHeader title={intl.formatMessage(approvalMessages.title)} />
        <Tabs
          variant="line"
          className="mt-3"
          value={view}
          onValueChange={(value) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                view: value === 'decided' ? ('decided' as const) : undefined,
                id: undefined,
              }),
              replace: true,
            })
          }
        >
          <TabsList className="border-b-0">
            <TabsTrigger value="waiting">
              {intl.formatMessage(approvalMessages.waiting)}
              <span className="ms-1.5 text-xs tabular-nums text-muted-foreground">
                {waitingCount}
              </span>
            </TabsTrigger>
            <TabsTrigger value="decided">
              {intl.formatMessage(approvalMessages.decided)}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="flex min-h-0 flex-1 border-t border-border/50">
        <div
          className={cn(
            'flex min-h-0 w-full shrink-0 flex-col border-r border-border/50 md:w-80 xl:w-[25rem]',
            search.id && 'hidden md:flex'
          )}
        >
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-2.5">
              {loading ? (
                <div className="flex justify-center py-12">
                  <Spinner size="lg" />
                </div>
              ) : (
                <ApprovalsList
                  items={items}
                  selectedId={selected?.id ?? null}
                  view={view}
                  onSelect={select}
                />
              )}
            </div>
          </ScrollArea>
        </div>
        <div className={cn('min-w-0 flex-1', !search.id && 'hidden md:block')}>
          <ScrollArea className="h-full">
            {selected && (
              <ApprovalDetail
                key={selected.id}
                approval={selected}
                decidedHere={decidedHere.has(selected.id)}
                onBack={() => select(undefined)}
                onChange={(approval, decided) => {
                  setLatest((previous) => new Map(previous).set(approval.id, approval))
                  if (decided) setDecidedHere((previous) => new Set(previous).add(approval.id))
                }}
              />
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}
