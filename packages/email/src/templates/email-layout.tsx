import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Section,
  Text,
  Link,
  Row,
  Column,
} from '@react-email/components'
import { layout, branding, typography, utils, DEFAULT_LOGO_URL } from './shared-styles'
import { useEmailShowPoweredBy } from '../powered-by'
import { ReplyMarkerLine } from './reply-marker-line'

interface EmailLayoutProps {
  preview: string
  logoUrl?: string
  logoAlt?: string
  children: React.ReactNode
  footer?: React.ReactNode
  /**
   * Override the process-wide Powered-by flag. Capability-free templates
   * (no link, no code, no token) pass false so the footer cannot add an anchor.
   */
  showPoweredBy?: boolean
}

/**
 * Shared email layout with proper HTML email best practices:
 * - Wrapper Section with background color (fallback for clients that strip <body> styles)
 * - Centered container via React Email's align="center" (no margin:auto)
 * - Consistent logo, spacing, and footer placement
 */
export function EmailLayout({
  preview,
  logoUrl,
  logoAlt = 'Quackback',
  children,
  footer,
  showPoweredBy: showPoweredByOverride,
}: EmailLayoutProps) {
  const fromContext = useEmailShowPoweredBy()
  const showPoweredBy = showPoweredByOverride ?? fromContext
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={layout.main}>
        {/* Wrapper Section provides background color for clients that strip <body> styles */}
        <Section style={layout.wrapper}>
          <Container style={layout.container}>
            <ReplyMarkerLine />
            {/* Logo and name above the card */}
            <Section style={branding.logoContainer}>
              <Row>
                <Column style={{ width: `${branding.logo.width}px`, verticalAlign: 'middle' }}>
                  <Img
                    src={logoUrl ?? DEFAULT_LOGO_URL}
                    alt={logoAlt}
                    width={branding.logo.width}
                    height={branding.logo.height}
                    style={branding.logo}
                  />
                </Column>
                <Column style={{ verticalAlign: 'middle' }}>
                  <Text style={branding.appName}>{logoAlt}</Text>
                </Column>
              </Row>
            </Section>

            <Section style={layout.card}>
              {children}

              {/* Footer */}
              {footer}
              {showPoweredBy ? (
                <Text style={typography.footer}>
                  <Link href="https://quackback.io" style={{ ...utils.link, fontSize: '13px' }}>
                    Powered by Quackback
                  </Link>
                </Text>
              ) : null}
            </Section>
          </Container>
        </Section>
      </Body>
    </Html>
  )
}

/** Standard footer for transactional emails (sign-in, password reset, welcome, invitation) */
export function TransactionalFooter({ children }: { children: React.ReactNode }) {
  return <Text style={typography.footer}>{children}</Text>
}

/** Standard footer for notification emails with unsubscribe link */
export function NotificationFooter({
  reason,
  unsubscribeUrl,
  unsubscribeLabel = 'Unsubscribe from this post',
  preferencesUrl,
}: {
  reason: string
  unsubscribeUrl: string
  unsubscribeLabel?: string
  preferencesUrl?: string
}) {
  return (
    <Text style={typography.footer}>
      {reason}
      <br />
      <Link href={unsubscribeUrl} style={{ ...utils.link, fontSize: '13px' }}>
        {unsubscribeLabel}
      </Link>
      {preferencesUrl ? (
        <>
          {' · '}
          <Link href={preferencesUrl} style={{ ...utils.link, fontSize: '13px' }}>
            Manage notification preferences
          </Link>
        </>
      ) : null}
    </Text>
  )
}
