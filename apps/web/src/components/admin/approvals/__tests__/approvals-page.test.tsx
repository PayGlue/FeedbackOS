// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalView } from '@/lib/server/domains/assistant/approvals.queue'

const state = vi.hoisted(() => ({
  search: {} as { view?: 'decided'; id?: string },
  navigate: vi.fn(),
  waiting: [] as unknown[],
  decided: [] as unknown[],
  approve: vi.fn(),
  reject: vi.fn(),
  getApproval: vi.fn(),
  undo: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({
    useNavigate: () => state.navigate,
    useSearch: () => state.search,
  }),
  useRouter: () => ({ invalidate: vi.fn(async () => undefined) }),
}))
vi.mock('@/lib/server/functions/approvals', () => ({
  listApprovalsFn: async ({ data }: { data: { view?: string } }) =>
    data.view === 'decided' ? state.decided : state.waiting,
  getApprovalFn: (args: unknown) => state.getApproval(args),
  getWaitingApprovalsFn: async () => ({ count: 0, latest: [] }),
  approveApprovalFn: (args: unknown) => state.approve(args),
  rejectApprovalFn: (args: unknown) => state.reject(args),
}))
vi.mock('@/lib/server/functions/workspace-copilot', () => ({
  undoWorkspaceSettingsProposalFn: (args: unknown) => state.undo(args),
}))
// The settings labels load with Copilot's strings; English renders from the code.
vi.mock('@/components/admin/ask/ask-messages', () => ({
  AskMessages: ({ children }: { children: ReactNode }) => children,
}))

const { ApprovalsPage } = await import('../approvals-page')

function view(overrides: Partial<ApprovalView> = {}): ApprovalView {
  const now = Date.now()
  return {
    id: 'assistant_action_01',
    toolName: 'propose_settings_change',
    summary: 'Change the workspace name',
    risk: 'low',
    status: 'proposed',
    parent: { kind: 'thread', id: null },
    requestedVia: 'mcp',
    requestedById: 'principal_key',
    requestedByName: 'Zapier key',
    onBehalfOfPrincipalId: 'principal_james',
    onBehalfOfName: 'James Morton',
    clientName: null,
    proposedAt: new Date(now - 4 * 60_000).toISOString(),
    expiresAt: new Date(now + 23 * 3_600_000).toISOString(),
    contentHash: 'digest-1',
    needsFreshSignIn: false,
    canDecide: true,
    decidedById: null,
    decidedByName: null,
    decidedAt: null,
    decidedVia: null,
    decisionReason: null,
    undoable: false,
    undone: false,
    diff: {
      kind: 'settings',
      changes: [
        {
          id: 'portal.displayName',
          area: 'portal',
          path: ['displayName'],
          before: 'Acme',
          after: 'Acme team',
        },
      ],
    },
    ...overrides,
  }
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <ApprovalsPage />
      </IntlProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  state.search = {}
  state.navigate.mockReset()
  state.approve.mockReset()
  state.reject.mockReset()
  state.getApproval.mockReset()
  state.undo.mockReset()
  state.waiting = []
  state.decided = []
})
afterEach(cleanup)

describe('ApprovalsPage', () => {
  it('lists what is waiting, with risk and who asked, and opens the newest beside it', async () => {
    state.waiting = [
      view(),
      view({
        id: 'assistant_action_02',
        summary: 'Close the conversation',
        risk: 'high',
        toolName: 'end_conversation',
        parent: { kind: 'conversation', id: 'conversation_1' },
        proposedAt: new Date(Date.now() - 3_600_000).toISOString(),
        diff: { kind: 'action', args: {} },
      }),
    ]
    renderPage()
    const list = await screen.findByRole('list')
    expect(within(list).getByText('Change the workspace name')).toBeInTheDocument()
    expect(within(list).getByText('Close the conversation')).toBeInTheDocument()
    expect(within(list).getByText('High')).toHaveAttribute('data-risk', 'high')
    expect(screen.getByRole('tab', { name: /Waiting/ })).toHaveTextContent('2')
    const detail = screen.getByRole('heading', { level: 2, name: 'Change the workspace name' })
    expect(detail).toBeInTheDocument()
    expect(screen.getByText('Zapier key', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByText('James Morton', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByText('Changes')).toBeInTheDocument()
    expect(screen.getByText('Acme team')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('lists decided requests with their outcome and no decision buttons', async () => {
    state.search = { view: 'decided' }
    state.decided = [
      view({
        status: 'rejected',
        canDecide: false,
        decidedById: 'principal_ada',
        decidedByName: 'Ada Admin',
        decidedAt: new Date().toISOString(),
        decisionReason: 'Keep the name',
      }),
    ]
    renderPage()
    const list = await screen.findByRole('list')
    expect(within(list).getByText(/Rejected/)).toBeInTheDocument()
    expect(screen.getByText('Rejected by Ada Admin')).toBeInTheDocument()
    expect(screen.getByText('Reason: Keep the name')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('moves between Waiting and Decided through the URL', async () => {
    state.waiting = [view()]
    renderPage()
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('tab', { name: 'Decided' }))
    expect(state.navigate).toHaveBeenCalled()
    const { search } = state.navigate.mock.calls[0]![0] as {
      search: (previous: object) => object
    }
    expect(search({ id: 'assistant_action_01' })).toEqual({ view: 'decided', id: undefined })
  })

  it('says when nothing is waiting', async () => {
    renderPage()
    expect(await screen.findByText('Nothing waiting.')).toBeInTheDocument()
  })

  it('asks for a reason inline before rejecting, and says who was told', async () => {
    state.waiting = [view()]
    state.reject.mockResolvedValue({
      ok: true,
      approval: view({ status: 'rejected', canDecide: false, decisionReason: 'Not now' }),
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    expect(state.reject).not.toHaveBeenCalled()
    const reason = screen.getByLabelText('Reason, sent to James Morton')
    expect(reason).toHaveAttribute('placeholder', 'Optional')
    fireEvent.change(reason, { target: { value: 'Not now' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await screen.findByText('Rejected.')
    expect(state.reject).toHaveBeenCalledWith({
      data: { approvalId: 'assistant_action_01', contentHash: 'digest-1', reason: 'Not now' },
    })
    // The request stays in the list with its outcome.
    expect(within(screen.getByRole('list')).getByText(/Rejected/)).toBeInTheDocument()
  })

  it('lets the reason form be cancelled without deciding', async () => {
    state.waiting = [view()]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Reason, sent to James Morton')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(state.reject).not.toHaveBeenCalled()
  })

  it('approves with the hash it showed and offers Undo where the change can be undone', async () => {
    state.waiting = [view()]
    state.approve.mockResolvedValue({
      ok: true,
      approval: view({ status: 'executed', canDecide: false, undoable: true }),
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await screen.findByText('Applied just now.')
    expect(state.approve).toHaveBeenCalledWith({
      data: { approvalId: 'assistant_action_01', contentHash: 'digest-1' },
    })
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('refreshes a request that changed and asks for another look', async () => {
    state.waiting = [view()]
    state.approve.mockResolvedValue({
      ok: false,
      code: 'APPROVAL_CONTENT_CHANGED',
      message: 'This request changed. Review it again.',
    })
    state.getApproval.mockResolvedValue(
      view({
        contentHash: 'digest-2',
        diff: {
          kind: 'settings',
          changes: [
            {
              id: 'portal.displayName',
              area: 'portal',
              path: ['displayName'],
              before: 'Acme',
              after: 'Acme people',
            },
          ],
        },
      })
    )
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This request changed. Review it again.'
    )
    await screen.findByText('Acme people')
    expect(state.getApproval).toHaveBeenCalledWith({ data: { approvalId: 'assistant_action_01' } })
    // The next decision names the content now on screen.
    state.approve.mockResolvedValue({ ok: true, approval: view({ status: 'executed' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() =>
      expect(state.approve).toHaveBeenLastCalledWith({
        data: { approvalId: 'assistant_action_01', contentHash: 'digest-2' },
      })
    )
  })

  it('keeps Approve on a high-risk request and asks for a recent sign-in when refused', async () => {
    state.waiting = [view({ risk: 'high', needsFreshSignIn: true })]
    state.approve.mockResolvedValue({
      ok: false,
      code: 'RECENT_SIGN_IN_REQUIRED',
      message: 'Sign in again to decide this request.',
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in again to approve')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })
})
