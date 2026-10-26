import { Heading, Link, Text } from '@react-email/components'
import { EmailLayout } from './email-layout'
import { colors, eyebrow, typography } from './shared-styles'

export interface ConversationClosedEmailProps {
  workspaceName: string
  variant: 'closed' | 'auto_closed'
  logoUrl?: string
  viewUrl?: string
  csatPrompt?: string
  ratingUrls?: readonly [string, string, string, string, string]
}

const CSAT_FACES = ['😞', '🙁', '😐', '🙂', '😄'] as const

const muted: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: '14px',
  lineHeight: '22px',
  margin: '0 0 12px',
}

/** FeedbackOS: in the PayGlue mail look, like the conversation reply. */
export function ConversationClosedEmail({
  workspaceName,
  variant,
  logoUrl,
  viewUrl,
  csatPrompt,
  ratingUrls,
}: ConversationClosedEmailProps) {
  const intro =
    variant === 'auto_closed'
      ? "This conversation was closed because we haven't heard back from you."
      : `${workspaceName} marked this conversation as resolved.`
  const followUp =
    variant === 'auto_closed'
      ? 'Need anything else? Just reply to this email and the conversation will reopen.'
      : 'Not sorted? Just reply to this email and the conversation will reopen.'

  return (
    <EmailLayout preview={intro} logoUrl={logoUrl} logoAlt={workspaceName}>
      <Text style={eyebrow}>{workspaceName} support</Text>
      <Heading style={typography.h1}>
        {variant === 'auto_closed' ? 'Conversation closed' : 'Conversation resolved'}
      </Heading>
      <Text style={typography.text}>{intro}</Text>
      {ratingUrls ? (
        <>
          <Text style={{ ...typography.text, marginBottom: '8px' }}>
            {csatPrompt || 'How did we do?'}
          </Text>
          <Text style={{ margin: '0 0 24px', fontSize: '28px', letterSpacing: '8px' }}>
            {CSAT_FACES.map((face, i) => (
              <a key={face} href={ratingUrls[i]} style={{ textDecoration: 'none' }}>
                {face}
              </a>
            ))}
          </Text>
        </>
      ) : null}
      <Text style={muted}>{followUp}</Text>
      {viewUrl ? (
        <Text style={muted}>
          <Link href={viewUrl} style={{ color: colors.link, textDecoration: 'none' }}>
            View it online
          </Link>
        </Text>
      ) : null}
    </EmailLayout>
  )
}
