# Updates

Updating the portal to a new release, and Documenso or the other images when a dependency update moves them. Pick a
quiet time: the portal is away for a minute or two. The commands run in `~/booster-rocket/deploy`; add `--profile proxy`
if you use this installation's proxy.

## 1. Before anything

1. Read the release's notes on the repository's **Releases** page, for every release since yours. A note that says
   "change your .env" means a new line to fill in: `.env.example` has it.
2. Back up both databases: `docker compose run --rm backup --now`. Note the time in the file names it prints: it is the
   way back.

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
2. Sign in as an Admin and open **Health**: **Version** names the new version, and every line reads as it did before
   ([Health page warnings](health-warnings.md) for any that doesn't).
3. Open the portal as a parent would (a test family): Home, Payments, Forms.

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
