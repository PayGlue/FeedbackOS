import { Button, Heading, Section, Text } from '@react-email/components'
import { EmailLayout, NotificationFooter } from './email-layout'
import { typography, button, colors } from './shared-styles'

export interface NewFeedbackEmailProps {
  title: string
  /** Plain-text preview. Empty string suppresses the quote block. */
  preview: string
  /** Display name of the author; empty for an anonymous post. */
  authorName: string
  boardName: string
  /** True while the post waits for approval and customers cannot see it. */
  held: boolean
  url: string
  workspaceName: string
  preferencesUrl?: string
  logoUrl?: string
}

/**
 * Alert for the team when someone outside it posts feedback.
 *
 * Agent-facing, so there is no unsubscribe token: the only opt-out is the
 * notification-preferences surface, and the footer links straight to it.
 */
export function NewFeedbackEmail({
  title,
  preview,
  authorName,
  boardName,
  held,
  url,
  workspaceName,
  preferencesUrl,
  logoUrl,
}: NewFeedbackEmailProps) {
  const heading = held ? 'New feedback waiting for approval' : 'New feedback'
  const paragraphs = preview
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  return (
    <EmailLayout preview={heading} logoUrl={logoUrl} logoAlt={workspaceName}>
      <Heading style={typography.h1}>{heading}</Heading>
      <Text style={typography.text}>
        {authorName || 'Someone'} posted on {boardName}.
        {held ? ' Customers cannot see it until it is approved.' : ''}
      </Text>

      <Section
        style={{
          backgroundColor: colors.surfaceMuted,
          borderRadius: '8px',
          padding: '16px 20px',
          marginBottom: '16px',
          borderLeft: `3px solid ${colors.primary}`,
        }}
      >
        <Text style={{ ...typography.text, marginTop: '0', marginBottom: '8px', fontWeight: 600 }}>
          {title}
        </Text>
        {paragraphs.map((p, i) => (
          <Text key={i} style={{ ...typography.textSmall, marginTop: '0', marginBottom: '8px' }}>
            {p}
          </Text>
        ))}
      </Section>

      <Section style={{ textAlign: 'center', marginTop: '24px', marginBottom: '24px' }}>
        <Button href={url} style={button.primary}>
          {held ? 'Review post' : 'View post'}
        </Button>
      </Section>

      {preferencesUrl && (
        <NotificationFooter
          reason={`You received this email because you are on the ${workspaceName} team.`}
          unsubscribeUrl={preferencesUrl}
          unsubscribeLabel="Manage notification preferences"
        />
      )}
    </EmailLayout>
  )
}
