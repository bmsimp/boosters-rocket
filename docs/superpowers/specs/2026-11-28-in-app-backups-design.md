# In-app backups — design

**Status:** DRAFT for the owner's review. Nothing here is decided until he says so; the questions in section 13 are
his. Until each slice is built, the code, `AGENTS.md` and `docs/agents/operations.md` describe what is built.
**Builds on:** `main` at `5fc502f4`. **Asked for by:** the owner, 2026-11-25: the portal manages its own database
backups from Settings, so nobody has to SSH into the server to run `scripts/backup.sh` or a restore
(`docs/agents/owner-taste.md`, rule 8: "Anything that sends someone to the server to type commands is a gap to close,
for example in-app backups").

Words used here. The **backup service** is `deploy/compose.yml`'s `backup` container (Postgres 18's image, our
scripts mounted read only, the superuser's password, `BACKUP_DIR` at `/backups`). The **agent** is what that service
runs once this spec is built: `scripts/backup-agent.sh`, in place of `backup-schedule.sh`'s loop. A **backup** is one
pair of files with one time in their names, `booster-rocket-<time>.dump` and `documenso-<time>.dump`, as today.
**Off-site storage** is any storage that speaks the S3 API (Cloudflare R2, Backblaze B2, Amazon S3, Wasabi, MinIO
and others); the page never names a provider except as an example. *(Proposed)* marks the lead's own details, which
the owner may change at review.

---

## 1. Why

Today a club's backups are good (both databases or neither, read back in full before they are kept, the newest 14,
the migrate step's 26-hour check), but every act on them is a command on the server. A board member who isn't the
person who installed the portal can see only Health's **Last backup** line. Anything else needs SSH and the runbooks.

## 2. What exists today, and what still needs SSH

| Task | Today | Needs SSH? |
| --- | --- | --- |
| Nightly backup of both databases | `backup` service, `scripts/backup-schedule.sh` at `BACKUP_AT` club time | No (it runs by itself) |
| See the last backup | Health, **Last backup** (`backup.last_success`, written by `backup.sh`; warns after 48 hours) | No |
| See every backup on the server, their sizes, the free disk | `ls -l` on `BACKUP_DIR` | Yes |
| Back up now (before an update, or when the migrate step stops for one) | `docker compose run --rm backup --now` | Yes |
| Change the time, or how many are kept | Edit `BACKUP_AT`, `BACKUP_KEEP` in `deploy/.env`, `docker compose up -d backup` | Yes |
| See when the next one runs, or why one failed | `docker compose run --rm backup --next`, `docker compose logs backup` | Yes |
| Copy backups off the machine | The volunteer's own `rsync` from cron (`docs/runbooks/backups.md`) | Yes, and it's often never done |
| Download a backup to a laptop | `scp` | Yes |
| Check a backup can be restored | `restore.sh` into `booster_restore_check`, then drop it, once a term | Yes |
| Restore | `docs/runbooks/restore.md`: stop app, worker, Documenso, backup; `restore.sh --replace` twice; `up -d`; check Health; back up again | Yes |
| Keep the env file and the signing certificate safe | By hand, in the board's password manager | Off the server, by hand |

What makes this hard is that the app is the wrong place to do the work. It runs as `node` in `node:26-slim`, with no
`pg_dump`, no access to `BACKUP_DIR`, no Docker socket, as the database role `booster`, which can't read Documenso's
database and can't drop its own. The backup service has every one of those things.

## 3. Goals

1. **See** the last backup and whether it was read back whole; every backup on the server, with sizes; the free
   disk; when the next one runs; and why the last one failed, in words.
2. **Change** the schedule (the time, or off) and how many to keep.
3. **Run** a backup now.
4. **Download** a backup, both databases in one file.
5. **Off-site copies**, optional: after each nightly backup, an encrypted copy to S3-compatible storage the Admin
   sets up.
6. **Restore**: section 6 decides how much of it happens in the app.

Not goals: point-in-time recovery (WAL archiving); backing up the env file or the signing certificate (they never
leave the server through the app: section 8); a restore onto a new machine from the app (it has no app yet);
Postgres major-version moves.

## 4. Architecture: how the app asks for work it can't do

### The options

- **(A) The backup service polls a request table.** The app writes a row (`backup_request`); the agent, which
  already has the tools, the superuser's password and the folder, claims it, does it, and writes back the outcome.
  The app gains no privilege. Nothing listens on a port.
- **(B) A worker job does it.** The worker is the app's image calling the app's endpoint every minute: it has no
  `pg_dump`, no folder, no Documenso access. Giving it those is giving the app them. Rejected.
- **(C) A small privileged sidecar with an HTTP API** (or the Docker socket, to run `docker compose run backup`).
  A new listening service, a new token to share, and with the socket, root on the host for whoever reaches it. The
  brief rules out the socket in the app's container; moving it next door doesn't make it safer. Rejected.

### Recommended: (A), the agent

`scripts/backup-agent.sh` replaces `backup-schedule.sh`'s loop in the `backup` service (`--now` and `--next` keep
working, so every runbook command still does). Every 10 seconds *(Proposed)* it:

1. writes a heartbeat (`backup.agent`: when it last looked, its own version, the free bytes of `/backups`, when the
   next backup is due);
2. reads the schedule from the portal's database (`backup.schedule`, section 7), falling back to `BACKUP_AT` and
   `BACKUP_KEEP` from the environment while no one has saved one, and the club's time zone from the Club setting,
   falling back to `TZ`;
3. claims at most one waiting request (`update … set claimed_at = now() where id = (select … for update skip locked)`),
   does it with `backup.sh` or `restore.sh`, and writes the outcome and its words;
4. lists `/backups` into `backup_file` (time, both sizes, whether Documenso's was there, whether it was checked),
   so the app shows the folder without reading it;
5. runs the nightly backup when it is due.

Still bash and `psql`, as `backup.sh` is, so the service keeps the Postgres image it already pins. Every value it
reads from a row is held to a pattern before use: a request's `kind` is one of a fixed list, a backup's time must
match `^[0-9]{8}T[0-9]{6}Z$` **and** name a pair it listed itself; nothing from a row is ever a path, a database
name, a command or SQL. A row is a request, never an instruction.

If the agent isn't running (an installation not yet updated, or the service stopped), the heartbeat goes stale and
the page says so in one line, with every button that needs it left out (section 9).

### Getting a file to the browser

The app never mounts `BACKUP_DIR`. To download, the agent copies the chosen pair, with a short `KEEP-THESE-TOO.txt`,
into one tar file in a new volume, `backup-outbox`, mounted into the backup service and into the app (at
`/app/backup-outbox`), owned by the app's user, mode 600. The app streams it once and deletes it; the agent removes
anything left there after 15 minutes *(Proposed)*. So the app holds a backup only for the minutes someone asked for
one, and only one at a time. Off-site uploads use the same outbox (section 7).

## 5. Data *(Proposed)*

- `backup_request`: `id`, `kind` (`backup`, `download`, `check`, `upload`, and `restore` only if section 6's option
  (b) is chosen), `backup_at` (the pair's time, or null), `requested_by` (staff user, null for the agent's own
  uploads), `requested_at`, `claimed_at`, `finished_at`, `outcome` (`ok`, `failed`, `refused`), `words` (the agent's
  one line, which names no secret and no family), `result` (jsonb: sizes, table counts, the outbox file's name).
  One unfinished request of each kind at a time (a partial unique index). Cleaned up 90 days after it finished
  (`CLEANED_TABLES`, with a boundary test).
- `backup_file`: one row per pair the agent last saw in `/backups`: `backup_at` (key), `portal_bytes`,
  `documenso_bytes` (null when it was left out), `schema` (the last migration applied when it was taken, read by the
  agent before the dump, so section 6 can tell whether a restore needs the migrate step), `checked_at` and
  `check_outcome`, `offsite_at` and `offsite_outcome`. Rewritten by the agent at each look (`KEPT_TABLES`: it is a
  mirror of the folder, never past its life).
- Settings: `backup.schedule` (`{ at: "03:00" | "off", keep: 1..60 }`), `backup.agent` (the heartbeat),
  `backup.offsite` (section 7), and `backup.last_success` exactly as now, since the migrate step's check reads it.

Nothing here is keyed by a QuickBooks id, so a change of company clears none of it.

## 6. Restore: the hard part

### Why it is hard

- **A running app can't drop the database it is using**, and `restore.sh` refuses a target anything is connected to.
  Today the volunteer stops the app, the worker and Documenso first. Without the Docker socket, nothing in the app
  or the backup service can stop a container.
- **Documenso's database must go back to the same moment.** A portal restored to Tuesday with Documenso left at
  Thursday has forms the portal doesn't know of, and evidence it can't match.
- **Not everything is in the dump.** `deploy/.env` holds `SETTINGS_ENCRYPTION_KEY` (the QuickBooks tokens, the
  sign-in certificates, the mail password, parents' authenticator apps), `BETTER_AUTH_SECRET` (backup codes,
  remembered devices, emailed links) and Documenso's own encryption keys; the `.p12` and its passphrase sign forms. On
  the same machine they are already right, unless the key was changed since the backup without keeping the old one
  as `SETTINGS_ENCRYPTION_KEY_PREVIOUS`. On a new machine they must be put back by hand first.
- **An older backup may need the migrate step**, which runs only when the installation starts. A running app on a
  newer schema than its restored database breaks.
- **A restore loses its own record**: the audit row of the Admin who asked is in the database being replaced.

### The options

- **(a) No in-app restore. A guided page with the exact steps,** filled in with the chosen backup's file names, each
  command with a Copy button, in `docs/runbooks/restore.md`'s order. Still SSH, but no thinking.
- **(b) An in-app restore handed to the agent.** The Admin chooses a pair, reads what is lost, types the club's name
  and ticks the box. The agent loads both files beside the live databases (`booster_restoring`,
  `documenso_restoring`), and only when both have loaded whole: sets the portal's maintenance mark, ends every
  connection to both live databases as the superuser, renames each live one to `…_before_<time>` and each new one
  into its name, and writes the restore's audit row into the restored database. The app's pool reconnects to the
  restored database, the app exits so its restart policy starts it clean, and Documenso reconnects by itself. The
  agent then takes a fresh backup, so the migrate step's check holds. Only a backup with the running schema
  (`backup_file.schema`) can be restored this way; an older one gets (a)'s steps, since the migrate step must run.
  The old databases are kept for 7 days *(Proposed)* with **Undo the restore** offered beside them.
- **(c) Restore into a side database to inspect first.** The agent restores the pair into `booster_restore_check`
  and `documenso_restore_check`, counts every table, records the counts in `backup_file`, and drops both. Nothing
  live changes. It automates the runbook's once-a-term check, and could run by itself once a month.

### Recommended: (c) and (a) now; (b) as a later slice, only on the owner's word

(c) is safe and is the proof every club owes itself (conformance 14.6 is still "partly built": nobody has followed
the restore runbook). (a) makes the dangerous thing a short, exact walk. Together they cover the day a database goes
wrong, without the portal ever ending its own connections.

(b) is buildable without the Docker socket, and it closes the last SSH task, but it is the one feature here that can
destroy a club's data from a phone. Its risks, plainly:

1. Ending every connection mid-request. A parent's save in flight is lost; a QuickBooks write in the queue is
   retried from the restored queue, which may resend a change already made in QuickBooks (`docs/agents/
   quickbooks-writes.md` would need its rule for a restored queue).
2. Documenso holds state outside its database (jobs in flight, sealing). Swapping under it was never verified
   (`docs/superpowers/specs/2026-11-15-documenso-verification.md`) and would need its own check.
3. Anyone who holds the permission, or takes over an Admin's sign-in, can roll the club back. The kept `_before_`
   databases are the only way back, and they cost disk.
4. Everything made since the backup (signed forms, payments recorded, parents' passwords and passkeys) is gone, and
   every parent is signed out of anything newer.

If the owner chooses (b), it ships last, after (c) has run on real installations.

## 7. Off-site copies (optional)

An Admin sets up **Off-site storage** in a drawer: the storage's address (endpoint), region, bucket, a folder in it,
an access key ID and secret. **Test the connection** writes and reads back a small file. Once it works, after every
backup the agent stages the pair in the outbox and leaves an `upload` request; the worker's job `backup_offsite`
(the app's own process, which holds `SETTINGS_ENCRYPTION_KEY`) encrypts it while streaming it up, records the outcome
in `backup_file`, and deletes the staged file.

- **Encrypted before it leaves.** *(Proposed)* in the `age` format with a passphrase, so a club can decrypt with the
  standard `age` tool without the portal. The portal makes the passphrase when off-site storage is set up, shows it
  once with a Copy button and "Keep this with the env file. Without it, these copies can't be opened.", and keeps it
  sealed by `secretBox()` for the uploads.
- **Credentials sealed** by `secretBox()`, as the mail password and the QuickBooks tokens are; never sent back to the
  page (it shows "Saved" and the key ID's last four characters).
- **The portal never deletes off-site.** It asks for, and the help text suggests, a key that may write but not
  delete, and a lifecycle rule in the bucket that removes copies after the club's chosen time. A stolen server
  then can't wipe its own off-site copies.
- **New dependencies.** S3 signing (`aws4fetch`, or our own SigV4 of about 100 lines) and `age` (`age-encryption`,
  the reference TypeScript implementation). `AGENTS.md` forbids a new dependency the brief doesn't name: question 6.

Bringing an off-site copy back is (a)'s steps with one more: download it from the storage's own site and
`age -d`.

## 8. Security and privacy

- **One new permission, `Admin.Backups.ReadWrite`, in `ADMIN_ONLY`**, with words ("See and manage backups") and an
  area. Every backup holds every family's records, staff-only notes, the audit log and sealed secrets, so no custom
  role may hold it. It guards the page, every action and the download route.
- **Audited**, each in its transaction, with words in `ACTION_NAMES`: `backup.run.request`, `backup.schedule.update`,
  `backup.download.request`, `backup.download.fetch`, `backup.check.request`, `backup.offsite.update`,
  `backup.offsite.test`, `backup.offsite.remove` (and `backup.restore.request`, `backup.restore.done`,
  `backup.restore.undo` with (b)). The agent's outcomes are `backup_request` rows, not audit rows: it isn't a person.
- **Downloads**: a route handler, `/staff/settings/backups/download`, which checks the staff session and the
  permission first and answers a bare 404 otherwise; takes the request's id and finds it only among the asker's own
  finished `download` requests; sends `cache-control: no-store` and a fixed name,
  `Content-Disposition: attachment; filename="boosters-rocket-backup.tar"`; streams, and deletes the file once sent.
  Listed in `ROUTE_HANDLERS`. One prepared download at a time, live 15 minutes, used once.
- **Who may download:** an Admin, after a confirm that says what the file holds. *(Proposed)* not re-asked for their
  sign-in: staff sign in with Microsoft or Google, and the portal has no staff "ask again" yet (question 7).
- **What never leaves through the app:** the env file, `SETTINGS_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, the
  database passwords, the `.p12` and its passphrase. A download without them restores data that can't be fully read,
  which is the point: a stolen download alone doesn't open the QuickBooks connection or the mail password. The tar's
  `KEEP-THESE-TOO.txt` says what else is needed.
- **Local files stay as they are**: mode 600, owned by `BACKUP_DIR`'s owner. Not encrypted on the server, which holds
  the live database anyway.
- **The app gains no privilege**: no socket, no `BACKUP_DIR`, no superuser, no access to Documenso's database. The
  worst a taken-over app can do is ask for backups and downloads (it can already read every row), and, with (b), a
  restore, which keeps the old databases.

## 9. The page

One Settings item, **Backups**, in Administration, after Health: key `backups`, keywords "restore", "download",
"off-site", "storage", "S3", "schedule", "copy"; `see` and `change` both `Admin.Backups.ReadWrite`; its rail status
"Backed up" / "Needs attention" / "Not answering" in `RAIL_STATUS`. It starts with `<SettingsHeader />` and
`PageHeader` ("Backups", "Copies of the club's records, made every night."). Mocks with these words go to the owner
before any code (owner-taste rule 10).

1. **Status card.** "Last backup: today at 3:00 AM. Read back in full." with a status label (Recent, Needs
   attention, Failed, Under way), the two sizes, the free disk ("41 GB free on the server"), and "Next: tonight at
   3:00 AM". A failure shows the agent's one line in a `Notice`. Primary button **Back up now**; secondary
   **Download the latest backup**. While one runs: "Backing up, started 2:14 PM." and the page refreshes itself.
2. **Schedule card.** "Every night at 3:00 AM. Keeps the newest 14." Button **Change the schedule** opens a `Drawer`
   (Time, a `TextInput` of type time, or "Don't back up on a schedule" as a `Checkbox`; How many to keep, 1 to 60).
   One line by Save when "keep" goes down: "Older backups beyond this number are removed after the next backup."
3. **Backups on this server.** A `DataTable`: when, size, Documenso included, last checked. Each row's action on the
   row: **Download**, **Check this backup** (option (c)).
4. **Off-site copies.** Not set up: one sentence, "Keep a copy away from this server, in storage the club rents."
   and **Set up off-site storage** (a `Drawer`). Set up: "Last copy: today at 3:04 AM." with **Test the
   connection**, **Change**, and **Stop off-site copies** (a `ConfirmDialog`: "Copies already there stay. New
   backups won't be copied.").
5. **Restore.** One sentence, "Putting a backup back replaces everything done since it was made." and the
   `LinkButton` **Restore a backup**, to its own page, `/staff/settings/backups/restore` (option (a)'s steps, or
   (b)'s form).
6. **Keep these too.** One sentence: "Keep the server's env file and Documenso's signing certificate with its
   passphrase in the board's password manager. Backups can't bring the portal back without them."

`ConfirmDialog`s: **Download** ("This file holds every family's records. Keep it private, and delete it when
you're done."), **Stop off-site copies**, and with (b) the restore (the club's name typed, a tick, "Everything done
since Tuesday, November 24 at 3:00 AM is lost, and everyone is signed out."). No fold-outs; every answer is
`ActionOutcome` in place. Times by `LocalTime`, sizes in plain units. The agent not answering: one `Notice`, "The
backup service on the server isn't answering, so backups can't be managed here. The person who looks after the
server can check it.", with every button that needs it left out.

## 10. Health

- **Last backup** stays (the migrate step and the runbooks name it), and links to Backups.
- **Backup service**, new: answering, or not since when (`backup.agent`), and the free disk, warning under 10 % or
  two backups' worth *(Proposed)*.
- **Off-site copies**, new, shown only once set up: the last copy, and a warning after two nights without one.
- **Last restore check**, a note on Last backup: when a backup was last checked, and whether it passed.

Each new line or warning gets its entry in `docs/runbooks/health-warnings.md`, and its key in
`tests/integration/health-page.test.ts` and `tests/e2e/ops.spec.ts`.

## 11. Tests

- **The agent, for real**, as `tests/integration/backup-restore.test.ts` does: a `backup` request is claimed once
  (two agents, one claim), backs up both databases and writes `backup_file`; a request naming a time it never listed,
  a path, or a kind it doesn't know is refused, touching nothing; `download` writes one tar into the outbox, owned
  by the app's user, and it is swept after its life; `check` restores into the side databases, records the counts and
  drops them, never touching the live ones; the schedule is read from the setting, then the environment; the
  heartbeat is written. `backup-schedule.test.ts`'s cases carry over for `--now` and `--next`. Shellcheck lists the
  new script.
- **The app**: every action refuses without `Admin.Backups.ReadWrite` (and the permission is refused to a custom
  role: `tests/unit/permissions/rules.test.ts`); each writes its audit row; the schedule's checks (time, off, 1 to
  60); one unfinished request per kind; the download route's 404 for no session, another staff member's request, a
  spent or expired one, and its `no-store` and fixed name; off-site credentials are sealed and never in the page's
  props; uploads against an in-process fake S3 that checks the signature, and a copy that `age` decrypts.
- **The tripwires** (`docs/agents/tripwires.md`): `page-guards.test.ts` (`ROUTE_HANDLERS`), `settings-sections.test.ts`,
  `audit-actions.test.ts`, `permission-words.test.ts`, `cleanup.test.ts` (`backup_request` cleaned,
  `backup_file` kept), `deploy-names-no-host.test.ts` (no provider or bucket written into `deploy/`), the staff menu
  and a11y specs, and screenshots of Backups at 390 and 1440.

## 12. Rollout

One pull request, in slices *(Proposed)*:

1. **The agent and the status.** `backup-agent.sh`, the tables, the heartbeat, the Backups page read only (status
   card, the server's backups, next run), Health's Backup service line. `deploy/compose.yml` runs the agent and adds
   the `backup-outbox` volume; `docker-compose.poc.yml` likewise.
2. **Back up now, and the schedule.** The setting replaces `BACKUP_AT` and `BACKUP_KEEP` as the source, the env
   values staying the first ones until saved. The migrate step's refusal also says "or press Back up now on
   Settings, Backups"; the runbooks' commands keep working.
3. **Download.**
4. **Check this backup, and the restore page** (options (c) and (a)).
5. **Off-site copies** (once question 6 is answered).
6. **In-app restore** (option (b)), only if the owner chooses it.

An installation picks the agent up with its next update (`docs/runbooks/updates.md`), since the change is in
`deploy/compose.yml`. Until then the page shows "isn't answering" and the old commands still work.
`docs/agents/operations.md`, `docs/runbooks/backups.md`, `restore.md`, `health-warnings.md` and `docs/conformance.md`
(14.5, 14.6) change in the slices that change them.

### What stays manual

- Keeping `deploy/.env` and the `.p12` with its passphrase safe (and now the off-site passphrase).
- Creating the storage account, the bucket, a write-only key and the lifecycle rule.
- A restore onto a new machine (there is no app yet), and with (a), every restore.
- Installing, updating, and Postgres major-version moves.
- Restoring an off-site copy (download it from the storage's site, decrypt with `age`, then the restore steps).

## 13. Questions for Brian

1. **Which restore option?** Recommended: (c) Check this backup and (a) the guided steps now; (b) later, only if you
   want it once (c) has run on real installations. (b) closes the last SSH task but can wipe a club's recent work
   from a phone.
2. **Is off-site storage in v1 of this?** Recommended: yes, as the last slice before any in-app restore. A backup
   only on the machine it protects is lost with it, and the rsync step is the one most clubs never do.
3. **How many to keep, and for how long?** Recommended: keep today's 14 nightly as the default, changeable from 1 to
   60; no weekly or monthly tiers on the server. Off-site, the bucket's own lifecycle rule decides (suggest 90 days).
4. **Should the check run by itself?** Recommended: yes, once a month, with its result on Health, as well as the
   button.
5. **Encrypt off-site copies with a passphrase the portal shows once?** Recommended: yes, in the standard `age`
   format, kept with the env file. The other choice, deriving it from the env file's key, is simpler but means one
   leaked file opens everything.
6. **New dependencies for off-site copies?** Recommended: `age-encryption` (pinned) for the encryption, and our own
   S3 signing rather than a client library. Without your word on the first, off-site copies wait.
7. **Who may download?** Recommended: any Admin, behind a confirm, audited, no second step for now. If you'd like
   downloads to ask an Admin to sign in again first, that is a staff "ask again" the portal doesn't have yet.
8. **Keep the env settings `BACKUP_AT` and `BACKUP_KEEP`?** Recommended: yes, as the first values only, until
   someone saves the schedule on the page; then the page wins.
