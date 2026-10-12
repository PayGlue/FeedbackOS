/**
 * What a comment reaction may be: one emoji, never free text. The portal and
 * widget offer a fixed set (REACTION_EMOJIS), while the API and MCP accept any
 * single emoji, so the check is on shape rather than membership.
 */

const MAX_LENGTH = 32
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const FLAG = /^\p{Regional_Indicator}{2}$/u
const KEYCAP = /^[0-9#*]️?⃣$/u
const LETTER = /\p{L}/u

let segmenter: Intl.Segmenter | undefined

/** True when `value` is exactly one emoji: a pictograph, a flag or a keycap. */
export function isReactionEmoji(value: string): boolean {
  if (value.length === 0 || value.length > MAX_LENGTH) return false
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  if (Array.from(segmenter.segment(value)).length !== 1) return false
  if (FLAG.test(value) || KEYCAP.test(value)) return true
  return PICTOGRAPHIC.test(value) && !LETTER.test(value)
}

export const REACTION_EMOJI_MESSAGE = 'A reaction must be a single emoji'
