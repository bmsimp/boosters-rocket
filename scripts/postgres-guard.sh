#!/usr/bin/env bash
# Starts Postgres for Booster Rocket, unless doing so could greet the club with an empty portal. Every compose file's
# db service runs this in front of the image's own docker-entrypoint.sh (docker-compose.yml, docker-compose.poc.yml,
# deploy/compose.yml), with two volumes:
#   /var/lib/postgresql   the data of the Postgres this image is (18 keeps it in /var/lib/postgresql/18/docker)
#   /old-data             read only: the volume Postgres 16 kept its data in, at the root of the volume. Nothing here
#                         ever writes to it.
# A Postgres 18 that found no data of its own would make a new, empty database. While the Postgres 16 volume holds
# data that hasn't been moved, that must never happen: this refuses to start, changes nothing, and says what to do.
# The move is scripts/move-postgres.sh, which uses the other commands below in one-off containers of the same service.
#
#   postgres-guard.sh postgres [args]   the service's own start: refuses unless it is safe, then runs the image's
#                                       entrypoint with the same arguments
#   postgres-guard.sh check             says whether a start would be refused (exit 0 or 2), and starts nothing
#   postgres-guard.sh state             one line for the move: old=<yes|no> new=<empty|moving|moved|other> same=<yes|no|->
#                                       fingerprint=<the old data's, or ->
#   postgres-guard.sh begin [--again]   marks a move as under way, then clears any Postgres 18 data a move left half
#                                       made. --again also clears 18 data that isn't a copy of the 16 data as it is now
#   postgres-guard.sh moving postgres   the move's own start of Postgres 18: only while a move is marked under way
#   postgres-guard.sh finish <fingerprint>   records the move as done, from the 16 data with that fingerprint
#
# BR_MOVE_RUNBOOK names the runbook section a person follows to move the data (set in each compose file).
# Exit codes: 2 refused (nothing was started or changed), 3 something here is not as the move expects.
set -euo pipefail
export LC_ALL=C

NEW_ROOT="/var/lib/postgresql"
OLD="/old-data"
MOVING="$NEW_ROOT/booster-rocket-move-under-way"
MOVED="$NEW_ROOT/booster-rocket-moved-from"
RUNBOOK="${BR_MOVE_RUNBOOK:-docs/runbooks/updates.md, the section \"Moving to a new major version of Postgres\"}"
# The image's own data folder (PGDATA): /var/lib/postgresql/18/docker for Postgres 18.
DATA="${PGDATA:?PGDATA is not set: this runs only in the official postgres image}"
case "$DATA" in "$NEW_ROOT"/*) ;; *) printf 'PGDATA (%s) is not under %s: this file does not know this image.\n' "$DATA" "$NEW_ROOT" >&2; exit 3 ;; esac

refuse() {
  {
    printf '\n'
    printf 'Booster Rocket: Postgres was NOT started, and no data was changed or deleted.\n\n'
    printf '%s\n' "$@"
    printf '\nWhat to do: %s\n' "$RUNBOOK"
    printf "Until then this version of Booster Rocket can't start."
    if old_has_data; then
      printf '\nThe Postgres 16 data is kept exactly as it is, so the previous version of Booster Rocket still\n'
      printf 'starts on it if you go back to it (that section says how).'
    fi
    printf '\n\n'
  } >&2
  exit 2
}

old_has_data() { [ -s "$OLD/PG_VERSION" ]; }
# The 16 data's control file changes whenever Postgres 16 starts or stops, so its hash says whether the 16 data has
# been used since it was moved.
fingerprint() { sha256sum "$OLD/global/pg_control" | cut -d' ' -f1; }
new_state() {
  if [ -e "$MOVING" ]; then echo moving
  elif [ -s "$DATA/PG_VERSION" ] && [ -s "$MOVED" ]; then echo moved
  elif [ -s "$DATA/PG_VERSION" ]; then echo other
  elif [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then echo other
  else echo empty
  fi
}
moved_from() { sed -n 's/^fingerprint=//p' "$MOVED" 2>/dev/null | head -n 1; }

# Why a normal start must not go ahead, or nothing when it may.
start_problem() {
  local new
  new="$(new_state)"
  if [ "$new" = "moving" ]; then
    refuse "A move of the database to Postgres $PG_MAJOR was started and did not finish." \
      "Run the move again: it starts again from the Postgres 16 data."
  fi
  old_has_data || return 0
  case "$new" in
    empty)
      refuse "This version of Booster Rocket runs Postgres $PG_MAJOR. The club's data is in the Postgres 16 data folder," \
        "which Postgres $PG_MAJOR can't read until it is moved across. Starting here would make a new, empty database:" \
        "the portal would ask to be set up again as if it had never been used." \
        "The move backs up the data with Postgres 16, loads it into Postgres $PG_MAJOR and checks every table." ;;
    moved)
      [ "$(moved_from)" = "$(fingerprint)" ] && return 0
      refuse "The data was moved to Postgres $PG_MAJOR before, but Postgres 16 has been started on the old data since" \
        "(the previous version of Booster Rocket was run again). Postgres $PG_MAJOR holds the older copy, so it is not started." \
        "To bring the Postgres 16 data across again, run the move with --again. That replaces what is in Postgres $PG_MAJOR."
      ;;
    other)
      refuse "There is Postgres $PG_MAJOR data here that the move didn't make, and Postgres 16 data beside it." \
        "Neither was touched. To use the Postgres 16 data, run the move with --again: that replaces the Postgres $PG_MAJOR data."
      ;;
  esac
}

cmd="${1:-}"
case "$cmd" in
  postgres|-*)
    start_problem
    exec docker-entrypoint.sh "$@"
    ;;
  check)
    start_problem
    printf 'Postgres can start.\n'
    ;;
  state)
    old="no" same="-" fp="-"
    if old_has_data; then old="yes"; fp="$(fingerprint)"; fi
    new="$(new_state)"
    if [ "$old" = "yes" ] && [ "$new" = "moved" ]; then
      if [ "$(moved_from)" = "$fp" ]; then same="yes"; else same="no"; fi
    fi
    printf 'old=%s new=%s same=%s fingerprint=%s\n' "$old" "$new" "$same" "$fp"
    ;;
  begin)
    again="${2:-}"
    old_has_data || { printf 'There is no Postgres 16 data in %s to move.\n' "$OLD" >&2; exit 3; }
    new="$(new_state)"
    case "$new" in
      empty|moving) ;;
      moved|other)
        [ "$again" = "--again" ] || { printf 'Postgres %s data is already here (%s); only --again replaces it.\n' "$PG_MAJOR" "$new" >&2; exit 2; }
        if [ "$new" = "moved" ] && [ "$(moved_from)" = "$(fingerprint)" ]; then
          printf 'The Postgres %s data is already a copy of the Postgres 16 data as it is now: nothing to replace.\n' "$PG_MAJOR" >&2
          exit 2
        fi
        ;;
    esac
    # The mark goes first, so a move cut off from here on leaves a start that is refused, never an empty database.
    printf 'started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MOVING"
    rm -f "$MOVED"
    # Only what a move made, or (with --again) Postgres 18 data the person has chosen to replace: never /old-data.
    rm -rf "$DATA"
    mkdir -p "$DATA"
    chown postgres:postgres "$DATA"
    chmod 700 "$DATA"
    printf 'A move is marked under way; the Postgres %s data folder is empty.\n' "$PG_MAJOR"
    ;;
  moving)
    shift
    [ -e "$MOVING" ] || { printf 'No move is marked under way, so this start is refused.\n' >&2; exit 2; }
    [ "${1:-}" = "postgres" ] || { printf 'Usage: postgres-guard.sh moving postgres\n' >&2; exit 3; }
    exec docker-entrypoint.sh "$@"
    ;;
  finish)
    want="${2:-}"
    [ -e "$MOVING" ] || { printf 'No move is marked under way.\n' >&2; exit 3; }
    [ -s "$DATA/PG_VERSION" ] || { printf 'The Postgres %s data folder is empty: nothing was moved.\n' "$PG_MAJOR" >&2; exit 3; }
    old_has_data || { printf 'The Postgres 16 data is no longer in %s.\n' "$OLD" >&2; exit 3; }
    if [ -z "$want" ] || [ "$(fingerprint)" != "$want" ]; then
      printf 'The Postgres 16 data changed after it was backed up for the move (was Postgres 16 started?). Run the move again.\n' >&2
      exit 3
    fi
    printf 'fingerprint=%s\nmoved=%s\n' "$want" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MOVED.new"
    mv "$MOVED.new" "$MOVED"
    rm -f "$MOVING"
    printf 'The move is recorded as done.\n'
    ;;
  *)
    printf 'Usage: postgres-guard.sh postgres [args] | check | state | begin [--again] | moving postgres | finish <fingerprint>\n' >&2
    exit 3
    ;;
esac
