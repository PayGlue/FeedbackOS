/**
 * Anchor ids for content headings. The article HTML and the help center's table
 * of contents both build ids with this, in document order, so a heading's
 * anchor and its table-of-contents link always agree. Repeated heading text
 * (an "Options" section under each platform, say) gets `-1`, `-2` suffixes, so
 * every heading has its own anchor and the scrollspy marks one entry at a time.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Returns a function that hands out unique ids for one document's headings. */
export function createHeadingIds(): (text: string) => string {
  const used = new Set<string>()
  return (text) => {
    const base = slugifyHeading(text)
    if (!base) return ''
    let id = base
    for (let n = 1; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    return id
  }
}
