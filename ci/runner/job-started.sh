#!/usr/bin/env bash
# Runs before every job, before its service containers start (ACTIONS_RUNNER_HOOK_JOB_STARTED). A runner that is kept
# between jobs must start each one as a fresh machine would: no container, network or volume a cut-off job left in the
# CI's Docker daemon, no server still holding a port, no file the next checkout can't remove. It talks only to the
# CI's own daemon (br-ci-dind) and refuses to touch any other, or anything at all, when it can't tell it is that one.
set -uo pipefail

name="$(docker info --format '{{.Name}}' 2>/dev/null || true)"
if [ "$name" != "br-ci-dind" ]; then
  echo "The job-started hook cleans only the CI's own Docker daemon, br-ci-dind; DOCKER_HOST reaches \"$name\". Nothing was cleaned." >&2
  exit 1
fi

# The shared /tmp (the br-ci-tmp volume, the same in br-ci-dind): one job runs at a time, and nothing of an earlier
# job may reach the next.
find /tmp -mindepth 1 -maxdepth 1 -exec sudo rm -rf -- {} + 2>/dev/null || true

leftover="$(docker ps -aq)"
if [ -n "$leftover" ]; then
  # shellcheck disable=SC2086 # one id per word
  docker rm -f -v $leftover >/dev/null
fi
docker network prune -f >/dev/null
docker volume prune -af >/dev/null

# Once a week: images no job has used since, and build cache older than a week.
stamp=/state/last-prune
if [ ! -f "$stamp" ] || [ -n "$(find "$stamp" -mtime +6)" ]; then
  docker image prune -af >/dev/null
  docker builder prune -af --filter until=168h >/dev/null
  touch "$stamp"
fi

# A server a cancelled job left running in this container (the browser run's app on 3100, its mail sink on 2465).
pkill -f 'next-server|next start|mail-sink' 2>/dev/null || true

# Files a container wrote into the shared folders as root.
sudo find /home/runner/_work -xdev ! -user runner -print0 2>/dev/null | sudo xargs -0r chown -h runner:runner
exit 0
