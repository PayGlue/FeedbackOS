/**
 * FeedbackOS: helpers for the places where the fork behaves differently from
 * upstream on purpose, so the upstream end-to-end tests keep checking the rest.
 */

/**
 * The bare address of a header that may carry a display name. The fork names
 * the reply address ("Acme Corp Support <reply+...@inbound.test>").
 */
export function addressOf(value: string | undefined | null): string | undefined {
  if (value == null) return undefined
  const match = /<([^>]+)>/.exec(value)
  return (match ? match[1] : value).trim()
}

/** The fork tells the team about new feedback by email; drop those mails. */
export function withoutNewFeedbackMail<T extends { Subject: string }>(mails: T[]): T[] {
  return mails.filter((m) => !/^(Approve new feedback|New feedback): /.test(m.Subject))
}

/** The fork tells the team about new feedback in the bell; drop those rows. */
export function withoutPostSubmitted<T extends { type?: string | null }>(rows: T[]): T[] {
  return rows.filter((row) => row.type !== 'post_submitted')
}
