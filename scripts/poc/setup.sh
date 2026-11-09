#!/usr/bin/env bash
# One-time setup for the Booster Rocket proof of concept on linuxdev. Safe to run again.
set -euo pipefail

BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$BR_DIR"

need() { command -v "$1" >/dev/null 2>&1 || { printf 'Missing: %s\n' "$1" >&2; exit 2; }; }
need docker; need git; need openssl

if ! docker network inspect booster-rocket-edge >/dev/null 2>&1; then
  docker network create booster-rocket-edge >/dev/null
  echo "Created network booster-rocket-edge."
else
  echo "Network booster-rocket-edge already exists."
fi

if [ ! -f .env.poc ]; then
  [ -f .env.poc.example ] || { echo ".env.poc.example is missing; cannot create .env.poc." >&2; exit 2; }
  umask 077
  tmp="$(mktemp ./.env.poc.XXXXXX)"
  trap 'rm -f "$tmp"' EXIT
  sed -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env.poc.example > "$tmp"
  for key in BETTER_AUTH_SECRET DB_PASSWORD SETTINGS_ENCRYPTION_KEY; do
    grep -Eq "^${key}=.+" "$tmp" || { echo "Could not generate ${key}; .env.poc was not created." >&2; exit 2; }
  done
  chmod 600 "$tmp"
  mv "$tmp" .env.poc
  trap - EXIT
  echo "Created .env.poc with fresh secrets."
else
  if ! grep -Eq '^SETTINGS_ENCRYPTION_KEY=.+' .env.poc; then
    sed -i.bak '/^SETTINGS_ENCRYPTION_KEY=/d' .env.poc && rm -f .env.poc.bak
    [ -z "$(tail -c1 .env.poc)" ] || printf '\n' >> .env.poc
    printf 'SETTINGS_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> .env.poc
    echo "Added SETTINGS_ENCRYPTION_KEY to .env.poc."
  fi
  echo ".env.poc already exists; left as is."
fi

cat <<'EOT'

One manual step: let cloudflared reach the app.
In ~/n8n/docker-compose.yml add `booster-rocket-edge` under the cloudflared service's networks:
      - booster-rocket-edge
and under the top-level networks:
  booster-rocket-edge:
    external: true
Then run:  docker compose -f ~/n8n/docker-compose.yml up -d --no-deps cloudflared

Then deploy with:  scripts/poc/deploy.sh
It prints a setup code at the end. Open the site, enter the code, and follow the setup page.
Back up .env.poc along with the database: SETTINGS_ENCRYPTION_KEY is needed to read the stored sign-in secrets.
EOT
