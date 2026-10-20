import { useEffect, useRef } from 'react'

interface FeedbackSidebarProps {
  /** The filter panel. */
  children: React.ReactNode
  /** Pinned under the panel, outside its scroll area, so it stays in view. */
  footer?: React.ReactNode
}

/** Gap kept between the column and the viewport edges. */
const EDGE = 24

export function FeedbackSidebar({ children, footer }: FeedbackSidebarProps) {
  const columnRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // The column fills the space from where it sits down to the viewport's
  // bottom edge: below the portal header at the top of the page, the full
  // height once it sticks. The panel scrolls inside it and the footer stays
  // in view throughout.
  useEffect(() => {
    const column = columnRef.current
    if (!column) return
    let frame = 0
    const fit = () => {
      frame = 0
      const top = Math.max(EDGE, column.getBoundingClientRect().top)
      column.style.maxHeight = `${window.innerHeight - top - EDGE}px`
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit)
    }
    fit()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [])

  // While more of the panel sits below its fold, its foot fades out as a cue
  // to scroll. Set on the element directly so scrolling never re-renders.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const update = () => {
      panel.toggleAttribute(
        'data-more-below',
        panel.scrollTop + panel.clientHeight < panel.scrollHeight - 1
      )
    }
    update()
    panel.addEventListener('scroll', update, { passive: true })
    // The panel resizes with the column, and its content grows when a
    // section unfolds.
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    if (panel.firstElementChild) observer.observe(panel.firstElementChild)
    return () => {
      panel.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [])

  return (
    <aside className="hidden w-72 shrink-0 lg:block xl:w-80">
      <div ref={columnRef} className="sticky top-6 flex max-h-[calc(100vh-3rem)] flex-col gap-3">
        <div
          ref={panelRef}
          className="min-h-0 overflow-y-auto scrollbar-thin rounded-lg border border-border/50 bg-card shadow-sm data-more-below:[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]"
        >
          {children}
        </div>
        {footer && <div className="shrink-0">{footer}</div>}
      </div>
    </aside>
  )
}
