import { createFileRoute } from '@tanstack/react-router'
import { withApiKeyAuth } from '@/lib/server/domains/api/auth'
import { successResponse, handleDomainError } from '@/lib/server/domains/api/responses'
import { PERMISSIONS } from '@/lib/shared/permissions'
import type { TicketTypeEntity } from '@/lib/server/db'

/** Public, stable ticket-type shape for the read API: the id `POST /tickets`
 *  takes as `ticketTypeId`, plus the slug an integration can map onto. */
function serializeTicketType(row: TicketTypeEntity) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    category: row.category,
    icon: row.icon,
    color: row.color,
    position: row.position,
    isDefault: row.isDefault,
    intakeVisible: row.intakeVisible,
  }
}

export const Route = createFileRoute('/api/v1/ticket-types/')({
  server: {
    handlers: {
      /** GET /api/v1/ticket-types — the workspace's live ticket types, ordered by
       *  category then position. Discovery for the ids `POST /tickets` takes, so
       *  an integration can file under a type by its slug. Requires a team-role
       *  API key. FeedbackOS addition. */
      GET: async ({ request }) => {
        try {
          await withApiKeyAuth(request, { permission: PERMISSIONS.TICKET_VIEW })

          const { listTicketTypes } =
            await import('@/lib/server/domains/tickets/ticket-type.service')
          const types = await listTicketTypes()

          return successResponse(types.map(serializeTicketType))
        } catch (error) {
          return handleDomainError(error)
        }
      },
    },
  },
})
