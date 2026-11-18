# The app owns families and logins — design

**Status:** proposed on 2026-11-18, awaiting the owner's review. Nothing in it is built. When approved it overrides the
specs it names below. It goes into AGENTS.md's list of specs only once the owner approves it.
**Overrides, once approved:** in the v1 spec, §4 (who owns families and students), §5.2, §6 (roster management),
§8.2 (whose invoices a family sees), §11.5 where a buy-out's customer is read from the roster cache, and the parts of
§12 that name QuickBooks ids; in `2026-11-10-quickbooks-connection-and-roster-design.md`, the cache as the roster (§2)
and the read-only roster pages (§5); in `2026-11-11-parents-from-quickbooks-design.md`, §1 to §6 (who gets access, the
reconcile, held addresses, the match review); in `2026-11-10-parent-email-code-sign-in-design.md`, only where a sign-in
is tied to a family's QuickBooks ID.
**Builds on:** everything built for v1 on `parent-portal` (merged to `main` at `8f3e513`).

Words used here. A **guardian** is a person who signs in (the code's *parent*). A guardian's place in one family is a
**membership** (the code's *guardian* row). A **link** ties an app record to a customer in the accounting system.
**The accounting system** is whichever one is connected; today, QuickBooks. *(Proposed)* marks this spec's own
details; "the lead's reading" marks what the lead said in the design conversation and the owner did not correct. The
detail a builder needs is in the appendices.

---

## 1. Why

The owner, on 2026-11-18:

> "I want to reverse the decision that QB is the source of families. That makes it so that we can't integrate with
> other accounting software easily in the future. I believe we need to switch to the app owning families and logins
> and changing QuickBooks to be the source of payments. I still want to link them together but this may need to move
> to a simple mapping screen where it defaults to suggesting on mapping by email address but an admin with rights
> needs to match."

He then approved the design as the lead laid it out in six pieces ("3 and 4 look good", and "write it up" after 5
and 6). Sections 3 to 9 follow them.

In one paragraph: the portal keeps its own families, students and guardians, with its own ids, and decides from them
who can sign in. QuickBooks stays the record for invoices, payments, balances and products. Each family is tied to its
QuickBooks customer by a link an admin confirms on a mapping screen, which suggests matches by email address. A change
made in the app is saved in the app, then sent on to QuickBooks. Seasons, volunteering, forms and buy-outs point at
the app's ids, so connecting a different company no longer wipes them.

## 2. What stays true

**The privacy rules**, as they read once the family is the app's own id:

- **The family comes only from the signed-in session,** and it is now the app's family id. An id in an address, a
  form or a button is untrusted: it is looked up within that family, and anything else is "not found" or refused.
- **Code that reads every family never runs for a parent's page.** A test checks this; the new code that reads every
  family or customer (the import, the mapping screen, the differences) joins its list.
- **A QuickBooks id is never used for another company.** Today everything stored against one is deleted when a
  different company is connected. Now QuickBooks ids live only in links, money records and the few places section 3
  lists, each naming its company. What is keyed by the app's ids stays.
- **Signed-form evidence is never deleted.** Only the current company's evidence is given the app's ids. Evidence
  already in the "Earlier company" archive gets no app family, stays for staff only, and is never matched to a family
  by a QuickBooks number.
- **Names, emails and memos are shown as text only,** wherever they came from.
- **A page sends the browser only what it shows.** A link's customer id never reaches a parent's browser.
- **A refusal says the same thing whatever the reason.** An unlinked family's money words do not say why.
- **Unchanged:** staff notes stay for staff; the offline page is the only thing kept on a phone; family data is never
  cached; no secret reaches the browser. Any reason an admin writes on the mapping screen is for staff only. Each
  accounting system's credentials are sealed, as QuickBooks' are.

**The money rules:** never the wrong company (no live read unless the accounting system is connected to the company
the link was made in); answers read strictly (only a well-formed empty answer means "none", and an empty customer list
is never believed over one that held customers); whole cents everywhere, shown by the one money formatter; a parent's
page never waits for the connection; nothing in a request chooses a customer.

**Audit:** every write is audited in the same transaction, every link and unlink too. A staff read of one family or
person is audited before it is shown; a parent viewing their own family is not.

## 3. Who owns what, and the link

| | Owned by |
|---|---|
| Families, students, guardians, each with the app's own id; sign-in emails, on guardians | The app |
| Memberships (a guardian can belong to more than one family; only staff add one) | The app |
| Links | The app |
| Seasons, volunteering, forms, buy-outs (they point at the app's ids) | The app |
| Invoices, payments, balances, products (read as today, kept in the money cache) | The accounting system |

**A link** ties a family to its accounting customer and, where the books have them (as this club's do), each student
and parent to their own record under it. Each link records the accounting system and company, who confirmed it and
when. A customer can be linked to only one family. The owner's piece: "QuickBooks ids live only in links and money
records", and switching company "clears the links and the money cache, and nothing else". So a change of company no
longer touches sign-ins, sessions, welcomes or the sign-in switches; today it ends every session and switches sign-ins
and welcomes off. What it still has to clear is listed in Open questions, 16.

**Where QuickBooks ids still appear.** "Only in links and money records" leaves no room for these, which the code
needs (Open questions, 5): signed-form evidence (the record as signed); the audit log (old rows are never rewritten);
a payment requirement's product; the queue's waiting requests (what is to be sent); the check's sandbox records; and
QuickBooks' own copies (its customer list, customer types, membership shape and products).

**Phones and addresses.** The app keeps only a copy of the phone QuickBooks holds, and no mailing address: a parent's
address is read from QuickBooks when the edit page opens. To own them the app must start storing them (Open
questions, 6).

The three kinds of books the portal knows, and a guardian in two families, make links less simple than they read
(Appendix B).

## 4. Starting, and the mapping screen

The owner: "import once and staff maintain"; and "groups should have the option to skip import if they choose to and
just manually maintain membership. we still want to tie the portal and the accounting software together."

- **Import, once, if the club wants it.** The app reads the customers and proposes families with their students and
  guardians, using the customer types as today. An admin reviews the list before anything is saved. Families made
  this way are linked from the start. *(Proposed:)* an address under two families becomes one guardian in both, shown
  in the review. Flat books: Open questions, 4.
- **By hand.** Staff add families, students and guardians in the app. These start unlinked.

After either, staff maintain families in the app; the import is not run again. A club already running starts from
the links stage 1 carries over (Open questions, 2).

### The mapping screen

The owner, on the "confirm all exact email matches" button: "no your change is exactly what I had in mind. It's very
similar to the integration mapping screens that I use in Rewst". As in those: one row per family, the suggested
customer already filled in, a status on each row, filters, and bulk confirm.

**A row** shows the family, its guardians' emails, the suggested or linked customer's name and email, and a status.
It opens to show the students and guardians and their own links.

**Statuses** *(proposed)*: Suggested (one customer's email exactly matches a guardian's; filled in); Several possible
(nothing filled in); No match; Linked; Carried over (from stage 1, Open questions, 2); Linked, with differences;
Customer gone (Open questions, 13); Left unlinked (kept out of the bulk button).

*(Proposed:)* an exact match is the same address once trimmed and lower-cased. The suggestion is always the
family-level customer: the family's record, or the member in flat books. A match on a parent record suggests the
family above it, and the parent record is linked under it.

**Filters** *(proposed)*: by status, and a search by name or email.

**For each row** an admin with the linking permission can **confirm** the suggestion, **pick a different customer**
(from those not linked to any family), **create a new customer in QuickBooks**, or **leave it unlinked**. What
confirming does to the students and guardians: Open questions, 3.

**Confirm all exact email matches** is shown only once the admin has the list in front of them, and confirms every
Suggested row *(proposed: only rows the current filter shows, with the count on the button, refused and shown again
if the list changed)*.

**Customers with no family** are listed in their own part of the screen, each with **Create a family from this**, so
one family can be brought in later without a full import. **Differences** are listed here too (section 5).

**An unlinked family** has everything except money: no invoices, no Pay button, no buy-out offer, and words saying the
club hasn't connected their payments yet *(proposed: "The club hasn't connected your payments to the portal yet.")*.

**The permission** is a new one a role such as treasurer can hold (Open questions, 1). Every link, unlink, import and
alignment is audited (proposed rows: Appendix A).

## 5. Keeping the two in step

The owner: "app wins, show the difference, and provide a way to align them".

**Changes made in the app.** A change to a linked person is saved in the app first, then sent to QuickBooks: a name,
phone, address or email; a new student or guardian; a student moved to another family; someone made inactive. If
QuickBooks can't be reached, the change waits in the existing queue and the app says so. A change to an unlinked
family stays in the app. The lead's reading: the direction flips. Today QuickBooks changes first and the app follows
its answer; now the app's record changes first and the change is sent on.

Open for the owner: a staff member changing a guardian's sign-in email (Open questions, 8); a new guardian in books
with no record for one (7); a change QuickBooks refuses after the app saved it (10); and making someone inactive,
where the recommendation departs from this piece (11).

**The balance rule.** The owner, on 2026-11-17: "anyone with a balance can't be made inactive. That balance has to be
paid or written off". Before anyone linked is made inactive, the app reads what they owe and refuses if there is a
balance. An unlinked family has no balance to check.

**A move made in QuickBooks is no longer followed.** Today the next roster read follows it: the student's forms and
volunteer places go with them, and the daily buy-out check deals with their buy-outs. Now the student stays where the
app has them, and the move shows as a difference; the follow-ups run only when the move is made in the app. The
lead's reading: this follows from "app wins" and from retiring the customer list as the roster.

**Differences.** At each daily read, and on demand, the app compares its copy with QuickBooks' and lists what differs
on the mapping screen, with both values. This covers an edit made in QuickBooks and a change QuickBooks refused. For
each, an admin chooses **Send the app's to QuickBooks** or **Take QuickBooks' into the app**; there is a bulk **Send
the app's for all**. *(Proposed:)* compared for each link are the name, whether it is active, the family it is under,
and for a guardian's or family's record the email, phone and address. Making a customer active again is not a write
the portal has (Open questions, 12); taking a sign-in email from QuickBooks is Open questions, 9.

The daily read is today's roster refresh. Its customer list is no longer the roster: it feeds the import, the mapping
screen and the differences. Nobody's sign-in changes because of what it reads.

## 6. Logins

- A guardian's sign-in email is the app's record.
- Staff add a guardian to a family with a name and email; the parent signs in with the emailed code as today.
- A parent changes their own email in the app with the same confirm-by-link step; the app then sends it on.
- A guardian can sign in while they are an active guardian of an active family in the app, whatever QuickBooks holds.
  Blocking stays.
- The review for an email under two families goes away: one guardian simply belongs to both.
- Only staff add guardians. A parent cannot invite a second guardian.

**What leaves.** The owner retired deriving logins from QuickBooks and the two-family review. The lead's reading is
that what only serves them goes too: held addresses, the clean-up preview's dry run, and the previous-company snapshot
and match review. Sign-in codes, sessions, the family chooser and welcome emails stay; the sign-in switches are Open
questions, 15.

## 7. Money, and the accounting interface

The owner: "We should ensure for QB that we're maintaining the ability to do all of the account updates, invoice
creation, etc from the app and will determine what is capable for other software in the future". The lead's reading:
"invoice creation" means what the app creates today, the buy-out invoice; staff raising other invoices is not part of
this change.

**Money.** A family sees the invoices of the records linked to it and nothing else: its own customer and its active
linked students and parents, and only while the family is active, as today. An unlinked family sees none. Payment
requirements and buy-outs work as now, against the linked records. The money reads, the daily read, the cache rules,
the Pay link check and the balance cross-check are kept; only the list of a family's customers changes, from the
customer tree to its links. When a moved student's invoices follow them: Open questions, 14.

**The accounting interface.** One small interface per accounting system; one connection at a time, as now.

| Every system must be able to | Each system declares whether it can |
|---|---|
| Connect *(proposed: and disconnect)* | Create a customer |
| List customers (for import, mapping and differences) | Update a name or contact details |
| Read a customer's invoices, balance and Pay links | Move a record |
| List products | Make it inactive; create an invoice; void one |

The app offers a button only when the connected system declares that ability. QuickBooks declares everything it does
today: the customer create, the rename, the phone and address update and the email field update, the change of parent,
making inactive after the balance read, and the buy-out invoice's create and void. Its customer types and membership
shape stay its own settings. **The check of the portal's requests** stays as QuickBooks' own self-test.

**Setup** lets a club start with no accounting system at all (stage 5): families, sign-ins, seasons, forms and
volunteering, and no money.

## 8. What becomes of what exists

Appendix A has every table that holds a QuickBooks id and what becomes of each id, the areas of code kept, changed
and retired, and the documents that will need rewriting. In short, each id moves to the app's ids, stays as a money
record or one of QuickBooks' own copies, or leaves with the two-family review and the match review. PRODUCT.md's
terms ("a family (a QuickBooks customer)", "a student (a sub-customer)") and positioning would need the owner's own
new words; its third principle, "QuickBooks is the truth", still holds for the books.

**The owner's runbook, meanwhile.** Real phones (part 3), the Documenso installation (part 4) and Intuit's assessment
(part 5) can carry on. The sandbox journeys about roster changes wait: part 1's step 8 (the proof of concept's checks
18 to 25, sign-ins from QuickBooks and a change of company), and part 2's checks 4, 7, 8, 9 and 12 (a parent's details, the email change, a staff change that waits, a student moved in QuickBooks,
making a family inactive). Connecting the real books (part 6) waits, with parts 7 and 8 after it. The owner has not
said about the rest of part 2 (payments and buy-outs).

## 9. The stages

Each ships whole and is tested on GitHub's CI. No club is installed yet, so the in-between states matter on the
proof-of-concept host and in CI; a club that installs before stage 4 runs each stage in turn, so each must hold on its
own. The migration rules in AGENTS.md apply: new migrations from `0023`, one agent at a time, never a rename in one
step (an additive migration, then a finishing one), never an applied one edited. What guards each stage, and the
builder's detail, are in Appendix C.

**Stage 1: app ids and links.**
- *Done:* family and student records with the app's ids, and memberships pointing at them, filled from today's cache,
  each with its link (Open questions, 2). Until stage 3 QuickBooks is still the source, and every roster read, write
  and reconcile keeps them in step. A change of company clears or rebuilds them in the same transaction as today's
  clear, and every lookup through a link names the connected company.
- *Users see:* nothing.
- *Not half done:* every QuickBooks id a current-company record holds maps to an app record, including customers
  QuickBooks no longer returns (Open questions, 4). Archived evidence of an earlier company maps to nothing. The test
  seeds make app records and links for both test families, so later tests have something to find.

**Stage 2: re-key one area at a time:** seasons, volunteering, forms and the current company's evidence, buy-outs,
reminders, the money cache.
- *Done:* each points at the app's ids. New audit rows name the app's ids; old rows stay as written (Open questions,
  17). A company switch would no longer wipe them; until stage 4 a different company is refused (Open questions, 18).
- *Users see:* nothing.
- *Not half done:* an area moves in one go, with its isolation tests, whose must-show checks cover that area's own
  data so an empty page fails. The areas read each other, so until both sides
  of a read have moved it goes through the link, and the two kinds of id are kept apart in the code so they can't be
  compared by mistake. Reminder claims are carried over, so none goes twice.

**Stage 3: move the source.**
- *Done:* the staff Families pages edit the app's records and send changes on. Logins come from the app; the session
  carries the app's family id. New families and customers added in QuickBooks: Open questions, 19.
- *Users see:* staff add guardians and edit contact details in the portal; QuickBooks edits no longer change who can
  sign in, and a student moved in QuickBooks no longer takes their forms and places along. Parents see nothing new.
- *Not half done:* the session's family id and every parent query change in one release; a session that can't be
  carried over is ended. A refused change shows on Reconciliation until stage 4.

**Stage 4: the mapping screen.**
- *Done:* the optional import, suggestions, bulk confirm, differences and align, customers with no family. A change of
  company clears links and the money cache; families are linked again on the screen.
- *Users see:* the mapping screen, for holders of the linking permission; an unlinked family's money words.
- *Not half done:* the retired pieces leave in this stage or the one before, never while something still reads them.

**Stage 5: the accounting interface.**
- *Done:* the interface drawn around the QuickBooks code, abilities declared, buttons shown by ability; setup without
  an accounting system.
- *Users see:* a club can finish setup without QuickBooks.
- *Not half done:* no second system is built; QuickBooks' requests do not change.

## 10. Not in this change

A spreadsheet import; parents registering themselves or inviting a second guardian; more than one accounting system at
once; staff raising other invoices; a second accounting system (the interface only makes room for one).

## 11. Open questions for the owner

| # | Question | Recommendation | Why |
|---|---|---|---|
| 1 | The linking permission's name, and who holds it at first. | "Link families to accounting": Admin at first, grantable to a custom role such as Treasurer, not Admin-only. Aligning a difference takes it too. | Your words: "a role such as treasurer can hold". Aligning is the same trust. |
| 2 | Do the links stage 1 carries over from today's roster count as confirmed? | Yes, recorded as "carried over from the roster" on its date with no person named, with their own status and filter so an admin can review them. | They are exactly today's QuickBooks tree, which already decides whose invoices a family sees. |
| 3 | What confirming a family's link does. | It sends nothing. Each student and parent link proposed under the family is shown in the row and confirmed with it; a name or email match only fills in the suggestion. "Create a new customer" makes the family's record and, where the books have the types, one per active student and guardian, linked. | You said an admin must match; two students with the same name could be linked the wrong way round. |
| 4 | How the import reads flat books, and records naming a customer QuickBooks no longer returns. | Flat: each member is a family of one, one guardian (the first address), no students. No parent type: one guardian per address in the family's email field. A missing customer becomes an inactive app record, named from what the portal last knew. | It is what the membership shape means today; kept records must point at something. |
| 5 | May QuickBooks ids stay in the places section 3 lists? | Yes, as stated exceptions, each naming its company and cleared on a change of company, except evidence and the audit log: never deleted, never matched to a family by a number. | Each holds what was signed, sent or recorded; dropping the id loses the record. |
| 6 | Where phone and address live in the app. | On the guardian, sent to each record linked to them; in books with no parent type, on the family, sent to its record. | One person, one set of details, as with sign-in emails. |
| 7 | A new guardian in books with no parent type: is their address added to the family's email field in QuickBooks? | Yes, with the email field update used today for a parent's own change, which refuses a field over 100 characters; past that, the guardian is added in the app only and the difference shown. | It is the only place those books have; but it is a new use of that write. |
| 8 | May staff change a guardian's sign-in email? | Only by the confirm-by-link step: the link to the new address, a notice to the old one, which works until confirmed; audited. | Unconfirmed, it hands the sign-in to whoever owns the new address. |
| 9 | May "Take QuickBooks' into the app" change a sign-in email, and what is the guardian told? | Only by the same confirm-by-link step, to the address QuickBooks holds, with a notice to the old one. | Anyone with QuickBooks access can type an email. |
| 10 | A change QuickBooks refuses after the app saved it. | The app keeps its value; a waiting staff member is told at once; the difference gives QuickBooks' reason in words (a taken name offers "Name (2)"). | Undoing it would make QuickBooks win by the back door. |
| 11 | Making someone inactive. | This departs from piece 3 for this one change. Refuse, rather than queue, while the balance can't be read. Mark a person inactive in the app only once QuickBooks has taken it. A send cut off after the balance read waits in the queue ("being made inactive"); the queue reads the balance again before sending, as today, and a new balance stops it: the person stays active and Reconciliation says who owes. A family keeps today's order (everyone under it first, the family last, never queued, stopping at the first refusal), so both sides agree part way. Refuse on any balance, owed or credit. | Saving first would leave the app saying inactive while QuickBooks says no, against your rule. QuickBooks refuses a credit too. |
| 12 | May "Send the app's" make a customer active again? | Not in this change. Where QuickBooks shows inactive, only "Take QuickBooks' into the app" is offered, and the bulk button passes it over. | The portal has never sent that write; it isn't among your abilities, and the writes test would have to name it. |
| 13 | A linked customer made inactive, merged or deleted in QuickBooks. | Inactive: a difference, link kept. Gone: "Customer gone", its money hidden, an admin picks again. Never relinked by itself. | A link decides whose invoices a family sees. |
| 14 | A student moved in the app: do their invoices follow at once, or once QuickBooks takes the move? | Once QuickBooks takes it. | Until then QuickBooks bills them under the old family, and the balance cross-check would disagree. |
| 15 | The sign-in switches and the "no active students, no access" setting. | Keep both, no longer needing QuickBooks connected; read the setting from the app's students. | Nothing you said retires them; they are how an Admin says the club is ready. |
| 16 | What a change of company still clears beyond links and the money cache. | QuickBooks' own copies: the customer list and types, the membership shape, products and each payment requirement's product, the check's records, the roster's company and run history, the money run's place. Queued requests for the old company are given up. Paid buy-outs keep counting; unpaid live ones end ("earlier company") and are listed for the treasurer. Not touched, as your "nothing else" says: sign-ins, sessions, welcomes, the sign-in switches, email changes, seasons, volunteering, forms. | Each names another company's customer, product or invoice; ending a buy-out keeps the history. |
| 17 | Finding a record's audit rows from before stage 2. | Never rewrite old rows; the audit page's record filter also looks for the QuickBooks ids the record's link rows name. | The log is append-only. |
| 18 | A change of company between stages. | Refuse a different company from stage 2 until stage 4 ships; reconnecting the same one works. Stage 1 needs no refusal: its clear still wipes everything. | Until stage 4 there is no screen to link families again. |
| 19 | Stage 3 on its own: a new family, and a customer added in QuickBooks. | Bring two pieces forward: a family staff add while QuickBooks is connected is created there too and linked, as confirmed by that staff member if they hold the linking permission (unlinked otherwise); and Reconciliation lists customers with no family, with "Create a family from this". Otherwise ship stages 3 and 4 together. | Today a new family has money at once; without these, stage 3 leaves new families without money and QuickBooks' new customers with no way in. |
| 20 | The data on the proof-of-concept host. | Let stage 1 carry it over, after a backup; test the import on a fresh database beside it. | It is the only installed data: the best test of stage 1. |

## 12. Risks

| Risk | How the stages contain it |
|---|---|
| A record re-keyed to the wrong family shows another's data. | Stage 1 proves one app record and link per QuickBooks id before anything reads them; each area moves with its isolation tests. |
| The tests pass on an empty page. | The seeds make app records and links from stage 1; each area's must-show checks cover its data. |
| Mid-stage 2, an app id is compared with a QuickBooks id, matches nothing, and a waiver, credit or paid buy-out stops counting; or a reminder goes twice. | The two kinds of id differ in the code; cross-area reads translate through the link; claims are carried over. |
| Archived evidence attaches to a current family with the same number. | Only current-company evidence gets app ids; a test proves it after every stage. |
| A wrong link shows a family another's invoices. | An admin confirms each link; one customer, one family; bulk takes only exact matches on screen; all audited. |
| "App wins" overwrites the treasurer's edit in QuickBooks. | Sends carry the version the app last read; a refusal becomes a difference; only an admin's "Send the app's" overwrites, audited. |
| A guardian is locked out, or the wrong person let in. | Memberships are built from today's open sign-ins; stage 3 proves the same people sign in to the same families. |
| A person with a balance is made inactive. | The balance is read first, and QuickBooks takes the change before the app does (Open questions, 11). |
| Stage 3 leaves new families without money. | Open questions, 19. |
| The interface grows for systems nobody asked for. | Stage 5 draws it around QuickBooks only. |

---

## Appendix A: for the builder

### Every table that holds a QuickBooks id

Seventeen tables hold one as a record of their own; eight more hold one too, listed after them.

| Table | Holds today | What becomes of each QuickBooks id |
|---|---|---|
| `guardian` | A person's place in a family: `family_qbo_id`, and `source_qbo_id`, the record the sign-in came from (null for one made by hand) | Becomes the membership: `family_qbo_id` gives way to the app's family id. `source_qbo_id` moves into a link. The closing reasons that come from QuickBooks (held, no email, address changed, not in QuickBooks, company changed) go with the reconcile. |
| `parent_email_change` | `family_qbo_id`, and `record_qbo_id`, the record the change would write | The family becomes the app's id. The record id goes: the send looks up the guardian's links when it sends. No longer deleted on a change of company. |
| `family_match` | An old company's family id matched to a new one's | Retired with the match review (the lead's reading). Its decisions are in the audit log. |
| `qbo_customer` | The roster cache, with each customer's email and phone | Stays as QuickBooks' customer list, for import, mapping, differences and money. No longer the roster. Cleared on a change of company (Open questions, 16). |
| `family_money` | One family's figures, keyed by `family_qbo_id`, with `realm_id` | Keyed by the app's family id; the invoices inside still name their customers. Cleared on a change of company. |
| `write_queue` | `realm_id`, `target_qbo_id`, `family_qbo_id`, and the ids in each request | The family becomes the app's id; the item also names the app record it is for. The customer ids stay: they are what is sent. Old company's items given up (Open questions, 16). |
| `requirement` | `item_qbo_id`, the product a payment is met by or a buy-out billed with | Stays a QuickBooks id (Open questions, 5). Cleared on a change of company, as today. |
| `requirement_cover` | `subject_qbo_id`, a chosen family or student | Becomes the app's family or student id. |
| `requirement_progress` | `subject_qbo_id`, a tick or waiver's subject | Becomes the app's id. |
| `requirement_reminder` | `family_qbo_id` | Becomes the app's id; claims carried over in the finishing migration. |
| `volunteer_signup` | `family_qbo_id`, `student_qbo_id` | Both become the app's ids. |
| `volunteer_credit` | `family_qbo_id`, `student_qbo_id` | Both become the app's ids. |
| `volunteer_reminder` | `family_qbo_id`, and the family inside `key` | Becomes the app's id, and each claim's key is rewritten in the finishing migration, so no reminder goes twice. |
| `buyout` | `family_qbo_id`, `subject_qbo_id`; `customer_qbo_id`, `item_qbo_id`, `invoice_qbo_id`, `realm_id` | The family and subject become the app's ids. The customer, item, invoice and company stay: a buy-out is a money record. A change of company: Open questions, 16. |
| `signature_request` | `family_qbo_id`, `subject_qbo_id` | Both become the app's ids. No longer deleted on a change of company. |
| `signed_form_evidence` | `family_qbo_id`, `subject_qbo_id`, `realm_id`, `earlier_company_at` | Rows with no `earlier_company_at`, whose `realm_id` is the cache's company, gain the app's ids beside the old ones, which stay as copies. Archive rows get no app family, stay staff-only, and are never matched by a QuickBooks id. Never deleted. No longer cut from its request on a change of company. |
| `audit_log` | QuickBooks ids in `target_id`, `before` and `after` | Old rows are never rewritten. New rows name the app's ids, and a link's QuickBooks id in its own rows (Open questions, 17). |
| `held_address` | Family ids under one address | Retired with the two-family review. |
| `parent_auth_session` | `family_qbo_id`, the family a session chose | Becomes the app's family id, in the same release as the guards (stage 3). |
| `qbo_customer_type` | QuickBooks' customer types | Stays, QuickBooks' own; cleared on a change of company. |
| `qbo_item` | QuickBooks' products | Stays; cleared on a change of company. |
| `qbo_connection`, `qbo_check_run`, `qbo_check_record` | The company, and the check's runs and records | Stay, QuickBooks' own; the check's records cleared on a change of company, as today. |
| `setting` | The membership shape, the roster's company, the money run's place, the parent switches, the previous-company snapshot | The shape and the company stay as QuickBooks settings and the money run's place as a money record, all cleared on a change of company; the parent switches are no longer touched by one; the snapshot is retired (the lead's reading). |

Consents, and the form reminder claims and rounds, stop being deleted on a change of company; the signed-form copies
were already kept.

### Areas of code

Retired items not among the owner's three ("deriving logins from QuickBooks", "the two-family review step",
"QuickBooks' customer list acting as the roster") are the lead's reading.

| Kept as they are | Changed | Retired |
|---|---|---|
| Every QuickBooks request in the client, and the write queue's retries | The guards and the session: the family is the app's id | The reconcile and its rules (logins from QuickBooks) |
| The check of the portal's requests | The parent's family read: from the app's records | Held addresses and the two-family review |
| The money reads, the daily read of every family, the Pay link check | Whose invoices a family sees: from its links | QuickBooks' customer list acting as the roster |
| Buy-outs, their daily check and closing | The staff Families pages: they edit the app's records | The previous-company snapshot and the match review (lead's reading) |
| All the season, volunteer and forms logic | The roster writes: the app first, then sent on | The clean-up preview's dry run (lead's reading) |
| Sign-in codes, sessions, the chooser, welcome emails | The roster read: it fills the customer list and finds differences | Following QuickBooks moves at each read (lead's reading) |
| The privacy tests, re-pointed at the app's ids | A parent's contact and email changes: the app first | The "changed in QuickBooks" notes on staff pages (lead's reading) |
| | A change of company: clears links, the money cache and QuickBooks' copies | |
| | Setup and settings: an accounting system is optional | |
| | Each re-keyed area (stage 2) | |

### Audit actions *(names proposed)*

| What happened | Action |
|---|---|
| A stage-1 link carried over from the roster (one row per run, with counts) | `accounting.link.carried_over` |
| An import reviewed and saved, with counts | `accounting.import.save` |
| A link confirmed, one or in bulk (one row per link, plus one for the bulk press with its count) | `accounting.link.confirm`, `accounting.link.bulk` |
| A link removed | `accounting.link.remove` |
| A customer created for a family from the mapping screen | `accounting.customer.create` |
| A family made from a customer | `accounting.family.from_customer` |
| A difference aligned, either way | `accounting.difference.send`, `accounting.difference.take` |
| The links cleared by a change of company, with counts | `accounting.links.cleared` |

### Documents that will need rewriting once approved

- **AGENTS.md:** the opening paragraph; the privacy rules on the session's family and on QuickBooks ids; Money's
  whose-invoices rule; Writes to QuickBooks (the direction, the staff writes, the parent writes, the email change);
  Seasons' roster lock; Forms' evidence on a change of company; Volunteering's moved student; the test helpers' ids;
  the tripwire list.
- **PRODUCT.md:** the terms, the positioning and the capabilities line, in the owner's words.
- **Specs:** each part this one overrides (head of this file) gains a "Changed since" line.
- **docs/conformance.md:** the rows of v1 §6.1 to §6.3, §8.2 (whose invoices), §9.4's company-change row, §11.5's
  billing target, §12, and the parents-from-QuickBooks rows.
- **Runbooks:** reconnecting QuickBooks, first install (starting with no accounting system), Health warnings (the
  roster line), the owner's runbook as section 8 says, and the walkthrough's roster and sign-in journeys.

## Appendix B: where the code makes this harder than it reads

- **The portal knows three kinds of books.** Layered books with a parent type (this club's: a Family customer with
  Student and Parent customers under it) fit piece 1 exactly. In layered books with no parent type, a guardian has no
  record of their own: their address is one of several in the family customer's email field. In flat books each
  member customer is a family of one, with no students. A parent's link exists only where a parent record does.
- **A parent's link belongs to a membership, not to the person.** A guardian in two families has a Parent customer
  under each in QuickBooks, so their one sign-in email is sent to two records, and a difference can show on one and
  not the other.
- **"Nothing is overwritten" has to be kept another way.** Today every write carries the version (QuickBooks'
  SyncToken) the staff member was shown, and a stale one is answered with QuickBooks' current values. Once the app
  changes first, the send carries the version the app last read; if QuickBooks changed since, it refuses, and that
  becomes a difference, never an overwrite.
- **Staff editing phones, addresses and emails is new.** Today only a parent changes their own, from their own pages;
  staff pages say these are changed in QuickBooks. Sending staff edits uses the same requests from new callers, which
  changes the QuickBooks writes tripwire test on purpose.
- **A move made in QuickBooks is followed today** by the next roster read, which moves the student's forms and places;
  the daily buy-out check deals with their buy-outs. That following ends (section 5).
- **Making someone inactive is QuickBooks first today,** with the balance read before the send and again by the queue
  before a waiting one is sent. Open questions, 11 keeps that order for this one change.
- **A change of company today does more than clear ids:** it closes every sign-in, ends sessions, deletes unused
  codes and email change requests, clears "already welcomed" and switches sign-ins and welcomes off, then keeps a
  snapshot for the match review. Under this design none of that happens.

## Appendix C: the stages, for the builder

**Stage 1.**
- *Guarded by:* a test that each cached family and student has one app record and one link, each open sign-in one
  membership, and each record a sign-in came from one link (a sign-in made by hand, or one in books with no parent
  type, has no record of its own and so no link); `seedTwoFamilies()` and `scripts/seed-e2e.ts` making app records and
  links for both families; a test that seeds archived evidence (`earlier_company_at` set) whose `family_qbo_id` equals
  a current family's and proves no parent of that family sees it, kept and run again after every stage; the clean-up
  and audit-rows tripwires (new tables named).
- *Detail:* `clearRosterOfOtherCompanyLocked()` clears or rebuilds the new tables inside its own transaction. Every
  lookup through a link filters on the connected company's `realm_id`. Only evidence with no `earlier_company_at` and
  the cache's `realm_id` is mapped.

**Stage 2.**
- *Guarded by:* per area, in the same change: `parent-isolation.test.ts` and the action tests re-pointed (family A with
  family B's app ids in every field), with must-show checks covering that area's own data, so an empty page fails
  rather than passing as "shows nothing of B"; the `STAFF_ONLY_IMPORTS` scan; `company-change-step5.test.ts` rewritten
  to prove the area is kept; the archived-evidence test.
- *Detail:* each area is its additive migration, its code, its tests, then its finishing migration. The app's ids get
  their own branded type, distinct from a QuickBooks id's, so comparing the two fails the typecheck. The reads that
  cross areas are `loadFamilyStanding()` (ticks, waivers, forms, credit, buy-outs, money), `allocateFamilies()`
  (waivers and buy-outs) and `afterStudentMoved()` (forms, places, buy-outs): until both sides of one have moved, it
  translates through the link, within the connected company. The `requirement_reminder` and `volunteer_reminder`
  claims, including the family inside `volunteer_reminder.key`, are rewritten in the finishing migration, not left to
  age out. Until stage 3 the session still holds `ctx.familyQboId`, and a moved area's parent query finds the app's
  family through that family's own link and returns that family alone.

**Stage 3.**
- *Guarded by:* `tests/unit/quickbooks-writes.test.ts`, changed on purpose for the new callers; `page-guards` and
  `parent-isolation`; `parent-session.spec.ts`; a test that the same people sign in to the same families before and
  after.
- *Detail:* `ctx.familyQboId` becomes the app's family id, with `parent_auth_session` and every parent query, in one
  release.

**Stage 4.**
- *Guarded by:* a test that no confirm links a customer already linked to another family; tests for each status and
  action; the audit-actions tripwire; `staff-pages.spec.ts`.
- *Detail:* the reconcile, held addresses and the match review leave here or in stage 3.

**Stage 5.**
- *Guarded by:* the QuickBooks writes tripwire (requests unchanged); the check of the portal's requests; tests of the
  pages with nothing connected and with an ability switched off.
