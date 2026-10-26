import { createFileRoute, redirect, notFound, Outlet } from '@tanstack/react-router'
import { getPublicCategoryBySlugFn } from '@/lib/server/functions/help-center'
import { resolveHelpCenterRedirectFn } from '@/lib/server/functions/help-center-redirect-rules'
import { hcCollectionPath } from '@/lib/shared/help-center-url'
import type { HelpCenterConfig } from '@/lib/shared/types/settings'

/**
 * Legacy `/hc/categories/{slug}` → `/hc/{locale}/collections/{urlId}-{slug}`.
 * A slug with no category left (merged or deleted) falls back to the
 * admin-configured redirect rules before giving up with a 404.
 */
export const Route = createFileRoute('/_portal/hc/categories/$categorySlug')({
  beforeLoad: async ({ params, context }) => {
    const locale =
      (context.settings?.helpCenterConfig as HelpCenterConfig | undefined)?.locales?.default ?? 'en'
    const category = await getPublicCategoryBySlugFn({
      data: { slug: params.categorySlug },
    }).catch(() => null)
    if (!category) {
      const target = await resolveHelpCenterRedirectFn({
        data: { path: `/hc/categories/${params.categorySlug}` },
      })
      if (target) throw redirect({ to: target as string as '/', replace: true, statusCode: 301 })
      throw notFound()
    }
    throw redirect({
      href: hcCollectionPath({ locale, urlId: category.urlId, slug: category.slug }),
      statusCode: 301,
    })
  },
  component: () => <Outlet />,
})
