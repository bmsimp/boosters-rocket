#!/usr/bin/env bash
# Prints a one-time setup code for the Booster Rocket setup page (replaces any earlier code).
#   scripts/poc/setup-code.sh            while setup is open
#   scripts/poc/setup-code.sh --reopen   reopen setup first (use reopen-setup.sh)
set -euo pipefail
BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$BR_DIR"
exec docker compose -f docker-compose.poc.yml --env-file .env.poc run --rm migrate node tools/scripts/setup-code.mjs "$@"
