import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { backupFile, backupRequest, setting } from "@/lib/db/schema";
import { lastBackup, type LastBackup } from "@/lib/health/backup";

/**
 * What the Settings, Backups page and the Health page read about backups (docs/superpowers/specs/2026-11-28-in-app-
 * backups-design.md): the backup service's heartbeat, the schedule, the backups on the server as the agent last listed
 * them, and the requests under way or last finished. Staff only (Admin.Backups.ReadWrite, Admin.Health.Read): nothing
 * here is a family's data, but a backup holds every family's. The agent writes the heartbeat and the folder's mirror;
 * nothing here writes.
 */
export const AGENT_KEY = "backup.agent";
export const SCHEDULE_KEY = "backup.schedule";
export const BACKUPS_PERMISSION = "Admin.Backups.ReadWrite" as const;
/** The agent looks every 10 seconds; a minute without a look is a service that isn't answering. */
export const AGENT_LATE_MS = 60_000;
/** A prepared download waits in the outbox this long, then the agent removes it. */
export const DOWNLOAD_LIFE_MS = 15 * 60_000;
export const STAMP = /^\d{8}T\d{6}Z$/;
export const KEEP_MAX = 60;
const RESTORE_NEWS_MS = 24 * 3_600_000;
export const DEFAULT_SCHEDULE = { at: "03:00", keep: 14 } as const;

export type Schedule = { at: string; keep: number };
export type AgentBeat = { at: string; freeBytes: number | null; nextAt: string | null; schedule: string; keep: number; zone: string; version: number };
export type RequestKind = (typeof backupRequest.$inferSelect)["kind"];
export type BackupRow = {
  backupAt: string; iso: string; portalBytes: number; documensoBytes: number | null;
  /** Whether the backup was made by the version of the portal that is running, so the agent can put it back. */
  restorable: boolean;
  offsite: { at: string; ok: boolean } | null;
};
export type Finished = { id: string; kind: RequestKind; outcome: "ok" | "failed" | "refused"; words: string; finishedAt: string; backupAt: string | null; result: Record<string, unknown> };
export type Waiting = { id: string; kind: RequestKind; requestedAt: string; claimedAt: string | null; backupAt: string | null };

/** A backup's time in its file names (20261124T030000Z) as an ISO instant. */
export function stampIso(stamp: string): string {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** The agent's last heartbeat, or null when it never wrote one (or what is stored can't be read). */
export async function agentBeat(tx: Tx | typeof db = db): Promise<AgentBeat | null> {
  const [row] = await tx.select({ value: setting.value }).from(setting).where(eq(setting.key, AGENT_KEY));
  const v = row?.value as Record<string, unknown> | undefined;
  const at = str(v?.at);
  if (!v || !at || Number.isNaN(Date.parse(at))) return null;
  const nextAt = str(v.nextAt);
  return { at, freeBytes: num(v.freeBytes), nextAt: nextAt && !Number.isNaN(Date.parse(nextAt)) ? nextAt : null,
    schedule: str(v.schedule) ?? DEFAULT_SCHEDULE.at, keep: num(v.keep) ?? DEFAULT_SCHEDULE.keep, zone: (str(v.zone) ?? "UTC").slice(0, 64), version: num(v.version) ?? 0 };
}

export const answering = (beat: AgentBeat | null, now = new Date()) => beat !== null && now.getTime() - Date.parse(beat.at) <= AGENT_LATE_MS;

/** The schedule an Admin saved, or null while nobody has (the server's BACKUP_AT and BACKUP_KEEP are used then). */
export async function savedSchedule(tx: Tx | typeof db = db): Promise<Schedule | null> {
  const [row] = await tx.select({ value: setting.value }).from(setting).where(eq(setting.key, SCHEDULE_KEY));
  const v = row?.value as { at?: unknown; keep?: unknown } | undefined;
  return v && typeof v.at === "string" && typeof v.keep === "number" ? { at: v.at, keep: v.keep } : null;
}

/** The time of the last migration the running database has applied: a backup with the same can be put back here. */
export async function liveSchemaAt(tx: Tx | typeof db = db): Promise<number | null> {
  const rows = await tx.execute<{ m: string | null }>(sql`select max(created_at)::text as m from drizzle.__drizzle_migrations`);
  const m = rows[0]?.m;
  return m ? Number(m) : null;
}

/** The backups on the server, newest first. */
export async function backupRows(tx: Tx | typeof db = db): Promise<BackupRow[]> {
  const [files, live] = await Promise.all([tx.select().from(backupFile).orderBy(desc(backupFile.backupAt)), liveSchemaAt(tx)]);
  return files.map((f) => ({
    backupAt: f.backupAt, iso: stampIso(f.backupAt), portalBytes: f.portalBytes, documensoBytes: f.documensoBytes,
    restorable: live !== null && f.schemaAt === live,
    offsite: f.offsiteAt ? { at: f.offsiteAt.toISOString(), ok: f.offsiteOutcome === "ok" } : null,
  }));
}

const finishedOf = (r: typeof backupRequest.$inferSelect): Finished => ({
  id: r.id, kind: r.kind, outcome: r.outcome!, words: r.words ?? "", finishedAt: r.finishedAt!.toISOString(), backupAt: r.backupAt,
  result: r.result && typeof r.result === "object" ? (r.result as Record<string, unknown>) : {},
});

/** The requests not finished yet, oldest first. */
export async function waitingRequests(): Promise<Waiting[]> {
  const rows = await db.select().from(backupRequest).where(isNull(backupRequest.finishedAt)).orderBy(backupRequest.requestedAt);
  return rows.map((r) => ({ id: r.id, kind: r.kind, requestedAt: r.requestedAt.toISOString(), claimedAt: r.claimedAt?.toISOString() ?? null, backupAt: r.backupAt }));
}

/** The latest finished request of a kind (asked for by anyone, or by one staff member). */
export async function lastFinished(kind: RequestKind, by?: string): Promise<Finished | null> {
  const [r] = await db.select().from(backupRequest)
    .where(and(eq(backupRequest.kind, kind), sql`${backupRequest.finishedAt} is not null`, by ? eq(backupRequest.requestedBy, by) : undefined))
    .orderBy(desc(backupRequest.finishedAt)).limit(1);
  return r ? finishedOf(r) : null;
}

/** A download this staff member asked for that is ready, not yet taken and not past its life: its id and size. */
export async function readyDownload(staffUserId: string, now = new Date()): Promise<{ id: string; backupAt: string | null; bytes: number | null } | null> {
  const last = await lastFinished("download", staffUserId);
  if (!last || last.outcome !== "ok" || last.result.fetched === true) return null;
  if (now.getTime() - Date.parse(last.finishedAt) > DOWNLOAD_LIFE_MS) return null;
  return { id: last.id, backupAt: last.backupAt, bytes: num(last.result.bytes) };
}

export type BackupsView = {
  beat: AgentBeat | null; answering: boolean;
  schedule: Schedule & { saved: boolean };
  rows: BackupRow[];
  last: LastBackup | null;
  waiting: Waiting[];
  lastBackupRequest: Finished | null;
  /** The last restore, while it is news (a day). */
  lastRestore: Finished | null;
};

/** Everything the Backups page shows, read once. */
export async function backupsView(now = new Date()): Promise<BackupsView> {
  const [beat, saved, rows, last, waiting, lastBackupRequest, lastRestore] = await Promise.all([
    agentBeat(), savedSchedule(), backupRows(), lastBackup(), waitingRequests(), lastFinished("backup"), lastFinished("restore"),
  ]);
  const schedule = saved ? { ...saved, saved: true }
    : beat ? { at: beat.schedule, keep: beat.keep, saved: false } : { ...DEFAULT_SCHEDULE, saved: false };
  // A restore's answer is news for a day after it finished.
  const restoreNews = lastRestore && now.getTime() - Date.parse(lastRestore.finishedAt) < RESTORE_NEWS_MS ? lastRestore : null;
  return { beat, answering: answering(beat, now), schedule, rows, last, waiting, lastBackupRequest, lastRestore: restoreNews };
}

/** "3:00 AM", from a 24-hour "03:00". */
export function clockWords(at: string): string {
  const m = /^(\d\d):(\d\d)$/.exec(at);
  if (!m) return at;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** "Every night at 3:00 AM. Keeps the newest 14." */
export function scheduleWords(s: Schedule): string {
  const keeps = `Keeps the newest ${s.keep}.`;
  return s.at === "off" ? `Not on a schedule. ${keeps}` : `Every night at ${clockWords(s.at)}. ${keeps}`;
}

/** A size in plain units: "12.4 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
