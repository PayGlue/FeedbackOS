import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createId, type ConversationId, type PrincipalId, type UserId } from '@quackback/ids'
import {
  db,
  user,
  principal,
  conversations,
  conversationMessages,
  supportAgents,
  supportAgentTurns,
  eq,
  and,
} from '@/lib/server/db'
import {
  registerExternalAgent,
  verifyAgentCredential,
  type RegisteredAgent,
} from '../support-agents.service'
import { requestAgentTurn, getTurn, releaseAgentControl, expireTurn } from '../turns.service'
import {
  postAgentReply,
  streamAgentText,
  handOffToTeam,
  resolveAsAgent,
} from '../agent-actions.service'
import * as assistant from '@/lib/server/domains/assistant'

let registered: RegisteredAgent
let conversationId: ConversationId
let customerId: PrincipalId
let customerUserId: UserId

beforeAll(() => {
  vi.stubEnv('BASE_URL', 'http://localhost:3199')
  vi.stubEnv('SECRET_KEY', 'agent-turns-test-secret-local-and-ci-000000')
})
afterAll(() => vi.unstubAllEnvs())

beforeEach(async () => {
  customerUserId = createId('user')
  customerId = createId('principal')
  conversationId = createId('conversation')
  await db
    .insert(user)
    .values({ id: customerUserId, name: 'Customer', email: `${customerUserId}@example.test` })
  await db.insert(principal).values({
    id: customerId,
    userId: customerUserId,
    role: 'user',
    type: 'user',
    createdAt: new Date(),
  })
  await db
    .insert(conversations)
    .values({ id: conversationId, visitorPrincipalId: customerId, channel: 'messenger' })
  registered = await registerExternalAgent({
    name: 'Test AI',
    endpointUrl: 'https://agent.example.com/turn',
    fallback: 'team',
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (conversationId) await db.delete(conversations).where(eq(conversations.id, conversationId))
  if (registered) {
    await db.delete(supportAgents).where(eq(supportAgents.id, registered.agent.id))
    if (registered.agent.principalId)
      await db.delete(principal).where(eq(principal.id, registered.agent.principalId))
  }
  if (customerId) await db.delete(principal).where(eq(principal.id, customerId))
  if (customerUserId) await db.delete(user).where(eq(user.id, customerUserId))
})

async function customerMessage(content = 'Help me', at = new Date()) {
  const [message] = await db
    .insert(conversationMessages)
    .values({
      conversationId,
      principalId: customerId,
      senderType: 'visitor',
      content,
      createdAt: at,
    })
    .returning()
  return message
}

async function newTurn() {
  const message = await customerMessage()
  const turn = await requestAgentTurn({
    conversationId,
    agent: registered.agent,
    triggerMessageId: message.id,
  })
  if (!turn) throw new Error('Turn was not requested')
  return turn
}

const replies = () =>
  db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.senderType, 'agent')
      )
    )

describe('agent turns against PostgreSQL', () => {
  it('uses the agent credential rather than a teammate key', async () => {
    expect(registered.credential.startsWith('qba_')).toBe(true)
    expect((await verifyAgentCredential(registered.credential))?.id).toBe(registered.agent.id)
    expect(await verifyAgentCredential('qb_not_an_agent_key')).toBeNull()
  })

  it('deduplicates simultaneous intake of the same customer message', async () => {
    const message = await customerMessage()
    const [a, b] = await Promise.all(
      [0, 1].map(() =>
        requestAgentTurn({
          conversationId,
          agent: registered.agent,
          triggerMessageId: message.id,
        })
      )
    )
    expect(a!.id).toBe(b!.id)
    expect(
      await db
        .select()
        .from(supportAgentTurns)
        .where(eq(supportAgentTurns.conversationId, conversationId))
    ).toHaveLength(1)
  })

  it('stores one reply and its receipt atomically when two calls compete', async () => {
    const turn = await newTurn()
    const input = {
      agent: registered.agent,
      conversationId,
      turnId: turn.id,
      content: 'Here is the answer',
      idempotencyKey: 'reply-1',
    }
    const results = await Promise.all([postAgentReply(input), postAgentReply(input)])
    expect(results[0].messageId).toBe(results[1].messageId)
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true])
    expect(await replies()).toHaveLength(1)
    expect(await getTurn(turn.id)).toMatchObject({
      status: 'replied',
      replyKey: 'reply-1',
      replyMessageId: results[0].messageId,
    })
  })

  it('rolls back the message and receipt if recording the answer fails', async () => {
    const turn = await newTurn()
    vi.spyOn(assistant, 'recordAssistantAnswer').mockRejectedValueOnce(
      new Error('injected failure')
    )
    await expect(
      postAgentReply({
        agent: registered.agent,
        conversationId,
        turnId: turn.id,
        content: 'An answer',
        idempotencyKey: 'retryable',
      })
    ).rejects.toThrow('injected failure')
    expect(await replies()).toHaveLength(0)
    expect(await getTurn(turn.id)).toMatchObject({
      status: 'requested',
      replyKey: null,
      replyMessageId: null,
    })
  })

  it('supersedes an old turn and refuses its late reply', async () => {
    const turn = await newTurn()
    const newer = await customerMessage('One more thing', new Date(Date.now() + 100))
    const current = await requestAgentTurn({
      conversationId,
      agent: registered.agent,
      triggerMessageId: newer.id,
    })
    expect(current!.id).not.toBe(turn.id)
    await expect(
      postAgentReply({
        agent: registered.agent,
        conversationId,
        turnId: turn.id,
        content: 'Old answer',
        idempotencyKey: 'late',
      })
    ).rejects.toMatchObject({ code: 'STALE_TURN' })
    expect(await replies()).toHaveLength(0)
  })

  it('refuses publication after a teammate takes over', async () => {
    const turn = await newTurn()
    await releaseAgentControl(conversationId)
    await expect(
      postAgentReply({
        agent: registered.agent,
        conversationId,
        turnId: turn.id,
        content: 'Late answer',
        idempotencyKey: 'late',
      })
    ).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
    expect(await replies()).toHaveLength(0)
  })

  it('enforces the deadline even before its job runs', async () => {
    const turn = await newTurn()
    await db
      .update(supportAgentTurns)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(supportAgentTurns.id, turn.id))
    await expect(
      postAgentReply({
        agent: registered.agent,
        conversationId,
        turnId: turn.id,
        content: 'Late answer',
        idempotencyKey: 'late',
      })
    ).rejects.toMatchObject({ code: 'STALE_TURN' })
    expect(await replies()).toHaveLength(0)
  })

  it('stops streaming when a teammate takes control between chunks', async () => {
    const turn = await newTurn()
    async function* chunks() {
      yield 'First part'
      await releaseAgentControl(conversationId)
      yield 'Last part'
    }
    await expect(
      streamAgentText(registered.agent, conversationId, turn.id, chunks(), 4000)
    ).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
    expect(await replies()).toHaveLength(0)
  })
  it('recovers an expired turn after fallback fails, without applying it twice', async () => {
    const turn = await newTurn()
    vi.spyOn(assistant, 'recordHandoff').mockRejectedValueOnce(new Error('fallback failed'))
    await expect(expireTurn(turn.id, { force: true })).rejects.toThrow('fallback failed')
    expect(await getTurn(turn.id)).toMatchObject({ status: 'expired', fallbackAppliedAt: null })
    await expireTurn(turn.id)
    expect((await getTurn(turn.id))!.fallbackAppliedAt).toBeInstanceOf(Date)
    const first = await replies()
    await expireTurn(turn.id)
    expect(await replies()).toHaveLength(first.length)
  })

  it('does not apply an old deadline to a newer agent turn', async () => {
    const old = await newTurn()
    const message = await customerMessage('New question', new Date(Date.now() + 100))
    const current = await requestAgentTurn({
      conversationId,
      agent: registered.agent,
      triggerMessageId: message.id,
    })
    await expireTurn(old.id, { force: true })
    expect(await getTurn(current!.id)).toMatchObject({
      status: 'requested',
      fallbackAppliedAt: null,
    })
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
    expect(conversation.controllerAgentId).toBe(registered.agent.id)
  })

  it('refuses handoff and resolution after human takeover', async () => {
    await newTurn()
    await releaseAgentControl(conversationId)
    await expect(
      handOffToTeam({ agent: registered.agent, conversationId, reason: 'system_error' })
    ).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
    await expect(
      resolveAsAgent({ agent: registered.agent, conversationId, confirmed: true })
    ).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
    expect(await replies()).toHaveLength(0)
  })
})
