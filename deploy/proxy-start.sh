#!/bin/sh
# Starts the optional reverse proxy (deploy/compose.yml, profile "proxy") once its two addresses are ones it can serve.
# Caddy reads anything after the name in a site address as a path to match: "https://portal.example.org/" would be
# served for the exact path "/" alone, and every other page would come back empty, with nothing in any log. So
# APP_URL and DOCUMENSO_URL must each be http:// or https://, a name, a port if it has one, and nothing after it: no
# slash at the end, no path. A wrong one stops the proxy here, saying which line of deploy/.env to change.
set -eu

check() {
  name="$1" value="$2"
  case "$value" in
    http://*|https://*) rest="${value#*://}" ;;
    *) rest="" ;;
  esac
  case "$rest" in
    ""|*/*|*'?'*|*'#'*|*@*|*' '*)
      printf '%s\n' "$name in deploy/.env must be the address and nothing after it, like https://portal.example.org: no slash at the end, no path. It is \"$value\". Change it, then start the proxy again." >&2
      exit 2 ;;
  esac
}

check APP_URL "${APP_URL:-}"
check DOCUMENSO_URL "${DOCUMENSO_URL:-}"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
