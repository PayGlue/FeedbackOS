import { useWorkspaceSettings } from '@/lib/client/hooks/use-root-context'

/**
 * Whether the status page offers its RSS feed. A feed reader has no session,
 * so a page published for signed-in visitors or chosen segments gives it an
 * empty feed (`listStatusFeedFn` applies the page's own gate): only a public
 * page has a feed worth pointing to.
 */
export function useStatusFeedOffered(): boolean {
  const settings = useWorkspaceSettings()
  return (settings?.statusConfig?.audience ?? 'public') === 'public'
}
