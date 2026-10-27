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
- The launcher greeting uses the waving hand with a skin tone (👋🏻) in every
  language.
- Once a teammate replies in a conversation, the messenger header shows that
  person instead of the AI assistant; the assistant moves to the subtitle.
- A "Source code" link to this repository under the feedback filters in the
  portal (`portal-source-code-link.tsx`), so every user can reach the source of
  the running version (AGPL section 13). A fork points
  `apps/web/src/lib/shared/source-code.ts` at its own repository.

**Help center on a custom domain**

- Paths from a previous documentation site are redirected into the help center
  (`/` to `/hc`, `/<category>` to the category, `/<category>/<article>` to
  `/hc/...`).
- A category URL whose category was merged or deleted falls back to the
  configured redirect rules instead of a 404.
- Clicking an image in an article opens it at full size in the file viewer,
  with the article's other images one arrow key away.

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
- No Dependabot. Its updates for this Bun workspace fail in the fork; the
  audit check in CI catches advisories, and upstream merges bring the updates.

## Configuration added by this fork

| Variable              | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `EMAIL_LOGO_URL`      | Logo for emails sent without a workspace logo               |
| `IMAP_MARK_SEEN_ALSO` | Further mailboxes in which a handled message is marked seen |

## Maintaining the fork

- **Upstream updates are merged, never rebased.** Fetch Quackback's `main`, run
  `git merge --no-ff upstream/main` on a branch named `upstream-sync/<date>`,
  and open a pull request. Merge it with a merge commit, not a squash, so the
  upstream history and the recorded conflict resolutions stay.
- **Turn on `git rerere`** in every clone (`git config rerere.enabled true`), so
  a conflict resolved once is resolved the same way next time.
- **`merge=ours` only for branding files.** `.gitattributes` marks `README.md`;
  it needs `git config merge.ours.driver true` once per clone. Never use it for
  code: it discards the other side entirely, real fixes included.
- **No octopus merges** and no automatic search and replace of "Quackback":
  both have silently broken forks before (URLs, path aliases, i18n keys).
- After an upstream merge, check every file this fork added or deleted against
  the new tree. Upstream can bring a deleted file back under a new path.
- The `Upstream reference check` workflow fails a pull request that adds new
  references to Quackback's infrastructure; `upstream-sync/*` branches are
  exempt and reviewed by hand.
- Commits follow Conventional Commits (`feat(email): ...`, `fix(imap): ...`),
  in English, describing the behaviour.
