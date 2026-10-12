import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { redirectMoved } from '@/lib/shared/moved-route'
import { adminPageHead } from '@/lib/client/admin-head'

/** Retired path: Copilot became Quackback AI, Teammates. A tab opens its own page. */
export const Route = createFileRoute('/admin/settings/copilot')({
  head: adminPageHead('Teammates settings'),
  validateSearch: z.object({ tab: z.enum(['knowledge', 'guidance', 'actions']).optional() }),
  beforeLoad: ({ search, location }) => {
    if (search.tab === 'knowledge')
      redirectMoved('/admin/settings/ai/knowledge?tab=teammates', location)
    if (search.tab === 'guidance')
      redirectMoved('/admin/settings/ai/guidance?tab=teammates', location)
    if (search.tab === 'actions') redirectMoved('/admin/settings/ai/actions', location)
    redirectMoved('/admin/settings/ai/teammates', location)
  },
})
