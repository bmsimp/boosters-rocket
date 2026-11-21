# QuickBooks connection and roster — design

**Status:** approved by the owner on 2026-11-11; implemented by plan 2026-11-11-quickbooks-connection-and-roster.md, and proved against an Intuit sandbox company on the proof of concept on 2026-11-11 and 12 (its runbook, checks 10 to 17). The portal now also writes to QuickBooks, as the roadmap's steps 3, 5 and 6 describe.
**Changed since** (2026-11-19, stage 3 slice 9c of `2026-11-18-app-owned-families-design.md`): the roster cache is no longer
the club's families. The portal's own family and student records stand alone: a roster refresh stores the customer list and
changes no record or sign-in, follows no student moved in QuickBooks, and a customer renamed, moved, made inactive, added or
removed there changes nothing in the portal (stage 4 shows such a change as a difference); a staff write still goes to
QuickBooks first and then changes its own record. The cache still decides whose invoices each family sees.
**Changed since** (2026-11-20, stage 3 slices 9d to 12b2 of `2026-11-18-app-owned-families-design.md`): the roster pages
(Â§5) change the portal's records first: a family staff add is the portal's own (9d), sent to QuickBooks only by someone
who may link families; a rename of a linked record, and a student added to a linked family, are saved in the portal and
then sent with the link's own QuickBooks version (9e); a customer no family is linked to can be made a family with
"Create a family from this" (10); a guardian row is the portal's own, found by its family record and its own link, and
holds no QuickBooks id (12b1, 12b2).
**Revises:** the v1 design (`2026-11-06-booster-rocket-v1-design.md`), sections 3, 4, 7, 8.1, 8.4 and 14, as
listed in "Changes to the v1 design" below. It delivers the first half of the roadmap's Plan 2. The second
half (what a parent sees: balances, open invoices, Pay links) is a separate piece.

## Why

The portal knows a family only as a QuickBooks ID that somebody typed into a seed script. Nothing in the app
talks to QuickBooks, so staff can't see who the club's families, students and parents are, and the pieces that
come next (adding parents, showing balances) have nothing real to stand on.

Two facts from the owner shape this design:

- **Not every customer is a member.** FZN's QuickBooks company has five customer types: `Family`, `Student`,
  `Parent`, `School` and `Vendor`. Students and parents are sub-customers under a family. Schools and vendors
  are customers too, and have nothing to do with the portal.
- **Not every club is shaped like FZN.** Another club may bill each member as their own customer with no
  family level, or may not record students in QuickBooks at all. The club decides its own shape.

## Goals

- An Admin connects the club's QuickBooks company once, and the connection stays alive without anyone
  visiting the portal.
- The club defines the shape of its membership in terms of QuickBooks customer types.
- Staff see the club's families, students and parents (or its members), read-only, with a list of what
  needs cleaning up in QuickBooks.
- The portal writes nothing to QuickBooks in this piece.

> **Revised 2026-11-15:** the portal now writes one thing to QuickBooks. The owner decided on 2026-11-14 that parents
> edit their own phone and mailing address (v1 spec §6.2, §6.3): a sparse `Customer` update of `PrimaryPhone` and
> `BillAddr`, sent with the `SyncToken` the parent's form was shown, by one function (`qboUpdateCustomerContact` in
> `src/lib/quickbooks/client.ts`) that one module may call. Everything else here still only reads. The test that held
> the portal to reading (§3 Rules for the connection, §7) now holds it to that one write:
> `tests/unit/quickbooks-writes.test.ts`. The request and the Fault codes it relies on have not been tried against a
> real company: `CUSTOMER_UPDATE` in the client lists what the owner's sandbox check must confirm (§8 has no row for it).

## Not in scope

- **Anything a parent sees.** Balances, open invoices and Pay links are the next money piece.
- **Creating sign-ins from QuickBooks.** No portal person or guardian row is created, changed or disabled
  because of what QuickBooks holds. The piece after this one decides those rules, and adds "add a missing
  parent from the portal", which writes a Parent sub-customer to QuickBooks.
- **Sign-in under a flat shape.** Today's parent sign-in is built around a family. A flat shape is cached and
  shown to staff now; how its members sign in is decided with the next piece.
- **Students defined in the portal** for a club that leaves the student type blank, and any payment provider
  other than QuickBooks.
- **Redesigning the Sign-in and Mail settings.** Only the QuickBooks settings use the new pattern (§3).
- Writes to QuickBooks of any kind, the write queue, and the reconciliation of money.

## 1. The membership shape

The shape is a setting an Admin chooses after connecting. It names QuickBooks **customer types**. A type is
stored by QuickBooks' ID for it, never by its name, so renaming a type in QuickBooks doesn't break the
setting.

### Flat

The Admin picks one or more customer types. Every customer of one of those types is a **member**. There is
no family level.

### Layered

The Admin picks:

- the **family** type (required);
- the **student** type (optional);
- the **parent** type (optional).

Then:

- a **family** is a customer of the family type;
- its **students** are the sub-customers directly under it that have the student type;
- its **parents** are the sub-customers directly under it that have the parent type.

Leaving the student type blank means the club doesn't identify students in QuickBooks. Leaving the parent
type blank means its parents exist only in the portal. Both blank is allowed.

For FZN the shape is layered, with `Family`, `Student` and `Parent`. `School` and `Vendor` are in no rule, so
those customers never appear in the portal.

### Rules

- A customer type can be used in only one role. The same type can't be both family and student.
- A customer the shape doesn't name is **outside the portal**: it isn't shown to staff and the portal keeps no
  contact details for it (§2).
- Changing the shape later is allowed. It takes effect at once on what staff see, and starts a refresh (§4)
  so contact details are fetched for customers the new shape names and dropped for those it no longer does.
- A shape that names a type QuickBooks no longer has is shown as broken on the settings view and in the staff
  warning (§5), and the roster pages say the shape needs attention instead of showing a wrong list.

## 2. The cache

The cache is a **reference copy** of what QuickBooks holds. It is never a source of truth, and it does not
replace the portal's own records: the `parent` and `guardian` tables remain the record of who may sign in and
which QuickBooks ID they belong to. That ID is what later pieces use to fetch a family's open invoices.

### Tables

**`qbo_connection`** (at most one row):

```
realm_id                 the QuickBooks company's ID
environment              sandbox | production
company_name
access_token             sealed
access_expires_at
refresh_token            sealed
refresh_expires_at       from Intuit's token response
connected_at, connected_by (staff user)
last_token_refresh_at
last_error, last_error_at   a short fixed sentence and a code, never a response body
```

The Intuit client ID and client secret are stored with it. The secret and both tokens are sealed with
`SETTINGS_ENCRYPTION_KEY`, each with its own purpose string, the way other secrets are. None of them is ever
sent to a browser, logged or audited.

**`qbo_customer_type`:** QuickBooks ID, name, active, `refreshed_at`.

**`qbo_customer`:**

```
qbo_id            primary key
display_name
active
parent_qbo_id     the customer it sits under, if any
type_qbo_id       its customer type, if any
email, phone      only for customers the shape names; null for everyone else
sync_token
qbo_updated_at    QuickBooks' own last-changed time
refreshed_at
```

**`job_run`:** job name, started, finished, outcome (`ok` or `failed`), a short detail. One row per run (§4).

### What is kept, and for whom

- Every customer's ID, name, active flag, parent and type are kept, because the shape step needs the whole
  picture to count and preview, and a shape change must not need a second trip to QuickBooks to know what
  exists.
- **Email and phone are kept only for customers the shape names** (families, students, parents, or flat
  members). The portal holds no contact details for schools, vendors or anyone else outside the shape.
- Addresses, notes, balances and everything else on the customer are not kept.

### Refreshing

- A refresh reads every customer type and every customer, active and inactive, a page at a time in `Id` order (so
  no customer is skipped or repeated between pages), and replaces the cache in one transaction. A customer
  QuickBooks no longer returns is removed from the cache.
- Only one refresh runs at a time. A second request while one is running reports that one is under way.
- A failed refresh leaves the previous cache in place, records the failure, and raises the staff warning (§5).
- **The cache records which company it came from** (the `roster.source` setting, written with every cache swap). While
  QuickBooks is connected, a cache from another company, or one that doesn't say which, is shown as not read yet, with
  none of that company's run history. The membership shape and the customer types are hidden with it, because their
  type IDs belong to that company: the roster page and the settings view say the shape hasn't been chosen yet. A
  refresh notes the company when it starts and fails, keeping the old cache, if the connected company changed before
  it saves.
- Names and every other QuickBooks field are free text that anyone with QuickBooks access can edit. They are
  always rendered as text, never as HTML.

## 3. Connecting QuickBooks

### The settings view

**QuickBooks** in the staff menu (Admins only) opens a plain view of the current state:

- connected or not, and the company's name;
- sandbox or production;
- when the connection was last refreshed, and when it expires;
- the chosen shape, in words ("Layered: families are *Family*, students are *Student*, parents are *Parent*");
- when the roster was last refreshed, with how many families, students and parents (or members) it found.

Nothing on this view is an input. It has two actions: **Set up** (or **Change**), which opens the steps below,
and **Disconnect**.

This is the first use of the settings pattern the owner asked for: a static view of what is set, with a
step-by-step flow to set it up or change it. Sign-in and Mail keep their current pages until the design pass.

### The steps

1. **Intuit app.** Enter the client ID and client secret from the club's Intuit developer app, and choose
   sandbox or production. The page shows the exact redirect address to paste into the Intuit app, with a
   Copy button. A saved secret is never shown again; leaving the field blank keeps it.
2. **Sign in to Intuit.** A button sends the Admin to Intuit to choose the company and approve access. On
   return the portal exchanges the code for tokens, stores them sealed, reads the company's name, and reads
   the customer types and customers for the first time.
3. **Membership shape.** The Admin chooses flat or layered and picks from the customer types found. Before
   saving, a preview shows the counts ("42 families, 61 students, 55 parents; 9 customers outside the
   portal") and the first few names in each role, so a wrong choice is obvious. Saving stores the shape and
   starts a refresh.

Each step says what it is for and what happens next. A step can't be reached before the one before it is
done, by button or by URL. **Change** opens the steps with the current values filled in, and can start at
any step already completed.

### Rules for the connection

- The portal asks Intuit for the accounting scope only. Intuit has no read-only form of it, so the portal is
  trusted not to write: in this piece no code path sends a create, update or delete to QuickBooks, and a test
  holds that (§7). *Since 2026-11-15 one update is sent, a parent's own phone and address; see the note under Goals.*
- The request to Intuit carries a single-use `state` value tied to the Admin who started the connect, and the return
  is refused if it doesn't match, was started by someone else, has been used, or is more than 10 minutes old.
- The redirect address is `<portal URL>/api/quickbooks/callback`.
- Connecting to a different company than the one already connected is refused with a clear message: the
  Admin must disconnect first. This stops a wrong click from silently replacing the club's roster.
- **Connecting a different company after a disconnect starts clean.** Before the first read, the portal clears the
  cache, the membership shape (customer type IDs belong to one company) and the roster's run history, and records
  `roster.cleared`. Reconnecting the same company clears nothing. Portal sign-ins keep the QuickBooks IDs they carry;
  what happens to them when the company changes is decided with the next piece.
- **A connect refused after Intuit issued tokens leaves no grant behind.** When the code was exchanged and the portal
  then doesn't keep the tokens (another company got connected, or the keys changed, while Intuit was answering; or
  storing them failed), it asks Intuit to revoke them. This is best effort: it never changes the refusal the Admin
  sees, and the audit row records whether Intuit confirmed it. A return refused before the exchange (a bad or stale
  `state`, a refusal at Intuit, a company ID that isn't one) has no tokens to revoke.
- **One exception: a failed store while renewing.** Intuit's revoke can cancel the company's whole grant to the app.
  So when storing fails and the portal still holds a connection to that same company (the Admin was signing in again
  to renew it), nothing is revoked and the connection that was there carries on. The failure is still recorded
  (`store_failed`), and the Admin sees the error.
- **Disconnect** asks Intuit to revoke the tokens, then deletes them from the portal. The client ID and
  secret are kept. The cache is kept but every roster page says it is no longer current, with the date.
- All QuickBooks calls happen on the server. The browser never receives a token or the client secret, and no
  settings or roster page shows the company's ID. The ID is recorded in the audit log when a company is connected
  or disconnected (§6).

## 4. Staying connected: the worker

The same container image, started in worker mode, runs as a second container. It is the worker the v1
design describes; this piece gives it its first two jobs.

| Job | Due when | Does |
|---|---|---|
| Token refresh | The last successful run was more than 24 hours ago | Refreshes the access token and saves the new refresh token |
| Roster refresh | The last successful run was more than 24 hours ago | Refreshes the cache (§2) |

- The worker wakes every minute, runs whichever jobs are due, and records each run in `job_run`. "Due" is
  measured from the last successful run, so there is no time-of-day or time zone in it.
- A job that fails is tried again on the next wake, at most once every 15 minutes, until it succeeds. The exception
  is a connection that needs an Admin: while the recorded error says Intuit no longer accepts the connection
  (`invalid_grant`) or the saved keys can't be read (`unreadable`), the worker runs neither job and records nothing.
  The staff warning stays up, **Refresh now** still tries, and connecting again clears the error.
- **Every token refresh saves the refresh token Intuit returns**, because the old one stops working. The
  refresh takes a lock on the connection row first, so the worker and a staff request can't both spend the
  same refresh token.
- The access token is also refreshed on demand: any QuickBooks call that finds it expired, or within five
  minutes of expiring, refreshes it first under the same lock.
- **Refresh now** on the roster pages runs the roster refresh at once, for staff who hold `Roster.Read`. It is
  limited to one run every five minutes.
- If the worker isn't running, nothing else breaks: on-demand token refresh and **Refresh now** still work,
  and the staff warning says the roster is getting old.
- The worker has no HTTP port and no job logic: every minute it asks the app, over the deployment's private network,
  to run whichever jobs are due. Its health is the age of its last recorded wake, shown on the settings view.

## 5. What staff see

### The roster pages (read-only)

A **Roster** entry in the staff menu, for anyone who holds `Roster.Read`.

**Layered shape:**

- **Families:** each family's name, whether it is active, and its student and parent counts. A search box
  filters by name.
- **A family's page:**
  - its students: name, active or not;
  - its parents, as QuickBooks lists them: name, email, phone, active or not;
  - **the portal sign-ins attached to this family** (the `guardian` rows carrying its QuickBooks ID): name,
    email and status, so staff can see who can sign in beside who QuickBooks lists.
- **Needs attention** names a person by name only. A portal sign-in whose QuickBooks ID isn't a family is listed by
  the person's name, with no email address.

**Flat shape:**

- **Members:** each member's name and whether they are active. A member's own page shows their email and phone
  and the portal sign-ins attached to that customer ID.

Both:

- Inactive customers are marked, not hidden.
- Every roster page has a "How fresh this is" section: when the roster was last read, the latest failure if there
  was one, and a **Refresh now** button (not offered while QuickBooks is disconnected). When QuickBooks is disconnected, every roster page also shows a dated
  notice that the roster is no longer current, with who can reconnect it.
- Before QuickBooks is connected or a shape is chosen, the pages say so and point Admins to the settings view.
- Opening a family's page (or a member's details) is recorded in the audit log as a staff read of family data.

### Needs attention

A list on the Roster pages, built from the cache and the portal's own tables. It changes nothing; it is the
club's clean-up list.

| Shape | Rule |
|---|---|
| Layered | A family with no parent under it (only when a parent type is set) |
| Layered | A family with no student under it (only when a student type is set) |
| Layered | A student or parent that isn't directly under a family |
| Layered | A customer of the family type that is itself a sub-customer |
| Layered, flat | A parent, or a flat member, with no email address |
| Layered, flat | Two parents in the same family, or two flat members, with the same email address (trimmed and lowercased). The same address on parents in different families is not a problem: that is one person in two families |
| Layered, flat | A portal sign-in whose QuickBooks ID isn't a family (or a member) in the cache |
| Layered, flat | An inactive family (or member) that still has a portal sign-in that isn't disabled |

Each row names the customer and says what is wrong in plain words. Inactive customers are left out of the
first six rules, since nobody needs to clean those up.

### The staff warning

Admins see a warning on the staff home, like the mail warning, while any of these is true:

- QuickBooks was connected and the last token refresh failed;
- the connection expires within 30 days;
- the last roster refresh failed, or the roster is more than 48 hours old;
- the shape names a customer type QuickBooks no longer has.

The warning says which, and links to the QuickBooks settings view. A site that has never connected QuickBooks
shows no warning; the settings view just says "not connected".

## 6. Permissions and audit

| Permission | Lets a person | Who can hold it |
|---|---|---|
| `Settings.QuickBooks.ReadWrite` | Open the QuickBooks settings, connect, disconnect, change the shape | Admins only, like sign-in and mail: it controls access to the club's books |
| `Roster.Read` | See the roster pages and Needs attention, and use **Refresh now** | Any role an Admin gives it to |

Audited, with the actor, the target and the request IP:

| Action | When |
|---|---|
| `settings.quickbooks.save` | The client ID, secret or environment was saved. Records that the secret changed, never the secret |
| `quickbooks.connect` | A company was connected. Records the company's name, ID and environment |
| `quickbooks.connect_refused` | A return from Intuit was refused (bad or stale `state`, a different company, Intuit said no), or storing the connection failed (reason `store_failed`). Records the reason, Intuit's error code when it gave one, and, when the portal asked Intuit to revoke tokens it had been issued and didn't keep, `revoked`: whether Intuit confirmed it (left out when no revoke was tried) |
| `quickbooks.disconnect` | The connection was removed |
| `settings.membership.save` | The shape was saved. Records the shape before and after, with type names |
| `quickbooks.token_refresh.failed` | A token refresh failed. Records Intuit's error code. Always recorded as the worker, whoever's request needed the refresh, and only when the error differs from the one already recorded |
| `roster.refresh` | A refresh finished: who or what started it (a person, or the worker), and the counts |
| `roster.refresh.failed` | A refresh failed. Records the error code |
| `roster.cleared` | Connecting a different company cleared the old company's cache, shape and roster run history. Records the Admin who connected, the reason and the company IDs |
| `roster.family.read` | A staff member opened a family's page, or a member's details |

A successful scheduled token refresh is recorded in `job_run`, not in the audit log, so one row a day doesn't
bury everything else. No audit row or log line ever holds a token, the client secret, or a QuickBooks
response body.

## 7. Testing

**Integration tests** (real Postgres, a stub QuickBooks and Intuit server passed in through function
arguments, as the mail tests do):

- The connect flow: the request carries a `state`; a return with a wrong, reused or stale `state` is refused
  and audited; a good return stores sealed tokens and the company; a different company is refused.
- Token refresh saves the new refresh token; two refreshes at once spend the refresh token once; an expired
  access token is refreshed before a call; a refused refresh raises the warning and is audited.
- The roster refresh pages through every customer, active and inactive; replaces the cache; removes customers
  QuickBooks no longer returns; keeps the old cache when it fails; and won't run twice at once.
- Email and phone are stored only for customers the shape names, and are dropped when a shape change stops
  naming them.
- Both shapes: flat with one and with several types; layered with all three types, with the student type
  blank, with the parent type blank, and with both blank. Customers outside the shape appear nowhere.
- Each Needs attention rule, in both directions.
- The worker: a job runs when it is due and not before, a failure is retried no more often than every 15
  minutes, and each run is recorded.
- Permissions: `Settings.QuickBooks.ReadWrite` can't be put in a custom role; a person without `Roster.Read`
  is refused the roster pages; the invariants test covers the new server actions; opening a family's page
  writes the read audit row.
- **Nothing writes to QuickBooks:** a test fails if any request the client sends, other than to Intuit's
  token and revoke endpoints, uses a method other than GET. *Since 2026-11-15 the test also allows the one
  customer update, sent by one function that one module may call; see the note under Goals.*
- No token, secret or response body reaches a log line or an audit row.

**End-to-end:** an Admin opens the settings view on a site that is already connected, walks the three steps without
leaving for Intuit, previews a shape, and opens a family's page. The return from Intuit, saving the shape and
refreshing are covered by integration tests through the real route handler and actions, because the app has no
switch that points it at a stub.

**Proof of concept** on linuxdev, against the owner's Intuit sandbox company with the development keys:

- connect, choose the layered shape with the sandbox's types, and see families with their students and parents;
- the worker refreshes the token and the roster on its own the next day;
- disconnect and reconnect;
- the audit entries are checked.

## 8. Verified before building on it

Short checks against the Intuit sandbox, done first in the plan, because the design depends on them. If one
fails, the section it bears on is revised before its code is written.

| Question | Why it matters | Answer (2026-11-11, sandbox company) |
|---|---|---|
| Can customer types be listed through the API (`select * from CustomerType`), and does each customer carry its type (`CustomerTypeRef`)? Is a minor version needed? | §1. Intuit's own reference wasn't found for this on 2026-11-10; only third-party references say so | **Yes to both.** The query answered 200 with each type's `Id`, `Name` and `Active` (IDs look like `1000000002`). Typed customers carry `CustomerTypeRef.value` equal to a type's `Id`; untyped customers have no `CustomerTypeRef`. Checked with `minorversion=75` |
| Do sandbox companies have customer types, or must they be created by hand first? | §7. The proof of concept needs a sandbox shaped like FZN | **By hand.** The sandbox's sample customers have no type. The owner created `Family`, `Parent`, `Student`, `School` and `Vendor` and a few typed customers |
| What does the token response give for the refresh token's expiry, and is there a hard limit beyond the rolling 100 days? | §4 and §5. Third-party guides report a 5-year limit from a November 2025 policy change; Intuit's FAQ still says a rolling 100 days. The portal uses whatever expiry the response states | `expires_in` is `3600` and `x_refresh_token_expires_in` is `8726400` seconds (101 days). The response states no hard limit, so the portal goes by the stated expiry on each refresh |
| How many customers can one query page return, and does `Active IN (true, false)` return inactive customers? | §2. The old CiviCRM extension paged by 100 and used that filter | **1000 a page** (`maxresults 1001` is refused: "Max allowed value is 1000"). The filter returns inactive customers, with `Active` as the JSON boolean `false`. Paging is only safe with an order, so the portal sends `select * from Customer where Active in (true, false) orderby Id startposition N maxresults 1000`; that string was accepted and returned the customers in `Id` order (compared as numbers) |
| Does a sub-customer's `ParentRef` always point at its direct parent, and how are deeper levels reported? | §1. "Directly under a family" must mean what QuickBooks means | `ParentRef.value` is the direct parent's `Id`, and each sub-customer also carries `Level` (1 for a direct sub-customer) and `Job: true`. The sandbox had no customer two levels down, so deeper levels weren't seen; the portal goes by `ParentRef` alone |

Also seen in the sandbox, and worth knowing:

- **QuickBooks adds " (deleted)" to an inactive customer's name.** The inactive test customer came back as
  `Inactive Test (deleted)` in `DisplayName` and `FullyQualifiedName`. The portal shows the name as QuickBooks gives it,
  beside its own "Inactive in QuickBooks" mark.
- The fields the cache reads are all present under the names the design assumed: `Id`, `DisplayName`, `Active`,
  `ParentRef.value`, `CustomerTypeRef.value`, `PrimaryEmailAddr`, `PrimaryPhone`, `SyncToken` and
  `MetaData.LastUpdatedTime` (an ISO time with an offset, for example `2026-11-11T01:43:03-08:00`).

## 9. Changes to the v1 design

| v1 section | Change |
|---|---|
| §3 Architecture | The worker exists from this piece on, with two jobs |
| §4 Data model | "Family = top-level customer, student = sub-customer" becomes "the club's membership shape decides" (§1). Parents can exist in QuickBooks as sub-customers of a parent type. `qbo_customer_cache` becomes `qbo_customer` and `qbo_customer_type`. `qbo_connection` and `job_run` are defined here |
| §7 Permissions | Adds `Settings.QuickBooks.ReadWrite` (Admin-only) and `Roster.Read` |
| §8.1 Connection | As §3 and §4 here. The Intuit client ID and secret are entered on the settings view, not set in a file |
| §8.4 Scheduled jobs | The first two rows exist; the rest arrive with their own pieces |
| §14 Operations | "QuickBooks connection" joins the runbook list |

The roadmap (`2026-11-07-v1-roadmap.md`) changes with it: Plan 2 splits into this piece and "Money for
parents"; Plan 3 becomes "Parents from QuickBooks: sign-ins for Parent customers, and adding a missing parent
from the portal"; and Plan 0's External ID spike is dropped, since the email-code design replaced it.
