# A first installation

From an empty machine with Docker to a signed-in Admin and a first backup. Follow it at the keyboard, top to bottom.
Anything in `monospace` is typed exactly; words in `<angle brackets>` are yours to fill in. If a screen no longer
matches what is written here, trust the screen.

The other runbooks: [Intuit](intuit.md), [outgoing mail](mail.md), [Documenso](documenso.md), [backups](backups.md),
[updates](updates.md), [restore](restore.md), [reconnecting QuickBooks](quickbooks-reconnect.md),
[Health page warnings](health-warnings.md), and [before the first family](before-the-first-family.md), the checks only
a person can make before families use the portal.

## What you need before you start

1. A machine that stays on, with Docker Engine and its compose plugin (`docker compose version` answers), git, and
   openssl. Plan for 2 processor cores, 3 GB of memory and 20 GB of disk: Documenso alone uses about 1 GB of memory, and
   its image is over 2 GB.
2. Two addresses, both pointing at that machine: one for the portal (for example `https://portal.example.org`) and one
   for Documenso, where forms are signed (for example `https://sign.example.org`). Each needs a name of its own; ask
   whoever looks after the club's domain to add the two names.
3. Either something already in front of the machine that gives those names https (a proxy or tunnel of your own), or
   ports 80 and 443 of the machine reachable from the internet, so this installation's own proxy can get certificates.
4. A mailbox the portal can send from (the parents' password links and sign-in codes come from it): [outgoing mail](mail.md).
5. An hour. Documenso's first start alone takes a few minutes.

## 1. Get the files

1. Sign in to the machine as the person who will look after it, and choose a folder for the portal's data, outside the
   checkout. This runbook uses `/srv/booster-rocket`:
   ```bash
   sudo mkdir -p /srv/booster-rocket/backups
   sudo chown "$USER" /srv/booster-rocket /srv/booster-rocket/backups
   ```
2. Get the portal's repository (its address is on its GitHub page, under **Code**):
   ```bash
   cd ~
   git clone <the repository's address> booster-rocket
   cd booster-rocket
   ```
3. Choose what to run. Once a release has been published, use it: `git checkout <version>` (for example
   `git checkout v1.0.0`; the repository's **Releases** page lists them). Until then stay on the default branch.

## 2. Make the signing certificate

Documenso seals every signed form with a certificate of the club's own. Follow
[Documenso, part 1](documenso.md#1-make-the-signing-certificate) now, and come back with the file
`/srv/booster-rocket/documenso-signing.p12` and its passphrase.

## 3. Fill in the settings

1. Copy the example and make it private:
   ```bash
   cd ~/booster-rocket/deploy
   cp .env.example .env
   chmod 600 .env
   ```
2. Open `.env` in an editor (`nano .env`). Each line says what it is. Fill in every empty line:
   - `APP_URL` and `DOCUMENSO_URL`: the two addresses, with `https://` and nothing after the name, not even a `/`
     (this installation's proxy refuses to start with one, and says which line).
   - `CLUB_TIME_ZONE`: for example `America/Chicago`.
   - `CLIENT_IP_HEADER`: `x-forwarded-for` if you will use this installation's own proxy (step 5). With a proxy of your
     own, see [A proxy of your own](#a-proxy-of-your-own) below.
   - Every password and secret: make each one with `openssl rand -hex 32` and paste it in. `SETTINGS_ENCRYPTION_KEY` is
     the one exception: make it with `openssl rand -base64 32`. Never reuse one value for two lines. Keep
     `SETTINGS_ENCRYPTION_KEY` safe: it also seals parents' authenticator apps, so losing it loses every parent's app
     (they sign in with a backup code or ask the club), and after changing it the old one must stay as
     `SETTINGS_ENCRYPTION_KEY_PREVIOUS` for good ([backups](backups.md)).
   - `DOCUMENSO_SIGNING_CERTIFICATE`: `/srv/booster-rocket/documenso-signing.p12`, and `DOCUMENSO_SIGNING_PASSPHRASE`
     its passphrase.
   - `DOCUMENSO_SMTP_*`: Documenso's own account mail ([outgoing mail](mail.md#documensos-account-mail)).
   - `BACKUP_DIR`: `/srv/booster-rocket/backups`.
   Paths must be full paths, starting with `/`.
3. Copy `.env` somewhere safe that is not this machine (a password manager the board shares is a good place). Without
   it a backup can't be read back.

## 4. Choose how to get the portal's image

There are two ways. Both run the same portal.

- **The published image.** Releases are published to the GitHub Container Registry. Use it once a release exists: it
  is built and checked by the project, and an update is a pull. In `.env`, set
  `BOOSTER_ROCKET_IMAGE=ghcr.io/<owner>/booster-rocket:stable`, where `<owner>` is the GitHub account in the
  repository's address, in lower case. (`stable` follows each new release; put a version such as `1.0.0` instead to
  stay on one until you change it.) Left empty, a start without `compose.build.yml` stops with "invalid reference
  format" and the words `SET-BOOSTER_ROCKET_IMAGE-IN-ENV`: the image hasn't been named.
- **A build from this checkout.** Use it until a release has been published, or to run a change that hasn't been
  released yet. Leave `BOOSTER_ROCKET_IMAGE` empty. Every command below then names two files,
  `-f compose.yml -f compose.build.yml`, and the first start builds the image here (ten minutes or more).

The commands below are written for the published image. For a build, put `-f compose.yml -f compose.build.yml` after
`docker compose` in each one, and start it the first time with:

```bash
APP_COMMIT="$(git rev-parse --short HEAD)" docker compose -f compose.yml -f compose.build.yml up -d --build
```

(`APP_COMMIT` is the commit being built, so the Health page can say which version is running.)

## 5. The first start

1. From `~/booster-rocket/deploy`, start everything. With this installation's own proxy:
   ```bash
   docker compose --profile proxy up -d
   ```
   With a proxy of your own, leave out `--profile proxy`.
2. Watch it come up: `docker compose ps`. Within a few minutes `db`, `app` and `documenso` say `healthy`, `migrate`
   says `Exited (0)`, and `worker` and `backup` say `Up`. Documenso's first start runs its own database set-up and is
   the slowest. `migrate` sets up the portal's empty database; on later starts, before it changes a database that
   holds data, it checks that a backup was made in the last 26 hours ([updates](updates.md#when-the-start-stops-for-a-backup)).
   This first start has nothing to back up, so it is never stopped.
3. If something stops, its log says why: `docker compose logs <name>` (for example `docker compose logs app`). A line
   that names a missing setting means a line of `.env` is still empty.
4. Check both addresses from your own computer's browser: the portal's address shows the setup page, and
   `<DOCUMENSO_URL>/api/health` shows `"status":"ok"`.
5. Check that this machine can reach its own two addresses, with either kind of proxy. The portal calls Documenso at
   `DOCUMENSO_URL`, and Documenso sends its webhook to `APP_URL`, both by their public names, from inside the machine.
   A browser outside reaching them doesn't prove this: behind a router that doesn't send a machine's own traffic back
   to it, these calls fail while every browser works. From `~/booster-rocket/deploy`:
   ```bash
   docker compose exec app node -e "fetch(process.argv[1] + '/api/health').then(r => console.log(r.status), e => console.log(e.cause?.code ?? e.message))" "<DOCUMENSO_URL>"
   docker compose exec documenso node -e "fetch(process.argv[1] + '/api/health').then(r => console.log(r.status), e => console.log(e.cause?.code ?? e.message))" "<APP_URL>"
   ```
   Each prints `200`. Anything else (a timeout, `ECONNREFUSED`) means the names lead somewhere this machine can't
   reach from inside. Ask whoever looks after the network to turn on "NAT loopback" (also called "hairpin NAT") on
   the router, or to make the two names lead to this machine's own address inside the network; with a proxy of your
   own, ask whoever runs it. Then run both again. Until both print `200`, forms can't be signed.

## 6. Setup

1. Get a setup code on the machine:
   ```bash
   docker compose run --rm migrate node tools/scripts/setup-code.mjs
   ```
   It prints `Setup code: XXXX-XXXX-XXXX`. Running it again replaces the code.
2. Open the portal's address in a browser. Enter the code and select **Unlock**.
3. **Step 1, the club.** Enter the club's name, its color and its time zone (the zone decides which day it is for
   everything parents read as due), **Save**, then **Next: staff sign-in**. All three can be changed later under
   **Settings**, **Club**.
4. **Step 2, staff sign-in.** Set up Microsoft, Google or both: the page walks through registering the portal with
   them and checks what you paste. The redirect address it shows is built on `APP_URL`.
5. **Step 3, outgoing mail.** Follow [outgoing mail](mail.md), then **Save** and **Send test email**. The next step
   opens only once a test email has gone out.
6. **Step 4, first Admin.** Enter the name and the email of the person who will be Admin, **Save name and email**,
   and sign in as them with Microsoft or Google. Setup closes and the staff home opens: you are signed in as the Admin.
7. Open **Health** in the staff menu (under **Admin**). Every line should be there;
   [Health page warnings](health-warnings.md) says what each one means. QuickBooks, Forms and parent sign-ins say "Not
   set up" or "Off" until the next steps.

## 7. The rest of the set-up

1. QuickBooks: [Intuit](intuit.md).
2. Forms: [Documenso, parts 2 to 4](documenso.md#2-the-first-documenso-account).
3. Parent sign-ins: under **Settings**, **Parent sign-ins**, once QuickBooks has read the roster. A guardian is
   added on their family's page, and a fresh installation has no families yet: a read of QuickBooks brings no
   customer into the portal's own families by itself. Bring each family in from **Reconciliation** in the staff menu:
   under **Customers with no family**, **Create a family from this** makes the family and its students, linked to
   their customers in QuickBooks (an Admin can do it, and so can anyone given "Link families to accounting"). Then add
   its guardians on its page, under **Families** (an Admin can, and so can anyone whose role may give or end a
   guardian's sign-in for a family; "Link families to accounting" alone can't). The reviewed import of every family at once comes with stage 4 of
   the roadmap. A family that isn't in QuickBooks yet is added under **Families** with **Make a family**: it is made in
   QuickBooks too, and linked, when the person adding it may link families to accounting; otherwise it is in the portal
   only until someone who may presses **Create in QuickBooks and link** on its page.
4. Before any family signs in: [before the first family](before-the-first-family.md), the checks only a person can
   make, from real phones to a pilot with a few families.

## 8. The first backup

1. Take one now, rather than waiting for the night:
   ```bash
   docker compose run --rm backup --now
   ```
   It prints `Backup written: /backups/booster-rocket-<time>.dump` and `Documenso's database written: ...`.
   (`/backups` inside the container is `BACKUP_DIR` on this machine.)
2. Open **Health** again: **Last backup** says "Recent" and names both files.
3. Read [backups](backups.md): the nightly schedule, what else to keep, and copying the backups off this machine.

## A proxy of your own

Leave out `--profile proxy` and point your proxy or tunnel at:

- the portal: `http://127.0.0.1:3000` (`PORTAL_LOCAL_PORT` in `.env`), for the address in `APP_URL`;
- Documenso: `http://127.0.0.1:3001` (`DOCUMENSO_LOCAL_PORT`), for the address in `DOCUMENSO_URL`.

Those ports answer on this machine only. Your proxy must, for both:

1. Serve each address over https, under exactly the name in `.env`.
2. Replace `X-Forwarded-For` with the visitor's bare address: one address, no port, no list. Documenso writes the
   first entry of it on each signed form's certificate and counts its limits by it; an address with a port is
   recorded as unknown, and a list lets a visitor write the first entry.
3. Send the visitor's address in a header it sets itself, and put that header's name in `CLIENT_IP_HEADER`. A header
   the visitor could send instead lets them dodge the sign-in limits. The comments in `.env.example` at the top of the
   repository list the usual ones. Find out what your proxy sets rather than guessing.
4. Compress responses (gzip or better). Documenso compresses nothing, and its signing page is several megabytes.

The portal and Documenso also call each other at their public addresses, so run the check in
[the first start](#5-the-first-start), item 5, once your proxy is in place.

## Changing a password

The database passwords are set when Postgres first starts, on an empty volume. Changing one in `.env` later does not
change it in Postgres, and the portal (or Documenso) then can't connect. To change one:

1. `docker compose exec db psql -U postgres -c "alter role booster password '<the new password>'"` (or `documenso`).
2. Put the same password in `.env`, then `docker compose up -d`.

## When no Admin can sign in

If staff sign-in stops working for everyone (for example, the Microsoft or Google app was deleted), reopen the setup
page. Saved settings are kept, and Admins stay Admins:

```bash
docker compose run --rm migrate node tools/scripts/setup-code.mjs --reopen
```

It prints a new setup code. Open the portal's address, enter it, and fix Step 2, staff sign-in.

## Stopping and starting

- Stop everything, keeping all data: `docker compose --profile proxy stop`.
- Start it again: `docker compose --profile proxy up -d`. A start with no database changes to make is never stopped
  for a backup; one that has changes to make (a new version) needs a backup from the last 26 hours, and says how to
  make one if not ([updates](updates.md#when-the-start-stops-for-a-backup), where `MIGRATE_WITHOUT_RECENT_BACKUP` is
  explained too).
- Never run `docker compose down -v` on a real installation: `-v` deletes the databases.
