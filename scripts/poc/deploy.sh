#!/usr/bin/env bash
# Deploys (or rolls back) the Booster Rocket proof of concept on linuxdev.
#   scripts/poc/deploy.sh             pull main, build, back up the database, migrate, recreate app and worker, wait healthy
#   scripts/poc/deploy.sh --rollback  return to the previous image
# The backup goes to BR_BACKUP_DIR (default ~/booster-rocket-backups, outside this checkout), keeping the newest
# BR_BACKUP_KEEP (default 14): scripts/backup.sh. A deploy never migrates a database it could not back up first.
# Exit codes: 0 ok, 2 refused (or another deploy running), 3 migrations failed (app untouched), 4 app unhealthy,
# 5 nothing to roll back to, 6 git pull failed, 7 build failed (app untouched), 8 backup failed (nothing migrated,
# app untouched).
set -euo pipefail

BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
BR_HEALTH_TIMEOUT="${BR_HEALTH_TIMEOUT:-120}"
BR_BACKUP_DIR="${BR_BACKUP_DIR:-$HOME/booster-rocket-backups}"
BR_BACKUP_KEEP="${BR_BACKUP_KEEP:-14}"
SCRIPTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_IMAGE="booster-rocket-app"
COMPOSE=(docker compose -f docker-compose.poc.yml --env-file .env.poc)

cd "$BR_DIR"

say() { printf '%s\n' "$*"; }
die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }

if command -v flock >/dev/null 2>&1; then
  exec 9>"$BR_DIR/.deploy.lock"
  flock -n 9 || die 2 "Another deploy is running. Try again when it finishes."
fi

check_env_file() {
  [ -f .env.poc ] || die 2 ".env.poc is missing. Run scripts/poc/setup.sh first."
  if [ "$(uname -s)" = "Linux" ]; then
    local mode
    mode="$(stat -c '%a' .env.poc)"
    [ "$mode" = "600" ] || die 2 ".env.poc must be private: run chmod 600 .env.poc (it is $mode)."
  fi
}

wait_healthy() {
  local waited=0 status
  while [ "$waited" -lt "$BR_HEALTH_TIMEOUT" ]; do
    status="$(docker inspect --format '{{.State.Health.Status}}' booster-rocket-app 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] && return 0
    sleep 2
    waited=$((waited + 2))
  done
  die 4 "The app didn't become healthy within ${BR_HEALTH_TIMEOUT}s. Check: docker logs booster-rocket-app. To go back: scripts/poc/deploy.sh --rollback"
}

recreate_app() {
  "${COMPOSE[@]}" up -d --no-deps --force-recreate app
  wait_healthy
}

# A migration can't be undone by a rollback, so the database is backed up first, and a deploy that can't back it up
# stops here. The database is started if this is the first deploy; it is then empty, and the backup is too.
backup_database() {
  local db_container
  "${COMPOSE[@]}" up -d db >/dev/null || die 8 "The database didn't start, so it couldn't be backed up. Nothing was migrated and the running app was not touched."
  db_container="$("${COMPOSE[@]}" ps -q db 2>/dev/null | head -n 1)"
  [ -n "$db_container" ] || die 8 "The database container wasn't found, so it couldn't be backed up. Nothing was migrated and the running app was not touched."
  BR_DB_CONTAINER="$db_container" "$SCRIPTS_DIR/backup.sh" "$BR_BACKUP_DIR" --keep "$BR_BACKUP_KEEP" \
    || die 8 "The backup failed. Nothing was migrated and the running app was not touched."
}

recreate_worker() {
  # The worker only keeps QuickBooks fresh; the site runs without it, so a worker that won't start never fails a deploy.
  if ! "${COMPOSE[@]}" up -d --no-deps --force-recreate worker; then
    say "The worker didn't start. The site is up; check: docker logs booster-rocket-worker"
  fi
}

if [ "${1:-}" = "--rollback" ]; then
  check_env_file
  docker image inspect "$APP_IMAGE:previous" >/dev/null 2>&1 || die 5 "No previous image to roll back to. Nothing was changed."
  say "Note: database migrations are not reversed by a rollback."
  docker image tag "$APP_IMAGE:previous" "$APP_IMAGE:current"
  recreate_app
  recreate_worker
  say "Rolled back to the previous image."
  exit 0
fi

[ -z "$(git status --porcelain)" ] || die 2 "This checkout has local changes. Commit or discard them before deploying."
check_env_file

git pull --ff-only || die 6 "git pull failed. Nothing was changed."
# compose build moves :current to the new image, and on Docker 29 (containerd image store) the old image is
# then gone, so give the running version a name of its own before building.
candidate=""
if docker image inspect "$APP_IMAGE:current" >/dev/null 2>&1   && docker image tag "$APP_IMAGE:current" "$APP_IMAGE:rollback-candidate" >/dev/null 2>&1; then
  candidate="yes"
  trap 'docker image rm "$APP_IMAGE:rollback-candidate" >/dev/null 2>&1 || true' EXIT
fi
"${COMPOSE[@]}" build app || die 7 "The build failed. The running app was not touched."
backup_database
"${COMPOSE[@]}" run --rm migrate || die 3 "Migrations failed. The running app was not touched."
running="$(docker inspect --format '{{.Image}}' booster-rocket-app 2>/dev/null || true)"
if [ -n "$running" ]; then
  pre_health="$(docker inspect --format '{{.State.Health.Status}}' booster-rocket-app 2>/dev/null || echo missing)"
  if [ "$pre_health" = "healthy" ]; then
    if [ -z "$candidate" ] || ! docker image tag "$APP_IMAGE:rollback-candidate" "$APP_IMAGE:previous"; then
      say "Couldn't keep a rollback copy of the running version; the deploy continues."
    fi
  else
    say "The running app isn't healthy, so the previous good image was kept for rollback."
  fi
fi
recreate_app
recreate_worker
if ! "${COMPOSE[@]}" run --rm migrate node tools/scripts/setup-code.mjs --if-open; then
  say "Couldn't check whether setup is finished. If it isn't, run scripts/poc/setup-code.sh for a setup code."
fi
say "Deployed $(git rev-parse --short HEAD)."
