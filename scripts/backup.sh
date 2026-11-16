#!/usr/bin/env bash
# Backs up Booster Rocket's databases into a folder, and keeps the newest few backups of each there.
#   scripts/backup.sh <folder>             write booster-rocket-<UTC time>.dump (the portal's database) and, when the
#                                          server has Documenso's database, documenso-<UTC time>.dump beside it; keep
#                                          the newest 14 of each
#   scripts/backup.sh <folder> --keep 30   keep the newest 30 of each instead
# Run it every night (deploy/compose.yml has a service that does: docs/runbooks/backups.md), and before
# anything risky. scripts/poc/deploy.sh runs it before it migrates.
#
# The databases are not all there is to keep. Keep with the backups, somewhere safe and private: the env file the
# portal runs with (its SETTINGS_ENCRYPTION_KEY), and Documenso's signing certificate (the .p12 file) with its passphrase.
#
# How it reaches the database:
#   BR_DB_CONTAINER       the Postgres container to run pg_dump in. Default: booster-rocket-db-1, the one the development
#                         compose file starts. Set it to an empty value to use the pg_dump on this machine instead; the
#                         connection then comes from the usual PGHOST, PGPORT, PGUSER and PGPASSWORD (or ~/.pgpass).
#   BR_DB_NAME            the portal's database (default booster)
#   BR_DB_USER            the database user inside the container (default booster)
#   BR_DOCUMENSO_DB_NAME  Documenso's database. Left unset, the database named documenso is backed up when the server
#                         has one, and the output says when it hasn't. Set to a name, that database must be there or
#                         nothing is backed up. Set to an empty value, Documenso's database is left out.
#   BR_DOCUMENSO_DB_USER  the database user for Documenso's database inside the container (default: BR_DB_USER)
#   BR_DB_WAIT            seconds to wait for the database to answer (default 30)
# No password is ever put on a command line or printed.
#
# Exit codes: 0 ok, 2 refused (bad arguments, or the folder can't be written), 3 a database can't be reached,
# 4 the backup failed (nothing was kept, and no older backup was removed).
set -euo pipefail
export LC_ALL=C
umask 077

BR_DB_CONTAINER="${BR_DB_CONTAINER-booster-rocket-db-1}"
BR_DB_NAME="${BR_DB_NAME:-booster}"
BR_DB_USER="${BR_DB_USER:-booster}"
BR_DOCUMENSO_DB_USER="${BR_DOCUMENSO_DB_USER:-$BR_DB_USER}"
BR_DB_WAIT="${BR_DB_WAIT:-30}"
# Unset: look for a database named documenso. Set (even to nothing): exactly what it says.
if [ -n "${BR_DOCUMENSO_DB_NAME+set}" ]; then DOCUMENSO_ASKED="yes"; else DOCUMENSO_ASKED=""; BR_DOCUMENSO_DB_NAME="documenso"; fi
KEEP=14
PORTAL_PATTERN='^booster-rocket-[0-9]{8}T[0-9]{6}Z\.dump$'
DOCUMENSO_PATTERN='^documenso-[0-9]{8}T[0-9]{6}Z\.dump$'

say() { printf '%s\n' "$*"; }
die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }
usage() {
  die 2 "Usage: scripts/backup.sh <folder> [--keep <number>]
Backs up the portal's database, and Documenso's when the server has it. Keep the env file the portal runs with, and
Documenso's signing certificate (the .p12 file) with its passphrase, somewhere safe with the backups as well."
}

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
# The names go into SQL below, so they are held to plain letters, digits and underscores.
for name in "$BR_DB_NAME" "$BR_DOCUMENSO_DB_NAME"; do
  [ -z "$name" ] || [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die 2 "A database name must be letters, digits and underscores: $name isn't."
done
[ "$BR_DOCUMENSO_DB_NAME" != "$BR_DB_NAME" ] || die 2 "BR_DOCUMENSO_DB_NAME names the portal's own database ($BR_DB_NAME). Name Documenso's database, or set it to an empty value."

# Where the Postgres tools run: inside the database's container, or on this machine.
if [ -n "$BR_DB_CONTAINER" ]; then
  command -v docker >/dev/null 2>&1 || die 3 "docker isn't available here, so the database container $BR_DB_CONTAINER can't be reached."
  CONN=(-U "$BR_DB_USER" --no-password)
  DOC_CONN=(-U "$BR_DOCUMENSO_DB_USER" --no-password)
  pg() { docker exec "$BR_DB_CONTAINER" "$@"; }
  pg_in() { docker exec -i "$BR_DB_CONTAINER" "$@"; }
else
  command -v pg_dump >/dev/null 2>&1 || die 3 "pg_dump isn't installed on this machine. Install the PostgreSQL client tools, or set BR_DB_CONTAINER to the database's container."
  CONN=(--no-password)
  DOC_CONN=(--no-password)
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

# Whether Documenso's database is backed up this time: "" when it is left out, else its name.
documenso_database() {
  [ -n "$BR_DOCUMENSO_DB_NAME" ] || return 0
  local found
  found="$(pg psql "${CONN[@]}" -d "$BR_DB_NAME" -Atqc "select count(*) from pg_database where datname = '$BR_DOCUMENSO_DB_NAME'" 2>/dev/null || true)"
  if [ "$found" = "1" ]; then
    pg psql "${DOC_CONN[@]}" -d "$BR_DOCUMENSO_DB_NAME" -Atqc 'select 1' >/dev/null 2>&1 \
      || die 3 "Documenso's database $BR_DOCUMENSO_DB_NAME is there, but it didn't answer as $BR_DOCUMENSO_DB_USER. Nothing was backed up."
    printf '%s' "$BR_DOCUMENSO_DB_NAME"
  elif [ -n "$DOCUMENSO_ASKED" ]; then
    die 3 "Documenso's database $BR_DOCUMENSO_DB_NAME isn't on this server. Nothing was backed up. (To back up the portal's database alone, set BR_DOCUMENSO_DB_NAME to an empty value.)"
  fi
}

# The time is in the names, so the names sort oldest first. Two backups in the same second wait for the next one.
new_stamp() {
  local stamp tries=0
  while :; do
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    [ -e "$DIR/booster-rocket-$stamp.dump" ] || [ -e "$DIR/documenso-$stamp.dump" ] || { printf '%s' "$stamp"; return 0; }
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || return 1
    sleep 1
  done
}

# Writes one database's dump under a name of its own first, and reads all of it back before it is trusted: a backup
# that stopped half way is never left looking like a good one. Listing the archive (pg_restore --list) reads only the
# table of contents at the start of the file, which a dump cut short still has. Writing the whole restore script out,
# to nowhere, reads every table's data to the end, and needs no database.
dump_and_check() {
  local what="$1" into="$2"; shift 2
  if ! pg pg_dump "$@" --format=custom > "$into"; then
    die 4 "The backup of $what failed. Nothing was kept, and no older backup was removed."
  fi
  [ -s "$into" ] || die 4 "The backup of $what came out empty. Nothing was kept, and no older backup was removed."
  if ! pg_in pg_restore -f /dev/null < "$into" >/dev/null 2>&1; then
    die 4 "The backup of $what that was written can't be read back. It was not kept, and no older backup was removed."
  fi
}

# Keeps the newest $KEEP files whose names match a pattern. Only files this script named are ever removed: one you
# renamed or copied in stays.
prune() {
  local pattern="$1" glob="$2" f excess removed=0
  local kept=()
  for f in "$DIR"/$glob; do
    [ -f "$f" ] || continue
    [[ "$(basename "$f")" =~ $pattern ]] && kept+=("$f")
  done
  excess=$(( ${#kept[@]} - KEEP ))
  if [ "$excess" -gt 0 ]; then
    for f in "${kept[@]:0:excess}"; do
      rm -f -- "$f"
      removed=$((removed + 1))
    done
  fi
  printf '%s' "$removed"
}

wait_for_database
DOCUMENSO_DB="$(documenso_database)"
stamp="$(new_stamp)" || die 4 "Couldn't choose a name for the backup in $DIR. Nothing was backed up."
name="booster-rocket-$stamp.dump"
final="$DIR/$name"
partial="$DIR/.$name.partial"
doc_name="documenso-$stamp.dump"
doc_final="$DIR/$doc_name"
doc_partial="$DIR/.$doc_name.partial"
trap 'rm -f "$partial" "$doc_partial"' EXIT

dump_and_check "the portal's database" "$partial" "${CONN[@]}" -d "$BR_DB_NAME"
if [ -n "$DOCUMENSO_DB" ]; then
  dump_and_check "Documenso's database" "$doc_partial" "${DOC_CONN[@]}" -d "$DOCUMENSO_DB"
fi
# Both were read back whole: only now do they take their names.
mv "$partial" "$final"
bytes="$(wc -c < "$final" | tr -d '[:space:]')"
doc_json="null"
if [ -n "$DOCUMENSO_DB" ]; then
  mv "$doc_partial" "$doc_final"
  doc_bytes="$(wc -c < "$doc_final" | tr -d '[:space:]')"
  # Both values are this script's own: a name it made and a count of bytes.
  doc_json="{\"file\": \"$doc_name\", \"bytes\": $doc_bytes}"
fi
trap - EXIT

removed="$(prune "$PORTAL_PATTERN" 'booster-rocket-*.dump')"
removed=$((removed + $(prune "$DOCUMENSO_PATTERN" 'documenso-*.dump')))

# Tell the portal, so its Health page can say when the last backup was taken and whether Documenso's database was in
# it. The backup is good without this.
recorded="$(pg_in psql "${CONN[@]}" -d "$BR_DB_NAME" -v ON_ERROR_STOP=1 -Atq -v "file=$name" -v "bytes=$bytes" -v "documenso=$doc_json" 2>/dev/null <<'SQL' || true
select to_regclass('public.setting') is not null as has_setting \gset
\if :has_setting
insert into setting (key, value)
  values ('backup.last_success', jsonb_build_object('at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'file', :'file', 'bytes', :bytes::bigint, 'documenso', :'documenso'::jsonb))
  on conflict (key) do update set value = excluded.value, updated_at = now();
\echo recorded
\else
\echo no-portal-tables
\endif
SQL
)"

say "Backup written: $final ($bytes bytes)."
if [ -n "$DOCUMENSO_DB" ]; then
  say "Documenso's database written: $doc_final ($doc_bytes bytes)."
elif [ -z "$BR_DOCUMENSO_DB_NAME" ]; then
  say "Documenso's database was left out, as BR_DOCUMENSO_DB_NAME is empty."
else
  say "This server has no database named $BR_DOCUMENSO_DB_NAME, so Documenso's database was not backed up. If the club's Documenso keeps its database elsewhere, back it up there."
fi
if [ "$removed" -gt 0 ]; then
  say "Keeping the newest $KEEP backups of each database in $DIR; removed $removed older."
else
  say "Keeping the newest $KEEP backups of each database in $DIR; none needed removing."
fi
case "$recorded" in
  *recorded*) ;;
  *no-portal-tables*) say "This database has no portal tables yet, so the portal's Health page was not told about this backup." ;;
  *) say "The backup is good, but the portal's Health page could not be told about it. It will show the backup before this one." ;;
esac
cat <<'EOT'

Keep three more things, or this backup can't bring everything back:
  1. The env file the portal runs with, kept somewhere safe and private. It holds SETTINGS_ENCRYPTION_KEY.
     Without that key the QuickBooks connection, the sign-in certificates and the mail password stored in this backup
     can't be read, and each would have to be set up again.
  2. Documenso's signing certificate (the .p12 file) and its passphrase, kept together, safe and private. Without
     them a restored Documenso can't finish signing a form.
  3. A copy of this folder somewhere other than this server. A backup that lives only on the machine it protects
     is lost with it.
To check that a backup can be restored, without touching the live databases:
  scripts/restore.sh <backup file> booster_restore_check
EOT
