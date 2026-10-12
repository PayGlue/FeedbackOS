import { createFileRoute } from '@tanstack/react-router'
import { redirectMoved } from '@/lib/shared/moved-route'
import { adminPageHead } from '@/lib/client/admin-head'

/** Retired path: office hours are a part of Hours & SLAs. */
export const Route = createFileRoute('/admin/settings/office-hours')({
  head: adminPageHead('Office hours settings'),
  beforeLoad: ({ location }) => redirectMoved('/admin/settings/hours-sla', location),
})
