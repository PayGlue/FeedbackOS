/**
 * What the workspace's own AI agent can do to a conversation it controls:
 * show that it is working, stream its text, reply, hand off to the team and
 * resolve. Every write is checked against the conversation's current
 * controller first, so an agent that lost the conversation (a teammate took
 * it, the deadline passed) cannot write to it.
 *
 * Replies are ordinary assistant-style messages from the agent's own service
 * principal, so they read as AI everywhere, and they land on the same
 * involvement records the built-in AI writes, so analytics count them alike.
 */
import {
  db,
  conversations,
  conversationMessages,
  assistantInvolvements,
  supportAgentTurns,
  and,
  eq,
  inArray,
  type AssistantHandoffReason,
  type Conversation,
} from '@/lib/server/db'
import type {
  ConversationId,
  ConversationMessageId,
  SupportAgentTurnId,
} from '@quackback/ids'
import type {
  ConversationMessageCitation,
  ConversationStreamEvent,
} from '@/lib/shared/conversation/types'
import type { ConversationAuthorInput } from '@/lib/server/domains/conversation/conversation.types'
import type { TiptapContent } from '@/lib/server/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/shared/errors'
import {
  publishAgentConversationEvent,
  publishConversationOnlyEvent,
} from '@/lib/server/realtime/conversation-channels'
import {
  clearActivitySnapshot,
  writeActivitySnapshot,
} from '@/lib/server/domains/assistant/assistant-activity-snapshot'
import { toMessageDTO } from '@/lib/server/messages/message-core'
import { logger } from '@/lib/server/logger'
import type { AgentActivityStatus } from '@/lib/shared/support-agents'
import type { SupportAgent } from './support-agents.service'
import { getTurn, recordTurnReply, releaseAgentControl, settleTurn } from './turns.service'

const log = logger.child({ component: 'agent-actions' })

type TurnRow = NonNullable<Awaited<ReturnType<typeof getTurn>>>

function authorOf(agent: SupportAgent): ConversationAuthorInput {
  if (!agent.principalId) throw new Error('support agent has no principal')
  return { principalId: agent.principalId, displayName: agent.name, avatarUrl: null }
}

async function loadConversation(conversationId: ConversationId): Promise<Conversation> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  if (!row) throw new NotFoundError('CONVERSATION_NOT_FOUND', 'Conversation not found')
  return row
}

/** Who controls the conversation right now, for the 409 an agent receives. */
async function currentControllerOf(
  conversation: Conversation
): Promise<'ai_agent' | 'quackback_ai' | 'team'> {
  if (conversation.controllerAgentId) return 'ai_agent'
  const { getLatestInvolvement } = await import('@/lib/server/domains/assistant')
  const latest = await getLatestInvolvement(conversation.id)
  return latest?.status === 'active' && latest.supportAgentId === null ? 'quackback_ai' : 'team'
}

/** The conversation, once the agent is confirmed as its controller. */
export async function assertAgentControls(
  agent: SupportAgent,
  conversationId: ConversationId
): Promise<Conversation> {
  const conversation = await loadConversation(conversationId)
  if (conversation.controllerAgentId !== agent.id) {
    const controller = await currentControllerOf(conversation)
    throw new ConflictError(
      'NOT_CONTROLLER',
      `This conversation is not controlled by this agent. Current controller: ${controller}`
    )
  }
  return conversation
}

/** The agent's active involvement on the conversation, opened if it has none. */
async function engage(agent: SupportAgent, conversationId: ConversationId) {
  const { getLatestInvolvement, openInvolvement, voidAssumedResolutionForConversation } =
    await import('@/lib/server/domains/assistant')
  const revived = await voidAssumedResolutionForConversation(conversationId)
  const latest = revived ?? (await getLatestInvolvement(conversationId))
  if (latest?.status === 'active') {
    if (latest.supportAgentId === agent.id) return latest
    // Another answerer was engaged before this agent took over.
    await db
      .update(assistantInvolvements)
      .set({ status: 'abandoned', endedAt: new Date() })
      .where(eq(assistantInvolvements.id, latest.id))
  }
  return openInvolvement({
    conversationId,
    triggeredBy: 'first_touch',
    supportAgentId: agent.id,
  })
}

async function claimTurn(
  agent: SupportAgent,
  conversationId: ConversationId,
  turnId: SupportAgentTurnId
): Promise<TurnRow> {
  const turn = await getTurn(turnId)
  if (!turn || turn.conversationId !== conversationId || turn.agentId !== agent.id) {
    throw new NotFoundError('TURN_NOT_FOUND', 'Turn not found')
  }
  return turn
}

export interface AgentReplyInput {
  agent: SupportAgent
  conversationId: ConversationId
  turnId: SupportAgentTurnId
  content: string
  contentJson?: TiptapContent | null
  citations?: ConversationMessageCitation[]
  idempotencyKey: string
}

export interface AgentReplyResult {
  messageId: ConversationMessageId
  createdAt: string
  replayed: boolean
}

/** Post the agent's answer to an open turn. A retry with the same key returns the same message. */
export async function postAgentReply(input: AgentReplyInput): Promise<AgentReplyResult> {
  const { agent, conversationId, turnId, idempotencyKey } = input
  const content = input.content.trim()
  if (!content) throw new ValidationError('VALIDATION_ERROR', 'Reply content is required')

  const turn = await claimTurn(agent, conversationId, turnId)
  if (turn.status === 'replied' && turn.replyKey === idempotencyKey && turn.replyMessageId) {
    const [existing] = await db
      .select({ createdAt: conversationMessages.createdAt })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, turn.replyMessageId))
      .limit(1)
    if (existing) {
      return {
        messageId: turn.replyMessageId,
        createdAt: existing.createdAt.toISOString(),
        replayed: true,
      }
    }
  }
  await assertAgentControls(agent, conversationId)

  const claimed = await settleTurn(turnId, 'replied', { replyKey: idempotencyKey, agentId: agent.id })
  if (!claimed) {
    throw new ConflictError(
      'STALE_TURN',
      `This turn is no longer open (it is ${turn.status}). A newer customer message or the deadline replaced it.`
    )
  }

  try {
    const involvement = await engage(agent, conversationId)
    const { appendAssistantReply } =
      await import('@/lib/server/domains/conversation/conversation.service')
    const citations = (input.citations ?? []).map(
      (c): ConversationMessageCitation => ({ type: c.type, id: c.id, title: c.title, url: c.url })
    )
    const message = await appendAssistantReply(conversationId, content, authorOf(agent), {
      waiting: false,
      citations,
      contentJson: input.contentJson ?? null,
    })
    await recordTurnReply(turnId, message.id)
    const { recordAssistantAnswer } = await import('@/lib/server/domains/assistant')
    await recordAssistantAnswer(involvement.id, {
      sources: citations.map((c) => ({ type: c.type, id: c.id, title: c.title, url: c.url })),
    })
    await clearActivitySnapshot(conversationId)
    return { messageId: message.id, createdAt: message.createdAt, replayed: false }
  } catch (err) {
    // The answer never reached the customer: reopen the turn so the agent can retry.
    await db
      .update(supportAgentTurns)
      .set({ status: 'requested', completedAt: null, replyKey: null })
      .where(and(eq(supportAgentTurns.id, turnId), eq(supportAgentTurns.status, 'replied')))
    throw err
  }
}

/** Show the customer that the agent is working. Ephemeral, never stored. */
export async function setAgentActivity(
  agent: SupportAgent,
  conversationId: ConversationId,
  status: AgentActivityStatus
): Promise<void> {
  await assertAgentControls(agent, conversationId)
  const event: ConversationStreamEvent = {
    kind: 'assistant_activity',
    conversationId,
    status,
    at: new Date().toISOString(),
  }
  publishConversationOnlyEvent(conversationId, event)
  void writeActivitySnapshot(conversationId, event)
}

const STREAM_PUBLISH_INTERVAL_MS = 90

/**
 * Show the customer the agent's text as it is written. Each publish carries the
 * whole answer so far, like the built-in AI, so a dropped frame heals on the
 * next one. The persisted reply replaces it.
 */
export async function streamAgentText(
  agent: SupportAgent,
  conversationId: ConversationId,
  turnId: SupportAgentTurnId,
  chunks: AsyncIterable<string>,
  maxChars: number
): Promise<{ chars: number }> {
  await assertAgentControls(agent, conversationId)
  const turn = await claimTurn(agent, conversationId, turnId)
  if (turn.status !== 'requested') {
    throw new ConflictError('STALE_TURN', `This turn is no longer open (it is ${turn.status})`)
  }
  let text = ''
  let lastPublishAt = 0
  const publish = (at: number) => {
    lastPublishAt = at
    publishConversationOnlyEvent(conversationId, {
      kind: 'assistant_delta',
      conversationId,
      text,
      at: new Date(at).toISOString(),
    })
  }
  for await (const chunk of chunks) {
    if (text.length + chunk.length > maxChars) {
      throw new ValidationError('VALIDATION_ERROR', 'The streamed text is too long')
    }
    text += chunk
    const now = Date.now()
    if (now - lastPublishAt >= STREAM_PUBLISH_INTERVAL_MS) publish(now)
  }
  if (text) publish(Date.now())
  return { chars: text.length }
}

async function closeTurns(
  conversationId: ConversationId,
  status: 'handed_off' | 'resolved'
): Promise<void> {
  await db
    .update(supportAgentTurns)
    .set({ status, completedAt: new Date() })
    .where(
      and(
        eq(supportAgentTurns.conversationId, conversationId),
        inArray(supportAgentTurns.status, ['requested', 'replied'])
      )
    )
}

/** An internal note for the teammate who picks the conversation up. */
async function postInternalNote(
  conversationId: ConversationId,
  content: string,
  author: ConversationAuthorInput
): Promise<void> {
  const [message] = await db
    .insert(conversationMessages)
    .values({
      conversationId,
      principalId: author.principalId,
      senderType: 'agent',
      isInternal: true,
      content,
    })
    .returning()
  const dto = toMessageDTO(
    message,
    { principalId: author.principalId, displayName: author.displayName ?? null, avatarUrl: null },
    author.principalId
  )
  publishAgentConversationEvent({ kind: 'message', conversationId, message: dto })
}

/**
 * Give the conversation to the team: the involvement ends as handed off, the
 * customer sees the same transition notice the built-in AI shows, and the
 * conversation is routed to a teammate.
 */
export async function handOffToTeam(input: {
  agent: SupportAgent
  conversationId: ConversationId
  reason: AssistantHandoffReason
  note?: string | null
}): Promise<void> {
  const { agent, conversationId, reason } = input
  const author = authorOf(agent)
  const involvement = await engage(agent, conversationId)
  const { recordHandoff } = await import('@/lib/server/domains/assistant')
  const handed = await recordHandoff(involvement.id, reason)
  if (!handed) throw new ConflictError('ALREADY_ENDED', 'This engagement already ended')

  await releaseAgentControl(conversationId)
  await closeTurns(conversationId, 'handed_off')
  await clearActivitySnapshot(conversationId)

  const label = reason.replace(/_/g, ' ')
  const note = input.note?.trim()
  await postInternalNote(
    conversationId,
    note ? `AI agent handed off (${label}). ${note}` : `AI agent handed off (${label}).`,
    author
  )
  const { executeAssistantHandoff } =
    await import('@/lib/server/domains/conversation/conversation.service')
  await executeAssistantHandoff(conversationId, reason, author)
}

/** Record that the agent resolved the customer's question. */
export async function resolveAsAgent(input: {
  agent: SupportAgent
  conversationId: ConversationId
  confirmed: boolean
  summary?: string | null
}): Promise<{ outcome: 'resolved_confirmed' | 'resolved_assumed' }> {
  const { agent, conversationId } = input
  const author = authorOf(agent)
  const { getActiveInvolvement, recordOutcome } = await import('@/lib/server/domains/assistant')
  const active = await getActiveInvolvement(conversationId)
  if (!active || active.supportAgentId !== agent.id) {
    throw new ConflictError('NOT_ENGAGED', 'This agent has not answered this conversation yet')
  }
  const kind = input.confirmed ? 'confirmed' : 'assumed'
  const row = await recordOutcome(active.id, kind, db, {
    principalId: author.principalId,
    displayName: agent.name,
  })
  if (!row) throw new ConflictError('ALREADY_ENDED', 'This engagement already ended')

  await releaseAgentControl(conversationId)
  await closeTurns(conversationId, 'resolved')
  await clearActivitySnapshot(conversationId)
  const summary = input.summary?.trim()
  if (summary) await postInternalNote(conversationId, `AI agent resolved: ${summary}`, author)
  return { outcome: input.confirmed ? 'resolved_confirmed' : 'resolved_assumed' }
}

/**
 * The agent missed its deadline. Hand the conversation to its fallback: the
 * built-in AI when it is set up and may answer, otherwise the team.
 */
export async function applyTurnFallback(
  turn: TurnRow,
  agent: SupportAgent | null,
  fallback: 'quackback_ai' | 'team'
): Promise<void> {
  const conversationId = turn.conversationId
  try {
    if (fallback === 'quackback_ai') {
      const orchestrator = await import('@/lib/server/domains/assistant/assistant.orchestrator')
      if ((await orchestrator.previewAssistantTurnForConversation(conversationId)) === 'eligible') {
        await db
          .update(assistantInvolvements)
          .set({ status: 'abandoned', endedAt: new Date() })
          .where(
            and(
              eq(assistantInvolvements.conversationId, conversationId),
              eq(assistantInvolvements.status, 'active'),
              eq(assistantInvolvements.supportAgentId, turn.agentId)
            )
          )
        await orchestrator.runAssistantTurnForConversation(conversationId)
        return
      }
    }
    if (!agent?.principalId) return
    await handOffToTeam({ agent, conversationId, reason: 'system_error' })
  } catch (err) {
    log.error({ err, turn_id: turn.id, conversation_id: conversationId }, 'agent fallback failed')
    throw err
  }
}
