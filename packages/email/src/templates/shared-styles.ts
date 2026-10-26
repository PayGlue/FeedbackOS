/**
 * Shared email styles for Quackback emails
 *
 * Ensures consistent branding across all email templates.
 * Colors are derived from the app's design system.
 */

// FeedbackOS: the logo for mails that are sent without a workspace logo (the
// conversation and ticket mails), configurable per install.
export const DEFAULT_LOGO_URL = process.env.EMAIL_LOGO_URL || 'https://quackback.io/logo.png'

// FeedbackOS: PayGlue's mail look, the same dark shell the PayGlue dashboard
// sends its own account mails in (slate background, raised card, indigo).
export const colors = {
  // Indigo, the PayGlue primary (buttons, accents)
  primary: '#4f46e5',
  primaryDark: '#4338ca',
  // Lighter indigo for links on the dark card
  link: '#818cf8',

  // Text colors
  heading: '#f8fafc', // slate-50
  text: '#cbd5e1', // slate-300
  textMuted: '#94a3b8', // slate-400
  textLight: '#64748b', // slate-500

  // Background colors
  background: '#0f172a', // slate-900, page
  surface: '#1e293b', // slate-800, card
  surfaceMuted: '#0f172a', // quote boxes inside the card

  // Border
  border: '#334155', // slate-700
}

// Common layout styles
export const layout = {
  main: {
    backgroundColor: colors.background,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  wrapper: {
    backgroundColor: colors.background,
    padding: '48px 16px',
  },
  container: {
    maxWidth: '560px',
  },
  card: {
    backgroundColor: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: '16px',
    padding: '40px',
  },
}

// Typography styles
export const typography = {
  h1: {
    color: colors.heading,
    fontSize: '24px',
    fontWeight: '700' as const,
    lineHeight: '32px',
    marginTop: '0',
    marginBottom: '8px',
  },
  h2: {
    color: colors.heading,
    fontSize: '20px',
    fontWeight: '600' as const,
    lineHeight: '28px',
    marginTop: '0',
    marginBottom: '8px',
  },
  text: {
    color: colors.text,
    fontSize: '16px',
    lineHeight: '26px',
    marginTop: '0',
    marginBottom: '24px',
  },
  textSmall: {
    color: colors.textMuted,
    fontSize: '14px',
    lineHeight: '22px',
    marginTop: '0',
    marginBottom: '16px',
  },
  footer: {
    color: colors.textLight,
    fontSize: '13px',
    lineHeight: '20px',
    marginTop: '32px',
    marginBottom: '0',
    textAlign: 'center' as const,
  },
}

// Button styles
export const button = {
  primary: {
    backgroundColor: colors.primary,
    borderRadius: '10px',
    color: '#ffffff',
    fontSize: '16px',
    fontWeight: '600',
    padding: '14px 28px',
    textDecoration: 'none',
    display: 'inline-block',
  },
}

// Utility styles
export const utils = {
  divider: {
    borderTop: `1px solid ${colors.border}`,
    marginTop: '32px',
    marginBottom: '32px',
  },
  link: {
    color: colors.link,
    textDecoration: 'none',
  },
  codeBox: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: '8px',
    border: `1px solid ${colors.border}`,
    padding: '24px',
    textAlign: 'center' as const,
  },
  code: {
    color: colors.heading,
    fontSize: '32px',
    fontWeight: '700' as const,
    letterSpacing: '0.2em',
    fontFamily: 'monospace',
    marginTop: '0',
    marginBottom: '0',
  },
}

// Logo/branding: small logo and name above the card, left-aligned
export const branding = {
  logoContainer: {
    paddingBottom: '24px',
  },
  logo: {
    width: 28,
    height: 28,
    display: 'block' as const,
    borderRadius: '6px',
  },
  // A CamelCase name ("PayGlue") is drawn as a wordmark: first part in the
  // link indigo, the rest in white, like the PayGlue dashboard mails.
  appNameAccent: {
    color: colors.link,
  },
  appName: {
    color: colors.heading,
    fontSize: '18px',
    fontWeight: '800',
    letterSpacing: '-0.3px',
    margin: '0',
    paddingLeft: '10px',
  },
}

// The reply marker (see ../reply-marker.ts): quiet, above everything else
export const replyMarker = {
  color: colors.textLight,
  fontSize: '12px',
  lineHeight: '18px',
  margin: '0 0 16px',
  textAlign: 'center' as const,
}

// Small uppercase line above the heading ("PAYGLUE SUPPORT")
export const eyebrow = {
  color: colors.link,
  fontSize: '12px',
  fontWeight: '700' as const,
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
  lineHeight: '18px',
  margin: '0 0 8px',
}
