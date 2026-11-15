<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Booster Rocket: rules for agents

Booster Rocket is an open-source, self-hosted parent portal for booster clubs: each family signs in and sees only its own students, what it owes and what it must sign, while staff manage the roster. QuickBooks Online holds the club's books and the roster; the portal reads them and keeps a cache.

**Where the truth lives**
- `PRODUCT.md`: users, principles, terms, voice. `DESIGN.md` and `src/app/booster.css`: the visual system.
- `docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md`: the v1 spec. Later specs in that folder override the parts they name, and win where they disagree: `2026-11-10-parent-email-code-sign-in-design.md` (parents sign in with the portal's own emailed code, not Entra External ID), `2026-11-10-quickbooks-connection-and-roster-design.md`, `2026-11-11-parents-from-quickbooks-design.md`.
- `docs/superpowers/plans/2026-11-07-v1-roadmap.md`: what is built and what is next. Read it for current status.

**How work is done**
- One screen-sized slice at a time, from a short brief. Tests are written with the code. No long plans with code in them.
- Do the slice in the brief and nothing else. Say in your report what you left undone, and anything that surprised you.

### Privacy rules that are never traded
- The family comes only from the session: `ctx.familyQboId` from `requireParentPage()` or `parentAction`. An id from the URL, a form or an action argument is untrusted: look it up within that family, and answer `notFound()` or refuse when it isn't there.
- Staff-only query modules are never imported by parent code: `src/lib/roster/queries.ts` (`loadRosterPage`, `rosterEntry` load every family) and, in `src/lib/parents/directory.ts`, `listPeople`, `getPerson`, `heldReview`, `familySignins` (the note at the top of the file). A parent page reads through a query that takes the family id and returns that family alone.
- QuickBooks text (names, emails, memos) is rendered as text only: never `dangerouslySetInnerHTML`, never built into HTML, a URL or CSS.
- Pass a client component only what it shows: every prop is sent to the browser, rendered or not.
- Nothing family-specific is ever cached in a service worker or a shared cache. Route handlers that return data send `cache-control: no-store`. The one exception is the club's app icons (`src/app/icons/[name]/route.ts`): public, the same for everyone, and kept by their `?v=` version.
- The service worker (`public/sw.js`) stores one thing, `/offline.html`, and does one thing: it answers a page navigation that failed for lack of a connection with that page. It has one `cache.put`, no `add` or `addAll`, and no `respondWith` for anything but `mode === "navigate"`; it never stores a page, the data a page loads, an API answer or a script. Never add a caching strategy to it. `tests/unit/pwa-static.test.ts` reads the file for this, and `tests/e2e/pwa.spec.ts` signs a parent in, browses, and checks the caches hold `/offline.html` and nothing else. `public/offline.html` is the same for every club and person: no club name, no family data, no script.
- No secret reaches the browser: `scripts/check-client-bundle.mjs` searches the built client files for the secret values. Never read `process.env` or `@/env` in a client component.

### Checklists
New parent page (`src/app/(parent)/**/page.tsx`; example `src/app/(parent)/payments/page.tsx`):
- Make the first line of the page `const ctx = await requireParentPage("/its-address");`: the page's own address, written out as a string, so a visitor who has to sign in or choose a family first is brought back to it. A dynamic segment passes a template that starts with the fixed part: `` requireParentPage(`/forms/${id}`) ``. Only Home (`/`) calls it with no argument. `tests/integration/page-guards.test.ts` refuses a missing address, another page's, or one it can't read; `tests/integration/parent-isolation.test.ts` checks the redirect carries it.
- The parent layout is not a guard: it calls `parentLayoutCtx()` (`src/lib/guards.ts`), draws the frame for a signed-in parent and never redirects. Do not put `requireParentPage()` in a layout: its redirect runs before the page's and cannot name the page.
- The return path travels through the browser, so it is checked at every read by `safeReturnPath()` (`src/lib/auth/return-path.ts`): only a plain parent path on this site gets through, and anything else lands on `/`. Never redirect to a `next` value that has not been through it. A new top-level folder in `src/app` outside `(parent)` that holds a page or a route handler is added to `NOT_PARENT_SECTIONS` there (`tests/unit/return-path.test.ts` fails until it is).
- Read data with `ctx.familyQboId` only. Do not audit a parent viewing their own family.
- A page that gets a tab: add it to `PARENT_NAV` (`src/app/components/parent-nav.ts`; its icon goes in `parent-tabs.tsx`) and to the expected list in `tests/unit/parent-nav.test.ts`, and take it out of the 404 list in `tests/e2e/public-pages.spec.ts`.
- A query module for parent pages outside `src/app/(parent)/`: list it in `PARENT_CODE_ELSEWHERE` (a file) or `PARENT_FACING_LIB` (a folder) in `tests/integration/page-guards.test.ts`, so the staff-only import scan reads it.
- A dynamic segment: add its params to `PARAMS` in both `tests/integration/parent-isolation.test.ts` and `tests/e2e/parent-session.spec.ts` (there with ids from `scripts/seed-e2e.ts`). Each fails until it has them.
- New kinds of family data: seed them for both families in `seedTwoFamilies()` and add their strings to the markers.
- New `scripts/seed-e2e.ts` data for any family but `E2E-FAMILY`: add its strings to `OTHER_FAMILIES` in `tests/e2e/parent-session.spec.ts`, the only test that reads the props sent to client components.

New parent server action (no `parentAction` example exists yet; the closest is `src/app/choose-family/actions.ts` with `src/lib/parents/family-choice.ts`):
- Put `"use server"` first, in a file under `src/app/(parent)/`; export only functions wrapped in `parentAction`.
- Check every argument's type and size: it comes from the browser, whatever the type says. Re-check every id against `ctx.familyQboId`.
- Write the audit row in the same transaction as the write. Return the result shape below.

New staff page (`src/app/staff/(app)/**/page.tsx`; example `src/app/staff/(app)/roster/[id]/page.tsx`):
- Make the first line `const ctx = await requireStaffPage("Area.Object.Level");` with a permission from `src/lib/permissions/registry.ts`, written as a string.
- A page that shows one family's or one person's data writes an audit row before it shows anything (`roster.family.read`, `parent.read`).

New staff server action (example `src/app/staff/(app)/parents/actions.ts`, with the write in `src/lib/parents/people.ts`):
- Put `"use server"` first; export only `staffAction("Permission", ...)` functions. Check every argument (`NOT_FROM_PAGE` in the example).
- Do the write in `src/lib/`, in one `db.transaction`, with `writeAudit(entry, tx)` inside it (actor, permission, before, after, ip).
- Call `revalidatePath`, then return the result shape.

New route handler (`route.ts`; examples `src/app/api/internal/worker/route.ts`, `src/app/api/quickbooks/callback/route.ts`):
- Prefer a page or a server action. A handler has no guard wrapper: check the session or token in the handler itself, first.
- Machine-facing endpoints live under `/api/`; anything else is redirected to `/setup` while setup is open (`src/proxy.ts`).
- List it in `ROUTE_HANDLERS` in `tests/integration/page-guards.test.ts` with how it is guarded and the test that proves it.

Rules for all of them:
- Audit: `writeAudit` in the same transaction as every write. A staff read of one family's or person's data is audited. A parent viewing their own family is not.
- Action result: `{ ok: true, message }` or `{ ok: false, errors }` (`errors` is a list of sentences to show). Client forms call actions through `safely()` from `src/app/components/action-error.ts`.
- A guard refusal says the same thing whatever the reason. Never tell a parent why, or that another family exists.

### Money
- Amounts are integer cents everywhere in the portal. `toCents()` converts a QuickBooks number once, where it comes in, and `formatMoney(cents, currency)` is the only formatter (`src/lib/money/cents.ts`). Never add or compare dollars, and never format an amount yourself. The currency is the invoice's own (`currencyOf`), USD when absent.
- A parent page shows money through `loadFamilyMoney(ctx.familyQboId)` (`src/lib/money/family-money.ts`) and the components in `src/app/(parent)/money-box.tsx`: `<MoneyBox ctx={ctx} />` on Home, `MoneySection` and `PaidSection` on Payments. Do not query invoices from a page. A page shows a family's money only when `loadMyFamily()` returns the family: Home and Payments ask it first, and show `NotSetUpBox` and no money when it returns null.
- `family_money` holds one row per family: the last successful read (invoices as shown, total, `BalanceWithJobs`, currency, company, time) and the last failed try. A page load shows a fresh row at once (`money.settings` `{ freshSeconds }`, default 300); otherwise it makes one live read with a short timeout, and on failure shows the last figures marked not current with Pay switched off. The total is the sum of the open invoices shown, not QuickBooks' balance.
- The note on figures that are not current is the same whatever the cause (an outage, a connection only an Admin can mend, another read under way): it never says QuickBooks is down and never promises when paying will be back (`DESIGN.md`, Money lines).
- Whose invoices: the family customer and its active direct sub-customers of the student or parent type (flat: the member alone), read from the roster cache for the session's family, and only for an active family. Nothing in a request selects a customer. An id goes into query text only after `isQboId()` (digits only).
- Each stored invoice names the customer it was raised on (`customerQboId`). A row that holds an invoice of a customer the cache no longer puts in the family (a student moved or made inactive) is treated as absent, however fresh (`mayShow`), and saving a membership shape deletes every row.
- `BalanceWithJobs` counts every customer under the family at every depth, so it is read and compared (the credit line, the `money.balance_mismatch` audit) only when the cache holds nothing under the family but the customers whose invoices make up the total (`balanceCoversTheSame`).
- Never the wrong company: no live read unless QuickBooks is connected to the company the roster cache came from, and a stored row from another company is treated as absent.
- A Pay button's address goes through `safePayLink()` (`src/lib/money/pay-link.ts`): https on `intuit.com` or a subdomain, or no button. Due dates are said in words by `DueLine` (`src/app/(parent)/due-line.tsx`), which uses the viewer's own today.
- QuickBooks reads for money go through the GET-only client (`qboInvoices`, `qboCustomerById` in `src/lib/quickbooks/client.ts`). The invoice query strings (`INVOICE_QUERIES`) have not been tried against a real company yet (roadmap, checks table): do not change them without trying the new string in the sandbox.
- An answer whose emptiness a parent would read as "nothing owed" is read strictly (`strictRowsOf`): only a 200 whose `QueryResponse` is an object holding no rows means no invoices. Any other 200 is refused (`bad_answer`, or `fault` for a Fault), never taken for an empty list. A new read that a parent sees does the same.
- A read made for a page load passes `failFast`. It never waits for the connection row lock: a token that is still good is read without it, and one that needs refreshing is refreshed once for all the page loads in the process, taking the row only if it is free (`busy` otherwise). Never call `accessToken()` from code a parent page runs: it waits its turn for that lock, through another caller's request to Intuit.

### Database and migrations
- Conventions in `src/lib/db/schema.ts`: singular snake_case tables and columns; uuid primary keys with `defaultRandom()` for the portal's own records and `bigserial` for logs; `timestamp(..., { withTimezone: true })` with the `created()` and `updated()` helpers; enums as `text(..., { enum })`; QuickBooks ids as text in `*_qbo_id` columns; emails stored trimmed and lower-cased; sealed secrets as `*_ciphertext` plus `*_key_id`; indexes named `<table>_<what>_ix` and `_uq`; a comment above each table saying what it holds.
- Generate with `pnpm db:generate --name <snake_name>`. If drizzle-kit asks whether something was renamed, stop: split the change into an additive migration and a finishing one (see `0004_parents_additive`, `0005_parents_finish`).
- Never edit an applied migration: `0000` to `0009` are deployed, and `0010_family_money` is merged on `parent-portal`. New changes start at `0011`.
- Only one agent at a time may add migrations. In a parallel worktree, change `schema.ts` and generate a migration for your own test database, and say so in your report: migrations are regenerated when branches are merged.

### Tests
- Commands: `pnpm lint`, `pnpm typecheck`, `pnpm test` (vitest, unit and integration against a real Postgres), `pnpm vitest run <files>`, `pnpm e2e` (Playwright).
- The full suite is slow and serial (about 7 minutes; allow 10). While working, run the files you touched plus `tests/integration/invariants.test.ts`, `tests/integration/page-guards.test.ts` and `tests/integration/parent-isolation.test.ts`. Run the full suite before you finish.
- Postgres is the container `booster-rocket-db-1` on `127.0.0.1:5433` (user and password `booster`). The default test database is `booster_test`; the tests empty it again and again (`resetDb()` in `tests/helpers/db.ts`), so never point them at data you want.
- A private database: `docker exec booster-rocket-db-1 psql -U booster -d booster -c 'CREATE DATABASE "booster_<name>_test" OWNER booster'`, then `export TEST_DATABASE_URL=postgres://booster:booster@localhost:5433/booster_<name>_test`. The name must be short, lowercase letters, digits and underscores, ending in `_test`. Setting `DATABASE_URL` does nothing: vitest's config overrides it. Drop the database when you are done.
- A worktree: `git worktree add .worktrees/<name> -b <branch>`; inside it `pnpm install --frozen-lockfile --prefer-offline`; create a private database and export `TEST_DATABASE_URL` (vitest refuses the shared `booster_test` in a worktree). When its work is committed, remove it with `git worktree remove .worktrees/<name>`, and delete the folder if Windows leaves `node_modules` behind.
- e2e: export the env vars of the E2E step in `.github/workflows/ci.yml`, then `pnpm build`, `pnpm tsx scripts/seed-e2e.ts` (it migrates, empties the database, then seeds), `pnpm e2e` (about a minute and a half once built). That is the main tree: database `booster_test`, the app on port 3100, the mail sink on 2465.
- e2e in a worktree runs beside the others on its own database and ports. Export the same vars with `DATABASE_URL` naming the worktree's private database, plus `E2E_PORT=<port>`, `E2E_MAIL_PORT=<port>` and `APP_URL=http://localhost:<E2E_PORT>`: two ports no other tree uses (3101 to 3199 and 2466 to 2599). Seed and run with the same vars. The seed and `playwright.config.ts` refuse the shared `booster_test` in a worktree, and an `APP_URL` that is not the run's own address. Do not run `pnpm db:migrate` there: nothing checks its database.
- A vitest run on the same database wipes the e2e seed: seed again. Specs take addresses from `baseURL` and ports from `tests/e2e/run-config.ts`, never a number of their own. Both passes of a run (phone, then desktop) read one seed, so a spec leaves the seeded data as it found it, or passes from either state.
- Signed-in parent, vitest: `seedSignedInParent()` and `seedTwoFamilies()` in `tests/helpers/parent.ts` (also `seedParentIn()` for a family the test put in the cache itself, and `identityNow()` after changing a link); then import `tests/helpers/signed-in.ts` before anything from `src/` and call `asParent(identity)` (also `asParentChoosing`, `asRefusedParent`, `asStaff`, `renderPage`, `pageOutcome`, `redirectOf`, `revalidatedPaths`). Example: `tests/integration/parent-helpers.test.ts`.
- The real session read (sign-in, renewal, the cookie): import `tests/helpers/page-request.ts` instead and call `fromBrowser(cookie)`. It replaces `next/headers` only, and cannot be imported into the same test file as `signed-in.ts`. Example: `tests/integration/parent-door.test.ts`.
- Money in tests: `seedTwoFamilies()` stores fresh figures for both families (`seedFamilyMoney()`, `moneyMarkers()`); their ids are not digits, so nothing is ever asked of QuickBooks for them. To read through the stub, use the families in `tests/helpers/money.ts` (`RIVERA`, `CHENOWETH`, with `connectCompany(stub)`, `stubInvoice()`, `ageMoney()`, `setFreshSeconds()`); `stub.oddInvoiceAnswer` makes the stub answer an invoice query with a 200 of any shape. A stored invoice must name a customer of its family (`customerQboId`), in `seedFamilyMoney()` and in `scripts/seed-e2e.ts`, or the row is not shown. A test file that renders a page showing money with QuickBooks connected mocks `@/lib/quickbooks/endpoints` onto the stub (top of `tests/integration/payments-page.test.ts`), so a read can never reach Intuit. `seedRosterRead()` (`tests/helpers/roster-cache.ts`) records a finished refresh and the company it read.
- Signed-in parent, Playwright: `await context.addCookies([parentSessionCookie()])` from `tests/e2e/parent-session.ts` (Zelda, family `E2E-FAMILY`, seeded by `scripts/seed-e2e.ts`); staff: `staffSessionCookie()`.
- Fake QuickBooks with `startQboStub()` from `tests/helpers/qbo-stub.ts` and `vi.mock("@/lib/quickbooks/endpoints", ...)` (top of `tests/integration/roster-pages.test.ts`). Fake mail with `vi.mock("@/lib/mail/senders", ...)` and an outbox (`tests/integration/parent-door.test.ts`), or the real SMTP sink in `tests/helpers/mail-sink.ts`.
- No environment switch and no test-only branch under `src/`: tests replace modules from outside (`tests/unit/no-test-mail-path.test.ts`).

### Tripwire tests
A new feature will meet these. Changing one is a deliberate act named in the slice brief, never a fix made in passing:
- `tests/unit/quickbooks-read-only.test.ts`: the portal writes nothing to QuickBooks. It scans `src/lib/quickbooks`, `roster`, `jobs` and `money`: a new folder that calls QuickBooks is added to it.
- `tests/unit/parent-nav.test.ts`: the parent tabs are the pages that exist (Home, Payments, Family), each with a page on disk and an icon. `tests/e2e/public-pages.spec.ts`: the list of pages that answer 404 until they are built (`/forms`).
- `tests/integration/page-guards.test.ts`: the lists of pages outside the guarded trees, route handlers, staff-only imports and parent code outside `(parent)`; and the rule that a parent page passes its own address to its guard.
- `tests/unit/return-path.test.ts`: what `safeReturnPath()` refuses, and `NOT_PARENT_SECTIONS` against the folders of `src/app`.
- `tests/unit/pwa-static.test.ts`: what the service worker stores, the security headers in `next.config.ts`, the proxy's matcher, and the installed-app block being last in `booster.css`.
- `tests/e2e/parent-session.spec.ts`: `OTHER_FAMILIES`, with a test that fails when the seed gives another family a customer or an invoice the list would not find.
- `tests/e2e/quickbooks.spec.ts` and `tests/e2e/parents.spec.ts`: roster counts that follow from `scripts/seed-e2e.ts`. Change the seed and the counts together.

### UI
- Use only the tokens and components in `DESIGN.md` and `src/app/booster.css`. No hex colors in components: the club's color is set at runtime.
- Font sizes in rem, never px. Tap targets at least 44px. Every status is words, plus an icon where there is room; color never carries meaning alone.
- Show an instant with `LocalTime` and a calendar date with `CalendarDate` (`src/app/components/`), not with your own formatting. Show an amount with `formatMoney()`.
- `src/app/booster.css` ends with two marked blocks: Home and Family, then the installed app (safe areas, the install hint), which must stay last. `env(safe-area-inset-*)` for the top and sides appears only in that last block.
- Installed app: the manifest (`src/app/manifest.ts`) and the icons are built on each request from the club's settings and hold no hostname. Icon names are `ICONS` in `src/lib/pwa/icons.ts`. `InstallHint` and `RefreshOnResume` (`src/app/components/pwa/`) are given no club or family data.
- Copy follows the voice in `PRODUCT.md`: a warm, plain neighbor, kind about money. US English.

### Git
- Commit messages: `type(scope): what is now true`, a short body saying why, and the trailer `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. See `git log`.
- LF line endings. Small commits. Leave the tree clean. Do not reformat files you are not changing.
- No new dependency unless the brief names it.
- Never push, open a pull request or deploy unless the brief says the owner allowed it.
