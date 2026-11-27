#!/usr/bin/env bash
# The backup service's agent (docs/superpowers/specs/2026-11-28-in-app-backups-design.md): what the portal's Settings,
# Backups page asks for, done here, where the tools, the superuser and the backups folder are. deploy/compose.yml runs
# it as the service "backup", in place of scripts/backup-schedule.sh's loop.
#   scripts/backup-agent.sh <folder>           every few seconds, until stopped: one look (below)
#   scripts/backup-agent.sh <folder> --once    one look, then exits (the tests)
#   scripts/backup-agent.sh <folder> --now     one backup now, as backup-schedule.sh --now; exits with backup.sh's code
#   scripts/backup-agent.sh <folder> --next    says when the next nightly backup is, as backup-schedule.sh --next
#
# One look: it writes its heartbeat (the setting backup.agent: when it looked, the free space in the folder, when the
# next backup is due), lists the folder into the table backup_file, claims at most one waiting request of the table
# backup_request (back up, prepare a download, restore, stage an off-site copy), does it and writes its outcome, and
# makes the nightly backup when it is due, as a request of its own. A row is a request, never an instruction: its kind
# is one of a fixed list, and a backup's time must name a pair of files this look listed itself. Nothing from a row is
# ever a path, a database name, a command or SQL; values reach SQL only as psql variables, quoted by psql.
#
# The settings it reads from the portal's database: backup.schedule ({ at: "HH:MM" | "off", keep: 1..60 }), else
# BR_BACKUP_AT and BR_BACKUP_KEEP; the club's time zone (the Club setting), else TZ; backup.offsite's "on".
# How it reaches the databases: as scripts/backup.sh does (BR_DB_CONTAINER, PGHOST and the rest; BR_DB_NAME,
# BR_DOCUMENSO_DB_NAME), and it must be able to create, drop and rename databases (deploy/ runs it as postgres).
#   BR_OUTBOX        the folder shared with the portal's app, for downloads and off-site copies (default /backup-outbox)
#   BR_OUTBOX_OWNER  uid:gid the files there are given to, the app's user (default: left as they are)
#   BR_AGENT_EVERY   seconds between looks (default 10)
# It prints one line for each request it finishes, and never a secret.
set -uo pipefail
export LC_ALL=C
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP="$HERE/backup.sh"
SCHEDULE="$HERE/backup-schedule.sh"
AGENT_VERSION=1

BR_DB_CONTAINER="${BR_DB_CONTAINER-booster-rocket-db-1}"
BR_DB_NAME="${BR_DB_NAME:-booster}"
BR_DB_USER="${BR_DB_USER:-booster}"
if [ -n "${BR_DOCUMENSO_DB_NAME+set}" ]; then DOC_DB="$BR_DOCUMENSO_DB_NAME"; DOC_ASKED="yes"; else DOC_DB="documenso"; DOC_ASKED=""; fi
BR_OUTBOX="${BR_OUTBOX:-/backup-outbox}"
BR_OUTBOX_OWNER="${BR_OUTBOX_OWNER:-}"
BR_AGENT_EVERY="${BR_AGENT_EVERY:-10}"
ENV_AT="${BR_BACKUP_AT:-03:00}"
ENV_KEEP="${BR_BACKUP_KEEP:-14}"
ENV_TZ="${TZ:-UTC}"

STAMP_RE='^[0-9]{8}T[0-9]{6}Z$'
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
AT_RE='^(([01][0-9]|2[0-3]):[0-5][0-9]|off)$'
NAME_RE='^[a-z][a-z0-9_]{0,49}$'

die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }
usage() { die 2 "Usage: scripts/backup-agent.sh <folder> [--once | --now | --next]"; }

DIR="" MODE="loop"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --once) MODE="once"; shift ;;
    --now) MODE="now"; shift ;;
    --next) MODE="next"; shift ;;
    -*) usage ;;
    *) [ -z "$DIR" ] || usage; DIR="$1"; shift ;;
  esac
done
[ -n "$DIR" ] || usage
case "$MODE" in
  now) exec bash "$SCHEDULE" "$DIR" --keep "$ENV_KEEP" --now ;;
  next) exec bash "$SCHEDULE" "$DIR" --next ;;
esac
[[ "$BR_AGENT_EVERY" =~ ^[1-9][0-9]{0,3}$ ]] || die 2 "BR_AGENT_EVERY must be a number of seconds."
[[ "$BR_DB_NAME" =~ $NAME_RE ]] || die 2 "BR_DB_NAME must be lower-case letters, digits and underscores."
[ -z "$DOC_DB" ] || [[ "$DOC_DB" =~ $NAME_RE ]] || die 2 "BR_DOCUMENSO_DB_NAME must be lower-case letters, digits and underscores."
[ -z "$BR_OUTBOX_OWNER" ] || [[ "$BR_OUTBOX_OWNER" =~ ^[0-9]+:[0-9]+$ ]] || die 2 "BR_OUTBOX_OWNER must be uid:gid, two numbers."
[ -f "$BACKUP" ] || die 2 "backup.sh isn't beside this script, in $HERE."
mkdir -p "$DIR" "$BR_OUTBOX" 2>/dev/null || die 2 "The folders $DIR and $BR_OUTBOX can't be created."
# The app's user reads the outbox's files and removes them once sent, so the folder is theirs.
[ -z "$BR_OUTBOX_OWNER" ] || chown "$BR_OUTBOX_OWNER" "$BR_OUTBOX" 2>/dev/null || true
chmod 700 "$BR_OUTBOX" 2>/dev/null || true

if [ -n "$BR_DB_CONTAINER" ]; then
  CONN=(-U "$BR_DB_USER" --no-password)
  pg() { docker exec "$BR_DB_CONTAINER" "$@"; }
  pg_in() { docker exec -i "$BR_DB_CONTAINER" "$@"; }
else
  CONN=(--no-password)
  pg() { "$@" </dev/null; }
  pg_in() { "$@"; }
fi

# SQL against a database, values only ever as psql variables (-v name=value, read as :'name'). The SQL comes on stdin.
#   sql <database> [-v name=value ...] <<'SQL' ... SQL
sql() { local db="$1"; shift; pg_in psql "${CONN[@]}" -d "$db" -v ON_ERROR_STOP=1 -X -Atq -F '|' "$@"; }
portal() { sql "$BR_DB_NAME" "$@"; }
# One statement against the server's own database, for creating, dropping and renaming databases.
server() { pg psql "${CONN[@]}" -d postgres -v ON_ERROR_STOP=1 -X -Atq -c 'set client_min_messages = warning' -c "$1"; }
db_exists() { [ "$(server "select count(*) from pg_database where datname = '$1'" 2>/dev/null)" = "1" ]; }

say() { printf '%s\n' "$*"; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# --- The schedule --------------------------------------------------------------------------------------------------
AT="$ENV_AT" KEEP="$ENV_KEEP" ZONE="$ENV_TZ" OFFSITE=""
read_settings() {
  local row at keep zone off
  row="$(portal <<'SQL' 2>/dev/null
select coalesce((select value->>'at' from setting where key = 'backup.schedule'), ''),
       coalesce((select value->>'keep' from setting where key = 'backup.schedule'), ''),
       coalesce((select value->>'timeZone' from setting where key = 'club'), ''),
       coalesce((select value->>'on' from setting where key = 'backup.offsite'), '');
SQL
)" || return 1
  IFS='|' read -r at keep zone off <<<"$row"
  AT="$ENV_AT" KEEP="$ENV_KEEP" ZONE="$ENV_TZ"
  if [[ "$at" =~ $AT_RE ]] && [[ "$keep" =~ ^[1-9][0-9]?$ ]] && [ "$keep" -le 60 ]; then AT="$at" KEEP="$keep"; fi
  [[ "$AT" =~ $AT_RE ]] || AT="03:00"
  [[ "$KEEP" =~ ^[1-9][0-9]{0,3}$ ]] || KEEP=14
  if [[ "$zone" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] && [ -f "/usr/share/zoneinfo/$zone" ]; then ZONE="$zone"; fi
  OFFSITE=""; [ "$off" = "true" ] && OFFSITE="yes"
  return 0
}

# The next time it is $AT in $ZONE, as seconds since 1970, or nothing when backups are off or the zone is unknown here.
next_run() {
  [ "$AT" != "off" ] || return 0
  [[ "$ZONE" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] && { [ "$ZONE" = "UTC" ] || [ -f "/usr/share/zoneinfo/$ZONE" ]; } || return 0
  local now day target i
  now="$(date +%s)"
  for i in 0 1 2; do
    day="$(TZ="$ZONE" date -d "@$((now + i * 86400))" +%F)"
    target="$(TZ="$ZONE" date -d "$day $AT" +%s 2>/dev/null)" || continue
    [ "$target" -le "$now" ] || { printf '%s' "$target"; return 0; }
  done
}

# --- The folder ----------------------------------------------------------------------------------------------------
# The stamps of the pairs in the folder, oldest first: every booster-rocket-<time>.dump that backup.sh named.
stamps() {
  local f b
  for f in "$DIR"/booster-rocket-*.dump; do
    [ -f "$f" ] || continue
    b="$(basename "$f")"; b="${b#booster-rocket-}"; b="${b%.dump}"
    [[ "$b" =~ $STAMP_RE ]] && printf '%s\n' "$b"
  done
}
has_stamp() { [[ "$1" =~ $STAMP_RE ]] && [ -f "$DIR/booster-rocket-$1.dump" ]; }
size_of() { wc -c < "$1" | tr -d '[:space:]'; }

# The time of the last migration in a portal dump (drizzle's created_at), or nothing.
schema_of() {
  pg_in pg_restore --data-only --schema=drizzle --table=__drizzle_migrations -f - < "$1" 2>/dev/null \
    | awk -F '\t' '/^COPY /{on=1; next} /^\\\.$/{on=0} on && $3 ~ /^[0-9]+$/ { if ($3 + 0 > m) m = $3 + 0 } END { if (m) printf "%d", m }'
}
live_schema() { portal <<<"select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations" 2>/dev/null; }

# backup_file made the same as the folder. A pair's schema is read once, when it is first seen.
list_folder() {
  local known s portal_bytes doc_bytes schema values="" keep_list=""
  known="$(portal <<<"select backup_at from backup_file where schema_at is not null" 2>/dev/null)" || return 1
  while read -r s; do
    [ -n "$s" ] || continue
    portal_bytes="$(size_of "$DIR/booster-rocket-$s.dump")"
    doc_bytes="null"
    [ -f "$DIR/documenso-$s.dump" ] && doc_bytes="$(size_of "$DIR/documenso-$s.dump")"
    schema="null"
    if ! grep -qx "$s" <<<"$known"; then schema="$(schema_of "$DIR/booster-rocket-$s.dump")"; [ -n "$schema" ] || schema="null"; fi
    # Every value here is a stamp held to its pattern or a number this script counted.
    values+="${values:+,}('$s', $portal_bytes, $doc_bytes, $schema)"
    keep_list+="${keep_list:+,}'$s'"
  done < <(stamps)
  {
    echo "begin;"
    if [ -n "$keep_list" ]; then echo "delete from backup_file where backup_at not in ($keep_list);"; else echo "delete from backup_file;"; fi
    if [ -n "$values" ]; then
      echo "insert into backup_file (backup_at, portal_bytes, documenso_bytes, schema_at) values $values
        on conflict (backup_at) do update set portal_bytes = excluded.portal_bytes, documenso_bytes = excluded.documenso_bytes,
          schema_at = coalesce(backup_file.schema_at, excluded.schema_at), seen_at = now();"
    fi
    echo "commit;"
  } | portal >/dev/null
}

heartbeat() {
  local free next_at="" next
  free="$(df -Pk "$DIR" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 * 1024 }')"
  [[ "$free" =~ ^[0-9]+$ ]] || free=""
  next="$(next_run)"
  [ -z "$next" ] || next_at="$(iso "$next")"
  portal -v "free=$free" -v "next=$next_at" -v "at=$AT" -v "keep=$KEEP" -v "zone=$ZONE" -v "version=$AGENT_VERSION" >/dev/null <<'SQL'
insert into setting (key, value) values ('backup.agent', jsonb_build_object(
  'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'version', :'version'::int,
  'freeBytes', nullif(:'free', '')::bigint, 'nextAt', nullif(:'next', ''), 'schedule', :'at', 'keep', :'keep'::int, 'zone', :'zone'))
on conflict (key) do update set value = excluded.value, updated_at = now();
SQL
}

# --- Requests ------------------------------------------------------------------------------------------------------
# Claims the oldest waiting request: "id|kind|backup_at", or nothing.
claim() {
  portal <<'SQL'
update backup_request set claimed_at = now()
where id = (select id from backup_request where finished_at is null and claimed_at is null order by requested_at, id limit 1 for update skip locked)
returning id, kind, coalesce(backup_at, '');
SQL
}

# finish <database> <id> <ok|failed|refused> <words> [result json]
finish() {
  sql "$1" -v "id=$2" -v "outcome=$3" -v "words=${4:0:480}" -v "result=${5:-null}" >/dev/null <<'SQL'
update backup_request set finished_at = now(), outcome = :'outcome', words = :'words', result = :'result'::jsonb
where id = :'id' and finished_at is null;
SQL
  say "Backup request $2 ($KIND): $3. $4"
}

# Requests claimed by an agent that stopped before finishing them: nothing is still working on them.
finish_abandoned() {
  sql "$1" >/dev/null <<'SQL' || true
update backup_request set finished_at = now(), outcome = 'failed', words = 'The backup service stopped before this finished. Ask again.'
where finished_at is null and claimed_at is not null;
SQL
}

# The last line backup.sh wrote to say why it stopped: its own words, which name no secret.
why() { grep -v '^[[:space:]]*$' "$1" | tail -n 1 | cut -c1-300; }

run_backup() { bash "$BACKUP" "$DIR" "$@" >"$OUT" 2>"$ERR"; }
written_stamp() { sed -n 's#^Backup written: .*booster-rocket-\([0-9]\{8\}T[0-9]\{6\}Z\)\.dump .*#\1#p' "$OUT" | tail -n 1; }

# Stages a pair in the outbox as one tar file with what else to keep: prints its name and size, "name|bytes".
stage() {
  local s="$1" name="$2" part="$BR_OUTBOX/.$2.partial" note files
  note="$(mktemp -d)"
  cat > "$note/KEEP-THESE-TOO.txt" <<'EOT'
This is a backup of a Boosters Rocket portal: its database (booster-rocket-<time>.dump) and, when it was included,
Documenso's (documenso-<time>.dump). It holds every family's records. Keep it private, and delete it when done.

The databases are not all there is to bring back. Keep these with the backups, safe and private:
  1. The env file the portal runs with (deploy/.env). Its SETTINGS_ENCRYPTION_KEY opens the QuickBooks connection, the
     sign-in certificates and the mail password stored in the backup.
  2. Documenso's signing certificate (the .p12 file) and its passphrase.

To bring a backup back on a server, follow docs/runbooks/restore.md.
EOT
  files=("booster-rocket-$s.dump")
  [ -f "$DIR/documenso-$s.dump" ] && files+=("documenso-$s.dump")
  if ! tar -cf "$part" -C "$DIR" "${files[@]}" -C "$note" KEEP-THESE-TOO.txt 2>/dev/null; then
    rm -rf "$note" "$part"; return 1
  fi
  rm -rf "$note"
  chmod 600 "$part"
  [ -z "$BR_OUTBOX_OWNER" ] || chown "$BR_OUTBOX_OWNER" "$part" 2>/dev/null || true
  mv "$part" "$BR_OUTBOX/$name" || { rm -f "$part"; return 1; }
  printf '%s|%s' "$name" "$(size_of "$BR_OUTBOX/$name")"
}

# Leaves an off-site copy's request for the worker, for a backup that was just made, while off-site copies are on.
ask_upload() {
  [ -n "$OFFSITE" ] && has_stamp "$1" || return 0
  portal -v "s=$1" >/dev/null 2>&1 <<'SQL' || true
insert into backup_request (kind, backup_at) values ('upload', :'s') on conflict (kind) where finished_at is null do nothing;
SQL
}

do_backup() {
  local id="$1" s
  if run_backup --keep "$KEEP"; then
    s="$(written_stamp)"
    list_folder || true
    finish "$BR_DB_NAME" "$id" ok "Backed up." "{\"backupAt\": \"$s\"}"
    ask_upload "$s"
  else
    list_folder || true
    finish "$BR_DB_NAME" "$id" failed "$(why "$ERR")"
  fi
}

do_download() {
  local id="$1" s="$2" got
  has_stamp "$s" || { finish "$BR_DB_NAME" "$id" refused "There is no backup from that time on the server any more."; return; }
  if got="$(stage "$s" "$id.tar")"; then
    finish "$BR_DB_NAME" "$id" ok "Ready to download." "{\"file\": \"${got%%|*}\", \"bytes\": ${got#*|}}"
  else
    finish "$BR_DB_NAME" "$id" failed "The download couldn't be prepared: the shared folder couldn't be written to."
  fi
}

do_upload() {
  local id="$1" s="$2" got
  has_stamp "$s" || { finish "$BR_DB_NAME" "$id" refused "There is no backup from that time on the server any more."; return; }
  if got="$(stage "$s" "upload-$s.tar")"; then
    finish "$BR_DB_NAME" "$id" ok "Ready to copy off-site." "{\"file\": \"${got%%|*}\", \"bytes\": ${got#*|}}"
  else
    finish "$BR_DB_NAME" "$id" failed "The off-site copy couldn't be prepared: the shared folder couldn't be written to."
  fi
}

# Loads one dump into <target>_restoring, owned by <owner>, closed to other roles. 0 when all of it loaded.
load_beside() {
  local file="$1" target="$2" owner="$3" staging="${2}_restoring"
  server "drop database if exists \"$staging\"" >/dev/null || return 1
  server "create database \"$staging\" owner \"$owner\"" >/dev/null || return 1
  server "revoke all on database \"$staging\" from public" >/dev/null || return 1
  pg_in pg_restore "${CONN[@]}" -d "$staging" --no-owner --no-acl --role="$owner" --exit-on-error --single-transaction < "$file" >/dev/null 2>&1
}
owner_of() { server "select pg_get_userbyid(datdba) from pg_database where datname = '$1'"; }
drop_staging() { server "drop database if exists \"${BR_DB_NAME}_restoring\"" >/dev/null 2>&1 || true; [ -z "$DOC_DB" ] || server "drop database if exists \"${DOC_DB}_restoring\"" >/dev/null 2>&1 || true; }

do_restore() {
  local id="$1" s="$2" live dumped fresh who last owner doc_owner="" with_doc="" words
  has_stamp "$s" || { finish "$BR_DB_NAME" "$id" refused "There is no backup from that time on the server any more."; return; }
  # A backup made by another version of the portal holds another schema, which only the migrate step can change.
  live="$(live_schema)"
  dumped="$(schema_of "$DIR/booster-rocket-$s.dump")"
  if [ -z "$dumped" ] || [ "$dumped" != "$live" ]; then
    finish "$BR_DB_NAME" "$id" refused "This backup was made by another version of the portal, so it can't be put back from here. The restore runbook's steps bring it back."
    return
  fi
  # Documenso's dump goes back too when the backup has one and this server has Documenso's database.
  if [ -n "$DOC_DB" ] && [ -f "$DIR/documenso-$s.dump" ] && db_exists "$DOC_DB"; then with_doc="yes"; fi
  if [ -n "$DOC_ASKED" ] && [ -n "$DOC_DB" ] && [ -f "$DIR/documenso-$s.dump" ] && [ -z "$with_doc" ]; then
    finish "$BR_DB_NAME" "$id" refused "Documenso's database isn't on this server, so this backup can't be put back from here."
    return
  fi
  # How things are now, kept first: the way back from this restore. Every backup is kept for this one.
  if ! run_backup --keep 9999; then
    finish "$BR_DB_NAME" "$id" failed "A backup of how things are now couldn't be made, so nothing was put back. $(why "$ERR")"
    return
  fi
  fresh="$(written_stamp)"
  list_folder || true
  # Read from the live database before it is replaced: who asked, and the backup just made.
  who="$(portal -v "id=$id" <<'SQL'
select json_build_object('by', requested_by, 'label', requested_label)::text from backup_request where id = :'id';
SQL
)" || who='{"by": null, "label": null}'
  last="$(portal <<<"select value::text from setting where key = 'backup.last_success'")" || last=""
  owner="$(owner_of "$BR_DB_NAME")"
  [ -z "$with_doc" ] || doc_owner="$(owner_of "$DOC_DB")"
  # Both load beside the live ones; only when both have loaded whole does either take its name.
  if ! load_beside "$DIR/booster-rocket-$s.dump" "$BR_DB_NAME" "$owner" \
    || { [ -n "$with_doc" ] && ! load_beside "$DIR/documenso-$s.dump" "$DOC_DB" "$doc_owner"; }; then
    drop_staging
    finish "$BR_DB_NAME" "$id" failed "The backup didn't load, so nothing was put back. The backup made just before is in the list." "{\"backupMadeFirst\": \"$fresh\"}"
    return
  fi
  # The swap: every connection to the live database is ended as it is dropped, and the loaded one takes its name.
  server "drop database \"$BR_DB_NAME\" with (force)" >/dev/null \
    && server "alter database \"${BR_DB_NAME}_restoring\" rename to \"$BR_DB_NAME\"" >/dev/null || {
      say "Backup request $id (restore): the portal's database couldn't be swapped. Its backup from $fresh is in $DIR."
      return
    }
  if [ -n "$with_doc" ]; then
    server "drop database \"$DOC_DB\" with (force)" >/dev/null && server "alter database \"${DOC_DB}_restoring\" rename to \"$DOC_DB\"" >/dev/null \
      || say "Backup request $id (restore): Documenso's database couldn't be swapped; it is in ${DOC_DB}_restoring."
  fi
  # Into the restored database: the audit row, this request finished, the backup just made as the last one, and
  # every request it held from before marked as not done.
  words="Put back the backup from $s. A backup of how things were just before was made first."
  portal -v "id=$id" -v "s=$s" -v "fresh=$fresh" -v "who=$who" -v "last=$last" -v "words=$words" -v "doc=${with_doc:-no}" >/dev/null <<'SQL' || say "Backup request $id (restore): restored, but its record couldn't be written."
begin;
update backup_request set finished_at = now(), outcome = 'refused', words = 'Asked for before the backup that was put back.'
  where finished_at is null;
insert into backup_request (id, kind, backup_at, requested_by, requested_label, claimed_at, finished_at, outcome, words, result)
  values (:'id', 'restore', :'s', (:'who'::jsonb)->>'by', (:'who'::jsonb)->>'label', now(), now(), 'ok', :'words',
    jsonb_build_object('backupMadeFirst', :'fresh', 'documenso', :'doc' = 'yes'))
  on conflict (id) do update set finished_at = now(), outcome = 'ok', words = :'words',
    result = jsonb_build_object('backupMadeFirst', :'fresh', 'documenso', :'doc' = 'yes');
insert into audit_log (door, actor_id, actor_label, action, permission, target_type, target_id, before, after)
  values ('staff', (:'who'::jsonb)->>'by', (:'who'::jsonb)->>'label', 'backup.restore.done', 'Admin.Backups.ReadWrite', 'backup', :'s',
    jsonb_build_object('backupMadeFirst', :'fresh'), jsonb_build_object('restored', :'s', 'request', :'id', 'documenso', :'doc' = 'yes'));
insert into setting (key, value) select 'backup.last_success', nullif(:'last', '')::jsonb where nullif(:'last', '') is not null
  on conflict (key) do update set value = excluded.value, updated_at = now();
commit;
SQL
  list_folder || true
  say "Backup request $id (restore): ok. $words"
}

# Downloads left in the outbox after 15 minutes, and staged off-site copies after a day, are removed.
sweep_outbox() {
  find "$BR_OUTBOX" -maxdepth 1 -type f -name '*.tar' ! -name 'upload-*' -mmin +15 -delete 2>/dev/null || true
  find "$BR_OUTBOX" -maxdepth 1 -type f -name 'upload-*.tar' -mmin +1440 -delete 2>/dev/null || true
  find "$BR_OUTBOX" -maxdepth 1 -type f -name '.*.partial' -mmin +60 -delete 2>/dev/null || true
}

# --- One look ------------------------------------------------------------------------------------------------------
OUT="$(mktemp)"; ERR="$(mktemp)"
trap 'rm -f "$OUT" "$ERR"' EXIT
NEXT="" NEXT_FOR=""
KIND=""

look() {
  read_settings || return 1
  heartbeat || return 1
  list_folder || return 1
  sweep_outbox
  # The nightly backup, when its time has come: a request like any other, so its outcome is on the page.
  if [ "$MODE" = "loop" ]; then
    if [ "$NEXT_FOR" != "$AT|$ZONE" ]; then NEXT="$(next_run)"; NEXT_FOR="$AT|$ZONE"; fi
    if [ -n "$NEXT" ] && [ "$(date +%s)" -ge "$NEXT" ]; then
      portal >/dev/null 2>&1 <<<"insert into backup_request (kind) values ('backup') on conflict (kind) where finished_at is null do nothing;" || true
      NEXT="$(next_run)"
    fi
  fi
  local got id kind s
  got="$(claim)" || return 1
  [ -n "$got" ] || return 0
  IFS='|' read -r id kind s <<<"$got"
  [[ "$id" =~ $UUID_RE ]] || return 1
  [ -z "$s" ] || [[ "$s" =~ $STAMP_RE ]] || { KIND="$kind"; finish "$BR_DB_NAME" "$id" refused "That isn't the time of a backup."; return 0; }
  KIND="$kind"
  case "$kind" in
    backup) do_backup "$id" ;;
    download) do_download "$id" "$s" ;;
    restore) do_restore "$id" "$s" ;;
    upload) do_upload "$id" "$s" ;;
    *) finish "$BR_DB_NAME" "$id" refused "The backup service doesn't know that kind of request." ;;
  esac
  heartbeat || true
}

if [ "$MODE" = "once" ]; then look; exit $?; fi
# Only one agent runs beside a portal: when it starts, nothing is still working on a request it had claimed.
finish_abandoned "$BR_DB_NAME"
# Stopped while it sleeps, it stops at once. Stopped while it works, the work finishes first (deploy/compose.yml gives
# the container time to stop).
trap 'exit 0' TERM INT
while :; do
  look || true
  sleep "$BR_AGENT_EVERY" &
  wait $! || true
done
