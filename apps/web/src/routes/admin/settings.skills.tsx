import { createFileRoute } from '@tanstack/react-router'
import { redirectMoved } from '@/lib/shared/moved-route'
import { adminPageHead } from '@/lib/client/admin-head'

/** Retired path: skills are the Procedures tab of Quackback AI, Guidance. */
export const Route = createFileRoute('/admin/settings/skills')({
  head: adminPageHead('Skills settings'),
  beforeLoad: ({ location }) =>
    redirectMoved('/admin/settings/ai/guidance?tab=procedures', location),
})
