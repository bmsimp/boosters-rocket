# Restore

Bringing the portal and Documenso back from a backup: onto the same machine (a database went wrong, an update must be
undone) or onto a new one (the machine is gone). You need the backup files, `deploy/.env` as it was, and Documenso's
signing certificate with its passphrase ([backups](backups.md)).

A restore puts back everything as it was at the backup: anything done since (a form signed, a parent's change, an audit
row) is gone from the portal. QuickBooks is not touched; the portal reads it again on its own.

A backup made by Postgres 16 (from before the installation moved to Postgres 18) restores into Postgres 18 with these
same steps. A backup made by Postgres 18 can't be restored into Postgres 16: going back to 16 is done with its old
volume, not a backup ([updates](updates.md#going-back-to-postgres-16)).

The commands run in `~/booster-rocket/deploy`; add the `-f` files and `--profile` you start the installation with.

## Onto the same machine

1. Choose the backup: `ls -l /srv/booster-rocket/backups` (the time is in each name, in UTC). Use the
   `booster-rocket-` and `documenso-` files with the same time.
2. Take a backup of what is there now, in case you want it back: `docker compose run --rm backup --now`.
3. Stop everything that uses the databases, leaving the database running:
   ```bash
   docker compose stop app worker documenso backup
   ```
4. Restore the portal's database, replacing it:
   ```bash
   docker compose run --rm --entrypoint bash backup /opt/booster-rocket/scripts/restore.sh /backups/<booster-rocket file> booster --replace --owner booster
   ```
   It says `Restored ... into the database booster (<number> tables, owned by booster), replacing what was there.`
   If it says the database is in use, something still runs: step 3 again.
5. Restore Documenso's the same way:
   ```bash
   docker compose run --rm --entrypoint bash backup /opt/booster-rocket/scripts/restore.sh /backups/<documenso file> documenso --replace --owner documenso
   ```
6. Start everything: `docker compose up -d`. The migration step brings an older backup up to the running version.
7. Check, as in [After a restore](#after-a-restore).

A restore that fails leaves the database as it was: the backup is loaded beside it first, and only takes its name when
all of it has loaded.

## Onto a new machine

1. Install Docker, git and openssl, and get the files as in [a first installation](first-install.md), steps 1 and 4
   (the same release as the backup was taken on, or a newer one).
2. Put back `deploy/.env` as it was, and the signing certificate at the path it names (with `chown 1001` and
   `chmod 400`, as in [Documenso](documenso.md#1-make-the-signing-certificate)). Don't make new secrets: the backup needs
   the old `SETTINGS_ENCRYPTION_KEY` and database passwords.
3. Copy the two backup files into `BACKUP_DIR`.
4. Start only the database: `docker compose up -d db`, and wait until `docker compose ps` says `healthy`. It makes the
   two empty databases and their roles, with the passwords in `.env`.
5. Restore both, as in steps 4 and 5 above (with `--replace`: the empty databases are replaced).
6. Start everything: `docker compose up -d` (with `--profile proxy` if you use this installation's proxy).
7. Point the two addresses at the new machine, if it has a new network address.
8. Check, as below.

## After a restore

1. Sign in as an Admin and open **Health**. Each line says when that part last worked.
2. Look at **QuickBooks**, **Outgoing mail** and **Forms (Documenso)** first: a wrong `SETTINGS_ENCRYPTION_KEY` shows there as a
   token or password that "can't be opened" or "can't be read".
3. Open `<DOCUMENSO_URL>/api/health`: `"database"` and `"certificate"` both say `ok`. A certificate problem means the
   file or its passphrase isn't the one in `.env`.
4. Take a backup now: `docker compose run --rm backup --now`. The restored database holds the backup time recorded
   before it was dumped, so until this backup is made, starting a newer version is stopped by the migrate step's
   backup check ([updates](updates.md#when-the-start-stops-for-a-backup)).
