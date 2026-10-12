import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { AreaMessages } from '@/components/shared/area-messages'
import { PortalIntlProvider } from '@/components/portal-intl-provider'
import { DeviceApproval } from '@/components/device/device-approval'
import { buildSigninRedirect } from '@/lib/shared/auth-prompt'
import {
  DEFAULT_LOCALE,
  loadPortalMessages,
  loadMessages,
  seedAreaMessages,
} from '@/lib/shared/i18n'

const searchSchema = z.object({ user_code: z.string().max(32).optional() })

/**
 * The verification page for the OAuth device authorization grant (RFC 8628):
 * a headless client shows a code and a link here, and the signed-in person
 * approves or denies it. The link carries the code, so a person who follows it
 * lands on the approval with nothing to type.
 */
export const Route = createFileRoute('/device')({
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    const user = context.session?.user as { isAnonymous?: boolean } | undefined
    if (!user || user.isAnonymous) {
      const back = search.user_code
        ? `/device?user_code=${encodeURIComponent(search.user_code)}`
        : '/device'
      throw redirect(buildSigninRedirect(back))
    }
  },
  loader: async ({ context }) => {
    const locale = context.acceptLanguageLocale ?? DEFAULT_LOCALE
    const messages = await seedAreaMessages(locale, 'deviceSignIn')
    // The capability picker is shared with API keys, and its labels live there.
    // The sign-in-again dialog renders the portal sign-in form, so it needs the
    // portal catalog too.
    const shared: Record<string, string> = { ...(await loadPortalMessages(locale)) }
    if (locale !== DEFAULT_LOCALE) {
      for (const [key, value] of Object.entries(await loadMessages(locale))) {
        if (key.startsWith('apiKeys.scopes.')) shared[key] = value
      }
    }
    return { locale, messages, shared }
  },
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
  component: DeviceRoute,
})

function DeviceRoute() {
  const { locale, messages, shared } = Route.useLoaderData()
  const { user_code } = Route.useSearch()
  const navigate = useNavigate()
  return (
    <PortalIntlProvider locale={locale} messages={shared}>
      <AreaMessages area="deviceSignIn" messages={messages}>
        <DeviceApproval
          userCode={user_code}
          onCode={(code) =>
            void navigate({ to: '/device', search: code ? { user_code: code } : {} })
          }
        />
      </AreaMessages>
    </PortalIntlProvider>
  )
}
