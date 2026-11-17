# Updates

Updating the portal to a new release, and Documenso or the other images when a dependency update moves them. Pick a
quiet time: the portal is away for a minute or two. The commands run in `~/booster-rocket/deploy`; add `--profile proxy`
if you use this installation's proxy.

## 1. Before anything

1. Read the release's notes on the repository's **Releases** page, for every release since yours. A note that says
   "change your .env" means a new line to fill in: `.env.example` has it.
2. Back up both databases: `docker compose run --rm backup --now`. Note the time in the file names it prints: it is the
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
   One reason is the backup check, below.
2. Sign in as an Admin and open **Health**: **Version** names the new version, and every line reads as it did before
   ([Health page warnings](health-warnings.md) for any that doesn't).
3. Open the portal as a parent would (a test family): Home, Payments, Forms.

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

The databases move forward with an update and can't be moved back on their own, so going back is a restore of the
backup from part 1:

1. Put back the previous version's files and image: `git checkout <previous version>` and, for the published image, the
   previous version in `BOOSTER_ROCKET_IMAGE` (not `stable`), then `docker compose pull`.
2. Follow [restore, onto the same machine](restore.md#onto-the-same-machine), steps 3 to 7, with the backup from part 1.

## Documenso and the other images

A dependency update (a pull request that changes `deploy/compose.yml`) may move Documenso, Postgres or the proxy to a new
version. Merge it like any change, then update as above. Documenso is the one to be careful with:

1. Read Documenso's release notes for every version between the old and the new, and look for changes to signing,
   the API, webhooks or embedded signing: the portal was checked against the version the compose file names.
2. After updating, sign a test form end to end, open the signed PDF, and check the Health page's forms line.
3. Postgres moves only within version 16 here. Moving to a new major version needs a backup and a restore into the new
   version, not just a pull.
