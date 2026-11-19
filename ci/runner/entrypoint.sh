#!/usr/bin/env bash
# The CI runner's entrypoint (ci/runner/README.md).
#   register   reads a registration token on stdin, registers the runner and keeps its registration in /state
#   run        (the default) puts the kept registration back, waits for the CI's Docker daemon, and runs jobs
# The token is never put on a command line, in a file or in the output: config.sh reads it from its own environment
# variable, which only this process and the ones it starts can see.
set -euo pipefail

cd /home/runner
KEPT=(.runner .credentials .credentials_rsaparams)
die() { printf '%s\n' "$*" >&2; exit 1; }

# The volumes come up owned by whoever made them first: give them back to the runner, and /tmp its usual mode.
sudo chown runner:runner /state /home/runner/_work
sudo chmod 1777 /tmp

case "${1:-run}" in
  register)
    : "${RUNNER_URL:?RUNNER_URL must name the repository, https://github.com/<owner>/<repository>}"
    IFS= read -r token || true
    [ -n "${token:-}" ] || die "No registration token on stdin. Nothing was changed."
    ACTIONS_RUNNER_INPUT_TOKEN="$token" ./config.sh --unattended --replace --url "$RUNNER_URL" \
      --name "${RUNNER_NAME:-br-ci-1}" --labels "${RUNNER_LABELS:-self-hosted,br-ci}" --work /home/runner/_work
    unset token
    for f in "${KEPT[@]}"; do install -m 600 "$f" "/state/$f"; done
    echo "Registered as ${RUNNER_NAME:-br-ci-1}; the registration is kept in the br-ci-state volume."
    ;;
  run)
    for f in "${KEPT[@]}"; do
      [ -f "/state/$f" ] || die "This runner isn't registered yet: run the register step in ci/runner/README.md first."
      install -m 600 "/state/$f" "$f"
    done
    for _ in $(seq 1 60); do docker version >/dev/null 2>&1 && break; sleep 1; done
    docker version >/dev/null 2>&1 || die "The CI's Docker daemon (DOCKER_HOST=${DOCKER_HOST:-unset}) never answered."
    exec ./run.sh
    ;;
  *) die "usage: entrypoint.sh [register|run]" ;;
esac
