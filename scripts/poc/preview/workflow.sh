#!/usr/bin/env bash
# The GitHub side of pull request previews (docs/superpowers/specs/2026-11-27-pr-previews-design.md), run by
# .github/workflows/previews.yml from main, never from a pull request's code. It opens or closes a preview's gate in
# Cloudflare (cloudflare.sh) and puts on or takes off the label the test server polls for; the test server builds and
# removes the preview itself.
#   workflow.sh up <n>     the owner asked: refuse a fork's pull request or a third preview, open the gate, label it
#   workflow.sh down <n>   close the gate, take the label off
#   workflow.sh sweep      take down every labeled pull request that is closed or older than PREVIEW_TTL_DAYS, and
#                          close any gate left with no open, labeled pull request
# Needs GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER, GITHUB_ACTOR and GITHUB_TRIGGERING_ACTOR (as Actions
# sets them), PREVIEW_DOMAIN, and cloudflare.sh's settings. Exit codes: 0 ok, 2 refused, 5 GitHub or Cloudflare failed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="${PREVIEW_LABEL:-preview}"
MAX="${PREVIEW_MAX:-2}"
TTL_DAYS="${PREVIEW_TTL_DAYS:-7}"
# The label counts only when this workflow put it on (as the Actions bot) or the owner did.
BOT="github-actions[bot]"

die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }
say() { printf '%s\n' "$*"; }
gh_api() { gh api "$@" || die 5 "GitHub refused: gh api $*"; }
number() { [[ "${1:-}" =~ ^[1-9][0-9]{0,5}$ ]] || die 2 "Give a pull request's number."; }
address() { printf 'https://pr-%s-br.%s' "$1" "$PREVIEW_DOMAIN"; }
comment() { gh_api -X POST "repos/$GITHUB_REPOSITORY/issues/$1/comments" -f body="$2" >/dev/null; }
labeled() { gh_api "repos/$GITHUB_REPOSITORY/issues/$1/labels" --jq '.[].name' | grep -qx "$LABEL"; }
unlabel() { gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$1/labels/$LABEL" >/dev/null 2>&1 || true; }

up() {
  number "$1"
  local owner="$GITHUB_REPOSITORY_OWNER"
  [ "$GITHUB_ACTOR" = "$owner" ] && [ "$GITHUB_TRIGGERING_ACTOR" = "$owner" ] \
    || die 2 "Only $owner starts a preview."
  local pr
  pr="$(gh_api "repos/$GITHUB_REPOSITORY/pulls/$1")"
  [ "$(jq -r .state <<<"$pr")" = "open" ] || die 2 "Pull request $1 isn't open."
  [ "$(jq -r .base.repo.full_name <<<"$pr")" = "$GITHUB_REPOSITORY" ] || die 2 "Pull request $1 isn't into $GITHUB_REPOSITORY."
  [ "$(jq -r '.head.repo.full_name // ""' <<<"$pr")" = "$GITHUB_REPOSITORY" ] \
    || die 2 "Pull request $1 comes from a fork. Previews run only this repository's own branches."
  local others
  others="$(gh_api "repos/$GITHUB_REPOSITORY/issues?state=open&labels=$LABEL&per_page=100" \
    --jq "[.[] | select(.pull_request and .number != $1)] | length")"
  [ "$others" -lt "$MAX" ] || die 2 "$MAX previews are up already. Take one down first (this workflow, down)."
  "$HERE/cloudflare.sh" open "$1"
  if ! labeled "$1"; then
    gh_api -X POST "repos/$GITHUB_REPOSITORY/issues/$1/labels" -f "labels[]=$LABEL" >/dev/null
    comment "$1" "A preview is on its way at $(address "$1") (about ten minutes). It follows each push, and comes down when this pull request closes or in $TTL_DAYS days."
  fi
  say "Preview $1 asked for: $(address "$1")."
}

down() {
  number "$1"
  local why="${2:-}"
  "$HERE/cloudflare.sh" close "$1"
  if labeled "$1"; then
    unlabel "$1"
    [ -z "$why" ] || comment "$1" "The preview at $(address "$1") was taken down: $why"
  fi
  say "Preview $1 is closed."
}

# When the label was last put on by the bot or the owner, in seconds; nothing if a later event took it off or someone
# else put it on.
labeled_at() {
  gh_api --paginate "repos/$GITHUB_REPOSITORY/issues/$1/events" --jq '.[]' | jq -rs \
    --arg label "$LABEL" --arg owner "$GITHUB_REPOSITORY_OWNER" --arg bot "$BOT" \
    '[.[] | select((.event == "labeled" or .event == "unlabeled") and .label.name == $label)] | last
     | if . != null and .event == "labeled" and (.actor.login == $owner or .actor.login == $bot)
       then (.created_at | fromdateiso8601) else empty end'
}

sweep() {
  local now n state at seen=""
  now="$(date -u +%s)"
  for n in $(gh_api --paginate "repos/$GITHUB_REPOSITORY/issues?state=all&labels=$LABEL&per_page=100" --jq '.[] | select(.pull_request) | .number'); do
    seen="$seen $n"
    state="$(gh_api "repos/$GITHUB_REPOSITORY/pulls/$n" --jq .state)"
    at="$(labeled_at "$n")"
    if [ "$state" != "open" ]; then down "$n"
    elif [ -z "$at" ]; then down "$n" "the label wasn't put on by this workflow or the owner."
    elif [ $(( now - at )) -gt $(( TTL_DAYS * 86400 )) ]; then down "$n" "it was $TTL_DAYS days old. Run the previews workflow again to bring it back."
    fi
  done
  # A gate whose pull request lost its label some other way.
  for n in $("$HERE/cloudflare.sh" list); do
    [[ " $seen " == *" $n "* ]] || "$HERE/cloudflare.sh" close "$n"
  done
}

case "${1:-}" in
  up) up "${2:-}" ;;
  down) down "${2:-}" "${3:-}" ;;
  sweep) sweep ;;
  *) die 2 "Give one of: up <n>, down <n>, sweep." ;;
esac
