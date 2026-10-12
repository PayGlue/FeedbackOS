import { createFileRoute } from '@tanstack/react-router'
import { redirectMoved } from '@/lib/shared/moved-route'
import { adminPageHead } from '@/lib/client/admin-head'

/** Retired path: ticket statuses are a part of Tickets. */
export const Route = createFileRoute('/admin/settings/ticket-statuses')({
  head: adminPageHead('Ticket statuses settings'),
  beforeLoad: ({ location }) => redirectMoved('/admin/settings/tickets', location),
})
