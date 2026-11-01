import type { ExternalStatusItem } from '@/lib/server/integrations/types'
import { getParsecProjectSetup } from '@/integrations/parsec/server/api'

/** The connected project's columns for the status-mapping UI, in board order. */
export async function fetchParsecStatuses(params: {
  accessToken: string
  config: Record<string, unknown>
}): Promise<ExternalStatusItem[]> {
  const projectRef = params.config.projectRef
  if (typeof projectRef !== 'string' || !projectRef) return []
  const { columns } = await getParsecProjectSetup(
    { apiUrl: params.config.apiUrl, accessToken: params.accessToken },
    projectRef
  )
  return [...columns]
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ id: c.name, name: c.name }))
}
