import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { approvalKeys, approvalQueries } from '@/lib/client/queries/approvals'
import { unreadCountQuery } from '@/lib/client/hooks/use-notifications-queries'

/**
 * What waits on the viewer: the rail's count and Home's list, from the read
 * the admin layout warms with the document. A new request rings the bell of
 * everyone who may decide it, so a rise in the unread count is when this is
 * read again; it never polls on its own. The unread count is only observed
 * here, so this adds no request to the bell's.
 */
export function useWaitingApprovals() {
  const queryClient = useQueryClient()
  const waiting = useQuery(approvalQueries.waiting())
  const { data: unread } = useQuery({
    ...unreadCountQuery(),
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })
  const seen = useRef(unread)
  useEffect(() => {
    if (unread !== undefined && seen.current !== undefined && unread > seen.current)
      void queryClient.invalidateQueries({ queryKey: approvalKeys.waiting() })
    seen.current = unread
  }, [unread, queryClient])
  return waiting.data
}
