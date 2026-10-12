import { createFileRoute } from '@tanstack/react-router'
import { redirectMoved } from '@/lib/shared/moved-route'
import { adminPageHead } from '@/lib/client/admin-head'

/** Retired path: SLA policies are a part of Hours & SLAs. */
export const Route = createFileRoute('/admin/settings/sla')({
  head: adminPageHead('SLA settings'),
  beforeLoad: ({ location }) => redirectMoved('/admin/settings/hours-sla', location),
})
