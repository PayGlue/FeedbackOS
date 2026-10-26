import { Text } from '@react-email/components'
import { REPLY_MARKER_TEXT, useEmailReplyMarker } from '../reply-marker'
import { replyMarker } from './shared-styles'

/** The reply marker, rendered only when the mail can be answered by email. */
export function ReplyMarkerLine({ style }: { style?: React.CSSProperties }) {
  if (!useEmailReplyMarker()) return null
  return <Text style={{ ...replyMarker, ...style }}>{REPLY_MARKER_TEXT}</Text>
}
