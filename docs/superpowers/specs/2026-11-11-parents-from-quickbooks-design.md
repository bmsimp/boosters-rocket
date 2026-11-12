# Parents from QuickBooks — design

**Status:** approved by the owner on 2026-11-11. No plan is written yet.
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
| 6 | Where the sign-in email lives | QuickBooks only. The portal's change-my-email feature is off until the portal can write to QuickBooks. |
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
- the same address on two candidates in one family;
- an address held across families (also listed on the Parents page, §4);
- one address with different names;
- a family nobody can sign in to.

## 2. The reconcile step

### When it runs

- Inside every roster refresh, in the same database transaction that swaps in the new copy of QuickBooks. Both
  succeed or neither does.
- When something else changes the answer: a switch or setting in §3 is changed, a held address is decided or
  reversed, a person is blocked or unblocked, a match is accepted (§6).
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
  `no_email`, `held`, `no_active_students`, `not_in_quickbooks`, `company_changed`. The existing reasons stay.
- **Person:** who blocked them, when, and the reason; when they were last sent a welcome email, and whether one
  is owed.
- **Decisions on held addresses:** a new table: the address, the set of family QuickBooks IDs, the decision,
  the staff member, the time, and their note.
- **Settings:** parent sign-ins on or off; welcome emails on or off; require active students on or off; review
  notices by email on or off.

### Email changes

A family link follows its QuickBooks candidate. When that candidate's address changes:

- If the person has no other link under the old address and the new address belongs to nobody else in the
  portal, the person's address is updated in place. Their history and "already welcomed" stay, and no email is
  sent.
- Otherwise the link moves to the person who has the new address, creating that person if needed. A person
  created this way is new, and is owed a welcome when welcomes are on.

The portal's own change-my-email feature (parent or staff) is switched off for people whose links come from
QuickBooks. The pages say that the address is changed in QuickBooks.

### Closing a link

Closing a link ends that person's sessions for that family at once. When the cause goes away (the record is
made active again, the address is restored) the link opens again at the next reconcile, with no new welcome.

### Welcome emails

The reconcile never sends mail. It marks a person as owed a welcome when they first get access to any family
and welcomes are on. The worker sends owed welcomes afterwards, a few per minute. A failed send is retried at
most once every 15 minutes, and holds nothing else up. A person is welcomed once, however many families
they have.

### Failure

If the reconcile fails, the roster refresh fails the way it does today: the transaction rolls back, the old
roster and the old access stay, the failure is recorded, and the staff warning shows it.

## 3. Turning it on

A new **Parents** settings page for Admins, in the pattern the QuickBooks page set: a plain view of what is set,
with the steps on their own page.

### Step 1: the clean-up preview

Worked out by the rules function against the current roster, each time the page opens:

- how many people would get access, to how many families;
- what needs fixing, as lists that open: held addresses, candidates with no address, records with more than
  one address, families nobody could sign in to;
- which existing sign-ins would end.

Nothing here blocks switching on. People with problems cannot sign in until the data is fixed in QuickBooks or
a held address is decided.

### Step 2: parent sign-ins

Offered only when QuickBooks is connected, a shape is chosen, the roster was read in the last 48 hours and
outgoing mail works. The Admin confirms against the counts, and the reconcile runs.

Switching sign-ins **off** closes the parent door at once, signs parents out and pauses the reconcile. Links and
history are kept. Switching on again goes through the preview.

### Step 3: welcome emails

Off by default, and separate from step 2, so an Admin can test with real families before anyone is emailed.
The page shows how many people would be emailed now and shows the email. Switching on marks everyone with
access who has not been welcomed as owed one; after that each new person is. Switching off stops new welcomes.

The welcome email names the club, gives the portal's address, says to sign in with this email address and a
code, and gives the club's reply address from Mail settings for questions. It holds no family details.

### The active-students setting

On the same page, off by default, offered only when the shape names a student type. Before the Admin confirms,
the page shows how many families and people it would close.

## 4. Staff pages

### Parents (staff menu, needs `Parents.ReadWrite`)

- **To review:** held addresses awaiting a decision. Each shows the address, the families it appears under and
  the names on those records, with **Same person** and **Not the same person**. A decision needs a short note.
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
  - At most one email in any 24 hours; items that appear in between wait for the next one.
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

- every family link is closed with the reason `company_changed`, and parents are signed out;
- parent sign-ins and welcome emails are switched off;
- people are kept, with their history, blocks and "already welcomed";
- undecided and decided held-address records are kept for the match review;
- a snapshot of the old company is saved: each family's name and QuickBooks ID, and the names and addresses of
  the people who had access to it.

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
- carries over **Same person** decisions that involved that family, so those addresses are not held again;
- keeps "already welcomed" for its people.

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
| The reconcile opened, closed or moved a link, with the reason | `parent.access.granted`, `parent.access.ended`, `parent.email.changed` |
| A held address decided or reversed, with the note | `parent.hold.decided` |
| A person blocked or unblocked, with the reason | `parent.block`, `parent.unblock` |
| A welcome sent, resent or failed | `parent.welcome.sent`, `parent.welcome.failed` |
| A review notice sent to staff | `parent.review.notified` |
| Staff opened a person's page | `parent.read` |
| A company change closed all access | `parent.access.cleared` |
| A match accepted, changed or rejected | `parent.match.decided` |

Rows written by the reconcile are recorded as done by the system and name the roster run that caused them. No
row holds an email body or a sign-in code.

### Permissions

- `Settings.Parents.ReadWrite`: the switches, settings and the match review. Admin only.
- `Parents.ReadWrite`: the Parents page and its actions. Grantable.
- `Roster.Read` (existing): statuses on a family's page.

### Existing code

`src/lib/parents/people.ts` already holds block, unblock, resend-welcome, remove-guardian and
students-changed functions that no page calls yet. This piece uses or replaces them; the review items recorded
against that library (a welcome sent after a block, the lock order between block and confirm, ignored send
results) are fixed as part of it. Sign-in, the family chooser and sessions are not changed, beyond showing
family names.

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

- Whether Intuit returns several addresses in one email field separated by commas, semicolons or both. The
  parser accepts both; a sandbox check confirms what QuickBooks stores.
- The sending rate for welcome emails against the mailbox's limits (Microsoft 365 and SMTP differ).
