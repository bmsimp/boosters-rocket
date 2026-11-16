# Booster Rocket

An open-source parent portal for booster clubs and other parent groups that support youth
programs.

Each family signs in and sees only its own students, what it owes and what it must sign.
Volunteers manage the roster, forms and settings from the same app. The club's books stay in
QuickBooks Online.

- **QuickBooks Online is the source of truth** for invoices, payments and the family roster. The
  portal reads them and keeps a copy for speed; it never holds its own version of the books. The
  one thing it writes back is a parent's own phone and mailing address, when that parent changes
  them.
- **Commitment forms are signed in [Documenso](https://github.com/documenso/documenso)**, which
  each club hosts alongside the portal.
- **Each club runs its own copy**, at its own address. There is no shared, multi-club service.

## Status

In development. It is not yet ready for a club's real families.

What works today:

- Staff sign in with Microsoft or Google; parents sign in with a code the portal emails them.
- A first-run setup page, roles and permissions, and an audit log with filters and a CSV export.
- A connection to QuickBooks: the family roster, and each family's open invoices with Pay buttons
  that open QuickBooks' own payment page.
- Parent pages for Home, Family and Payments, installable as an app on iOS and Android. A parent
  can update their own phone and mailing address, which the portal writes to QuickBooks.
- Seasons: staff set up a season's steps and what each asks of a family or student, tick checklist
  items off and waive them; parents see where they stand on Home and on a Season page.
- For whoever runs it: a Health page, backups with a tested restore, and a daily clean-up.

The invoice queries and the address update have not yet been tried against a real QuickBooks
company; the roadmap lists what must be checked first.

Still to come before v1: email changes and staff edits to the roster, forms, volunteering and
staff money pages. [The roadmap](docs/superpowers/plans/2026-11-07-v1-roadmap.md) is the current
status, and [the v1 design](docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md) says
what is being built.

## Run it on your own machine

You need Node 26, pnpm and Docker.

```bash
docker compose up -d                 # Postgres, on 127.0.0.1:5433
cp .env.example .env                 # then set SETTINGS_ENCRYPTION_KEY: openssl rand -base64 32
pnpm install
node --env-file=.env --import tsx src/lib/db/migrate.ts   # create the tables
pnpm dev                             # http://localhost:3000
node --env-file=.env scripts/setup-code.mjs               # prints the code the setup page asks for
```

Open http://localhost:3000. The setup page asks for the code, then walks through staff sign-in,
outgoing mail and the first Admin. `.env.example` says what each value in `.env` is for.

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit and integration tests against the local
Postgres) and `pnpm e2e` (browser tests; see `AGENTS.md` for how to run them).

## Run it for a club

The portal runs on any machine with Docker, at addresses the club chooses. `deploy/` holds the
installation: the portal and its worker, Postgres with the portal's and Documenso's databases,
Documenso, a nightly backup of both, and an optional reverse proxy. It pulls the published image,
or builds one from the checkout with `deploy/compose.build.yml`.

The runbooks, written for a club volunteer:

- [A first installation](docs/runbooks/first-install.md): from an empty machine to a signed-in Admin
  and a first backup
- [Intuit](docs/runbooks/intuit.md): registering the portal with Intuit, and its production assessment
- [Outgoing mail](docs/runbooks/mail.md): Microsoft 365 or SMTP, for the portal and for Documenso
- [Documenso](docs/runbooks/documenso.md): the signing certificate, the first account, connecting it
- [Backups](docs/runbooks/backups.md): the nightly schedule, what else to keep, copying them away
- [Updates](docs/runbooks/updates.md): a new release, and how to go back
- [Restore](docs/runbooks/restore.md): onto the same machine or a new one
- [Reconnecting QuickBooks](docs/runbooks/quickbooks-reconnect.md): the same company, or a different one
- [When the Health page warns](docs/runbooks/health-warnings.md): one entry for each of its lines

[The proof-of-concept runbook](docs/runbooks/poc-linuxdev.md) is the record of the first
installation, made with `docker-compose.poc.yml` and the scripts in `scripts/poc/`.

Licensed under [AGPL-3.0](LICENSE).
