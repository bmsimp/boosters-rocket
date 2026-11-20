# Booster Rocket

An open-source parent portal for booster clubs and other parent groups that support youth
programs.

Each family signs in and sees only its own students, what it owes and what it must sign.
Volunteers manage the roster, forms and settings from the same app. The club's books stay in
QuickBooks Online.

- **QuickBooks Online is the source of truth** for invoices and payments. The portal reads them and
  keeps a copy for speed; it never holds its own version of the books. The families, students and
  sign-ins are the portal's own records, each linked to its customer in QuickBooks; a change made
  in QuickBooks doesn't change them. It
  writes back only what someone asks it to: a guardian's phone and
  mailing address (the portal's own, changed by the parent or by staff, and sent on to their record
  after the save), the roster changes staff make (new families, students and parents, names, a student's
  family, making a customer inactive), and the one invoice it ever makes, for a guardian who
  chooses to pay instead of volunteering. It never deletes anything and never touches a payment.
- **Commitment forms are signed in [Documenso](https://github.com/documenso/documenso)**, which
  each club hosts alongside the portal. The portal keeps each signed form's sealed copy and its
  evidence.
- **Each club runs its own copy**, at its own address. There is no shared, multi-club service.

## Status

The v1 design is built, step by step, and the whole portal is being reviewed against it. It is not
yet ready for a club's real families: nothing has been pushed or deployed since the proof of
concept, the portal's requests to QuickBooks have not yet been tried against a real company, and
no real phone has signed a form. [Before the first family](docs/runbooks/before-the-first-family.md)
is the list of what a person must check first, in order.

What it does:

- Staff sign in with Microsoft or Google; parents sign in with a code the portal emails them, and
  stay signed in for 90 days on their own phone.
- Parent pages for Home, Forms, Payments, Volunteer and Family, installable as an app on iOS and
  Android, checked for WCAG 2.2 AA in every display mode.
- Money: each family's open invoices and total with Pay buttons that open QuickBooks' own payment
  page, and for staff, who owes what, read from QuickBooks every day.
- Seasons: staff set up a season's steps and what each asks of a family or student (a form to
  sign, a payment, volunteering, a checklist item); parents see where they stand.
- Forms signed inside the portal in Documenso, with the signed copy emailed to each guardian and a
  matrix for staff of who has signed, reminders and downloads.
- Volunteering: events and shifts, sign-ups with a calendar file, check-in by a printed QR code,
  credit toward a requirement, and paying instead of volunteering.
- Staff changes to the roster written to QuickBooks, with a queue for when it can't be reached.
- A first-run setup page, roles chosen from a checklist, an audit log with filters and a CSV
  export, a Health page, nightly backups with a tested restore, and a daily clean-up.

[The roadmap](docs/superpowers/plans/2026-11-07-v1-roadmap.md) is the current status, with its
known gaps, and [the v1 design](docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md)
says what is being built. [The conformance matrix](docs/conformance.md) holds the build against that
design requirement by requirement, with what proves each, and [the walkthrough](docs/walkthrough.md)
goes through the portal page by page.

## Run it on your own machine

You need Node 26, pnpm and Docker.

```bash
docker compose up -d                 # Postgres 18, on 127.0.0.1:5433 (from 16: AGENTS.md, Tests)
cp .env.example .env                 # then set SETTINGS_ENCRYPTION_KEY: openssl rand -base64 32
pnpm install
node --env-file=.env --import tsx src/lib/db/migrate.ts   # create the tables
pnpm dev                             # http://localhost:3000
node --env-file=.env scripts/setup-code.mjs               # prints the code the setup page asks for
```

Open http://localhost:3000. The setup page asks for the code, then walks through the club, staff
sign-in, outgoing mail and the first Admin. `.env.example` says what each value in `.env` is for.

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit and integration tests against the local
Postgres) and `pnpm e2e` (browser tests; see `docs/agents/testing.md` for how to run them).

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
- [Before the first family](docs/runbooks/before-the-first-family.md): every check only a person can
  make (real phones, a real QuickBooks company, Documenso, Intuit's assessment), then a pilot with a
  few families and the welcome emails

[The proof-of-concept runbook](docs/runbooks/poc-linuxdev.md) is the record of the first
installation, made with `docker-compose.poc.yml` and the scripts in `scripts/poc/`.

For whoever works on the portal: `AGENTS.md` holds the rules every change follows,
`PRODUCT.md` and `DESIGN.md` say who it is for and how it looks, and `docs/ui-backlog.md` lists
the interface problems still open.

Licensed under [AGPL-3.0](LICENSE).
