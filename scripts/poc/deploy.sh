#!/usr/bin/env bash
# Deploys (or rolls back) the Booster Rocket proof of concept on linuxdev.
#   scripts/poc/deploy.sh             pull main, build, migrate, recreate app, wait healthy
#   scripts/poc/deploy.sh --rollback  return to the previous image
# Exit codes: 0 ok, 2 refused, 3 migrations failed (app untouched), 4 app unhealthy, 5 nothing to roll back to.
set -euo pipefail

BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
BR_HEALTH_TIMEOUT="${BR_HEALTH_TIMEOUT:-120}"
APP_IMAGE="booster-rocket-app"
COMPOSE=(docker compose -f docker-compose.poc.yml --env-file .env.poc)

cd "$BR_DIR"

say() { printf '%s\n' "$*"; }
die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }

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
  docker image tag "$APP_IMAGE:previous" "$APP_IMAGE:current"
  recreate_app
  say "Rolled back to the previous image."
  exit 0
fi

[ -z "$(git status --porcelain)" ] || die 2 "This checkout has local changes. Commit or discard them before deploying."
check_env_file

git pull --ff-only
if docker image inspect "$APP_IMAGE:current" >/dev/null 2>&1; then
  docker image tag "$APP_IMAGE:current" "$APP_IMAGE:previous"
fi
"${COMPOSE[@]}" build app
"${COMPOSE[@]}" run --rm migrate || die 3 "Migrations failed. The running app was not touched."
recreate_app
say "Deployed $(git rev-parse --short HEAD)."
