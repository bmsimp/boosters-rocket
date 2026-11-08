#!/usr/bin/env bash
# Builds the image with a canary .env.poc in the build context and fails if the canary ends up inside.
# Checks the final image, and also the build stage: the multi-stage layout keeps the build stage out of the final
# image on its own, so only the build stage shows whether .dockerignore is really keeping env files out of the context.
set -euo pipefail

CANARY="CANARY-$(date +%s)-do-not-ship"
IMAGE="booster-rocket-app:secret-check"
BUILD_IMAGE="booster-rocket-app:secret-check-build"
cleanup() { rm -f .env.poc.canary-test .env.poc; docker image rm -f "$IMAGE" "$BUILD_IMAGE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -e .env.poc ]; then
  echo "Refusing: a real .env.poc exists in this directory. Run this in a clean checkout." >&2
  exit 2
fi
printf 'BETTER_AUTH_SECRET=%s\nDATABASE_URL=postgres://x:%s@db/x\n' "$CANARY" "$CANARY" > .env.poc

docker build -q -t "$IMAGE" . >/dev/null
docker build -q --target build -t "$BUILD_IMAGE" . >/dev/null
for img in "$IMAGE" "$BUILD_IMAGE"; do
  if docker run --rm --entrypoint sh "$img" -c "grep -rIl --exclude-dir=proc --exclude-dir=sys -- '$CANARY' / 2>/dev/null" | grep -q .; then
    echo "FAIL: the canary secret was found inside the image ($img)." >&2
    exit 1
  fi
done
echo "ok: no env-file secrets inside the image"
