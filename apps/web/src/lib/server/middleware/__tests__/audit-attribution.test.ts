/**
 * The request boundary for audit attribution: a signed-in server function is
 * attributed to the app (`ui`), and every other request opens an empty slot
 * that a credential boundary inside the handler (REST key auth) fills.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/server/config', () => ({ config: { trustedProxyHops: 1 } }))

const mockInsertValues = vi.fn()
vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: { insert: () => ({ values: (...args: unknown[]) => mockInsertValues(...args) }) },
}))

const { handleRequestWithAuditAttribution } = await import('../audit-attribution')
const { recordAuditEvent } = await import('@/lib/server/audit/log')
const { setAuditAttribution, getAuditAttribution } = await import('@/lib/server/audit/attribution')

beforeEach(() => {
  vi.clearAllMocks()
  mockInsertValues.mockResolvedValue(undefined)
})

function request(method: string, path: string, headers: Record<string, string> = {}) {
  return new Request(`https://acme.example${path}`, { method, headers })
}

describe('audit attribution request boundary', () => {
  it('attributes changes made in a server function to the app', async () => {
    await handleRequestWithAuditAttribution({
      request: request('POST', '/_serverFn/abc'),
      handlerType: 'serverFn',
      next: async () => {
        await recordAuditEvent({ event: 'auth.password.disabled', actor: { email: 'a@b.com' } })
        return {}
      },
    })
    expect(mockInsertValues.mock.calls[0][0]).toMatchObject({ channel: 'ui', credentialKind: null })
  })

  it('opens an empty slot for other requests that a boundary inside the handler fills', async () => {
    const seen: unknown[] = []
    await handleRequestWithAuditAttribution({
      request: request('GET', '/api/widget/config'),
      handlerType: 'router',
      next: async () => {
        seen.push(getAuditAttribution())
        setAuditAttribution({ channel: 'api', clientName: 'Zapier' })
        await recordAuditEvent({ event: 'sso.config.changed', actor: { email: 'a@b.com' } })
        return {}
      },
    })
    expect(seen).toEqual([null])
    expect(mockInsertValues.mock.calls[0][0]).toMatchObject({
      channel: 'api',
      clientName: 'Zapier',
    })
  })

  it('never lets one request see another request’s attribution', async () => {
    const seen: unknown[] = []
    await handleRequestWithAuditAttribution({
      request: request('POST', '/api/v1/posts'),
      handlerType: 'router',
      next: async () => {
        setAuditAttribution({ channel: 'api', clientName: 'First' })
        return {}
      },
    })
    await handleRequestWithAuditAttribution({
      request: request('POST', '/api/widget/identify'),
      handlerType: 'router',
      next: async () => {
        seen.push(getAuditAttribution())
        return {}
      },
    })
    expect(seen).toEqual([null])
  })
})
