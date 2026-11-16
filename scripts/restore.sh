#!/usr/bin/env bash
# Loads one Booster Rocket backup (made by scripts/backup.sh) into a database: the portal's (booster-rocket-*.dump) or
# Documenso's (documenso-*.dump).
#   scripts/restore.sh <backup file> <database>                  refuses if <database> already holds tables
#   scripts/restore.sh <backup file> <database> --replace        replaces everything in <database> with the backup
#   scripts/restore.sh <backup file> <database> --owner <role>   the restored database and everything in it belong to
#                                                                <role> (the portal's or Documenso's own database role)
# Without --owner, a database that is replaced keeps the owner it had, and a new one belongs to the user restoring it.
# The backup is first loaded into a database of its own beside the one you name. Only when all of it has loaded does
# it take that name, so a restore that fails leaves the database you named exactly as it was.
# Stop the portal (or Documenso) before replacing the database it is using: a database that is in use is refused.
#
# A database is not all there is to bring back. The portal needs the env file it had when the backup was taken (its
# SETTINGS_ENCRYPTION_KEY), and Documenso its signing certificate (the .p12 file) and passphrase: keep them somewhere
# safe with the backups.
#
# How it reaches the database server (the same settings as scripts/backup.sh):
#   BR_DB_CONTAINER  the Postgres container to run the tools in (default booster-rocket-db-1). Set it to an empty value
#                    to use the tools on this machine, with PGHOST, PGPORT, PGUSER and PGPASSWORD (or ~/.pgpass).
#   BR_DB_USER       the database user inside the container (default booster)
# No password is ever put on a command line or printed.
#
# Exit codes: 0 ok, 2 refused (bad arguments, not a backup, the database holds tables, or it is in use),
# 3 the database server can't be reached, 4 the restore failed (the database you named was left as it was).
set -euo pipefail
export LC_ALL=C

BR_DB_CONTAINER="${BR_DB_CONTAINER-booster-rocket-db-1}"
BR_DB_USER="${BR_DB_USER:-booster}"

say() { printf '%s\n' "$*"; }
die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }
usage() {
  die 2 "Usage: scripts/restore.sh <backup file> <database> [--replace] [--owner <role>]
Loads a backup of the portal's database or of Documenso's. The portal also needs the env file it had when the backup
was taken, and Documenso its signing certificate (the .p12 file) with its passphrase: keep them somewhere safe with
the backups."
}

FILE="" DB="" REPLACE="" OWNER=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --replace) REPLACE="yes"; shift ;;
    --owner) [ "$#" -ge 2 ] || usage; OWNER="$2"; [ -n "$OWNER" ] || usage; shift 2 ;;
    --owner=*) OWNER="${1#--owner=}"; [ -n "$OWNER" ] || usage; shift ;;
    -*) usage ;;
    *) if [ -z "$FILE" ]; then FILE="$1"; elif [ -z "$DB" ]; then DB="$1"; else usage; fi; shift ;;
  esac
done
[ -n "$FILE" ] && [ -n "$DB" ] || usage
[ -f "$FILE" ] && [ -r "$FILE" ] || die 2 "The backup file $FILE can't be read."
[ -s "$FILE" ] || die 2 "The backup file $FILE is empty."
# The names go into SQL below, so they are held to plain lower-case letters, digits and underscores. The database's is
# short enough to leave room for the name of the database the backup is loaded into first.
[[ "$DB" =~ ^[a-z][a-z0-9_]{0,49}$ ]] || die 2 "The database name must be lower-case letters, digits and underscores, start with a letter, and be at most 50 long."
case "$DB" in postgres|template0|template1) die 2 "$DB is one of Postgres's own databases. Choose another name." ;; esac
[ -z "$OWNER" ] || [[ "$OWNER" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die 2 "The owner must be a database role's name: lower-case letters, digits and underscores."
STAGING="${DB}_restoring"

if [ -n "$BR_DB_CONTAINER" ]; then
  command -v docker >/dev/null 2>&1 || die 3 "docker isn't available here, so the database container $BR_DB_CONTAINER can't be reached."
  [ "$(docker inspect --format '{{.State.Running}}' "$BR_DB_CONTAINER" 2>/dev/null || true)" = "true" ] \
    || die 3 "The database container $BR_DB_CONTAINER isn't running. Nothing was changed."
  CONN=(-U "$BR_DB_USER" --no-password)
  pg() { docker exec "$BR_DB_CONTAINER" "$@"; }
  pg_in() { docker exec -i "$BR_DB_CONTAINER" "$@"; }
else
  command -v pg_restore >/dev/null 2>&1 || die 3 "pg_restore isn't installed on this machine. Install the PostgreSQL client tools, or set BR_DB_CONTAINER to the database's container."
  CONN=(--no-password)
  pg() { "$@" </dev/null; }
  pg_in() { "$@"; }
fi

# One answer from the server, asked through its own "postgres" database.
ask() { pg psql "${CONN[@]}" -d postgres -v ON_ERROR_STOP=1 -Atqc "$1"; }
# Notices ("does not exist, skipping") are kept off the screen; errors are not.
run() { pg psql "${CONN[@]}" -d postgres -v ON_ERROR_STOP=1 -q -c 'set client_min_messages = warning' -c "$1" >/dev/null; }

ask 'select 1' >/dev/null 2>&1 || die 3 "The database server didn't answer. Nothing was changed."
pg_in pg_restore --list < "$FILE" >/dev/null 2>&1 || die 2 "$FILE isn't a backup made by scripts/backup.sh, or it is damaged. Nothing was changed."
if [ -n "$OWNER" ] && [ "$(ask "select count(*) from pg_roles where rolname = '$OWNER'")" != "1" ]; then
  die 2 "There is no database role named $OWNER on this server. Nothing was changed."
fi

exists="$(ask "select count(*) from pg_database where datname = '$DB'")"
tables=0
if [ "$exists" != "0" ]; then
  tables="$(pg psql "${CONN[@]}" -d "$DB" -v ON_ERROR_STOP=1 -Atqc "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")" \
    || die 3 "The database $DB couldn't be looked at. Nothing was changed."
  if [ "$tables" != "0" ] && [ -z "$REPLACE" ]; then
    die 2 "The database $DB already holds $tables tables. Nothing was changed. To replace everything in it with this backup, run the same command again with --replace at the end."
  fi
  in_use="$(ask "select count(*) from pg_stat_activity where datname = '$DB' and pid <> pg_backend_pid()")"
  if [ "$in_use" != "0" ]; then
    die 2 "The database $DB is in use ($in_use connections). Stop the portal first (its app and worker), or Documenso if it is Documenso's, then run this again. Nothing was changed."
  fi
  # A database that is replaced keeps its owner unless told otherwise, so the portal (or Documenso) can still use it.
  [ -n "$OWNER" ] || OWNER="$(ask "select pg_get_userbyid(datdba) from pg_database where datname = '$DB'")"
fi

# Load into a database of its own. One left behind by a restore that was interrupted is cleared first. With an owner,
# the database is theirs and everything in it is made as them (pg_restore --role), as it would be by their own hand.
owned_by="" as_role=()
if [ -n "$OWNER" ]; then owned_by=" owner \"$OWNER\""; as_role=(--role="$OWNER"); fi
run "drop database if exists \"$STAGING\"" || die 4 "Couldn't clear $STAGING, left by an earlier restore. Nothing was changed."
run "create database \"$STAGING\"$owned_by" || die 4 "Couldn't create a database to load the backup into. Nothing was changed."
if ! pg_in pg_restore "${CONN[@]}" -d "$STAGING" --no-owner --no-acl "${as_role[@]}" --exit-on-error --single-transaction < "$FILE"; then
  run "drop database if exists \"$STAGING\"" || true
  if [ "$exists" != "0" ]; then die 4 "The backup didn't load. The database $DB was left as it was."; fi
  die 4 "The backup didn't load. Nothing was created."
fi
loaded="$(pg psql "${CONN[@]}" -d "$STAGING" -v ON_ERROR_STOP=1 -Atqc "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")"

# All of it loaded: now it takes the name.
if [ "$exists" != "0" ]; then
  if ! run "drop database \"$DB\""; then
    run "drop database if exists \"$STAGING\"" || true
    die 4 "The database $DB couldn't be replaced; something connected to it. It was left as it was. Stop the portal and run this again."
  fi
fi
run "alter database \"$STAGING\" rename to \"$DB\"" \
  || die 4 "The backup loaded, but couldn't be given the name $DB. It is in the database $STAGING; nothing in it is lost."

owned=""
[ -z "$OWNER" ] || owned=", owned by $OWNER"
if [ "$exists" != "0" ] && [ "$tables" != "0" ]; then
  say "Restored $FILE into the database $DB ($loaded tables$owned), replacing what was there."
else
  say "Restored $FILE into the database $DB ($loaded tables$owned)."
fi
cat <<'EOT'

What to do next, if the portal or Documenso is to run on this database (docs/runbooks/restore.md):
  1. A portal database: give the portal the env file that was kept with the backup. SETTINGS_ENCRYPTION_KEY must be
     the one the portal had when the backup was taken, or the QuickBooks connection, the sign-in certificates and the
     mail password in it can't be read.
  2. A Documenso database: give Documenso the signing certificate (the .p12 file) and its passphrase that were kept
     with the backups. Documenso brings an older database up to its own version when it starts.
  3. Start the portal the way you normally update it. That also brings an older backup's database up to the version
     that is running.
  4. Sign in as an Admin and open Health. Each line says when that part last worked. After a restore, look at
     QuickBooks, outgoing mail and Forms first: a wrong key or certificate shows there.
EOT
