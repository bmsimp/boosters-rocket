#!/usr/bin/env bash
# Pull request previews: each pull request of this repository's own branches at https://pr-<n>-br.<domain>, on
# the e2e seed's test data, for clicking around before a merge (docs/superpowers/specs/2026-11-27-pr-previews-design.md).
# Never the site's: each preview is its own compose project (booster-rocket-pr-<n>), folder (BR_PREVIEW_HOME/pr-<n>),
# secrets, database and network. Run only from the site's checkout; the branch supplies its code, never this script.
# The gate (each preview's Access application and DNS name) is opened and closed by the previews workflow on GitHub
# (.github/workflows/previews.yml, scripts/poc/preview/cloudflare.sh), which also puts on the label this polls for:
# no Cloudflare token is kept here.
#   scripts/poc/preview.sh init <domain> <gate header> <owner login>   once: .env.preview, the edge network, the proxy
#   scripts/poc/preview.sh up <n>      build pull request <n>'s head, reset and seed its database, start it
#   scripts/poc/preview.sh reset <n>   the same commit again on a fresh seed, without fetching or building
#   scripts/poc/preview.sh down <n>    stop it and remove its database, image and folder
#   scripts/poc/preview.sh list        what is running
#   scripts/poc/preview.sh sweep       take down every preview whose pull request is closed, unlabeled or too old
#   scripts/poc/preview.sh poll        sweep, then bring up or refresh each open pull request labeled by the workflow
#                                      or the owner (cron, every five minutes)
# Exit codes: 0 ok, 2 refused (nothing changed), 3 seed failed (that preview is down), 4 app unhealthy (that preview is
# down), 5 GitHub couldn't be asked (nothing more changed), 6 fetch failed (nothing changed), 7 build failed (the
# running preview untouched).
set -euo pipefail

BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
BR_PREVIEW_HOME="${BR_PREVIEW_HOME:-$HOME/booster-rocket-preview}"
BR_HEALTH_TIMEOUT="${BR_HEALTH_TIMEOUT:-180}"
GITHUB_API="${GITHUB_API:-https://api.github.com}"
SHARED_ENV="$BR_PREVIEW_HOME/.env.preview"
REPO_CLONE="$BR_PREVIEW_HOME/repo"
EDGE_NETWORK="booster-rocket-preview-edge"
PROXY="booster-rocket-preview-proxy"
export BR_PREVIEW_HOME

say() { printf '%s\n' "$*"; }
die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }
need() { command -v "$1" >/dev/null 2>&1 || die 2 "Missing: $1"; }
env_value() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -n 1; }
setting() { env_value "$1" "$SHARED_ENV"; }

pr_number() {
  [[ "${1:-}" =~ ^[1-9][0-9]{0,5}$ ]] || die 2 "Give a pull request's number."
  PREVIEW_PR="$1"
  PR_HOME="$BR_PREVIEW_HOME/pr-$PREVIEW_PR"
  # A first-level name, so Cloudflare's free certificate covers it, and of a shape no other site of the zone has.
  PR_HOST="pr-$PREVIEW_PR-br.$(setting PREVIEW_DOMAIN)"
  PR_ENV="$PR_HOME/pr.env"
  BR_PREVIEW_SRC="$PR_HOME/src"
  export PREVIEW_PR BR_PREVIEW_SRC
}
compose() {
  docker compose -p "booster-rocket-pr-$PREVIEW_PR" -f "$BR_DIR/docker-compose.preview.yml" \
    --env-file "$SHARED_ENV" --env-file "$PR_ENV" "$@"
}
edge() { docker compose -f "$BR_DIR/docker-compose.preview-edge.yml" --env-file "$SHARED_ENV" "$@"; }

# GitHub, read only. A token in .env.preview (read-only, this repository alone) raises the hourly limit; it is optional.
github() {
  need curl; need jq
  local token; token="$(setting GITHUB_TOKEN)"
  local auth=()
  [ -z "$token" ] || auth=(-H "Authorization: Bearer $token")
  curl -fsS --max-time 20 -H "Accept: application/vnd.github+json" "${auth[@]}" "$GITHUB_API/repos/$(setting PREVIEW_REPO)/$1" \
    || die 5 "Couldn't ask GitHub for $1. Nothing was changed."
}

# Every page of a list GitHub answers in pages (at most ten), as one JSON array.
github_all() {
  local page=1 got all="[]"
  while [ "$page" -le 10 ]; do
    got="$(github "$1&page=$page")"
    [ "$(jq length <<<"$got")" -gt 0 ] || break
    all="$(jq -c --argjson more "$got" '. + $more' <<<"$all")"
    page=$((page + 1))
  done
  printf '%s' "$all"
}

init() {
  local domain="${1:-}" gate="${2:-}" owner="${3:-}"
  [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
    || die 2 "Give the previews' domain (each is pr-<n>-br.<domain>), the access gate's header and the owner's GitHub login: scripts/poc/preview.sh init example.org Cf-Access-Jwt-Assertion octocat"
  [[ "$gate" =~ ^[A-Za-z0-9-]{1,64}$ ]] || die 2 "The gate's header is letters, digits and dashes."
  [[ "$owner" =~ ^[A-Za-z0-9-]{1,39}$ ]] || die 2 "The owner's GitHub login is letters, digits and dashes."
  # The site never has a preview's shape of name, so no preview's Access application or DNS name can be the site's.
  local live
  live="$(env_value APP_URL "$BR_DIR/.env.poc")"
  [[ ! "${live%/}" =~ ^https://pr-[0-9]+-br\. ]] || die 2 "The site's own address has a preview's shape of name (pr-<n>-br). Give the site another."
  local origin repo
  origin="$(git -C "$BR_DIR" remote get-url origin)"
  repo="$(printf '%s' "$origin" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
  [[ "$repo" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || die 2 "The site's checkout isn't a GitHub clone ($origin)."
  umask 077
  mkdir -p "$BR_PREVIEW_HOME"
  chmod 700 "$BR_PREVIEW_HOME"
  if [ -f "$SHARED_ENV" ]; then
    say ".env.preview already exists; left as is."
  else
    local tmp
    tmp="$(mktemp "$BR_PREVIEW_HOME/.env.preview.XXXXXX")"
    {
      printf '# Pull request previews (docs/superpowers/specs/2026-11-27-pr-previews-design.md). Never copy .env.poc into it.\n'
      printf 'PREVIEW_DOMAIN=%s\n' "$domain"
      printf 'PREVIEW_GATE_HEADER=%s\n' "$gate"
      printf 'PREVIEW_REPO=%s\n' "$repo"
      printf 'PREVIEW_OWNER=%s\n' "$owner"
      printf 'PREVIEW_LABEL=preview\n'
      printf 'PREVIEW_MAX=2\n'
      printf 'PREVIEW_TTL_DAYS=7\n'
      printf '# Optional: a fine-grained token with read-only access to this repository alone (pull requests, metadata).\n'
      printf 'GITHUB_TOKEN=\n'
    } > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$SHARED_ENV"
    say "Created .env.preview: previews at https://pr-<n>-br.$domain, for $repo, triggered by $owner."
  fi
  if [ ! -d "$REPO_CLONE/.git" ]; then
    git clone --quiet --no-checkout "$origin" "$REPO_CLONE"
  fi
  if docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1; then
    say "Network $EDGE_NETWORK already exists."
  else
    docker network create --internal "$EDGE_NETWORK" >/dev/null
    say "Created network $EDGE_NETWORK (internal: nothing on it can reach outside this machine)."
  fi
  edge up -d >/dev/null
  say "The previews' proxy is up. Next: the owner's steps in the design doc (the tunnel, DNS and the access gate)."
}

check_ready() {
  [ -f "$SHARED_ENV" ] || die 2 "No .env.preview. Run scripts/poc/preview.sh init first."
  if [ "$(uname -s)" = "Linux" ]; then
    [ "$(stat -c '%a' "$SHARED_ENV")" = "600" ] || die 2 ".env.preview must be private: chmod 600 $SHARED_ENV"
  fi
  local key
  for key in PREVIEW_DOMAIN PREVIEW_GATE_HEADER PREVIEW_REPO PREVIEW_OWNER PREVIEW_LABEL PREVIEW_MAX PREVIEW_TTL_DAYS; do
    grep -Eq "^${key}=.+" "$SHARED_ENV" || die 2 ".env.preview has no $key."
  done
  [ "$(docker network inspect --format '{{.Internal}}' "$EDGE_NETWORK" 2>/dev/null || echo missing)" = "true" ] \
    || die 2 "The network $EDGE_NETWORK is missing or not internal. Run scripts/poc/preview.sh init (remove a network of that name made another way first)."
}

lock() {
  command -v flock >/dev/null 2>&1 || return 0
  exec 9>"$BR_PREVIEW_HOME/.preview.lock"
  flock -n 9 || die 2 "Another preview command is running. Try again when it finishes."
  # Two builds at once are too much for this machine: wait for the site's deploy instead of building beside it.
  if [ -e "$BR_DIR/.deploy.lock" ]; then
    exec 8<"$BR_DIR/.deploy.lock"
    flock -n 8 || die 2 "The site is deploying. Try again when it finishes."
    flock -u 8
    exec 8<&-
  fi
}

# The one gate on whose code runs here: an open pull request whose head is a branch of this very repository. A fork's
# pull request is refused, whoever asks. Sets PR_BRANCH and PR_SHA.
check_pr() {
  local json repo
  repo="$(setting PREVIEW_REPO)"
  json="$(github "pulls/$PREVIEW_PR")"
  [ "$(jq -r .state <<<"$json")" = "open" ] || die 2 "Pull request $PREVIEW_PR isn't open."
  [ "$(jq -r '.base.repo.full_name' <<<"$json")" = "$repo" ] || die 2 "Pull request $PREVIEW_PR isn't into $repo."
  [ "$(jq -r '.head.repo.full_name // ""' <<<"$json")" = "$repo" ] \
    || die 2 "Pull request $PREVIEW_PR comes from a fork. Previews run only this repository's own branches."
  PR_BRANCH="$(jq -r .head.ref <<<"$json")"
  PR_SHA="$(jq -r .head.sha <<<"$json")"
  if ! [[ "$PR_BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] || [[ "$PR_BRANCH" == *..* ]]; then
    die 2 "That branch name isn't one this script takes."
  fi
  [[ "$PR_SHA" =~ ^[0-9a-f]{40}$ ]] || die 5 "GitHub gave no commit for pull request $PREVIEW_PR."
}

# The branch itself, never the pull request's own ref on GitHub (which a fork writes), and only at the commit GitHub just named.
fetch_pr() {
  git -C "$REPO_CLONE" fetch --quiet --no-tags origin "+refs/heads/$PR_BRANCH:refs/preview/pr-$PREVIEW_PR" \
    || die 6 "Couldn't fetch $PR_BRANCH. Nothing was changed."
  [ "$(git -C "$REPO_CLONE" rev-parse "refs/preview/pr-$PREVIEW_PR")" = "$PR_SHA" ] \
    || die 6 "$PR_BRANCH moved while it was fetched. Nothing was changed; run it again."
  local next="$PR_HOME/src.next"
  rm -rf "$next"; mkdir -p "$next"
  git -C "$REPO_CLONE" archive "$PR_SHA" | tar -x -C "$next"
}

make_pr_home() {
  umask 077
  mkdir -p "$PR_HOME/mail-tls"
  if [ ! -f "$PR_ENV" ]; then
    local tmp
    tmp="$(mktemp "$PR_HOME/pr.env.XXXXXX")"
    {
      printf 'APP_URL=https://%s\n' "$PR_HOST"
      printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
      printf 'DB_PASSWORD=%s\n' "$(openssl rand -hex 24)"
      printf 'SETTINGS_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)"
    } > "$tmp"
    chmod 600 "$tmp"; mv "$tmp" "$PR_ENV"
  fi
  # The preview's secrets are never the site's: a preview signed with them could forge the site's sessions.
  if [ -f "$BR_DIR/.env.poc" ]; then
    local key
    for key in APP_URL BETTER_AUTH_SECRET DB_PASSWORD SETTINGS_ENCRYPTION_KEY; do
      [ "$(env_value "$key" "$PR_ENV")" != "$(env_value "$key" "$BR_DIR/.env.poc")" ] \
        || die 2 "pr-$PREVIEW_PR's pr.env has the site's $key. Remove $PR_ENV and run it again."
    done
  fi
  if [ ! -f "$PR_HOME/mail-tls/cert.pem" ]; then
    # A certificate for 127.0.0.1 only, which mailpit presents and this preview's app alone trusts.
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" \
      -keyout "$PR_HOME/mail-tls/key.pem" -out "$PR_HOME/mail-tls/cert.pem" 2>/dev/null
    chmod 644 "$PR_HOME/mail-tls/key.pem" "$PR_HOME/mail-tls/cert.pem"
  fi
}

running() {
  local d
  for d in "$BR_PREVIEW_HOME"/pr-*/current; do
    [ -f "$d" ] || continue
    d="${d%/current}"; printf '%s\n' "${d##*/pr-}"
  done
}

wait_healthy() {
  local waited=0 status
  while [ "$waited" -lt "$BR_HEALTH_TIMEOUT" ]; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "booster-rocket-pr-$PREVIEW_PR-app" 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] && return 0
    sleep 2
    waited=$((waited + 2))
  done
  stop_preview
  die 4 "Preview $PREVIEW_PR's app didn't become healthy within ${BR_HEALTH_TIMEOUT}s; it is down."
}

stop_preview() {
  docker network disconnect "booster-rocket-pr-$PREVIEW_PR-internal" "$PROXY" >/dev/null 2>&1 || true
  compose --profile tools down --remove-orphans >/dev/null 2>&1 || true
  # Only this preview's own database, by its name. Never a volume of the site's or another preview's.
  docker volume rm "booster-rocket-pr-$PREVIEW_PR-db" >/dev/null 2>&1 || true
}

start_preview() {
  stop_preview
  compose up -d db >/dev/null
  say "Installing the seed's dependencies."
  compose run --rm seed-install >/dev/null || { stop_preview; die 3 "Installing the seed's dependencies failed; preview $PREVIEW_PR is down."; }
  say "Seeding preview $PREVIEW_PR's database with the e2e test data."
  compose run --rm seed || { stop_preview; die 3 "The seed failed (its lines are above); preview $PREVIEW_PR is down."; }
  compose up -d app >/dev/null
  wait_healthy
  compose up -d mailpit worker door >/dev/null
  docker network connect "booster-rocket-pr-$PREVIEW_PR-internal" "$PROXY" >/dev/null
}

up() {
  pr_number "$1"; check_pr
  if [ ! -f "$PR_HOME/current" ]; then
    local count; count="$(running | wc -l)"
    [ "$count" -lt "$(setting PREVIEW_MAX)" ] || die 2 "$(setting PREVIEW_MAX) previews are running already. Take one down first."
  elif [ "$(env_value commit "$PR_HOME/current")" = "$PR_SHA" ] && [ "${2:-}" = "--if-changed" ]; then
    return 0
  fi
  make_pr_home; fetch_pr
  PREVIEW_REF="#$PREVIEW_PR $PR_BRANCH"; APP_COMMIT="${PR_SHA:0:12}"
  export PREVIEW_REF APP_COMMIT
  say "Building pull request $PREVIEW_PR ($PR_BRANCH at $APP_COMMIT); a preview already running stays up meanwhile."
  BR_PREVIEW_SRC="$PR_HOME/src.next" compose build app || { rm -rf "$PR_HOME/src.next"; die 7 "The build failed. The running preview, if any, was not touched."; }
  rm -rf "$BR_PREVIEW_SRC"; mv "$PR_HOME/src.next" "$BR_PREVIEW_SRC"
  start_preview
  printf 'pr=%s\nbranch=%s\ncommit=%s\nat=%s\n' "$PREVIEW_PR" "$PR_BRANCH" "$PR_SHA" "$(date -u +%s)" > "$PR_HOME/current"
  say "Preview $PREVIEW_PR is up: $(env_value APP_URL "$PR_ENV")/__preview/ (mail at /__preview/mail/)."
}

down() {
  pr_number "$1"
  stop_preview
  docker volume rm "booster-rocket-pr-$PREVIEW_PR-node-modules" >/dev/null 2>&1 || true
  docker image rm "booster-rocket-preview-app:pr-$PREVIEW_PR" >/dev/null 2>&1 || true
  git -C "$REPO_CLONE" update-ref -d "refs/preview/pr-$PREVIEW_PR" 2>/dev/null || true
  rm -rf "$PR_HOME"
  say "Preview $PREVIEW_PR is down; its database, image and folder are gone."
}

# Does the label count? It must have been put on last by the previews workflow (the Actions bot, which only the owner
# can start) or by the owner, and less than PREVIEW_TTL_DAYS ago. Anyone with triage rights can label; that counts
# for nothing.
label_fresh() {
  local at
  at="$(github_all "issues/$1/events?per_page=100" | jq -r --arg label "$(setting PREVIEW_LABEL)" \
    --arg owner "$(setting PREVIEW_OWNER)" --arg bot "github-actions[bot]" \
    '[.[] | select((.event == "labeled" or .event == "unlabeled") and .label.name == $label)] | last
     | if . != null and .event == "labeled" and (.actor.login == $owner or .actor.login == $bot)
       then (.created_at | fromdateiso8601) else empty end')"
  [ -n "$at" ] && [ $(( $(date -u +%s) - at )) -le $(( $(setting PREVIEW_TTL_DAYS) * 86400 )) ]
}

labeled_open() {
  github "issues?state=open&labels=$(setting PREVIEW_LABEL)&per_page=30" | jq -r '.[] | select(.pull_request) | .number'
}

sweep() {
  local n wanted
  wanted="$(labeled_open)"
  for n in $(running); do
    if grep -qx "$n" <<<"$wanted" && label_fresh "$n"; then continue; fi
    say "Pull request $n is closed, unlabeled, or its label is too old."
    down "$n"
  done
}

poll() {
  sweep
  local n
  for n in $(labeled_open); do
    label_fresh "$n" || continue
    ( up "$n" --if-changed ) || say "Preview $n wasn't brought up (above)."
  done
}

need docker; need git; need openssl
cmd="${1:-}"
case "$cmd" in
  init) shift; init "$@" ;;
  list)
    check_ready
    for n in $(running); do cat "$BR_PREVIEW_HOME/pr-$n/current"; echo; done ;;
  up) check_ready; lock; up "${2:-}" ;;
  reset)
    check_ready; lock; pr_number "${2:-}"
    [ -f "$PR_HOME/current" ] || die 2 "Preview $PREVIEW_PR isn't running; use up."
    PREVIEW_REF="#$PREVIEW_PR $(env_value branch "$PR_HOME/current")"
    APP_COMMIT="$(env_value commit "$PR_HOME/current" | cut -c1-12)"
    export PREVIEW_REF APP_COMMIT
    start_preview
    say "Preview $PREVIEW_PR is seeded afresh." ;;
  down) check_ready; lock; down "${2:-}" ;;
  sweep) check_ready; lock; sweep ;;
  poll) check_ready; lock; poll ;;
  *) die 2 "Give one of: init, up <n>, reset <n>, down <n>, list, sweep, poll." ;;
esac
