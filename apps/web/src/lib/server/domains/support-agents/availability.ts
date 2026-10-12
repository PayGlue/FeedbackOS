import { isFeatureEnabled } from '@/lib/server/domains/settings/settings.service'
import { getCloudConfig } from '@/lib/server/domains/settings/cloud/cloud.service'
import { ForbiddenError } from '@/lib/shared/errors'
import { EntitlementRequiredError } from '@/lib/server/errors/entitlement-error'

/** The experimental switch is off by default. Self-hosted installs stay unrestricted. */
export async function assertOwnAgentAvailable(): Promise<void> {
  if (!(await isFeatureEnabled('ownAgent')))
    throw new ForbiddenError('OWN_AGENT_DISABLED', 'Your AI agent is not enabled')
  const cloud = await getCloudConfig()
  if (cloud.enabled && (!cloud.plan || cloud.plan === 'free')) {
    throw new EntitlementRequiredError({
      entitlement: 'ownAgent',
      friendly: 'Your AI agent',
      friendlyIsPlural: false,
      currentPlan: cloud.plan,
      currentPlanName: cloud.plan === 'free' ? 'Free' : null,
      requiredPlan: 'pro',
      requiredPlanName: 'Pro',
      requiredPlanArticle: 'a',
    })
  }
}
