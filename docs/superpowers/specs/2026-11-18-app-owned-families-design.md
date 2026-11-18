# The app owns families and logins — design

**Status:** proposed on 2026-11-18, awaiting the owner's review. Nothing in it is built. When approved it overrides the
specs it names below. It goes into AGENTS.md's list of specs only once the owner approves it.
**Overrides, once approved:** in the v1 spec, §4 (who owns families and students), §5.2, §6 (roster management) and
the parts of §12 that name QuickBooks ids; in `2026-11-10-quickbooks-connection-and-roster-design.md`, the cache as
the roster (§2) and the read-only roster pages (§5); in `2026-11-11-parents-from-quickbooks-design.md`, §1 to §6 (who
gets access, the reconcile, held addresses, the match review); in
`2026-11-10-parent-email-code-sign-in-design.md`, only where a sign-in is tied to a family's QuickBooks ID.
PRODUCT.md's terms and its third principle ("QuickBooks is the truth") would need the owner's own new words.
**Builds on:** everything built for v1 on `parent-portal` (merged to `main` at `8f3e513`).

Words used here. A **guardian** is a person who signs in (the code calls this record a *parent*). A guardian's place
in one family is a **membership** (the code's *guardian* row). A **link** ties an app record to a customer in the
accounting system. **QuickBooks** is the accounting system the club uses today; **the accounting system** means
whichever one is connected.

---

## 1. Why

The owner, on 2026-11-18:

> "I want to reverse the decision that QB is the source of families. That makes it so that we can't integrate with
> other accounting software easily in the future. I believe we need to switch to the app owning families and logins
> and changing QuickBooks to be the source of payments. I still want to link them together but this may need to move
> to a simple mapping screen where it defaults to suggesting on mapping by email address but an admin with rights
> needs to match."

What changes, in one paragraph: the portal keeps its own families, students and guardians, with its own ids, and
decides who can sign in from them. QuickBooks stays the record for invoices, payments, balances and products. Each
family is tied to its QuickBooks customer by a link an admin confirms on a mapping screen, which suggests matches by
email address. A change made in the app is saved in the app and then sent on to QuickBooks, so QuickBooks stays in
step. Everything the portal records about a family (seasons, volunteering, forms, buy-outs) points at the app's ids,
so connecting a different company no longer wipes it.

## 2. What stays true

### The privacy rules, as they read once the family is the app's own id

| Rule today | Once this is built |
|---|---|
| The family comes only from the session (`ctx.familyQboId`). | The family comes only from the session, and it is the app's family id. An id from the URL, a form or an action argument is untrusted: it is looked up within that family, and anything else is `notFound()` or refused. |
| Staff-only query modules are never imported by parent code. | The same list, plus the new modules that read every family or every customer: the import, the mapping screen, the differences. They join `STAFF_ONLY_IMPORTS`. |
| Anything stored against a QuickBooks id means another customer in another company, and is deleted when a different company is connected. | QuickBooks ids live only in links and money records (and in QuickBooks' own copies: the customer list, the product list, the queue, the check's records). Each of those names its company and is never used for another. Switching company clears the links and the money cache. Everything keyed by the app's ids stays (buy-outs and queued writes, which hold both: Open questions, 8). |
| Signed-form evidence is never deleted. | Still never deleted. It is no longer cut from its request on a change of company, because the request no longer names a QuickBooks id. |
| QuickBooks text is rendered as text only. | The same, and it still applies after the import copies a name into the app: names, emails and memos are text wherever they came from. |
| A client component is passed only what it shows. | Unchanged. A link's customer id never reaches the browser on a parent page. |
| A guard refusal says the same thing whatever the reason. | Unchanged. An unlinked family's money words are the same whatever the reason the family isn't linked. |

### The money rules that must survive

- **Never the wrong company.** No live read unless the accounting system is connected to the company the link was
  made in; a stored money row from another company is treated as absent.
- **Answers are read strictly.** An empty answer is acted on, so only a well-formed one with no rows means no rows.
  This matters more now: an empty customer list would mark every link's customer as gone, so it is never believed
  over a list that held customers (as `no_customers` does for the roster today).
- **Integer cents everywhere,** converted once where an amount comes in and formatted only by `formatMoney`.
- **A parent page never waits on the connection.** Its reads pass `failFast` and never queue for the connection row.
- Nothing in a request selects a customer: a family's customers come from its links, read for the session's family.

### Audit

Every write is audited in the same transaction. Every link and unlink is audited. A staff read of one family's or one
person's data is audited before it is shown. A parent viewing their own family is not. Every new action gets words in
`ACTION_NAMES`.

## 3. Who owns what, and the link

| | Owned by | Notes |
|---|---|---|
| Families, students, guardians | The app | Each with the app's own id. Sign-in emails live on guardians. A guardian can belong to more than one family. |
| Memberships (which guardian is in which family) | The app | Only staff add a guardian to a family. |
| Invoices, payments, balances, products | The accounting system | Read as today, and kept in a cache (the money records). |
| Links | The app | One per linked family, and, where the books have them, one per linked student and parent record. |
| Seasons, volunteering, forms, buy-outs | The app | They point at the app's ids. |

**A link** ties a family to its accounting customer. Where the books have them (as this club's do), each student and
parent also links to their own record under it. Each link records the accounting system and company, who confirmed
it and when. A customer can be linked to only one family. QuickBooks ids live only in links and money records.
Switching accounting company clears the links and the money cache, and nothing else.

Where the code makes this harder than it reads:

- **The portal knows three kinds of books.** Layered books with a parent type (this club's: a Family customer with
  Student and Parent customers under it) fit the piece exactly. In layered books with no parent type, a guardian has
  no record of their own: their address is one of several in the family customer's email field. In flat books each
  member customer is a family of one, with no students. The links are designed for all three: a parent's link exists
  only where a parent record does.
- **A parent's link belongs to a membership, not to the person.** A guardian in two families has a Parent customer
  under each family in QuickBooks. So their one sign-in email in the app is sent to two records, and a difference can
  show on one and not the other.
- **The app does not hold phones or mailing addresses today.** A parent's address is read from QuickBooks when the
  edit page opens. For the app to own contact details it must start storing them (Open questions, 9).

## 4. Starting: import or by hand, and the mapping screen

The owner:

> "import once and staff maintain"

> "groups should have the option to skip import if they choose to and just manually maintain membership. we still
> want to tie the portal and the accounting software together."

### Two ways to start

- **Import, once, if the club wants it.** The app reads the customers and proposes families with their students and
  guardians, using the customer types as it does today (the membership shape). An admin reviews the list before
  anything is saved. Families made this way are linked from the start. An address that appears under two families
  becomes one guardian who belongs to both *(proposed: the review list shows it)*.
- **By hand.** Staff add families, students and guardians in the app. These families start unlinked.

After either, staff maintain the families in the app. The import is not run again over existing families; a single
customer can still be brought in later (below).

### The mapping screen

It follows the pattern of the integration mapping screens the owner uses in Rewst. The owner, on the bulk button:

> "no your change is exactly what I had in mind. It's very similar to the integration mapping screens that I use in
> Rewst".

Details below marked *(proposed)* are the spec's, not the owner's.

**A row** is one family. It shows the family's name, its guardians' emails, the suggested or linked customer's name
and email, and a status. A row opens to show the family's students and guardians and their own links.

**Statuses** *(proposed)*:

| Status | Means |
|---|---|
| Suggested | One customer's email exactly matches one of this family's guardians. The suggestion is filled in. |
| Several possible | More than one customer matches. Nothing is filled in. |
| No match | No customer's email matches. |
| Linked | Confirmed, and the app and the accounting system agree. |
| Linked, with differences | Confirmed, and something differs (section 5). |
| Customer gone | The linked customer is no longer in the accounting system's answer (Open questions, 3). |
| Left unlinked | An admin chose to leave it. It stays out of the bulk button. |

An exact match is the same address once trimmed and lower-cased *(proposed)*. A customer counts as matching when its
own email field holds the address, or a parent record under it does.

**Filters:** by status, and a search by family name or email *(the filters themselves proposed)*.

**For each row** an admin with the linking permission can:

- **Confirm** the suggestion.
- **Pick a different customer** from a search of customers not yet linked to any family.
- **Create a new customer in QuickBooks** for this family.
- **Leave it unlinked.**

**Confirm all exact email matches.** The button is shown only once the admin has the list in front of them. It
confirms every row whose status is Suggested *(proposed: only rows the current filter shows, with the count on the
button, refused and reloaded if the list changed since it was shown, as the held-address decisions are today)*.

**Customers with no family.** Customers in the accounting system that no family is linked to are listed in their own
part of the screen, each with **Create a family from this**, so one family can be brought in later without a full
import.

**Differences** are listed on the same screen (section 5).

**An unlinked family** has everything except money: no invoices, no Pay button, no buy-out offer, and words saying
the club hasn't connected their payments yet *(proposed: "The club hasn't connected your payments to the portal
yet.")*. *(Proposed:)* a payment requirement reads as it does with no invoice.

**The permission.** Linking takes a new permission that a role such as treasurer can hold (name and first holders:
Open questions, 1). Every link and unlink is in the audit log.

**Audit actions** *(names proposed)*:

| What happened | Action |
|---|---|
| An import reviewed and saved, with counts | `accounting.import.save` |
| A link confirmed, one or in bulk (one row per link, plus one for the bulk press with its count) | `accounting.link.confirm`, `accounting.link.bulk` |
| A link removed | `accounting.link.remove` |
| A customer created for a family from the mapping screen | `accounting.customer.create` |
| A family made from a customer | `accounting.family.from_customer` |
| A difference aligned, either way | `accounting.difference.send`, `accounting.difference.take` |
| The links cleared by a change of company, with counts | `accounting.links.cleared` |

## 5. Keeping the two in step

The owner, on what happens when the app and QuickBooks disagree:

> "app wins, show the difference, and provide a way to align them"

### Changes made in the app

A change made in the app to a linked person is saved in the app first, then sent to QuickBooks. That covers a name,
phone, address or email; a new student or guardian; a student moved to another family; someone made inactive. If
QuickBooks can't be reached, the change waits in the existing write queue and the app says so. A change to an
unlinked family stays in the app.

The lead's reading, which the owner did not correct: the direction of each change flips. Today QuickBooks is changed
first and the app follows its answer. In the new setup the app's record changes first and the change is then sent on.

Where the code makes this harder than it reads:

- **"Nothing is overwritten" has to be kept another way.** Today every write carries the version (SyncToken) the
  staff member was shown, and a stale one is answered with QuickBooks' current values. Once the app changes first,
  the send carries the version the app last read. If QuickBooks changed since, it refuses, and that becomes a
  difference to align, never an overwrite.
- **Staff editing phones, addresses and emails is new.** Today only a parent can change their own phone, address and
  email, and only from their own pages; staff pages say these are changed in QuickBooks. Sending staff edits uses the
  same requests from new callers, which changes the QuickBooks writes tripwire test on purpose.
- **A new guardian in books with no parent type** has no record to create: their address is added to the family's
  email field, the only place QuickBooks has for it.
- **A move made directly in QuickBooks** is followed today by the next roster read, which moves the student's forms,
  places and buy-outs. In the new setup it is a difference. The follow-ups run when the move is made in the app,
  either by staff or by "take QuickBooks' into the app".

### The balance rule

The owner, on 2026-11-17: "anyone with a balance can't be made inactive. That balance has to be paid or written off".

Before anyone linked is made inactive, the app reads what they owe in the accounting system and refuses if there is
a balance. An unlinked family has no balance to check. Because the app now saves first, the read must come before the
app's own change; what happens when it can't be read is Open questions, 4.

### Differences

At each daily read, and on demand, the app compares its copy with QuickBooks' and lists what differs on the mapping
screen, showing both values. This covers an edit made directly in QuickBooks and a change QuickBooks refused. For each
one an admin chooses **Send the app's to QuickBooks** or **Take QuickBooks' into the app**, and there is a bulk
**Send the app's for all**.

What is compared *(proposed)*: for each link, the name, whether it is active, the family it is under, and, for a
guardian's or a family's record, the email, phone and mailing address. For a guardian in two families, each record is
compared on its own.

The daily read is today's roster refresh. It keeps reading every customer into the cache, but the cache is no longer
the roster: it feeds the import, the mapping screen and the differences. Nobody's sign-in changes because of what it
reads.

## 6. Logins

- A guardian's sign-in email is the app's record.
- Staff add a guardian to a family with a name and email, and the parent signs in with the emailed code as today.
- A parent changes their own email in the app with the same confirm-by-link step, and the app then sends it on to
  QuickBooks.
- Sign-in no longer comes and goes with what QuickBooks holds: a guardian can sign in while they are an active
  guardian of an active family in the app. Blocking stays.
- The review step for an email that appears under two families in QuickBooks goes away: one guardian can simply
  belong to both families.
- Only staff add guardians. A parent cannot invite a second guardian.

What leaves with this: the reconcile that turned QuickBooks records into sign-ins, held addresses and their review,
the clean-up preview's dry run, and the previous-company snapshot and match review, which exist only to carry those
over a change of company. The parent sign-in and welcome switches, sign-in codes, sessions, the family chooser and
welcome emails are not named as retired and stay; whether the switches still need QuickBooks connected is Open
questions, 10.

## 7. Money, and the accounting interface

The owner:

> "We should ensure for QB that we're maintaining the ability to do all of the account updates, invoice creation, etc
> from the app and will determine what is capable for other software in the future"

The lead's reading, which the owner did not correct: "invoice creation" means what the app creates today, the buy-out
invoice. Staff raising other invoices from the app is not part of this change.

### Money

A family sees the invoices of the records linked to it and nothing else: its own customer plus its linked students
and parents. An unlinked family sees none. Payment requirements and buy-outs work as they do now, against the linked
records. The money reads, the daily read of every family, the cache rules, the Pay link check and the balance
cross-check are kept; only where the list of a family's customers comes from changes (its links, not the customer
tree).

One consequence: today a student moved in QuickBooks takes their invoices to the new family at the next read. With
links, a student moved in the app takes them at once, even while the move waits to be sent.

### The accounting interface

One small interface per accounting system. One accounting connection at a time, as now.

| Every system must be able to | Each system declares whether it can |
|---|---|
| Connect (and disconnect) | Create a customer |
| List customers (for import, mapping and differences) | Update a name |
| Read a customer's invoices, balance and Pay links | Update contact details |
| List products | Move a record |
| | Make it inactive |
| | Create an invoice |
| | Void one |

The app offers a button only when the connected system declares that ability. QuickBooks declares everything it does
today:

| Ability | QuickBooks request today |
|---|---|
| Create a customer | The customer create (a family, a student or parent under it, or a member) |
| Update a name | The sparse rename |
| Update contact details | The phone and address update, and the email field update |
| Move a record | The change of parent |
| Make it inactive | The sparse update of Active, after the balance read |
| Create an invoice | The buy-out invoice create |
| Void one | The buy-out invoice void, after the live read |

The customer types and the membership shape are QuickBooks' own settings, used by its import and its creates.

**The check of the portal's requests** stays, as QuickBooks' own self-test, on the QuickBooks settings page, with its
sandbox-only writes and its own records.

**Setup** changes so a club can start with no accounting system connected at all (stage 5). Such a club has families,
sign-ins, seasons, forms and volunteering, and no money.

## 8. What becomes of what exists

### Every table that holds a QuickBooks id

Seventeen tables hold one as a record of their own; eight more places in the schema hold one too, listed after them.

| Table | Holds today | What becomes of each QuickBooks id |
|---|---|---|
| `guardian` | A person's link to a family: `family_qbo_id`, and `source_qbo_id`, the record the sign-in came from | Becomes the membership: `family_qbo_id` gives way to the app's family id. `source_qbo_id` moves into a link. The closing reasons that come from QuickBooks (held, no email, address changed, not in QuickBooks, company changed) are retired. |
| `parent_email_change` | `family_qbo_id`, and `record_qbo_id`, the record the change would write | The family becomes the app's id. The record id goes: the send looks up the guardian's links when it sends. |
| `family_match` | An old company's family id matched to a new one's | Retired: links replace it. Its decisions are in the audit log. |
| `qbo_customer` | The roster cache | Stays as QuickBooks' customer list, for import, mapping, differences and money. No longer the roster. |
| `family_money` | One family's figures, keyed by `family_qbo_id`, with `realm_id` | Keyed by the app's family id; the invoices inside still name their customers. Cleared on a change of company. |
| `write_queue` | `realm_id`, `target_qbo_id`, `family_qbo_id`, and the ids in each request | The family becomes the app's id; the request also names the app record it is for. The customer ids stay: they are what is sent. A change of company: Open questions, 8. |
| `requirement` | `item_qbo_id`, the product a payment is met by or a buy-out billed with | Stays a QuickBooks id (a product, a money reference). Cleared on a change of company, as today (Open questions, 8). |
| `requirement_cover` | `subject_qbo_id`, a chosen family or student | Becomes the app's family or student id. |
| `requirement_progress` | `subject_qbo_id`, a tick or waiver's subject | Becomes the app's id. |
| `requirement_reminder` | `family_qbo_id` | Becomes the app's id. |
| `volunteer_signup` | `family_qbo_id`, `student_qbo_id` | Both become the app's ids. |
| `volunteer_credit` | `family_qbo_id`, `student_qbo_id` | Both become the app's ids. |
| `volunteer_reminder` | `family_qbo_id`, and the family inside `key` | Becomes the app's id; new keys use it, and old claims age out. |
| `buyout` | `family_qbo_id`, `subject_qbo_id`; `customer_qbo_id`, `item_qbo_id`, `invoice_qbo_id`, `realm_id` | The family and subject become the app's ids. The customer, item, invoice and company stay: a buy-out is a money record. A change of company: Open questions, 8. |
| `signature_request` | `family_qbo_id`, `subject_qbo_id` | Both become the app's ids. No longer deleted on a change of company (nor its consents). |
| `signed_form_evidence` | `family_qbo_id`, `subject_qbo_id`, `realm_id` | Gains the app's ids beside the old ones, which stay as copies of the record as it was. Never deleted. No longer cut from its request on a change of company. Rows already in the "Earlier company" archive stay there. |
| `audit_log` | QuickBooks ids in `target_id`, `before` and `after` | Old rows are never rewritten: the log is append-only. New rows name the app's ids, and a link's QuickBooks id in its own rows. Finding a record's older rows: Open questions, 7. |
| `held_address` | Family ids under one address | Retired with the two-family review. |
| `parent_auth_session` | `family_qbo_id`, the family a session chose | Becomes the app's family id, in the same step as `ctx` (stage 3). |
| `qbo_customer_type` | QuickBooks' customer types | Stays, QuickBooks' own. |
| `qbo_item` | QuickBooks' products | Stays; cleared on a change of company. |
| `qbo_connection`, `qbo_check_run`, `qbo_check_record` | The company, and the check's runs and records | Stay, QuickBooks' own. |
| `setting` | The membership shape (type ids), the roster's company, the money run's place, the previous-company snapshot | The shape and the company stay as QuickBooks settings; the money run's place stays a money record; the snapshot is retired. |

`signature_consent`, `signed_form_copy` and the form reminder claims hold no QuickBooks id; they stop being deleted
with their requests on a change of company.

### Areas of code

| Kept as they are | Changed | Retired |
|---|---|---|
| Every QuickBooks request in the client, and the write queue's retries | The guards and the session: the family is the app's id | The reconcile and its rules (logins from QuickBooks) |
| The check of the portal's requests | The parent's family read: from the app's records | Held addresses, their review and its notices |
| The money reads, the daily read of every family, the Pay link check | Whose invoices a family sees: from its links | The previous-company snapshot and the match review |
| Buy-outs, their daily check and closing | The staff Families pages: they edit the app's records | The clean-up preview's dry run |
| All the season, volunteer and forms logic | The roster writes: the app first, then sent on | Following QuickBooks moves at each read |
| Sign-in codes, sessions, the chooser, welcome emails | The roster read: it fills the cache and finds differences | QuickBooks' customer list acting as the roster |
| The privacy tests, re-pointed at the app's ids | A parent's contact and email changes: the app first | The "changed in QuickBooks" notes on staff pages |
| | A change of company: clears links and the money cache | |
| | Setup and settings: an accounting system is optional | |
| | Each re-keyed area (stage 2) | |

### Documents that will need rewriting

- **AGENTS.md:** the opening paragraph; the privacy rules on the session's family and on QuickBooks ids; Money's
  whose-invoices rule; Writes to QuickBooks (the direction, the staff writes, the parent writes, the email change);
  the Seasons rule on the roster lock; the Forms rule on evidence and a change of company; Volunteering's moved
  student; the test helpers' ids; the tripwire list.
- **PRODUCT.md:** the terms ("family (a QuickBooks customer)", "student (a sub-customer)"), the positioning, the
  capabilities line and the third principle, in the owner's words.
- **Specs:** the parts this one overrides (head of this file) each gain a "Changed since" line.
- **docs/conformance.md:** the rows of §6.1 to §6.3, §8.2's whose-invoices row, §9.4's company-change row, §12, and
  the parents-from-QuickBooks rows.
- **Runbooks:** reconnecting QuickBooks, first install (starting with no accounting system), Health warnings (the
  roster line), and the walkthrough's roster and sign-in journeys.
- **The owner's runbook** (`before-the-first-family.md`): meanwhile, real phones (part 3), the Documenso
  installation (part 4) and Intuit's assessment (part 5) can carry on. The sandbox journeys about roster changes wait,
  since each changes in this design: part 1's checks 18 to 25 (sign-ins from QuickBooks, a change of company) and,
  in part 2, a parent's details, the email change, a staff change that waits, a student moved in QuickBooks and
  making a family inactive (checks 4, 7, 8, 9 and 12). Connecting the real books (part 6) waits too, and parts 7 and
  8 come after it as they do now. The owner has not said either way about the rest of part 2 (the payment and
  buy-out journeys).

## 9. The stages

Each is shippable and tested on GitHub's CI. No club runs them one by one: the first club is not installed yet, so
the in-between states matter on the proof-of-concept host and in CI.

Migration rules from AGENTS.md apply throughout: new migrations start at `0023`; only one agent at a time adds them;
never a rename in one step (an additive migration, then a finishing one); never edit an applied one.

### Stage 1: app ids and links

- **True when done:** new family and student records with the app's ids exist, and the membership rows point at
  them, filled from what is cached today, each with its link. Until stage 3, QuickBooks is still the source: every
  roster read, roster write and reconcile keeps these records and links in step, so they never drift.
- **Users see:** nothing changes.
- **Guarded by:** a test that each cached family, student and open sign-in has exactly one app record and one link;
  the cleanup tripwire (new tables named); the audit-rows tripwire.
- **Not half done:** every QuickBooks id any record holds must map to an app record, including customers QuickBooks
  no longer returns (Open questions, 6).

### Stage 2: re-key one area at a time

- **True when done:** seasons, volunteering, forms and kept evidence, buy-outs, reminders, the money cache and the
  audit log point at the app's ids. A company switch stops wiping them.
- **Users see:** nothing changes.
- **Guarded by:** for each area, in the same change, the isolation tests re-pointed (family A with family B's app ids
  in every field), the staff-only import scan, and the company-change test rewritten to prove the area is kept.
- **Not half done:** an area moves in one go: its additive migration, its code, its tests, then its finishing
  migration. Until stage 3 the session still names the family's QuickBooks id: a re-keyed area's parent query finds
  the app's family through that family's own link, and returns that family alone. Signed-form evidence is never
  deleted at any point, and its QuickBooks ids are kept as copies. A company
  switch in the middle of these stages: Open questions, 11.

### Stage 3: move the source

- **True when done:** the staff Families pages edit the app's records and send changes on to QuickBooks. Logins come
  from the app. The session carries the app's family id.
- **Users see:** staff add guardians and edit contact details in the portal; QuickBooks edits no longer change who
  can sign in. Parents see nothing new.
- **Guarded by:** the QuickBooks writes tripwire, changed on purpose for the new callers; the page guards and the
  isolation tests; the parent-session browser test; a test that the same people can sign in to the same families
  before and after.
- **Not half done:** `ctx`'s family id, the session row and every parent query change in one release; a session that
  can't be carried over is ended. A change QuickBooks refuses shows on Reconciliation until stage 4 lists it as a
  difference.

### Stage 4: the mapping screen

- **True when done:** the optional import, suggestions, bulk confirm, differences with align, and customers with no
  family. A change of company clears links and the money cache, and the families come back through the screen.
- **Users see:** the mapping screen, for those who hold the linking permission. An unlinked family's money words.
- **Guarded by:** a test that a confirm by family A's admin can't link a customer already linked to family B; tests
  for each status and action; the audit-actions tripwire; the staff-pages browser test.
- **Not half done:** the retired pieces (reconcile, held addresses, match review) leave in this stage or the one
  before, never while something still reads them.

### Stage 5: the accounting interface

- **True when done:** the interface is drawn around the QuickBooks code, each ability declared, buttons shown by
  ability; setup lets a club start with no accounting system connected.
- **Users see:** a club can finish setup without QuickBooks.
- **Guarded by:** the QuickBooks writes tripwire (unchanged requests); the check of the portal's requests; a test of
  the pages with nothing connected and with an ability switched off.
- **Not half done:** no second accounting system is built. QuickBooks' requests and bodies do not change.

## 10. Not in this change

- A spreadsheet import.
- Parents registering themselves, or a parent inviting a second guardian.
- More than one accounting system at once.
- Staff raising other invoices from the app.
- A second accounting system: the interface makes room for one; which abilities another system has is for later.

## 11. Open questions for the owner

| # | Question | Recommendation | Why |
|---|---|---|---|
| 1 | The linking permission's name, and which roles hold it at first. | `Accounting.Link.ReadWrite`, held by Admin; grantable to a custom role such as Treasurer; not Admin-only. Aligning a difference takes it too. | Your words: "a role such as treasurer can hold". Aligning changes QuickBooks or the app's record of a linked person, which is the same trust. |
| 2 | May "Take QuickBooks' into the app" change a sign-in email, and what is the guardian told? | Only through the confirm-by-link step: the app mails a link to the address QuickBooks holds, and the old address keeps working until the guardian confirms; the old address gets a notice. | Anyone with QuickBooks access can type an email; taken straight in, it would hand someone's sign-in to whoever typed it. |
| 3 | What a link does when its customer is made inactive, merged or deleted in QuickBooks. | Inactive: a difference, the link kept. Gone from QuickBooks' answer (a merge or a delete): the row reads "Customer gone", the link's money is hidden, and an admin picks again. Never relinked by itself. | A link decides whose invoices a family sees; only an admin should change that. |
| 4 | The balance rule when the balance can't be read, and credits. | Refuse to make a linked person inactive while what they owe can't be read. Refuse on any balance, owed or credit. | The app now saves first; queuing would leave the app saying inactive while QuickBooks says no. QuickBooks refuses a credit too (6220), so stopping only amounts owed would leave a difference every time. |
| 5 | What happens to a change QuickBooks refuses after the app has saved it, beyond showing the difference. | The app keeps its value ("app wins"); the staff member is told at once when the refusal comes while they wait; the difference carries QuickBooks' reason in words (a taken name offers "Name (2)"). | Undoing the app's change would make QuickBooks the winner by the back door. |
| 6 | How the import reads customer types for flat books, and records that name a customer QuickBooks no longer returns. | Flat: each member is a family of one with one guardian (the first address on it) and no students. Layered with no parent type: one guardian per address in the family's field. A customer missing from the answer becomes an inactive app record, named from what the portal last knew. | It is what the membership shape means today. Kept records (evidence, waivers) must keep pointing at something. |
| 7 | Finding a record's audit rows from before stage 2. | Never rewrite old rows. The audit page's "this record" filter also looks for the QuickBooks ids that the record's link rows name. | The log is append-only, and staff still need a family's whole history. |
| 8 | What a change of company does to buy-outs, queued writes and payment requirements' products. | Paid buy-outs keep counting. Unpaid live ones end ("earlier company"), so the family can choose again, and are listed for the treasurer. Queued writes for the old company are given up, never sent. Products are cleared, as today. | Your words clear "the links and the money cache, and nothing else", but each of these holds another company's invoice, customer or product id, so something must be decided for them. Ending (not deleting) keeps the family's history. |
| 9 | Where phone and mailing address live in the app. | On the guardian, sent to each record linked to them. In books with no parent type, the family has its own address, sent to the family record. | Today the address isn't kept at all; one person, one set of details, matches "sign-in emails live on guardians". |
| 10 | The parent sign-in switches and the "no active students, no access" setting. | Keep both switches, no longer needing QuickBooks connected; keep the setting, read from the app's students. | Nothing you said retires them, and they are how an Admin decides the club is ready to email families. |
| 11 | A change of company between stages 2 and 4. | Refuse connecting a different company from stage 2 until stage 4 ships (reconnecting the same one still works). | Until stage 4 there is no screen to link families again, and until stage 3 sign-ins still come from QuickBooks. |
| 12 | What linking does at the moment it is confirmed, including "create a new customer". | Confirming sends nothing; any differences are listed at once. "Create a new customer" makes the family's record and, where the books have the types, one for each active student and guardian, then links them all. A confirmed family's students and guardians are matched within its customer only (students by name, guardians by email), with the rest shown for the admin. | Nothing reaches QuickBooks that an admin didn't ask for. |
| 13 | What the data on the proof-of-concept host becomes. | Let stage 1 carry it over, after a backup, as it would any club's; test the import on a fresh database beside it. | It is the only installed data, so it is the best test of stage 1. |

## 12. Risks

| Risk | How the stages contain it |
|---|---|
| A record re-keyed to the wrong family shows one family another's data. | Stage 1 proves one app record and one link per QuickBooks id before anything reads them. Each area in stage 2 moves with its isolation tests in the same change. |
| A wrong link shows a family another's invoices. | Links are confirmed by an admin (import is reviewed first); one customer, one family; bulk confirm takes only exact matches the admin has on screen; every link is audited. |
| App wins overwrites what the treasurer changed in QuickBooks. | Every send carries the version the app last read; a refusal becomes a difference. Only an admin's "Send the app's" overwrites, and it is audited. |
| A guardian is locked out, or the wrong person let in, when logins move. | Stage 1 builds memberships from today's open sign-ins exactly; stage 3 proves the same people sign in to the same families before and after. |
| Signed-form evidence is lost or detached. | It is never deleted; its QuickBooks ids stay as copies; finishing migrations never drop them. |
| A person with a balance is made inactive. | The balance read comes before the app's own change, and a balance that can't be read refuses (Open questions, 4). |
| Half-built states on a running installation. | No club runs the stages one by one; each ships whole on CI; a change of company is refused between stages 2 and 4 (Open questions, 11). |
| The interface grows to fit systems nobody has asked for. | Stage 5 draws it around QuickBooks only, with abilities declared; no second system is built. |
| A family's history in the audit log is hard to find after re-keying. | Old rows are kept as they are and found through the link rows (Open questions, 7). |
