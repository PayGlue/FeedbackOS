/**
 * Tells the team that someone outside it posted feedback, in the bell and by
 * email. Runs at create time rather than from post.created because that event
 * waits for moderation, and a held post is invisible until someone acts on it.
 */
import { and, db, eq, inArray, principal } from '@/lib/server/db'
import type { PostId, PrincipalId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'
import { buildHookContext } from '@/lib/server/events/hook-context'
import { mailContact, resolveContactRecipients } from '@/lib/server/email/recipient'
import { batchGetNotificationPreferences } from '@/lib/server/domains/subscriptions/subscription.service'
import { shouldNotify } from '@/lib/server/domains/subscriptions/notification-matrix'
import { createNotificationsBatch } from '@/lib/server/domains/notifications/notification.service'
import { truncate } from '@/lib/shared/utils/string'

const log = logger.child({ component: 'post-team-alert' })

const TYPE = 'post_submitted'
const PREVIEW_LENGTH = 400

export interface NewPostAlert {
  post: { id: PostId; title: string; content: string }
  board: { slug: string; name: string }
  authorPrincipalId: PrincipalId
  authorName: string
  held: boolean
}

export async function alertTeamToNewPost(alert: NewPostAlert): Promise<void> {
  const { post, board, authorPrincipalId, authorName, held } = alert

  const team = await db
    .select({ id: principal.id })
    .from(principal)
    .where(and(eq(principal.type, 'user'), inArray(principal.role, ['admin', 'member'])))
  const ids = team.map((t) => t.id as PrincipalId)
  if (ids.length === 0 || ids.includes(authorPrincipalId)) return

  const prefs = await batchGetNotificationPreferences(ids)
  const wants = (id: PrincipalId, channel: 'inApp' | 'email') => {
    const p = prefs.get(id)
    return p ? shouldNotify(p, TYPE, channel) : true
  }

  const heading = held ? 'New feedback waiting for approval' : 'New feedback'
  await createNotificationsBatch(
    ids
      .filter((id) => wants(id, 'inApp'))
      .map((principalId) => ({
        principalId,
        type: TYPE,
        title: heading,
        body: truncate(post.title, 255),
        // A held post has no public page yet, so its bell opens the moderation queue.
        ...(held ? {} : { postId: post.id }),
      }))
  )

  const ctx = await buildHookContext()
  if (!ctx) return
  const base = ctx.portalBaseUrl.replace(/\/$/, '')
  const url = held
    ? `${base}/admin/feedback/moderation`
    : `${base}/b/${board.slug}/posts/${post.id}`

  const addresses = await resolveContactRecipients(ids.filter((id) => wants(id, 'email')))
  const { sendNewFeedbackEmail } = await import('@quackback/email')
  await Promise.allSettled(
    [...addresses.values()].map((to) =>
      mailContact(sendNewFeedbackEmail, to, {
        title: post.title,
        preview: truncate(post.content, PREVIEW_LENGTH),
        authorName,
        boardName: board.name,
        held,
        url,
        workspaceName: ctx.workspaceName,
        preferencesUrl: `${base}/settings/preferences`,
        logoUrl: ctx.logoUrl ?? undefined,
      }).catch((err) => log.warn({ err, post_id: post.id }, 'new feedback email failed'))
    )
  )
}
