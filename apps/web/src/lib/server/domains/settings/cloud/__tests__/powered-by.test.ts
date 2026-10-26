import { describe, expect, it } from 'vitest'
import { DISABLED_CLOUD_CONFIG, type CloudConfig } from '../cloud.types'
import { shouldShowPoweredBy } from '../powered-by'

function cloudOn(overrides: Partial<CloudConfig> = {}): CloudConfig {
  return {
    ...DISABLED_CLOUD_CONFIG,
    enabled: true,
    plan: 'pro',
    ...overrides,
  }
}

// FeedbackOS: the badge is off on every install, whatever the entitlements.
describe('shouldShowPoweredBy', () => {
  it('never shows on a self-hosted install', () => {
    expect(shouldShowPoweredBy(DISABLED_CLOUD_CONFIG)).toBe(false)
  })

  it('never shows on cloud, with or without the add-on', () => {
    expect(shouldShowPoweredBy(cloudOn({ entitlements: {} }))).toBe(false)
    expect(shouldShowPoweredBy(cloudOn({ entitlements: { hideBranding: false } }))).toBe(false)
    expect(shouldShowPoweredBy(cloudOn({ entitlements: { hideBranding: true } }))).toBe(false)
  })
})
