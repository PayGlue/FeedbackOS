import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PostId, PrincipalId } from '@quackback/ids'

const mocks = vi.hoisted(() => ({
  team: [] as { id: string }[],
  prefs: new Map<string, unknown>(),
  createNotificationsBatch: vi.fn(),
  send: vi.fn(),
}))

vi.mock('@/lib/server/db', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  principal: {},
  db: { select: () => ({ from: () => ({ where: async () => mocks.team }) }) },
}))
vi.mock('@/lib/server/events/hook-context', () => ({
  buildHookContext: async () => ({
    portalBaseUrl: 'https://hub.example.com/',
    workspaceName: 'Acme',
    logoUrl: null,
  }),
}))
vi.mock('@/lib/server/email/recipient', () => ({
  resolveContactRecipients: async (ids: string[]) =>
    new Map(ids.map((id) => [id, `${id}@example.com`])),
  mailContact: (send: (p: unknown) => unknown, to: string, rest: object) =>
    Promise.resolve(send({ ...rest, to })),
}))
vi.mock('@/lib/server/domains/subscriptions/subscription.service', () => ({
  batchGetNotificationPreferences: async () => mocks.prefs,
}))
vi.mock('@/lib/server/domains/notifications/notification.service', () => ({
  createNotificationsBatch: mocks.createNotificationsBatch,
}))
vi.mock('@quackback/email', () => ({ sendNewFeedbackEmail: mocks.send }))

import { alertTeamToNewPost } from '../post.team-alert'

const alert = {
  post: { id: 'post_1' as PostId, title: 'Add Apple Pay', content: 'Please' },
  board: { slug: 'ideas', name: 'Ideas' },
  authorPrincipalId: 'principal_visitor' as PrincipalId,
  authorName: '',
  held: true,
}

describe('alertTeamToNewPost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.team = [{ id: 'principal_a' }]
    mocks.prefs = new Map()
  })

  it('tells the team about a held post and links to the moderation queue', async () => {
    await alertTeamToNewPost(alert)

    const [bells] = mocks.createNotificationsBatch.mock.calls[0]
    expect(bells).toEqual([
      {
        principalId: 'principal_a',
        type: 'post_submitted',
        title: 'New feedback waiting for approval',
        body: 'Add Apple Pay',
      },
    ])
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'principal_a@example.com',
        held: true,
        url: 'https://hub.example.com/admin/feedback/moderation',
      })
    )
  })

  it('links a published post to its page', async () => {
    await alertTeamToNewPost({ ...alert, held: false })

    expect(mocks.createNotificationsBatch.mock.calls[0][0][0].postId).toBe('post_1')
    expect(mocks.send.mock.calls[0][0].url).toBe('https://hub.example.com/b/ideas/posts/post_1')
  })

  it('stays quiet about a post from the team', async () => {
    await alertTeamToNewPost({ ...alert, authorPrincipalId: 'principal_a' as PrincipalId })

    expect(mocks.createNotificationsBatch).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('respects a teammate who turned the email off', async () => {
    mocks.prefs = new Map([
      ['principal_a', { emailMuted: false, matrix: { post_submitted: { email: false } } }],
    ])

    await alertTeamToNewPost(alert)

    expect(mocks.createNotificationsBatch.mock.calls[0][0]).toHaveLength(1)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('survives a failed email', async () => {
    mocks.send.mockRejectedValueOnce(new Error('down'))

    await expect(alertTeamToNewPost(alert)).resolves.toBeUndefined()
  })
})
