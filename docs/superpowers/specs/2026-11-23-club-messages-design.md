# Club messages — design

**Status:** design approved by the owner in conversation on 2026-11-22 and 2026-11-23 ("yes, write it up"). This
written spec waits for his review before an implementation plan is written. Nothing here is built yet; until it is,
the code and `AGENTS.md` describe what is built.
**Builds on:** `main` at `b47f6ac2` (the app-owned families rework through stage 4, the sign-in release, design system
v2 and the brand kit).

Words used here. A **message** is what staff post to the club's families: a title, a body and its files. A
**version** is one saved state of a message; the first post is version 1 and every edit adds one. The **poster** is
the staff member who posted it. A **parent** is a person who signs in to the parent portal (`parent` table; the
session's `ctx.parentId`). *(Proposed)* marks the lead's own details, which the owner may change at review.

---

## 1. Why

Clubs today send their news through other apps (the owner names Band and SportsYou), apart from the portal that holds
what a family owes and must sign. The owner, on 2026-11-22: the portal needs in-app messaging, staff to families only,
no commenting, with email the club may turn on. Asked about plain text, he chose a rich editor and attachments from the
start ("It's in other apps like Band and SportsYou that groups use and need"), and editing with every earlier version
kept and visible, like a Facebook post, in place of withdrawing a message whose email has already gone.

In one paragraph: staff who may post write a message in a rich editor, with pictures in it and files attached, and
post it to every family in the club. Parents see new messages on Home and all of them on a Messages page, each showing
who posted it, which links to that staff member's profile. When the club allows it, a message is also emailed, if the
poster leaves "Also email families" ticked. The poster may edit it later; each edit is kept as a version parents can
read, and may be emailed as an update. An Admin may delete a message outright.

## 2. What the owner decided

1. **Audience: every family in the club.** No groups, seasons or single families for now ("Granularity maybe later").
2. **One way.** Staff post; parents read. No replies, comments or reactions.
3. **Email is the club's choice, then the poster's.** A club setting, off by default and changed only by an Admin,
   allows messages to be emailed. When it is on, the post form has "Also email families", ticked by default.
4. **Where parents read them:** a card at the top of Home and a Messages page. No new tab.
5. **A rich editor and attachments from the start.**
6. **Edit, never withdraw.** Only the poster may edit. Every save is a new version; parents see "Edited" and can open
   "Earlier versions", each with its date. An edit has "Email families about this change", ticked by default, and the
   mail says it is an update.
7. **An Admin may delete a message** (when it must disappear, say it held the wrong family's details): audited, no mail.
8. **Every post carries its poster:** "Posted by <name> · <date>", linking to a new staff profile page with the staff
   member's name and email address.

## 3. What stays true

- **The privacy rules of `AGENTS.md`.** A message's content is the same for every family, so it is not family data;
  what is family data, or a person's, is whether a parent has read it, and that is only ever read for the session's
  own `ctx.parentId`. The mail results (which addresses got it, which failed) are other families' addresses and are
  staff-only.
- **Text from staff is rendered as text.** A message body is never HTML and is never given to
  `dangerouslySetInnerHTML`; section 6 says how it is stored and drawn.
- **Nothing family-specific is cached.** The file routes answer `cache-control: no-store`, like the signed-form
  downloads, and the service worker is unchanged.
- **Every write is audited in its own transaction** (`writeAudit(entry, tx)`), with words in `ACTION_NAMES`.
- **Mail ends with "Powered by Boosters Rocket"** and carries no image and no remote content (`src/lib/mail/messages.ts`).

## 4. What staff see

**Messages** is a new entry in the staff menu's Families group, and a row of the Families hub on a phone.

- **The list** (`/staff/messages`): every message, newest first: its title, poster, when it was posted, "Edited" with
  the last edit's date when it has more than one version, and, where it was emailed, "Emailed 142 · 3 couldn't be
  delivered". A deleted message stays in the list as "Deleted by <name> on <date>", with nothing of its content. A
  **New message** button for those who may post.
- **New message** (`/staff/messages/new`): a title (required, up to 120 characters *(proposed)*), the body in the rich
  editor, files, and, when the club allows email, "Also email families", ticked. **Preview** shows the message as a
  parent will see it, with "This goes to 87 families" and, when emailing, "and is emailed to 142 addresses". **Post**
  posts it.
- **A message** (`/staff/messages/[id]`): the message as parents see it, its versions, and its mail results: delivered
  and failed counts per emailed version, with the failed addresses listed. **Edit** for its poster alone; **Delete**
  for an Admin alone, behind a confirm step that says no mail is sent and the content can't be brought back.
- **Edit** (`/staff/messages/[id]/edit`): the same form, opened on the current version, with "Email families about this
  change", ticked, when the club allows email. Saving adds a version. Anyone else who opens the address is refused.

**Your account** (`/staff/account`) gains a card, "Contact email shown to families": the address parents see on the
staff member's profile. It starts as their sign-in address; they may set another (a club mailbox such as
band-director@club.org) or go back to their sign-in address.

**Settings** gains an item, **Messages** (group Club): one switch, "Allow messages to be emailed to families", off
until an Admin turns it on. Others who may see Settings see it read-only with the line saying who can change it.

## 5. What parents see

- **Home:** while a parent has new messages, a card at the top: "2 new messages from the club", the newest one's title,
  and a link to Messages. When everything is read the card becomes a quiet line, "Messages", linking to the page. With
  no messages at all, nothing is shown.
- **Messages** (`/messages`): every message, newest first: title, "Posted by <name> · <date>", "Edited" when it has
  more than one version, and "New" (word and icon, never color alone) on those this parent hasn't read.
- **A message** (`/messages/[id]`): the current version in full, its pictures in place and its files listed by their
  names with their sizes, "Posted by <name> · <date>", and when edited, "Edited <date>" with **Earlier versions**, a
  disclosure listing each earlier version by its date, each opening to that version in full. Who edited is not shown:
  only the poster can edit. Opening it marks it read for this parent.
- **A staff profile** (`/messages/from/[staffId]`): the staff member's name and contact email (a `mailto:` link), and
  the messages they posted. It exists only for a staff member with at least one message that isn't deleted; any other
  id, a staff member's who never posted included, is "not found", so a parent can't list the club's staff.
- **Read and new are per parent.** Two guardians of one family each have their own. A family that joins later sees
  every message that isn't deleted.
- **An edit emailed as an update makes the message new again** for everyone *(proposed: an edit that changes enough
  to email about is worth showing as new; a quiet edit, with the box unticked, leaves read messages read)*.

No new tab: `PARENT_NAV` keeps its five.

## 6. The body: rich text, stored as structure

**The editor** is Tiptap, the one new dependency, named by this spec (the owner's yes to the design covers it). The
packages, each pinned to one exact version with no range, all at the same release: `@tiptap/react`, `@tiptap/pm`,
`@tiptap/starter-kit` and `@tiptap/extension-image`. The builder takes the newest 3.x release at least two weeks old
when the slice starts and writes the version in the slice's report. The editor runs only in the staff form, a client
component; parent pages and mail never load it.

**What the editor offers:** paragraphs, headings (two levels), bold, italic, underline, bulleted and numbered lists,
links, line breaks and pictures. Nothing else is accepted, whatever the browser sends: tables, code, colors, fonts,
embeds and raw HTML are not.

**Stored as JSON, checked on the server.** The body is Tiptap's document JSON, kept in a `jsonb` column. Every save goes
through one function, `checkBody()` *(proposed: `src/lib/messages/body.ts`)*, which rebuilds the document from an
allowlist of node and mark types and their attributes and refuses anything else, so what is stored is only what the
allowlist names:

- nodes: `doc`, `paragraph`, `heading` (level 2 or 3), `bulletList`, `orderedList`, `listItem`, `hardBreak`, `text`,
  `image`;
- marks: `bold`, `italic`, `underline`, `link`;
- a link's `href` only `https:`, `http:` or `mailto:`, parsed with `URL`, at most 2,000 characters; any other attribute
  is dropped;
- an image only `{ attachment: <id> }`: the id of a picture uploaded to this message (section 7), never a URL, plus
  `alt` text up to 300 characters;
- at most 100 KB of JSON and 20,000 characters of text *(proposed)*.

**Drawn by our own code.** `renderBody()` walks the checked JSON and returns React elements for the pages, and
`bodyMail()` walks it again for the mail: plain text, and HTML in which every piece of text and every attribute goes
through the existing `esc()`. Neither uses Tiptap's HTML output or `dangerouslySetInnerHTML`. A link opens with
`rel="noopener noreferrer"` and is shown with its address when its text differs from it *(proposed)*.

## 7. Pictures and files

- **What may be uploaded:** pictures (JPEG, PNG, GIF, WebP) shown in the body, and attached files: PDF, Word
  (`.docx`, `.doc`), Excel (`.xlsx`, `.xls`), PowerPoint (`.pptx`, `.ppt`) and the same picture types. SVG is not
  accepted. **At most 10 files per message and 10 MB each**, pictures in the body included.
- **Checked by their contents.** The type is read from the file's first bytes (the magic numbers of each allowed type;
  for the Office formats, a ZIP whose entries name the Office part, or the OLE header for the older ones), never from
  its name or the browser's word. A file whose contents match no allowed type is refused with the name and a plain
  sentence.
- **Kept in Postgres** as `bytea` (the schema's `bytes` type), so the nightly backup and a restore carry them with no
  new volume. The original name is kept, cut to 200 characters, and shown only on the page as text.
- **Uploaded before posting.** The form uploads each file through a staff action as it is added; it is held against
  the staff member until the post or edit saves, then belongs to that version. Files held and never posted are removed
  by the daily clean-up after 24 hours *(proposed)*.
- **Served through guarded routes.** A parent's route `/messages/files/[id]` answers only to a signed-in parent, and
  only for a file of a version of a message that isn't deleted (earlier versions' files included); the staff route
  `/staff/messages/files/[id]` to staff who may see messages. Both send `cache-control: no-store`,
  `x-content-type-options: nosniff`, the type read from the bytes, and a fixed name: pictures inline, everything else
  as an attachment named `attachment.<ext>` from the stored type, so nothing typed by staff reaches a header.
- **Versions share files.** An edit that keeps a file points at the same stored file; a file dropped in an edit stays
  with the earlier version that had it.

## 8. Email

- **Who gets it:** the sign-in address of every parent with an active membership of an active family, once per
  address, however many families the address belongs to. Addresses are the portal's own (`docs/agents/app-records.md`),
  never QuickBooks'.
- **Queued with the post.** Posting or saving an edit with the box ticked writes the version and one row per address to
  a mail queue in the same transaction. The worker (`runDueJobs()`, `src/lib/jobs/runner.ts`) sends a batch at each
  wake, a new job `messages.mail` with mail purposes `club_message` and `club_message_update`. A send that fails is
  tried again at the next wake, at most three times *(proposed)*, then counted as failed with its reason.
- **What it says.** Subject: the title for a post, "Updated: <title>" for an edit. Body: the club's name bar, "<name>
  posted a message" (or "updated a message"), the body as section 6 draws it, each picture as a line "There's a picture
  here: view it in the portal", the files' names as a list with "Open the message in the portal to download them", and
  the message's address in the portal alone on its line (`APP_URL` and `/messages/<id>`, which brings a parent who must
  sign in back to it). Then "Powered by Boosters Rocket". No file is attached and nothing is loaded from the portal.
- **The results.** Staff who may see messages see, per emailed version, delivered and failed counts and the failed
  addresses with a short reason. Parents never see them.
- **A delete stops what hasn't gone.** Rows still queued for a deleted message are dropped; nothing more is sent.

## 9. Edits, versions and delete

- **Only the poster edits**, checked in the action against `ctx.staffUserId` and the message's `postedBy`, whatever
  their permissions; the Edit button is shown to the poster alone. A poster who is disabled can't sign in, so their
  messages stand as they are; an Admin can still delete one.
- **A version is never changed.** An edit inserts version n+1 with its title, body and files; the current version is
  the highest. The title may change in an edit.
- **Delete is an Admin's** (a new Admin-only permission, section 10). It erases the content of every version, their
  files' bytes and the queued mail in one transaction, and keeps the message row with who deleted it and when, so the
  staff list can say so. Its audit row names the message by its id and number of versions, and holds none of its content, its title included (a title can hold what had to be removed). Parents stop
  seeing it at once; a link to it, or to one of its files, is "not found". There is no undo.

## 10. Permissions, audit and settings

**Permissions** (`src/lib/permissions/registry.ts`, with words and an area in `src/lib/permissions/words.ts`):

| Permission | What it allows | Admin-only |
| --- | --- | --- |
| `Messages.Post.ReadWrite` | See every message and its mail results, post messages, edit one's own | no: a custom role may hold it |
| `Messages.Delete.ReadWrite` | Delete any message | yes |
| `Settings.Messages.ReadWrite` | Turn emailing messages on or off | yes |

The staff pages ask for `Messages.Post.ReadWrite`; an Admin holds every permission. Seeing the Settings item asks for
`Settings.Club.Read`, like the Club item.

**Audit actions** (each with words in `ACTION_NAMES`, `src/lib/audit/actions.ts`): `message.post`, `message.edit`
(with the version number and whether it was emailed), `message.delete`, `message.file.upload`,
`settings.messages.change`, `staff.contact_email.change`. A parent reading a message is not audited (their own family's
view). Staff opening a message page or the list is not audited: it shows no one family's data. The failed addresses
are a list across families, like the roster's, and are not audited per view *(proposed)*.

**The club setting** is kept in the `setting` table under `messages.email_allowed` *(proposed)*, read through
`src/lib/settings/`.

## 11. Data

*(Proposed names; the builder follows `docs/agents/database.md` and takes the next migration number, 0057 at the time
of writing.)*

- `message`: id (uuid), `posted_by` (staff_user), `posted_at`, `deleted_by`, `deleted_at`.
- `message_version`: id, `message_id`, `n` (1, 2, …; unique with the message), `title`, `body` (jsonb, checked),
  `saved_at`, `emailed` (boolean).
- `message_file`: id, `message_id`, `held_by` (staff_user, while not yet posted), `name`, `type`, `size`, `bytes`
  (bytea), `uploaded_at`.
- `message_version_file`: `version_id`, `file_id`, `position`; which files a version has, in order, pictures in the body
  included.
- `message_read`: `message_id`, `parent_id`, `version_n` read, `read_at`; unique on message and parent.
- `message_mail`: id, `version_id`, `address` (trimmed, lower-cased; unique with the version), `status` (queued, sent,
  failed), `tries`, `reason` (short, no secret), `sent_at`.
- `staff_user.contact_email` (nullable): the address shown on the profile; null means the sign-in address.

The daily clean-up (`tests/integration/cleanup.test.ts` names every table) removes held files over 24 hours old and
`message_mail` rows for versions over 90 days old *(proposed)*, and keeps the rest. None of these tables is keyed by a
QuickBooks id, so a change of company clears nothing here.

## 12. Code and the checklists it meets

- `src/lib/messages/` *(proposed)*: `body.ts` (check and draw), `files.ts` (types by bytes, limits), `parent.ts` (the
  parent reads, each taking `ctx.parentId`: the list with new flags, one message, its versions, a profile, marking
  read), `staff.ts` (the staff list, a message with its results, post, edit, delete, uploads), `mail.ts` (queue and the
  worker's job). `staff.ts` and `mail.ts` read every parent's address: they join `STAFF_ONLY_IMPORTS` in
  `tests/integration/page-guards.test.ts`; `parent.ts` and `body.ts` join `PARENT_CODE_ELSEWHERE`.
- **Parent pages** `/messages`, `/messages/[id]`, `/messages/from/[staffId]`: the new parent page checklist, each with
  `requireParentPage()` and its own address first; `[id]` and `[staffId]` added to `PARAMS` in
  `tests/integration/parent-isolation.test.ts` and `tests/e2e/parent-params.ts`, with ids seeded in
  `scripts/seed-e2e.ts`. The Home card goes in `src/app/(parent)/page.tsx`.
- **Parent server action:** marking read happens on the server as the message page renders, so there is no parent
  action *(proposed)*.
- **Route handlers** `/messages/files/[id]` and `/staff/messages/files/[id]`: listed in `ROUTE_HANDLERS` with how each
  is guarded and the test that proves it.
- **Staff pages** `/staff/messages`, `/new`, `/[id]`, `/[id]/edit`: `requireStaffPage("Messages.Post.ReadWrite")` first,
  built from the primitives (`PageHeader`, `Card`, `DataTable`, `Notice`, `ActionOutcome`, `TextInput`, `Checkbox`,
  `Button`); the menu entry in `staffMenu()`, `tests/integration/staff-menu.test.ts`, `GROUPS` in
  `tests/e2e/staff-menu.spec.ts`, and its `ABOUT` line in `hub-page.tsx`.
- **Staff actions:** post, edit, upload and remove a held file (`staffAction("Messages.Post.ReadWrite", …)`), delete
  (`staffAction("Messages.Delete.ReadWrite", …)`), the setting (`staffAction("Settings.Messages.ReadWrite", …)`), and
  the contact email (`staffSelfAction`, taking no id).
- **Settings item** `messages` in `SETTINGS_ITEMS` with its keywords ("announcements", "news", "email families") and
  `RAIL_STATUS`, starting with `<SettingsHeader />`.
- **An area document**, `docs/agents/messages.md`, with its row in the table of `AGENTS.md`, written in the first slice.

## 13. Tests

- **The body:** `checkBody()` refuses every node, mark and attribute off the allowlist, a `javascript:`, `data:` or
  relative link, an image with a URL or another message's file, and a body over the limits; a stored `<script>` in a
  text node is drawn as text on the page and escaped in the mail (unit).
- **Files:** each allowed type passes by its bytes; a renamed executable, an SVG, an HTML file named `.pdf` and an 11 MB
  file are refused; an eleventh file is refused (unit and integration).
- **The file routes:** no session, a staff session on the parent route, a file of a deleted message, a held file and an
  unknown id are each "not found"; the answer has `no-store`, `nosniff` and the fixed name (integration).
- **Edits:** only the poster's edit saves; another staff member's, an Admin's included, is refused; an edit adds a
  version and leaves the earlier one unchanged; earlier versions show on the parent page with their dates.
- **Read state:** parent A reading a message changes nothing for parent B of the same family or another; an emailed
  edit makes it new again and a quiet one doesn't; the Home card's count follows.
- **Isolation:** `seedTwoFamilies()` gives family B's parent read rows and a failed mail row;
  `tests/integration/parent-isolation.test.ts` finds none of B's state or address on A's pages.
- **Profiles:** a staff member with a visible message has a profile showing their contact email (or sign-in address);
  one with none, or whose only message is deleted, is "not found".
- **Email:** nothing is queued when the club setting is off, whatever the form sent; nothing when the box is unticked;
  one row per address however many families share it; the worker sends, retries and counts failures; a delete drops
  queued rows; the mail holds no file, no image and no remote content, and ends with "Powered by Boosters Rocket".
- **Delete:** an Admin's delete erases every version's content and files and is audited without content; anyone else
  is refused.
- **The usual gates:** `page-guards`, `parent-isolation`, `invariants`, `audit-rows`, `audit-actions`,
  `permission-words`, `cleanup`, `staff-menu` and `settings-sections`, each extended as section 12 says.
- **End to end** (`tests/e2e/messages.spec.ts`, at 390 and 1440 wide, with axe): a staff member posts with a picture
  and a PDF and the box ticked; a parent sees the Home card, opens the message, downloads the PDF, and the card turns
  quiet; the poster edits; the parent sees "Edited" and the earlier version; an Admin deletes; the parent's link is
  "not found".

## 14. Build order: four slices, one pull request

1. **Foundations:** the tables and migration, the permissions with their words, the club setting and its Settings item,
   the staff contact email on Your account, the area document.
2. **Staff posting:** the editor, `checkBody()` and `renderBody()`, uploads and the file rules, the staff pages, post
   and edit with versions, the staff file route.
3. **Parents:** the Home card, Messages, a message with earlier versions, staff profiles, read state, the parent file
   route.
4. **Email and delete:** the queue, the worker's job, the mail, the results on the staff pages, an Admin's delete.

The full suite and the e2e run pass locally before the one push (`fewer, bigger PRs`); push and merge only on the
owner's word.

## 15. Not in scope

Sending to a group, a season or one family; replies, comments, reactions; scheduled posts; push notifications; a
parent's choice to stop the emails; read receipts shown to staff; pinning; search. Each can come later on this design.

## 16. Open questions

None the owner must answer before building. The *(proposed)* details above (the limits, the retry count, the 24-hour
and 90-day clean-up, an emailed edit marking a message new again, the setting's key) are the lead's, for the owner to
change at review.
