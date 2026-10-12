import { useId } from 'react'
import { useIntl } from 'react-intl'
import { Link } from '@tanstack/react-router'
import { getShortTimeAgo } from '@/components/ui/time-ago'
import { approvalMessages } from './approval-messages'
import { askedBy } from './approval-people'
import { ApprovalRiskChip } from './approval-risk-chip'
import { useWaitingApprovals } from './use-waiting-approvals'

/**
 * Home's "Waiting on you": the newest requests the viewer may decide, each a
 * way into Approvals. It reads the answer the admin layout already holds, so
 * Home renders without waiting for it, and shows nothing while nothing waits.
 */
export function WaitingOnYou() {
  const intl = useIntl()
  const headingId = useId()
  const waiting = useWaitingApprovals()
  if (!waiting || waiting.count === 0 || waiting.latest.length === 0) return null
  return (
    <section aria-labelledby={headingId} data-slot="waiting-on-you">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-[13px] font-medium text-muted-foreground">
          {intl.formatMessage({
            id: 'admin.overview.waiting.title',
            defaultMessage: 'Waiting on you',
          })}
        </h2>
        <Link
          to="/admin/approvals"
          className="rounded-sm text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {intl.formatMessage(approvalMessages.title)}
        </Link>
      </div>
      <ul>
        {waiting.latest.map((approval) => (
          <li key={approval.id}>
            <Link
              to="/admin/approvals"
              search={{ id: approval.id }}
              className="-mx-2.5 flex h-[42px] items-center gap-3 rounded-lg px-2.5 text-sm text-foreground/90 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ApprovalRiskChip risk={approval.risk} />
              <span className="min-w-0 flex-1 truncate">{approval.summary}</span>
              <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                {askedBy(approval, intl)} · {getShortTimeAgo(approval.proposedAt, intl.locale)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
