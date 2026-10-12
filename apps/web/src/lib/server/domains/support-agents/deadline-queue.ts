/**
 * `agent-turn-deadline` job handler: the moment an AI agent's reply deadline
 * passes, expire the turn if nobody answered it and hand the conversation to
 * the agent's fallback. One job per turn, queued with the turn at its deadline.
 * Running it for a turn that was already answered is a no-op.
 */
import type { SupportAgentTurnId } from '@quackback/ids'
import type { ClaimedJob } from '@/lib/server/jobs/job-queue'
import { expireTurn } from './turns.service'

export async function runTurnDeadline(job: ClaimedJob): Promise<void> {
  const turnId = (job.payload as { turnId?: string }).turnId
  if (!turnId) return
  await expireTurn(turnId as SupportAgentTurnId)
}
