#!/usr/bin/env bash
# Moves Booster Rocket's databases from Postgres 16 to Postgres 18, on a machine whose compose files already say 18.
#   scripts/move-postgres.sh deploy <folder>       a club's installation (deploy/compose.yml, deploy/.env)
#   scripts/move-postgres.sh poc <folder>          the proof of concept (docker-compose.poc.yml, .env.poc)
#   scripts/move-postgres.sh dev <folder>          a developer's database (docker-compose.yml)
#   ... --again              only when it says to: after going back to Postgres 16 and using it, brings the 16 data
#                            across again. It first backs up what Postgres 18 holds into <folder>, and stops there if
#                            Postgres 18 holds work done after the move.
#   ... --again --discard-18 only when it says to: the Postgres 16 data is the one the club keeps, and the work done on
#                            Postgres 18 after the move is set aside (it stays in the backup the move made of it)
#   ... --leave-others       only when it says to: the Postgres 16 server holds databases or roles the move doesn't
#                            carry, and they are left behind (they stay in the Postgres 16 data only)
#   scripts/move-postgres.sh <deploy|poc|dev> --stop
#                            stops and removes whatever a move left behind (its own containers and its copy of the
#                            old data), and changes nothing else
# Run it from anywhere in the checkout. <folder> is where the move's backups and row counts are written: a new folder
# of its own (docs/runbooks/updates.md names one). Keep it until the old data has been removed.
#
# What it does, in order, and it can be stopped at any point and run again:
#   1. stops the services that use the database, and refuses while anything else has the old data open for writing;
#   2. copies the Postgres 16 data into a volume of the move's own (the old volume is mounted read only to copy it),
#      starts Postgres 16 on that copy, read only, checks it holds nothing the move wouldn't carry, counts the rows of
#      every table, and backs up both databases with scripts/backup.sh, using Postgres 16's own tools (a backup
#      Postgres 16 made can be loaded into 16 or 18);
#   3. with --again: starts Postgres 18 on its own data, read only, and backs it up into <folder>/postgres-18-before-again
#      first; when Postgres 18 holds work done after the move, it stops here unless told --discard-18;
#   4. marks the move under way, so that until the end a normal start refuses (scripts/postgres-guard.sh);
#   5. starts Postgres 18 on its own new, empty volume, where it makes the roles and empty databases as on a first
#      installation, then loads each backup with scripts/restore.sh;
#   6. counts every table's rows again and compares them with step 2: any difference and the move stops, unfinished;
#   7. stops Postgres 18 and records the move as done. Then the services can start on Postgres 18 (for deploy, it first
#      makes the first backup with Postgres 18).
# The old data is never written to, deleted or set up again: the move only reads it, through a read-only mount, to
# copy it. Going back to the previous version starts Postgres 16 on it again, until a person removes the old volume by
# hand (the runbook says how and when).
#
# Exit codes: 0 moved, or nothing to move; 2 refused (nothing was changed); 3 Docker or a database couldn't be reached;
# 4 the move failed part way (the old data is untouched, a normal start is refused; run it again).
set -euo pipefail
export LC_ALL=C
# Git Bash on Windows (a developer's machine) rewrites arguments that look like paths before docker sees them, so a
# path inside a container would become a Windows one. Nothing else reads these.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
# Postgres 16, as deploy/compose.yml pinned it before the move. It reads data any 16.x left: minor versions share the
# storage format.
OLD_IMAGE="postgres:16.16@sha256:dd2bf3ce2dc83a81674cf7f217fcfd8a5009a4b325dda5b843bfee82a06cff6f"
WAIT="${BR_MOVE_WAIT:-300}"

say() { printf '%s\n' "$*"; }
indent() { local line; while IFS= read -r line; do printf '  %s\n' "$line"; done; }
die() { local code="$1"; shift; printf '\n%s\n' "$*" >&2; exit "$code"; }
usage() {
  die 2 "Usage: scripts/move-postgres.sh <deploy|poc|dev> <folder> [--again [--discard-18]] [--leave-others]
       scripts/move-postgres.sh <deploy|poc|dev> --stop
Moves the databases from Postgres 16 to Postgres 18. docs/runbooks/updates.md, \"Moving to a new major version of
Postgres\", says when and how."
}

SETUP="" FOLDER="" AGAIN="" DISCARD="" LEAVE_OTHERS="" STOP_ONLY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --again) AGAIN="--again"; shift ;;
    --discard-18) DISCARD="yes"; shift ;;
    --leave-others) LEAVE_OTHERS="yes"; shift ;;
    --stop) STOP_ONLY="yes"; shift ;;
    -*) usage ;;
    *) if [ -z "$SETUP" ]; then SETUP="$1"; elif [ -z "$FOLDER" ]; then FOLDER="$1"; else usage; fi; shift ;;
  esac
done
[ -n "$SETUP" ] || usage
if [ -n "$STOP_ONLY" ]; then
  if [ -n "$FOLDER" ] || [ -n "$AGAIN$DISCARD$LEAVE_OTHERS" ]; then usage; fi
else
  [ -n "$FOLDER" ] || usage
fi
if [ -n "$DISCARD" ] && [ -z "$AGAIN" ]; then die 2 "--discard-18 goes with --again: scripts/move-postgres.sh $SETUP <folder> --again --discard-18"; fi
[[ "$WAIT" =~ ^[0-9]{1,4}$ ]] || die 2 "BR_MOVE_WAIT must be a number of seconds."
command -v docker >/dev/null 2>&1 || die 3 "docker isn't available here. Nothing was changed."

# Each setup: where its compose file is read from, the services that use the database, and the name of the volume
# Postgres 16 kept its data in.
case "$SETUP" in
  deploy)
    cd "$REPO/deploy"
    if [ ! -f compose.yml ] || [ ! -f .env ]; then die 2 "deploy/compose.yml or deploy/.env is missing. Nothing was changed."; fi
    COMPOSE=(docker compose)
    USERS=(app worker documenso backup migrate db)
    OLD_KEY="db-data"
    ;;
  poc)
    cd "$REPO"
    if [ ! -f docker-compose.poc.yml ] || [ ! -f .env.poc ]; then die 2 "docker-compose.poc.yml or .env.poc is missing. Nothing was changed."; fi
    COMPOSE=(docker compose -f docker-compose.poc.yml --env-file .env.poc)
    USERS=(worker app db)
    OLD_KEY="pgdata"
    ;;
  dev)
    cd "$REPO"
    [ -f docker-compose.yml ] || die 2 "docker-compose.yml is missing. Nothing was changed."
    # The developer's file is at the top of every checkout, a club's and the proof of concept's too: there, it would
    # look at volumes that were never used and say there is nothing to move.
    if [ -f deploy/.env ]; then die 2 "This checkout has deploy/.env: it is a club's installation. Run: scripts/move-postgres.sh deploy <folder>. Nothing was changed."; fi
    if [ -f .env.poc ]; then die 2 "This checkout has .env.poc: it is the proof of concept. Run: scripts/move-postgres.sh poc <folder>. Nothing was changed."; fi
    COMPOSE=(docker compose -f docker-compose.yml)
    USERS=(db)
    OLD_KEY="pgdata"
    ;;
  *) usage ;;
esac

CONFIG="$("${COMPOSE[@]}" config 2>/dev/null || true)"
PROJECT="$(sed -n 's/^name: *//p' <<<"$CONFIG" | head -n 1)"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die 3 "docker compose couldn't read the compose file here (try: ${COMPOSE[*]} config). Nothing was changed."
# The old volume's name, as compose names it, read before anything runs: running the service would make it.
OLD_NAME="$(awk -v key="$OLD_KEY" '
  /^volumes:/ { v = 1; next }
  /^[^ ]/ { v = 0 }
  v && $0 == "  " key ":" { k = 1; next }
  v && /^  [^ ]/ { k = 0 }
  v && k && /^    name: / { print $2; exit }' <<<"$CONFIG")"
LABEL="booster-rocket.move=$PROJECT"
PROBE="$PROJECT-move-probe" COPIER="$PROJECT-move-copy" OLD_DB="$PROJECT-move-postgres-16"
KEEP_DB="$PROJECT-move-postgres-18-before" NEW_DB="$PROJECT-move-postgres-18"
COPY_VOLUME="$PROJECT-move-copy-16"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Our own one-off containers and the copy of the old data, by name. Postgres is stopped first, so it shuts down
# cleanly. None of them ever had the old volume open for writing.
remove_ours() {
  local c removed=""
  for c in "$PROBE" "$COPIER" "$OLD_DB" "$KEEP_DB" "$NEW_DB"; do
    if docker container inspect "$c" >/dev/null 2>&1; then
      docker stop -t 120 "$c" >/dev/null 2>&1 || true
      docker rm -f "$c" >/dev/null 2>&1 || true
      removed="$removed $c"
    fi
  done
  if docker volume inspect "$COPY_VOLUME" >/dev/null 2>&1; then
    docker volume rm -f "$COPY_VOLUME" >/dev/null 2>&1 || true
    removed="$removed $COPY_VOLUME"
  fi
  printf '%s' "$removed"
}

if [ -n "$STOP_ONLY" ]; then
  left="$(remove_ours)"
  if [ -n "$left" ]; then say "Stopped and removed what a move had left:$left. Nothing else was changed."
  else say "Nothing of a move was left here. Nothing was changed."; fi
  exit 0
fi

mkdir -p "$FOLDER" 2>/dev/null || die 2 "The folder $FOLDER can't be created. Nothing was changed."
FOLDER="$(cd "$FOLDER" && pwd)"
[ -w "$FOLDER" ] || die 2 "The folder $FOLDER can't be written to. Nothing was changed."
trap 'remove_ours >/dev/null' EXIT
trap 'exit 130' INT TERM HUP

# One line from the guard (scripts/postgres-guard.sh state), from a one-off container of the db service that mounts
# both volumes. It also gives the volumes' real names and the server's administrator.
OLD_VOLUME="" NEW_VOLUME="" ADMIN=""
probe() {
  docker rm -f "$PROBE" >/dev/null 2>&1 || true
  local line
  line="$("${COMPOSE[@]}" run --no-deps -T --name "$PROBE" --label "$LABEL" db state 2>/dev/null)" \
    || die 3 "The database service couldn't be run to look at the data (try: ${COMPOSE[*]} run --rm --no-deps db check). Nothing was changed."
  OLD_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/old-data"}}{{.Name}}{{end}}{{end}}' "$PROBE")"
  NEW_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}' "$PROBE")"
  ADMIN="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$PROBE" | sed -n 's/^POSTGRES_USER=//p' | head -n 1)"
  ADMIN="${ADMIN:-postgres}"
  docker rm -f "$PROBE" >/dev/null 2>&1 || true
  if [ -z "$OLD_VOLUME" ] || [ -z "$NEW_VOLUME" ] || [ "$OLD_VOLUME" = "$NEW_VOLUME" ]; then
    die 2 "The compose file here doesn't have the move's two volumes: check out the version that moves to Postgres 18 first (the runbook's first step). Nothing was changed."
  fi
  # The administrator's name goes into SQL below.
  [[ "$ADMIN" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die 3 "The database service's POSTGRES_USER isn't a plain name. Nothing was changed."
  STATE_OLD="$(sed -n 's/.*old=\([a-z]*\).*/\1/p' <<<"$line")"
  STATE_NEW="$(sed -n 's/.*new=\([a-z]*\).*/\1/p' <<<"$line")"
  STATE_SAME="$(sed -n 's/.*same=\([a-z-]*\).*/\1/p' <<<"$line")"
  FINGERPRINT="$(sed -n 's/.*fingerprint=\([0-9a-f-]*\).*/\1/p' <<<"$line")"
  NEW_DATA="$(sed -n 's/.*newdata=\([a-z]*\).*/\1/p' <<<"$line")"
  MOVED_AT="$(sed -n 's/.*moved=\([0-9TZ:-]*\).*/\1/p' <<<"$line")"
  if [ -z "$STATE_OLD" ] || [ -z "$STATE_NEW" ] || [ -z "$NEW_DATA" ]; then die 3 "The database service didn't say what data it holds (it said: $line). Nothing was changed."; fi
  [[ "$MOVED_AT" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z|-)$ ]] || MOVED_AT="-"
}

# Waits for a Postgres container to answer over TCP: during a first start's set-up it answers on its socket alone.
wait_ready() {
  local c="$1" db="$2" waited=0
  while ! docker exec "$c" pg_isready -q -h 127.0.0.1 -U "$ADMIN" -d "$db" >/dev/null 2>&1; do
    [ "$(docker inspect --format '{{.State.Running}}' "$c" 2>/dev/null || true)" = "true" ] \
      || { docker logs --tail 30 "$c" >&2 || true; die 4 "Postgres in $c stopped before it was ready (its last lines are above). The old data is untouched."; }
    [ "$waited" -lt "$WAIT" ] || die 4 "Postgres in $c didn't answer within ${WAIT}s. The old data is untouched; run the move again."
    sleep 2
    waited=$((waited + 2))
  done
}

# psql in a container: psql_in reads its SQL from stdin, psql_c takes it as an argument.
psql_in() { docker exec -i "$1" psql -U "$ADMIN" -d "$2" --no-password -v ON_ERROR_STOP=1 -Atq; }
psql_c() { docker exec "$1" psql -U "$ADMIN" -d "$2" --no-password -v ON_ERROR_STOP=1 -Atqc "$3" </dev/null; }

# Every table's exact row count, one "schema.table|count" line each, in name order.
count_rows() {
  psql_in "$1" "$2" <<'SQL'
select format('select %L || ''|'' || count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%'
 order by n.nspname, c.relname
\gexec
SQL
}

# The time of the portal's newest audit row, which every change in the portal writes: "absent" without the table,
# "empty" with no rows.
newest_record() {
  psql_in "$1" booster <<'SQL'
select to_regclass('public.audit_log') is not null as has_audit \gset
\if :has_audit
select coalesce(to_char(max(at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'empty') from audit_log;
\else
select 'absent';
\endif
SQL
}

has_database() {
  [ "$(psql_c "$1" postgres "select count(*) from pg_database where datname = '$2'")" = "1" ]
}

# Databases and roles on the old server that the move would not carry: it carries the portal's database and
# Documenso's, and a new installation makes their roles. A developer's test databases are thrown away on purpose.
left_behind() {
  local test_dbs=""
  [ "$SETUP" != "dev" ] || test_dbs="and datname !~ '_test\$'"
  psql_c "$1" postgres "select 'the database ' || datname from pg_database
     where not datistemplate and datname not in ('postgres', 'booster', 'documenso') $test_dbs
   union all
   select 'the role ' || rolname from pg_roles
     where rolname !~ '^pg_' and rolname not in ('$ADMIN', 'booster', 'documenso')
   order by 1"
}

stop_clean() {
  local c="$1"
  docker stop -t 120 "$c" >/dev/null || die 4 "Postgres in $c couldn't be stopped. The old data is untouched; run the move again."
  [ "$(docker inspect --format '{{.State.ExitCode}}' "$c")" = "0" ] \
    || { docker logs --tail 30 "$c" >&2 || true; die 4 "Postgres in $c didn't stop cleanly (its last lines are above). The old data is untouched; run the move again."; }
  docker rm "$c" >/dev/null
}

# Containers other than the move's own that have the old volume open for writing: the previous version's database,
# started from another window or another checkout. Two servers on one data folder damage it.
writers_of_old() {
  local id name
  for id in $(docker ps -q --filter "volume=$OLD_VOLUME"); do
    name="$(docker inspect --format '{{.Name}}' "$id")"
    name="${name#/}"
    if [ "$(docker inspect --format "{{range .Mounts}}{{if eq .Name \"$OLD_VOLUME\"}}{{.RW}}{{end}}{{end}}" "$id")" = "true" ]; then
      printf ' %s' "$name"
    fi
  done
}

# Backs a running Postgres up with scripts/backup.sh into a folder; sets DUMPS to the files it wrote.
DUMPS=()
backup_from() {
  local c="$1" into="$2" with_documenso="$3" out portal documenso
  out="$(BR_DB_CONTAINER="$c" BR_DB_USER="$ADMIN" BR_DOCUMENSO_DB_USER="$ADMIN" BR_DB_NAME=booster \
    BR_DOCUMENSO_DB_NAME="$with_documenso" "$HERE/backup.sh" "$into" --keep 9999)" || return 1
  portal="$(sed -n 's/^Backup written: \(.*\) ([0-9]* bytes)\.$/\1/p' <<<"$out")"
  documenso="$(sed -n "s/^Documenso's database written: \(.*\) ([0-9]* bytes)\.$/\1/p" <<<"$out")"
  [ -s "$portal" ] || return 1
  if [ -n "$with_documenso" ] && [ ! -s "$documenso" ]; then return 1; fi
  DUMPS=("$portal")
  [ -z "$documenso" ] || DUMPS+=("$documenso")
}

# A move cut off by force may have left its own containers: stopped first, cleanly. Then a look, which changes
# nothing and leaves the services running when there is nothing to do.
remove_ours >/dev/null
if [ -n "$OLD_NAME" ] && ! docker volume inspect "$OLD_NAME" >/dev/null 2>&1; then
  say "There is no volume named $OLD_NAME here, where Postgres 16 kept its data, so there is nothing to move. Nothing was changed."
  exit 0
fi
probe
FIRST_FINGERPRINT="$FINGERPRINT"
case "$STATE_OLD/$STATE_NEW" in
  no/moved|no/other) say "This installation already runs on Postgres 18, and the volume $OLD_VOLUME holds no Postgres 16 data to move. Nothing was changed."; exit 0 ;;
  no/empty) say "The volume $OLD_VOLUME holds no Postgres 16 data, so there is nothing to move: a new installation simply starts. Nothing was changed."; exit 0 ;;
  no/moving) die 4 "A move was started, but the Postgres 16 data is no longer in the volume $OLD_VOLUME. A normal start stays refused. The move's backups are in $FOLDER: docs/runbooks/restore.md says how to load them." ;;
  yes/moved)
    if [ "$STATE_SAME" = "yes" ]; then
      say "The data was already moved to Postgres 18, from the Postgres 16 data as it is now. Nothing was changed."
      exit 0
    fi
    [ -n "$AGAIN" ] || die 2 "The data was moved to Postgres 18 before, and Postgres 16 has been started on the old data since (the
previous version was run again). Nothing was changed. Postgres 18 holds the data as it was moved, with anything done
on it before going back; the Postgres 16 data holds what was done since going back. To bring the Postgres 16 data
across again, run this again with --again at the end: it first backs up what Postgres 18 holds, and stops there if
Postgres 18 holds work done after the move, to let you choose." ;;
  yes/other)
    [ -n "$AGAIN" ] || die 2 "There is Postgres 18 data here that the move didn't make, as well as the Postgres 16 data. Nothing was
changed. To bring the Postgres 16 data across, run this again with --again at the end: it first backs up what Postgres
18 holds, then says what it would set aside." ;;
  yes/empty|yes/moving) ;;
  *) die 3 "The database service gave an answer this script doesn't know (old=$STATE_OLD new=$STATE_NEW). Nothing was changed." ;;
esac
[ "$STATE_NEW" != "moving" ] || say "A move was started before and didn't finish: starting again from the Postgres 16 data."
if [ -z "$FIRST_FINGERPRINT" ] || [ "$FIRST_FINGERPRINT" = "-" ]; then die 3 "The Postgres 16 data's control file couldn't be read. Nothing was changed."; fi

# 1. Nothing may use the database while it moves.
say "Stopping what uses the database: ${USERS[*]}."
"${COMPOSE[@]}" stop "${USERS[@]}" >/dev/null 2>&1 || die 3 "The services couldn't be stopped (try: ${COMPOSE[*]} stop). Nothing was changed."
writers="$(writers_of_old)"
[ -z "$writers" ] || die 2 "Another Postgres is running on the Postgres 16 data:$writers. It may be the previous version of Booster
Rocket, started from another window or another folder. Nothing was changed. Stop it first (docker stop$writers),
then run this again. Never go back to the previous version while a move is running."

# 2. A copy of the old data, made through a read-only mount; Postgres 16 runs on the copy, read only, with no network.
say "Copying the Postgres 16 data (volume $OLD_VOLUME, read only) into $COPY_VOLUME."
docker image inspect "$OLD_IMAGE" >/dev/null 2>&1 || docker pull -q "$OLD_IMAGE" >/dev/null \
  || die 3 "The Postgres 16 image couldn't be downloaded. Nothing was changed."
docker volume create --label "$LABEL" "$COPY_VOLUME" >/dev/null || die 3 "A volume for the copy couldn't be made. Nothing was changed."
docker run --rm --name "$COPIER" --label "$LABEL" --network none -v "$OLD_VOLUME:/old:ro" -v "$COPY_VOLUME:/copy" \
  --entrypoint bash "$OLD_IMAGE" -c 'cp -a /old/. /copy/' >/dev/null \
  || die 4 "The Postgres 16 data couldn't be copied (is the disk full? docs/runbooks/updates.md, \"Before the move\"). The old data is untouched."
probe
[ "$FINGERPRINT" = "$FIRST_FINGERPRINT" ] || die 4 "The Postgres 16 data changed while it was being copied: something started Postgres 16 on it (the
previous version, from another window?). The old data was not written to by the move. Stop that, then run this again."
say "Starting Postgres 16 on the copy, read only."
docker run -d --name "$OLD_DB" --label "$LABEL" --network none -v "$COPY_VOLUME:/var/lib/postgresql/data" "$OLD_IMAGE" \
  postgres -c default_transaction_read_only=on >/dev/null \
  || die 3 "Postgres 16 couldn't be started on the copy of the old data. Nothing was changed."
wait_ready "$OLD_DB" postgres
has_database "$OLD_DB" booster || die 4 "The Postgres 16 data has no database named booster. The old data is untouched."
others="$(left_behind "$OLD_DB")" || die 4 "The Postgres 16 server's databases and roles couldn't be listed. The old data is untouched."
if [ -n "$others" ]; then
  if [ -z "$LEAVE_OTHERS" ]; then
    die 2 "The Postgres 16 server also holds what the move doesn't carry (it carries the portal's database and Documenso's):
$(indent <<<"$others")
Nothing was changed. These would stay in the Postgres 16 data only, and be gone once it is removed. If they are no
longer needed (a booster_restore_check left by a restore check is one), run this again with --leave-others at the end.
If one is needed, back it up first: docs/runbooks/updates.md, \"Before the move\"."
  fi
  say "Leaving behind, in the Postgres 16 data only:"
  indent <<<"$others"
fi
DATABASES=(booster)
if has_database "$OLD_DB" documenso; then DATABASES+=(documenso); fi
for db in "${DATABASES[@]}"; do
  count_rows "$OLD_DB" "$db" > "$FOLDER/move-$STAMP-rows-postgres-16-$db.txt" \
    || die 4 "The rows of $db couldn't be counted. The old data is untouched."
done
NEWEST_16="$(newest_record "$OLD_DB")" || NEWEST_16="absent"

say "Backing up with Postgres 16's own tools into $FOLDER."
backup_from "$OLD_DB" "$FOLDER" "$([ "${#DATABASES[@]}" -gt 1 ] && echo documenso || true)" \
  || die 4 "The backup failed, so nothing was moved. The old data is untouched."
PORTAL_DUMP="${DUMPS[0]}" DOCUMENSO_DUMP="${DUMPS[1]:-}"
for f in "${DUMPS[@]}"; do say "  $f"; done
stop_clean "$OLD_DB"

# 3. With --again: what Postgres 18 holds now is backed up before anything replaces it, and kept from being replaced
# unawares when it holds work done after the move.
if [ -n "$AGAIN" ] && { [ "$STATE_NEW" = "moved" ] || [ "$STATE_NEW" = "other" ]; }; then
  KEPT_DIR="$FOLDER/postgres-18-before-again"
  if [ "$NEW_DATA" = "yes" ]; then
    say "Backing up what Postgres 18 holds now, before anything replaces it, into $KEPT_DIR."
    "${COMPOSE[@]}" run -d --no-deps --name "$KEEP_DB" --label "$LABEL" db look postgres >/dev/null \
      || die 4 "Postgres 18 couldn't be started on its own data to back it up, so nothing was replaced. The old data is untouched."
    wait_ready "$KEEP_DB" booster
    keep_documenso=""
    if has_database "$KEEP_DB" documenso; then keep_documenso="documenso"; fi
    backup_from "$KEEP_DB" "$KEPT_DIR" "$keep_documenso" \
      || die 4 "The backup of what Postgres 18 holds failed, so nothing was replaced. The old data is untouched, and so
is the Postgres 18 data. Put right what the lines above say (room on the disk, the folder $KEPT_DIR), then run this
again."
    KEPT=("${DUMPS[@]}")
    NEWEST_18="$(newest_record "$KEEP_DB")" || NEWEST_18="absent"
    stop_clean "$KEEP_DB"
    for f in "${KEPT[@]}"; do say "  $f"; done
  else
    KEPT=()
    NEWEST_18="absent"
  fi
  # Work done on 18 after the move: any audit row from the move's time on, or nothing to tell by.
  worked=""
  if [ "$STATE_NEW" = "other" ] || [ "$NEWEST_18" = "absent" ] || [ "$MOVED_AT" = "-" ]; then worked="yes"
  # Both times are YYYY-MM-DDTHH:MM:SSZ, so their digits compare as numbers.
  elif [ "$NEWEST_18" != "empty" ] && [ "${NEWEST_18//[!0-9]/}" -ge "${MOVED_AT//[!0-9]/}" ]; then worked="yes"; fi
  if [ -n "$worked" ] && [ -z "$DISCARD" ]; then
    if [ "${#KEPT[@]}" -gt 0 ]; then kept_words="A backup of what Postgres 18 holds now was written first (only Postgres 18 can load it):
$(printf '  %s\n' "${KEPT[@]}")"
    else kept_words="The Postgres 18 data folder holds files but no database that can be started, so there was nothing to back up."; fi
    die 2 "Postgres 18 may hold work done after the move, which the Postgres 16 data doesn't have.
  The move to Postgres 18 was made at:       $MOVED_AT
  Postgres 18's newest record in the portal: $NEWEST_18
  Postgres 16's newest record in the portal: $NEWEST_16
$kept_words
Nothing else was changed. Choose which copy the club keeps (docs/runbooks/updates.md, \"Going back to Postgres 16\"):
  - the Postgres 16 data: run this again with --again --discard-18 at the end. The work done on Postgres 18 is then
    kept only in the backup above.
  - the Postgres 18 data: that section says how to load the backup above after the move."
  fi
  if [ -n "$worked" ]; then say "Setting aside the work done on Postgres 18 after the move, as --discard-18 says: it is kept in the backup above."; fi
fi

# 4. The move is marked under way: from here until it is recorded as done, a normal start refuses.
"${COMPOSE[@]}" run --rm --no-deps -T db begin $AGAIN >/dev/null \
  || die 4 "The move couldn't be marked under way in the volume $NEW_VOLUME. The old data is untouched."

# 5. Postgres 18 on its own volume: its first start makes the roles and empty databases, as a first installation does.
say "Starting Postgres 18 on its own volume ($NEW_VOLUME) and loading the backup."
"${COMPOSE[@]}" run -d --no-deps --name "$NEW_DB" --label "$LABEL" db moving postgres >/dev/null \
  || die 4 "Postgres 18 couldn't be started. The old data is untouched; run the move again."
wait_ready "$NEW_DB" booster
BR_DB_CONTAINER="$NEW_DB" BR_DB_USER="$ADMIN" "$HERE/restore.sh" "$PORTAL_DUMP" booster >/dev/null \
  || die 4 "The portal's backup didn't load into Postgres 18. The old data is untouched; run the move again."
if [ -n "$DOCUMENSO_DUMP" ]; then
  BR_DB_CONTAINER="$NEW_DB" BR_DB_USER="$ADMIN" "$HERE/restore.sh" "$DOCUMENSO_DUMP" documenso >/dev/null \
    || die 4 "Documenso's backup didn't load into Postgres 18. The old data is untouched; run the move again."
fi

# 6. Every table, both databases, the same number of rows.
for db in "${DATABASES[@]}"; do
  before="$FOLDER/move-$STAMP-rows-postgres-16-$db.txt"
  after="$FOLDER/move-$STAMP-rows-postgres-18-$db.txt"
  count_rows "$NEW_DB" "$db" > "$after" || die 4 "The rows of $db couldn't be counted in Postgres 18. The old data is untouched; run the move again."
  if ! diff -u "$before" "$after" >&2; then
    die 4 "The database $db doesn't hold the same rows in Postgres 18 as in Postgres 16 (the differences are above). The move
was stopped unfinished: a normal start stays refused, and the old data is untouched. Run it again, or go back."
  fi
  say "  $db: $(wc -l < "$after" | tr -d ' ') tables, every one with the same number of rows as before."
done

# 7. Done: only now may Postgres 18 start normally. The guard records it only if the old data is still exactly as it
# was when it was copied.
stop_clean "$NEW_DB"
"${COMPOSE[@]}" run --rm --no-deps -T db finish "$FIRST_FINGERPRINT" >/dev/null \
  || die 4 "The move couldn't be recorded as done (did something start Postgres 16 on the old data while it ran?). A normal
start stays refused; the old data was not written to by the move. Run the move again."
say "The move is done: Postgres 18 holds the data. The Postgres 16 data is still in the volume $OLD_VOLUME, untouched."

case "$SETUP" in
  deploy)
    say "Making the first backup with Postgres 18 (the nightly backups go on from here)."
    "${COMPOSE[@]}" run --rm backup --now >/dev/null \
      || say "That backup failed: start the portal anyway, then run: docker compose run --rm backup --now"
    say ""
    say "Now start the portal as you always do, from $REPO/deploy:"
    say "  docker compose up -d            (with --profile proxy if this installation's proxy is used)"
    ;;
  poc)
    say ""
    say "Now deploy, which builds, backs up with Postgres 18, migrates and starts the portal:"
    say "  scripts/poc/deploy.sh           (docs/runbooks/poc-linuxdev.md, \"Moving the database to Postgres 18\", step 5)"
    ;;
  dev)
    say ""
    say "Now start the database: ${COMPOSE[*]} up -d"
    ;;
esac
say "Keep the folder and the old volume: while they are there, going back to the previous version still works. The
runbook says when and how to remove them."
