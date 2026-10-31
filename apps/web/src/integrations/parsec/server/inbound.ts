/**
 * Parsec inbound webhook handler.
 *
 * Signature: `X-Itsaplan-Signature: t=<seconds>,v1=<hex>`, HMAC-SHA256 of
 * `<t>.<raw body>` with the secret Parsec issued when the webhook was created.
 * Every delivery attempt signs afresh, so a stale timestamp is a replay rather
 * than a slow retry.
 * Status field: `data.state.name`, the name of the issue's column.
 */

import { timingSafeEqual, createHmac } from 'crypto'
import type {
  InboundWebhookHandler,
  InboundWebhookResult,
} from '@/lib/server/integrations/inbound-types'

const MAX_AGE_SECONDS = 300

export const parsecInboundHandler: InboundWebhookHandler = {
  statusMode: 'automatic',
  async verifySignature(request: Request, body: string, secret: string): Promise<true | Response> {
    const header = request.headers.get('X-Itsaplan-Signature')
    if (!header) {
      return new Response('Missing signature', { status: 401 })
    }

    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header)
    if (!match) {
      return new Response('Invalid signature', { status: 401 })
    }

    const [, timestamp, signature] = match
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    const valid = timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    if (!valid) {
      return new Response('Invalid signature', { status: 401 })
    }

    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) {
      return new Response('Stale signature', { status: 401 })
    }

    return true
  },

  async parseStatusChange(body: string): Promise<InboundWebhookResult | null> {
    const payload = JSON.parse(body)

    if (payload.event !== 'issue.state_changed') {
      return null
    }

    const stateName = payload.data?.state?.name
    const identifier = payload.data?.identifier
    if (!stateName || !identifier) return null

    return {
      destinationId: String(payload.data.projectId),
      occurredAt: payload.createdAt,
      externalId: identifier,
      externalStatus: stateName,
      eventType: payload.event,
    }
  },
}
