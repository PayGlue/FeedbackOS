// @vitest-environment happy-dom
/**
 * The incident editor around publishing and posting: what it says about the
 * publish email, which lifecycle moves it offers, and how a sidebar edit made
 * just before posting lands relative to the post.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'

const INCIDENT_ID = 'status_incident_01h455vb4pex5vsknk084sn02q'
const API = 'status_component_01h455vb4pex5vsknk084sn02b'

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: INCIDENT_ID,
    kind: 'incident',
    title: 'Elevated errors',
    status: 'investigating',
    impact: 'major',
    impactOverride: false,
    scheduledStartAt: null,
    scheduledEndAt: null,
    autoStart: true,
    autoComplete: true,
    startedAt: '2026-10-10T08:00:00.000Z',
    resolvedAt: null,
    backfilled: false,
    notifiedAt: '2026-10-10T08:00:01.000Z',
    notifySubscribers: true,
    createdBy: null,
    createdAt: '2026-10-10T08:00:00.000Z',
    updatedAt: '2026-10-10T08:00:00.000Z',
    notifiedSubscriberCount: 12,
    affectedComponents: [{ componentId: API, componentStatus: 'major_outage', name: 'API' }],
    updates: [
      {
        id: 'status_incident_update_1',
        status: 'investigating',
        body: 'Looking into it.',
        createdAt: '2026-10-10T08:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

let detail: ReturnType<typeof incident>
const choices = { groups: [], ungrouped: [{ id: API, name: 'API' }] }
const mockUpdate = vi.fn()
const mockPost = vi.fn()

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (opts: { queryKey: string[] }) => {
    if (opts.queryKey.includes('choices')) return { data: choices, isLoading: false }
    if (opts.queryKey.includes('templates')) return { data: [] }
    return { data: detail, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/lib/client/queries/status', () => ({
  statusIncidentQueries: { detail: (id: string) => ({ queryKey: ['status', 'detail', id] }) },
  statusComponentQueries: { choices: () => ({ queryKey: ['status', 'components', 'choices'] }) },
  statusTemplateQueries: { list: () => ({ queryKey: ['status', 'templates'] }) },
  statusKeys: { components: () => ['status', 'components'] },
}))
vi.mock('@/lib/client/mutations/status', () => ({
  useUpdateStatusIncident: () => ({ mutateAsync: mockUpdate, isPending: false }),
  usePostStatusIncidentUpdate: () => ({ mutateAsync: mockPost, isPending: false }),
}))

import { StatusIncidentModal } from '../status-incident-editor'

function renderEditor() {
  return render(
    <IntlProvider locale="en" defaultLocale="en" onError={() => {}}>
      <StatusIncidentModal incidentId={INCIDENT_ID} />
    </IntlProvider>
  )
}

beforeEach(() => {
  detail = incident()
  mockUpdate.mockReset()
  mockPost.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('incident editor, the publish email', () => {
  it('says subscribers were emailed, with the count, when they were', () => {
    renderEditor()
    expect(screen.getAllByText(/emailed ~12 subscribers/).length).toBeGreaterThan(0)
  })

  it('says they were not when "Email subscribers" was off, though notifiedAt is set', () => {
    // An unticked publish is stamped notified_at so an older version's
    // sweep never sends it; the choice, not the stamp, says what happened.
    detail = incident({ notifySubscribers: false, notifiedSubscriberCount: null })
    renderEditor()

    expect(screen.getAllByText('Published · subscribers not emailed').length).toBeGreaterThan(0)
    expect(screen.queryByText(/emailed ~/)).toBeNull()
    expect(screen.queryByText('Published')).toBeNull()
  })
})
