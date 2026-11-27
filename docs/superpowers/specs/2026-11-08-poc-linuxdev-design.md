# Boosters Rocket proof of concept on linuxdev — Design

**Date:** 2026-11-08
**Status:** Built by plan `2026-11-08-poc-linuxdev.md` (removed on 2026-11-26 once built; in git history) and running since 2026-11-09. Its runbook (docs/runbooks/poc-linuxdev.md) records checks 1 to 17 passed and 18 to 25 not yet run; the next deploy there is part 1 of docs/runbooks/before-the-first-family.md. A club's real installation is `deploy/` (docs/runbooks/first-install.md), not this one.
**Builds on:** `docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md` (v1 spec) and Plan 1
(foundation), merged to `main`.

---

## 1. What this is

A running, publicly reachable proof of concept of Boosters Rocket on the owner's Linux host
`linuxdev` (192.168.1.2), at **`https://portaltest.rhinoautomator.com`**, behind the owner's existing
Cloudflare tunnel with **Cloudflare Access** in front. It proves the foundation works for real:
staff sign in with Microsoft through the band's Entra tenant, a test parent signs in through Entra
External ID, and every sign-in and change lands in the audit log.

### Users and data

The owner and a few named test users only. The database holds test data. No real families use it.

### Success

The checklist in §6 passes end to end on `linuxdev`, run by the owner.

## 2. Decisions already made

| Decision | Choice |
|---|---|
| Host | `linuxdev`, Docker 29 / Compose v5, existing user `brian` |
| Public address | `portaltest.rhinoautomator.com` (the band domain isn't on the owner's Cloudflare account) |
| Staff sign-in | Microsoft, app registration in the **band's** Entra tenant (owner has Global Admin) |
| Parent sign-in | A new **Entra External ID** tenant created from the band's Azure subscription |
| Front door | Cloudflare Access, **specific emails** with a one-time PIN |
| Deploys | **Build on linuxdev from GitHub** with one deploy script, run by hand (no runner, no registry) |
| Runtime | Node 26 (`node:26-slim`) |
| Old GitHub runner on linuxdev | Removed (done 2026-11-08) |

## 3. What runs on linuxdev

Everything lives in `~/booster-rocket`, a clone of `github.com/bmsimp/booster-rocket` (linuxdev's SSH
key already has access). One compose file, **`docker-compose.poc.yml`**, defines:

| Service | What it is | Networks | Ports |
|---|---|---|---|
| `db` | Postgres 16, named volume `booster-rocket-pgdata`, healthcheck. Since 2026-11-17 the compose file runs Postgres 18 with its data in `booster-rocket-postgres`, and mounts `booster-rocket-pgdata` read only beside it until a person removes it; the host's data is moved by hand (`docs/runbooks/poc-linuxdev.md`, section 8, "Moving the database to Postgres 18") | `internal` | none |
| `app` | The Boosters Rocket image built from the repo's `Dockerfile`, healthcheck on `/api/health` | `internal`, `edge` | none |
| `migrate` | One-off, profile `tools`: same image as `app`, runs migrations and exits | `internal` | none |

- **`internal`**: private to this project. Only `app` and `migrate` reach `db`.
- **`edge`** (named `booster-rocket-edge`): shared only by `app` and `cloudflared`. It is added to
  `cloudflared`'s networks in **`~/n8n/docker-compose.yml`** (as an external network), so the
  weekly `update-cloudflared.sh` recreate keeps the connection. Boosters Rocket never joins
  `cipp-tracker-net`, and no other project can reach its database.
- **No published ports** for any service. The only way in is the tunnel.
- **Secrets** live in `~/booster-rocket/.env.poc` on linuxdev, mode 600, never committed. The
  repo ships `.env.poc.example` with every variable documented.
- **Timezone** `TZ=America/Chicago` on `app` and `db`, matching n8n.
- **Cloudflare**: the tunnel's public hostname `portaltest.rhinoautomator.com` routes to
  `http://booster-rocket-app:3000`, with **HTTP Host Header left unset** (so the request Host is the
  public hostname, which Next.js server actions and Better Auth's origin checks rely on).
- **`APP_URL`** is `https://portaltest.rhinoautomator.com`.

## 4. Building and deploying

### 4.1 The image

`Dockerfile`, multi-stage, on `node:26-slim`:

- **deps**: install with pnpm from the lockfile.
- **build**: `next build` with `output: "standalone"`. The build needs the env schema satisfied, so
  it sets clearly fake placeholder values. **No real secret is ever present at build time.**
- **run**: only the standalone server, static assets, the migrations folder and the plain
  migration script; runs as a non-root user; `CMD ["node", "server.js"]`.

### 4.2 Migrations without dev tools

`pnpm db:migrate` runs through `tsx`, a devDependency missing from the run image. Add
**`scripts/migrate.mjs`**, a plain JavaScript script using the same `drizzle-orm` migrator and
`postgres` client against the committed `drizzle/` folder, exiting non-zero on failure. The
`migrate` service runs it. `src/lib/db/migrate.ts` stays for development and tests.

### 4.3 Health route

**`/api/health`** returns `200 {"ok":true}` when a trivial database query succeeds and
`503 {"ok":false}` when it doesn't. It returns nothing else: no version, no error text, no data.
It is public (Docker and the deploy script call it from inside the host). It writes no audit entry.

### 4.4 Scripts (in the repo, run on linuxdev)

- **`scripts/poc/setup.sh`** (one time): checks prerequisites, creates `booster-rocket-edge` if
  missing, creates `.env.poc` from the example with a generated `BETTER_AUTH_SECRET` and database
  password (mode 600) if missing, then prints the one manual step (adding the edge network to
  `~/n8n/docker-compose.yml`, with the exact lines) and the next command.
- **`scripts/poc/deploy.sh`**:
  1. refuses if the checkout has local changes;
  2. `git pull --ff-only` on `main`;
  3. tags the current app image as `booster-rocket-app:previous`;
  4. builds the image;
  5. runs `migrate`; **if it fails, stops** and leaves the running app untouched;
  6. recreates `app` and waits for its healthcheck to pass (fails loudly after a timeout);
  7. prints the deployed commit.
- **`scripts/poc/deploy.sh --rollback`**: retags `previous` as current and recreates `app`.
  Migrations are not reversed (test data only).
- **`scripts/seed-poc-guardian.mjs`**: inserts one guardian row (name, email, External ID object
  ID, a made-up family ID, status `invited` so the first sign-in activates it), run through the `migrate` service's image so it needs no dev tools.
  Refuses to run if `APP_URL` doesn't contain `portaltest` (keeps it off any future production).
  Writes an audit entry (`guardian.seed`, door system).

## 5. Sign-in setup (the runbook)

**`docs/runbooks/poc-linuxdev.md`**, written for a non-developer, covers in order:

1. **First-time setup on linuxdev**: clone, `setup.sh`, the n8n compose edit, restart
   `cloudflared` with `docker compose -f ~/n8n/docker-compose.yml up -d cloudflared`.
2. **Staff app registration (band's Entra tenant)**: single tenant; redirect URI
   `https://portaltest.rhinoautomator.com/api/auth/staff/callback/microsoft`; client secret;
   which `.env.poc` variables receive the tenant ID (a GUID), client ID and secret;
   `BOOTSTRAP_ADMIN_EMAIL` = the owner's band email.
3. **Entra External ID tenant (parents)**: create the external tenant from the band's Azure
   subscription, region United States; app registration with redirect URI
   `https://portaltest.rhinoautomator.com/api/auth/parent/callback/parent-oidc`; a user flow with
   **email one-time passcode** sign-in and **sign-up disabled**; the discovery URL
   (`https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0/.well-known/openid-configuration`), client
   ID and secret into `.env.poc`.
4. **Test parents**: create two External ID users; run `seed-poc-guardian.mjs` for the first only.
5. **Cloudflare**: the public hostname (as §3); an Access self-hosted application for
   `portaltest.rhinoautomator.com` with an Allow policy for the listed emails and the one-time PIN
   login method.
6. **First deploy**: `scripts/poc/deploy.sh`.
7. **Troubleshooting**: each audit reason (`missing_object_id`, `no_guardian`, `disabled`,
   `subject_mismatch`, `parent.object_id_unverified` reasons) and common dashboard mistakes
   (redirect URI typos, multi-tenant staff app, sign-up left on, Host header set) mapped to a fix.

Exact click paths in the Microsoft and Cloudflare dashboards are checked against current
Microsoft Learn and Cloudflare documentation when the runbook is written.

## 6. The first real test (checklist, in the runbook)

1. Visit the address: Cloudflare Access asks for an email code; after it, the portal's sign-in page.
2. Staff: sign in at `/staff/sign-in` with Microsoft → staff home, as Admin.
3. Set the club name and color → they show on every page.
4. Parent: sign in at `/sign-in` as the seeded test parent → parent home (not the refusal page).
5. Audit log shows: `admin.bootstrap`, `staff.bind`, staff `signin`, parent `signin`,
   `parent.object_id_set`, `guardian.activate`, `settings.club.save`.
6. Sign out at both doors → both `signout` entries appear.
7. The second External ID user (no guardian row) → refusal page; audit shows `signin.refused`
   with reason `no_guardian`.
8. `deploy.sh` run a second time with no changes completes and keeps the app healthy; `--rollback`
   returns to the previous image and the app stays healthy.

Results are recorded at the bottom of the runbook with the date and deployed commit.

## 7. Automated checks (added to CI)

- **Image build**: CI runs `docker build` on every push.
- **No secrets in the image**: CI builds the image with fake secret values in the build
  environment and fails if any appear in the image filesystem (extends the existing client-bundle
  check).
- **`scripts/migrate.mjs`**: an integration test runs it against an empty database and checks the
  schema and the Admin role exist; and checks it exits non-zero on a bad connection string.
- **`/api/health`**: tests for 200 with the database up, 503 with it unreachable, and a body of
  exactly `{"ok":true}` / `{"ok":false}`.
- **Shell scripts**: `shellcheck` on `scripts/poc/*.sh`; a test of `deploy.sh`'s control flow with
  `docker`/`git` replaced by stubs, proving a failed migration stops before `app` is recreated and
  that local changes abort the deploy.
- **Seed script**: refuses without `portaltest` in `APP_URL`; inserts one guardian and one audit row.

## 8. Not in this proof of concept

Backups and restore (test data; Plan 6), publishing images to a registry, auto-deploy, Documenso,
email sending, QuickBooks (Plan 2), and any change to the app's features.

## 9. Risks

- **Dashboards Claude can't see.** Staff sign-in, parent sign-in and Access depend on settings in
  Entra, External ID and Cloudflare. Mitigation: the runbook's troubleshooting section and the
  audit reasons.
- **First real parent token.** The `oid` claim has never been seen in a real External ID token.
  Mitigation: checklist step 4–5; failure shows a specific `parent.object_id_unverified` reason.
- **Two logins for testers.** Access plus the portal's own sign-in. Accepted for a proof of
  concept.
