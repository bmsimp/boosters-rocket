#!/usr/bin/env bash
# Backs up the Booster Rocket database into a folder, and keeps the newest few backups there.
#   scripts/backup.sh <folder>             write booster-rocket-<UTC time>.dump into <folder> and keep the newest 14
#   scripts/backup.sh <folder> --keep 30   keep the newest 30 instead
# Run it every night (cron), and before anything risky. scripts/poc/deploy.sh runs it before it migrates.
#
# How it reaches the database:
#   BR_DB_CONTAINER  the Postgres container to run pg_dump in. Default: booster-rocket-db-1, the one the compose file
#                    starts. Set it to an empty value to use the pg_dump on this machine instead; the connection then
#                    comes from the usual PGHOST, PGPORT, PGUSER and PGPASSWORD (or ~/.pgpass).
#   BR_DB_NAME       the database to back up (default booster)
#   BR_DB_USER       the database user inside the container (default booster)
#   BR_DB_WAIT       seconds to wait for the database to answer (default 30)
# No password is ever put on a command line or printed.
#
# Exit codes: 0 ok, 2 refused (bad arguments, or the folder can't be written), 3 the database can't be reached,
# 4 the backup failed (nothing was kept, and no older backup was removed).
set -euo pipefail
export LC_ALL=C
umask 077

BR_DB_CONTAINER="${BR_DB_CONTAINER-booster-rocket-db-1}"
BR_DB_NAME="${BR_DB_NAME:-booster}"
BR_DB_USER="${BR_DB_USER:-booster}"
BR_DB_WAIT="${BR_DB_WAIT:-30}"
KEEP=14
NAME_PATTERN='^booster-rocket-[0-9]{8}T[0-9]{6}Z\.dump$'

say() { printf '%s\n' "$*"; }
die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }
usage() { die 2 "Usage: scripts/backup.sh <folder> [--keep <number>]"; }

DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep) [ "$#" -ge 2 ] || usage; KEEP="$2"; shift 2 ;;
    --keep=*) KEEP="${1#--keep=}"; shift ;;
    -*) usage ;;
    *) [ -z "$DIR" ] || usage; DIR="$1"; shift ;;
  esac
done
[ -n "$DIR" ] || usage
[[ "$KEEP" =~ ^[1-9][0-9]{0,3}$ ]] || die 2 "--keep takes a number from 1 to 9999: how many backups to keep."
[[ "$BR_DB_WAIT" =~ ^[0-9]{1,4}$ ]] || die 2 "BR_DB_WAIT must be a number of seconds."

# Where the Postgres tools run: inside the database's container, or on this machine.
if [ -n "$BR_DB_CONTAINER" ]; then
  command -v docker >/dev/null 2>&1 || die 3 "docker isn't available here, so the database container $BR_DB_CONTAINER can't be reached."
  CONN=(-U "$BR_DB_USER" --no-password)
  pg() { docker exec "$BR_DB_CONTAINER" "$@"; }
  pg_in() { docker exec -i "$BR_DB_CONTAINER" "$@"; }
else
  command -v pg_dump >/dev/null 2>&1 || die 3 "pg_dump isn't installed on this machine. Install the PostgreSQL client tools, or set BR_DB_CONTAINER to the database's container."
  CONN=(--no-password)
  pg() { "$@" </dev/null; }
  pg_in() { "$@"; }
fi

mkdir -p "$DIR" 2>/dev/null || die 2 "The folder $DIR can't be created."
[ -d "$DIR" ] && [ -w "$DIR" ] || die 2 "The folder $DIR can't be written to."

wait_for_database() {
  local waited=0
  if [ -n "$BR_DB_CONTAINER" ]; then
    [ "$(docker inspect --format '{{.State.Running}}' "$BR_DB_CONTAINER" 2>/dev/null || true)" = "true" ] \
      || die 3 "The database container $BR_DB_CONTAINER isn't running. Nothing was backed up."
  fi
  while ! pg psql "${CONN[@]}" -d "$BR_DB_NAME" -Atqc 'select 1' >/dev/null 2>&1; do
    [ "$waited" -lt "$BR_DB_WAIT" ] || die 3 "The database $BR_DB_NAME didn't answer within ${BR_DB_WAIT}s. Nothing was backed up."
    sleep 1
    waited=$((waited + 1))
  done
}

# The time is in the name, so the names sort oldest first. Two backups in the same second wait for the next one.
new_name() {
  local name tries=0
  while :; do
    name="booster-rocket-$(date -u +%Y%m%dT%H%M%SZ).dump"
    [ -e "$DIR/$name" ] || { printf '%s' "$name"; return 0; }
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || return 1
    sleep 1
  done
}

wait_for_database
name="$(new_name)" || die 4 "Couldn't choose a name for the backup in $DIR. Nothing was backed up."
final="$DIR/$name"
partial="$DIR/.$name.partial"
trap 'rm -f "$partial"' EXIT

# Written under another name first: a backup that stopped half way is never left looking like a good one.
if ! pg pg_dump "${CONN[@]}" -d "$BR_DB_NAME" --format=custom > "$partial"; then
  die 4 "The backup failed. Nothing was kept, and no older backup was removed."
fi
[ -s "$partial" ] || die 4 "The backup came out empty. Nothing was kept, and no older backup was removed."
# Read all of it back before trusting it. Listing the archive (pg_restore --list) reads only the table of contents at
# the start of the file, which a dump cut short still has. Writing the whole restore script out, to nowhere, reads
# every table's data to the end, and needs no database.
if ! pg_in pg_restore -f /dev/null < "$partial" >/dev/null 2>&1; then
  die 4 "The backup that was written can't be read back. It was not kept, and no older backup was removed."
fi
mv "$partial" "$final"
trap - EXIT
bytes="$(wc -c < "$final" | tr -d '[:space:]')"

# Keep the newest $KEEP. Only files this script named are ever removed: one you renamed or copied in stays.
removed=0
kept=()
for f in "$DIR"/booster-rocket-*.dump; do
  [ -f "$f" ] || continue
  [[ "$(basename "$f")" =~ $NAME_PATTERN ]] && kept+=("$f")
done
excess=$(( ${#kept[@]} - KEEP ))
if [ "$excess" -gt 0 ]; then
  for f in "${kept[@]:0:excess}"; do
    rm -f -- "$f"
    removed=$((removed + 1))
  done
fi

# Tell the portal, so its Health page can say when the last backup was taken. The backup is good without this.
recorded="$(pg_in psql "${CONN[@]}" -d "$BR_DB_NAME" -v ON_ERROR_STOP=1 -Atq -v "file=$name" -v "bytes=$bytes" 2>/dev/null <<'SQL' || true
select to_regclass('public.setting') is not null as has_setting \gset
\if :has_setting
insert into setting (key, value)
  values ('backup.last_success', jsonb_build_object('at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'file', :'file', 'bytes', :bytes::bigint))
  on conflict (key) do update set value = excluded.value, updated_at = now();
\echo recorded
\else
\echo no-portal-tables
\endif
SQL
)"

say "Backup written: $final ($bytes bytes)."
if [ "$removed" -gt 0 ]; then
  say "Keeping the newest $KEEP backups in $DIR; removed $removed older."
else
  say "Keeping the newest $KEEP backups in $DIR; none needed removing."
fi
case "$recorded" in
  *recorded*) ;;
  *no-portal-tables*) say "This database has no portal tables yet, so the portal's Health page was not told about this backup." ;;
  *) say "The backup is good, but the portal's Health page could not be told about it. It will show the backup before this one." ;;
esac
cat <<'EOT'

Keep two more things, or this backup can't bring the portal back:
  1. The env file the portal runs with (.env.poc), kept somewhere safe and private. It holds SETTINGS_ENCRYPTION_KEY.
     Without that key the QuickBooks connection, the sign-in certificates and the mail password stored in this backup
     can't be read, and each would have to be set up again.
  2. A copy of this folder somewhere other than this server. A backup that lives only on the machine it protects
     is lost with it.
To check that a backup can be restored, without touching the live database:
  scripts/restore.sh <backup file> booster_restore_check
EOT
