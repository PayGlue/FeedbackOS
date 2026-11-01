/**
 * Parsec-specific server functions.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { PERMISSIONS } from '@/lib/shared/permissions'

export interface ParsecProjectOption {
  id: string
  ref: string
  name: string
}

export interface ParsecIssueOptions {
  issueTypes: { id: string; name: string }[]
  members: { id: string; name: string }[]
}

export const saveParsecConnectionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({ apiUrl: z.string().min(1), webUrl: z.string().min(1), apiKey: z.string().min(1) })
  )
  .handler(async ({ data }) => {
    const { requireAuth } = await import('@/lib/server/functions/auth-helpers')
    const { saveIntegration } = await import('@/lib/server/integrations/save')
    const { listParsecProjects, normalizeOrigin } = await import('@/integrations/parsec/server/api')

    const auth = await requireAuth({ permission: PERMISSIONS.INTEGRATION_MANAGE })

    const apiUrl = normalizeOrigin(data.apiUrl)
    const webUrl = normalizeOrigin(data.webUrl)

    // Validate the key by reading the projects it can see.
    try {
      await listParsecProjects({ apiUrl, accessToken: data.apiKey })
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        throw new Error('Invalid API key. Please check your Parsec API key and try again.')
      }
      throw new Error('Failed to reach Parsec. Please check the API address.', { cause: error })
    }

    await saveIntegration('parsec', {
      principalId: auth.principal.id,
      accessToken: data.apiKey,
      config: { apiUrl, webUrl, workspaceName: new URL(webUrl).host },
    })
  })

export const fetchParsecProjectsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ParsecProjectOption[]> => {
    const { requireAuth } = await import('@/lib/server/functions/auth-helpers')
    const { db, integrations, eq } = await import('@/lib/server/db')
    const { getIntegrationAuth } = await import('@/lib/server/integrations/token-refresh')
    const { listParsecProjects } = await import('@/integrations/parsec/server/api')

    await requireAuth({ permission: PERMISSIONS.INTEGRATION_MANAGE })

    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.integrationType, 'parsec'),
    })

    if (!integration?.secrets || integration.status !== 'active') {
      throw new Error('Parsec not connected')
    }

    const { accessToken, config } = await getIntegrationAuth(integration.id)
    const projects = await listParsecProjects({ apiUrl: config.apiUrl, accessToken })
    return projects.map((p) => ({ id: String(p.id), ref: p.ref, name: p.name }))
  }
)

export const fetchParsecIssueOptionsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ projectRef: z.string().min(1) }))
  .handler(async ({ data }): Promise<ParsecIssueOptions> => {
    const { requireAuth } = await import('@/lib/server/functions/auth-helpers')
    const { db, integrations, eq } = await import('@/lib/server/db')
    const { getIntegrationAuth } = await import('@/lib/server/integrations/token-refresh')
    const { getParsecProjectSetup } = await import('@/integrations/parsec/server/api')

    await requireAuth({ permission: PERMISSIONS.INTEGRATION_MANAGE })

    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.integrationType, 'parsec'),
    })

    if (!integration?.secrets || integration.status !== 'active') {
      throw new Error('Parsec not connected')
    }

    const { accessToken, config } = await getIntegrationAuth(integration.id)
    const { issueTypes, assignees } = await getParsecProjectSetup(
      { apiUrl: config.apiUrl, accessToken },
      data.projectRef
    )
    return {
      issueTypes: issueTypes.map((t) => ({ id: String(t.id), name: t.name })),
      members: assignees
        .filter((a) => a.kind === 'member')
        .map((a) => ({ id: a.userId, name: a.name })),
    }
  })
