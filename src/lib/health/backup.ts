import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

/** Written by scripts/backup.sh after a backup it could read back; nothing in the portal writes it. */
export const BACKUP_KEY = "backup.last_success";
export type LastBackup = { at: string; file: string | null; bytes: number | null };

/** When a backup last succeeded, or null when none has been recorded. A value that isn't a time counts as none. */
export async function lastBackup(): Promise<LastBackup | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, BACKUP_KEY));
  const v = row?.value as { at?: unknown; file?: unknown; bytes?: unknown } | undefined;
  if (!v || typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  return { at: new Date(v.at).toISOString(), file: typeof v.file === "string" ? v.file.slice(0, 200) : null, bytes: typeof v.bytes === "number" && Number.isFinite(v.bytes) ? v.bytes : null };
}
