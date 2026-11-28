# Accounting as a plugin — design

**Status:** approved by the owner on 2026-11-28, with his answers in section 10. Built in the slices of section 7.
**Stage:** stage 5 of the app-owned families rework (`docs/superpowers/plans/2026-11-07-v1-roadmap.md`, "Not started").
**Overrides, once built:** section 7 of `2026-11-18-app-owned-families-design.md` ("The accounting interface") and its
stage 5 lines in sections 9 and Appendix C. Where they speak of an interface in the core, this spec puts a plugin
outside it. The abilities that section lists stay, declared by the plugin.
**Mock:** `design/mocks/stage5/index.html` (setup's books step, Settings → Integrations, the payments choice,
and Mark paid).

Words used here. The **core** is the portal with nothing added: families, students, guardians, sign-ins, seasons,
forms, volunteering, messages and backups. A **plugin** is a folder of code that adds to the core and that the core
never imports. A plugin is **installed** when its code is in the build, and **on** when the club has chosen it.
**Your books** is how the screens name an accounting system in general; `{accounting.name}` is the one that is on
("QuickBooks"), and `{accounting.customerNoun}` its word for a customer ("customer").

## 1. The owner's decisions (2026-11-27)

1. **Students are the portal's own, always.** A club may keep students even when its books have no student type.
2. **Accounting is additive.** The core stands whole on its own. QuickBooks is one plugin that adds money (balances
   and invoices), roster writes, buy-outs and the accounting links screen. Other accounting packages, and later other
   integrations, follow the same pattern. It is not an interface inside the core.
3. **New screens and copy are provider-neutral.** "Your books", `{accounting.name}`, `{accounting.customerNoun}`.
   No new screen hard-codes QuickBooks.

His answers of 2026-11-28 (section 10): turning QuickBooks off keeps its links and figures; with no accounting
system the Admin chooses to track payments by hand or not at all (section 2a); "Your books" is a setup step of its own.

## 2. What the core owns

| The core owns | A plugin adds |
|---|---|
| Families, students, guardians, memberships, sign-ins, contact details | Links from those records to the books |
| Seasons and steps; the form, volunteering and checklist kinds; the payment kind with payments by hand | Payments met by the books; the buy-out offer on volunteering |
| Forms and signing (Documenso), volunteering, messages, backups | Money: figures, invoices, Pay, Balances |
| Staff, roles, the audit log, Health, Settings | Writes to the books and their queue; Reconciliation |
| The club's records lock, the worker, mail | Its own jobs, Health lines, Settings page, permissions |

Documenso, mail and staff sign-in stay core. They are on the Integrations page, but the core needs them to work.

### With no accounting at all

**Setup.** A new step, "Your books", comes after Outgoing mail and before First Admin (mock, screen 1). It asks:
QuickBooks Online, or No accounting system, the default. No accounting system then asks the payments choice
(section 2a). Choosing only records the choice. Connecting needs an Admin who is signed in, so it happens after
setup, from Settings, as today.

**Staff see** the Families pages working on the portal's own records: add a family, add a student, rename, move a
student, make inactive, add and remove guardians. Each saves at once, with its audit row, and sends nothing. They do
not see Balances, Reconciliation, Accounting links, the Money group or its hub, the staff home's QuickBooks warning,
or Health's QuickBooks lines. A season step offers forms, volunteering and checklist items, and payments when the
club tracks them by hand. A volunteer requirement has no buy-out offer.

**Parents see** Home with their students, forms, season and volunteering, Family, Messages, and their details. There
is no Payments tab, no money box and no "as of" line; a payment tracked by hand shows on the season as paid or
owed. Their saved phone or address says "Saved.", nothing more.
They never read "The club hasn't connected your payments": that line is for a family not yet linked while
accounting is on.

**Families with no active student** (the Admin's sign-in rule, today in force only while the membership shape names
a student type) is always available, since students are always the portal's own.

### 2a. Payments with no accounting system

The owner, 2026-11-28: with no accounting system, the Admin chooses one of two settings, `payments.byHand`:

- **Track payments by hand.** A payment requirement keeps counting toward its step. Staff mark a family (or, for a
  per-student requirement, a student) paid with an amount, a date and an optional note, in a Drawer from the
  requirement's progress page (mock, screen 4), one at a time or many at once with the table's selection. Each mark
  is audited (`season.payment.marked`, and `season.payment.unmarked` to undo one). Parents see "Paid" or the amount
  still owed on the season, never the note. The note is a staff note, like a waiver's reason: it is seeded in
  `seedTwoFamilies()` and the isolation test fails a parent page that shows it.
- **Don't track payments.** Payment requirements are hidden from parents and count neither for nor against a step.
  Staff see each as "Not tracked: no accounting system is on". No payment requirement can be added.

How it fits what came before. The app-owned families spec has the owner's "just manually maintain membership"
(section 4): families kept by hand, without the books. This is the same idea for payments, and it reuses the v1
spec's checklist item, which staff already tick for a family or student (`requirement_progress`, `docs/agents/seasons.md`).
A mark by hand is that tick with an amount, a date and a note. It needs no new kind and no plugin: it is core.

**The amount owed.** A payment requirement tracked by hand has an optional amount, set by staff on the requirement
("$150 per student"). With one, parents read "$150 owed" until marked; without one, "Not paid yet". A mark records
the amount received; a mark below the amount owed still counts as paid (no part payments: the treasurer decides).

**Where the choice appears.** In setup, under No accounting system (mock, screen 1). In the turn-off dialog, which
can't be confirmed without it (mock, screen 3). On Integrations, under Accounting while none is on, where an Admin can
change it later (mock, screen 2b). It is held by `Settings.Integrations.ReadWrite`.

**With accounting on**, payment requirements are met by the books as today and the Drawer is not offered. Marks made
by hand are kept and still count: a payment the club recorded stays recorded.

## 3. The plugin boundary

### What a plugin declares

One manifest per plugin, plain data plus functions, in `src/plugins/<key>/plugin.ts`. A sketch:

```ts
type Plugin = {
  key: "quickbooks";
  kind: "accounting";                      // later: "integration"; one accounting plugin on at a time
  name: string;                            // "QuickBooks Online"
  nouns?: { books: string; customer: string; customers: string };   // accounting only
  abilities?: readonly AccountingAbility[];                          // accounting only
  permissions: readonly PluginPermission[];   // each with its words, area, and whether Admin-only
  auditActions: Record<string, string>;       // action -> words, as ACTION_NAMES
  tables: readonly string[];                  // the tables it owns
  settings: IntegrationItem;                  // its row on Integrations and its Settings page
  pages: readonly PluginPage[];               // staff menu entries and parent tabs, by path and permission
  jobs: readonly PluginJob[];                 // name, when due, run()
  health: readonly HealthCheck[];             // lines for Health and the staff home
  slots: Partial<Slots>;                      // what it adds to core screens (below)
  on: { canTurnOff(): Promise<Blocker[]>; turnOff(tx): Promise<void>; turnOn(tx): Promise<void> };
};

type AccountingAbility =
  | "customer.create" | "customer.rename" | "customer.move" | "customer.makeInactive"
  | "contact.update" | "email.update" | "invoice.create" | "invoice.void";
```

Every accounting plugin must connect, disconnect, list customers, read a customer's invoices, balance and Pay links,
and list products. The abilities above are the optional ones, from section 7 of the app-owned families spec.
QuickBooks declares them all. A button that needs one is drawn only while the plugin on declares it.

### How the core finds plugins

- **Compiled in, turned on in Settings.** `src/plugins/index.ts` lists the installed plugins: one line each. There is
  no loading of code at run time, no upload and no marketplace. A self-hosted club gets every plugin in the release.
- **On or off** is one setting, `plugins.on` (a list of keys; at most one of kind `accounting`), read through
  `pluginOn(key)` and `accountingOn()`, which returns the plugin or null.
- **The core imports nothing under `src/plugins/`** but `index.ts` and `types.ts`. A test reads every import in
  `src/lib` and `src/app` outside plugin paths and fails for any other (`tests/unit/plugin-boundary.test.ts`).
  It starts with a list of today's crossings, and each slice shortens it. It ends empty.

### Slots: what the core offers to be added to

The core draws its own screens and leaves named places a plugin fills. Each slot is typed, takes only what the
core gives it, and draws nothing when no plugin fills it.

| Slot | Core screen | QuickBooks fills it with |
|---|---|---|
| `parent.homeCards(familyId)` | Home | The money box and its open invoices |
| `parent.tabs` | Parent bar | Payments |
| `parent.contactSaved(familyId)` | Your details | Today's words for a change sent on to the books |
| `staff.menu` | Staff menu and hubs | Balances, Reconciliation, Accounting links |
| `staff.homeLines` | Staff home | "QuickBooks needs attention" |
| `staff.familyPanels(familyId)` | A family's page | Its link, what the books hold, the write forms |
| `seasons.paymentSource` | The payment kind | Invoices for the requirement's product, in place of marks by hand |
| `volunteer.creditSources` | Volunteering counts | Paid buy-outs ("Paid instead"); kept while off (section 5) |
| `volunteer.requirementOffers` | A volunteer requirement | The buy-out offer |
| `families.howToAdd` | Add a family, add a student | Today's flow: the books first, then the record |
| `records.events` | Every save of a core record | Queue the write to the books, in the same transaction |
| `records.mayMail()` | Reminders, messages' mail | Hold mail while a change of company is half done |

A slot handed a family is handed `ctx.familyId` from the session, never an id from the page. A parent slot's code is
parent code (below).

**Events.** When the core saves a family, student, guardian, contact detail or sign-in email, it calls
`records.events` inside its own transaction, with the record's app id and what changed. QuickBooks' handler is what
the roster writes and the contact queue do today: it queues the write, in that transaction. The core never waits on
the books, and the request sent is the same as today's.

### How its tables, permissions, audit actions and Settings entry hang off it

- **Tables.** A plugin's tables are made by the same Drizzle migrations, in the same chain, whether it is on or not.
  `tables` names them; a test checks every table belongs to the core or to exactly one plugin, and that no core table
  has a foreign key into a plugin's. A plugin's table may point at a core record (`family_money.family_id`, with
  `restrict`: the core never deletes a family). Turning a plugin off drops nothing.
- **Permissions.** Installed plugins' permissions join `src/lib/permissions/registry.ts` at build, so the type stays
  an exact list and `ADMIN_ONLY` works as now. Their words and areas come from the manifest. While a plugin is off,
  the roles checklist leaves its permissions out (a saved role keeps them) and its guards refuse.
- **Audit actions.** Installed plugins' words join `ACTION_NAMES`, on or off, so old rows always read in words.
- **Settings.** The manifest's `settings` becomes an item of `SETTINGS_ITEMS` of kind `integration`, a row of the
  Integrations page under its kind. Its page starts with `<IntegrationHead />` as today.
- **Pages.** Next.js needs route files under `src/app`, so a plugin's pages stay there, each a thin file that calls
  `requirePluginPage("quickbooks", "Permission")`: `notFound()` while the plugin is off, then `requireStaffPage()`.
  The page-guards test learns which paths belong to which plugin and fails a page there without it. Its work lives in
  the plugin's folder.
- **Jobs and Health.** The worker runs a plugin's jobs only while it is on. Health shows its lines only while on.

### Who may turn a plugin on or off

A new core permission, `Settings.Integrations.ReadWrite`, Admin-only, guards the Integrations page (today it borrows
`Settings.QuickBooks.ReadWrite`) and the turn on and turn off. Every Admin holds it.

## 4. QuickBooks behind the boundary, area by area

Everything moves into `src/plugins/quickbooks/`. Its requests to Intuit and to the relay do not change, and
`tests/unit/quickbooks-writes.test.ts` holds them, pointed at the new paths. The code shared by any future accounting
package (links, money, buy-outs, the mapping screen) stays inside this plugin until a second package is built. Its
manifest's abilities and nouns are the line a second package would follow.

| Area | Today | Behind the boundary |
|---|---|---|
| Connection, relay, discovery, client | `src/lib/quickbooks/` | The plugin's `connection/`. Unchanged. |
| Customer list, types, shape, refresh | `src/lib/roster/` (cache, `shape.ts`, `refresh.ts`) | The plugin's `books/`. The shape decides links only, never whether a family has students. |
| Records lock | `ROSTER_LOCK` in `src/lib/roster/shape.ts` | `RECORDS_LOCK` in `src/lib/families/`, core. The plugin takes it as today. |
| Roster writes and queue | `src/lib/roster/writes.ts`, `queue.ts` | The plugin's `writes/`, reached by `records.events` and `families.howToAdd`. |
| Contact queue (parent code) | `src/lib/parents/contact-queue.ts` | The plugin's `parent/`, an event handler. Still parent code: in `PARENT_FACING_LIB`. |
| Money cache, Balances, the money run | `src/lib/money/` | The plugin's `money/`. `cents.ts` and `formatMoney()` go to the core: a money figure is drawn one way. |
| Buy-outs and their daily check | `src/lib/buyouts/` | The plugin's `buyouts/`, through `volunteer.creditSources` and `requirementOffers`. |
| The payment kind | In `src/lib/seasons/kinds.ts` | Core, with marks by hand; the plugin's `seasons/` meets it from the books through `seasons.paymentSource`. |
| Mapping screen, import, differences | `src/lib/accounting/`, `/staff/links` | The plugin's `links/`. The page stays at `/staff/links`. |
| `accounting_link`, `accounting_link_ended` | `src/lib/families/links.ts` | The plugin's tables. The core has no column that points at the books. |
| Reconciliation, customers with no family | `/staff/reconciliation`, `src/lib/roster/no-family.ts` | The plugin's pages. |
| The change of company and its clear | `src/lib/quickbooks/switch.ts`, the `company-change.ts` files | The plugin's `switch/`. It ends links and clears the plugin's own tables; it never touches a core record, as since M7a. |
| The sandbox check | `src/lib/quickbooks/sandbox-check/` | The plugin's. Unchanged. |
| Health, the staff warning | `src/lib/quickbooks/health.ts`, `report.ts` | The manifest's `health`. |
| Settings pages | `/staff/settings/quickbooks/**` | Unchanged addresses, guarded by `requirePluginPage()`. |

**Words.** Screens that stay QuickBooks' own (its settings, its setup steps, the relay) keep their words. Every core
screen that names the books today moves to the neutral words: the permission words of `Roster.Read` and
`Roster.Family.ReadWrite` ("see families and students", "add, rename, move and make inactive families and students,
and send the changes to your books"), the Integrations page's Accounting lede and rule (mock, screen 2), and
`PRODUCT.md`'s terms ("a family, linked to its customer in your books when the club uses one"). The Connect relay's
spec is unchanged.

### The privacy rules, kept

- **The family comes from the session.** A parent slot takes `ctx.familyId`; it has no other way to name a family.
  `tests/integration/parent-isolation.test.ts` runs every parent page twice, accounting on and off.
- **Staff-only modules.** `STAFF_ONLY_IMPORTS` moves with the files. The page-guards scan reads `src/plugins/` too:
  the plugin's `parent/` folder is parent code and imports nothing staff-only, nor the QuickBooks client.
- **Staff notes, client props, `no-store`, the service worker, secrets.** Unchanged. A slot that draws a client
  component passes only what it shows. `QBO_*` env stays server-only, read inside the plugin.
- **Another company.** The switch rule (an Admin's ask, `roster_company`) is the plugin's, unchanged.
- **Books text is text.** Names from the books are never built into HTML, a URL or CSS.

## 5. Turning accounting off, or on later

**Off.** On Integrations, the accounting row's page has "Turn off QuickBooks Online", behind a ConfirmDialog that
says what stops: money on parent pages, Balances, sends to the books, buy-outs. Decide before: it is refused, in
words, while anything is half done (`canTurnOff()`): a write waiting or being sent, a buy-out being invoiced or
voided, a change of company under way. The dialog names each, with where to settle it.

Turning off, in one transaction with its audit row (`plugins.accounting.off`): disconnects through today's disconnect
(the relay's acknowledgement first, where it applies), sets `plugins.on`, and stops the jobs. It keeps every link,
the money cache, every buy-out and the queue's history. The core's records are not touched.

The turn-off dialog asks the payments choice (section 2a) and can't be confirmed without one. With "Track payments
by hand", every family the books showed as having paid a requirement, as last read, is marked paid in the same
transaction (amount and date from the figures, the note "Paid in QuickBooks"), with one audit row of counts, so
nobody who paid reads "owed" the next morning.

**While off.** Payment requirements follow the Admin's choice (section 2a). A paid buy-out still counts toward volunteering: it is a
settled fact in the plugin's own table, read with no call to the books, the one source kept while off. An invoiced
buy-out not yet paid stays owed in the books, and the portal stops showing it.

**On again.** Choosing QuickBooks on Integrations sets `plugins.on` and opens its setup at Connect. The same company
picks up its links and figures where they were; the next money run reads them fresh. A different company is the
switch, with today's ask and clear. A family added while off has no link and shows on Accounting links to be linked.

**On for the first time** (a club that started with none): QuickBooks' setup, then Accounting links' import, as for a
new installation today. Families made in the portal are matched by email, as the screen already does.

## 6. Migration for a club already on QuickBooks

One migration sets `plugins.on` to `["quickbooks"]` on every existing installation where setup is finished. A new
installation starts with it empty. That is the whole data change: no table is renamed, no row moved. The code moves,
and the requests do not.

**Nothing they see changes.** Same pages at the same addresses, same menu, same words on QuickBooks' own screens,
same jobs at the same times, same audit actions. Setup is finished there, so they never see the new step. The only
new things are on Integrations: the Accounting lede in neutral words, and the "Turn off" button on QuickBooks' page.

Proven by: the full browser run unchanged on the seeded QuickBooks club; the writes tripwire; the sandbox check;
`tests/integration/plugin-migration.test.ts` (a database as today, migrated, then every page and job compared).

## 7. Slices

Each is one pull request, screen-sized, with its tests. Order matters: the frame first, then each core screen made
to stand alone, then the move, then the two screens that change.

| # | Slice | Proves |
|---|---|---|
| P1 | **The frame.** `src/plugins/index.ts`, `types.ts`, the QuickBooks manifest declaring what exists today (pages, jobs, permissions, audit actions, tables), `plugins.on` and its migration, `pluginOn()`, `requirePluginPage()`, the boundary test with today's crossings listed. | Nothing changes for a club. Every table has one owner; every permission and action has words. |
| P2 | **Core records stand alone.** `RECORDS_LOCK` in the core; the shape out of core decisions; Families with no active student always offered; add a family and a student with no books (`families.howToAdd`, core default). | With accounting off, staff can run the roster by hand, every action audited. With QuickBooks on, adding goes the way it goes today. |
| P3 | **Staff slots.** `staff.menu`, `staff.homeLines`, `staff.familyPanels`, jobs and Health from the manifest. Balances, Reconciliation and Accounting links fill them. | Off: those pages answer `notFound()`, the menu and hubs leave them out, the jobs don't run. On: as today. |
| P4 | **Parent slots.** `parent.tabs`, `parent.homeCards`, `parent.contactSaved`; the "as of" line goes with the money box. | Off: no money anywhere a parent looks. The isolation and parent e2e runs pass on and off. |
| P5 | **Seasons and volunteering.** The payment kind's source, the buy-out offer and paid buy-outs' credit through their slots. | Off: no buy-out offered; paid buy-outs still count. On: the payment kind as today. |
| P5b | **Payments by hand.** `payments.byHand`; the requirement's optional amount; the Mark paid Drawer, its bulk form and its undo, audited; parents' paid or owed; "Don't track payments" hiding them. | Both settings, a parent of family A never sees B's mark or any note, and a mark counts toward the step. |
| P6 | **Events.** `records.events` from every core save; QuickBooks' handlers queue what the roster writes and the contact queue queue now. | The writes tripwire holds: the same requests, in the same order, from the same saves. |
| P7 | **The move.** The code into `src/plugins/quickbooks/`, in two or three pull requests by area, the lists in `page-guards.test.ts` and AGENTS.md moved with it. | The boundary test's list is empty. Full CI green with no test changed but its imports. |
| P8 | **The two screens.** Setup's "Your books" step with the payments choice; Integrations' Accounting kind in neutral words, with the choice while none is on; `Settings.Integrations.ReadWrite`. | A new club finishes setup without QuickBooks, either way of payments. The mock's words, at 390 and 1440. |
| P9 | **Off and on.** `canTurnOff()`, the ConfirmDialog with the payments choice, the carry-over (each family the books last showed as paid marked paid, note "Paid in QuickBooks", one audit row of counts), the disconnect, turning on again with the same or a different company. | Off keeps every core record and every link; with payments by hand, a family that paid in QuickBooks reads paid the moment it is off; on again with the same company shows the same figures. |
| P10 | **The documents.** AGENTS.md (the plugin rules and checklist), the area documents' paths, `PRODUCT.md`'s terms, `docs/agents/ui.md`, the first-install runbook with no accounting, `docs/conformance.md`, the roadmap. | A builder can add the next plugin from AGENTS.md alone. |

P1 to P7 change nothing a club sees, with QuickBooks on. P5b, P8 and P9 are the ones the owner sees. Following the
owner's "fewer, bigger PRs", P1 to P2, P3 to P5 and P8 to P9 may each go as one pull request.

## 8. Tests that hold it

- `tests/unit/plugin-boundary.test.ts`: the core imports only `src/plugins/index.ts` and `types.ts`.
- `tests/unit/plugin-manifest.test.ts`: every installed plugin's permissions have words and an area; its actions
  have words; its pages call `requirePluginPage()`; its tables exist, and each table has one owner.
- `tests/integration/plugin-off.test.ts`: with accounting off, every plugin page answers `notFound()`, no plugin
  job runs, no slot draws but paid buy-outs' credit, and no request leaves the portal (the QuickBooks client is replaced and must not be called).
- `tests/integration/parent-isolation.test.ts` and `page-guards.test.ts`: run with accounting on and off.
- `tests/e2e/no-accounting.spec.ts`: setup with "No accounting system", a family added by hand, a parent signing
  in and signing a form, at 390 and 1440.
- The writes tripwire and the sandbox check: unchanged requests.

## 9. Not in this change

A second accounting package; plugins of other kinds (the slot list makes room, nothing more); plugins loaded at run
time or from outside the release; more than one accounting system on at once; staff raising other invoices; a
different order for adding a family with QuickBooks on (it stays the books first).

## 10. The owner's answers (2026-11-28)

1. Turning QuickBooks off keeps its links and figures; turning it on again with the same company picks up where it
   left off. A different company runs today's switch and clear. **Yes, as recommended.**
2. With no accounting system, the Admin chooses "Track payments by hand" or "Don't track payments" (section 2a), in
   setup and when accounting is turned off. **Changed from the recommendation**, which was to pause them.
3. "Your books" is its own setup step before First Admin, with No accounting system the default, offering QuickBooks,
   or none with the payments choice. **Yes, as recommended.**

4. When QuickBooks is turned off with "Track payments by hand", every family the books last showed as paid is marked
   paid at once, in the turn-off's transaction (section 5). **Yes, carry over, as recommended.**

He then approved the spec and the mock (2026-11-28).
