# Integrations as plugins: the core stands alone — design

**Status:** drafted on 2026-11-21 for the owner to approve. Nothing in it is built. It is stage 5 of the app-owned
families rework (`2026-11-18-app-owned-families-design.md`, section 9), reshaped by the owner's two decisions of
2026-11-21 (section 1). Until a slice ships, the code and AGENTS.md describe what is built; the slice that changes a
rule changes AGENTS.md and the area document in the same commit.
**Overrides, as each slice ships:** in `2026-11-18-app-owned-families-design.md`, section 7's "accounting interface"
(it becomes the accounting kind's abilities, section 4 here), section 9's stage 5, and open question 15 where it reads
"Families with no active student" from the books' shape; in the v1 spec, §2's place of QuickBooks as a part every club
has; in `2026-11-10-quickbooks-connection-and-roster-design.md`, §5's roster pages as a view of QuickBooks' cache.
PRODUCT.md's positioning and terms change only in the owner's words (open question 7).
**Builds on:** `main` at `dce3a946`: stages 1 to 3, the sign-in release and stage 4's slices through M8a, as merged.

Words used here. **The core** is what every club has: families, students, guardians, sign-ins, seasons, forms,
volunteering, staff, roles and the audit log. **A plugin** is an in-repo module that adds to the core: pages, menu
entries, jobs and the rest of section 3. **An integration** is a plugin that talks to an outside system. **The
accounting plugin** is QuickBooks Online, today the only one. **On** and **off** are an installation's choice of
plugin; **connected** is the plugin's own state with its outside system (QuickBooks can be on and not yet connected,
as a fresh club is today). *(Proposed)* marks this spec's own details.

---

## 1. Why

The owner, on 2026-11-21:

1. **A club may keep students in the portal when its books have no student type.** This answers the roadmap's open
   product choice (stage 5's row, and stage 3's slice 12a, which kept "Families with no active student" in force only
   while the membership shape names a student type).
2. **The accounting integration is additive, in a plugin style for integrations, not part of the core.** The core
   portal stands whole with no accounting system at all. QuickBooks becomes one plugin that adds to it: money pages,
   payment requirements, buy-out invoices, roster sends, Accounting links. Later integrations follow the same pattern.

Today about seventy files outside the QuickBooks, money, roster, accounting and buy-out folders import from them
(Appendix A). The deepest lean is one a club without books
meets first: the staff Families pages are drawn from QuickBooks' customer cache and the membership shape, so before
QuickBooks is connected and its shape chosen, the Roster page says "QuickBooks isn't connected yet" and lists no
family at all, even though the app has owned families since stage 3. Setup already finishes without QuickBooks (it
has no QuickBooks step); what does not stand is everything after it.

## 2. What stays true

- **Every privacy rule in AGENTS.md.** The family comes only from the session; staff-only modules are never imported
  by parent code; nothing family-specific is cached; no secret reaches the browser; text from an outside system is
  text only. Section 9 says how each holds for every plugin.
- **QuickBooks' requests do not change.** Every write, its callers and its order stay as `docs/agents/
  quickbooks-writes.md` says; `tests/unit/quickbooks-writes.test.ts` keeps its lists and gains none.
- **No address changes.** `/payments`, `/staff/balances`, `/staff/links`, `/staff/reconciliation`,
  `/staff/settings/quickbooks/*`, `/api/quickbooks/callback` and the rest keep their paths.
- **No data is lost and no table is renamed.** The migration rules of `docs/agents/database.md` apply: new migrations
  from `0056`, one agent at a time, additive before finishing, never an applied one edited.
- **"QuickBooks is the truth" for the books.** Where the accounting plugin is on, figures still come from it and say
  when they were read.
- **One accounting system at a time,** as section 10 of the app-owned families spec says; no second one is built.

## 3. What the core owns, and what a plugin may add

**The core owns** the app's own records and every page about them: families, students, guardians, memberships,
sign-ins and their settings, seasons and their steps, the checklist, form and volunteering requirement kinds,
volunteer events, shifts, sign-ups and credit, signed forms and their evidence, staff, roles, permissions, the audit
log, outgoing mail, the club's name and color, setup, Health's own lines (the worker, mail, backups, the address, the
version), the worker and the job runner, and the clean-up.

**A plugin may add** only through the points below. Each is a list the core already keeps, which becomes the core's
entries followed by those of every plugin that is on. Nothing else in the core changes for a plugin.

| Point | Where the core keeps it today | What QuickBooks adds | While the plugin is off |
|---|---|---|---|
| Parent tabs | `PARENT_NAV` | Payments, after Forms | No tab; the page answers 404 |
| Boxes on parent Home | `src/app/(parent)/page.tsx` | What you owe | Not drawn |
| Parts of a parent page | Volunteer, a season's lines | "Pay instead", a buy-out's line; a payment requirement's line | Not drawn |
| Staff menu entries, in the core's groups | `staffMenu()` | Money: Balances, Reconciliation; Families: Accounting links | Not listed; a group left empty is left out, as today |
| Settings sections | `SETTINGS_SECTIONS` | QuickBooks | Not listed |
| Panels on a core staff page | the family's page, a person's page, Progress | Link state, waiting sends, differences, Buy-outs | Not drawn |
| Staff home lines | `src/app/staff/(app)/page.tsx` | The QuickBooks warning, waiting sends | Not drawn |
| Health lines | `src/lib/health/report.ts` | Connection, roster read, shape, the requests check, the money run, the buy-out check, the write queue, the contact take-in | Not drawn |
| Requirement kinds | `src/lib/seasons/kinds.ts` | Payment | Not offered for a new requirement (section 8) |
| A kind's extension | the volunteering rule | A buy-out counts as credit; "Pay instead" | See open question 1 |
| Jobs | `src/lib/jobs/runner.ts` | Token refresh, roster read, write queue, money run and products, buy-out check, contact take-in | Not run |
| Hooks on core changes | none yet (section 7) | Sends a change of a linked record on, or refuses it | Not called |
| Route handlers | `ROUTE_HANDLERS` | `/api/quickbooks/callback` | Answers 404 |
| Audit actions | `ACTION_NAMES` | `roster.*`, `quickbooks.*`, `money.*`, `buyout.*`, `accounting.*` | Always registered: old rows keep their words |
| Permissions | `PERMISSIONS`, `PERMISSION_WORDS`, `PERMISSION_AREAS` | `Finance.Balance.Read`, `Settings.QuickBooks.ReadWrite`, `Accounting.Link.ReadWrite` | Always registered, so a saved role never breaks; the roles checklist hides an off plugin's area |
| Tables and migrations | `src/lib/db/schema.ts`, `drizzle/` | Section 10 | Kept, empty on a club that never turned it on |
| Cleared on a change of company | `clearRosterOfOtherCompanyLocked()` | All of it: it is the plugin's own | Never runs |
| Evidence and audit lookups | signed-form evidence, the audit filter | The company a form was signed under; a record's ids in the books | Nothing added |

*(Proposed:)* the core's own groups and settings sections stay fixed; a plugin adds entries to a group but never adds
a group of its own, except that the Money group exists only while some plugin fills it. A plugin's page is drawn with
the core's primitives (`DataTable`, `Notice`, `ActionOutcome`, the `booster.css` controls) and the core's guards, like
any other page.

## 4. How a plugin declares what it can do

**The manifest.** Each plugin has one plain data file, `src/plugins/<id>/plugin.ts`, that the core reads and the
tests read. It holds:

| Field | What it says |
|---|---|
| `id`, `title`, `kind` | `quickbooks`, "QuickBooks Online", `accounting`. A kind says which abilities apply; at most one plugin of the accounting kind is on |
| `contributes` | Its entries for each point of section 3, each with the permission that shows it |
| `abilities` | For an integration: what its outside system can do (below) |
| `staffOnly`, `parentFacing` | Its modules, by path. Every module in its folder is staff-only unless listed as parent-facing (section 9) |
| `routeHandlers` | Each with how it is guarded and the test that proves it, as `ROUTE_HANDLERS` asks today |
| `tables`, `settings` | The tables and setting keys it owns (section 10) |
| `secrets` | The environment keys whose values the client-bundle check searches for (none for QuickBooks today: its secret is stored encrypted in the database) |
| `onWhen` | What an existing installation's data says about whether it was in use (section 11) |
| `mayTurnOff` | What must be true before an Admin may turn it off (open question 1) |

**The accounting kind's abilities** start from section 7 of the app-owned families spec, which the owner approved.
The core and the accounting pages offer a button only when the plugin that is on declares the ability; a test holds
QuickBooks' list to exactly what it does today.

| Every accounting plugin must be able to | Each declares whether it can | QuickBooks |
|---|---|---|
| Connect and disconnect | Create a customer for a family, student or guardian | Yes |
| List customers (import, links screen, differences) | Change a name; change contact details; change the email field | Yes |
| Read a customer's invoices, balance and Pay links | Move a student to another family | Yes |
| List products (a payment requirement's, a buy-out's) | Make a record inactive (after reading its balance) | Yes |
| Say which company it is connected to | Create an invoice; void one (buy-outs) | Yes |
| Clear what it holds of another company | Check its own requests against a sandbox | Yes |

Abilities are declared, not probed: what a system can do is fixed by its code. What depends on the club's books
(whether they have a student type, whether a balance can be read just now) stays the plugin's own and is said in the
plugin's own words, as today. *(Proposed:)* an ability a plugin does not declare is never offered and never refused
after the fact: the button is simply not there.

## 5. How plugins are registered

**In the repository, compiled into every image, turned on by the club.** *(Proposed:)*

- **One registry.** `src/plugins/registry.ts` imports each plugin's manifest by name; nothing finds plugins by
  reading folders at run time. Adding a plugin is a pull request that adds its folder and one line there.
- **Every plugin is in every image.** One Docker image per release stays one image for every club, as PRODUCT.md
  says. A build that left a plugin out would make an image some clubs can't use, and a successor who may not code
  could not change it.
- **On or off is the club's, kept in the database.** A setting, `integrations.on`, read by one core function,
  `pluginOn(id)`, and changed by an Admin on a new Settings section, Integrations, behind a new Admin-only permission,
  `Settings.Integrations.ReadWrite` (it reaches the club's books, as `Settings.QuickBooks.ReadWrite` does). Turning a
  plugin on or off is audited (`integrations.turned_on`, `integrations.turned_off`). Not an environment variable: the
  club's volunteer changes Settings, not the server.
- **Pages stay under `src/app`,** as Next.js needs, in route groups that change no address:
  `src/app/(parent)/(accounting)/payments/`, `src/app/staff/(app)/(accounting)/balances/` and so on. Each page's first
  line is its guard, as AGENTS.md says, and its second is `await requirePlugin("quickbooks")`, which answers
  `notFound()` while it is off, the same answer as an address that doesn't exist. A layout never guards. A test reads
  every page under a plugin's group for both lines.
- **The core imports no plugin.** Only the registry and the pages in a plugin's route group import from
  `src/plugins/<id>/`; a plugin imports the core but no other plugin. `tests/unit/plugin-boundary.test.ts` reads every
  import under `src/`.

**Why not third-party code loaded at run time.** The owner's choice of open-source, self-hosted copies kept by one
volunteer leaves no one to vet a stranger's module, and the privacy rules are proven by tests that read the code:
the staff-only import scan, the parent isolation run, the route-handler list, the client-bundle check. None of them
can read a module that arrives after the build. Allowing it would cost a plugin API held stable across releases, a
sandbox that keeps a plugin from the database's other families and from the session, signing and a review process,
a page system other than Next.js's file routes, and a way to run migrations that are not in the repository. Each of
those is larger than stage 5. A club that wants an integration we don't have gets it by a pull request, which the
tests then guard (open question 5).

## 6. Which integrations are in scope

| Candidate | In stage 5? | Why |
|---|---|---|
| QuickBooks Online | **Yes**, moved behind the boundary and made optional | The owner's decision 2 |
| Another accounting system | No; the accounting kind's abilities make room for one | The app-owned families spec, section 10 |
| Documenso | No; proposed as the next plugin, a stage of its own (open question 3) | Forms are core, but a form needs a signing system; a club without one would have checklist items in place of forms |
| Outgoing mail (SMTP, Microsoft Graph) | No, and *(proposed)* never: mail stays core | Sign-in can't work without it: set-up links, codes and resets are mailed. Its two senders stay providers inside the core, chosen in Settings as today |
| Staff sign-in providers (Microsoft, Google) | No: core | Staff can't reach Settings without them |

## 7. The core without QuickBooks

Three seams are drawn in the core before anything moves.

**The club's records setting (the owner's decision 1).** Whether the club's families have students becomes the core's
own setting, `club.records`, "Our families have students" (yes or no), on the Club section of Settings. It is read
wherever the code asks `shapeNamesStudents()` today about the app's own records: "Families with no active student"
(`studentsRuleInForce()`, `src/lib/parents/switches.ts`), whether staff may add or move a student, whether a season
has student requirements (`src/lib/seasons/subjects.ts`), and the words a family page uses. The membership shape
stays QuickBooks' own setting and means only how the app's records meet QuickBooks' customer types: a club that keeps
students with books that have no student type keeps them in the app, unlinked, and they never send anything to
QuickBooks. *(Proposed:)* flat books' members remain families of one, worded "member", as the shape says today; that
wording is the plugin's, and a club with no books says "family". What a per-student payment requirement does for an
unlinked student is open question 6.

**One lock for the records.** `ROSTER_LOCK` (`src/lib/roster/shape.ts`) is held by volunteering, seasons and signed
forms to keep a change of family from crossing their writes. It moves to the core as `RECORDS_LOCK`, the same number,
so nothing waits differently.

**Hooks on the app's records.** Today the core calls QuickBooks' code directly when a guardian, family or student
changes: `src/lib/parents/guardians.ts`, `people.ts` and `contact-queue.ts` call `queueForGuardian()` and its kin in
`src/lib/roster/writes.ts`, and the staff Families actions call `askRosterWrite()`. *(Proposed:)* the core calls one
function per change instead, `recordChanged(tx, change)`, inside the change's own transaction, and each plugin that is
on answers in two ways:

- **It may refuse,** with a sentence to show, before anything is saved: QuickBooks refuses a make-inactive while the
  balance can't be read, as open question 11 of the app-owned families spec decided.
- **It may act** in the same transaction: queue a send, or send at once and record the answer, exactly as today.

The changes are a closed list the core names (a family or student created, renamed, made inactive or active; a student
moved; a guardian added, removed, renamed, their details or confirmed sign-in email changed), so a plugin learns of
nothing else. A hook called from parent code (a parent's own details, `contact-queue.ts`) runs a plugin module listed
as parent-facing, which takes the session's family from the change and reads no other family's records.

**The Families pages from the app's records.** `/staff/roster` and `/staff/roster/[id]` list the app's families,
students and guardians whether or not any plugin is on, and the accounting plugin adds its panels (link state, sends
waiting, "Create in QuickBooks and link", differences). With QuickBooks on, connected and its shape chosen, the page
shows what it shows today; the case it no longer has, a page with no families until QuickBooks has been read, is the
point of the change. A QuickBooks customer no family is linked to stays on Accounting links and Reconciliation, the
plugin's pages, as today.

## 8. What a club with no accounting plugin sees

On every page that shows money today. *(Proposed:)* the copy says nothing about money that isn't there; a page only
for money is not there at all. A parent never learns that a portal could show money (open question 4).

| Page | With QuickBooks on (as today) | With no accounting plugin |
|---|---|---|
| Parent Home | The money box: what is owed, Pay buttons, "From QuickBooks, as of …"; or, for an unlinked family, "The club hasn't connected your payments to the portal yet." | No money box. Forms, season and volunteering boxes as today |
| Parent tabs | Home, Forms, Payments, Volunteer, Family | Home, Forms, Volunteer, Family |
| `/payments` | Invoices, Pay links, buy-out invoices | 404, as any address that doesn't exist |
| Parent season lines | A payment requirement reads "Paid", "No invoice yet" or how much is left | No payment requirement exists to read |
| Parent Volunteer | "Pay instead" where a requirement allows it; a buy-out's state | Neither. Volunteering is counted from check-ins and staff credit only |
| `/volunteer/pay-instead/…` | The offer and confirm pages | 404 |
| Staff menu | Money: Balances, Reconciliation; Families: Accounting links | No Money group; Families: Roster, Parents |
| Staff home | The QuickBooks warning, waiting sends | Neither |
| Families pages | Link state, waiting sends, differences, "Create in QuickBooks and link", a family's Buy-outs | The app's records alone; adding a family saves it in the portal and nothing more, with "Saved." |
| Seasons | Payment is a kind to choose; volunteering can offer a buy-out with its product and price | Checklist, form and volunteering only; no buy-out setting |
| Progress | Payment columns | None |
| Settings | Club, Staff sign-in, Outgoing mail, QuickBooks, Parent sign-ins, Forms, Integrations | The same without QuickBooks; Integrations says "The club's books aren't connected to the portal. Turn on QuickBooks Online here if you keep them there." |
| Health | QuickBooks' lines, the money run, the buy-out check, the queue, the take-in | The core's lines only |
| Audit | Every row | Every row, with its words: old QuickBooks rows keep them |
| Roles | The checklist's Money and Accounting areas | Those areas hidden; a role keeps what it was given |

A club that turns QuickBooks on later sees today's pages, starting from "not connected" as a fresh club does now.

## 9. How the privacy rules survive

Each tripwire either moves into the plugin with its code or is widened to hold for every plugin. None is loosened.

| Rule | Its tests today | With plugins |
|---|---|---|
| Staff-only modules are never imported by parent code | `STAFF_ONLY_IMPORTS`, `PARENT_CODE_ELSEWHERE`, `PARENT_FACING_LIB` in `tests/integration/page-guards.test.ts` | The core's lists keep the core's modules. Each plugin's folder is staff-only as a whole unless its manifest names a module parent-facing, and the scan reads the manifests: stricter than today, where a module is staff-only only once someone lists it. A parent-facing plugin module imports none of the plugin's staff-only modules nor the core's |
| A parent page reads only the session's family | `tests/integration/parent-isolation.test.ts` with `seedTwoFamilies()` | Runs twice: with every plugin on (today's seeds and markers, money included) and with none on, each with its must-show checks, so an empty page fails either way. A plugin's seeds join `seedTwoFamilies()` for both families |
| Every parent page guards itself and names its address | `page-guards.test.ts`, the parent pages found on disk | Unchanged; a plugin's route group is under `(parent)`, so its pages are found. Plus: every page in a plugin's group calls `requirePlugin()` second |
| Ids from the browser are checked against the family | each action's own test | Unchanged; the plugin's actions keep theirs (`contact-edits`, buy-outs' confirm and switch back) |
| Route handlers are listed with their guard | `ROUTE_HANDLERS` | The core's list plus each manifest's; a handler found on disk in neither fails |
| Nothing family-specific is cached; data handlers send `no-store` | `tests/unit/pwa-static.test.ts`, `tests/e2e/pwa.spec.ts` | Unchanged: they read `public/sw.js` and the headers, which no plugin may add to |
| No secret reaches the browser | `scripts/check-client-bundle.mjs` | Its `SECRET_KEYS` plus each manifest's `secrets`; every plugin is in every build, so the one build is searched |
| An outside system's text is text only | the rule; no `dangerouslySetInnerHTML` | *(Proposed:)* made a test: no `dangerouslySetInnerHTML` anywhere under `src/`, so every plugin meets it; AGENTS.md's rule says "an outside system's text" |
| Staff notes never reach a parent | `season.staffOnly` markers | Unchanged; a plugin with a staff note seeds one |
| A parent sees no other family's buy-out, invoice or money | `tests/e2e/parent-session.spec.ts`, `OTHER_FAMILIES` | Unchanged with the plugin on; a no-books run checks the props of the four tabs |
| Every write to QuickBooks and who may send it | `tests/unit/quickbooks-writes.test.ts` | Moves with the plugin, its lists unchanged; it also holds the abilities of section 4 to them |
| A change of company clears another company's ids | `docs/agents/app-records.md`'s list and its tests | The plugin's own: its manifest's `tables` must each be cleared or kept by name in its clear (`tests/integration/cleanup.test.ts`'s rule, every table named once, widened to "named once, by the core or one plugin") |
| Every write has its audit row | `tests/unit/audit-rows.test.ts` | Unchanged: it reads all of `src/`, the plugins too |
| The core works with no plugin | none | `tests/unit/plugin-boundary.test.ts` (no core import of a plugin), and a no-books e2e spec that walks every parent tab and the staff menu with QuickBooks off |

Tests that belong to the plugin move to `tests/unit/plugins/quickbooks/` and `tests/integration/plugins/quickbooks/`,
paths the focused run already allows.

## 10. Data, migrations and the change of company

**Tables stay where they are.** There is one schema file and one migration sequence. *(Proposed:)* a plugin's tables
are created on every installation, and are simply empty where it is never turned on. Splitting migrations by plugin
would mean several sequences the migrator must order, and a club that turns a plugin on later would run migrations
long after its others, against a schema they were not tested on. One sequence costs a club without books a few empty
tables.

**Who owns which table.** The QuickBooks plugin owns `qbo_connection`, `qbo_customer_type`, `qbo_customer`,
`qbo_item`, `family_money`, `write_queue`, `qbo_check_run`, `qbo_check_record`, `buyout`, `accounting_link` and
`accounting_link_ended`, and the settings `membership.shape`, `roster.source`, `quickbooks.switch` and the money run's
place. *(Proposed:)* links are the accounting kind's, held by whichever accounting plugin is on (they name their
`system` and `realm_id` already); the app-owned families spec's "the app owns links" stays true in that the app, not
the books, keeps them. The schema file marks each table's owner in its comment and the manifest lists it.

**Where a plugin's ids stay in core tables,** as stated exceptions, each named in the manifest:

- `requirement.item_qbo_id`: a payment requirement's product. *(Proposed:)* kept: the column is empty for every other
  kind, and moving it would be an additive and a finishing migration for no change anyone sees.
- `signed_form_evidence.realm_id`, `family_qbo_id`, `subject_qbo_id`: the record as signed, never rewritten. A form
  signed with no plugin on records none, as one signed with no link does today. The forms area asks the plugin for the
  stamp through the evidence lookup of section 3, rather than reading the roster's company itself.
- `audit_log`: old rows are never rewritten; the audit page's record filter asks the plugin for the ids a record's
  links name (`docs/agents/audit.md`), rather than reading them itself.
- `job_run` rows under the plugin's job names, kept by the clean-up as today.

**The change of company** is wholly the plugin's: the switch page, the ask, the clear and what it keeps, as
`docs/agents/app-records.md` ("A change of company") says. The core offers it one function per core table it must
touch (ending a buy-out's place in volunteering credit is the plugin's own table; ending links is the accounting
kind's), and a plugin writes a core table only through a core function named for it.

**Turning the plugin off** keeps every row: nothing is deleted, cleared or ended by it. Whether it is allowed once
data depends on it is open question 1.

## 11. Existing installations

The proof-of-concept host was deployed at `dce3a946` on 2026-11-21 with QuickBooks connected.

- **The first slice's migration turns QuickBooks on where it was in use.** `onWhen` in QuickBooks' manifest: a stored
  QuickBooks app or connection, or any row in the plugin's tables, or a requirement of the payment kind. That host
  comes up with QuickBooks on and every page as it was; a database with none of these (CI's empty start, a club
  installed later) starts with it off. The migration writes one audit row saying what it found, and is refused by
  nothing.
- **`club.records` is filled from the shape:** yes where the shape names a student type or any student record exists,
  so "Families with no active student" answers as it does now.
- **No address, table or request changes;** sessions, sign-ins, links, money, buy-outs, the queue and evidence are
  untouched.
- **Going back** to the earlier image works: the migration only adds settings, which it doesn't read.
- **The owner's runbook** (`docs/runbooks/before-the-first-family.md`) gains a check after the deploy: on the host,
  QuickBooks shows as on in Settings, Integrations, and Home shows the test family's money as before.

## 12. The slices

One screen-sized pull request each, in this order, each tested on CI. The first five move code behind the boundary
and change nothing anyone sees; the proof is that every existing test passes untouched but for import paths.

| Slice | What is true when it is done | Users see |
|---|---|---|
| P1. The registry and the switch | `src/plugins/registry.ts` and QuickBooks' manifest, declaring today's contributions, abilities, modules, handlers, tables and settings as data; `pluginOn()`; migration `0056` filling `integrations.on` by `onWhen` and `club.records` from the shape, with its audit row. Nothing reads them yet but tests, which check the manifest against the code (every listed module exists, every table is in the schema) | Nothing |
| P2. The core's records setting and lock | `studentsRuleInForce()`, the switches, subjects, adding and moving a student, and the family page's words read `club.records`; `RECORDS_LOCK` in the core. The shape stays QuickBooks' and decides only links and sends | Nothing (the host's answers are the same) |
| P3. Lists from contributions | `PARENT_NAV`, `staffMenu()`, `SETTINGS_SECTIONS`, the staff home's lines, Health's lines, the requirement kinds, the job runner, `ROUTE_HANDLERS`, `ACTION_NAMES` and the permission words are each the core's entries plus those of plugins that are on; with QuickBooks on, each list is the same as before, which the existing tests prove | Nothing |
| P4a. Hooks: guardians | `recordChanged()`; `guardians.ts`, `people.ts` and the parent's `contact-queue.ts` call it, and QuickBooks' listeners queue or send what they did. Its parent-facing listener is in the manifest | Nothing |
| P4b. Hooks: families and students | The Families actions save the app's record and call the hook; refusals (the balance rule) come back as the plugin's sentence, as today. `askRosterWrite()` is reached only from the plugin | Nothing |
| P5a. The plugin's code moves | `src/lib/quickbooks/`, `src/lib/roster/` (all but what P2 moved), `src/lib/accounting/`, `src/lib/buyouts/`, and `src/lib/money/` (but `cents.ts` and `due.ts`, which the core uses for any amount or date) move under `src/plugins/quickbooks/` by `git mv`, with import paths only; the contact take-in and the evidence and audit lookups go with them. `plugin-boundary.test.ts` turns on | Nothing |
| P5b. The plugin's pages in their groups | Every QuickBooks page and handler moves into an `(accounting)` route group, the same addresses, each with `requirePlugin()` second; the plugin's tests move under `tests/*/plugins/quickbooks/` | Nothing |
| P6. Tripwires for every plugin | The staff-only scan reads the manifests, default staff-only; `parent-isolation.test.ts` runs with every plugin on and with none; `ROUTE_HANDLERS` and `SECRET_KEYS` read the manifests; the `dangerouslySetInnerHTML` test; the clean-up test's ownership rule | Nothing |
| P7a. Families pages from the app's records | `/staff/roster` lists the app's families, students and guardians from its own tables, with QuickBooks' panels drawn by the plugin when it is on. With QuickBooks off a club sees and edits its families | A club with QuickBooks off sees its families (none has one yet) |
| P7b. A family's page from the app's records | `/staff/roster/[id]` the same, its link, sends and Buy-outs as the plugin's panels | The same, for one family |
| P8. A club with no books | Settings, Integrations, turning QuickBooks on and (open question 1) off, audited; every page of section 8 without the plugin; the no-books e2e spec at 390 and 1440 | A club can run the portal with no accounting system |
| P9. The documents | AGENTS.md's rules for plugins (a new checklist, "New plugin"), the area documents moved with their code (`docs/agents/money.md`, `quickbooks-writes.md`, `buyouts.md` under the plugin's heading), `docs/conformance.md`'s rows, the walkthrough, the owner's runbook, and PRODUCT.md in the owner's words | The documents |

P1 to P6 can each be reverted alone. P7a is the first that a club running QuickBooks could notice, and with
QuickBooks on and read it shows the same rows: its test is today's roster tests, passing unchanged.

## 13. Not in this stage

A second accounting system; Documenso, mail or staff sign-in as plugins; plugins from outside the repository or
loaded at run time; a migration sequence per plugin; a setup step for the books (a club turns QuickBooks on in
Settings once setup is finished, as it connects it today); staff raising invoices; moving `requirement.item_qbo_id`.

## 14. Open questions for the owner

Each is a choice only you can make: what families or staff see, or what the project takes on. Each has the lead's
recommendation, which stands if you raise no change.

| # | Question | Recommended | Why |
|---|---|---|---|
| 1 | May an Admin turn QuickBooks off once the club has used it? | Only while nothing depends on it: no link, no payment requirement in a current or future season, no open buy-out. Otherwise Settings says what is still using it, and an Admin can disconnect QuickBooks (as today, figures shown as no longer current) but not turn it off. | Off hides pages; a parent's paid buy-out would stop counting as volunteering and a payment requirement would vanish from a family's season mid-way. Disconnect already has words for that state. |
| 2 | Where a club chooses its books. | A new Settings section, Integrations, Admin-only, and a line on setup's finish page: "You can connect your books later in Settings." No new setup step. | Setup today finishes without QuickBooks and connects it later; a step for a choice most clubs make once, after setup, would lengthen the first run for nothing. |
| 3 | Is Documenso the next plugin? | Yes, as a stage of its own after this one, of the kind "signing". Mail stays core for good. | Forms are core in your list, but a club without Documenso can use only checklist items today, and Documenso's settings, token and webhook already stand apart. Mail can't be optional: every way in is mailed. |
| 4 | What a parent of a club with no books sees about money. | Nothing: no Payments tab, no money box, no line. | Section 8. Words like "the treasurer can tell you what you owe" suit a club whose books aren't connected yet, not one that never keeps them here. |
| 5 | Plugins written outside the project. | Not supported: every plugin is in the repository, compiled into every image and guarded by its tests; a club wanting a new integration proposes it as a pull request. | Section 5. Runtime plugins would cost a stable API, a sandbox, signing and review, and would put the privacy tests out of reach. |
| 6 | A per-student payment requirement in books with no student type, now that such a club keeps students (your decision 1). | Offered only where the books have a student type. Elsewhere a payment requirement is per family; the requirement's page says why in one line. | An unlinked student has no customer, so no invoice can ever meet it: it would read "No invoice yet" forever. |
| 7 | PRODUCT.md's positioning and terms. | Positioning: "Free, open-source and self-hosted by each club. It keeps the club's families, sign-ins, seasons, forms and volunteering, and, where the club keeps its books in QuickBooks Online, links each family to its customer there and shows what they owe." Terms: "family (a household the portal keeps)", "student (a child the portal keeps in a family)", with the QuickBooks links said only under QuickBooks. | PRODUCT.md is yours; today it says the club's books "stay in QuickBooks Online" as if every club had them. |

## 15. Risks

- **The moves are large** (about sixty modules in P5a, thirty pages and handlers in P5b). Kept to `git mv` and import
  paths, with no logic in the same
  pull request, review reads the rename list and CI does the rest. A move cut half way leaves the boundary test off,
  never failing.
- **Hooks in parent code.** P4a puts a plugin call inside a parent's save transaction. The listener is parent-facing,
  scanned as parent code, and takes nothing from the browser: `tests/integration/contact-edits.test.ts` keeps its
  family-B-in-every-field case.
- **The roster pages change source** (P7a, P7b). Shown side by side with QuickBooks on, the old and new pages must
  agree; the slices keep today's tests and add a no-books one.
- **Two answers for one question.** Until P2, "does the club keep students" is the shape's; after it, the core's. P2
  changes every reader in one pull request, and the migration fills the setting so both answers agree on the host.
- **A plugin left off by mistake** on an installation with data hides its money. `onWhen` reads every table the plugin
  owns, and the runbook's check after the deploy looks.

---

## Appendix A: where the core leans on QuickBooks today

From the code at `dce3a946`. "Goes to" is the slice that moves it.

| Area | Files | What it uses | Goes to |
|---|---|---|---|
| QuickBooks itself | `src/lib/quickbooks/` (client, connection, endpoints, health, switch, what-it-does, sandbox check) | Intuit's API, tokens, the company, the switch | P5a, the plugin |
| Money | `src/lib/money/` (`family_money`, the money run, Balances, items, payment standings, Pay links) | Invoices, balances and products read through links | P5a; `cents.ts` and `due.ts` stay core |
| The roster cache and writes | `src/lib/roster/` (refresh, model, queries, writes, queue, shape, source, no-family, attention, place) | `qbo_customer`, `qbo_customer_type`, the shape, the queue, sends | P5a; the lock moves to core in P2; the Families pages' reads in P7a |
| The links screen | `src/lib/accounting/` | Every family's guardians and the cache, the link presses, the import | P5a |
| Buy-outs | `src/lib/buyouts/` | Invoice create and void, the daily check, the change of company | P5a |
| Seasons | `kinds.ts` (the payment rule, `withBuyout`), `subjects.ts` and `roster-lock.ts` (the shape, the lock, the company), `due-reminders.ts` (`moneyRows`) | The payment kind, the buy-out extension | P2 (shape, lock), P3 (kinds) |
| Volunteering | `bought.ts` (`buyoutFacts`), `check-in.ts` and `my-volunteer.ts` (the lock) | A buy-out as credit | P2 (lock), P3 (the extension) |
| Signed forms | `evidence-job.ts` (the roster's company, the lock) | The company a form was signed under | P2, P3 (the evidence lookup) |
| Audit | `src/lib/audit/query.ts` (the roster's company) | A record's ids in the books | P3 (the audit lookup) |
| Parents | `guardians.ts`, `people.ts`, `contact-queue.ts` (sends), `contact-take-in.ts` (the take-in), `contact-edits.ts`, `my-family.ts`, `sessions.ts`, `switches.ts` (the shape), `refresh-ask.ts` (the roster job) | Sends of guardians' changes; "Families with no active student" | P2, P4a; the take-in to P5a |
| Families | `links.ts` (the company, the connection), `roster-import.ts`, `plan.ts`, `company-change.ts` | Links by company; stage 1's import from the cache | Links' company question to P3; the import to P5a |
| Parent pages | Home (`money-box.tsx`, `page.tsx`), `/payments`, `/volunteer` and `pay-instead`, season lines | `loadFamilyMoney()`, buy-outs | P3 (contributions), P5b, P8 |
| Staff pages | Roster and a family's page, Buy-outs, Balances, Reconciliation, Accounting links, Seasons' payment and buy-out parts, Parents' person page, the staff home's warning and counts | The cache, the queue, links, money | P5b, P7a, P7b |
| Health | `src/lib/health/report.ts`, `job-lines.ts` | Connection, roster, queue, check, money run, buy-out check, take-in | P3 |
| Jobs | `src/lib/jobs/runner.ts`, `money-job.ts` | Six QuickBooks jobs | P3 |
| Setup and menus | `staffMenu()`, `SETTINGS_SECTIONS`, `PARENT_NAV`; setup has no QuickBooks step | Entries for every club | P3, P8 |
| Permissions | `Finance.Balance.Read`, `Settings.QuickBooks.ReadWrite`, `Accounting.Link.ReadWrite`; `Roster.Read`'s and `Roster.Family.ReadWrite`'s words name QuickBooks | Who sees money and links | P3 (the plugin's); the core's two keep their names, their words lose QuickBooks in P9 |
| Route handlers | `/api/quickbooks/callback` | The connect | P5b |

## Appendix B: tables and settings that hold QuickBooks ids

| Table or setting | QuickBooks ids | Owner after stage 5 | At a change of company |
|---|---|---|---|
| `qbo_connection` | `realm_id` | QuickBooks | Replaced |
| `qbo_customer_type`, `qbo_customer`, `qbo_item` | `qbo_id`, parent and type ids | QuickBooks | Deleted |
| `family_money` | `realm_id`, invoices in its figures | QuickBooks | Deleted |
| `write_queue` | `realm_id`, target and result ids | QuickBooks | Given up, kept |
| `qbo_check_run`, `qbo_check_record` | `realm_id`, `qbo_id` | QuickBooks | Deleted |
| `buyout` | customer, item and invoice ids, `realm_id` | QuickBooks | Paid kept; unpaid ended; invoiced and paid as last read marked paid |
| `accounting_link`, `accounting_link_ended` | `customer_id`, `realm_id` | The accounting kind | Ended |
| `requirement.item_qbo_id` | a product | Core table, the plugin's column (stated exception) | Cleared |
| `signed_form_evidence` | `realm_id`, family and subject ids | Core (stated exception) | Kept, never rewritten |
| `audit_log` | in `before` and `after` | Core (stated exception) | Kept, never rewritten |
| `membership.shape`, `roster.source`, `quickbooks.switch`, the money run's place | type ids, the company | QuickBooks | Deleted or replaced, as today |
| `integrations.on`, `club.records` (new) | none | Core | Not touched |
