import { afterEach, describe, expect, it, vi } from 'vitest'
import { handOffFeedInput, takeFeedInput } from '../feed-input-handoff'

describe('feed input handoff', () => {
  afterEach(() => vi.useRealTimers())

  it('hands each value over once', () => {
    handOffFeedInput({ search: 'zap', composeTitle: 'Dark mode' })
    expect(takeFeedInput('search')).toBe('zap')
    expect(takeFeedInput('search')).toBeUndefined()
    expect(takeFeedInput('composeTitle')).toBe('Dark mode')
  })

  it('drops input nobody took in time, so a later visit starts clean', () => {
    vi.useFakeTimers()
    handOffFeedInput({ search: 'zap' })
    vi.advanceTimersByTime(5000)
    expect(takeFeedInput('search')).toBeUndefined()
  })

  it('does not revive an expired value when new input is handed over', () => {
    vi.useFakeTimers()
    handOffFeedInput({ composeTitle: 'Abandoned idea' })
    vi.advanceTimersByTime(5000)
    handOffFeedInput({ search: 'zap' })
    expect(takeFeedInput('composeTitle')).toBeUndefined()
    expect(takeFeedInput('search')).toBe('zap')
  })
})
