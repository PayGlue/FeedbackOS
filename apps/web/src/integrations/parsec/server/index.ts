import { channelDestination } from '@/lib/server/integrations/destination'
import type { IntegrationDefinition } from '@/lib/server/integrations/types'
import { listParsecProjects, parsecRequest } from '@/integrations/parsec/server/api'
import { parsecCatalog } from '@/integrations/parsec/server/catalog'
import { parsecInboundHandler } from '@/integrations/parsec/server/inbound'
import { parsecIssues } from '@/integrations/parsec/server/issues'
import { fetchParsecStatuses } from '@/integrations/parsec/server/statuses'

export const parsecIntegration: IntegrationDefinition = {
  id: 'parsec',
  destination: channelDestination(['apiUrl']),
  catalog: parsecCatalog,
  destinations: {
    project: {
      label: 'Project',
      list: async ({ accessToken, config }) => {
        const projects = await listParsecProjects({ apiUrl: config.apiUrl, accessToken })
        return projects.map((p) => ({ id: String(p.id), name: p.name }))
      },
    },
  },
  inbound: parsecInboundHandler,
  issues: parsecIssues,
  linkedItems: true,
  webhookRegistration: {
    register: async ({ accessToken, config, callbackUrl }) => {
      const webhook = await parsecRequest<{ id: number; secret: string }>(
        { apiUrl: config.apiUrl, accessToken },
        `/projects/${encodeURIComponent(String(config.projectRef))}/webhooks`,
        { method: 'POST', body: { url: callbackUrl, events: ['issue.state_changed'] } }
      )
      return { externalWebhookId: String(webhook.id), webhookSecret: webhook.secret }
    },
    unregister: async ({ accessToken, config, externalWebhookId }) => {
      await parsecRequest(
        { apiUrl: config.apiUrl, accessToken },
        `/webhooks/${encodeURIComponent(externalWebhookId)}`,
        { method: 'DELETE' }
      )
    },
  },
  listExternalStatuses: fetchParsecStatuses,
  platformCredentials: [],
}
