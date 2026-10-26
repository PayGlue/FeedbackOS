# FeedbackOS: how this fork differs from Quackback

FeedbackOS is a fork of [Quackback](https://github.com/QuackbackIO/quackback),
licensed under the [AGPL-3.0](LICENSE). It has been modified since October 2026
by PayGlue. The complete source code of the running instance lives in this
repository, on the `payglue` branch, and changes from Quackback are merged in
regularly.

"Quackback" is the name of the original project. This fork is not affiliated
with, and is not endorsed by, the Quackback project or its maintainers. The names
and logos "FeedbackOS" and "PayGlue" are not part of the AGPL licensing.

## Changes

**Branding**

- No "Powered by Quackback" footer in the portal, widget or emails.
- The admin uses the workspace name and favicon in the browser tab.
- Emails use the PayGlue look: logo and wordmark above a dark card, indigo
  buttons and links. Conversation emails to customers (replies, acknowledgement,
  closed) use the same layout with the subject as heading.
- The widget launcher reads hex brand colours as well as oklch.
- A "Source code" link to this repository in the portal, so every user can
  reach the source of the running version (AGPL section 13). A fork points
  `apps/web/src/lib/shared/source-code.ts` at its own repository.

**Help center on a custom domain**

- Paths from a previous documentation site are redirected into the help center
  (`/` to `/hc`, `/<category>` to the category, `/<category>/<article>` to
  `/hc/...`).
- A category URL whose category was merged or deleted falls back to the
  configured redirect rules instead of a 404.

**Email channel**

- Mails that can be answered by email start with a reply marker line. Inbound
  replies are cut at the quote that holds it, independent of mail client and
  language; the client's attribution line is removed by its shape.
- German attribution lines ("Am ... schrieb ...:") are recognised as well.
- New contacts from inbound email take the display name from the From header.
- The reply address carries a display name ("<Workspace> Support").

**IMAP inbound**

- The poll searches unseen and recent mail, because some servers (label
  folders) report new mail as seen. Duplicates are dropped by Message-ID.
- A handled message can be marked seen in further mailboxes
  (`IMAP_MARK_SEEN_ALSO`, comma separated).
- A fetched message that is not ingested is logged with its reason.

**Tickets API**

- `GET /api/v1/ticket-types` lists ticket types with id and slug.
- `POST /api/v1/tickets` accepts `descriptionFromRequester`, so a ticket an
  integration files on a customer's behalf opens with the customer's message.
- Tickets created by an API key or integration are not assigned to it.

**Dependencies**

- Security updates ahead of upstream where an advisory required it.

## Configuration added by this fork

| Variable              | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `EMAIL_LOGO_URL`      | Logo for emails sent without a workspace logo               |
| `IMAP_MARK_SEEN_ALSO` | Further mailboxes in which a handled message is marked seen |
