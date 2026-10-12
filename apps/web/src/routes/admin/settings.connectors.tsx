import { createFileRoute } from '@tanstack/react-router'
import { redirectMoved } from '@/lib/shared/moved-route'
import { adminPageHead } from '@/lib/client/admin-head'

/**
 * Retired path: connectors are Quackback AI, Actions. The query string (an
 * OAuth return) travels with the visit. The connector page keeps its path.
 */
export const Route = createFileRoute('/admin/settings/connectors')({
  head: adminPageHead('Connectors settings'),
  beforeLoad: ({ location }) => redirectMoved('/admin/settings/ai/actions', location),
})
