import type { ConversationMessageDTO } from './types'

/** A teammate who has joined a conversation, as the visitor sees them. */
export interface ThreadHumanAgent {
  principalId: string
  name: string | null
  avatarUrl: string | null
}

type AgentCandidate = Pick<ConversationMessageDTO, 'senderType' | 'isAssistant' | 'author'> & {
  isInternal?: boolean
}

/**
 * The teammate who last replied in a thread, or null while only the visitor,
 * the AI assistant and system events have spoken. The messenger header fronts
 * the assistant until a human takes over; from then on it shows that person,
 * so the visitor can see who they are talking to.
 */
export function lastHumanAgent(messages: readonly AgentCandidate[]): ThreadHumanAgent | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.senderType !== 'agent' || m.isAssistant || m.isInternal || !m.author) continue
    return {
      principalId: m.author.principalId,
      name: m.author.displayName,
      avatarUrl: m.author.avatarUrl,
    }
  }
  return null
}
