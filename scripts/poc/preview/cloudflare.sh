#!/usr/bin/env bash
# A preview's gate in Cloudflare (docs/superpowers/specs/2026-11-27-pr-previews-design.md), run by the previews
# workflow (.github/workflows/previews.yml) on GitHub's runner, never on the test server: the API token stays in
# GitHub. Each preview has an Access application for its one host name, pr-<n>-br.<PREVIEW_DOMAIN>, and a proxied
# DNS name pointing at the tunnel. The application is made before the DNS name and goes after it, so the name never
# answers without the gate. Every lookup and delete is by the preview's own host name: nothing else of the zone or the
# account is touched.
#   cloudflare.sh open <n>    the Access application, then the DNS name (each only if missing)
#   cloudflare.sh close <n>   the DNS name, then the Access application (each only if there)
#   cloudflare.sh list        the numbers of the previews that have either
# Needs CF_API_TOKEN (Access: Apps and Policies Edit on the account; DNS Edit on the zone), CF_ACCOUNT_ID,
# CF_ZONE_ID, CF_TUNNEL_ID, CF_ACCESS_POLICY_ID (a reusable policy: the owner only) and PREVIEW_DOMAIN.
# Exit codes: 0 ok, 2 refused, 5 Cloudflare refused or answered something unexpected.
set -euo pipefail

CF_API="${CF_API:-https://api.cloudflare.com/client/v4}"

die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }
say() { printf '%s\n' "$*"; }

for key in CF_API_TOKEN CF_ACCOUNT_ID CF_ZONE_ID CF_TUNNEL_ID CF_ACCESS_POLICY_ID PREVIEW_DOMAIN; do
  [ -n "${!key:-}" ] || die 2 "$key is not set."
done
[[ "$PREVIEW_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die 2 "PREVIEW_DOMAIN isn't a domain."
for key in CF_ACCOUNT_ID CF_ZONE_ID CF_TUNNEL_ID CF_ACCESS_POLICY_ID; do
  [[ "${!key}" =~ ^[A-Za-z0-9-]{1,64}$ ]] || die 2 "$key isn't an id."
done

cf() {
  local method="$1" path="$2" body="${3:-}" args=() answer
  [ -z "$body" ] || args=(-H "Content-Type: application/json" --data "$body")
  answer="$(curl -sS --max-time 30 -X "$method" -H "Authorization: Bearer $CF_API_TOKEN" "${args[@]}" "$CF_API/$path")" \
    || die 5 "Couldn't reach Cloudflare for $method $path."
  jq -e '.success == true' >/dev/null 2>&1 <<<"$answer" \
    || die 5 "Cloudflare refused $method $path: $(jq -c '.errors // "no answer"' 2>/dev/null <<<"$answer" || echo "an answer that isn't JSON")"
  printf '%s' "$answer"
}

host_of() {
  [[ "${1:-}" =~ ^[1-9][0-9]{0,5}$ ]] || die 2 "Give a pull request's number."
  HOST="pr-$1-br.$PREVIEW_DOMAIN"
}
app_id() {
  cf GET "accounts/$CF_ACCOUNT_ID/access/apps?domain=$HOST&per_page=50" \
    | jq -r --arg host "$HOST" '[.result[] | select(.domain == $host)][0].id // ""'
}
record_id() {
  cf GET "zones/$CF_ZONE_ID/dns_records?type=CNAME&name=$HOST" \
    | jq -r --arg host "$HOST" '[.result[] | select(.name == $host)][0].id // ""'
}

open_gate() {
  host_of "$1"
  if [ -z "$(app_id)" ]; then
    cf POST "accounts/$CF_ACCOUNT_ID/access/apps" "$(jq -nc --arg host "$HOST" --arg policy "$CF_ACCESS_POLICY_ID" \
      '{type: "self_hosted", name: ("Boosters Rocket preview " + $host), domain: $host, session_duration: "168h",
        app_launcher_visible: false, policies: [{id: $policy, precedence: 1}]}')" >/dev/null
    say "Made the Access application for $HOST."
  fi
  [ -n "$(app_id)" ] || die 5 "The Access application for $HOST isn't there; its DNS name was not made."
  if [ -z "$(record_id)" ]; then
    cf POST "zones/$CF_ZONE_ID/dns_records" "$(jq -nc --arg host "$HOST" --arg target "$CF_TUNNEL_ID.cfargotunnel.com" \
      '{type: "CNAME", name: $host, content: $target, proxied: true, comment: "Boosters Rocket preview; removed when its pull request closes"}')" >/dev/null
    say "Made the DNS name $HOST."
  fi
}

close_gate() {
  host_of "$1"
  local id
  id="$(record_id)"
  [ -z "$id" ] || { cf DELETE "zones/$CF_ZONE_ID/dns_records/$id" >/dev/null; say "Removed the DNS name $HOST."; }
  [ -z "$(record_id)" ] || die 5 "The DNS name $HOST is still there; its Access application was kept."
  id="$(app_id)"
  [ -z "$id" ] || { cf DELETE "accounts/$CF_ACCOUNT_ID/access/apps/$id" >/dev/null; say "Removed the Access application for $HOST."; }
}

list_gates() {
  local pattern="^pr-([1-9][0-9]{0,5})-br\\.${PREVIEW_DOMAIN//./\\.}$"
  {
    cf GET "accounts/$CF_ACCOUNT_ID/access/apps?per_page=1000" | jq -r '.result[].domain // empty'
    cf GET "zones/$CF_ZONE_ID/dns_records?type=CNAME&per_page=5000" | jq -r '.result[].name'
  } | sed -nE "s/$pattern/\\1/p" | sort -un
}

case "${1:-}" in
  open) open_gate "${2:-}" ;;
  close) close_gate "${2:-}" ;;
  list) list_gates ;;
  *) die 2 "Give one of: open <n>, close <n>, list." ;;
esac
