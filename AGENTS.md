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
- Nothing family-specific is ever cached in a service worker or a shared cache. Route handlers that return data send `cache-control: no-store`.
- No secret reaches the browser: `scripts/check-client-bundle.mjs` searches the built client files for the secret values. Never read `process.env` or `@/env` in a client component.

### Checklists
New parent page (`src/app/(parent)/**/page.tsx`; example `src/app/(parent)/page.tsx`):
- Make the first line of the page `const ctx = await requireParentPage();`. The layout's guard does not count.
- Read data with `ctx.familyQboId` only. Do not audit a parent viewing their own family.
- A dynamic segment: add its params to `PARAMS` in `tests/integration/parent-isolation.test.ts`.
- New kinds of family data: seed them for both families in `seedTwoFamilies()` and add their strings to the markers.

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

### Database and migrations
- Conventions in `src/lib/db/schema.ts`: singular snake_case tables and columns; uuid primary keys with `defaultRandom()` for the portal's own records and `bigserial` for logs; `timestamp(..., { withTimezone: true })` with the `created()` and `updated()` helpers; enums as `text(..., { enum })`; QuickBooks ids as text in `*_qbo_id` columns; emails stored trimmed and lower-cased; sealed secrets as `*_ciphertext` plus `*_key_id`; indexes named `<table>_<what>_ix` and `_uq`; a comment above each table saying what it holds.
- Generate with `pnpm db:generate --name <snake_name>`. If drizzle-kit asks whether something was renamed, stop: split the change into an additive migration and a finishing one (see `0004_parents_additive`, `0005_parents_finish`).
- Never edit an applied migration: `0000` to `0009` are deployed.
- Only one agent at a time may add migrations. In a parallel worktree, change `schema.ts` and generate a migration for your own test database, and say so in your report: migrations are regenerated when branches are merged.

### Tests
- Commands: `pnpm lint`, `pnpm typecheck`, `pnpm test` (vitest, unit and integration against a real Postgres), `pnpm vitest run <files>`, `pnpm e2e` (Playwright).
- The full suite is slow and serial (about 5 minutes). While working, run the files you touched plus `tests/integration/invariants.test.ts`, `tests/integration/page-guards.test.ts` and `tests/integration/parent-isolation.test.ts`. Run the full suite before you finish.
- Postgres is the container `booster-rocket-db-1` on `127.0.0.1:5433` (user and password `booster`). The default test database is `booster_test`; the tests empty it again and again (`resetDb()` in `tests/helpers/db.ts`), so never point them at data you want.
- A private database: `docker exec booster-rocket-db-1 psql -U booster -d booster -c 'CREATE DATABASE "booster_<name>_test" OWNER booster'`, then `export TEST_DATABASE_URL=postgres://booster:booster@localhost:5433/booster_<name>_test`. The name must be short, lowercase letters, digits and underscores, ending in `_test`. Setting `DATABASE_URL` does nothing: vitest's config overrides it. Drop the database when you are done.
- A worktree: `git worktree add .worktrees/<name> -b <branch>`; inside it `pnpm install --frozen-lockfile --prefer-offline`; create a private database and export `TEST_DATABASE_URL`. When its work is committed, remove it with `git worktree remove .worktrees/<name>`, and delete the folder if Windows leaves `node_modules` behind.
- e2e runs from one tree at a time: it uses fixed ports 3100 (the app) and 2465 (the mail sink). With the env vars from `.github/workflows/ci.yml` on the command line, run `pnpm build`, `pnpm db:migrate`, `pnpm tsx scripts/seed-e2e.ts`, then `pnpm e2e`. A vitest run on the same database wipes the e2e seed: seed again.
- Signed-in parent, vitest: `seedSignedInParent()` and `seedTwoFamilies()` in `tests/helpers/parent.ts`; then import `tests/helpers/signed-in.ts` before anything from `src/` and call `asParent(identity)` (also `asParentChoosing`, `asRefusedParent`, `asStaff`, `renderPage`, `pageOutcome`, `redirectOf`, `revalidatedPaths`). Example: `tests/integration/parent-helpers.test.ts`.
- Signed-in parent, Playwright: `await context.addCookies([parentSessionCookie()])` from `tests/e2e/parent-session.ts` (Zelda, family `E2E-FAMILY`, seeded by `scripts/seed-e2e.ts`); staff: `staffSessionCookie()`.
- Fake QuickBooks with `startQboStub()` from `tests/helpers/qbo-stub.ts` and `vi.mock("@/lib/quickbooks/endpoints", ...)` (top of `tests/integration/roster-pages.test.ts`). Fake mail with `vi.mock("@/lib/mail/senders", ...)` and an outbox (`tests/integration/parent-door.test.ts`), or the real SMTP sink in `tests/helpers/mail-sink.ts`.
- No environment switch and no test-only branch under `src/`: tests replace modules from outside (`tests/unit/no-test-mail-path.test.ts`).

### Tripwire tests
A new feature will meet these. Changing one is a deliberate act named in the slice brief, never a fix made in passing:
- `tests/unit/quickbooks-read-only.test.ts`: the portal writes nothing to QuickBooks.
- `tests/unit/parent-nav.test.ts`: the four parent tabs. `tests/e2e/public-pages.spec.ts`: the list of pages that answer 404 until they are built.
- `tests/integration/page-guards.test.ts`: the lists of pages outside the guarded trees, route handlers and staff-only imports.
- `tests/e2e/quickbooks.spec.ts` and `tests/e2e/parents.spec.ts`: roster counts that follow from `scripts/seed-e2e.ts`. Change the seed and the counts together.

### UI
- Use only the tokens and components in `DESIGN.md` and `src/app/booster.css`. No hex colors in components: the club's color is set at runtime.
- Font sizes in rem, never px. Tap targets at least 44px. Every status is words, plus an icon where there is room; color never carries meaning alone.
- Show an instant with `LocalTime` and a calendar date with `CalendarDate` (`src/app/components/`), not with your own formatting.
- Copy follows the voice in `PRODUCT.md`: a warm, plain neighbor, kind about money. US English.

### Git
- Commit messages: `type(scope): what is now true`, a short body saying why, and the trailer `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. See `git log`.
- LF line endings. Small commits. Leave the tree clean. Do not reformat files you are not changing.
- No new dependency unless the brief names it.
- Never push, open a pull request or deploy unless the brief says the owner allowed it.
