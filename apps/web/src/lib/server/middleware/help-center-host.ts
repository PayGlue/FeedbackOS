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
 * The settings are imported inside the server-only part of the middleware:
 * `start.ts` is a client entry as well as a server one.
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
  // `/` and `/index` were the old site's start page.
  if (trimmed === '' || trimmed === '/index') return `/hc${search}`
  // A single segment is read as a locale under /hc, so `/faq` would 404 there.
  // Send it to the category of that name instead.
  if (/^\/[^/]+$/.test(trimmed)) return `/hc/categories${trimmed}${search}`
  return `/hc${trimmed}${search}`
}

interface NextResult {
  response?: Response
}

export async function handleHelpCenterHost<T extends NextResult>({
  request,
  next,
  loadDomain,
}: {
  request: Request
  next: () => Promise<T>
  /** The verified help center domain, lower case, or null when there is none. */
  loadDomain: () => Promise<string | null>
}): Promise<T | Response> {
  if (!READ_METHODS.has(request.method)) return next()
  const url = new URL(request.url)
  const host =
    normalizeHost(request.headers.get('x-forwarded-host')) ??
    normalizeHost(request.headers.get('host'))
  if (!host) return next()

  let domain: string | null
  try {
    domain = await loadDomain()
  } catch {
    return next()
  }
  if (!domain || host !== domain) return next()

  const target = helpCenterRootRedirect(url.pathname, url.search)
  if (!target) return next()
  return new Response(null, { status: 301, headers: { Location: target } })
}

// The settings import sits inside `.server()`, which the client build strips:
// it reaches the database, and `start.ts` is a client entry too.
export const helpCenterHostMiddleware = createMiddleware().server(({ next, request }) =>
  handleHelpCenterHost({
    request,
    next: () => Promise.resolve(next()),
    loadDomain: async () => {
      const { getHelpCenterConfig } = await import('@/lib/server/domains/settings/settings.service')
      const config = await getHelpCenterConfig()
      return config.domain?.verifiedAt ? (config.domain.domain?.toLowerCase() ?? null) : null
    },
  })
)
