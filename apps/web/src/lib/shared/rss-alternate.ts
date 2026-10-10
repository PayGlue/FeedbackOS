/**
 * The RSS feed a page advertises to feed readers through
 * `<link rel="alternate">`. The status pages offer the status feed; every
 * other page keeps offering the changelog feed, as before.
 *
 * Decided from the matched route ids in the root route's `head`, because
 * TanStack Router concatenates `links` across matches: a child route can add
 * a second feed but cannot replace the root's.
 *
 * Only a public status page advertises its feed. A feed reader has no
 * session, so a page published for signed-in visitors or chosen segments
 * gives it an empty feed; such a page offers the changelog feed like any
 * other.
 */
export function rssAlternateLink(
  routeIds: readonly string[],
  { statusPagePublic }: { statusPagePublic: boolean }
) {
  const onStatusPage = routeIds.some((id) => id.startsWith('/_portal/status/'))
  return onStatusPage && statusPagePublic
    ? {
        rel: 'alternate',
        type: 'application/rss+xml',
        title: 'Status RSS Feed',
        href: '/status/feed',
      }
    : {
        rel: 'alternate',
        type: 'application/rss+xml',
        title: 'Changelog RSS Feed',
        href: '/changelog/feed',
      }
}
