import { createContext, createElement, useContext, type ReactNode } from 'react'

/**
 * FeedbackOS: a line at the top of every mail that can be answered by email.
 *
 * Mail clients quote the message they reply to, and each one writes its own
 * attribution line ("On … wrote:", "Am … schrieb …:", "Le … a écrit :") in the
 * reader's language. Recognising every variant is a losing game. This line is
 * ours: every client quotes it verbatim, so the inbound side cuts the reply at
 * it whatever the client or language (see `REPLY_MARKER_PATTERN`).
 */
export const REPLY_MARKER_TEXT = '##- Reply above this line -##'

/** Matches the marker inside quoted text or HTML, with or without `>` prefixes. */
export const REPLY_MARKER_PATTERN = /##-\s*Reply above this line\s*-##/i

const EmailReplyMarkerContext = createContext(false)

/** Set by the sender when the mail carries a reply address that routes back. */
export function EmailReplyMarkerProvider(props: { value: boolean; children: ReactNode }) {
  return createElement(EmailReplyMarkerContext.Provider, { value: props.value }, props.children)
}

export function useEmailReplyMarker(): boolean {
  return useContext(EmailReplyMarkerContext)
}
