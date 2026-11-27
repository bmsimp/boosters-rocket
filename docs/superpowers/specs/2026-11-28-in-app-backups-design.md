# In-app backups — design

**Status:** approved by the owner on 2026-11-27 (his two decisions below); built in the slices of section 10.
**Asked for by:** the owner, 2026-11-25: the portal manages its own backups from Settings, so nobody has to SSH into
the server to back up, download or restore (`docs/agents/owner-taste.md`, rule 8).

Words used here. The **backup service** is `deploy/compose.yml`'s `backup` container (Postgres 18's image, our scripts
mounted read only, the superuser's password, `BACKUP_DIR` at `/backups`). The **agent** is what it runs:
`scripts/backup-agent.sh`. A **backup** is one pair of files with one time in their names,
`booster-rocket-<time>.dump` and `documenso-<time>.dump`, as `scripts/backup.sh` has always made them.

## 1. The owner's decisions (2026-11-27)

1. **Off-site copies are optional, a setting an Admin may turn on, never required, and off by default.** One kind of
   storage: **S3-compatible storage** (its address, region, bucket, a folder, an access key). No provider is named
   anywhere in the app.
2. **One-click restore is in.** Admin only, behind a ConfirmDialog that says what is lost (everything done since that
   backup was made). The agent takes a fresh backup just before it restores, so the moment before is always one of the
   backups in the list. Every restore is audited.

## 2. How the app asks for work it can't do

The app runs as `node` with no `pg_dump`, no access to `BACKUP_DIR`, no Docker socket and no superuser. The backup
service has all of them, so it does the work, and the app only asks:

- The app writes a row in `backup_request` (`backup`, `download`, `restore`, `upload`), audited in the same
  transaction. Nothing listens on a port; the app gains no privilege.
- The agent, every 10 seconds: writes its heartbeat (the setting `backup.agent`: when it looked, the free space in
  `/backups`, when the next backup is due); reads the schedule (`backup.schedule`, falling back to `BACKUP_AT` and
  `BACKUP_KEEP` until someone saves one) and the club's time zone (the Club setting, falling back to `TZ`); lists
  `/backups` into `backup_file`; claims at most one waiting request (`for update skip locked`), does it and writes its
  outcome and one line of words; and makes the nightly backup when it is due, as a request of its own.
- A row is a request, never an instruction. A request's kind is one of a fixed list; a backup's time must match
  `^[0-9]{8}T[0-9]{6}Z$` **and** name a pair the agent listed itself. Nothing from a row becomes a path, a database
  name, a command or SQL.
- `docker compose run --rm backup --now` and `--next` still work, so every runbook command does.
- If the agent isn't answering (an installation not yet updated, the service stopped), the heartbeat goes stale and
  the page says so in one line, with every button that needs the agent left out.

**Files to the browser and to off-site storage** go through one small volume, `backup-outbox`, mounted in the backup
service and the app (`BACKUP_OUTBOX`, `/backup-outbox`), the app's user owning it. The agent copies the chosen pair
there as one tar file with `KEEP-THESE-TOO.txt`; the app streams it once and deletes it. The agent removes a download
left there after 15 minutes, and a staged upload after a day. The app never sees `BACKUP_DIR`.

## 3. Data

- `backup_request`: `id`, `kind`, `backup_at` (the pair's time, or null), `requested_by` and `requested_label` (the
  staff member, or null for the agent's own nightly backup and uploads), `requested_at`, `claimed_at`, `finished_at`,
  `outcome` (`ok`, `failed`, `refused`), `words` (the agent's one line: no secret, no family), `result` (jsonb: the
  outbox file's name and size, the fresh backup's time). One unfinished request of each kind at a time (a partial
  unique index). Cleaned 90 days after it finished.
- `backup_file`: one row per pair the agent last saw in `/backups`: `backup_at` (key), both sizes (Documenso's null when
  it was left out), `schema_at` (the time of the last migration in the dump, read by the agent), and the off-site copy's
  time and outcome. Rewritten by the agent at each look: a mirror of the folder, kept.
- Settings: `backup.schedule` (`{ at: "03:00" | "off", keep: 1..60 }`), `backup.agent` (the heartbeat),
  `backup.offsite` (section 6) and `backup.last_success`, exactly as before, since the migrate step's check reads it.

Nothing here is keyed by a QuickBooks id, so a change of company clears none of it.

## 4. Restore

The Admin presses **Restore this backup** on a row, reads "Everything done since <its time> is lost, and anyone who
signed in since then signs in again. A backup of how things are now is made first.", ticks the box and confirms. The
agent then:

1. refuses a backup whose `schema_at` differs from the running database's last migration (it was made by another
   version of the portal: the restore runbook's steps bring it back, since only the migrate step can change a schema);
2. takes a fresh backup with `backup.sh`; if that fails, nothing is restored;
3. loads both files beside the live databases (`<name>_restoring`), owned by each live database's owner, and only when
   both have loaded whole, ends every connection to each live database and drops it (`with (force)`), and renames each
   new one into its name;
4. writes into the restored database the audit row `backup.restore.done` (who asked, which backup, the fresh backup's
   time), the finished request, and `backup.last_success` naming the fresh backup.

The app's connections are ended and it reconnects by itself; so does Documenso. A parent's save in flight at that
moment is lost. The request's own audit row (`backup.restore.request`) is in the fresh backup. Putting the fresh backup
back undoes the restore.

## 5. The page: Settings, Backups

One Settings item, **Backups**, in Administration after Health (`see` and `change` both `Admin.Backups.ReadWrite`; its
rail status "Backed up", "Needs attention" or "Not answering"). `SettingsHeader` "Backups", "Copies of the club's
records, made on the server every night."

1. **Last backup.** When, and its size; the free space on the server; when the next one runs. **Back up now**
   (primary). While a request is under way: "Backing up, started 2:14 PM." and the page refreshes itself. A failure
   shows the agent's line in a `Notice`.
2. **Schedule.** "Every night at 3:00 AM. Keeps the newest 14." **Change the schedule** opens a `Drawer` (the time, or
   "Don't back up on a schedule"; how many to keep, 1 to 60).
3. **Backups on this server.** A `DataTable`: when, size, Documenso, off-site copy; on each row **Download** (a
   ConfirmDialog: "This file holds every family's records. Keep it private, and delete it when you're done.") and
   **Restore this backup** (section 4). A prepared download shows **Save the backup file** for 15 minutes.
4. **Off-site copies.** Off: "Keep a copy away from this server, in S3-compatible storage the club rents." and **Set
   up off-site copies** (a `Drawer`). On: the last copy, **Test the connection**, **Change off-site storage**, and
   **Stop off-site copies** (a ConfirmDialog: "Copies already there stay. New backups won't be copied.").
5. **Keep these too.** "Keep the server's env file, and Documenso's signing certificate with its passphrase, in the
   board's password manager. Backups can't bring the portal back without them."

No fold-outs; every answer is `ActionOutcome` in place; times by `LocalTime`.

## 6. Off-site copies

- After each backup that worked, while off-site copies are on, the agent stages the pair in the outbox and leaves an
  `upload` request; the worker (the app's own process, which holds `SETTINGS_ENCRYPTION_KEY`) encrypts it as it streams
  it up, records the outcome on `backup_file`, and deletes the staged file.
- **Encrypted before it leaves**, with a passphrase the portal makes when off-site copies are set up and shows once
  ("Keep this with the env file. Without it, these copies can't be opened."). The format is OpenSSL's own
  (`openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256`), so a club decrypts with the standard `openssl` tool and
  no portal: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in <copy> -out backup.tar`.
- The access key's secret and the passphrase are sealed by `secretBox()` and never sent back to the page (it shows the
  key ID's last four characters).
- Uploads are signed with AWS Signature Version 4, our own code with Node's crypto (no new dependency), path-style
  (`<address>/<bucket>/<folder>/<file>`), `https` only (`http` only to this machine, for tests). **Test the
  connection** writes one small file.
- The portal never deletes off-site. A key that may write but not delete, and the bucket's own rule removing old
  copies, mean a stolen server can't wipe its copies.

## 7. Security and privacy

- **One new permission, `Admin.Backups.ReadWrite`, in `ADMIN_ONLY`** ("See backups, make one, download one, restore
  one, and set up off-site copies"): a backup holds every family's records, staff-only notes, the audit log and sealed
  secrets. It guards the page, every action and the download.
- **Audited**, each in its transaction: `backup.run.request`, `backup.schedule.update`, `backup.download.request`,
  `backup.download.fetch`, `backup.restore.request`, `backup.restore.done` (written by the agent),
  `backup.offsite.update`, `backup.offsite.test`, `backup.offsite.remove`.
- **The download** is a route handler, `/staff/settings/backups/download`: a staff session with the permission,
  checked first; the request's id taken from the query and found only among the asker's own finished `download`
  requests under 15 minutes old; `cache-control: no-store`, a fixed name (`boosters-rocket-backup.tar`); streamed
  once, then deleted. Anything else answers the same bare 404.
- **What never leaves through the app:** the env file, `SETTINGS_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, the database
  passwords, the `.p12` and its passphrase. A stolen download alone doesn't open the QuickBooks connection or the mail
  password. The tar's `KEEP-THESE-TOO.txt` says what else is needed.

## 8. Health

- **Last backup** stays (the migrate step and the runbooks name it), and now leads to Backups.
- **Backup service**, new: answering, or not since when, and the free space, warning under 2 GB.
- **Off-site copies**, new, only while they are on: the last copy, warning after two days without one, or when the
  last upload failed.

Each line's entry is in `docs/runbooks/health-warnings.md`.

## 9. Tests

- **The agent, for real** (`tests/integration/backup-agent.test.ts`, as `backup-restore.test.ts` does): a request is
  claimed once and backs up both databases and fills `backup_file`; a time it never listed, or a kind it doesn't know,
  is refused, touching nothing; a download writes one tar into the outbox; a restore takes the fresh backup first,
  swaps the database, writes its audit row and refuses a backup of another schema; the heartbeat is written. Shellcheck
  lists the new script.
- **The app**: every action refuses without the permission (and no custom role may hold it); each writes its audit
  row; the schedule's checks; one unfinished request per kind; the download's 404s (no session, another person's
  request, a spent or old one), `no-store` and fixed name; off-site secrets sealed and never in the page; uploads
  against an in-process fake storage that checks the signature, and a copy `openssl` decrypts.
- **The tripwires** (`docs/agents/tripwires.md`): `ROUTE_HANDLERS`, `settings-sections`, `audit-actions`,
  `permission-words`, `cleanup` (`backup_request` cleaned, `backup_file` kept), `audit-rows`, Health's keys.

## 10. Slices

1. The tables, the permission, the agent with its heartbeat, listing, Back up now and the schedule; the page read
   only plus those two; Health's Backup service line; `deploy/compose.yml` runs the agent with the outbox.
2. Download.
3. Restore.
4. Off-site copies.

An installation picks the agent up with its next update; until then the page says the backup service isn't answering
and the old commands still work. `docs/agents/operations.md`, `docs/runbooks/backups.md`, `restore.md`,
`health-warnings.md` and `docs/conformance.md` (14.5, 14.6) change with the slices.

### What stays manual

- Keeping `deploy/.env`, the `.p12` with its passphrase, and the off-site passphrase safe.
- Renting the storage, making the bucket, a key that can't delete, and the rule that removes old copies.
- A restore onto a new machine, of a backup made by another version, or of an off-site copy (the restore runbook).
- Installing, updating, and Postgres major-version moves.
