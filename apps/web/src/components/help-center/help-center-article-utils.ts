/**
 * Pure utility functions for help center article pages.
 * Extracted for testability — no React dependencies.
 */

import { createHeadingIds } from '@/lib/shared/heading-ids'

// =============================================================================
// Types
// =============================================================================

export interface TocHeading {
  id: string
  text: string
  level: number
}

// =============================================================================
// extractHeadings — walks TipTap JSON and pulls out H2/H3 headings
// =============================================================================

interface TipTapNode {
  type?: string
  text?: string
  content?: TipTapNode[]
  attrs?: Record<string, unknown>
}

function extractTextFromNode(node: TipTapNode | null | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  if (Array.isArray(node.content)) {
    return node.content.map(extractTextFromNode).join('')
  }
  return ''
}

export function extractHeadings(
  contentJson: { type?: string; content?: TipTapNode[] } | null | undefined
): TocHeading[] {
  if (!contentJson || !Array.isArray(contentJson.content)) return []

  const headings: TocHeading[] = []
  // Every heading takes an id in document order, as the article HTML does, so
  // repeated text gets the same suffix in both places. Only H2 and H3 are listed.
  const headingId = createHeadingIds()

  const visit = (nodes: TipTapNode[]) => {
    for (const node of nodes) {
      if (node.type === 'heading') {
        const text = extractTextFromNode(node).trim()
        const id = headingId(text)
        const level = node.attrs?.level
        if (id && (level === 2 || level === 3)) headings.push({ id, text, level })
        continue
      }
      if (Array.isArray(node.content)) visit(node.content)
    }
  }
  visit(contentJson.content)

  return headings
}

// =============================================================================
// computePrevNext — finds previous/next articles given a flat list + current slug
// =============================================================================

interface ArticleLike {
  id: string
  urlId: number
  slug: string
  title: string
}

export function computePrevNext<T extends ArticleLike>(
  articles: T[],
  currentSlug: string
): { prev: T | null; next: T | null } {
  const index = articles.findIndex((a) => a.slug === currentSlug)
  if (index === -1) return { prev: null, next: null }

  return {
    prev: index > 0 ? articles[index - 1] : null,
    next: index < articles.length - 1 ? articles[index + 1] : null,
  }
}
