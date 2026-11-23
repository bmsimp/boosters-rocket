# Club messages: the plan

The spec is [2026-11-23-club-messages-design.md](../specs/2026-11-23-club-messages-design.md); where this plan and the
spec differ, the spec wins. Four slices, one screen each, on one branch (`feature/club-messages`) and one pull request
(spec section 14). Each brief says what it builds and nothing else; each slice's report says what it left undone. Read
`AGENTS.md` and the area documents it lists for every area a slice touches, `docs/agents/messages.md` above all, before
writing code. Tests are written with the code.

## Slice 1: foundations

**Goal.** The data, the permissions, the club's email switch and the staff contact email exist, with nothing yet posted
or read.

**Files and areas.** `src/lib/db/schema.ts` and one migration (`pnpm db:generate --name club_messages`): the tables of
spec section 11 (`message`, `message_version`, `message_file`, `message_version_file`, `message_read`, `message_mail`)
and `staff_user.contact_email`. `src/lib/permissions/registry.ts` and `words.ts`: the three permissions of section 10
(two Admin-only), with words, and `Messages.Post.ReadWrite` in an area of its own. `src/lib/settings/messages.ts`: the
setting `messages.email_allowed` read and saved, audited `settings.messages.change`. A Settings item `messages` (group
Club, seen with `Settings.Club.Read`, changed with `Settings.Messages.ReadWrite`): its page under
`src/app/staff/(app)/settings/messages/`, its action, its rail status. `src/lib/staff/contact-email.ts` and a card on
`/staff/account` with a `staffSelfAction`, audited `staff.contact_email.change`. The daily clean-up's two deletes
(`src/lib/jobs/cleanup.ts`: held files over 24 hours, mail rows of versions over 90 days) and every new table named
there. A new area document, `docs/agents/messages.md`, its row in `AGENTS.md`, and the migration's line in
`docs/agents/database.md`.

**Checklists.** New staff server action (twice: the setting's, and the contact email's as a `staffSelfAction`, taking
no id). A settings page as an item of `SETTINGS_ITEMS` with `RAIL_STATUS`, starting with `<SettingsHeader />`, read-only
with the one line for someone who may see it but not change it. Audit words in `ACTION_NAMES`. Permission words and
areas. Every table in `CLEANED_TABLES` or `KEPT_TABLES`.

**Tests.** `tests/integration/messages-foundations.test.ts`: the setting is off until an Admin turns it on, audited with
before and after; a custom role that holds everything grantable is refused the switch; the page shows the switch to an
Admin and the read-only line to someone with `Settings.Club.Read` alone; the contact email starts as the sign-in
address, can be set (trimmed, lower-cased, checked) and taken back, only for the session's own record, audited, and a
parent session or none is refused; the tables' checks (one version number per message, one read row per message and
parent, one mail row per address and version). Extended: `tests/unit/permission-words.test.ts`,
`tests/unit/settings-sections.test.ts`, `tests/integration/cleanup.test.ts` (boundary tests for both deletes).

**Done when.** `pnpm typecheck` and `pnpm lint` pass; the files touched pass with `invariants`, `page-guards` and
`parent-isolation`; the migration applies to an empty database.

## Slice 2: staff posting

**Goal.** A staff member who may post writes a message in the rich editor, with pictures and files, previews it and
posts it; the poster edits it, each save a new version; staff read the list and a message.

**Files and areas.** The four Tiptap packages of spec section 6, pinned to one exact 3.x release at least two weeks
old (the version named in the report). `src/lib/messages/body.ts` (`checkBody()`, `renderBody()`), `files.ts` (types by
their bytes, the limits), `staff.ts` (the list, one message, post, edit, upload and remove a held file). Staff pages
`/staff/messages`, `/new`, `/[id]`, `/[id]/edit`; the editor as one client component that is given only what it shows;
the staff file route `/staff/messages/files/[id]`. The menu entry in the Families group.

**Checklists.** New staff page (four), built from the primitives; a page with a menu entry (`staffMenu()`,
`tests/integration/staff-menu.test.ts`, `GROUPS` in `tests/e2e/staff-menu.spec.ts`, its `ABOUT` line in
`hub-page.tsx`, `VISITS` in `tests/e2e/staff-pages.spec.ts` for the dynamic ones). New staff server action (post, edit,
upload, remove a held file). New route handler (`ROUTE_HANDLERS`). `staff.ts` joins `STAFF_ONLY_IMPORTS`, `body.ts`
joins `PARENT_CODE_ELSEWHERE`. No `dangerouslySetInnerHTML`.

**Tests.** `checkBody()` refuses everything off the allowlist (spec section 13, the body); the file rules (each allowed
type by its bytes, the refused ones, the size and count limits); only the poster's edit saves, an Admin's included is
refused; an edit adds a version and leaves the earlier unchanged; the staff file route's guards and headers.

**Done when.** As slice 1, plus `audit-rows`, `audit-actions` and `staff-menu`.

## Slice 3: parents

**Goal.** Parents see new messages on Home and all of them on Messages, read one with its earlier versions and files,
and open the poster's profile; read and new are kept per parent.

**Files and areas.** `src/lib/messages/parent.ts` (each read taking `ctx.parentId`: the list with new flags, one
message, its versions, a profile, marking read as the page renders). Parent pages `/messages`, `/messages/[id]`,
`/messages/from/[staffId]`; the Home card in `src/app/(parent)/page.tsx`; the parent file route
`/messages/files/[id]`. `scripts/seed-e2e.ts` gains a message.

**Checklists.** New parent page (three, each `requireParentPage("/its-address")` first; `[id]` and `[staffId]` in
`PARAMS` of `tests/integration/parent-isolation.test.ts` and `tests/e2e/parent-params.ts`); no new tab. `parent.ts` in
`PARENT_CODE_ELSEWHERE`. New route handler. `seedTwoFamilies()` gives family B's parent read rows (and slice 4 a failed
mail row), with their markers.

**Tests.** Read state per parent (A's read changes nothing for B, of the same family or another); the Home card's
count; profiles (one with a visible message shows its contact email, one with none or only a deleted one is "not
found"); the parent file route (no session, a staff session, a held file, an unknown id: "not found"; `no-store`,
`nosniff`, the fixed name); isolation.

**Done when.** As slice 2, plus `parent-isolation` finding none of B's state on A's pages.

## Slice 4: email and delete

**Goal.** A post or an edit, when the club allows it and the box is ticked, is emailed to every parent's sign-in
address once; staff see delivered and failed counts; an Admin deletes a message outright.

**Files and areas.** `src/lib/messages/mail.ts` (the queue written in the post's or edit's transaction, the worker's job
`messages.mail` in `runDueJobs()`, purposes `club_message` and `club_message_update`, three tries); `bodyMail()` in
`body.ts`; the results on the staff message page and list; Delete (`Messages.Delete.ReadWrite`) behind its confirm step;
an emailed edit making the message new again. Its Health line and `docs/runbooks/health-warnings.md` entry if the job
gets a mark. `tests/e2e/messages.spec.ts`.

**Checklists.** New staff server action (delete). `mail.ts` joins `STAFF_ONLY_IMPORTS`. Mail ends with "Powered by
Boosters Rocket" and loads nothing. A delete's audit row holds no content, its title included.

**Tests.** Spec section 13's email and delete lists; the e2e journey at 390 and 1440 with axe.

**Done when.** The full suite and the e2e run pass locally before the one push, which waits for the owner's word.
