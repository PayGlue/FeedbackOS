// @vitest-environment happy-dom
/**
 * Clicking an image in a help article opens it in the shared file viewer, with
 * the article's other images one arrow key away. Linked images keep their link.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const open = vi.fn()
vi.mock('@/components/shared/files/file-viewer-context', () => ({
  useFileViewer: () => ({ open }),
}))

import { HelpCenterImageZoom } from '../help-center-image-zoom'

afterEach(() => {
  cleanup()
  open.mockClear()
})

function renderArticle() {
  render(
    <HelpCenterImageZoom>
      <p>Intro</p>
      <img src="https://cdn.example.com/a/first.png" alt="First step" />
      <img src="https://cdn.example.com/a/second%20shot.png" alt="" />
      <a href="https://example.com/elsewhere">
        <img src="https://cdn.example.com/a/linked.png" alt="Linked" />
      </a>
    </HelpCenterImageZoom>
  )
}

describe('HelpCenterImageZoom', () => {
  it('opens the clicked image with every article image in order', () => {
    renderArticle()
    fireEvent.click(document.querySelectorAll('img')[1])
    expect(open).toHaveBeenCalledTimes(1)
    const [files, index] = open.mock.calls[0]
    expect(index).toBe(1)
    expect(files.map((f: { name: string }) => f.name)).toEqual([
      'First step',
      'second shot.png',
      'Linked',
    ])
    expect(files.every((f: { family: string }) => f.family === 'image')).toBe(true)
  })

  it('leaves linked images and plain text alone', () => {
    renderArticle()
    fireEvent.click(screen.getByAltText('Linked'))
    fireEvent.click(screen.getByText('Intro'))
    expect(open).not.toHaveBeenCalled()
  })
})
