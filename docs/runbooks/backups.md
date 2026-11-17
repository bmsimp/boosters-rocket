# Backups

Every night the installation backs up both databases: the portal's (families' records, staff, settings, the audit log,
kept signed forms) and Documenso's (templates, accounts, every form while it is being signed). The commands run in
`~/booster-rocket/deploy`; add the `-f` files and `--profile` you start the installation with.

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

1. `deploy/.env`. Its `SETTINGS_ENCRYPTION_KEY` is what reads the QuickBooks connection, the sign-in certificates and
   the mail password stored in the portal's database.
2. Documenso's signing certificate (the `.p12` file named by `DOCUMENSO_SIGNING_CERTIFICATE`) and its passphrase.
3. A copy of the backups themselves: a backup that lives only on the machine it protects is lost with it.

## The nightly schedule

The `backup` service does it: at `BACKUP_AT` (default `03:00`) in `CLUB_TIME_ZONE`, every night.

1. See what it did: `docker compose logs backup`. Each night adds the lines of one backup, and nothing else.
2. See when the next one is: `docker compose run --rm backup --next`.
3. Take one now: `docker compose run --rm backup --now`.
4. Change the time: set `BACKUP_AT` in `deploy/.env` (24-hour clock; not between 01:00 and 03:00 where the clocks
   change then), then `docker compose up -d backup`.

### Using the host's own scheduler instead

1. In `deploy/.env`, set `BACKUP_AT=off`, then `docker compose up -d backup`. The service then waits without backing up.
2. Run `crontab -e` as the person who looks after the installation, and add one line (it runs at 03:00 by this
   machine's clock; change the path to your checkout):
   ```
   0 3 * * * cd "$HOME/booster-rocket/deploy" && docker compose run --rm -T backup --now >> "$HOME/booster-rocket-backup.log" 2>&1
   ```
3. The next morning, check the log file and the Health page.

## Copying the backups off this machine

Copy `BACKUP_DIR` somewhere else every day, after the backup has run: another machine, or storage the club rents. The
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
