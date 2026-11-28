# Backups

Every night the installation backs up both databases: the portal's (families' records, staff, settings, the audit log,
kept signed forms) and Documenso's (templates, accounts, every form while it is being signed). Most of what follows is
done in the portal, on **Settings, Backups** (an Admin's page). The commands run in `~/booster-rocket/deploy`; add the
`-f` files and `--profile` you start the installation with.

## On Settings, Backups

The `backup` service runs `scripts/backup-agent.sh`, which looks at the portal every 10 seconds and does what the
page asks. On the page an Admin can:

1. see the last backup, the free space on the server and when the next one runs;
2. press **Back up now** (before an update, or when the update's migrate step asks for a recent backup);
3. change the schedule (the time, or none; how many to keep, 1 to 60). Until someone saves one, `BACKUP_AT` and
   `BACKUP_KEEP` from `deploy/.env` are used;
4. download a backup: one `.tar` file with both databases and a note of what else to keep, ready for 15 minutes and
   taken once;
5. put a backup back (**Restore this backup**, [restore](restore.md#from-the-portal));
6. turn on off-site copies (below).

If the page says the backup service isn't answering, `docker compose ps` should show `backup` as `Up`; `docker compose
logs backup` says why not. An installation older than this page runs the old nightly loop: update it
([updates](updates.md)).

## What a backup is, and what else to keep

Each night `scripts/backup.sh` writes two files into `BACKUP_DIR`, with the same time in their names:

- `booster-rocket-<time>.dump`, the portal's database;
- `documenso-<time>.dump`, Documenso's database.

It reads each file back in full before it keeps it, keeps both or neither, keeps the newest 14 of each
(`BACKUP_KEEP`), and tells the portal, so the Health page's **Last backup** line says when it ran and whether
Documenso's database was in it.

The files are made by the installation's Postgres, version 18. A backup made by Postgres 18 can't be loaded into an
older Postgres: 16 refuses it, and `scripts/restore.sh` says the file `was made by a newer version of Postgres than
this server's`, which means the file is fine, not damaged. One made by Postgres 16, before the installation moved to
18, loads into 18 as any backup does ([updates](updates.md#backups-from-before-and-after-the-move)).

Three things are not in the files, and a backup can't bring the portal back without them. Keep them together,
somewhere safe that is not this machine (the board's password manager):

1. `deploy/.env`. Its `SETTINGS_ENCRYPTION_KEY` is what reads the QuickBooks connection, the sign-in certificates,
   the mail password and parents' authenticator apps stored in the portal's database. Losing it loses every parent's
   app: they sign in with a backup code or ask the club. After changing it, keep the old one as
   `SETTINGS_ENCRYPTION_KEY_PREVIOUS` for good, and in the safe place too: each app is sealed again under the new key
   the next time its holder signs in with it, but an app not used since still needs the old key, and a second change
   (which replaces `SETTINGS_ENCRYPTION_KEY_PREVIOUS`) loses the apps not used since the first. Its
   `BETTER_AUTH_SECRET` matters too: with a different one, every parent's backup codes, remembered phones and computers
   and emailed links stop working ([first install, part 3](first-install.md#3-fill-in-the-settings)).
2. Documenso's signing certificate (the `.p12` file named by `DOCUMENSO_SIGNING_CERTIFICATE`) and its passphrase.
3. A copy of the backups themselves: a backup that lives only on the machine it protects is lost with it.

## The nightly schedule

The `backup` service does it, every night at the time saved on Settings, Backups, in the club's time zone (Settings,
Club). Until a time is saved there, at `BACKUP_AT` (default `03:00`) in `CLUB_TIME_ZONE`.

1. See what it did: `docker compose logs backup`. Each night adds the lines of one backup, and nothing else.
2. See when the next one is: `docker compose run --rm backup --next`.
3. Take one now: `docker compose run --rm backup --now`.
4. Change the time: on Settings, Backups, **Change the schedule** (not between 01:00 and 03:00 where the clocks
   change then).

### Using the host's own scheduler instead

1. On Settings, Backups, **Change the schedule** and tick "Don't back up on a schedule" (or, before anyone has saved a
   schedule there, set `BACKUP_AT=off` in `deploy/.env` and `docker compose up -d backup`). The service still answers
   the page, but makes no nightly backup.
2. Run `crontab -e` as the person who looks after the installation, and add one line (it runs at 03:00 by this
   machine's clock; change the path to your checkout):
   ```
   0 3 * * * cd "$HOME/booster-rocket/deploy" && docker compose run --rm -T backup --now >> "$HOME/booster-rocket-backup.log" 2>&1
   ```
3. The next morning, check the log file and the Health page.

## Off-site copies

Optional, and off until an Admin turns them on: after every backup, an encrypted copy goes to S3-compatible storage the
club rents. Any storage that speaks the S3 API works.

1. At the storage's own site: make a bucket, and an access key that may write to it but not delete (so nobody who
   reaches this server can remove the copies). Add the bucket's own rule that removes copies older than the club
   wants, 90 days say: the portal never deletes there.
2. On Settings, Backups, **Set up off-site copies**: the storage's S3 address, its region (or `auto`), the bucket, a
   folder if you want one, the key's ID and secret. Press **Turn on off-site copies**.
3. The answer shows the copies' passphrase, once. Put it in the board's password manager with `deploy/.env`: without
   it the copies can't be opened.
4. Press **Test the connection**. It writes one small file to the bucket.
5. The morning after, the table's Off-site copy column says Copied, and Health has an **Off-site copies** line.

A copy is named `boosters-rocket-<time>.tar.enc`. To open one, download it from the storage's site, then:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in boosters-rocket-<time>.tar.enc -out backup.tar
tar -xf backup.tar
```

## Copying the backups off this machine by hand

Instead of off-site copies, copy `BACKUP_DIR` somewhere else every day, after the backup has run: another machine, or storage the club rents. The
files are private (each family's records are in them): keep the copy where only the board can read it. Each backup
file belongs to the owner of `BACKUP_DIR` (the person who looks after the installation, from the first installation)
and only they can read it, so run the copy as that person, from their own `crontab -e`; a copy run as anyone else is
refused. Any tool that copies a folder works; an example with `rsync` to another machine the club controls, from cron
at 04:00:

```
0 4 * * * rsync -a --delete /srv/booster-rocket/backups/ <user>@<other machine>:booster-rocket-backups/
```

## Checking a backup can be restored

Once a term, restore the newest backups into databases of their own, beside the live ones. Nothing live changes.

```bash
docker compose run --rm --entrypoint bash backup /opt/booster-rocket/scripts/restore.sh /backups/<booster-rocket file> booster_restore_check --owner booster
docker compose run --rm --entrypoint bash backup /opt/booster-rocket/scripts/restore.sh /backups/<documenso file> documenso_restore_check --owner documenso
```

Each says `Restored ... (<number> tables, owned by ...)`. Then remove the copies:

```bash
docker compose exec db psql -U postgres -c "drop database booster_restore_check" -c "drop database documenso_restore_check"
```

## When it fails

`docker compose logs backup` has the reason, in words. The exit codes: 2 refused (a setting or the folder is wrong),
3 a database didn't answer, 4 the backup failed and nothing was kept. A failed night keeps every older backup. The
Health page's backup line warns once the last good backup is more than two days old ([Health page
warnings](health-warnings.md#last-backup)).
