#!/usr/bin/env bash
# Reopens the setup page when nobody can sign in (for example, an expired client secret).
# Stored sign-in values are kept; existing Admins stay Admins. Prints a fresh setup code.
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/setup-code.sh" --reopen
