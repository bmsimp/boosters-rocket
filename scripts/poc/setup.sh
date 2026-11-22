#!/usr/bin/env bash
# One-time setup for a Boosters Rocket server run with docker compose. Safe to run again.
#   scripts/poc/setup.sh https://portal.yourclub.org   the first time: the address people will use for the portal
#   scripts/poc/setup.sh                               later: checks what is there and changes nothing
# The address is part of setting the portal up: sign-in, the links in emails and the installed app are built on it.
# Exit codes: 0 ok, 2 refused (a tool is missing, or no usable address was given the first time).
set -euo pipefail

BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$BR_DIR"

need() { command -v "$1" >/dev/null 2>&1 || { printf 'Missing: %s\n' "$1" >&2; exit 2; }; }
need docker; need git; need openssl

ADDRESS="${1:-}"
ADDRESS="${ADDRESS%/}"
valid_address() { [[ "$1" =~ ^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]]; }
if [ -n "$ADDRESS" ] && ! valid_address "$ADDRESS"; then
  echo "That isn't an address the portal can use. Give it like https://portal.yourclub.org: https, the name, and nothing after it." >&2
  exit 2
fi
if [ ! -f .env.poc ] && [ -z "$ADDRESS" ]; then
  echo "Give the portal's address, the one people will type: scripts/poc/setup.sh https://portal.yourclub.org" >&2
  exit 2
fi

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
  sed -e "s|^APP_URL=.*|APP_URL=$ADDRESS|" \
      -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env.poc.example > "$tmp"
  for key in APP_URL BETTER_AUTH_SECRET DB_PASSWORD SETTINGS_ENCRYPTION_KEY; do
    grep -Eq "^${key}=.+" "$tmp" || { echo "Could not generate ${key}; .env.poc was not created." >&2; exit 2; }
  done
  chmod 600 "$tmp"
  mv "$tmp" .env.poc
  trap - EXIT
  echo "Created .env.poc with fresh secrets. The portal's address is $ADDRESS."
else
  if ! grep -Eq '^SETTINGS_ENCRYPTION_KEY=.+' .env.poc; then
    sed -i.bak '/^SETTINGS_ENCRYPTION_KEY=/d' .env.poc && rm -f .env.poc.bak
    [ -z "$(tail -c1 .env.poc)" ] || printf '\n' >> .env.poc
    printf 'SETTINGS_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> .env.poc
    echo "Added SETTINGS_ENCRYPTION_KEY to .env.poc."
  fi
  current="$(sed -n 's/^APP_URL=//p' .env.poc | head -n 1)"
  if [ -z "$current" ]; then
    echo ".env.poc already exists; left as is."
    echo "It has no APP_URL, and the portal can't start without one. Add a line APP_URL=https://... with the address people use for the portal." >&2
  elif [ -n "$ADDRESS" ] && [ "$ADDRESS" != "${current%/}" ]; then
    echo ".env.poc already exists; left as is. The portal's address is $current."
    echo "It was not changed to $ADDRESS. To move the portal to a new address, edit APP_URL in .env.poc, deploy, and update the redirect addresses at Microsoft, Google and Intuit."
  else
    echo ".env.poc already exists; left as is. The portal's address is $current."
  fi
fi

cat <<'EOT'

One manual step: let your reverse proxy or tunnel reach the app.
The app listens on port 3000 on the docker network `booster-rocket-edge` and publishes no port of its own.
Put the proxy's container on that network (in its compose file, add `booster-rocket-edge` under its networks and,
at the top level, `booster-rocket-edge: { external: true }`), point it at http://booster-rocket-app:3000, and restart it.
If the proxy is not Cloudflare, set CLIENT_IP_HEADER in .env.poc to the header it writes (.env.example lists them).

Then deploy with:  scripts/poc/deploy.sh
It prints a setup code at the end. Open the site, enter the code, and follow the setup page.
Back up .env.poc along with the database: SETTINGS_ENCRYPTION_KEY is needed to read the stored sign-in secrets.
EOT
