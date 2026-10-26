import { Heading, Hr, Link, Text } from '@react-email/components'
import { EmailLayout } from './email-layout'
import { colors, eyebrow, typography } from './shared-styles'

/**
 * Correspondence for the email channel: the agent's words are the body.
 *
 * FeedbackOS: drawn in the PayGlue mail look (logo and wordmark above a dark
 * card, an uppercase support line, the subject as heading), so a customer gets
 * the same mail from support that they get from the rest of the product. Still
 * no unsubscribe and no intro: the message is the content.
 */
export interface ConversationReplyEmailProps {
  /** Sanitized HTML of the agent's message. */
  bodyHtml?: string
  /** Plain fallback when there is no rendered body. */
  messagePreview: string
  agentName: string
  /** Second signature line: team or workspace name. */
  teamName: string
  /** Conversation subject, shown as the heading (without a leading "Re:"). */
  heading?: string
  logoUrl?: string
  /** Portal or widget deep link; omitted when the visitor has no web surface. */
  viewUrl?: string
  quotedPrevious?: {
    date: Date | string
    name: string
    text: string
  }
}

const body: React.CSSProperties = {
  color: colors.text,
  fontSize: '16px',
  lineHeight: '26px',
}

const signature: React.CSSProperties = {
  color: colors.text,
  fontSize: '16px',
  lineHeight: '24px',
  margin: '24px 0 0',
}

const rule: React.CSSProperties = {
  borderColor: colors.border,
  margin: '28px 0 16px',
}

const footer: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: '13px',
  lineHeight: '20px',
  margin: '0 0 16px',
}

const footerLink: React.CSSProperties = {
  color: colors.link,
  fontSize: '13px',
  textDecoration: 'none',
}

const quote: React.CSSProperties = {
  color: colors.textLight,
  fontSize: '13px',
  lineHeight: '20px',
  margin: '0',
}

function formatQuoteDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function quoteExcerpt(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= 500) return trimmed
  return `${trimmed.slice(0, 499).trimEnd()}…`
}

function headingText(subject: string | undefined): string | null {
  const stripped = (subject ?? '').replace(/^(re|aw|fwd?|wg):\s*/i, '').trim()
  return stripped || null
}

export function ConversationReplyEmail({
  bodyHtml,
  messagePreview,
  agentName,
  teamName,
  heading,
  logoUrl,
  viewUrl,
  quotedPrevious,
}: ConversationReplyEmailProps) {
  const preview = messagePreview.slice(0, 140)
  const quoteDate = quotedPrevious ? formatQuoteDate(quotedPrevious.date) : ''
  const title = headingText(heading)

  return (
    <EmailLayout preview={preview} logoUrl={logoUrl} logoAlt={teamName}>
      <Text style={eyebrow}>{teamName} support</Text>
      {title ? <Heading style={typography.h1}>{title}</Heading> : null}

      {bodyHtml ? (
        <div
          style={{ ...body, marginTop: '16px' }}
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      ) : (
        <Text style={{ ...body, margin: '16px 0 13px' }}>{messagePreview}</Text>
      )}

      <Text style={signature}>
        {agentName}
        {teamName && teamName !== agentName ? (
          <>
            <br />
            {teamName}
          </>
        ) : null}
      </Text>

      <Hr style={rule} />

      <Text style={footer}>
        Reply to this email to continue the conversation
        {viewUrl ? (
          <>
            {' · '}
            <Link href={viewUrl} style={footerLink}>
              View it online
            </Link>
          </>
        ) : null}
      </Text>

      {quotedPrevious ? (
        <Text style={quote}>
          On {quoteDate}
          {quoteDate ? ', ' : ''}
          {quotedPrevious.name} wrote:
          <br />
          {quoteExcerpt(quotedPrevious.text)}
        </Text>
      ) : null}
    </EmailLayout>
  )
}
