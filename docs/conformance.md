# Does the portal do what the specs say?

**Checked:** 2026-11-16, on the branch `slice/conform` (step 7 of `docs/superpowers/plans/2026-11-07-v1-roadmap.md`),
then brought up to date when step 7's four slices were merged on `parent-portal` the same day, and again when step
8's six were merged (2026-11-17).
**Against:** `docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md` (the v1 spec), as the later specs in that
folder override it (`2026-11-10-parent-email-code-sign-in-design.md`, `2026-11-10-quickbooks-connection-and-roster-design.md`,
`2026-11-11-parents-from-quickbooks-design.md`, `2026-11-15-documenso-verification.md`, and for setup
`2026-11-08-first-run-setup-design.md`) and as the owner's decisions of 2026-11-14 (roadmap) change it.

One row per requirement. **Built** means code and a test that would fail without it. **Partly built** means code with
no test, or a test that covers only part. **Missing** means no code. **Changed** and **Dropped** mean a later spec or the
owner deliberately changed or removed it; the row names the source. Paths are from the repository root; a test is named
by its file and the start of its title. "Owner check" means only a real company, phone or host can settle it (the
roadmap's checks table). For every request the portal sends QuickBooks, that owner check is now one page: Settings,
QuickBooks, **Check the portal's requests** (`/staff/settings/quickbooks/check`, `src/lib/quickbooks/sandbox-check/`,
`tests/integration/quickbooks-check.test.ts`), run by an Admin against an Intuit sandbox company.

## Counts

| Section | Built | Partly built | Missing | Changed or dropped |
|---|---|---|---|---|
| §2 In v1 | 10 | 0 | 0 | 0 |
| §6 Roster management | 15 | 0 | 0 | 6 |
| §8 Money | 24 | 0 | 0 | 0 |
| §9 Forms | 23 | 0 | 0 | 2 |
| §10 Seasons | 17 | 1 | 0 | 0 |
| §11 Volunteering | 26 | 0 | 0 | 0 |
| §12 Privacy invariants | 9 | 0 | 0 | 0 |
| §13 Audit log | 10 | 1 | 0 | 0 |
| §14 Operations | 9 | 3 | 0 | 2 |
| Owner's decisions of 2026-11-14 | 5 | 0 | 0 | 0 |
| **All** | **148** | **5** | **0** | **10** |

Nothing the specs ask for is missing outright. The five partly built rows, and what each lacks, are listed at the foot
of this page with a rough size; the changes the step made are under "Fixed in this step", and the roadmap's Known gaps
are checked one by one after that.

## §2 In v1

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 2.1 | Parent and staff sign-in | Parents sign in with the portal's own emailed code (email-code spec), not Entra External ID; staff by Microsoft or Google | Built | `src/lib/auth/`; `tests/integration/parent-door.test.ts`, `signin-codes.test.ts`, `providers.test.ts`, `tests/e2e/parent-sign-in.spec.ts` |
| 2.2 | Family roster managed in the portal, stored in QuickBooks | The membership shape decides what a family is (QuickBooks spec §1); staff create, rename, move and make inactive from the roster pages (parents spec as changed by step 5). Since stage 3's sixth slice the roster pages list the app's own family and student records, with what QuickBooks holds joined from the roster cache, and the staff season, volunteering and forms pages read the app's active families (`loadSeasonFamilies()`) | Built | §6 below; `roster-queries.test.ts` "rosterFamilies: the app's family records, each with what QuickBooks holds for its customer, in the roster's order"; `season-families.test.ts` |
| 2.3 | Balance, open invoices, a Pay link per invoice | | Built | §8.2 below |
| 2.4 | Parent contact edits written back to QuickBooks | Owner decision 3: phone and address of the parent's own record; email by confirmed link | Built | §6.2 below |
| 2.5 | Commitment forms signed in Documenso, with completion tracking | Owner decision 2; the Documenso verification corrects §9 | Built | §9 below |
| 2.6 | Season steps with four kinds of requirement, shown as the ruler | | Built | §10 below |
| 2.7 | Volunteer sign-up, reminders, check-in, credit, buy-outs | | Built | §11 below |
| 2.8 | Permissions for staff | | Built | `src/lib/permissions/`; `tests/unit/permissions/rules.test.ts`, `registry.test.ts`, `tests/integration/roles.test.ts`, `roles-checklist.test.ts` |
| 2.9 | Audit log | | Built | §13 below |
| 2.10 | Setup flow, deployment image, backup and restore, QuickBooks runbooks | Setup spec; owner decision 6 (no host name in code) | Built | `src/app/setup/`, `deploy/`, `scripts/backup.sh`, `scripts/restore.sh`, `docs/runbooks/`; `tests/integration/setup-finish.test.ts`, `setup-club.test.ts`, `backup-restore.test.ts`, `tests/unit/deploy-names-no-host.test.ts`, `runbooks.test.ts`, `tests/e2e/setup.spec.ts` |

## §6 Roster management

### §6.1 Staff operations

All of these go to QuickBooks first, and the cache and the app's own record follow QuickBooks' answer (`src/lib/roster/writes.ts`, under the roster lock). Since stage 3's slice 9c of the app-owned families spec each write changes its own record itself (`changeOwnRecord()`: a new family, member or student's record and its link, `created` by the staff member who asked; a name; a student's family; an inactive flag; a Parent customer none), audited as `appRecord` on the write's row, and one QuickBooks took that the portal couldn't take in waits on the queue marked sent, so the found-done path makes the same change: `roster-writes.test.ts` "each write QuickBooks took changes the app's own record too", `roster-queue.test.ts` "a family staff made that the portal couldn't take in" and "a move staff made that the portal couldn't take in". Nothing made, renamed, moved or made inactive in QuickBooks changes a record (`app-records.test.ts` "the records stand alone").

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 6.1.1 | Create family: Customer create | A customer of the shape's family type (or a flat member of a chosen member type) | Built | `tests/integration/roster-writes.test.ts` "makes a family: a customer of the family type"; flat in "flat with several member types" |
| 6.1.2 | Create family: add the primary guardian, provision sign-in | Since stage 3's slice 7a of the app-owned families spec nothing makes a sign-in from QuickBooks: a Parent sub-customer staff add there gets none. Since slice 7b staff add a guardian to a family in the portal, by name and address (`src/lib/parents/guardians.ts`, `Roster.Family.ReadWrite`, the permission that changes a family: the lead's choice, for the owner to confirm): one address is one person, and an address someone holds already is added only after staff are shown who that is and press again; the membership is an invited row in the family's record; nothing is sent to QuickBooks until the source move, and a family with no link takes nobody until then | Changed | `tests/integration/roster-writes.test.ts` "adds a parent with their own email address, billed apart; the portal makes them no sign-in from it"; `tests/integration/staff-guardians.test.ts` "makes the person, their sign-in account and an invited row naming the family record and its customer, in step, audited", "an address someone holds changes nothing at the first press: staff are shown who it is; the second press, naming them, adds them under their own name", "adding, removing and reinstating take Roster.Family.ReadWrite, never Parents.ReadWrite alone; a name takes Parents.ReadWrite" |
| 6.1.3 | Add student: sub-customer with ParentRef, Job, BillWithParent | | Built | `roster-writes.test.ts` "adds a student under a family: ParentRef, Job and BillWithParent" |
| 6.1.4 | Edit family or student names: sparse update | Parents and flat members too | Built | `roster-writes.test.ts` "renames with the version the page was shown, sending the name alone"; `tests/unit/roster-write-rules.test.ts` "a display name" |
| 6.1.5 | Move a student: update ParentRef; re-scope open signature requests | The move also takes the student's volunteer places and per-student buy-outs (`afterStudentMoved()`) and their record's family. Since stage 3's slice 9c a move made in QuickBooks is not followed (app-owned families spec section 5): the refresh follows nothing and the daily check voids nothing; the student stays where the app has them, for stage 4 to show as a difference | Changed | `roster-writes.test.ts` "moves a student with an open form, a signed form and a place on a shift to come" and "a move: the student's record goes to the family moved to"; `tests/integration/signed-forms-staff.test.ts` "takes a complete form along with its evidence"; `buyouts-check.test.ts` "a student who moves in the portal". A move made in QuickBooks: `roster-refresh-moves.test.ts` "a student moved, renamed or made inactive in QuickBooks"; `buyouts-check.test.ts` "voids nothing for a student QuickBooks moved" |
| 6.1.6 | Deactivate a student or family: Active = false | The owner's decision of 2026-11-17, after the sandbox refused a family while a customer under it was active (800): a family is made inactive in one action, staff confirming the list of every active customer under it, each made inactive deepest first and the family last, never queued, saying what is true when it stops part way (`askFamilyInactive()`, `src/lib/roster/writes.ts`). Nobody with a balance is made inactive: what each owes is read first and nothing is sent while anyone owes (the amount only with `Finance.Balance.Read`), on every path: a make-inactive waiting on the queue is read again before it is sent, and stuck as `open_balance` when owed; QuickBooks' own 6220 and 800 are said in words. The family's last write carries the version read just before it (the lead's choice, runbook item 18) | Changed | `roster-writes.test.ts` "makes a family inactive in one action", "lists everyone active under the family at any depth", "makes a parent inactive", the describes "nobody with a balance is made inactive", "making a family inactive can stop part way", "what QuickBooks shows of each record" and "a make-inactive waiting on the queue"; `roster-write-pages.test.ts` "making a family inactive from its page" |
| 6.1.7 | Deactivating disables guardians with no active students | "No active students, no access" is a club setting, off by default, read by the gate from the app's own student records (open question 15 of the app-owned families spec); no row is closed for it, and a family made inactive is kept out the same way; it is switched on only while the membership shape names a student type, and is in force only then (`studentsRuleInForce()`): a value stored on beside a shape with none is kept and not used, and the settings page says so | Changed | `tests/integration/parent-door.test.ts` "the gate: while the club asks for an active student, a family with none is not one to enter" (and "does not apply the setting stored on while the shape names no students, and applies it again once a shape does"); `parents-switches.test.ts` (and "the active-students setting is refused while the shape names no students, and a shape saved without them leaves it stored but not in force"), `settings-parents.test.ts` "the active-students option is saved through its action, says what it would stop, and closes no row" and "says the active-students option is on but not in use while the shape names no students, and counts as the gate does"; `due-reminders.test.ts` "goes to no guardian of a family with no active student while the club asks for one" |
| 6.1.8 | Add, edit or remove a non-primary guardian (portal only) | A sign-in is the app's own guardian row (app-owned families spec section 6); QuickBooks' parent records give none and end none since stage 3's slice 7a. Since slice 7b staff add, remove (at once, whatever the family owes: the owner's decision of 2026-11-18) and reinstate a guardian (`Roster.Family.ReadWrite`), and change a person's name (`Parents.ReadWrite`), from the family's Portal sign-ins box and the person's page, in the portal only; a remove ends the person's unused email change asked in that family (every unused change and code at their last open row), and a form being opened as they are removed or blocked never gives them the document | Changed | `roster-writes.test.ts` "makes a parent inactive in QuickBooks: the portal's own sign-in for them stays"; `roster-refresh-signins.test.ts`; `staff-guardians.test.ts` "closes the row as removed with a note for staff only, ends that family's sessions, starts its waiting forms again, in step", "opens the same row again as it was, owes a welcome when due, in step", "changes the person and their sign-in account together, audited with before and after; the same name changes nothing", "ends the person's unused email change asked in that family; at their last open row, every unused change and code"; `forms-signing.test.ts` "never gets the document when removed in the middle of the open" (and blocked) |
| 6.1.9 | Change the primary guardian | No primary guardian in the design any more: each parent signs in by their own record, or every parent shares the family's record (parents spec §1). `guardian.is_primary` is only an ordering | Dropped | parents spec §1 |
| 6.1.10 | A taken display name offers a suffixed one | Also a name a waiting change will give, and QuickBooks' own 6240 | Built | `roster-writes.test.ts` "names: a taken one is answered with a free one to offer"; `roster-write-rules.test.ts` "that is taken is offered with the first free suffix" |
| 6.1.11 | Each membership shape allows only what it can hold | QuickBooks spec §1 | Built | `roster-writes.test.ts` "each membership shape allows what it allows"; `roster-write-rules.test.ts` "what each membership shape lets staff change" |
| 6.1.12 | A write that can't reach QuickBooks is queued and retried with back-off; never made twice | v1 §3, §8.4; AGENTS.md (Writes to QuickBooks) | Built | `tests/integration/roster-queue.test.ts` (all of it, "a write QuickBooks may already have made is never simply sent again" among it); `roster-write-rules.test.ts` "backs off 1, 5, 15 and 60 minutes" |

### §6.2 Parent edits

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 6.2.1 | Phone and address written straight to QuickBooks, audited | Owner decision 3; §6.2's note of 2026-11-15: the parent's own record (a Parent sub-customer, or the shared family or member record, which the page says), read live when the page opens | Built | `src/lib/parents/contact-edits.ts`; `tests/integration/contact-edits.test.ts` "layered, with a parent type", "layered, with no parent type", "flat", "the address goes as one billing address, and the audit row holds it before and after" |
| 6.2.2 | Another guardian's edits stay in the portal | Nothing is kept in the portal: a sign-in made by hand has no record and is told to ask the club | Changed | `contact-edits.test.ts` "a sign-in made by hand has no QuickBooks record of its own" |
| 6.2.3 | Email: a single-use, expiring, hashed link to the new address and a notice to the old | The request is asked in the session's own family, the app's record (`parent_email_change.family_id`, since stage 3's fifth slice), and is live only there | Built | `src/lib/parents/email-change.ts`; `tests/integration/email-change.test.ts` "stores the request, mails a link to the new address and a notice to the old", "replaces an earlier request that wasn't used" |
| 6.2.4 | On confirmation: sign-in identity, then QuickBooks, then the portal | Email-code spec §6: no Graph step. QuickBooks first, then the person's own address changed by the confirmation itself (stage 3's slice 7a), ending their sessions; an address another person holds is refused before anything is sent; a lost answer is finished by the next try without sending again | Built | `email-change.test.ts` "own Parent record: the one address is changed in QuickBooks, then the person, and the old address signs in nowhere", "an address %s signs in with is refused before anything is sent, and nothing changes", "an answer that never came", "the roster is busy"; the two other shapes |
| 6.2.5 | A later step that fails goes to the write queue and the reconciliation screen | Never queued: the parent is waiting (AGENTS.md, Writes to QuickBooks). A busy roster leaves the cache and asks the worker for a refresh | Changed | `email-change.test.ts` "the roster is busy: QuickBooks has the change, the cache is left alone and a refresh asked for", "an answer that never came" |

### §6.3 Concurrent edits

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 6.3.1 | Every update sends the cached SyncToken; a stale one is answered with the current values and nothing is overwritten | | Built | `contact-edits.test.ts` "changed in the moment between the read and the write: QuickBooks refuses, the record is read again"; `roster-writes.test.ts` "is refused by QuickBooks (5010), read again, shown with its current values, and not queued"; `email-change.test.ts` "a record changed in QuickBooks meanwhile" |
| 6.3.2 | The worker refreshes the roster cache nightly | QuickBooks spec §4: due 24 hours after the last good run, retried every 15 minutes | Built | `src/lib/jobs/runner.ts`; `tests/integration/jobs-runner.test.ts` "retries a failed job, but no more often than every 15 minutes"; `roster-refresh.test.ts` |
| 6.3.3 | Differences it can't explain are flagged on a reconciliation screen | Needs attention (QuickBooks spec §5) and `/staff/reconciliation`; its sign-in rule (`signin_unknown`) holds a sign-in to its membership's family record's customer (`guardian.family_id`); the flags the sign-in rules from QuickBooks made went with them, and so did `inactive_with_signin`, since nobody can enter an inactive family (stage 3's slice 7a) | Built | `tests/unit/roster-attention.test.ts`; `roster-pages.test.ts` "shows Needs attention with plain words"; `roster-write-pages.test.ts` "the Reconciliation page (Roster.Read)" |
| 6.3.4 | A refresh never puts an older copy over what a write just stored | AGENTS.md (the cache changes only from QuickBooks' answer, under the roster lock) | Built | `email-change.test.ts` "a refresh that stored a later version while the confirmation waited keeps it"; `contact-edits.test.ts` "a roster refresh under way: QuickBooks has the change, the cache is left alone and the worker asked to read the roster again" (fixed in this step) |

## §8 Money: balances, invoices, payment

### §8.1 Connection

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 8.1.1 | An Admin connects QuickBooks once with OAuth 2.0 | QuickBooks spec §3: the Intuit keys are entered on the settings view; a single-use state; another company refused. From stage 2 of the app-owned families spec until stage 4, any company but the one the roster was read from is refused too, after a disconnect as well, and no roster of another company is read (open question 18) | Built | `src/lib/quickbooks/connection.ts`; `tests/integration/quickbooks-connection.test.ts` "a state works once", "refuses a different company than the one connected"; `tests/integration/company-change-step5.test.ts` "refuses to connect another company", "refuses to read another company's roster"; `roster-company.test.ts` "refuses to connect a different company" |
| 8.1.2 | Tokens encrypted at rest | | Built | `quickbooks-connection.test.ts` "stores sealed tokens and the company on a good return"; `tests/unit/secret-box.test.ts` |
| 8.1.3 | Every refresh saves the new refresh token | | Built | `tests/integration/quickbooks-client.test.ts` "refreshes a token that is within 5 minutes of expiring, and saves the new refresh token", "two callers at once spend the refresh token once" |
| 8.1.4 | The portal warns well before the inactivity expiry and the hard limit | QuickBooks spec §5, §8: the stated expiry is used; warned within 30 days | Built | `tests/integration/quickbooks-health.test.ts` "a connection that expires within 30 days" |
| 8.1.5 | Each club registers its own Intuit app; a runbook walks it | | Built | `docs/runbooks/intuit.md`; `tests/unit/deploy-names-no-host.test.ts`. The assessment itself is an owner check |

### §8.2 What a parent sees

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 8.2.1 | Every open invoice on the family and its active student sub-customers: number, date, due date, amount due | The family's active student and parent sub-customers, or the member alone (AGENTS.md, Money) | Built | `src/lib/money/family-money.ts`; `tests/integration/payments-page.test.ts` "fresh figures: each open invoice, the total, a Pay link", "flat shape: the member's own invoices"; `family-money.test.ts` |
| 8.2.2 | A family total, the sum of those invoices | | Built | `payments-page.test.ts` "the credit line: QuickBooks' balance is lower than the invoices add up to, and the figure stays the sum" |
| 8.2.3 | A Pay button per invoice from `InvoiceLink`, https on an Intuit domain or no button | | Built | `src/lib/money/pay-link.ts`; `tests/unit/money-pay-link.test.ts`; `payments-page.test.ts` "checks a stored pay link again before showing it". Owner check: a real company's links |
| 8.2.4 | Read live when the page loads, with a short cache, shown with an "as of" time | | Built | `payments-page.test.ts` "stale figures are read again from QuickBooks before the page shows them" and the as-of assertion in "fresh figures" |
| 8.2.5 | QuickBooks unreachable: the last known figures, marked as not current | Pay switched off; the note never names an outage (AGENTS.md, Money) | Built | `payments-page.test.ts` "QuickBooks down, with figures stored", "figures that are not current because" |
| 8.2.6 | Never another family's invoices; nothing in a request picks a customer | The stored figures are kept by the app's own family since stage 2 of the app-owned families spec (migrations 0032 and 0033), found from the session's customer on each load; whose invoices a family sees is still the roster's tree (AGENTS.md, Money) | Built | `payments-page.test.ts` "family A's page holds none of family B's invoices", "nothing in the request chooses the family"; `family-money.test.ts` "a parent of a family whose record is inactive is shown no money"; `tests/integration/migrate-money.test.ts` |
| 8.2.7 | (added by `2026-11-18-app-owned-families-design.md` §4) A family with no link to the club's books sees no invoices, no Pay and no buy-out offer, and words saying the club hasn't connected its payments | Shown from stage 3, the owner's decision of 2026-11-18; only when the portal can tell the family has no link (`notConnected`, AGENTS.md, Money); every other case with no figures keeps "We can't show what you owe right now." | Built, in review | `tests/integration/family-money.test.ts` "a family with no link to the club's books"; `payments-page.test.ts` "a family with no link to the club's books"; `parent-home-family.test.ts` "a family with no link to the club's books"; `buyouts.test.ts` "offers a family with no link to the club's books nothing" |

### §8.3 Lessons from the CiviCRM extension

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 8.3.1 | `Customer.Balance` excludes sub-customers: the total comes from invoices | | Built | as 8.2.2 |
| 8.3.2 | `BalanceWithJobs` only as a cross-check; a mismatch logged and shown on the reconciliation screen | Read only when it covers the same customers (`balanceCoversTheSame`); each customer's own balance is compared by the daily run and listed as "Worth a look" on Balances and Reconciliation | Built | `family-money.test.ts` (`money.balance_mismatch`); `money-sweep.test.ts` "compares each customer's own balance in QuickBooks with its open invoices"; `balances-pages.test.ts` "lists the families worth a look"; `roster-write-pages.test.ts` "offers Try again now and Give up ... and the money worth a look" |
| 8.3.3 | The invoice query asks for `include=invoiceLink` | | Built | `quickbooks-client.test.ts` (the `include` assertion); owner check against a real company |
| 8.3.4 | No payments outside QuickBooks | | Built | Nothing takes a payment; `tests/unit/quickbooks-writes.test.ts` lists every write |
| 8.3.5 | Invoice text rendered as text, never HTML | | Built | `payments-page.test.ts` "renders a hostile invoice number and customer name as text"; §12 invariant 6 |

### §8.4 Scheduled jobs

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 8.4.1 | Roster refresh and reconciliation nightly | QuickBooks spec §4 (24 hours from the last good run). Since stage 3's slice 9c of the app-owned families spec the refresh stores the customer list and nothing else: it changes no family, student or sign-in and follows no move | Built | `jobs-runner.test.ts`; `roster-refresh.test.ts` |
| 8.4.2 | Token refresh daily | | Built | `jobs-runner.test.ts` "records when the token job finished" |
| 8.4.3 | Write-queue retries every few minutes with back-off | Every wake (a minute) for what is due | Built | `roster-queue.test.ts` "the worker" |
| 8.4.4 | Signature reminders as configured per form | Days before the due date and weekly after, from 9:00 club time | Built | `tests/integration/signed-forms-staff.test.ts` "saves a form's schedule, and sends it at the first wake on or after 9 on the club's clock" |
| 8.4.5 | Volunteer reminders and due-date nudges daily, plus the day-before reminder | | Built | `tests/integration/volunteer-reminders.test.ts` |
| 8.4.6 | Buy-out invoice status with the nightly reconciliation | After each daily money run; since stage 3's slice 9c it voids nothing for a student QuickBooks moved | Built | `tests/integration/buyouts-check.test.ts` "marks a paid one paid, flags one QuickBooks no longer shows, ... voids nothing for a student QuickBooks moved" |
| 8.4.7 | Expired email-change and session clean-up daily | Every table is cleaned or kept on purpose; Better Auth's verification rows added in this step | Built | `tests/integration/cleanup.test.ts` |
| 8.4.8 | (new) Every family's invoices read daily by the worker | Added by step 4 (Money for staff); a family whose read keeps failing is passed over after three stopped runs (this step); a roster family with no family record of the app's own is passed over as `no_record`, never stopping a run (stage 2) | Built | `money-sweep.test.ts` "reads each family in turn", "stops at a family whose read keeps failing", "passes over a roster family with no family record" |

## §9 Commitment forms and signatures

### §9.1 Setup

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 9.1.1 | A form is a requirement in a season step, pointing at a Documenso template staff make in Documenso | | Built | `src/lib/forms/attach.ts`; `tests/integration/forms-staff.test.ts` "reads the template, checks it, and keeps its id and last-changed time" |
| 9.1.2 | Prefilled text fields for student and guardian names, one or two signer roles | Verification §5.1 and §1a: fields found by label, and every prefilled field must be read-only, checked when attached and at each open | Built | `tests/unit/forms-template.test.ts`; `forms-staff.test.ts` "refuses, in plain words, a template the portal can't safely fill"; `forms-signing.test.ts` "does not make a document from a template whose name fields are no longer read-only" |
| 9.1.3 | Who must sign: any one guardian, or every guardian | Verification §5.2: "any one" is made for the guardian who opens it, and remade for the other while unsigned; "every" is at most the template's two roles | Built | `forms-signing.test.ts` "any one guardian: when the other guardian opens it while nobody has signed, it is withdrawn and made again for them", "makes one document for every guardian in one call" |
| 9.1.4 | Staff sign in to Documenso with the club's Entra tenant | Verification §4.f, §5.14: generic OIDC in Documenso, set up by its runbook; the portal plays no part | Changed | `docs/runbooks/documenso.md`; owner check with a real tenant |

### §9.2 Signing

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 9.2.1 | A guardian opens a form for one of their students | Also forms asked once of each family | Built | `src/lib/forms/my-forms.ts`; `tests/integration/forms-pages.test.ts` "lists this season's forms for the family and for each student" |
| 9.2.2 | Consent text shown and agreed (who, when, IP, version) before signing starts | | Built | `src/lib/forms/consent.ts`; `forms-signing.test.ts` "makes nothing and asks Documenso nothing until the guardian has agreed"; `forms-pages.test.ts` "shows the consent first" |
| 9.2.3 | Document made on first open, names prefilled, the required guardians as recipients | Verification §5.3, §6: one call when every role is filled, three otherwise; externalId, email off, time zone always sent | Built | `forms-signing.test.ts` "makes the document on the first open after consent, for one guardian of a two-signer template, by the verified recipe" |
| 9.2.4 | Names always current | Verification §5.4: true until a signature; an unsigned document is remade when a name changes | Built | `forms-signing.test.ts` "makes the document again when a name changed while nobody had signed, and leaves it alone once someone has" |
| 9.2.5 | Embedded signing; the token only to the guardian it belongs to | Verification §5.5: an iframe, the token read at each open and never stored | Built | `forms-pages.test.ts` "gives each of two guardians a page with their own token and never the other's"; `forms-signing.test.ts` "makes one document for every guardian ... gives each guardian their own token and nobody else's" |
| 9.2.6 | The webhook marks recipients and the document complete; its secret checked; repeats safe | Verification §5.6: the secret compared in constant time, the message only a hint, the API believed; the worker also asks every 5 minutes; complete only on COMPLETED | Built | `tests/integration/forms-webhook.test.ts` "answers a bare 404 with no secret, a wrong one, or one that differs only at the end", "is not fooled by a body that lies", "takes the same message any number of times"; `forms-job.test.ts` "stores a completion no webhook told it about"; `forms-signing.test.ts` "is complete only when Documenso says COMPLETED". Owner check: a real webhook |
| 9.2.7 | (new) "Signed, waiting for the sealed copy" in words, with an alert to staff after an hour | Verification §5.7 | Built | `forms-job.test.ts` "asks Documenso to seal again when everyone signed a while ago", "counts for the Health page the forms ... signed over an hour ago that still aren't sealed"; `staff-home.test.ts` (`formsToChase`) |
| 9.2.8 | (new) A declined form is a state with a way forward | Verification §1a | Built | `forms-signing.test.ts` "shows a declined form as declined, and starts it again with a new document"; `forms-pages.test.ts` "starts a family's own declined form again, and nobody else's" |
| 9.2.9 | On completion: the signed PDF and certificate downloaded and stored, SHA-256 recorded | Verification §5.8: every sealed PDF, the certificate PDF, the audit log as PDF and JSON, hashes of the sealed and original PDFs. Since migration 0036 (a part of stage 3's source move) a family or student with no QuickBooks link is no reason to wait: the evidence keeps no QuickBooks copy and no company for it; only QuickBooks connected to a company other than the roster's waits (`other_company`) | Built | `src/lib/signed-forms/evidence-job.ts`; `tests/integration/signed-forms-evidence.test.ts` "fetches every file, keeps it with the names and consents as they were", "keeps a per-family form of a family with no link", "keeps nothing and asks Documenso nothing while QuickBooks is connected to a company other than the roster's"; `tests/integration/migrate-evidence-without-link.test.ts` |
| 9.2.10 | The guardian is emailed a copy | Attached under 3 MB, a link otherwise | Built | `signed-forms-evidence.test.ts` "emails each guardian who signed it, once", "sends a link to the signed-in download in place of a PDF of 3 MB or more" |
| 9.2.11 | Documenso's own emails off; all mail from the portal | Verification §5.9: off for each document the portal makes; account mail to staff still goes | Built | `forms-signing.test.ts` "by the verified recipe" (the email override); `tests/helpers/documenso-stub.ts` records both settings |

### §9.3 What staff see

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 9.3.1 | A matrix of students by forms for the current season: unsigned, partly signed, signed | Verification §5.10 adds "not opened yet", "waiting for the other guardian", "signed, being sealed" | Built | `src/lib/signed-forms/matrix.ts`; `tests/integration/signed-forms-staff.test.ts` "lists the season's students by family and its forms across, each cell in words" |
| 9.3.2 | Reminders from the matrix | "Remind now" and a schedule | Built | `signed-forms-staff.test.ts` "emails only the guardians of the family asked about", "for a form, reminds each family's own guardians" |
| 9.3.3 | A download of any signed document with its certificate | Each file of the evidence, audited before a byte is sent | Built | `tests/integration/signed-forms-downloads.test.ts` "checks the session and Forms.Signature.Read first, then audits the read before sending the bytes" |
| 9.3.4 | (new) Start again: a document withdrawn as the verification says, never once complete | | Built | `signed-forms-staff.test.ts` "deletes a document nobody signed, cancels one somebody signed", "never touches a complete form" |

### §9.4 Evidence kept per signed form

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 9.4.1 | The sealed PDF and Documenso's audit certificate | | Built | as 9.2.9 |
| 9.4.2 | The template version | Verification §5.11: no version in Documenso; the template's id and `updatedAt` and the original PDF's SHA-256 | Changed | `signed-forms-evidence.test.ts` "fetches every file"; `signed-forms-staff.test.ts` "audits the read of a signed form's evidence ... with the signers, consents, template and hashes" |
| 9.4.3 | The consent record and the SHA-256 | | Built | as 9.4.2 |
| 9.4.4 | Audit entries for which signed-in guardian opened and completed it | `form.sign.open` and `form.signer.signed` | Built | `forms-signing.test.ts` "audits each time a guardian is given their signing frame, and each signature as the portal first reads it" |
| 9.4.5 | Evidence is the club's record: never deleted, kept across a change of company | AGENTS.md (Forms). Evidence kept with no company (its family had no link) is the current company's to its family and to staff, and is archived like the rest by a change of company | Built | `tests/integration/company-change-step5.test.ts`; `signed-forms-staff.test.ts` "keeps every byte and hash of the earlier evidence", "is among the current forms, never in the earlier company's archive"; `archived-evidence.test.ts` "refuses family A's own form while its evidence is another company's or archived"; `signed-forms-downloads.test.ts` "is the family's own to list and download, and nobody else's" |
| 9.4.6 | Clubs should have a lawyer review their form text; the docs say so | | Built | The staff page where a template is attached says so (this step, see Fixes; `forms-staff.test.ts` "shows the form part only on a form requirement"), and so do `docs/runbooks/documenso.md` (making templates, item 4) and the owner's runbook (`docs/runbooks/before-the-first-family.md`, part 4, "The lawyer's look") |

## §10 Season steps and requirements

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 10.1.1 | A season has an ordered list of steps staff name, reorder, add and remove | Removal refused while ticks, waivers, made forms or live places are held. A step's requirements can be reordered too (this step) | Built | `src/lib/seasons/setup.ts`; `tests/integration/seasons-staff.test.ts` "adds, renames, dates, reorders and removes steps, each with its audit row", "won't remove a step while a tick or a waiver is recorded in it", "moves a requirement earlier or later within its step" |
| 10.1.2 | A step has an optional date range | | Built | as 10.1.1; `tests/unit/season-progress.test.ts` "the current step" |
| 10.1.3 | A new season can be copied from the last one | Each kind's own settings copied too (buy-out price and item, a form's template, signers and reminders), fixed in this step | Built | `seasons-staff.test.ts` "copies the last season", "copies what each kind is met or billed by" |
| 10.1.4 | New installs start with a template season (Join, Forms, Volunteer, Season, Wrap-up) | Offered when there are none | Built | `seasons-staff.test.ts` "offers the template when there are none" |
| 10.1.5 | Requirement kind: form, payment, volunteer, checklist | | Built | `tests/unit/season-kinds.test.ts` "lets staff create every kind" |
| 10.1.6 | Required or optional; optional never holds a step open | | Built | `season-progress.test.ts` "never lets an optional item hold a step open, and still shows its progress" |
| 10.1.7 | Applies to each family or each student | Fixed once made | Built | `season-progress.test.ts` "tracks a per-family requirement once for the family and a per-student one for each active student"; `seasons-staff.test.ts` "offers a club whose roster lists no students only requirements for each family" |
| 10.1.8 | Amount: volunteer only, shifts or hours | | Built | `seasons-staff.test.ts` "refuses an amount on a checklist item" |
| 10.1.9 | Due date: drives reminders and the "due soon" state | Reminders for forms (a schedule), volunteering (nudges), and since step 8 for payment and checklist items: 14 and 3 days before, one email per guardian, family and due date, a payment's amount only from fresh figures and nothing when the figures can't tell it is unpaid | Built | Due words: `seasons-parent.test.ts` "says a due date in words on the club's day". Reminders: `signed-forms-staff.test.ts`, `volunteer-reminders.test.ts` "the nudges before a due date", `src/lib/seasons/due-reminders.ts` and `due-reminder-rules.ts`; `tests/unit/due-reminder-rules.test.ts`, `tests/integration/due-reminders.test.ts` |
| 10.1.10 | Who it covers: everyone, or a subset by a fixed filter (grade, section) | Everyone or a hand-picked list; a grade or section filter waits on the owner (QuickBooks holds no grade) | Partly built | `seasons-staff.test.ts` "covers everyone, or a list picked from the roster"; `season-progress.test.ts` "covers everyone, or only the chosen list". Roadmap, Waiting on the owner |
| 10.2.1 | Form met when its document is completed by the required guardians | | Built | `src/lib/forms/kind.ts`; `season-kinds.test.ts` "meets a form only by its signed document"; `forms-pages.test.ts` "shows on Home and on Season the same words as the Forms page, and done only when the document is complete" |
| 10.2.2 | Payment met when invoices carrying its item exist and none is open | | Built | `src/lib/money/payment-rule.ts`; `tests/unit/money-payment-rule.test.ts`; `tests/integration/payment-requirements.test.ts`. Owner check: the item on real invoice lines |
| 10.2.3 | Volunteer met by confirmed credit reaching the amount, or a paid buy-out | A staff tick no longer counts (step 5) | Built | `src/lib/volunteer/rules.ts`; `tests/unit/volunteer-rules.test.ts`; `buyouts.test.ts` "reads 'Buy-out invoiced' until the stored figures say its invoice is paid, then 'Paid instead'" |
| 10.2.4 | Checklist met by a staff tick, one at a time or in bulk | | Built | `seasons-staff.test.ts` "ticks an item off for one student, then for everyone shown, and unticks it" |
| 10.2.5 | Any requirement can be waived with a reason in the audit log | The reason is staff-only; the family reads "Waived" | Built | `seasons-staff.test.ts` "waives a requirement for a family or student with a reason"; `tests/integration/parent-isolation.test.ts` (the staff-only markers) |
| 10.3.1 | A step is done when every required item is met or waived | | Built | `season-progress.test.ts` "when a step is done (spec 10.3)" |
| 10.3.2 | The current set: the step by date or, with no dates, the first not done by everyone | Parents read "set", staff "step" | Built | `season-progress.test.ts` "the current step (spec 10.3)"; `seasons-parent.test.ts` "follows the club's dates, on the club's own day" |
| 10.3.3 | Each student's marker; progress in words, never color alone | | Built | `seasons-parent.test.ts` "draws the ruler for the family's own step, with a dot for each student"; `tests/e2e/parent-a11y.spec.ts` |

## §11 Volunteering

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 11.1.1 | Events (name, date, location, description) with shifts | | Built | `src/lib/volunteer/setup.ts`; `tests/integration/volunteer-staff.test.ts` "adds an event, checking what was typed, and audits it" |
| 11.1.2 | A shift: start and end, capacity, optional role, the requirements it counts toward | An end at or before the start is the next morning | Built | `volunteer-staff.test.ts` "adds a shift, checking its times, places and requirements"; `volunteer-parent.test.ts` "keeps an overnight shift listed past midnight" |
| 11.1.3 | A shift credits its length in hours, or one shift | | Built | `tests/unit/volunteer-allocation.test.ts` "gives a requirement counted in shifts whole credits, one shift each, and one counted in hours the minutes"; `volunteer-check-in.test.ts` "credits the real length of a shift across the night the clocks go forward" |
| 11.1.4 | Recurring events can be copied | | Built | `volunteer-staff.test.ts` "copies an event to another day with its shifts and what they count toward, and nobody signed up" |
| 11.2.1 | A guardian picks a shift with a free place, for themselves or one of their students | | Built | `volunteer-parent.test.ts` "takes a place for the guardian", "takes a place for one of the family's students", "signs up only the family's own active students" |
| 11.2.2 | Before confirming, the guardian sees which requirement it counts toward | | Built | `volunteer-parent.test.ts` "takes a place for one of the family's students, and shows beforehand what it counts toward for each person" |
| 11.2.3 | Parents see "3 of 5 places filled", never who else; staff see the list | | Built | `volunteer-parent.test.ts` "invariant 7"; `volunteer-staff.test.ts` "lists the events, and a shift's sign-ups by name with their family" |
| 11.2.4 | Cancel until the club's cut-off; after it, contact the coordinator | | Built | `volunteer-parent.test.ts` "cancels the family's own sign-up until the cut-off, to the second", "after the cut-off, the page says whom to contact" |
| 11.2.5 | A full shift is full; no waitlist | | Built | `volunteer-parent.test.ts` "refuses a full shift", "leaves exactly as many people signed up as there are places when they all take them at the same moment" |
| 11.2.6 | (new) Signing up is rate-limited per guardian | Known gap of step 4, fixed in this step | Built | `volunteer-parent.test.ts` "refuses a guardian's 31st sign-up press in 15 minutes"; `tests/integration/rate-limit.test.ts` |
| 11.3.1 | A confirmation with a calendar file on sign-up | | Built | `volunteer-parent.test.ts` "emails them a confirmation with a calendar file"; `tests/unit/mail-messages.test.ts` |
| 11.3.2 | A reminder the day before | From 9:00 club time | Built | `volunteer-reminders.test.ts` "the day-before reminder" |
| 11.3.3 | A notice when staff change or cancel the shift | Cancelling asks first (fixed in this step) | Built | `volunteer-staff.test.ts` "emails everyone signed up when the date or place changes", "emails the shift's sign-ups when its time changes", "cancels one shift: its sign-ups are emailed"; `tests/e2e/volunteer.spec.ts` (Cancel this event, then Keep it) |
| 11.3.4 | Reminders before a due date for families with unmet required volunteering | | Built | `volunteer-reminders.test.ts` "emails each family that hasn't met one, once per nudge" |
| 11.4.1 | Each shift has a check-in code shown as a QR code to print | Its own random code, never its id | Built | `tests/integration/volunteer-credit-staff.test.ts` "draws the code as a QR code on the server, writes out the address it opens, and makes a new code that stops the old one". Owner check: real phones |
| 11.4.2 | Scanning opens the portal; the guardian must be signed in; checks in the person on the sign-up | Any guardian of the family checks in everyone of the family on the shift (owner's call, Known gaps). The requirement's staff page says what counts (corrected in this step) | Built | `volunteer-check-in.test.ts` "checks in everyone of the family on the shift at once"; `tests/integration/parent-isolation.test.ts` (the sign-in redirect carries the page) |
| 11.4.3 | Works from 30 minutes before the start until the end; outside, says so and records nothing | | Built | `volunteer-check-in.test.ts` "opens 30 minutes before the start and closes at the end, checked again when the press arrives"; `tests/unit/volunteer-check-in-window.test.ts` |
| 11.4.4 | A check-in creates credit for that shift | One live credit per sign-up | Built | `volunteer-check-in.test.ts` "after checking in" |
| 11.4.5 | Staff correct credit (remove, add a missed one) and credit outside work with a note, each audited | The note and a removal's reason are staff-only | Built | `volunteer-credit-staff.test.ts` "adds a missed check-in once the shift has started", "removes a check-in with a reason only staff see", "credits volunteering done outside the portal" |
| 11.4.6 | Required before optional, never beyond the amount needed; leftovers to optional | `allocateCredit()` | Built | `volunteer-allocation.test.ts` "fills a required requirement before an optional one", "gives nothing beyond what a requirement needs" |
| 11.5.1 | A volunteer requirement can allow a buy-out at a set amount, billed with an item staff pick | | Built | `src/lib/buyouts/setup.ts`; `buyouts.test.ts` "offers the choice with the amount" |
| 11.5.2 | The guardian confirms the amount; an invoice for the family or the student's sub-customer | The quote is worked out again and stamped, the stamp sealing the app's ids of the family and the subject beside the requirement, customer, item and price, and the keys following the family's own students by name; the confirm carries a stamp of the subject the page showed too and checks it first (a key that now names another student is answered with the reload words, and so is a page drawn before the subject's stamp, which sends one argument fewer; a quote stamp sealed the old way, by QuickBooks ids, with the price-changed words); while the membership shape doesn't hold nothing is offered or confirmed (`shapeHolds()`); nothing the browser sends names a customer, item or amount; the customer billed is the family's or the student's own linked customer, the student's directly under the family's in the roster cache. The invoice's bill-to address is the confirming guardian's own sign-in address, from the session, kept with the queued create (the owner's decision of 2026-11-17); nothing is emailed. QuickBooks refusing the address is a refusal like any other | Built | `buyouts.test.ts` "makes one invoice in QuickBooks, for the family", "bills a per-student requirement to the student's own customer", "refuses a stale quote with the new amount", "refuses a quote stamped the old way", "refuses a student's key that has come to name another student", "answers a confirm from a page whose key a sibling's rename has moved", "offers nothing, confirms and switches back nothing", "bills the sign-in address of the guardian who confirms", "sends, from the worker, the address the guardian had when they chose", "refuses the buy-out, queues nothing, and tells staff about the address", "refuses the buy-out without sending anything when the guardian's address is one QuickBooks can't take"; `buyouts-privacy.test.ts`; `tests/unit/quickbooks-writes.test.ts` "send a bill-to email address only from the check of the portal's requests and the buy-out writer" |
| 11.5.3 | It appears among the open invoices with its own Pay button | `family_money` marked stale. QuickBooks gives a Pay link only to an invoice with an email address (the sandbox, 2026-11-17), so the invoice carries the chooser's sign-in address | Built | `buyouts.test.ts` "makes one invoice ... and the chooser's address, and emails nothing" (the stale mark and the Pay link), "shows the buy-out's invoice with its Pay button on Payments once it is made". Owner check: a Pay button on a real company's buy-out invoice, and whether online payment needs more than ACH |
| 11.5.4 | "Buy-out invoiced" until paid, then met | | Built | `buyouts.test.ts` "reads 'Buy-out invoiced' until the stored figures say its invoice is paid, then 'Paid instead'"; `tests/unit/buyout-rules.test.ts` |
| 11.5.5 | Switching back before paying voids it; once paid, only the treasurer reverses it | Read live first; voided only with nothing paid | Built | `buyouts.test.ts` "voids the invoice when nothing is paid on it, read live first", "never voids a paid or part-paid invoice" |
| 11.5.6 | The only invoice the portal makes; create and void through the write queue; the nightly check flags one QuickBooks no longer shows | | Built | `tests/unit/quickbooks-writes.test.ts`; `buyouts.test.ts` "never makes a second invoice after a lost answer", "goes through the queue when QuickBooks can't be reached for the void"; `buyouts-check.test.ts`. Since step 8 staff close a refused, never-sent, gone or paid-in-full buy-out from Reconciliation or a family's buy-outs page, sending nothing to QuickBooks: `src/lib/buyouts/closing.ts`, `close.ts`; `tests/unit/buyout-close-rule.test.ts`, `tests/integration/buyouts-close.test.ts`, `tests/e2e/buyout-close.spec.ts` |

## §12 Privacy invariants

Each was read; the four marked "mutated" were also broken on purpose in this step, and the test named failed each time.

| # | Invariant | Override | State | Enforced by |
|---|---|---|---|---|
| 1 | No request parameter selects a family; every parent query takes it from the session; a test calls every parent endpoint as A with B's ids | Email-code spec §6: from the session's chosen guardian row, re-checked on every request. Since stage 3's fifth slice the session stores the app's own family record it chose (`parent_auth_session.family_id`; migrations 0037 and 0038, a session that can't be carried has its family cleared), and the gate (`resolveParentSession()`) matches it to the person's open rows by their `family_id`, only while that family is active (app-owned families spec §6), and gives it as `ctx.familyId`: no QuickBooks id takes part; every parent query reads by `ctx.familyId`, and a parent's season, forms and volunteering need no link | Built | Pages: `tests/integration/parent-isolation.test.ts` "one family never sees another's data on a parent page" (every page on disk, both ways, with `PARAMS` holding B's ids) and `tests/e2e/parent-session.spec.ts` (`OTHER_FAMILIES`, the props). Actions and lookups: `contact-edits.test.ts` "as family A with family B's customer id in every argument", `email-change.test.ts` "family B's token" and "a change asked in family A can't be confirmed from the same person's session in family B", `forms-pages.test.ts` "refuses every action called as family A with family B's request", `forms-signing.test.ts` "every action called as family A with family B's request", `volunteer-parent.test.ts` "refuses family B's sign-up to family A's parent", `volunteer-check-in.test.ts` (invariant 8), `buyouts-privacy.test.ts` (and "shows and does nothing for a family whose own record is inactive"), `signed-forms-downloads.test.ts` "answers another family's id ... with the same 404", `choose-family-action.test.ts`. Re-checked per request: `parent-door.test.ts` "sends a parent back to choose when the chosen family goes away", and "the gate: a parent enters only an active family of the app's own" (an inactive family, a row with no record, a person whose only open row names no active family sent no code, the same people in the same families). No link needed: `seasons-parent.test.ts` "needs no link", `forms-pages.test.ts` and `volunteer-parent.test.ts` "a family with no link to QuickBooks", `family-money.test.ts` "for a family with no link to a customer". Static: `page-guards.test.ts` "parent code never imports the staff-only queries". **Mutated:** dropping the family filter in `loadMyVolunteering()` failed `parent-isolation.test.ts` and `volunteer-parent.test.ts` |
| 2 | Every staff handler declares a permission, and a test calls each without it and expects a refusal | | Built | `tests/integration/invariants.test.ts` "every server action is guarded"; `tests/integration/doors.test.ts` "invariant 2: every staff action is refused to whoever lacks its permission" (each action, by a staff member holding every other permission, and by a parent); route handlers in `page-guards.test.ts` "every route handler is listed with its guard". **Mutated:** letting one permission through in `staffCtx()` failed `doors.test.ts`. The test proves the declared permission is enforced, not that it is the right one: that is read in review |
| 3 | Parent pages refuse staff sessions, staff pages refuse parent sessions | | Built | `doors.test.ts` "invariant 3: each door's pages refuse the other door's session" (every page of both doors on disk); `page-guards.test.ts` "every page guards itself" |
| 4 | Public pages hold no family data, rendered anonymously against a seeded database | | Built | `doors.test.ts` "invariant 4: the public pages show no family data" (names, amounts and staff notes of two families); `tests/e2e/public-pages.spec.ts` |
| 5 | No secret reaches the browser; a signing token only to its recipient | Email-code spec: no Graph credentials remain | Built | `tests/unit/client-components.test.ts` "client components reach no secret"; `scripts/check-client-bundle.mjs` (CI, the built files); `forms-pages.test.ts` "gives each of two guardians a page with their own token and never the other's"; `tests/integration/quickbooks-connection.test.ts` and `forms-staff.test.ts` (secrets never sent back to a page) |
| 6 | QuickBooks text is never rendered as HTML | | Built | `tests/unit/no-raw-html.test.ts` "nothing under src/ writes raw HTML" (every file); `tests/unit/mail-messages.test.ts` (emails escape QuickBooks names); page tests with hostile names (`payments-page.test.ts`, `roster-pages.test.ts`, `seasons-parent.test.ts`, `roster-write-pages.test.ts`) |
| 7 | Parents never see other families on volunteer shifts: two families on one shift each see a count and their own | | Built | `volunteer-parent.test.ts` "invariant 7: each parent sees only a count and their own sign-up" (pages and the data handed to them). **Mutated:** as invariant 1 |
| 8 | A check-in code credits only the signed-in family's own sign-up, only inside its window | | Built | `volunteer-check-in.test.ts` "invariant 8: a check-in code credits only the signed-in family's own sign-up". **Mutated:** dropping the family filter in the check-in's sign-up lookup failed it and `parent-isolation.test.ts` |
| 9 | (new) A code goes only to a person not blocked with a guardian row that counts (open, in an active family record, and with an active student while the club asks for one); the page's answer doesn't depend on it | Email-code spec §6; app-owned families spec section 6 | Built | `signin-codes.test.ts` "sends nothing to %s and audits why"; `parent-door.test.ts` "answers the same for known, unknown, blocked and all-disabled, and only the known one gets mail" |

## §13 Audit log

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 13.1 | Every create, update and delete is recorded | Rate-limit counts, a claim held while a form's document is made, the check of the portal's requests' own records, Documenso's and the worker's last answers for the Health page, the placeholder request rows a family's Forms page makes, which step of setup is showing and a connection's state before Intuit answers are not the club's records, and are named on purpose with why. Sign-in codes and sessions are ended inside the block, membership close or email change that audits them | Built | `tests/unit/audit-rows.test.ts`: every insert, update and delete under `src/` (drizzle's, and SQL) sits in a function that writes an audit row, or in a helper only such functions call (kept to its file, or given the caller's transaction), or is in its `NOT_AUDITED` list with why; it found none of the club's records written without one. A heuristic: it follows calls by name, and can't tell that a caller's row is in the same transaction. Each write's own test still asserts its row (for example `seasons-staff.test.ts` "each with its audit row", `roster-writes.test.ts`), and `tests/unit/audit-actions.test.ts` holds every action to words |
| 13.2 | Every sign-in, sign-out and refused sign-in, both doors | | Built | `tests/integration/signin-audit.test.ts`; `signin-codes.test.ts` (`signin.code_refused`, `signin.code_wrong`); `tests/integration/resolve.test.ts` (a refused staff sign-in, with its address since this step) |
| 13.3 | Staff reads of family data: a family's details, balances, invoices, signed forms, any export | The forms matrix, a read of many families, is not audited on purpose | Built | `roster-pages.test.ts` "a family's page ... and the visit is audited"; `signed-forms-staff.test.ts` "is not audited" (the matrix, by design); `balances-pages.test.ts` "audits the read before anything is shown"; `signed-forms-staff.test.ts` "audits the read of a signed form's evidence before it is shown"; `signed-forms-downloads.test.ts`; `seasons-staff.test.ts` "shows where one family stands ... and audits the read"; `volunteer-credit-staff.test.ts` "is audited before it shows anything"; `parents-pages.test.ts` (`parent.read`); `audit-log.test.ts` "audits the export with its filters and count" |
| 13.4 | Opening the audit log itself, filtered to one family or person | Not decided | Partly built | The export is audited; the page is not (roadmap Known gaps: the owner to say) |
| 13.5 | Parents viewing their own family are not recorded | | Built | `seasons-parent.test.ts` "is not audited: a parent looking at their own family's season leaves no row"; `parent-home-family.test.ts` "records nothing: a parent viewing their own family is not audited"; `payments-page.test.ts` (Payments leaves no audit row) |
| 13.6 | Each entry: who (person and door), action and permission, record, before and after, when, request IP | | Built | `tests/integration/audit.test.ts` "records who, what, which record, before/after, and IP"; `doors.test.ts` (the refusal's permission) |
| 13.7 | Admins can view and export it | Admin only (`Audit.Log.Read` is `ADMIN_ONLY`) | Built | `audit-log.test.ts` "is Admin only", "gives an Admin every matching row as CSV, never cached" |
| 13.8 | Append-only from the app's point of view | | Built | `tests/unit/audit-append-only.test.ts` (added in this step); `cleanup.test.ts` "never touches the audit log, however old" |
| 13.9 | No secret, code or message body in a row | Email-code spec §1, QuickBooks spec §6 | Built | `signin-codes.test.ts` "never puts the code in a log line or the audit log"; `roster-writes.test.ts` "QuickBooks' words never reach the audit log"; `signed-forms-evidence.test.ts` "audits the hashes, never the bytes" |
| 13.10 | Staff notes are for staff | AGENTS.md (a waiver's reason, a credit's note, a start-again reason) | Built | `parent-isolation.test.ts` (`season.staffOnly` markers) |
| 13.11 | A missing entry is a defect | | Built | This step added the address to a refused staff sign-in and a first sign-in's bind (`resolve.test.ts`), the buy-out counts to a move's follow-up row (`buyouts-check.test.ts` "voids an unpaid per-student invoice through the queue"), and words for the new `season.requirement.move` (`tests/unit/audit-actions.test.ts`) |

## §14 Operations

| # | Spec says | Override | State | Proof |
|---|---|---|---|---|
| 14.1 | One image per release with a `stable` tag on GitHub Container Registry | Also the version and the commit's first 12 characters | Partly built | `.github/workflows/release.yml`; checked with actionlint, never run (nothing may be pushed): owner check |
| 14.2 | Migrations on start-up after a pre-migration backup check | The `migrate` service runs before the app. Before it changes a database that already holds data (migrations applied, more to apply), it refuses unless the last good backup (`backup.last_success`, recorded by `scripts/backup.sh`) is less than 26 hours old, and says what to do: `docker compose run --rm backup --now`, then start again. A first installation (an empty database) and a start with nothing to apply are never stopped; `MIGRATE_WITHOUT_RECENT_BACKUP=yes` lets one start through for a volunteer with a backup of their own. `scripts/poc/deploy.sh` backs up first itself and stops if that fails | Built | `scripts/backup-check.mjs`, run by `scripts/migrate.mjs --backup-check` in `deploy/compose.yml`; `docs/runbooks/updates.md` "When the start stops for a backup", `first-install.md`; `tests/integration/migrate-script.test.ts` "scripts/migrate.mjs --backup-check" (empty, nothing to apply, none, old, the override, fresh), `tests/unit/deploy-migrate.test.ts`, `tests/unit/deploy-script.test.ts` |
| 14.3 | A club's host pulls `stable`; FZN by App Service continuous deployment | Owner decision 6: nothing depends on one provider; `deploy/compose.yml` pulls the pinned image | Changed | `docs/runbooks/updates.md`; `tests/unit/deploy-names-no-host.test.ts` |
| 14.4 | Dependency updates automated; every release passes CI before `stable` moves | Security updates also need Dependabot's settings switched on in the repository (the owner's runbook, part 1 item 11) | Partly built | `.github/dependabot.yml`; `release.yml` builds and publishes only after its first job finds CI's green run on the release's commit (`tests/unit/release-workflow.test.ts`). Never run: owner check |
| 14.5 | Backups of both databases with point-in-time restore | `scripts/backup.sh` nightly at `BACKUP_AT` club time, both databases or neither, newest 14 kept (no point-in-time restore on a plain host) | Changed | `backup-restore.test.ts` "backs up both databases into the folder in one run", "a backup that fails keeps nothing"; `backup-schedule.test.ts` |
| 14.6 | Restore is a launch requirement, with a runbook carried out at least once | | Partly built | `scripts/restore.sh`, `docs/runbooks/restore.md`; `backup-restore.test.ts` "restores Documenso's backup, and everything in it is the same", "restores into a database that doesn't exist yet". Nobody has followed the runbook yet: owner check (the owner's runbook, part 1 item 7) |
| 14.7 | The health page checks QuickBooks, Graph (now mail), Documenso API and webhook, and email | Email-code spec §6: mail sending instead of Graph; plus the worker, backups, money run, clean-up, sign-in addresses | Built | `src/lib/health/report.ts`; `tests/integration/health-page.test.ts`; `forms-staff.test.ts` "the Health page's line for forms"; `tests/e2e/ops.spec.ts` |
| 14.8 | Runbook: first deployment | | Built | `docs/runbooks/first-install.md`; `tests/unit/runbooks.test.ts`, `deploy-names-no-host.test.ts` |
| 14.9 | Runbook: Intuit app registration and assessment | | Built | `docs/runbooks/intuit.md`; same tests. Written without Intuit's screens (owner check) |
| 14.10 | Runbook: External ID tenant setup | Email-code spec §6: replaced by outgoing mail setup | Built | `docs/runbooks/mail.md`; `runbooks.test.ts` "sends the mail runbook's readers to the step numbers the page shows" |
| 14.11 | Runbook: Documenso setup and signing certificate | | Built | `docs/runbooks/documenso.md`; `runbooks.test.ts` "keeps the signing certificate's copy before handing the file to Documenso's user" |
| 14.12 | Runbooks: updates, restore | Also the move to a new major version of Postgres (16 to 18, 2026-11-17): a start that meets data not yet moved is refused, with what to do, and never makes an empty database; the move never writes to the old data, and coming forward again after going back first backs up what Postgres 18 holds | Built | `docs/runbooks/updates.md` ("Moving to a new major version of Postgres"), `restore.md`, `backups.md`; `scripts/move-postgres.sh`, `scripts/postgres-guard.sh`; `deploy-names-no-host.test.ts`, `tests/integration/postgres-move.test.ts`, `tests/unit/postgres-version.test.ts` |
| 14.13 | Runbook: reconnecting QuickBooks | QuickBooks spec §9 adds it | Built | `docs/runbooks/quickbooks-reconnect.md`; `deploy-names-no-host.test.ts` |
| 14.14 | Health page entries explained for a volunteer | | Built | `docs/runbooks/health-warnings.md`; `health-page.test.ts` |

## Owner's decisions of 2026-11-14

| # | Decision | State | Proof |
|---|---|---|---|
| D3 | Parents edit their phone and address; the portal writes to QuickBooks for the named paths only | Built | §6.2; `tests/unit/quickbooks-writes.test.ts` (every write and who may send it) |
| D4 | A parent stays signed in for 90 days, renewed by use; every request re-checks links and blocks | Built | `parent-door.test.ts` "lasts 90 days from sign-in", "starts its 90 days again when it is used, at most once a day", "signs a parent out at once when their last family goes, or they're blocked" |
| D5 | Installable on iOS and Android | Built | `src/app/manifest.ts`, `public/sw.js`; `tests/unit/pwa-static.test.ts`, `pwa-rules.test.ts`, `tests/integration/pwa-icons.test.ts`, `tests/e2e/pwa.spec.ts`, `parent-home.spec.ts`. Owner check: real phones |
| D6 | The address is set by whoever installs it; no host name in code; no one provider | Built | `src/env.ts` (`APP_URL`), `PortalAddress`; `tests/unit/deploy-names-no-host.test.ts`, `health-address.test.ts` |
| D1, D2 | Scope is the whole v1 spec; forms in Documenso from the start | Built | This page |

## What is partly built or missing, and what it would take

| Row | What is missing | Rough size | It would touch |
|---|---|---|---|
| 10.1.10 | Coverage by grade or section | Days, and an owner decision first: QuickBooks holds no grade | A data source for grade, `requirement_cover`, the coverage rules and pages |
| 13.4 | Auditing a view of the audit log filtered to one family or person | An hour once the owner decides | `src/app/staff/(app)/audit/page.tsx`, an action name |
| 14.1, 14.4 | A release and the dependency updates actually run | Owner check once pushing is allowed | GitHub |
| 14.6 | The restore runbook carried out once on real data | An hour of the owner's | The owner's runbook, part 1 item 7, and its Results table |

## Fixed in this step

Each in its own commit with its test, on `slice/conform`.

| Commit | Section | What is now true |
|---|---|---|
| `d0702d5` | §8.4 | The daily clean-up removes Better Auth's expired verification rows of both doors |
| `7e3ba2b` | §6.1, §6.3 | A queued roster write that may have been made stays so after a try that sent nothing |
| `aee9768` | §10.1 | A copied season keeps each requirement's buy-out, form template and reminder schedule |
| `d9e75c0` | §13 | A refused staff sign-in and a first sign-in's bind record the request's address |
| `77dd936` | §13 | A test holds that nothing under `src/` updates, deletes or truncates an audit row |
| `b43b611` | §12 (2, 3, 4) | Every staff action is called without its permission and refused; every page of each door refuses the other's session; the public pages show nothing of two seeded families |
| `307e52a` | §12 (6) | No raw-HTML API anywhere under `src/` but the fixed display script; emails escape QuickBooks names |
| `24bd468` | §11.3 | Cancelling an event or a shift asks first, since it emails everyone signed up |
| `0731592` | §11.2 | Signing up for shifts is rate-limited per guardian (`volunteer_signup_parent`) |
| `7ebcb5e` | §12 (5) | No client component reads the environment or imports a module that holds a secret |
| `e1532c2` | §9.4 | Where a form's template is attached, the page says to have the club's lawyer read its words |
| `fea2769` | §11.5, §13 | A student's move counts its buy-outs voided and flagged in `roster.student.move.followed` |
| `890e0b9` | §6.3 | A phone saved while a roster refresh runs is not put back by that refresh for long: the cache waits and the worker reads the roster again |
| `1dbf38c` | §11.4 | A volunteer requirement's staff page says a check-in is what counts (it said check-in wasn't built) |
| `a82ee6b` | §10.1 | Staff reorder a step's requirements, audited as `season.requirement.move`; families read the new order |
| `e2442d6` | §8.4 | A family whose read keeps failing stops at most two daily runs; the third passes it over, counted |

## The roadmap's Known gaps, checked

Each entry of the roadmap's Known gaps section as it stood on `parent-portal` on 2026-11-16. Step 8 (2026-11-17) closed
more of them; the roadmap's own Known gaps section is the current list.

| Left by | Gap (short) | Now | Proof |
|---|---|---|---|
| Step 2 review | No credit line for a family with other customers under it | Still true | `balanceCoversTheSame` in `src/lib/money/family-money.ts`; by design |
| Step 2 review | Payments and Home ask the family first (`loadMyFamily()`, the app's record since stage 3's fourth slice); `loadFamilyMoney()` alone does not | Still true | `figuresToShow()` in `src/lib/money/family-money.ts` |
| Step 2 review | Figures go "not current" when the portal is only busy | Still true | `src/lib/money/family-money.ts` |
| Step 2 review | A code step left on a shared device | Still true | The device keeps it for the code's 10 minutes, by design |
| Step 3 | A roster refresh can put an old phone back in the cache | Partly true: behind for minutes, not a day | `890e0b9`: while a refresh runs the save leaves the cache and asks for another; the one under way still stores what it read |
| Step 3 | The field limits for a parent's phone and address are guesses | Still true | Sandbox check |
| Step 3 | Coverage is everyone or a chosen list; no due-date reminders; no deleting a season; no reordering requirements | Partly true | Reordering: `a82ee6b`. Due-date reminders exist for forms and volunteering since step 5, not for payment or checklist items. No season delete; coverage waits on the owner |
| Step 3 | Better Auth's verification rows are never cleaned up | No longer true | `d0702d5`; `cleanup.test.ts` "Better Auth's verification rows, both doors" |
| Step 3 | Opening the audit log is not audited | Still true | Owner decision |
| Step 3 | The backup test needs `pg_dump` 16 on the CI runner | No longer true, not yet seen on GitHub | `0610b80`: CI runs the tools inside the Postgres service's container (`BR_TEST_DB_CONTAINER`) |
| Step 3 | A header the proxy doesn't send puts the staff door in one bucket | Still true | By design; the Health page says so |
| Step 3 | An untouched address part that is too long is sent again | Still true | `saveMyContact()` sends the whole address |
| Step 4 | The Documenso webhook has only met the stub | Still true | Owner check |
| Step 4 | Forms are shown, not kept | No longer true | Closed by step 5 (the entry says so) |
| Step 4 | The consent records no address locally | Still true | Local only |
| Step 4 | Volunteer credit not allocated; sign-ups not rate-limited; cancelling an event or shift has no confirm | No longer true | Step 5 (`allocateCredit()`); `0731592`; `24bd468` |
| Step 4 | A payment paid more than 12 months ago reads "No invoice yet"; the item list is read only on a press | Still true | `src/lib/money/invoices.ts`, `src/lib/money/items.ts` |
| Step 4 | A student moved in QuickBooks leaves an opened form, and a place, behind | True again, on purpose, since stage 3's slice 9c: a move made in QuickBooks changes nothing in the app (the refresh followed one from step 5 to slice 9c) | `refreshRoster()` runs no `afterStudentMoved()`; `roster-refresh-moves.test.ts` |
| Step 4 | A family whose read always fails stalls the daily money run | No longer true | `e2442d6`; `money-sweep.test.ts` "stops at a family whose read keeps failing". A family passed over as not a family gets no failed-try stamp either: `8a17c5f`; `money-sweep.test.ts` "stamps no failed try on a family the cache stops holding as one" |
| Step 4 | The Item list's inactive items have only met the stub | Still true | Sandbox check |
| Step 4 | The test teardown drops scratch databases by name | Still true | `scratchDatabase()` in `tests/setup/database-url.ts` |
| Step 4 | The installability browser test fails in a worktree with a long path | Still true | Windows path limit |
| Step 5 | After an email change that met a busy roster, the old address can still ask for a code | Still true | `confirmMyEmailChange()` |
| Step 5 | Signed-form evidence is never re-verified on its own, and the rest of that entry | Still true | `src/lib/signed-forms/` |
| Step 5 | The certificate and audit-log PDFs are kept but not compared | Still true | `src/lib/signed-forms/evidence.ts` |
| Step 5 | No Health line of its own for volunteer reminders | Still true | `src/lib/health/report.ts` |
| Step 5 | Making a customer active again is not offered; the queue's pace | Still true | `src/lib/roster/operations.ts`, `queue.ts` |
| Step 5 review | A moved student's signed form is the old family's to read | Still true | By design (`signedWithin()`) |
| Step 5 review | A form sealed at the moment of a move is left in Documenso | Still true | `form.document.withdraw.kept` |
| Step 5 review | A queued move whose answer named another record runs no follow-ups | Still true | `src/lib/roster/queue.ts` |
| Step 5 review | The copy for a guardian whose student moved goes only as an attachment | Still true | `src/lib/signed-forms/copies.ts` |
| Step 5 review | Any guardian checks in another guardian's place; no check-in from inside the installed app | Still true | Owner's call |
| Step 6 | No staff action closes a stuck, refused or flagged buy-out; no Health line for the check; no staff page of one family's buy-outs | No longer true | `cb8ed77`, `aa35a66`: staff close one no unpaid invoice of stands, from Reconciliation and the family's buy-outs page (`src/lib/buyouts/close.ts`, `/staff/roster/[id]/buyouts`; `tests/integration/buyouts-close.test.ts`); `b259bfe`: the Health page's `buyout_check` line |
| Step 6 | Copying a season drops the buy-out price; the move's follow-up row doesn't count buy-outs | No longer true | `aee9768`, `fea2769` |
| Step 6 | The write queue clears the sent flag on a retry that sent nothing | No longer true | `7e3ba2b`; `roster-queue.test.ts` "stays one that may have been made when a resend after it sends nothing" |
| Step 6 | The portal reaches Documenso at its public address | Still true | `src/lib/documenso/client.ts` |
| Step 6 | The image's time zone is `America/Chicago` | No longer true | `aae176f`: the `Dockerfile` sets `TZ=UTC`; `deploy/` sets the club's zone |
| Step 6 | The parent pages' keyboard journeys are not a committed test | Still true | `docs/accessibility-checks.md` |
| Step 6 | The Parent sign-ins clean-up preview and several staff pages are still lists | The preview went in stage 3's slice 7a; the other pages are still lists | `docs/ui-backlog.md` |
