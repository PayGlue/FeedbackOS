/**
 * Request bodies of the agent endpoints, shared by the routes that parse them
 * and the OpenAPI document that describes them.
 */
import { z } from 'zod'
import { ASSISTANT_MODEL_HANDOFF_REASONS } from '@/lib/server/db'
import { AGENT_ACTIVITY_STATUSES, AGENT_MAX_REPLY_LENGTH } from '@/lib/shared/support-agents'

export const agentCitationSchema = z.object({
  title: z.string().min(1).max(200),
  url: z
    .string()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), 'Citation URLs must be http or https'),
})

export const agentReplyBodySchema = z.object({
  turnId: z.string().min(1),
  content: z.string().min(1).max(AGENT_MAX_REPLY_LENGTH),
  citations: z.array(agentCitationSchema).max(10).optional(),
  idempotencyKey: z.string().min(1).max(200),
})

export const agentActivityBodySchema = z.object({
  status: z.enum(AGENT_ACTIVITY_STATUSES),
})

export const agentHandoffBodySchema = z.object({
  reason: z.enum(ASSISTANT_MODEL_HANDOFF_REASONS),
  note: z.string().max(2000).optional(),
})

export const agentResolveBodySchema = z.object({
  confirmed: z.boolean(),
  summary: z.string().max(2000).optional(),
})
