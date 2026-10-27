import { useCallback, type MouseEvent, type ReactNode } from 'react'
import { useFileViewer } from '@/components/shared/files/file-viewer-context'
import type { ViewerFile } from '@/components/shared/files/types'

/** The file name at the end of an image URL, for the viewer's header. */
function nameFromUrl(url: string): string {
  try {
    const last = new URL(url, 'https://x.invalid').pathname.split('/').filter(Boolean).pop()
    return last ? decodeURIComponent(last) : 'Image'
  } catch {
    return 'Image'
  }
}

/** Every image in an article as viewer files, in reading order. */
export function articleImages(root: HTMLElement): {
  files: ViewerFile[]
  elements: HTMLImageElement[]
} {
  const elements = [...root.querySelectorAll('img')].filter((img) =>
    Boolean(img.currentSrc || img.src)
  )
  const files = elements.map((img, index): ViewerFile => {
    const url = img.currentSrc || img.src
    const name = img.alt?.trim() || nameFromUrl(url)
    return {
      key: `${url}#${index}`,
      url,
      name,
      contentType: 'image/*',
      size: 0,
      family: 'image',
    }
  })
  return { files, elements }
}

/**
 * FeedbackOS: lets a reader open any image in a help article at full size, in
 * the same viewer chat attachments use (zoom, arrow keys through the article's
 * other images, Esc to close). Linked images keep following their link.
 */
export function HelpCenterImageZoom({ children }: { children: ReactNode }) {
  const viewer = useFileViewer()

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (!(target instanceof HTMLImageElement) || target.closest('a')) return
      const { files, elements } = articleImages(event.currentTarget)
      const index = elements.indexOf(target)
      if (index < 0) return
      event.preventDefault()
      viewer.open(files, index)
    },
    [viewer]
  )

  return (
    // Clicks bubble up from the images the rich text renders; the images
    // themselves stay plain <img> elements, so nothing about the article
    // markup changes.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div onClick={handleClick} className="[&_img:not(a_img)]:cursor-zoom-in">
      {children}
    </div>
  )
}
