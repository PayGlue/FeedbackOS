/**
 * FeedbackOS: on the verified help center domain, every page lives under /hc.
 *
 * A help center often moves to this instance from another documentation tool
 * that served articles at the root (`/getting-started/install`). Those links
 * keep working when a GET on the custom domain that is not already under /hc,
 * or one of the app's own paths, is sent to the same path under /hc. The help
 * center then resolves `/hc/<category>/<article>` itself, and its redirect
 * rules (Settings > Help Center > Domains) cover paths that differ.
 *
 * The settings are imported on first use: `start.ts` is a client entry as well
 * as a server one.
 */
import { createMiddleware } from '@tanstack/react-start'

const READ_METHODS = new Set(['GET', 'HEAD'])

/** Paths the app serves on every host; they are never moved under /hc. */
const PASSTHROUGH_PREFIXES = [
  '/hc',
  '/api/',
  '/_serverFn',
  '/_build',
  '/assets/',
  '/.well-known/',
  '/auth/',
  '/oauth/',
  '/widget',
  '/favicon',
  '/logo.png',
  '/robots.txt',
  '/sitemap.xml',
]

function normalizeHost(value: string | null | undefined): string | null {
  const host = value?.split(',')[0]?.trim().toLowerCase().replace(/\.$/, '')
  return host ? host.replace(/:(?:80|443)$/, '') : null
}

export function helpCenterRootRedirect(pathname: string, search: string): string | null {
  if (PASSTHROUGH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
    return null
  }
  const trimmed = pathname.replace(/\/+$/, '')
  return `/hc${trimmed}${search}`
}

interface NextResult {
  response?: Response
}

export async function handleHelpCenterHost<T extends NextResult>({
  request,
  next,
}: {
  request: Request
  next: () => Promise<T>
}): Promise<T | Response> {
  if (!READ_METHODS.has(request.method)) return next()
  const url = new URL(request.url)
  const host =
    normalizeHost(request.headers.get('x-forwarded-host')) ??
    normalizeHost(request.headers.get('host'))
  if (!host) return next()

  let domain: string | null | undefined
  try {
    const { getHelpCenterConfig } = await import('@/lib/server/domains/settings/settings.service')
    const config = await getHelpCenterConfig()
    domain = config.domain?.verifiedAt ? config.domain.domain?.toLowerCase() : null
  } catch {
    return next()
  }
  if (!domain || host !== domain) return next()

  const target = helpCenterRootRedirect(url.pathname, url.search)
  if (!target) return next()
  return new Response(null, { status: 301, headers: { Location: target } })
}

export const helpCenterHostMiddleware = createMiddleware().server(({ next, request }) =>
  handleHelpCenterHost({ request, next: () => Promise.resolve(next()) })
)
