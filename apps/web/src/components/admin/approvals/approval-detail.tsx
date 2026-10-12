import { Suspense, useId, useState, type ReactNode } from 'react'
import { useIntl } from 'react-intl'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { ArrowLeftIcon, CheckIcon } from '@heroicons/react/24/outline'
import type { ApprovalView } from '@/lib/server/domains/assistant/approvals.queue'
import {
  approveApprovalFn,
  rejectApprovalFn,
  type ApprovalDecisionResult,
} from '@/lib/server/functions/approvals'
import { undoWorkspaceSettingsProposalFn } from '@/lib/server/functions/workspace-copilot'
import { approvalKeys, approvalQueries } from '@/lib/client/queries/approvals'
import { AskMessages } from '@/components/admin/ask/ask-messages'
import { settingsAreaLabel } from '@/components/admin/ask/workspace-settings-proposal-card'
import { refreshSettingsAreaQueries } from '@/components/admin/ask/settings-proposal-cache'
import { getTimeAgo } from '@/components/ui/time-ago'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { SettingsArea } from '@/lib/shared/assistant/settings-proposals'
import { cn } from '@/lib/shared/utils'
import { approvalMessages, refusalMessage } from './approval-messages'
import { personOf, requesterOf, toldOf } from './approval-people'
import { ApprovalRiskChip } from './approval-risk-chip'
import { ApprovalChanges } from './approval-changes'

const bold = (chunks: ReactNode[]) => <b className="font-medium text-foreground">{chunks}</b>

/** Where a request stands for the person looking at it. */
type Stage = 'deciding' | 'rejecting' | 'applied' | 'failed' | 'rejected' | 'undone' | 'history'

function stageOf(approval: ApprovalView, decidedHere: boolean, rejecting: boolean): Stage {
  if (approval.status === 'proposed') return rejecting ? 'rejecting' : 'deciding'
  if (!decidedHere) return 'history'
  if (approval.status === 'rejected') return 'rejected'
  if (approval.status === 'failed') return 'failed'
  return approval.undone ? 'undone' : 'applied'
}

function refusalCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

/** The area a request acts on: the settings it changes, or its conversation or ticket. */
function useAreaLabel(approval: ApprovalView): string | null {
  const intl = useIntl()
  if (approval.diff.kind === 'settings') {
    const areas = [...new Set(approval.diff.changes.map((change) => change.area))]
    return intl.formatMessage(approvalMessages.areaSettings, {
      areas: areas.map((area) => settingsAreaLabel(intl, area as SettingsArea)).join(', '),
    })
  }
  if (approval.parent.kind === 'conversation')
    return intl.formatMessage(approvalMessages.areaConversation)
  if (approval.parent.kind === 'ticket') return intl.formatMessage(approvalMessages.areaTicket)
  return null
}

function settingsAreasOf(approval: ApprovalView): SettingsArea[] {
  return approval.diff.kind === 'settings'
    ? approval.diff.changes.map((change) => change.area as SettingsArea)
    : []
}

export interface ApprovalDetailProps {
  approval: ApprovalView
  /** Decided on this page in this visit, so its outcome shows in place. */
  decidedHere: boolean
  /** The request as it now stands, after a decision or a refresh. */
  onChange: (approval: ApprovalView, decided: boolean) => void
  onBack?: () => void
}

/** One request: who asked and for whom, what changes, and Approve or Reject. */
export function ApprovalDetail({ approval, decidedHere, onChange, onBack }: ApprovalDetailProps) {
  const intl = useIntl()
  const router = useRouter()
  const queryClient = useQueryClient()
  const reasonId = useId()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useAreaLabel(approval)
  const stage = stageOf(approval, decidedHere, rejecting)
  const requester = requesterOf(approval, intl)
  const person = personOf(approval)
  const told = toldOf(approval, intl)

  const refresh = async () => {
    const fresh = await queryClient.fetchQuery({
      ...approvalQueries.detail(approval.id),
      staleTime: 0,
    })
    onChange(fresh, false)
  }

  /** What changed elsewhere once a request was decided: the rail, Home and the decided list. */
  const settle = async (settled: ApprovalView) => {
    onChange(settled, true)
    const areas = settingsAreasOf(settled)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: approvalKeys.waiting() }),
      queryClient.invalidateQueries({ queryKey: approvalKeys.list('decided') }),
      settled.status === 'executed' && areas.length > 0
        ? refreshSettingsAreaQueries(queryClient, areas)
        : null,
    ])
    if (settled.status === 'executed' && areas.length > 0) await router.invalidate()
  }

  /**
   * A high-risk request needs a sign-in made just before the decision. Until
   * the person can sign in again from here, the page says that is what it
   * takes.
   */
  const requestSignInAgain = () => setError(intl.formatMessage(approvalMessages.errorSignIn))

  const refused = async (code: string) => {
    if (code === 'RECENT_SIGN_IN_REQUIRED') return requestSignInAgain()
    setError(intl.formatMessage(refusalMessage(code)))
    if (code === 'APPROVAL_CONTENT_CHANGED' || code === 'PENDING_ACTION_NOT_DECIDABLE')
      await refresh().catch(() => undefined)
  }

  const decide = async (run: () => Promise<ApprovalDecisionResult>) => {
    setBusy(true)
    setError(null)
    try {
      const result = await run()
      if (result.ok) {
        setRejecting(false)
        setReason('')
        await settle(result.approval)
      } else await refused(result.code)
    } catch {
      setError(intl.formatMessage(approvalMessages.errorFailed))
    } finally {
      setBusy(false)
    }
  }

  const approve = () =>
    decide(() =>
      approveApprovalFn({ data: { approvalId: approval.id, contentHash: approval.contentHash } })
    )

  const reject = () =>
    decide(() =>
      rejectApprovalFn({
        data: {
          approvalId: approval.id,
          contentHash: approval.contentHash,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      })
    )

  const undo = async () => {
    setBusy(true)
    setError(null)
    try {
      await undoWorkspaceSettingsProposalFn({ data: { pendingActionId: approval.id } })
      const fresh = await queryClient.fetchQuery({
        ...approvalQueries.detail(approval.id),
        staleTime: 0,
      })
      await settle(fresh)
    } catch (failure) {
      setError(intl.formatMessage(refusalMessage(refusalCode(failure))))
    } finally {
      setBusy(false)
    }
  }

  const decision =
    approval.status === 'rejected'
      ? intl.formatMessage(approvalMessages.rejectedBy, {
          name: approval.decidedByName ?? intl.formatMessage(approvalMessages.someone),
        })
      : approval.decidedAt
        ? intl.formatMessage(approvalMessages.approvedBy, {
            name: approval.decidedByName ?? intl.formatMessage(approvalMessages.someone),
          })
        : null

  return (
    <section aria-labelledby={`${reasonId}-title`} className="px-5 pt-6 pb-10 sm:px-9 sm:pt-7">
      {onBack && (
        <Button variant="ghost" size="sm" className="-ms-2 mb-3 md:hidden" onClick={onBack}>
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          {intl.formatMessage(approvalMessages.back)}
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        <ApprovalRiskChip risk={approval.risk} />
        {area && <span className="text-[13px] text-muted-foreground">{area}</span>}
      </div>
      <h2
        id={`${reasonId}-title`}
        className="mt-2.5 text-xl font-semibold leading-snug tracking-tight text-foreground"
      >
        {approval.summary}
      </h2>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
        <span>
          {intl.formatMessage(approvalMessages.requestedBy, { name: requester, b: bold })}
        </span>
        {person && (
          <span>{intl.formatMessage(approvalMessages.for, { name: person, b: bold })}</span>
        )}
        <span>{getTimeAgo(approval.proposedAt, intl.locale)}</span>
        {approval.status === 'proposed' ? (
          <span>
            {intl.formatMessage(approvalMessages.expires, {
              when: getTimeAgo(approval.expiresAt, intl.locale),
            })}
          </span>
        ) : (
          decision && <span>{decision}</span>
        )}
        {approval.status === 'rejected' && approval.decisionReason && (
          <span>
            {intl.formatMessage(approvalMessages.reasonGiven, { reason: approval.decisionReason })}
          </span>
        )}
      </div>

      <Suspense fallback={null}>
        <AskMessages>
          <ApprovalChanges diff={approval.diff} />
        </AskMessages>
      </Suspense>

      {stage === 'deciding' && approval.canDecide && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button type="button" disabled={busy} onClick={() => void approve()}>
            {intl.formatMessage(approvalMessages.approve)}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setError(null)
              setRejecting(true)
            }}
          >
            {intl.formatMessage(approvalMessages.reject)}
          </Button>
        </div>
      )}

      {stage === 'rejecting' && (
        <div className="mt-5 max-w-lg space-y-2.5">
          <Label htmlFor={reasonId} className="text-sm font-normal text-muted-foreground">
            {intl.formatMessage(approvalMessages.reasonLabel, { name: told })}
          </Label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={500}
            autoFocus
            placeholder={intl.formatMessage(approvalMessages.reasonPlaceholder)}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => void reject()}>
              {intl.formatMessage(approvalMessages.reject)}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setRejecting(false)
                setError(null)
              }}
            >
              {intl.formatMessage(approvalMessages.cancel)}
            </Button>
          </div>
        </div>
      )}

      {(stage === 'applied' ||
        stage === 'failed' ||
        stage === 'rejected' ||
        stage === 'undone') && (
        <div
          role="status"
          className={cn(
            'mt-6 flex items-center gap-3 rounded-xl border px-4 py-3.5 text-sm duration-150 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1',
            stage === 'applied'
              ? 'border-success/30 bg-success/10 text-foreground'
              : 'border-border bg-muted/40 text-foreground'
          )}
        >
          {stage === 'applied' && (
            <CheckIcon className="size-4 shrink-0 text-success" aria-hidden="true" />
          )}
          <span className="min-w-0">
            {stage === 'applied'
              ? approval.undoable
                ? intl.formatMessage(approvalMessages.applied, { name: told })
                : intl.formatMessage(approvalMessages.appliedFinal)
              : stage === 'rejected'
                ? intl.formatMessage(approvalMessages.rejected, { name: told })
                : stage === 'undone'
                  ? intl.formatMessage(approvalMessages.undone)
                  : intl.formatMessage(approvalMessages.failed)}
          </span>
          {stage === 'applied' && approval.undoable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void undo()}
              className="ms-auto shrink-0 rounded-sm font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {intl.formatMessage(approvalMessages.undo)}
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
