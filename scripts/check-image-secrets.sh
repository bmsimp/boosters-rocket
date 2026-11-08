#!/usr/bin/env bash
# Builds the image with a canary .env.poc in the build context and fails if the canary ends up inside.
# Scans the final image and also the build stage: the multi-stage layout keeps the build stage out of the final
# image on its own, so only the build stage shows whether .dockerignore really keeps env files out of the context.
set -euo pipefail

if [ -e .env.poc ]; then
  echo "Refusing: a real .env.poc exists in this directory. Run this in a clean checkout." >&2
  exit 2
fi

CANARY="CANARY-$(date +%s)-do-not-ship"
IMAGE="booster-rocket-app:secret-check"
BUILD_IMAGE="booster-rocket-app:secret-check-build"
cleanup() { rm -f .env.poc; docker image rm -f "$IMAGE" "$BUILD_IMAGE" >/dev/null 2>&1 || true; }
trap cleanup EXIT
printf 'BETTER_AUTH_SECRET=%s\nDATABASE_URL=postgres://x:%s@db/x\n' "$CANARY" "$CANARY" > .env.poc

docker build -q -t "$IMAGE" . >/dev/null
docker build -q --target build -t "$BUILD_IMAGE" . >/dev/null
for img in "$IMAGE" "$BUILD_IMAGE"; do
  # Run as root so unreadable directories cannot hide a match; capture output rather than piping into grep -q.
  found="$(docker run --rm -u 0 --entrypoint sh "$img" -c "grep -rIl --exclude-dir=proc --exclude-dir=sys -- '$CANARY' / 2>/dev/null" || true)"
  if [ -n "$found" ]; then
    echo "FAIL: the canary secret was found inside the image ($img): $found" >&2
    exit 1
  fi
done
echo "ok: no env-file secrets inside the image"
