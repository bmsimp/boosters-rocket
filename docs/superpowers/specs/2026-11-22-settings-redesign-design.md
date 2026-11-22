# Staff Settings, one place: design

Date: 2026-11-21, approved 2026-11-22 with the owner's answers written in ("Decisions", at the end; where they differ from the draft, the body says what was decided). Builds on the v2 look (`PageHeader`, `Card`, `List`/`ListRow`, `StatusBadge`, `SectionLabel`, `KeyValue`). The mockup and the owner's example screenshot were review material and are not kept in the repo.

## Why

The staff menu has a **Settings** entry and an **Admin** group (Staff, Roles, Audit, Health, and Design system on the v2 branch). Both hold "how the portal is set up", so staff have two places to look. Settings itself is a grid of six boxes with no sense of which part is a connection to another system. This makes Settings the one place: a left rail of everything a person may see, each item with a one-line status, and the systems the portal talks to gathered under **Integrations**, each opening its own page.

## Information architecture

The rail is titled **Settings**, with **Find a setting** at the top. Small group labels sit over the items, in sentence case (the v2 rules forbid uppercase labels; the example's capitals are dropped). Each item shows a status in words with a dot after it. The dot only repeats the words: green for done, amber for needs attention, gray for off or not set up.

| Group | Item | Address | Status line (words) | Where it comes from |
| --- | --- | --- | --- | --- |
| Club | Club | `/staff/settings/club` (unchanged) | "Set" / "Not set yet" / "Color not valid" | `getClubSettings()`, `clubSaved()` |
| People and access | Staff | `/staff/settings/staff` (was `/staff/people`) | "6 people" | `listStaff()` |
| | Roles | `/staff/settings/roles` (was `/staff/roles`) | "4 roles" | `listRoles()` |
| | Parent sign-ins | `/staff/settings/parents` (unchanged) | "On, Standard" / "On, Strict" / "Off" / "Level unreadable" | `readStoredSettings()` |
| Connections | Integrations | `/staff/settings/integrations` (new) | "All connected" / "1 needs attention" / "2 not set up" | the four integration statuses below, counted |
| Administration | Audit log | `/staff/settings/audit` (was `/staff/audit`) | "Last entry 4 min ago" | one new small read: the newest audit row's time |
| | Health | `/staff/settings/health` (was `/staff/health`) | "All working" / "2 need attention" | `healthReport()`, counted the way the Health page counts |
| | Design system | `/staff/settings/design-system` (v2's `/staff/design-system`) | "Samples only" (gray) | nothing read |

**Integrations** (one page, sections by kind, each with a one-line description, a plain rule and a bordered `List`):

| Kind, and its rule | Row | Opens | Status (words) | Source |
| --- | --- | --- | --- | --- |
| Accounting: "One QuickBooks company is connected at a time. Moving to another company is its own step." | QuickBooks Online | `/staff/settings/quickbooks` | "Connected" / "Needs attention" / "Not connected" / "Not set up", plus a "Sandbox" badge when it is the test company | `connectionView()`, `quickbooksProblems()` |
| Forms and signing: "The club's own Documenso, at the address you give." | Documenso | `/staff/settings/forms` | "Connected" / "Not checked yet" / "Last call failed" / "Token can't be read" / "Not set up" | `formsSummary()`, `apiFailing()` |
| Outgoing mail: "One way of sending is used at a time." | Microsoft 365 | `/staff/settings/mail` | the chosen method: "Working" / "Not tested" / "Last email failed"; the other: "Not in use" | `mailSummary()`, `mailAttention()` |
| | SMTP | `/staff/settings/mail` | as above | as above |
| Staff sign-in: "Staff can sign in with either or both." | Microsoft | `/staff/settings/sign-in` | "Working" / "Certificate expires Dec 2" (amber when expiring) / "Expired" / "Can't be read" / "Not set up" | `providerSummaries()`, `credentialStanding()` |
| | Google | `/staff/settings/sign-in` | the same, for the client secret | as above |

Each row has a logo tile (the vendor's own mark, decision 3), the name, one line of what the portal does with it, the status and a chevron. The whole row is one link. Parent sign-ins is not an integration: it is the portal's own.

**No Season or Money group.** The only club-wide setting outside Settings today is the volunteer cancelling cut-off, which sits on Volunteering, and stays there (decision 5). Seasons, Balances and the rest are work, not setup, and stay in their menus.

**`/staff/settings` itself.** On a desktop it shows the rail and an **Overview** pane: the items that need attention, each as a row that links to it, or a done notice saying "Everything that is set up is working." On a phone it is the rail (see Mobile). The six-box grid goes away.

## Permissions

The rail shows only the items a person may open, and the menu shows **Settings** when they may open at least one. No new permission is needed.

| Item | Who sees it | Who can change it |
| --- | --- | --- |
| Club | `Settings.Club.Read` | `Settings.Club.ReadWrite` |
| Staff | `Staff.Users.Read` | `Staff.Users.ReadWrite` (Admin only) |
| Roles | `Admin.Roles.ReadWrite` (Admin only) | the same |
| Parent sign-ins | `Settings.Parents.ReadWrite` (Admin only) | the same |
| Integrations, and each integration page | anyone holding at least one of `Settings.QuickBooks.ReadWrite`, `Settings.Forms.ReadWrite`, `Settings.Mail.ReadWrite`, `Settings.SignIn.ReadWrite` (all Admin only); the list shows only the rows they hold | the row's own permission |
| Audit log | `Audit.Log.Read` (Admin only) | nothing can be changed |
| Health | `Admin.Health.Read` (Admin only) | nothing to change |
| Design system | `Settings.Club.Read` (as on v2) | nothing to change |

**View but not change.** Only Club and Staff split seeing from changing today. Someone who may see but not change gets the same page with its change buttons left out, and one quiet line where they would be: "Only someone who may change club settings can change these." The Club page already does this; the Staff page does it by leaving out its forms. Buttons are hidden rather than disabled: a disabled control can't take the focus, so a screen reader user would never hear why it is there. Every ADMIN_ONLY permission stays Admin only, and every page keeps its own `requireStaffPage()` guard. The rail is navigation, not a guard.

**The Overview's guard.** `/staff/settings` keeps `Settings.Club.Read`. Someone who holds only `Staff.Users.Read` has a Settings menu entry that goes straight to Staff, their first item, so nobody is sent to a refusal. `staffMenu()` computes this from the item list.

**Possible later permission (not now): `Settings.Integrations.Read`.** It would let a treasurer see whether QuickBooks is connected without changing anything. Decision 2: integration status is for Admins only for now, and no permission is added.

## Integration pages

Every integration keeps its own page, and its setup steps stay at `.../setup` as today. Each page gets the same shape, built only from what the current page already shows:

1. **Header**: `PageHeader` with the logo tile, the name, one quiet line, and a `StatusBadge`. The way back is "Integrations".
2. **Connection**: a `KeyValue` card with what is set. QuickBooks: company, which QuickBooks, client ID, connected, last renewed, expires. Documenso: address, API token saved, last answered, webhook secret, last webhook. Mail: sends with, mailbox or server and from, password readable, last tested, last sent. Staff sign-in: tenant ID, client ID, certificate thumbprint and expiry, or secret saved and expiry.
3. **Health**: the matching line of `healthReport()` for that system (its words, its times, its fix link). These are the same words the Health page uses, shown where they can be acted on. Staff sign-in has no Health line, so its expiry is shown here instead.
4. **Change**: the "Change" or "Set up" button to the steps. QuickBooks keeps its extra cards (membership shape, roster, the portal's requests, switch company).
5. **Disconnect or remove**, only where it exists today: QuickBooks' Disconnect, with its warning about parents who can sign in, and Staff sign-in's remove button. Documenso and mail have no disconnect, and this redesign adds none.

Staff sign-in shows two rows and keeps one page with two cards (decision 7). Both rows point at that page, at each provider's card (`#staff-microsoft`, `#staff-google`).

## Search

**Find a setting** filters the rail as the person types. It runs in the browser only, with no request. It matches each visible item's name and a short fixed list of keywords kept beside it in the item list. Examples: Club takes "name, color, time zone, treasurer"; Integrations takes "QuickBooks, Intuit, books, Documenso, forms, mail, SMTP, Microsoft 365, Google, Entra"; Health takes "backup, worker, version"; Audit log takes "export, history". A match on an integration's keyword also shows that integration as a result under Integrations, so typing "smtp" leads to Mail. The search component is sent only the names, keywords and addresses of items the person may see, and nothing else (every prop reaches the browser). Enter opens the first result. "No setting matches" shows when nothing does. Escape clears the box.

## Mobile

Below 760px, `/staff/settings` is the rail as the first screen: the search, then the groups, each item a full-width 44px+ row with its status under its name. Each item opens as its own page with "Settings" as the way back (today's `BackToSettings`, shown on phones only). An integration page's way back is "Integrations". On the Integrations page, each row keeps the tile and the name, with the status under the one-line description; the chevron stays. The rail is never drawn beside a page on a phone. Walk it at 390 wide as usual.

## What changes in code and tests

- **Item list.** `SETTINGS_SECTIONS` becomes `SETTINGS_ITEMS` in `settings/sections.ts`. Each item has a key, group, title, keywords, the permission to see it, the permission to change it, its address and the address prefixes it owns. The four integrations get an `integration` kind with their own permission each. `settingsSections()` becomes `settingsItems(e)`. `tests/unit/settings-sections.test.ts` is rewritten for it.
- **Menu.** `staffMenu()` drops the Admin group. Settings is one entry, current for any address under `/staff/settings/`, with its address chosen as described under Permissions. Update `tests/integration/staff-menu.test.ts` (the Admin line goes; Settings is current on Health, Audit, Staff and Roles) and `GROUPS`/`TOP` in `tests/e2e/staff-menu.spec.ts` (it opens `/staff/health`: use the new address). Update AGENTS.md's staff page checklist ("Home, Families, Season, Money, Settings as one entry, Admin" becomes "...Settings as one entry"; "a new settings page is a section in `SETTINGS_SECTIONS`" becomes an item in `SETTINGS_ITEMS` with its group and keywords).
- **Layout.** A new `settings/layout.tsx` draws the rail on desktop and loads each visible item's status in parallel, reusing today's `LOADERS` from `settings/page.tsx`. Like the parent layout, it is not a guard: each page keeps `requireStaffPage("...")` as its first line, and `tests/integration/page-guards.test.ts` scans the moved pages as it does now. `healthReport()` runs on every Settings page for Admins. If that is slow, the rail's Health status gets a lighter count of its own.
- **Moves, with no redirects (decision 1).** `people/` moves to `settings/staff/`, `roles/` to `settings/roles/`, `audit/` (and `audit/export/route.ts`) to `settings/audit/`, `health/` to `settings/health/`, and v2's `design-system/` to `settings/design-system/`. The old addresses answer 404: the portal is in initial development, so nothing outside it holds them yet. Update the hard-coded links: `signin-resets.tsx`, `secret-expiry.tsx`, `mail-warning.tsx`, `quickbooks-warning.tsx`, `roster/freshness.tsx`, the people page's link to Roles, `src/lib/health/*` fix links (most already point at `/staff/settings/...`, which keep their addresses), the runbooks and `docs/walkthrough.md`. `ROUTE_HANDLERS` in `page-guards.test.ts` gets the audit export's new path. The QuickBooks callback (`/api/quickbooks/callback`) and every existing `/staff/settings/<key>` address stay as they are.
- **New page.** `settings/integrations/page.tsx` is guarded by `Settings.QuickBooks.ReadWrite` (decision 4). It is added to `tests/e2e/staff-pages.spec.ts`, `settings.spec.ts` and the a11y walk.
- **Styles.** One Settings block in `booster.css`: the rail, the pane, the status dot, and the logo tile (a white tile holding the vendor's mark, never recolored; a neat text tile where no official mark is kept). Rows are `List`/`ListRow` with `StatusBadge`-style words. The gallery gets a sample of the rail and an integration row. `DESIGN.md` ("Staff menu (grouped)", "Settings view") and `docs/agents/ui.md` change in the same slices.
- **Tests that move with the pages:** `settings-page.test.ts` (Overview instead of boxes), `staff-menu.test.ts`, `journey-staff.spec.ts` (if it walks Admin), and `docs/conformance.md` rows for the menu and Settings.

## Slices

Each slice is one screen. All of them need v2 merged first.

1. **Item list and menu.** Add `SETTINGS_ITEMS`. `staffMenu()` loses the Admin group. Move Staff, Roles, Audit, Health and Design system under `/staff/settings/`, with no redirects. The pages themselves don't change yet. Update the menu tests, page-guards and the docs.
2. **The rail (desktop).** Add `settings/layout.tsx` with the groups, statuses and dots, and the Overview pane at `/staff/settings`. `BackToSettings` becomes phone-only.
3. **The Integrations page.** Sections by kind with their rules, and the rows. The old grid's integration boxes go.
4. **Integration pages, same shape.** (a) QuickBooks. (b) Documenso and Mail. (c) Staff sign-in, with the anchors.
5. **Find a setting.** Keywords in the item list, and the client filter.
6. **Mobile pass.** The rail as the first screen, ways back, and a walk at 390 and 1440.

## Decisions (the owner's answers, 2026-11-22)

1. **Old addresses.** Staff, Roles, Audit log and Health move under `/staff/settings/...` with no redirects from the old addresses: "Let's do this clean since we're still in initial development." Every link, test and doc that names an old address is updated.
2. **Read-only integrations.** Integration status is for Admins only for now. No new permission.
3. **Logos.** Integration rows use the vendors' real marks (QuickBooks, Documenso, Microsoft, Google), and a generic mail icon for SMTP, kept in the app as static SVG files: each vendor's official mark as published for this kind of use, small, never recolored. `brand/README.md` names their sources and that they belong to their owners. Where an official SVG can't be had without a new dependency or a doubtful download, a neat text tile stands in and the gap is a follow-up.
4. **The Integrations page's guard** is `Settings.QuickBooks.ReadWrite` (the lead's default; every integration permission is Admin only, so it is the same as "holds any of" today).
5. **Volunteer cut-off** stays on Volunteering (the lead's default).
6. **Design system** lives under Administration in Settings.
7. **Staff sign-in** is one page with two cards, Microsoft and Google (the lead's default).

## Open questions as drafted

1. **Old addresses.** Is it fine for Staff, Roles, Audit and Health to move under `/staff/settings/` with permanent redirects? The alternative keeps their addresses and wraps them in the rail without moving them, but the current menu item then has to be worked out by a list instead of by the address.
2. **Read-only integrations.** Should a non-Admin (say the treasurer) see integration statuses? That needs a new grantable `Settings.Integrations.Read`. My recommendation is no for now: Health and the staff home warnings already tell Admins.
3. **Volunteer cut-off.** Should "Volunteer cancelling" move from Volunteering into Settings under Club? My recommendation: leave it where people manage events.
4. **The Integrations page's guard.** `requireStaffPage` takes one permission, and only Admins hold the integration permissions. Is it fine to guard the page with one of them (`Settings.QuickBooks.ReadWrite`), rather than add a "holds any of" guard? A custom role can't hold any of them, so the two are the same today.
5. **Logos.** Monogram text tiles ("QB", "D", "M", "G") in the product too, or real vendor logos? Text tiles avoid trademark questions and load nothing from outside.
6. **Design system** under Administration in Settings, or removed from the staff menu before release?
7. **Staff sign-in** as one page with two cards, or one page per provider (Microsoft, Google)?
