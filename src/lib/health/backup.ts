import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

/** Written by scripts/backup.sh after a backup it could read back; nothing in the portal writes it. */
export const BACKUP_KEY = "backup.last_success";
/**
 * Whether Documenso's database was in that backup: its file, "none" when backup.sh left it out (the server had none,
 * or it was told to), or "unknown" for a record from a backup.sh older than Documenso's part in it.
 */
export type DocumensoInBackup = { file: string; bytes: number | null } | "none" | "unknown";
export type LastBackup = { at: string; file: string | null; bytes: number | null; documenso: DocumensoInBackup };

const bytesOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function documensoOf(v: Record<string, unknown>): DocumensoInBackup {
  if (!("documenso" in v)) return "unknown";
  const d = v.documenso as { file?: unknown; bytes?: unknown } | null;
  if (d === null) return "none";
  if (typeof d === "object" && typeof d.file === "string") return { file: d.file.slice(0, 200), bytes: bytesOf(d.bytes) };
  return "unknown";
}

/** When a backup last succeeded, or null when none has been recorded. A value that isn't a time counts as none. */
export async function lastBackup(): Promise<LastBackup | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, BACKUP_KEY));
  const v = row?.value as { at?: unknown; file?: unknown; bytes?: unknown } | undefined;
  if (!v || typeof v !== "object" || typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  return { at: new Date(v.at).toISOString(), file: typeof v.file === "string" ? v.file.slice(0, 200) : null, bytes: bytesOf(v.bytes), documenso: documensoOf(v) };
}
