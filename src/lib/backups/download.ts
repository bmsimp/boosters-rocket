import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { backupRequest } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { env } from "@/env";
import { BACKUPS_PERMISSION, DOWNLOAD_LIFE_MS } from "./status";

/**
 * A prepared download, taken once by the Admin who asked for it (docs/superpowers/specs/2026-11-28-in-app-backups-
 * design.md, section 7): found only among that person's own finished download requests under DOWNLOAD_LIFE_MS old and
 * not yet taken, marked taken with its audit row in one transaction, then streamed from the outbox and removed from it
 * once sent. Anything else is null, which the route answers with one bare 404.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DOWNLOAD_NAME = "boosters-rocket-backup.tar";

export type Taken = { body: ReadableStream<Uint8Array>; bytes: number };

export async function takeDownload(id: unknown, who: { actor: Actor & { id: string }; ip: string | null }, o: { outbox?: string; now?: Date } = {}): Promise<Taken | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const outbox = o.outbox ?? env.BACKUP_OUTBOX, now = o.now ?? new Date();
  const file = path.join(outbox, `${id}.tar`);
  const found = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(backupRequest)
      .where(and(eq(backupRequest.id, id), eq(backupRequest.kind, "download"), eq(backupRequest.requestedBy, who.actor.id), eq(backupRequest.outcome, "ok")))
      .for("update");
    const result = (r?.result ?? {}) as { file?: unknown; fetched?: unknown };
    if (!r?.finishedAt || result.fetched === true || result.file !== `${id}.tar`) return null;
    if (now.getTime() - r.finishedAt.getTime() > DOWNLOAD_LIFE_MS) return null;
    const size = await stat(file).then((s) => (s.isFile() ? s.size : null), () => null);
    if (size === null) return null;
    await tx.update(backupRequest).set({ result: sql`${backupRequest.result} || '{"fetched": true}'::jsonb` }).where(eq(backupRequest.id, id));
    await writeAudit({ actor: who.actor, action: "backup.download.fetch", permission: BACKUPS_PERMISSION, targetType: "backup_request", targetId: id,
      after: { backupAt: r.backupAt, bytes: size }, ip: who.ip }, tx);
    return { bytes: size };
  });
  if (!found) return null;
  const stream = createReadStream(file);
  // Removed once sent, or once the browser goes away: a download is taken once.
  const gone = () => { void unlink(file).catch(() => {}); };
  stream.on("close", gone);
  return { body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, bytes: found.bytes };
}
