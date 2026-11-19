# Updates

Updating the portal to a new release, and Documenso or the other images when a dependency update moves them. Pick a
quiet time: the portal is away for a minute or two. The commands run in `~/booster-rocket/deploy`; add `--profile proxy`
if you use this installation's proxy.

## 1. Before anything

1. Sign in as staff and open **Reconciliation**. Under "Changes waiting to reach QuickBooks", clear every rename of a
   family, member or student, every new student, and every move of a student, that is waiting or stuck there: press **Try again now** and wait
   for it to go through, or **Give up**, which is the way for one that can't go through. An update that changes how
   those changes are sent refuses to start while one is there (part 3 says how that reads), and changes nothing. A
   change to make someone inactive, a parent's change, a new family, a volunteer buy-out's invoice, and a change
   kept in the portal that QuickBooks didn't take can stay.
2. Read the release's notes on the repository's **Releases** page, for every release since yours. A note that says
   "change your .env" means a new line to fill in: `.env.example` has it. A release that moves Postgres to a new major
   version says so: follow [Moving to a new major version of Postgres](#moving-to-a-new-major-version-of-postgres)
   instead of part 2.
3. Back up both databases: `docker compose run --rm backup --now`. Note the time in the file names it prints: it is the
   way back. The start in part 2 checks for it: see [When the start stops for a backup](#when-the-start-stops-for-a-backup).

## 2a. With the published image

1. Get the release's files (the compose file and scripts can change too):
   ```bash
   cd ~/booster-rocket
   git fetch --tags
   git checkout <version>
   cd deploy
   ```
2. If `BOOSTER_ROCKET_IMAGE` ends in `:stable`, pulling gets the newest release; if it names a version, change it to
   the new one first.
3. Pull and restart:
   ```bash
   docker compose pull
   docker compose up -d
   ```

## 2b. With an image built from the checkout

1. Get the code you want to run: `git fetch --tags` and `git checkout <version>` (or a branch with a change not yet
   released: `git pull`).
2. Build and restart:
   ```bash
   APP_COMMIT="$(git rev-parse --short HEAD)" docker compose -f compose.yml -f compose.build.yml up -d --build
   ```

## 3. Check it

1. `docker compose ps`: `app` and `documenso` say `healthy`, `migrate` says `Exited (0)`. If `migrate` failed,
   `docker compose logs migrate` says why, and the app was not started on a database it couldn't bring up to date.
   One reason is the backup check, below. Another is a change the database refuses: the log shows a line starting
   "migration failed: Failed query", followed by the change itself, in which you'll find the words "Migration ...
   stopped, and changed nothing", and then a line starting "the database said:" with the reason and how many rows it
   is about. `docker compose logs db` shows the same reason as an `ERROR:` line. Every change of one update is made
   together or not at all, so when one stops, none of them is kept and the database is exactly as the version you
   were running left it. Two such changes are yours to clear: "Migration 0041 stopped, and changed nothing: ... staff
   change(s) to the roster are still waiting or stuck on the queue", and "Migration 0042 stopped, and changed nothing:
   ... staff move(s) of a student are still waiting or stuck on the queue". Run the previous version again
   ([Going back](#going-back)), clear them on **Reconciliation** as part 1 says, and update again. For any other,
   keep it as it is, report both logs' lines, and run the previous version until a fix comes.
2. Sign in as an Admin and open **Health**: **Version** names the new version, and every line reads as it did before
   ([Health page warnings](health-warnings.md) for any that doesn't).
3. Open the portal as a parent would (a test family): Home, Payments, Forms.

## The update that brings password sign-in

Up to this release, parents signed in with a code the portal emailed them. From it, they sign in with their email
address and a password they choose from a link the portal emails them (and on a phone or computer the portal doesn't
know yet, a code too). After the update:

1. Parents who are signed in now stay signed in. Everyone else needs a password, and nobody has one yet.
2. Sign in as an Admin and open **Settings**, **Parent sign-ins**. With parent sign-ins and welcome emails both on
   (welcome emails need sign-ins on first), the section **Passwords not chosen yet** counts everyone who can sign in and
   has no password, and shows the email they will get. Press **Email a set-up link to everyone who can sign in and
   hasn't chosen a password** once.
3. Each person counted gets an email with a link to choose their password ("Choose your password for" the club). It
   works once, for 7 days. Someone never welcomed gets the welcome instead, with the same kind of link.
4. They go out five each time the worker wakes, and it wakes about once a minute: 300 people take about an hour, and
   500 about an hour and 40 minutes. While mail is failing it tries one a minute; Health's parent sign-ins line says so.
5. Meanwhile, and after a link runs out, a parent can always ask for a new link themselves at `/sign-in/password`
   ("Set up or reset my password" on the sign-in page), at the Standard level every club has until a later release
   offers Strict.

## When the start stops for a backup

A new version often has changes to make to the portal's database. Before the `migrate` step makes them to a database
that already holds data, it checks that a backup of it was made in the last 26 hours: the time the last good backup
was recorded (the nightly one, or `docker compose run --rm backup --now`; the Health page's **Last backup** line shows
it). If there is none that recent, it changes nothing, the portal doesn't start, and `docker compose logs migrate`
says so and what to do:

1. Make a backup now, from `~/booster-rocket/deploy`:
   ```bash
   docker compose run --rm backup --now
   ```
   The backup runs on its own, with the portal stopped.
2. Start it again the way you started it, for example `docker compose up -d` (with `--profile proxy` if you use this
   installation's proxy). The check now passes and the update goes on.

The check never stops a first installation (an empty database has nothing to lose), and never stops a start with no
changes to make, such as a restart after the machine rebooted.

If you already have a backup of your own made since the portal last changed (a copy of the whole machine, say) and
can't make one now, let this one start go ahead without it:

```bash
MIGRATE_WITHOUT_RECENT_BACKUP=yes docker compose up -d
```

Use it only for that one start, on the command line. Never put `MIGRATE_WITHOUT_RECENT_BACKUP` in `.env`: it would
switch the check off for every update after this one.

## Going back

After a `migrate` that failed, nothing was changed, so no restore is needed: put back the previous version's files and
image (step 1 below) and start it the way you started it, for example `docker compose up -d`. Its `migrate` finds
nothing to do, and the portal runs as it did before the update.

Otherwise the databases move forward with an update and can't be moved back on their own, so going back is a restore
of the backup from part 1:

1. Put back the previous version's files and image: `git checkout <previous version>` and, for the published image, the
   previous version in `BOOSTER_ROCKET_IMAGE` (not `stable`), then `docker compose pull`.
2. Follow [restore, onto the same machine](restore.md#onto-the-same-machine), steps 3 to 7, with the backup from part 1.

## Documenso and the other images

A dependency update (a pull request that changes `deploy/compose.yml`) may move Documenso, Postgres or the proxy to a new
version. Merge it like any change, then update as above. Documenso is the one to be careful with:

1. Read Documenso's release notes for every version between the old and the new, and look for changes to signing,
   the API, webhooks or embedded signing: the portal was checked against the version the compose file names.
2. After updating, sign a test form end to end, open the signed PDF, and check the Health page's forms line.
3. A dependency update never moves Postgres to a new major version: `.github/dependabot.yml` is told not to offer one
   (the build's lead chose this, so that a move is always a release of its own with the section below). It may move
   Postgres within its version (18.7 to 18.8, say): that is an ordinary update.

## Moving to a new major version of Postgres

Postgres keeps its data in a form that changes between major versions (16, 17, 18): a new major version can't start on
the old data. The data is moved instead: backed up by the old version, loaded into the new one, and checked. Booster
Rocket moved from Postgres 16 to Postgres 18 in this way; the release that does it says so in its notes.

Until the move is done, the database refuses to start on the new release, and nothing else starts either.
`docker compose up -d` stops with `dependency failed to start: container ... db-1 is unhealthy`, and
`docker compose logs db` says `Booster Rocket: Postgres was NOT started, and no data was changed or deleted.`, why, and
the name of this section. Nothing is lost: the club's data is still in Postgres 16's own volume, exactly as it was. The
move only reads it, through a read-only mount, to copy it: it is never written to, deleted or set up again, and the
portal never starts on an empty database instead.

The move takes a few minutes for a club's data. The portal and Documenso are away while it runs: pick a quiet time.
Never go back to the previous version, or start it from another window, while a move is running.

### Before the move

Do these with the version you have now, before you get the new release's files.

1. Back up both databases, as in part 1: `docker compose run --rm backup --now`. Once the new files are checked out,
   this command waits for a database that won't start until the move is done.
2. Check there is room. The move makes a copy of the data to work from, one more backup of both databases, and a
   second copy of the data in Postgres 18's own volume. See how big the data is, then that the disk has at least four
   times that free:
   ```bash
   docker compose exec db psql -U postgres -Atc "select pg_size_pretty(sum(pg_database_size(datname))) from pg_database"
   df -h ~ /var/lib/docker
   ```
3. The move carries the portal's database and Documenso's, with the roles a first installation makes, and nothing
   else. If you made another database or role on this server yourself, back it up now with `pg_dump`: the move names
   any it finds before it changes anything. A `booster_restore_check` or `documenso_restore_check` left from a
   [restore check](backups.md#checking-a-backup-can-be-restored) isn't needed.

### The move

1. Get the release's files and images, as in part 2a, steps 1 and 2 (or 2b, step 1), then, for the published image:
   ```bash
   cd ~/booster-rocket/deploy
   docker compose pull
   ```
2. Move the data, from the top of the checkout:
   ```bash
   cd ~/booster-rocket
   scripts/move-postgres.sh deploy ~/booster-rocket-moving-to-postgres-18
   ```
   It stops the portal, its worker, Documenso and the backup service; copies Postgres 16's data into a volume of its
   own and starts Postgres 16 on that copy, read only; counts the rows of every table in both databases and backs both
   up with Postgres 16's own tools into `~/booster-rocket-moving-to-postgres-18` (a folder of its own: the nightly
   backups never remove these files); starts Postgres 18 on a volume of its own, where it makes the two databases and
   their roles from `deploy/.env` as on a first installation; loads both backups; counts every table again; and records
   the move only when every count is the same. Last, it makes the first backup with Postgres 18 into `BACKUP_DIR`.
   **Success** is the lines `booster: <n> tables, every one with the same number of rows as before.` and
   `documenso: <n> tables, ...`, then `The move is done: Postgres 18 holds the data. ...`, the command to start the
   portal, and exit code 0 (`echo $?`).

   If it stops at the start with `The Postgres 16 server also holds what the move doesn't carry`, and names a database
   or a role, nothing was changed. A `booster_restore_check` or `documenso_restore_check` can be left behind: run the
   same command with `--leave-others` at the end. For anything else, back it up first (Before the move, step 3), then
   do the same.
3. Start the portal as you always do, from `~/booster-rocket/deploy`: `docker compose up -d` (with `--profile proxy` if
   you use this installation's proxy; for an image built from the checkout, the command of part 2b, step 2).
4. Check it, as in part 3. The Health page's **Last backup** line shows the backup the move made.

If the move stops with a message, or is cut off (a closed window, a power cut), nothing is lost and nothing is half
done where the portal could see it: until a move has finished, a start is refused with a message that says so. Read
the message, put right what it names, and run step 2 again: it starts again from the Postgres 16 data. Run it once
more after it has finished and it says the data was already moved, and changes nothing.

The database roles' passwords on Postgres 18 are the ones in `deploy/.env` when the move runs. If you ever changed one
in Postgres ([first install](first-install.md)), the same password must be in `deploy/.env`, as that section says.

### Backups from before and after the move

- Every backup made before the move, and the move's own two files, were made by Postgres 16. They load into Postgres
  18 with [restore](restore.md) as any backup does.
- A backup made by Postgres 18 (every one from the move on) can't be loaded into Postgres 16. `scripts/restore.sh`
  says so: `... was made by a newer version of Postgres than this server's (16...), so it can't be loaded here. The
  file itself is not damaged`. The file is fine, and Postgres 18 loads it. To go back to 16, use the old volume,
  below, not a backup. After going back, the previous version's `scripts/restore.sh` is the one on disk, and it says
  such a file `isn't a backup made by scripts/backup.sh, or it is damaged`: for a backup made after the move, that
  means only that Postgres 18 made it.

### Going back to Postgres 16

While Postgres 16's volume is still there, the previous version starts on it again, with the data as it was when the
move began. Anything done in the portal or Documenso since the move is not in it: it stays in Postgres 18's volume
and in the Postgres 18 backups in `BACKUP_DIR`.

1. Stop everything, from `~/booster-rocket/deploy`: `docker compose stop`
2. Always run this, from `~/booster-rocket`, even if no move was cut off. It stops whatever a move left behind and
   changes nothing else (it says `Nothing of a move was left here.` when there is nothing):
   `scripts/move-postgres.sh deploy --stop`
3. Copy the Postgres 18 backups to a folder of their own: Postgres 16's nightly backups go in the same folder and keep
   only the newest 14, so within two weeks they would remove them. With the folder `BACKUP_DIR` names in
   `deploy/.env`:
   ```bash
   mkdir -p ~/booster-rocket-postgres-18-backups
   cp -p <BACKUP_DIR>/*.dump ~/booster-rocket-postgres-18-backups/
   ```
4. Put back the previous version's files and image, as in [Going back](#going-back), step 1.
5. Start it: `docker compose up -d`. The Health page's **Version** names the previous version.

To come forward again later, update as above. The start is then refused again (Postgres 16 has been used since the
move), and `scripts/move-postgres.sh` says to run it with `--again` at the end. With `--again`, it first backs up what
Postgres 18 holds into `~/booster-rocket-moving-to-postgres-18/postgres-18-before-again`, and prints the files'
names. If Postgres 18 holds work done after the move (anything the portal recorded once it ran on Postgres 18), it
stops there, changes nothing else, and shows when the move was made and the newest record in each copy. The club
keeps one of the two:

- **The Postgres 16 data** (what was done since going back): run the move again with `--again --discard-18` at the
  end. The work done on Postgres 18 is then only in that backup: keep the folder.
- **The Postgres 18 data** (what was done before going back): do the same, then, before starting the portal, load the
  two files that backup printed over what was moved, from `~/booster-rocket/deploy`:
  ```bash
  docker compose up -d db
  docker compose run --rm --entrypoint bash -v ~/booster-rocket-moving-to-postgres-18:/moving:ro backup /opt/booster-rocket/scripts/restore.sh /moving/postgres-18-before-again/<booster-rocket file> booster --replace --owner booster
  docker compose run --rm --entrypoint bash -v ~/booster-rocket-moving-to-postgres-18:/moving:ro backup /opt/booster-rocket/scripts/restore.sh /moving/postgres-18-before-again/<documenso file> documenso --replace --owner documenso
  docker compose up -d
  ```
  What was done on Postgres 16 since going back is then only in Postgres 16's volume.

### Removing the old data

Leave Postgres 16's volume and `~/booster-rocket-moving-to-postgres-18` in place until the club has used the portal on
Postgres 18 for a few weeks and a [restore check](backups.md#checking-a-backup-can-be-restored) of a Postgres 18 backup
has passed. Removing them is the only step that deletes the old data, and going back to Postgres 16 is no longer
possible after it.

1. From `~/booster-rocket/deploy`, remove the containers but keep every volume (never add `-v` here: that would delete
   Postgres 18's data too):
   ```bash
   docker compose down
   ```
2. Remove Postgres 16's volume, and only that one: `docker volume rm booster-rocket-club_db-data`. Postgres 18's is
   `booster-rocket-club_postgres-data`; `docker volume ls` lists both before you start.
3. Start again: `docker compose up -d`. Docker makes a new, empty `db-data` volume, a few bytes that the database's
   start check reads as "nothing to move".
4. Delete the move's folder, which holds every family's records: `rm -r ~/booster-rocket-moving-to-postgres-18`.
