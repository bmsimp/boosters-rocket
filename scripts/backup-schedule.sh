#!/usr/bin/env bash
# Runs scripts/backup.sh once a night, at a set time of the club's day, and sleeps in between. deploy/compose.yml runs
# it as the service "backup"; a club that would rather use the host's own scheduler runs backup.sh from cron instead
# (docs/runbooks/backups.md).
#   scripts/backup-schedule.sh <folder> [--keep <number>]          every night, until stopped
#   scripts/backup-schedule.sh <folder> [--keep <number>] --now    one backup now; exits with backup.sh's exit code
#   scripts/backup-schedule.sh <folder> --next                     says when the next backup will be, and changes nothing
# The folder and --keep are passed to backup.sh, which reads the database settings it always reads (BR_DB_CONTAINER,
# PGHOST and the rest; see its header).
#
# When:
#   TZ             the club's time zone, an IANA name such as America/Chicago (required)
#   BR_BACKUP_AT   the time of day, HH:MM on a 24-hour clock in that zone (default 03:00). Choose a time that exists on
#                  every day of the year: in most zones the clocks change between 01:00 and 03:00.
#
# It prints nothing of its own while it waits or runs: what reaches the log is backup.sh's own lines, one run a night.
# Exit codes: 2 refused (bad arguments or settings, as backup.sh refuses), and with --now whatever backup.sh exits with.
# Without --now it runs until it is stopped, and exits 0 then.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP="$HERE/backup.sh"
BR_BACKUP_AT="${BR_BACKUP_AT:-03:00}"

die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }
usage() { die 2 "Usage: scripts/backup-schedule.sh <folder> [--keep <number>] [--now | --next]"; }

DIR="" KEEP="" MODE="loop"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep) [ "$#" -ge 2 ] || usage; KEEP="$2"; shift 2 ;;
    --keep=*) KEEP="${1#--keep=}"; shift ;;
    --now) MODE="now"; shift ;;
    --next) MODE="next"; shift ;;
    -*) usage ;;
    *) [ -z "$DIR" ] || usage; DIR="$1"; shift ;;
  esac
done
[ -n "$DIR" ] || usage
[ -z "$KEEP" ] || [[ "$KEEP" =~ ^[1-9][0-9]{0,3}$ ]] || die 2 "--keep takes a number from 1 to 9999: how many backups to keep."
[[ "$BR_BACKUP_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die 2 "BR_BACKUP_AT must be a time of day like 03:00 (24-hour clock, in the club's time zone)."
[ -n "${TZ:-}" ] || die 2 "Set TZ to the club's time zone, an IANA name such as America/Chicago, so the backup runs at $BR_BACKUP_AT club time."
[[ "$TZ" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] && [ -f "/usr/share/zoneinfo/$TZ" ] \
  || die 2 "TZ is $TZ, which isn't a time zone this machine knows. Use an IANA name such as America/Chicago."
export TZ
[ -f "$BACKUP" ] || die 2 "backup.sh isn't beside this script, in $HERE."
date -d "2000-01-01 00:00" +%s >/dev/null 2>&1 || die 2 "This machine's date command can't read dates (it needs GNU date)."

backup_args=("$DIR")
[ -z "$KEEP" ] || backup_args+=(--keep "$KEEP")

# The next time it is BR_BACKUP_AT in the club's zone, as seconds since 1970: today's if it is still to come, else the
# next day's. A day on which that time doesn't exist (the clocks jumped over it) is passed over.
next_run() {
  local now day target i
  now="$(date +%s)"
  for i in 0 1 2; do
    day="$(date -d "@$((now + i * 86400))" +%F)"
    target="$(date -d "$day $BR_BACKUP_AT" +%s 2>/dev/null)" || continue
    [ "$target" -le "$now" ] || { printf '%s' "$target"; return 0; }
  done
  return 1
}

case "$MODE" in
  now) exec bash "$BACKUP" "${backup_args[@]}" ;;
  next)
    at="$(next_run)" || die 2 "Couldn't work out when $BR_BACKUP_AT next comes in $TZ."
    printf 'The next backup is at %s (%s).\n' "$(date -d "@$at" '+%Y-%m-%d %H:%M %Z')" "$TZ"
    exit 0 ;;
esac

# Stopped while it sleeps, it stops at once. Stopped while a backup runs, the backup finishes first (give the
# container time to stop: deploy/compose.yml does).
trap 'exit 0' TERM INT
while :; do
  at="$(next_run)" || die 2 "Couldn't work out when $BR_BACKUP_AT next comes in $TZ."
  # Short sleeps, each checked against the clock, so a clock that is corrected or a machine that slept doesn't move
  # the backup by hours.
  while [ "$(date +%s)" -lt "$at" ]; do
    left=$((at - $(date +%s)))
    [ "$left" -le 300 ] || left=300
    [ "$left" -ge 1 ] || left=1
    sleep "$left" &
    wait $! || true
  done
  bash "$BACKUP" "${backup_args[@]}" || true
done
