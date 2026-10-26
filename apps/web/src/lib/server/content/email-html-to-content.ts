/**
 * Inbound email HTML -> TipTap contentJson (+ a plaintext mirror).
 *
 * The richest layer of the inbound email pipeline: it turns an HTML mail body
 * into the same `contentJson` shape a widget/agent rich message stores, so an
 * emailed reply keeps its bold/lists/links/images instead of being flattened to
 * plain text. Pipeline, in order:
 *
 *   1. QUOTE-TRIM (HTML level) — drop trailing quoted history *before* anything
 *      else, mirroring the text-level `extractReplyText` heuristics but on the
 *      markup. Conservative: cut at the first confidently-recognized history
 *      marker (Gmail/Apple attribution line, `gmail_quote`/`gmail_attr`
 *      container, Outlook reply-header / border-top divider, `Original Message`
 *      separator) and keep everything before it; when no marker is found, keep
 *      the whole body. A blockquote the sender wrote mid-reply is NEVER cut on
 *      its own — only in attribution/trailing position.
 *   2. LINE-BOUNDARY pre-pass — the layer-1 sanitizer unwraps `div`/table cells
 *      with NO separator (see `./sanitize-email-html.ts`), so Gmail's
 *      one-div-per-line reply style would collapse to "foobar". Inject explicit
 *      `<br>`/space boundaries here, before sanitizing, so line structure
 *      survives.
 *   3. `sanitizeEmailHtml` -> `turndown` -> `markdownToTiptapJson` ->
 *      `sanitizeTiptapContent`. The final tiptap sanitize is defense-in-depth:
 *      the HTML is untrusted, so even though the markdown bridge is a trusted
 *      parser we re-check the resulting tree. This runs the DEFAULT (permissive)
 *      sanitize — the strict, image-origin-restricting pass happens later at
 *      insert time (`sendVisitorMessage`). Running the permissive pass here
 *      keeps this module's output safe on its own regardless of caller.
 *   4. `text` = the plaintext mirror of the resulting doc (`tiptapJsonToText`).
 *
 * NOTE for the MIME-attachment task (rehosting `cid:` inline images): the final
 * `sanitizeTiptapContent` clears any non-http(s)/data image src to '' (a `cid:`
 * src is not a fetchable scheme), so by the time an image node reaches this
 * module's OUTPUT its `cid:` reference is already gone. The node itself is still
 * present (shape preserved), but to map it back to a MIME part the cid rewrite
 * must happen on the HTML *before* it reaches `sanitizeTiptapContent` — i.e.
 * rewrite `cid:` -> rehosted https URL on the raw HTML string prior to calling
 * `emailHtmlToContent`, so the https src survives the sanitize and lands on the
 * node.
 */

import TurndownService from 'turndown'
import { REPLY_MARKER_PATTERN } from '@quackback/email'
import { sanitizeEmailHtml } from './sanitize-email-html'
import { markdownToTiptapJson, tiptapJsonToText } from '@/lib/server/markdown-tiptap'
import { sanitizeTiptapContent } from '@/lib/server/sanitize-tiptap'
import type { TiptapContent } from '@/lib/server/db'

export interface EmailHtmlToContentResult {
  /** Plaintext mirror of `contentJson` (FTS/preview/transcript source). */
  text: string
  /** Rich doc, or null when the HTML carried no usable content. */
  contentJson: TiptapContent | null
}

// ---------------------------------------------------------------------------
// Quote-history markers (HTML level). Each matches the START of a run of
// trailing quoted history; we cut at the earliest match and keep everything
// before it. Deliberately well-anchored — a bare `<blockquote>` is NOT here (a
// sender's own mid-reply quote must survive), only quotes in attribution or
// client-marked position.
// ---------------------------------------------------------------------------
const HISTORY_MARKERS: readonly RegExp[] = [
  // Gmail / Apple Mail attribution line: "On <date> <name> wrote:" that forms
  // the whole text of its element (ends at a tag boundary). Tolerates an inline
  // <a> mailto for the sender address (Apple/Gmail render the address linked).
  // Mirrors extractReplyText's `^On .+ wrote:$` line rule, HTML-adapted.
  /(?<=>)\s*On\b(?:[^<]|<[^>]*>){2,400}?\bwrote:\s*(?=<|$)/i,
  // The same attribution line from German clients (Fastmail, Apple Mail, Gmail
  // in German): "Am <date>, schrieb <name>:" or "Am <date> schrieb <name>:".
  /(?<=>)\s*Am\b(?:[^<]|<[^>]*>){2,400}?\bschrieb\b(?:[^<]|<[^>]*>){0,300}?:\s*(?=<|$)/i,
  // Gmail quoted container / attribution wrapper (class on div or blockquote).
  /<(?:div|blockquote)[^>]*\bclass="[^"]*\bgmail_(?:quote|attr)\b[^"]*"[^>]*>/i,
  // Yahoo Mail quoted container.
  /<(?:div|blockquote)[^>]*\bclass="[^"]*\byahoo_quoted\b[^"]*"[^>]*>/i,
  // Outlook.com / OWA reply-forward header block.
  /<div[^>]*\bid="?divRplyFwdMsg"?[^>]*>/i,
  // Outlook message header (older OWA / some connectors), id or class.
  /<[^>]*\b(?:id|class)="?[^">]*OutlookMessageHeader[^">]*"?[^>]*>/i,
  // Outlook desktop divider div, but ONLY when the quoted From:/Sent: header
  // block follows it within a bounded window. A bare `border-top: solid` div is
  // far too common (signatures, content dividers, pasted formatting) to treat as
  // a history boundary on its own — requiring the adjacent Outlook header avoids
  // silently deleting real reply content that merely contains a styled divider.
  /<div[^>]*\bstyle="[^"]*border-top:[^"]*solid[^"]*"[^>]*>(?:[^<]|<[^>]*>){0,400}?\bFrom:(?:[^<]|<[^>]*>){0,200}?\bSent:/i,
  // Classic Outlook plaintext-in-HTML separator.
  /-{3,}\s*Original Message\s*-{3,}/i,
]

/**
 * Drop trailing quoted history at the earliest recognized marker. Conservative:
 * no marker -> the HTML is returned unchanged. Cutting can leave an enclosing
 * tag unclosed; `sanitizeEmailHtml` (htmlparser2) re-balances it, so the kept
 * content is unaffected.
 */
function trimQuotedHistory(html: string): string {
  let cut = html.length
  for (const marker of HISTORY_MARKERS) {
    const m = marker.exec(html)
    if (m && m.index < cut) cut = m.index
  }
  const atMarker = replyMarkerCut(html)
  if (atMarker !== null && atMarker < cut) return dropAttributionLine(html.slice(0, atMarker))
  return cut >= html.length ? html : html.slice(0, cut)
}

/**
 * FeedbackOS: where to cut at our own reply marker (`REPLY_MARKER_TEXT`, sent
 * at the top of every mail that can be answered). Language- and client-
 * independent: whatever the client writes around a quote, it quotes the marker
 * verbatim. The cut goes to the start of the blockquote that holds the marker
 * (Apple Mail, Fastmail, Thunderbird and Gmail quote inside one), or to the
 * marker itself when the client quotes without one.
 */
function replyMarkerCut(html: string): number | null {
  const m = REPLY_MARKER_PATTERN.exec(html)
  if (!m) return null
  const quoteStart = html.slice(0, m.index).search(/<blockquote\b[^>]*>(?![\s\S]*<blockquote\b)/i)
  return quoteStart >= 0 ? quoteStart : m.index
}

// Block boundaries a mail client puts around its attribution line.
const BLOCK_BOUNDARY = /<(?:br|\/?div|\/?p|\/?blockquote)\b[^>]*>/gi

/**
 * Drop the client's attribution line ("On … wrote:", "Am … schrieb …:",
 * "Le … a écrit :") left at the end once the quote below it is cut. Recognised
 * by shape, not by words: the last line of text ends with a colon and carries a
 * date or an address. Anything else is the sender's own text and stays.
 */
function dropAttributionLine(head: string): string {
  const bounds: Array<{ start: number; end: number }> = []
  for (const m of head.matchAll(BLOCK_BOUNDARY)) {
    bounds.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  let segEnd = head.length
  for (let i = bounds.length; i >= 0; i--) {
    const segStart = i === 0 ? 0 : bounds[i - 1].end
    const text = head
      .slice(segStart, segEnd)
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .trim()
    if (text) {
      const isAttribution = text.length <= 300 && /:$/.test(text) && /\d|@/.test(text)
      return isAttribution ? head.slice(0, segStart) : head
    }
    if (i > 0) segEnd = bounds[i - 1].start
  }
  return head
}

/**
 * Inject the line/cell boundaries the layer-1 sanitizer would otherwise drop:
 *  - a `<br>` before every `</div>` so adjacent one-div-per-line siblings don't
 *    fuse (`<div>foo</div><div>bar</div>` -> "foo bar", not "foobar");
 *  - a space before every `</td>`/`</th>` so table cells keep a word boundary;
 *  - a `<br>` before every `</tr>` so table rows read as separate lines.
 * turndown collapses the resulting redundant breaks, so over-injecting a
 * trailing/empty-cell boundary is harmless.
 */
function injectLineBoundaries(html: string): string {
  return html
    .replace(/<\/div>/gi, '<br></div>')
    .replace(/<\/(td|th)>/gi, ' </$1>')
    .replace(/<\/tr>/gi, '<br></tr>')
}

// Single reusable turndown instance: ATX headings (`##`) and fenced code blocks
// so `markdownToTiptapJson` maps them onto heading/codeBlock nodes; the default
// img rule already emits `![alt](src)`, which we keep.
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

/**
 * Convert an inbound email HTML body to `contentJson` plus its plaintext mirror.
 * Empty/blank HTML — or HTML that reduces to nothing after quote-trim and
 * sanitize — yields `{ text: '', contentJson: null }`.
 */
export function emailHtmlToContent(html: string): EmailHtmlToContentResult {
  if (!html || html.trim().length === 0) return { text: '', contentJson: null }

  const trimmed = trimQuotedHistory(html)
  const bounded = injectLineBoundaries(trimmed)
  const safeHtml = sanitizeEmailHtml(bounded)
  if (!safeHtml || safeHtml.trim().length === 0) return { text: '', contentJson: null }

  const markdown = turndown.turndown(safeHtml)
  if (!markdown || markdown.trim().length === 0) return { text: '', contentJson: null }

  const contentJson = sanitizeTiptapContent(markdownToTiptapJson(markdown))
  const text = tiptapJsonToText(contentJson)

  // A doc with neither text nor a content-bearing node (e.g. everything was a
  // stripped tracking pixel) is not real content — mirror the blank-HTML case.
  if (!text && !hasContentNode(contentJson)) return { text: '', contentJson: null }

  return { text, contentJson }
}

/** Node types that carry meaning even when a doc has no text leaf (an inline image). */
const CONTENT_NODE_TYPES = new Set(['image', 'resizableImage', 'chatImage'])

/** Depth-first: does the tree hold any non-text content node (e.g. an image)? */
function hasContentNode(node: TiptapContent): boolean {
  if (typeof node.type === 'string' && CONTENT_NODE_TYPES.has(node.type)) return true
  return Array.isArray(node.content) ? node.content.some(hasContentNode) : false
}
