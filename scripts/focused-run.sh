#!/usr/bin/env bash
# Runs .github/workflows/focused.yml on a branch already pushed, waits for it and prints what failed.
#
#   scripts/focused-run.sh <branch> [--e2e "<specs>"] <vitest files...>
#
# It pushes nothing: push the work-in-progress branch first. It dispatches the run with gh, finds the run it started
# (the newest by hand on that branch made since the dispatch, and not one listed before it), watches it to the end and,
# when it fails, prints the failed steps' log lines, trimmed. Its exit status is the run's.
set -euo pipefail

usage() {
  echo "Usage: scripts/focused-run.sh <branch> [--e2e \"<specs>\"] <vitest files...>" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
branch="$1"
shift
case "$branch" in
  "" | -*) usage ;;
esac

vitest=""
e2e=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --e2e)
      [ "$#" -ge 2 ] || usage
      e2e="${e2e:+$e2e }$2"
      shift 2
      ;;
    -*) usage ;;
    *)
      vitest="${vitest:+$vitest }$1"
      shift
      ;;
  esac
done
if [ -z "$vitest" ] && [ -z "$e2e" ]; then
  echo "Name at least one test file." >&2
  usage
fi

list_runs() {
  gh run list --workflow focused.yml --branch "$branch" --event workflow_dispatch --limit 20 \
    --json databaseId,createdAt --jq '.[] | "\(.databaseId) \(.createdAt)"'
}

before="$(list_runs || true)"
# A few seconds' allowance for the difference between this machine's clock and GitHub's.
since="$(date -u -d '-10 seconds' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Dispatching focused.yml on $branch"
gh workflow run focused.yml --ref "$branch" -f vitest="$vitest" -f e2e="$e2e"

run_id=""
for _ in $(seq 1 30); do
  while read -r id created; do
    [ -n "$id" ] || continue
    if [[ "$created" < "$since" ]]; then continue; fi
    if printf '%s\n' "$before" | grep -q "^$id "; then continue; fi
    run_id="$id"
    break
  done <<< "$(list_runs || true)"
  [ -z "$run_id" ] || break
  sleep 4
done
if [ -z "$run_id" ]; then
  echo "Dispatched, but the run did not show up within two minutes: look under Actions, focused." >&2
  exit 1
fi

echo "Watching run $run_id"
status=0
gh run watch "$run_id" --exit-status --interval 30 >/dev/null || status=$?
if [ "$status" -eq 0 ]; then
  echo "Run $run_id passed."
  exit 0
fi

echo "Run $run_id failed. The failed steps' last lines:"
# Each line is "job<TAB>step<TAB>time line"; keep the step and the line, without the time.
gh run view "$run_id" --log-failed \
  | cut -f2- \
  | sed -E 's/\t[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?/: /' \
  | grep -v -E '^[^:]*: *$' \
  | tail -n 200 || true
gh run view "$run_id" --json url --jq '.url' || true
exit "$status"
