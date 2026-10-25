import type { CloudConfig } from './cloud.types'

/**
 * Whether the "Powered by Quackback" badge should render on the portal,
 * widget, and branded emails.
 *
 * FeedbackOS: never. This build is a branded fork, so the badge is off on
 * every install regardless of cloud entitlements.
 */
export function shouldShowPoweredBy(_config: CloudConfig): boolean {
  return false
}
