import { createFileRoute } from '@tanstack/react-router'
import { redirectMoved } from '@/lib/shared/moved-route'
import { adminPageHead } from '@/lib/client/admin-head'

/** Retired path: ticket types are a part of Tickets. */
export const Route = createFileRoute('/admin/settings/ticket-types')({
  head: adminPageHead('Ticket types settings'),
  beforeLoad: ({ location }) => redirectMoved('/admin/settings/tickets', location),
})
