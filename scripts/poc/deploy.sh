#!/usr/bin/env bash
# Deploys (or rolls back) the Booster Rocket proof of concept on linuxdev.
#   scripts/poc/deploy.sh             pull main, build, migrate, recreate app, wait healthy
#   scripts/poc/deploy.sh --rollback  return to the previous image
# Exit codes: 0 ok, 2 refused (or another deploy running), 3 migrations failed (app untouched), 4 app unhealthy,
# 5 nothing to roll back to, 6 git pull failed, 7 build failed (app untouched).
set -euo pipefail

BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
BR_HEALTH_TIMEOUT="${BR_HEALTH_TIMEOUT:-120}"
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

if [ "${1:-}" = "--rollback" ]; then
  check_env_file
  docker image inspect "$APP_IMAGE:previous" >/dev/null 2>&1 || die 5 "No previous image to roll back to. Nothing was changed."
  say "Note: database migrations are not reversed by a rollback."
  docker image tag "$APP_IMAGE:previous" "$APP_IMAGE:current"
  recreate_app
  say "Rolled back to the previous image."
  exit 0
fi

[ -z "$(git status --porcelain)" ] || die 2 "This checkout has local changes. Commit or discard them before deploying."
check_env_file

git pull --ff-only || die 6 "git pull failed. Nothing was changed."
"${COMPOSE[@]}" build app || die 7 "The build failed. The running app was not touched."
"${COMPOSE[@]}" run --rm migrate || die 3 "Migrations failed. The running app was not touched."
# compose build has already moved :current to the new image, so remember what is actually running.
running="$(docker inspect --format '{{.Image}}' booster-rocket-app 2>/dev/null || true)"
if [ -n "$running" ]; then
  pre_health="$(docker inspect --format '{{.State.Health.Status}}' booster-rocket-app 2>/dev/null || echo missing)"
  if [ "$pre_health" = "healthy" ]; then
    docker image tag "$running" "$APP_IMAGE:previous"
  else
    say "The running app isn't healthy, so the previous good image was kept for rollback."
  fi
fi
recreate_app
if ! "${COMPOSE[@]}" run --rm migrate node tools/scripts/setup-code.mjs --if-open; then
  say "Couldn't check whether setup is finished. If it isn't, run scripts/poc/setup-code.sh for a setup code."
fi
say "Deployed $(git rev-parse --short HEAD)."
