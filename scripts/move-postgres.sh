#!/usr/bin/env bash
# Moves Booster Rocket's databases from Postgres 16 to Postgres 18, on a machine whose compose files already say 18.
#   scripts/move-postgres.sh deploy <folder>           a club's installation (deploy/compose.yml, deploy/.env)
#   scripts/move-postgres.sh poc <folder>              the proof of concept (docker-compose.poc.yml, .env.poc)
#   scripts/move-postgres.sh dev <folder>              a developer's database (docker-compose.yml)
#   ... --again                                        only when it says to: after going back to Postgres 16 and using
#                                                      it, brings the 16 data across again, replacing the 18 data
# Run it from anywhere in the checkout. <folder> is where the move's backups and row counts are written: a new folder
# of its own (docs/runbooks/updates.md names one). Keep it until the old data has been removed.
#
# What it does, in order, and it can be stopped at any point and run again:
#   1. stops the services that use the database;
#   2. starts Postgres 16 on the old data, counts the rows of every table, and backs up both databases with
#      scripts/backup.sh, using Postgres 16's own tools (a backup Postgres 16 made can be loaded into 16 or 18);
#   3. stops Postgres 16 and marks the move under way, so that until the end a normal start refuses
#      (scripts/postgres-guard.sh);
#   4. starts Postgres 18 on its own new, empty volume, where it makes the roles and empty databases as on a first
#      installation, then loads each backup with scripts/restore.sh;
#   5. counts every table's rows again and compares them with step 2: any difference and the move stops, unfinished;
#   6. stops Postgres 18 and records the move as done. Then the services can start on Postgres 18 (for deploy, it first
#      makes the first backup with Postgres 18).
# The old data is never deleted, overwritten or set up again: Postgres 16 runs on it in step 2 exactly as it ran
# before, and nothing else writes to it. Going back to the previous version starts Postgres 16 on it again, until a
# person removes the old volume by hand (the runbook says how and when).
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
die() { local code="$1"; shift; printf '\n%s\n' "$*" >&2; exit "$code"; }
usage() {
  die 2 "Usage: scripts/move-postgres.sh <deploy|poc|dev> <folder> [--again]
Moves the databases from Postgres 16 to Postgres 18. docs/runbooks/updates.md, \"Moving to a new major version of
Postgres\", says when and how."
}

SETUP="" FOLDER="" AGAIN=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --again) AGAIN="--again"; shift ;;
    -*) usage ;;
    *) if [ -z "$SETUP" ]; then SETUP="$1"; elif [ -z "$FOLDER" ]; then FOLDER="$1"; else usage; fi; shift ;;
  esac
done
if [ -z "$SETUP" ] || [ -z "$FOLDER" ]; then usage; fi
[[ "$WAIT" =~ ^[0-9]{1,4}$ ]] || die 2 "BR_MOVE_WAIT must be a number of seconds."
command -v docker >/dev/null 2>&1 || die 3 "docker isn't available here. Nothing was changed."

mkdir -p "$FOLDER" 2>/dev/null || die 2 "The folder $FOLDER can't be created. Nothing was changed."
FOLDER="$(cd "$FOLDER" && pwd)"
[ -w "$FOLDER" ] || die 2 "The folder $FOLDER can't be written to. Nothing was changed."

# Each setup: where its compose file is read from, the services that use the database, and how it is started after.
case "$SETUP" in
  deploy)
    cd "$REPO/deploy"
    if [ ! -f compose.yml ] || [ ! -f .env ]; then die 2 "deploy/compose.yml or deploy/.env is missing. Nothing was changed."; fi
    COMPOSE=(docker compose)
    USERS=(app worker documenso backup migrate db)
    ;;
  poc)
    cd "$REPO"
    if [ ! -f docker-compose.poc.yml ] || [ ! -f .env.poc ]; then die 2 "docker-compose.poc.yml or .env.poc is missing. Nothing was changed."; fi
    COMPOSE=(docker compose -f docker-compose.poc.yml --env-file .env.poc)
    USERS=(worker app db)
    ;;
  dev)
    cd "$REPO"
    [ -f docker-compose.yml ] || die 2 "docker-compose.yml is missing. Nothing was changed."
    COMPOSE=(docker compose -f docker-compose.yml)
    USERS=(db)
    ;;
  *) usage ;;
esac

PROJECT="$("${COMPOSE[@]}" config 2>/dev/null | sed -n 's/^name: *//p' | head -n 1)"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die 3 "docker compose couldn't read the compose file here (try: ${COMPOSE[*]} config). Nothing was changed."
PROBE="$PROJECT-move-probe" OLD_DB="$PROJECT-move-postgres-16" NEW_DB="$PROJECT-move-postgres-18"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Our own one-off containers only, by name. Postgres is stopped first, so it shuts down cleanly.
remove_ours() {
  local c
  for c in "$PROBE" "$OLD_DB" "$NEW_DB"; do
    if docker container inspect "$c" >/dev/null 2>&1; then
      docker stop -t 120 "$c" >/dev/null 2>&1 || true
      docker rm -f "$c" >/dev/null 2>&1 || true
    fi
  done
}
trap 'remove_ours' EXIT
trap 'exit 130' INT TERM HUP

# One line from the guard (scripts/postgres-guard.sh state), from a one-off container of the db service that mounts
# both volumes. It also gives the volumes' real names and the server's administrator.
OLD_VOLUME="" NEW_VOLUME="" ADMIN=""
probe() {
  docker rm -f "$PROBE" >/dev/null 2>&1 || true
  local line
  line="$("${COMPOSE[@]}" run --no-deps -T --name "$PROBE" db state 2>/dev/null)" \
    || die 3 "The database service couldn't be run to look at the data (try: ${COMPOSE[*]} run --rm --no-deps db check). Nothing was changed."
  OLD_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/old-data"}}{{.Name}}{{end}}{{end}}' "$PROBE")"
  NEW_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}' "$PROBE")"
  ADMIN="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$PROBE" | sed -n 's/^POSTGRES_USER=//p' | head -n 1)"
  ADMIN="${ADMIN:-postgres}"
  docker rm -f "$PROBE" >/dev/null 2>&1 || true
  if [ -z "$OLD_VOLUME" ] || [ -z "$NEW_VOLUME" ] || [ "$OLD_VOLUME" = "$NEW_VOLUME" ]; then
    die 2 "The compose file here doesn't have the move's two volumes: check out the version that moves to Postgres 18 first (the runbook's first step). Nothing was changed."
  fi
  STATE_OLD="$(sed -n 's/.*old=\([a-z]*\).*/\1/p' <<<"$line")"
  STATE_NEW="$(sed -n 's/.*new=\([a-z]*\).*/\1/p' <<<"$line")"
  STATE_SAME="$(sed -n 's/.*same=\([a-z-]*\).*/\1/p' <<<"$line")"
  FINGERPRINT="$(sed -n 's/.*fingerprint=\([0-9a-f-]*\).*/\1/p' <<<"$line")"
  if [ -z "$STATE_OLD" ] || [ -z "$STATE_NEW" ]; then die 3 "The database service didn't say what data it holds (it said: $line). Nothing was changed."; fi
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

# Every table's exact row count, one "schema.table|count" line each, in name order.
count_rows() {
  local c="$1" db="$2"
  docker exec -i "$c" psql -U "$ADMIN" -d "$db" --no-password -v ON_ERROR_STOP=1 -Atq <<'SQL'
select format('select %L || ''|'' || count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_toast%'
 order by n.nspname, c.relname
\gexec
SQL
}

has_database() {
  [ "$(docker exec "$1" psql -U "$ADMIN" -d postgres --no-password -Atqc "select count(*) from pg_database where datname = '$2'")" = "1" ]
}

stop_clean() {
  local c="$1"
  docker stop -t 120 "$c" >/dev/null || die 4 "Postgres in $c couldn't be stopped. The old data is untouched; run the move again."
  [ "$(docker inspect --format '{{.State.ExitCode}}' "$c")" = "0" ] \
    || { docker logs --tail 30 "$c" >&2 || true; die 4 "Postgres in $c didn't stop cleanly (its last lines are above). The old data is untouched; run the move again."; }
  docker rm "$c" >/dev/null
}

# A move cut off by force may have left its own Postgres running: stopped first, cleanly. Then a look, which changes
# nothing and leaves the services running when there is nothing to do.
remove_ours
probe
case "$STATE_OLD/$STATE_NEW" in
  no/moved|no/other) say "This installation already runs on Postgres 18, and there is no Postgres 16 data to move. Nothing was changed."; exit 0 ;;
  no/empty) say "There is no Postgres 16 data here, so there is nothing to move: a new installation simply starts. Nothing was changed."; exit 0 ;;
  no/moving) die 4 "A move was started, but the Postgres 16 data is no longer in the volume $OLD_VOLUME. A normal start stays refused. The move's backups are in $FOLDER: docs/runbooks/restore.md says how to load them." ;;
  yes/moved)
    if [ "$STATE_SAME" = "yes" ]; then
      say "The data was already moved to Postgres 18, from the Postgres 16 data as it is now. Nothing was changed."
      exit 0
    fi
    [ -n "$AGAIN" ] || die 2 "The data was moved to Postgres 18 before, and Postgres 16 has been started on the old data since (the
previous version was run again). Nothing was changed. If the Postgres 16 data is the one to keep, run this again with
--again at the end: it moves the 16 data across again and replaces what is in Postgres 18." ;;
  yes/other)
    [ -n "$AGAIN" ] || die 2 "There is Postgres 18 data here that the move didn't make, as well as the Postgres 16 data. Nothing was
changed. If the Postgres 16 data is the one to keep, run this again with --again at the end: it replaces the Postgres 18 data." ;;
  yes/empty|yes/moving) ;;
  *) die 3 "The database service gave an answer this script doesn't know (old=$STATE_OLD new=$STATE_NEW). Nothing was changed." ;;
esac
[ "$STATE_NEW" != "moving" ] || say "A move was started before and didn't finish: starting again from the Postgres 16 data."

# 1. Nothing may use the database while it moves.
say "Stopping what uses the database: ${USERS[*]}."
"${COMPOSE[@]}" stop "${USERS[@]}" >/dev/null 2>&1 || die 3 "The services couldn't be stopped (try: ${COMPOSE[*]} stop). Nothing was changed."

# 2. Postgres 16 on the old data, as it always ran, with no network: only this script talks to it.
say "Starting Postgres 16 on the old data (volume $OLD_VOLUME)."
docker image inspect "$OLD_IMAGE" >/dev/null 2>&1 || docker pull -q "$OLD_IMAGE" >/dev/null \
  || die 3 "The Postgres 16 image couldn't be downloaded. Nothing was changed."
docker run -d --name "$OLD_DB" --network none -v "$OLD_VOLUME:/var/lib/postgresql/data" "$OLD_IMAGE" >/dev/null \
  || die 3 "Postgres 16 couldn't be started on the old data. Nothing was changed."
wait_ready "$OLD_DB" postgres
DATABASES=(booster)
if has_database "$OLD_DB" documenso; then DATABASES+=(documenso); fi
for db in "${DATABASES[@]}"; do
  has_database "$OLD_DB" "$db" || die 4 "The old server has no database named $db. The old data is untouched."
  count_rows "$OLD_DB" "$db" > "$FOLDER/move-$STAMP-rows-postgres-16-$db.txt" \
    || die 4 "The rows of $db couldn't be counted. The old data is untouched."
done

say "Backing up with Postgres 16's own tools into $FOLDER."
backup_out="$(BR_DB_CONTAINER="$OLD_DB" BR_DB_USER="$ADMIN" BR_DOCUMENSO_DB_USER="$ADMIN" BR_DB_NAME=booster \
  BR_DOCUMENSO_DB_NAME="$([ "${#DATABASES[@]}" -gt 1 ] && echo documenso || true)" \
  "$HERE/backup.sh" "$FOLDER" --keep 9999)" || die 4 "The backup failed, so nothing was moved. The old data is untouched."
PORTAL_DUMP="$(sed -n 's/^Backup written: \(.*\) ([0-9]* bytes)\.$/\1/p' <<<"$backup_out")"
DOCUMENSO_DUMP="$(sed -n "s/^Documenso's database written: \(.*\) ([0-9]* bytes)\.$/\1/p" <<<"$backup_out")"
[ -s "$PORTAL_DUMP" ] || die 4 "The backup didn't say which file it wrote. The old data is untouched."
if [ "${#DATABASES[@]}" -gt 1 ] && [ ! -s "$DOCUMENSO_DUMP" ]; then die 4 "The backup of Documenso's database is missing. The old data is untouched."; fi
say "  $PORTAL_DUMP"
[ -z "$DOCUMENSO_DUMP" ] || say "  $DOCUMENSO_DUMP"

# 3. Postgres 16 stopped cleanly; the old data's fingerprint now is what the move is made from.
stop_clean "$OLD_DB"
probe
if [ "$STATE_OLD" != "yes" ] || [ -z "$FINGERPRINT" ] || [ "$FINGERPRINT" = "-" ]; then die 4 "The old data couldn't be read after the backup. It was not changed."; fi
"${COMPOSE[@]}" run --rm --no-deps -T db begin $AGAIN >/dev/null \
  || die 4 "The move couldn't be marked under way in the volume $NEW_VOLUME. The old data is untouched."

# 4. Postgres 18 on its own volume: its first start makes the roles and empty databases, as a first installation does.
say "Starting Postgres 18 on its own volume ($NEW_VOLUME) and loading the backup."
"${COMPOSE[@]}" run -d --no-deps --name "$NEW_DB" db moving postgres >/dev/null \
  || die 4 "Postgres 18 couldn't be started. The old data is untouched; run the move again."
wait_ready "$NEW_DB" booster
BR_DB_CONTAINER="$NEW_DB" BR_DB_USER="$ADMIN" "$HERE/restore.sh" "$PORTAL_DUMP" booster >/dev/null \
  || die 4 "The portal's backup didn't load into Postgres 18. The old data is untouched; run the move again."
if [ -n "$DOCUMENSO_DUMP" ]; then
  BR_DB_CONTAINER="$NEW_DB" BR_DB_USER="$ADMIN" "$HERE/restore.sh" "$DOCUMENSO_DUMP" documenso >/dev/null \
    || die 4 "Documenso's backup didn't load into Postgres 18. The old data is untouched; run the move again."
fi

# 5. Every table, both databases, the same number of rows.
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

# 6. Done: only now may Postgres 18 start normally.
stop_clean "$NEW_DB"
"${COMPOSE[@]}" run --rm --no-deps -T db finish "$FINGERPRINT" >/dev/null \
  || die 4 "The move couldn't be recorded as done. A normal start stays refused; the old data is untouched. Run the move again."
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
    say "Now start the portal: ${COMPOSE[*]} up -d db app worker"
    ;;
  dev)
    say ""
    say "Now start the database: ${COMPOSE[*]} up -d"
    ;;
esac
say "Keep the folder and the old volume: while they are there, going back to the previous version still works. The
runbook says when and how to remove them."
