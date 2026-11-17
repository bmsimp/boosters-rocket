// The backup check before deploy/'s migrate step changes a database that already holds data (docs/conformance.md,
// 14.2). Plain JavaScript for the production image (no tsx), run by scripts/migrate.mjs when it is given
// --backup-check, as deploy/compose.yml does. The proof of concept's deploy (scripts/poc/deploy.sh) backs up first
// itself and runs migrate.mjs without it.
//
// The rule: when the portal's database has migrations applied and this version has more to apply, the last good
// backup (the setting backup.last_success, which scripts/backup.sh records) must be less than 26 hours old, or nothing
// is changed. A first installation (no migration applied yet: nothing to lose) and a start with nothing to apply are
// never stopped. MIGRATE_WITHOUT_RECENT_BACKUP=yes lets one start through, for a volunteer with a backup of their own
// (docs/runbooks/updates.md). The message names no host: a club's installation is its own.
import { readFileSync } from "node:fs";
import path from "node:path";

const HOUR = 3_600_000;
/** The nightly backup runs once a day: 26 hours leaves it two hours' slack. */
export const FRESH_HOURS = 26;
export const OVERRIDE = "MIGRATE_WITHOUT_RECENT_BACKUP";
export const BACKUP_NOW = "docker compose run --rm backup --now";

/** The migrations a folder holds, by the time drizzle-kit gave each (its journal), oldest first. */
function journalOf(folder) {
  const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"));
  return journal.entries.map((e) => Number(e.when)).sort((a, b) => a - b);
}

/**
 * The time drizzle recorded for the last migration it applied, or null when it has applied none (an empty database).
 * Drizzle's migrator applies every migration of the folder whose time is later than this one, and so does this count.
 */
async function lastApplied(pg) {
  const [t] = await pg`select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
  if (!t.present) return null;
  const [row] = await pg`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
  return row ? Number(row.created_at) : null;
}

/** When the last good backup was made, as scripts/backup.sh recorded it; null when none is recorded or it can't be read. */
async function lastBackupAt(pg) {
  const [t] = await pg`select to_regclass('public.setting') is not null as present`;
  if (!t.present) return null;
  const [row] = await pg`select value from setting where key = 'backup.last_success'`;
  const at = row?.value && typeof row.value === "object" ? Date.parse(row.value.at) : NaN;
  return Number.isFinite(at) ? at : null;
}

const hoursWords = (ms) => {
  const h = Math.floor(ms / HOUR);
  return h < 1 ? "less than an hour ago" : h === 1 ? "1 hour ago" : `${h} hours ago`;
};
const changesWords = (n) => (n === 1 ? "1 change" : `${n} changes`);

/** What a volunteer reads when the start is stopped: what is wrong, the one command that fixes it, and how to go on. */
export function refusalMessage(pending, backup) {
  const when = (at) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
  const why = backup === null ? "no backup of it has been recorded yet"
    : backup.ageMs < 0 ? `the last backup's recorded time (${when(backup.at)}) is later than this machine's clock, so it can't be told how recent it is`
    : `the last good backup was made ${hoursWords(backup.ageMs)} (${when(backup.at)})`;
  return [
    `This version of the portal has ${changesWords(pending)} to make to its database, and ${why}.`,
    `The portal changes a database that holds a club's data only when a backup was made in the last ${FRESH_HOURS} hours, so nothing has been changed and the portal has not started.`,
    "",
    "1. Make a backup now, from the deploy folder:",
    `     ${BACKUP_NOW}`,
    "2. Then start the portal again the way you started it, for example:",
    "     docker compose up -d",
    "   (add --profile proxy if you use this installation's proxy).",
    "",
    `If you have a backup of your own made since the portal last changed, you can let this one start go ahead instead:`,
    `     ${OVERRIDE}=yes docker compose up -d`,
    "Only for that one start: never put it in .env. The updates runbook (docs/runbooks/updates.md) says more.",
  ].join("\n");
}

/**
 * Whether the migrate step may go on. `go` with the reason in words, or not, with the message to print. `now` is the
 * clock's time; `env` is the process's environment, for the override.
 */
export async function backupCheck(pg, { folder, env = process.env, now = Date.now() }) {
  const last = await lastApplied(pg);
  if (last === null) return { go: true, words: "backup check: an empty database (a first installation), so there is nothing to back up yet" };
  const pending = journalOf(folder).filter((when) => when > last).length;
  if (pending === 0) return { go: true, words: "backup check: nothing to apply" };
  const at = await lastBackupAt(pg);
  // A time more than an hour ahead of this clock is not believed: it would pass every check from now on.
  const backup = at === null ? null : { at, ageMs: at - now > HOUR ? -1 : Math.max(0, now - at) };
  if (backup && backup.ageMs >= 0 && backup.ageMs < FRESH_HOURS * HOUR) return { go: true, words: `backup check: the last good backup was made ${hoursWords(backup.ageMs)}` };
  if (env[OVERRIDE] === "yes") return { go: true, words: `backup check: going ahead without a recent backup, as ${OVERRIDE}=yes asks` };
  return { go: false, message: refusalMessage(pending, backup) };
}
