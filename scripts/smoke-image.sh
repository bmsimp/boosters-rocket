#!/usr/bin/env bash
# Runs the built image against a throwaway Postgres and checks what cloudflared and Docker will rely on.
#   scripts/smoke-image.sh <image>
set -euo pipefail

IMAGE="${1:?usage: scripts/smoke-image.sh <image>}"
NET="br-smoke-$$"
cleanup() { docker rm -f "$NET-app" "$NET-db" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

uid="$(docker run --rm "$IMAGE" node -e "process.stdout.write(String(process.getuid()))")"
[ "$uid" != "0" ] || fail "the image runs as root"
docker run --rm "$IMAGE" sh -c "test -f /app/server.js && test -f /app/tools/scripts/migrate.mjs && test -f /app/tools/drizzle/meta/_journal.json" \
  || fail "expected files missing from the image"
docker run --rm "$IMAGE" test -f tools/scripts/setup-code.mjs || fail "setup-code.mjs missing from the image"
docker run --rm "$IMAGE" test -f scripts/setup/New-BoosterRocketStaffApp.ps1 || fail "setup scripts missing from the image"

docker network create "$NET" >/dev/null
docker run -d --name "$NET-db" --network "$NET" -e POSTGRES_USER=b -e POSTGRES_PASSWORD=b -e POSTGRES_DB=b postgres:16 >/dev/null
ready=0
for _ in $(seq 1 30); do docker exec "$NET-db" pg_isready -h 127.0.0.1 -U b -d b >/dev/null 2>&1 && { ready=1; break; }; sleep 1; done
[ "$ready" = 1 ] || fail "throwaway Postgres never became ready"

DB="postgres://b:b@$NET-db:5432/b"
docker run --rm --network "$NET" -e DATABASE_URL="$DB" "$IMAGE" node tools/scripts/migrate.mjs | grep -q migrated || fail "migrations didn't run"

docker run -d --name "$NET-app" --network "$NET" -e DATABASE_URL="$DB" \
  -e APP_URL=https://portaltest.rhinoautomator.com -e BETTER_AUTH_SECRET=smoke-secret-smoke-secret-smoke-secret-1 \
  -e SETTINGS_ENCRYPTION_KEY=c21va2Uta2V5LXNtb2tlLWtleS1zbW9rZS1rZXktMTI= "$IMAGE" >/dev/null

status=starting
for _ in $(seq 1 45); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$NET-app")"
  [ "$status" = "healthy" ] && break
  sleep 2
done
[ "$status" = "healthy" ] || { docker logs "$NET-app" >&2; fail "container health is $status (the server must listen on 0.0.0.0)"; }

local_body="$(docker exec "$NET-app" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>process.stdout.write(t))" 2>/dev/null || true)"
[ "$local_body" = '{"ok":true}' ] || fail "health on 127.0.0.1 returned: $local_body"

by_name="$(docker run --rm --network "$NET" "$IMAGE" node -e "fetch('http://$NET-app:3000/api/health').then(r=>r.text()).then(t=>process.stdout.write(t))" 2>/dev/null || true)"
[ "$by_name" = '{"ok":true}' ] || fail "health by container name (what cloudflared does) returned: $by_name"

echo "ok: image runs as non-root, migrates, is healthy, and answers on 127.0.0.1 and by name"
