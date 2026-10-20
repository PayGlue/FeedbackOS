// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FeedbackSidebar } from '../feedback-sidebar'

afterEach(cleanup)

// happy-dom lays nothing out, so the panel's sizes are set by hand.
function sizePanel(panel: HTMLElement, sizes: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: sizes.scrollHeight })
  Object.defineProperty(panel, 'clientHeight', { configurable: true, value: sizes.clientHeight })
}

describe('FeedbackSidebar', () => {
  const resizeCallbacks: ResizeObserverCallback[] = []

  beforeEach(() => {
    resizeCallbacks.length = 0
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
  })

  function renderSidebar() {
    render(
      <FeedbackSidebar>
        <div>filters</div>
      </FeedbackSidebar>
    )
    return screen.getByText('filters').parentElement!
  }

  const resize = () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver)
  }

  it('fades the foot of the panel while more sits below its fold', () => {
    const panel = renderSidebar()
    sizePanel(panel, { scrollHeight: 800, clientHeight: 400 })
    resize()
    expect(panel).toHaveAttribute('data-more-below')

    panel.scrollTop = 400
    fireEvent.scroll(panel)
    expect(panel).not.toHaveAttribute('data-more-below')
  })

  it('shows no fade when the panel fits', () => {
    const panel = renderSidebar()
    sizePanel(panel, { scrollHeight: 400, clientHeight: 400 })
    resize()
    expect(panel).not.toHaveAttribute('data-more-below')
  })
})
