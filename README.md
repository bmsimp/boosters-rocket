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

The portal runs as a Docker image beside its own Postgres, behind a reverse proxy or tunnel that
gives it an https address. The scripts in `scripts/poc/` set up and update a server that uses
`docker-compose.poc.yml`:

```bash
scripts/poc/setup.sh https://portal.yourclub.org   # once: makes a private .env.poc with fresh secrets
scripts/poc/deploy.sh                              # build, back up the database, migrate, start; prints a setup code
```

`scripts/backup.sh <folder>` backs up the database and `scripts/restore.sh <file> <database>` loads
a backup; each explains itself at the top of the file. Keep `.env.poc` with the backups: without
its encryption key, a backup can't bring back the QuickBooks connection or the sign-in settings.

[The proof-of-concept runbook](docs/runbooks/poc-linuxdev.md) is a full walk-through of one
installation. Runbooks written for any club, and a published image, are still to come.

Licensed under [AGPL-3.0](LICENSE).
