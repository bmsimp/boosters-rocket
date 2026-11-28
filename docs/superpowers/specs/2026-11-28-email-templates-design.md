# Email templates — design

**Status:** approved by the owner on 2026-11-28, with his answers below (one changed: the permission is not Admin
only). The mock is `design/mocks/email-templates/index.html` (open it from a checkout).
**Asked for by:** the owner: staff change the words of the emails the portal sends, from Settings, in the editor club
messages already use.

Words used here. An **email** is one kind of mail the portal sends (the password reset). Its **template** is what a
staff member edits: a subject and a body. A **field** is a value filled in at each send ({Form name}). A **fixed part** is
something the portal always writes itself, which no one can change or remove (the link, the code, the security
sentences, "Powered by Boosters Rocket").

## 1. The emails the portal sends today

Every one is built in `src/lib/mail/messages.ts` and sent by `sendMail()` (`src/lib/mail/send.ts`), each with a
`MailPurpose` (`src/lib/mail/types.ts`). All share `frame()`: the club's bar with its name, the body, then the
Powered by line. There are 21. The Outgoing mail test (`testMessage()`) stays as it is: it proves the connection, so
it isn't listed. That leaves **20 templates**, in five groups:

| Group | Email (builder) | Sent by | Fields | Fixed parts |
| --- | --- | --- | --- | --- |
| Sign-in | Sign-in code (`signinCodeMessage`) | `signin-codes.ts` | Club name | The code, big; its life; "If you didn't just sign in…"; the subject |
| Sign-in | Code to confirm a change (`changeCodeMessage`) | `signin-codes.ts` | Club name | The code; its life; "If that wasn't you…"; the subject |
| Sign-in | Welcome (`welcomeMessage`, 3 forms) | `welcome.ts` | Club name, Portal address, Club contact | The set-up link and its life, the Strict lines, NEVER_ASKS |
| Sign-in | Choose your password (`choosePasswordMessage`) | `welcome.ts` | as Welcome | as Welcome |
| Sign-in | Set up your password (`passwordSetupMessage`) | `password-request.ts` | Club name | The link, its life, NEVER_ASKS, DID_NOT_ASK |
| Sign-in | Reset your password (`passwordResetMessage`) | `password-request.ts` | Club name | as Set up |
| Sign-in | Sign-in was reset (`signinResetMessage`) | `signin-reset.ts` | Club name, Club contact | What stopped working, the link, its life, "If you didn't ask…", NEVER_ASKS |
| Sign-in | Password was changed (`passwordChangedMessage`) | `signin-settings.ts` | Club name, Club contact | "If you didn't change it…", NEVER_ASKS |
| Sign-in | Confirm your new email (`emailChangeConfirmMessage`) | `email-change.ts` | Club name | The link, "within 24 hours", "If it wasn't you…" |
| Sign-in | Sign-in email change notice (`emailChangeNoticeMessage`) | `email-change.ts` | Club name | "If it wasn't you, please tell the club." |
| Forms | Signed copy (`signedFormCopyMessage`) | `signed-forms/copies.ts` | Form name, For (a student or the family), Family name | The PDF or its download line |
| Forms | Please sign (`formReminderMessage`) | `signed-forms/reminders.ts` | Form name, For, Due date, Family name | When it's due (or was), the link to the form |
| Volunteering | Signed up (`volunteerSignupMessage`) | `my-volunteer.ts` | Event, Role, When, Where, Volunteer, Contact, Cancel until | The shift's lines, the calendar file's line |
| Volunteering | Shift changed (`volunteerChangeMessage`) | `notices.ts` | as Signed up | When and Where with "it was", the calendar line |
| Volunteering | Shift cancelled (`volunteerCancelMessage`) | `notices.ts` | as Signed up | The shift's line, the calendar line |
| Volunteering | Place freed (`volunteerRemovedMessage`) | `notices.ts` | as Signed up | Why (staff or moved), the calendar line |
| Volunteering | Shift tomorrow (`volunteerReminderMessage`) | `volunteer/reminders.ts` | as Signed up | The shift's lines, the check-in lines |
| Volunteering | Volunteering due (`volunteerDueMessage`) | `volunteer/reminders.ts` | Due date, Days left, Family name | The list of what's still owed, the link |
| Season | Something's due (`requirementDueMessage`) | `due-reminders.ts` | Due date, Days left, Family name | The list of what's due, the Payments and Season links |
| Messages | Club message and its update (`clubMessageMail`) | `messages/mail.ts` | Poster, Message title | The message itself, its files' names, its link |

Every email also offers Club name, Portal address and Club contact (the Club page's treasurer address).

What is never editable, in every email: the club's bar; "Powered by Boosters Rocket" (`POWERED_BY`); any link the
portal makes (set-up, reset, confirm, a form, a message) and the words "open this link" that stand by it; codes and
how long they and links work; every sentence about what to do if the reader didn't ask (`DID_NOT_ASK`, the reset and
change lines); `NEVER_ASKS`; attachments and the lines about them; the lists (what's due, a shift's When and Where);
and the code emails' subjects, which carry the code. The Strict and Standard wording stays in the fixed parts, so a
change of level never needs anyone to rewrite anything.

## 2. What staff edit, and how fields go in

- **The subject**, a `TextInput`, fields written in braces (`Please sign: {Form name}`). An unknown name is refused in
  a sentence naming it. The two code emails' subjects are fixed and shown as text.
- **The body**, in `RichTextEditor` (Tiptap 3.33.0, the Simple Editor template kept as it ships in
  `src/app/components/tiptap/`; anything new in the wrapper or `rich-text-editor.scss`). The toolbar for an email:
  undo and redo, bold, italic, underline, bulleted and numbered lists, a link, and **Insert field**. No headings, no
  pictures (a mail loads nothing). No link tool in the Sign-in group: those mails carry no address but the portal's.
- **A field** is Tiptap's own Mention extension (`@tiptap/extension-mention`, pinned 3.33.0, named here as the one new
  dependency), configured with `{` as its trigger: type `{` or press Insert field (the template's dropdown menu), pick
  from the email's own fields, and it goes in as a chip that reads like its name. Stored as
  `{ type: "field", attrs: { name } }`, checked against the email's list.
- **A fixed part** is one block in the body, drawn as a gray card with its words and a lock ("Fixed: the link to
  choose a password"). It can be moved with cut and paste, not edited or removed: the wrapper's `filterTransaction`
  keeps it, and the server refuses a body that lacks one or has it twice ("Put the reset link back in the email.").
- The server check is `checkBody()`'s pattern in a new pure module, `src/lib/email-templates/body.ts`: an allowlist of
  nodes and marks, the email's own fields and fixed parts, the link rule of `safeHref()`, 20 KB of JSON at most.
- **At each send** a field's value goes in as text, through `esc()` in the HTML; nothing staff write is ever
  HTML. A paragraph whose only field is empty for this send (no Club contact) is left out, as today.
- **Family name** is offered only in the Forms, Volunteering and Season emails, which are about one family. The
  Sign-in emails name no family, student or person, by rule, so they have no such field.
- **Unedited, nothing changes:** each template's default is today's words, with today's sentences as the editable
  paragraphs. A test renders every email with its default and compares it, byte for byte, with what the builder
  sends today.

## 3. Preview and a test send

- **Preview** sits beside the editor (under it on a phone): the email as a family gets it, with the club's bar,
  subject, body and Powered by line, filled with sample values ("Medical release 2026", "Maya Ortiz",
  "Friday, September 4"), each listed in the Fields card. The renderer is pure, so the preview follows each keystroke
  in the browser, as the Club page's color preview does. It shows the words not yet saved.
- **Send me a test** (a tonal button by Save) sends the words on the page, saved or not, with the sample values, to
  the staff member's contact email (`src/lib/staff/contact-email.ts`), said by the button ("Goes to
  treasurer@lakesideband.org."). The subject starts "Test: ". A sample link opens the portal's "This link doesn't
  work" page, never a working token; a sample code is 123456 and opens nothing. At most 10 tests an hour per person.
  Audited `email_template.test`, with the email's key, not the address. Refused while outgoing mail isn't working, in
  a sentence pointing to Outgoing mail.

## 4. Reset to default

**Use the default words** (outlined, on the email's page, only once it differs from the default) opens a
`ConfirmDialog`: "The club's words for this email are replaced with the default. Earlier versions stay in the list."
It saves the default as the next version, so it can be undone from Earlier versions. The list shows each email as
"Club's words" or "Default".

## 5. Versions and audit

- Tables `email_template` (one row per email key that has ever been saved) and `email_template_version` (never
  changed: `n` from 1, subject, body JSON, who, when). The current version is the newest. The default is in code and
  never stored, so a new release can improve a default the club never changed.
- Saving an email that changes nothing is refused. Saving makes it live for the next send; no drafts.
- **Earlier versions** is a list of links on the email's page, each to `?version=N` (read only, with **Use these
  words again**, which saves it as the next version), as a message's earlier versions are.
- Audited `email_template.save` (key, version, `reset` true for the default), `email_template.test`, each in the
  save's transaction, with words in `ACTION_NAMES`. Nothing here is keyed by a QuickBooks id: a change of company
  clears nothing.
- A release that changes an email's fixed parts or its fields checks each stored current version at start-up; one
  that no longer passes is sent with the default, and the email's row says "Using the default words: the club's words
  need a look." (a Health line, `docs/runbooks/health-warnings.md`).

## 6. Permission and place

- A new permission, `Settings.Emails.ReadWrite` (words "Change the words of the emails the portal sends", area Staff
  and club), **not** Admin-only (the owner's answer 3): an Admin holds it and a custom role, a secretary's say, may be
  given it. Its "see" twin is `Settings.Club.Read` (`SEE_WITH` in `src/lib/permissions/words.ts`), the permission the
  page is seen with, read only for someone without the change, with "Only someone allowed to change the emails can
  change them." The fixed parts hold every link and every safety line, so a reworded email can't carry an address of
  its own in the Sign-in group.
- A Settings item `emails` in the group Club, after Messages, titled **Emails**, keywords "templates", "wording",
  "reminders", "sign-in code"; `/staff/settings/emails` (the list) and `/staff/settings/emails/[key]` (one email,
  the key one of a fixed list: anything else is `notFound()`). Rail status "Default words" or "3 changed".
- Not parent code: the pages, `src/lib/email-templates/catalog.ts` (reads and saves) and the renderer are read by staff pages
  and by every sender. The renderer and `template-body.ts` are pure and read no family data; the senders pass the
  values they already pass today.

## 7. Slices

1. **Templates in code, no screen.** Each builder becomes a template (key, group, fields, fixed parts, default body)
   and one renderer; every sender calls it. The byte-for-byte test of section 2. Nothing a family gets changes.
2. **Tables, permission and the list page.** Migration, `Settings.Emails.ReadWrite`, the Settings item, the list
   grouped as in section 1, each email's page read only (its words and the preview).
3. **The editor and Save.** Mention for fields, fixed-part blocks, `template-body.ts`, `email_template.save`; the
   senders read the club's current version.
4. **Send me a test.**
5. **Earlier versions and Use the default words,** and the start-up check with its Health line.

## As built (2026-11-28)

- The pure parts (catalog, body check and render, the mail's frame) are in `src/lib/email-templates/`, so the
  editor's page can draw the preview in the browser; the reads and writes stay in `src/lib/mail/`.
- One table, `email_template_version`, holds every version; an email with no row has its default words.
- "Family name" is left for later: no sender passes a family's name today. The tests' hourly limit is counted from the
  person's own `email_template.test` audit rows. Words set aside after a release are said on the list, the email's
  page and the Settings rail, not yet on Health.

## The owner's answers (2026-11-28)

1. The Sign-in emails are editable, only around their fixed parts, with no links of the editor's own.
2. Saving goes live at once; no drafts.
3. Changed: the permission is one a custom role may be given (a secretary's role), not Admin only; anyone who can open
   Settings (`Settings.Club.Read`) can read the emails.
4. Tiptap's Mention extension is added, `@tiptap/extension-mention` pinned exactly at 3.33.0, our Tiptap's version.
