# Parents from QuickBooks — design

**Status:** approved by the owner on 2026-11-11; implemented by plan `2026-11-11-parents-from-quickbooks.md`;
merged and deployed to the linuxdev proof of concept on 2026-11-12 (commit `82e4639`). Parent sign-ins are still
switched off there, and the runbook's checks 18-25 have not been run (docs/runbooks/before-the-first-family.md, part 1).
**Changed since:** step 5 of the roadmap changes its "What staff cannot do here": staff now create, rename, move and make inactive in QuickBooks from the roster pages.
**Changed since** (2026-11-19, stage 3 slice 7a of `2026-11-18-app-owned-families-design.md`): sign-ins no longer come from QuickBooks. The reconcile's sign-in half (§1, §2), the held-address review and its notice, the clean-up preview and its dry run (§3), the match review and the previous-company snapshot (§6) and the roster flags they made are gone; a guardian row is the app's own and counts at the gate while it is open, in an active family record and, under the setting, a family with an active student; the switches need only working mail; the parent's email confirm changes the person's address itself. Read the app-owned families spec for what stands.
**Changed since** (2026-11-20, stage 3 slices 7b to 12b2 of `2026-11-18-app-owned-families-design.md`): staff add, remove and reinstate guardians and rename a person in the portal (7b); a guardian's own Parent customer follows in QuickBooks where the books have a parent type and the family is linked (9h); a guardian's phone, mailing address and sign-in email are the portal's own and sent on to QuickBooks (11a to 11e); a guardian row stands on its family record and its own link and holds no QuickBooks id (12b1, 12b2: migration 0049 dropped `family_qbo_id` and `source_qbo_id`); a row a change of company closed keeps its history in no family, and a change of company closes no row now (stage 4's slice M7a).
**Builds on:** parent email-code sign-in (`2026-11-10-parent-email-code-sign-in-design.md`) and the QuickBooks
connection and roster (`2026-11-10-quickbooks-connection-and-roster-design.md`).
**Roadmap:** the first half of Plan 3. The second half (anything that writes to QuickBooks) is a separate
spec; see "Left out".

## Why

Parents can sign in with an email code, but only if somebody seeds them by hand with a script and types a
QuickBooks ID. The roster now shows who the club's families and parents are. This piece joins the two: a parent
who is in QuickBooks can sign in, with nobody on staff doing anything per parent, and the sign-in is tied to the
family's QuickBooks ID, which later pieces use to show a family its balance.

Facts from the owner that shape the design:

- **The data has gaps.** Some parents have no email address, some were never created, and some records repeat
  an address.
- **QuickBooks copies a family's contact details onto new sub-customers** in some cases when they are created
  in its screens. A repeated address is therefore often one address copied onto several records, not two
  people sharing a mailbox.
- **Testing a deployment must not email real parents.**
- **The club will move from a sandbox company to its real books,** and that move should not mean redoing every
  staff decision.

## Goals

- A parent in QuickBooks can sign in without staff inviting them.
- An Admin sees what would happen, and what needs cleaning up, before switching it on.
- A wrong or repeated address never shows one family's information to another family's parent.
- Welcome emails go out automatically, but only once an Admin has switched them on.
- Every change in who can sign in is in the audit log with its cause.
- The portal writes nothing to QuickBooks in this piece.

## Decisions the owner made

| # | Question | Decision |
|---|---|---|
| 1 | Scope | Sign-ins from the roster now; writing to QuickBooks is the next spec. |
| 2 | How a parent gets a sign-in | Automatic, after an Admin switches it on from a clean-up preview. |
| 3 | The same address under different families | Held for all of them until staff decide. |
| 4 | Welcome email | Automatic, behind its own Admin switch; staff can resend. |
| 5 | Losing access | Follows QuickBooks at each refresh. "No active students, no access" is a club setting, off by default. |
| 6 | Where the sign-in email lives | QuickBooks only. The portal has no page for changing a parent's address, for parents or staff, until the portal can write to QuickBooks. |
| 7 | A different QuickBooks company | All family access ends and people are kept; a match review carries decisions over. |
| 8 | Other membership shapes | Supported, per the table in §1. |
| 9 | Staff permissions | Switches are Admin only; parent access actions are a grantable permission. |
| 10 | Reminders about undecided items | None. One notice per item. |

## 1. Who gets access

### Candidates

A **candidate** is a QuickBooks customer whose email address can become a sign-in. Which customers are
candidates depends on the membership shape:

| Shape | Candidates | They sign in to |
|---|---|---|
| Layered, with a parent type | Each Parent customer, by its own email | The family it sits under |
| Layered, no parent type | Each address in the Family customer's email field | That family |
| Flat | Each member customer, by its own email | Their own record |

- In a layered club **with** a parent type, the Family customer's addresses are for invoices only. They never
  grant a sign-in, even when the family has no Parent customers; such a family is flagged as "nobody can sign in".
- A candidate's email field is used as follows. For a Parent customer or a flat member: the first address in
  the field is used, and a field holding more than one address is flagged. For a Family customer in a layered
  club with no parent type: every address in the field is used, because there is nowhere else for a second
  parent's address to go.
- Addresses are trimmed and lower-cased before any comparison. An entry that is not a valid address is unusable
  and flagged.

### The rule

A candidate has access to its family when all of these hold:

1. Parent sign-ins are switched on (§3).
2. The candidate and its family are both active in QuickBooks. (In a flat club the candidate is the family.)
3. It has a usable address.
4. The address is not held for this family (below), and the person is not blocked (§4).
5. If the club has switched on "no active students, no access", the family has at least one active Student
   customer. The setting can only be switched on when the shape names a student type.

### Held addresses

- **The same address under different families** is held: nobody at that address can sign in to any of those
  families until a staff member decides. The two decisions are **Same person** (the person gets all the listed
  families) and **Not the same person** (it stays held; the records need fixing in QuickBooks).
- A **Same person** decision is remembered for that address and that set of families. If the address later
  appears under a further family, only the new family is held, and it is a new item to review.
- A decision can be reversed. Reversing **Same person** holds the address again and ends the access it gave.
- A decision applies only to the families the page showed under the address. If the families under it changed
  after the page loaded (a refresh added or removed one), the decision is refused and staff reload the page.
- Only active candidates in active families count toward a hold: an inactive record, or a record under an inactive
  family, is refused for that reason and does not hold its address anywhere else.
- An address stays held across its families even when one of those families has no active student. The
  active-students setting (rule 5) is applied only to a claim that is not held.
- **The same address on two candidates in one family** is not held. It gives one sign-in for that family, and
  is flagged.

### People

A person in the portal is identified by email address, as today. One person can have access to several
families. The person's name comes from the QuickBooks candidate; when several candidates for the same address
have different names, the portal uses the one with the lowest QuickBooks ID (compared as a number) and flags it.

### What is flagged

Each of these is listed in the roster's existing Needs attention list, with what to change in QuickBooks:

- a candidate with no email address, or an unusable one;
- a Parent or flat-member record holding more than one address;
- the same address on two candidates in one family (the roster's existing rule, for records with identical email
  fields), and the same address on two records in one family whose email fields differ;
- an address held across families (also listed on the Parents page, §4);
- one address with different names;
- a family nobody can sign in to.

The held-address and different-names items name the person only: they show no address and no other family,
because Needs attention is shown to staff with only `Roster.Read`. The address and the families are on the
Parents page (§4).

## 2. The reconcile step

### When it runs

- Inside every roster refresh, in the same database transaction that swaps in the new copy of QuickBooks. Both
  succeed or neither does.
- When something else changes the answer: parent sign-ins are switched on, the active-students setting is
  changed, a held address is decided or reversed, a match is accepted (§6). Blocking and unblocking do not run
  it: a block leaves every link as it is and is checked at sign-in, so unblocking gives back the same access.
- While parent sign-ins are off it changes nothing. Sign-ins seeded by hand keep working until the switch is
  turned on, and are then closed by the first reconcile unless QuickBooks backs them.

### How it works

Two parts, kept separate:

- **The rules** are one function with no side effects. It takes the roster cache, the shape, the staff
  decisions and the settings, and returns who should have access to which family, plus everything to flag. The
  clean-up preview (§3) calls the same function.
- **The apply step** compares that answer with the stored people and family links and applies only the
  differences. Running it twice in a row changes nothing the second time.

It takes the roster lock that a refresh already holds, so two reconciles never run at once.

### What is stored

The existing `parent` (a person) and `guardian` (a person's link to a family) tables, with additions:

- **Family link:** the QuickBooks ID of the candidate it came from; and when closed, the reason: `inactive`,
  `family_inactive`, `no_email`, `held`, `no_active_students`, `address_changed`, `not_in_quickbooks`,
  `company_changed`. The existing reasons stay.
- **Person:** who blocked them, when, and the reason; when they were last sent a welcome email, and whether one
  is owed.
- **Decisions on held addresses:** a new table with one row per address and three sets of family QuickBooks IDs:
  approved (**Same person**), rejected (**Not the same person**) and announced (already in a review email, §5);
  with the staff member who last decided, the time and their note. A row is made when the address first becomes
  held.
- **Settings:** parent sign-ins on or off (and whether they were ever on); welcome emails on or off; require
  active students on or off; review notices by email on or off. With nothing stored, everything is off except
  review notices. A stored value that can't be read counts as sign-ins switched off after being on (the parent
  door closed, the reconcile stopped, no emails) until an Admin saves the settings again.
- **The previous company:** the snapshot kept after a company change (§6) is a setting, as is the time the last
  review email went (§5).
- **Matches:** a new table recording, for good, that an old company's family ID is a new company's family ID.

### Email changes

A family link follows its QuickBooks candidate. When that candidate's address changes:

- The person's address is changed in place only when all of these hold: nobody in the portal had the new address
  when the run started; nobody is given access with the old address in this run; and the person has no other
  link. Their history and "already welcomed" stay, and no email is sent. Changing an address in place signs the
  person out (their session was proved with the old address), deletes their unused sign-in codes and drops their
  pending email-change requests.
- Otherwise the link moves to the person who has the new address, creating that person if needed. A person
  created this way is new, and is owed a welcome when welcomes are on.
- Each of these is decided from the people as they were when the run started, never from changes the same run
  made, so one change cannot make room for the next. A record's own swap of addresses, or a chain of them within a
  family, therefore moves links rather than changing addresses in place, and can sign a parent out once.
- Links closed because a different company was connected (§6) take no part in matching by QuickBooks ID: their
  IDs belong to the old company.

A person's address comes from QuickBooks. The portal has no page where a parent or staff member changes it; the
Parents pages say that names and addresses are changed in QuickBooks. The library code for changing an address
in the portal (`changeParentEmailByStaff` and `src/lib/parents/email-change.ts`) is not called by any page and
is left for the spec that writes to QuickBooks.

### Closing a link

Closing a link ends that person's sessions for that family at once. When the cause goes away (the record is
made active again, the address is restored) the link opens again at the next reconcile. Someone already
welcomed gets no new welcome; someone never welcomed is owed one when welcomes are on.

### Welcome emails

The reconcile never sends mail. It marks a person as owed a welcome when they first get access to any family
and welcomes are on. The worker sends owed welcomes afterwards, a few per minute. A failed send is retried at
most once every 15 minutes, and holds nothing else up. A person is welcomed once, however many families
they have.

- Each welcome is claimed before it is sent, in one statement, so overlapping worker runs cannot email a person
  twice.
- A blocked person is never marked as owed a welcome, and blocking clears one that was owed. Unblocking marks the
  person as owed again when they were never welcomed, still have access to a family, and welcomes are on.
- **Resend welcome email** goes at once and does not depend on the welcome switch. It is refused for a blocked
  person, for a person with no open link, and once parent sign-ins have been on and are now switched off (the
  parent door is closed). Before sign-ins have ever been switched on a resend still goes, so a parent seeded by hand
  for testing can be welcomed.

### Failure

If the reconcile fails, the roster refresh fails the way it does today: the transaction rolls back, the old
roster and the old access stay, the failure is recorded, and the staff warning shows it. The app's log gets one
line, `[roster] reconcile failed`, with the error's class name and, for a database error, its SQLSTATE code and
constraint name; never its message, query or parameters, which can hold an address.

## 3. Turning it on

A new **Parents** settings page for Admins, in the pattern the QuickBooks page set: a plain view of what is set,
with the steps on their own page.

### Step 1: the clean-up preview

Worked out by the rules function against the current roster, each time the page opens:

- how many people would get access, to how many families;
- what needs fixing, as lists that open: held addresses, candidates with no address, records with more than
  one address, families nobody could sign in to;
- which existing sign-ins would end.

The sign-ins that would end come from a dry run of the real reconcile, run as if sign-ins were on and then rolled
back, so the preview and the switch can never disagree about them. It locks every link and person while it runs,
so it runs only on steps 1 and 2, and only while sign-ins are off; no other page runs it. The dry run never waits
for a roster refresh: while one is running, the list is shown as being worked out, and the page asks the Admin to
reload in a minute.

The counts leave out blocked people: they can't sign in and are never emailed.

Nothing here blocks switching on. People with problems cannot sign in until the data is fixed in QuickBooks or
a held address is decided.

### Step 2: parent sign-ins

Offered only when QuickBooks is connected, a shape is chosen, the roster was read in the last 48 hours and
outgoing mail works. The Admin confirms against the counts, and the reconcile runs.

Switching sign-ins **off** closes the parent door at once, signs parents out, deletes unused sign-in codes and
pauses the reconcile. It also switches welcome emails off and clears any owed welcomes, so switching sign-ins on
again never starts emailing families by itself. Links and history are kept. Switching on again goes through the
preview.

Before sign-ins have ever been switched on, the parent door is not closed: sign-ins seeded by hand keep working
(§2). A switch already in the state asked for (a second press, or a page left open) does nothing and records
nothing.

### Step 3: welcome emails

Off by default, and separate from step 2, so an Admin can test with real families before anyone is emailed.
The page shows how many people would be emailed now and shows the email. Switching on marks everyone with
access who has not been welcomed as owed one; after that each new person is. Switching off stops new welcomes.
Welcome emails cannot be switched on while parent sign-ins are off.

The welcome email names the club, gives the portal's address, says to sign in with this email address and a
code, and gives the club's reply address from Mail settings for questions. It holds no family details.

### The active-students setting

On the same page, off by default, offered only when the shape names a student type. Before the Admin confirms,
the page shows how many families and people it would close.

## 4. Staff pages

### Parents (staff menu, needs `Parents.ReadWrite`)

- **To review:** held addresses awaiting a decision. Each shows the address, the families it appears under and
  the names on those records, with **Same person** and **Not the same person**. A decision needs a short note,
  and applies only to the families the page showed: if they changed in the meantime it is refused, and staff
  reload (§1). A refused decision keeps the note as typed.
- **People:** everyone the portal knows, searchable by name or email: their families, whether they can sign in
  and why not, when they last signed in, when they were welcomed.
- **One person's page:** their families and status, with **Resend welcome email**, **Block** (with a reason
  only staff see) and **Unblock**. Opening it is audited as a staff read of family data.

**Blocking** applies to the person across all their families, takes effect at once, and signs them out. A
blocked person who tries to sign in gets the same message as an unknown address.

### The roster

- A family's page already has a **Portal sign-ins** box. It lists each person with a status and reason in plain
  words: "Can sign in", "Can't sign in: no email address in QuickBooks", "Held: this address is also under
  another family", "Blocked".
- Staff with `Parents.ReadWrite` get a link from each name to the person's page. Staff with only `Roster.Read`
  see the statuses and no links or actions. A held status never names the other family to staff who lack
  `Parents.ReadWrite`.
- Needs attention gains the kinds listed in §1.

### What staff cannot do here

Add a parent, or change a name, email or phone number. Each page says these are changed in QuickBooks, where
someone would look for the button.

### Parents

The family chooser and **Switch family** show the family's name from QuickBooks in place of
"Family account <ID>". A parent who is held, blocked or without access gets the same neutral message as an
unknown address.

## 5. Telling staff there is something to review

- **Staff home:** a standing notice, for example "Parent sign-ins: 3 addresses to review", for people with
  `Parents.ReadWrite`, linking to the Parents page. It shows whenever something is waiting.
- **Email:** sent to each staff member with `Parents.ReadWrite`, at the address they sign in with.
  - Only held addresses awaiting a decision count. Other problems are fixed in QuickBooks and stay in Needs
    attention.
  - Each held item is announced once. An email is sent only when at least one item has not been announced.
  - At most one email in any 24 hours; items that appear in between wait for the next one. The day's slot is
    taken before anything is sent, so overlapping worker runs send one email; if no email could be sent, the
    slot is given back and nothing is marked announced.
  - There are no reminders for items that stay undecided.
  - The email gives the number of new items, the number waiting in total, and a link. It names no family,
    person or address.
  - An Admin can switch the emails off on the Parents settings page. The home notice stays.

## 6. A different QuickBooks company

Disconnecting and reconnecting the same company changes nothing, as today.

### Before disconnecting

When parent sign-ins are on, the Disconnect confirmation says how many people have access and that connecting a
different company will end all of it.

### When a different company is connected

In the step that already clears the roster and the shape:

- every family link, open or already closed, is marked as belonging to the previous company (the reason
  `company_changed`); open ones are closed. Parents are signed out and unused sign-in codes are deleted;
- parent sign-ins and welcome emails are switched off;
- people are kept, with their history and blocks;
- a snapshot of the old company is saved: each family's name and QuickBooks ID, the names and addresses of the
  people who had access to it and when each was welcomed, and every **Same person** approval. A second company
  change replaces the snapshot;
- the live held-address records are deleted, and "already welcomed" is cleared for everyone. Rejected and
  undecided addresses are not kept: in the new company an address under two families is held by default. The
  approvals and welcome dates in the snapshot come back only through an accepted match.

A roster refresh that finds its cache came from a different company (because the clean-up at connect time failed
or never ran) runs the same clean-up itself, in the same transaction, before it stores the new roster. The
clean-up removes the shape, so that refresh stores the new roster without contact details (as with no shape),
and the shape must be chosen again before parent sign-ins can be switched on.

A link from the previous company keeps that company's family ID, which means some other family (or none) in the
new one. Such links are left out of a family's roster page and of Needs attention, and a person's page lists each
as "A family in the previous QuickBooks company", with no link.

### The match review

Offered on the Parents settings page once the new company's roster is read and a shape is chosen. It is optional.

- Each old family is shown beside its suggested counterpart in the new company, with the reason, for example
  "name matches, 2 of 2 addresses match".
- **Strong** suggestions (the name matches and every old address appears under the new family) can be accepted
  together. Others are accepted, pointed at a different family, or rejected, one at a time.
- Old families with no suggestion are listed as unmatched.

Accepting a match:

- records that the old family ID is now the new family ID, permanently, for later features that attach portal
  data to a family;
- carries over **Same person** decisions that involved that family, so those addresses are not held again, except
  where staff in the new company have already said **Not the same person** for that address and family: a match
  never overrides a refusal;
- restores "already welcomed" for its people from the snapshot;
- runs the reconcile.

A match never grants access. Access comes only from the new company's roster, through §3.

People who had access under the old company and are not part of an accepted match are treated as new if they
appear in the new company: they are owed a welcome once welcomes are on.

The snapshot holds the most recent previous company only. An Admin can delete it, and it is deleted
automatically 90 days after the switch.

## 7. Audit, permissions, and testing

### Audit

| What happened | Action |
|---|---|
| A switch or setting changed, with the counts shown | `settings.parents.save` |
| The reconcile made a person for an address it had not seen | `parent.create` |
| The reconcile opened or closed a link, with the reason | `parent.access.granted`, `parent.access.ended` |
| The reconcile pointed a link at a different QuickBooks record (taking over a hand-made sign-in, or following an address) | `parent.access.moved` |
| The reconcile changed a person's address in place | `parent.email.changed` |
| The reconcile changed a person's name to match QuickBooks | `parent.name.changed` |
| An address became held | `parent.hold.opened` |
| A held address decided or reversed, with the note | `parent.hold.decided` |
| A person blocked or unblocked, with the reason | `parent.block`, `parent.unblock` |
| A welcome sent, resent or failed | `parent.welcome.sent`, `parent.welcome.failed` |
| A review notice sent to staff | `parent.review.notified` |
| Staff opened a person's page | `parent.read` |
| A company change closed all access, with the counts | `parent.access.cleared` |
| A match accepted or rejected, with what was carried over | `parent.match.decided` |
| A code asked for, or a session used, while parent sign-ins are off | `signin.code_refused`, `signin.refused`, with reason `signins_off` |

The `settings.parents.save` row for switching sign-ins on records how many links opened and closed; the row for
switching them off records how many sessions ended and codes were deleted and, when welcome emails were on, that
they were switched off too and how many owed welcomes were cleared. `parent.access.cleared` records how many links,
people, sessions, codes, held addresses and welcome dates it cleared and what the snapshot kept;
`parent.match.decided` records how many approvals and welcome dates the match carried over, and how many approvals
it did not carry because staff in the new company had already said **Not the same person** for that address and
family.

Rows written by the reconcile are recorded as done by the system and name the roster run (or the staff action)
that caused them. No row holds an email body or a sign-in code.

The worker reports three jobs of this piece by name, each only when it did something or failed:
`parents.welcome` (welcomes sent or failed), `parents.review_notice` (a review email sent) and
`parents.snapshot_expiry` (the snapshot deleted after 90 days). Each is guarded on its own, so a failure in one
never stops the QuickBooks jobs.

### Permissions

- `Settings.Parents.ReadWrite`: the switches, settings and the match review. Admin only.
- `Parents.ReadWrite`: the Parents page and its actions. Grantable.
- `Roster.Read` (existing): statuses on a family's page.

### Existing code

`src/lib/parents/people.ts` holds block and unblock, which the Parents pages call; blocking takes a reason.
Resend welcome lives with the welcome emails in `src/lib/parents/welcome.ts`, and a person's page calls it. The
functions for inviting a guardian by hand, removing one, and closing a family's links when its students changed
were removed: links now come only from the reconcile. The review items recorded against that library (a welcome
sent after a block, the lock order between block and confirm, ignored send results) are fixed. Sign-in, the
family chooser and sessions are not changed, beyond showing family names and refusing while sign-ins are off.

### Testing

- The rules function: a table of small cases covering each shape, each reason for no access, each kind of
  repeated address, and the active-students setting on and off.
- The reconcile, against a real database: running twice changes nothing; address changes in place and by
  moving; a failure leaves the old roster and access; sessions end when a link closes.
- Welcome and review emails, with the local mail sink: once only, the one-a-day limit, nothing sent while the
  switch is off.
- Browser tests: the preview, both switches, deciding a held address, blocking, and the match review.
- A proof-of-concept run on linuxdev against the sandbox, with new checklist items in the runbook.

## Left out

- **Writing to QuickBooks:** adding a missing parent from the portal, and parents or staff editing contact
  details. Until then a missing parent is added in QuickBooks, followed by **Refresh now**.
- Balances and payments for parents.
- Students signing in.
- The single Settings page (parked by the owner until after v1).

## Guidance for the club

To go in the user documentation when it is written:

- A Parent customer holds **one** email address: that person's own.
- A Family customer may hold several, for invoices.
- When QuickBooks copies a family's contact details onto a new Parent or Student customer, replace them with
  that person's own, or clear them.

## Open questions for the plan

- The parser splits an email field on commas, semicolons and spaces, in any mix. A sandbox check of what
  QuickBooks actually stores is a proof-of-concept item.
- The sending rate for welcome emails is five a minute (one batch per worker wake). Whether that suits the
  mailbox's limits (Microsoft 365 and SMTP differ) is a proof-of-concept item.
- Owner to confirm: making a family active again in QuickBooks puts a shared address back under two families, so
  it is held again and the other family's access ends at the next refresh until staff decide.
- Owner to confirm: switching parent sign-ins off also switches welcome emails off, so an Admin who pauses
  sign-ins switches welcomes on again afterwards (§3). This was decided during the build so that switching sign-ins
  back on can never email families by surprise.

## Known gaps

Found by the whole-branch review on 2026-11-12. The first two were closed on 2026-11-15; the rest are not yet
fixed.

- **Closed: a sign-in code could go to an address that was just replaced.** A code request read the person's
  address before its own transaction, so a roster refresh that changed the address at that moment left a code
  that was mailed to the old address and worked with the new one. A code request now reads the address again
  under a lock that every change of address waits for, and mails only that address. A request made with an
  address that has just been replaced is refused like an address that was never on file. The same lock is
  taken once more when a code is right, after the session is stored: a code proved with the old address while
  the change was under way no longer becomes a session. It is refused and audited (`signin.refused`, reason
  `address_changed`).
- **Closed: a rare deadlock between a code request and an address change.** A code request now takes the
  person's row before it touches a code, the order every change of address uses, so neither side can hold what
  the other waits for. `tests/integration/signin-address-race.test.ts` runs a code request and a code check
  against a reconcile that is half way through a change of address.
- **An unreadable parents setting closes the parent door without saying why.** The pages show sign-ins as off;
  switching them on writes a good setting again. A company change in that state writes the closed setting back,
  which leaves staff review emails off. Only a hand-edited database row can cause it.
- **The same check is written in several places.** "This link is open", "this link is from the previous
  company" and the comparison of QuickBooks IDs as numbers each appear in several files, and the code calls one
  thing a guardian, a link and a sign-in. A tidy-up is owed; behavior is not affected.
- **Two wording slips** are in `docs/ui-backlog.md` (step 2 of the set-up steps; step 1 while sign-ins are on).
