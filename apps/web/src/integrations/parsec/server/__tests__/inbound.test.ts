/**
 * Tests for Parsec inbound webhook handler.
 */

import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { parsecInboundHandler } from '@/integrations/parsec/server/inbound'

const SECRET = 'test-secret'

function header(body: string, timestamp = Math.floor(Date.now() / 1000), secret = SECRET): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${digest}`
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/webhook', { headers })
}

const stateChanged = {
  action: 'update',
  type: 'Issue',
  event: 'issue.state_changed',
  createdAt: '2026-11-01T10:00:00.000Z',
  data: {
    projectId: 7,
    identifier: 'PROJ-42',
    state: { id: 3, name: 'In Progress', type: 'started' },
  },
}

const parse = (payload: unknown) =>
  parsecInboundHandler.parseStatusChange(JSON.stringify(payload), {}, {})

describe('parsecInboundHandler.verifySignature', () => {
  const body = JSON.stringify(stateChanged)

  it('accepts a correctly signed request', async () => {
    const request = makeRequest({ 'X-Itsaplan-Signature': header(body) })
    expect(await parsecInboundHandler.verifySignature(request, body, SECRET)).toBe(true)
  })

  it('rejects a missing header', async () => {
    const result = await parsecInboundHandler.verifySignature(makeRequest(), body, SECRET)
    expect((result as Response).status).toBe(401)
  })

  it('rejects a malformed header', async () => {
    const request = makeRequest({ 'X-Itsaplan-Signature': 'sha256=abc' })
    const result = await parsecInboundHandler.verifySignature(request, body, SECRET)
    expect((result as Response).status).toBe(401)
  })

  it('rejects a signature from another secret', async () => {
    const request = makeRequest({
      'X-Itsaplan-Signature': header(body, undefined, 'other-secret'),
    })
    const result = await parsecInboundHandler.verifySignature(request, body, SECRET)
    expect((result as Response).status).toBe(401)
  })

  it('rejects a tampered body', async () => {
    const request = makeRequest({ 'X-Itsaplan-Signature': header(body) })
    const result = await parsecInboundHandler.verifySignature(request, `${body} `, SECRET)
    expect((result as Response).status).toBe(401)
  })

  it('rejects a replayed delivery', async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600
    const request = makeRequest({ 'X-Itsaplan-Signature': header(body, stale) })
    const result = await parsecInboundHandler.verifySignature(request, body, SECRET)
    expect((result as Response).status).toBe(401)
  })
})

describe('parsecInboundHandler.parseStatusChange', () => {
  it('reads the column name, the identifier and the project', async () => {
    expect(await parse(stateChanged)).toEqual({
      destinationId: '7',
      occurredAt: '2026-11-01T10:00:00.000Z',
      externalId: 'PROJ-42',
      externalStatus: 'In Progress',
      eventType: 'issue.state_changed',
    })
  })

  it('ignores other events', async () => {
    expect(await parse({ ...stateChanged, event: 'issue.assigned' })).toBeNull()
  })

  it('ignores a payload without a state', async () => {
    expect(
      await parse({ ...stateChanged, data: { projectId: 7, identifier: 'PROJ-42' } })
    ).toBeNull()
  })
})
