import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { redirectMoved } from '@/lib/shared/moved-route'
import { adminPageHead } from '@/lib/client/admin-head'

/** Retired path: conversation attributes and tags are Fields & tags, under Support. */
export const Route = createFileRoute('/admin/settings/conversation-data')({
  head: adminPageHead('Conversation data settings'),
  validateSearch: z.object({ tab: z.enum(['attributes', 'tags']).optional() }),
  beforeLoad: ({ location }) => redirectMoved('/admin/settings/fields', location),
})
