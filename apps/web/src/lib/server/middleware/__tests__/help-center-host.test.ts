import { describe, it, expect } from 'vitest'
import { helpCenterRootRedirect } from '../help-center-host'

describe('FeedbackOS: helpCenterRootRedirect', () => {
  it('leaves the root to the section host routing, which shows the help center there', () => {
    expect(helpCenterRootRedirect('/', '')).toBeNull()
    expect(helpCenterRootRedirect('/', '?q=1')).toBeNull()
  })

  it('sends the old start page to the root', () => {
    expect(helpCenterRootRedirect('/index', '')).toBe('/')
  })

  it('moves old documentation paths under /hc', () => {
    expect(helpCenterRootRedirect('/faq', '')).toBe('/hc/categories/faq')
    expect(helpCenterRootRedirect('/guides/install', '?a=b')).toBe('/hc/guides/install?a=b')
  })

  it('never touches the help center or the app paths', () => {
    expect(helpCenterRootRedirect('/hc', '')).toBeNull()
    expect(helpCenterRootRedirect('/api/v1/posts', '')).toBeNull()
  })
})
