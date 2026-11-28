import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { backupFile, backupRequest, setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { agentBeat, answering, BACKUPS_PERMISSION, KEEP_MAX, liveSchemaAt, savedSchedule, SCHEDULE_KEY, STAMP, type RequestKind, type Schedule } from "./status";

/**
 * What an Admin asks the backup service for, from Settings, Backups (docs/superpowers/specs/2026-11-28-in-app-backups-
 * design.md): back up now, prepare a download, put a backup back, and the schedule. Each is a row of backup_request (the
 * schedule a setting) written with its audit row in one transaction; the agent on the server does the work. A request
 * is refused, in words, while the service isn't answering or one of its kind is already waiting. Every argument comes
 * from the browser and is checked here.
 */
export type Asked = { ok: true; message: string } | { ok: false; errors: string[] };
type Who = { actor: Actor; ip: string | null };

export const NOT_ANSWERING = "The backup service on the server isn't answering, so nothing can be asked of it now. The person who looks after the server can check it.";
const BUSY: Record<RequestKind, string> = {
  backup: "A backup is already under way. It shows here when it is done.",
  download: "A download is already being prepared.",
  restore: "A backup is already being put back.",
  upload: "An off-site copy is already under way.",
};
const no = (e: string): Asked => ({ ok: false, errors: [e] });

/** One request, audited, unless one of its kind is waiting. */
async function ask(kind: RequestKind, backupAt: string | null, who: Who, action: string, message: string, extra: Record<string, unknown> = {}): Promise<Asked> {
  if (!answering(await agentBeat())) return no(NOT_ANSWERING);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(backupRequest).values({ kind, backupAt, requestedBy: who.actor.id, requestedLabel: who.actor.label })
      .onConflictDoNothing({ target: backupRequest.kind, where: sql`finished_at is null` }).returning({ id: backupRequest.id });
    if (!row) return no(BUSY[kind]);
    await writeAudit({ actor: who.actor, action, permission: BACKUPS_PERMISSION, targetType: "backup_request", targetId: row.id,
      after: { kind, backupAt, ...extra }, ip: who.ip }, tx);
    return { ok: true as const, message };
  });
}

/** Back up now. */
export function askForBackup(who: Who): Promise<Asked> {
  return ask("backup", null, who, "backup.run.request", "Backing up. This page shows it when it is done.");
}

/** A backup's time as sent by the page, checked: one of the backups the server has. */
async function knownBackup(stamp: unknown) {
  if (typeof stamp !== "string" || !STAMP.test(stamp)) return null;
  const [f] = await db.select().from(backupFile).where(eq(backupFile.backupAt, stamp));
  return f ?? null;
}

const GONE = "That backup isn't on the server any more. Reload the page to see the ones that are.";

/** Prepare one backup as a file to download. */
export async function askForDownload(stamp: unknown, who: Who): Promise<Asked> {
  const f = await knownBackup(stamp);
  if (!f) return no(GONE);
  return ask("download", f.backupAt, who, "backup.download.request", "Preparing the download. It is ready here in a few seconds.");
}

/**
 * Put one backup back, replacing everything done since it was made. Only a backup made by the running version of the
 * portal (its last migration the same as the live database's), and not while a backup is under way.
 */
export async function askForRestore(stamp: unknown, who: Who): Promise<Asked> {
  const f = await knownBackup(stamp);
  if (!f) return no(GONE);
  const live = await liveSchemaAt();
  if (live === null || f.schemaAt !== live) return no("This backup was made by another version of the portal, so it can't be put back from here.");
  const [busy] = await db.select({ id: backupRequest.id }).from(backupRequest).where(and(isNull(backupRequest.finishedAt), eq(backupRequest.kind, "backup")));
  if (busy) return no("A backup is under way. Put this one back once it is done.");
  return ask("restore", f.backupAt, who, "backup.restore.request", "Putting the backup back. A backup of how things are now is made first. This can take a few minutes, and you may need to sign in again.");
}

/** The schedule's form, as the page sends it: a time of day or "off", and how many to keep. */
export function parseSchedule(fields: { at: unknown; off: unknown; keep: unknown }): { ok: true; schedule: Schedule } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const off = fields.off === "on" || fields.off === true;
  const at = typeof fields.at === "string" ? fields.at.trim() : "";
  if (!off && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) errors.push("Choose a time of day, or tick \"Don't back up on a schedule\".");
  const keepText = typeof fields.keep === "string" ? fields.keep.trim() : typeof fields.keep === "number" ? String(fields.keep) : "";
  const keep = /^\d{1,2}$/.test(keepText) ? Number(keepText) : NaN;
  if (!(keep >= 1 && keep <= KEEP_MAX)) errors.push(`Keep a number of backups from 1 to ${KEEP_MAX}.`);
  return errors.length ? { ok: false, errors } : { ok: true, schedule: { at: off ? "off" : at, keep } };
}

/** Saves the schedule, audited with before and after. The agent reads it at its next look. */
export async function saveSchedule(schedule: Schedule, who: Who): Promise<Asked> {
  return db.transaction(async (tx) => {
    await tx.select({ key: setting.key }).from(setting).where(eq(setting.key, SCHEDULE_KEY)).for("update");
    const before = await savedSchedule(tx);
    const value = { at: schedule.at, keep: schedule.keep };
    await tx.insert(setting).values({ key: SCHEDULE_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
    await writeAudit({ actor: who.actor, action: "backup.schedule.update", permission: BACKUPS_PERMISSION, targetType: "setting", targetId: SCHEDULE_KEY,
      before, after: value, ip: who.ip }, tx);
    return { ok: true as const, message: "Saved. The backup service uses it from its next look, within a minute." };
  });
}
