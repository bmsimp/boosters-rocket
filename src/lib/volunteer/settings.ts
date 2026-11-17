import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

/** The club's volunteering settings. `cutoffHours`: how long before a shift starts a guardian can still cancel it themselves (v1 spec §11.2). */
export type VolunteerSettings = { cutoffHours: number };
export const VOLUNTEER_SETTINGS_KEY = "volunteer.settings";
export const DEFAULT_CUTOFF_HOURS = 48;
export const CUTOFF_MAX = 720; // 30 days

const isCutoff = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= CUTOFF_MAX;

export async function getVolunteerSettings(): Promise<VolunteerSettings> {
  const [row] = await db.select().from(setting).where(eq(setting.key, VOLUNTEER_SETTINGS_KEY));
  const stored = (row?.value ?? {}) as { cutoffHours?: unknown };
  return { cutoffHours: isCutoff(stored.cutoffHours) ? stored.cutoffHours : DEFAULT_CUTOFF_HOURS };
}

export async function saveVolunteerSettings(input: { cutoffHours: unknown }, o: { actor: Actor; ip: string | null; permission?: string }): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  if (!isCutoff(input.cutoffHours)) return { ok: false, errors: [`Enter the cut-off as a whole number of hours, from 0 to ${CUTOFF_MAX}.`] };
  const after: VolunteerSettings = { cutoffHours: input.cutoffHours };
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(setting).where(eq(setting.key, VOLUNTEER_SETTINGS_KEY)).for("update");
    const before = row ? { cutoffHours: (row.value as { cutoffHours?: unknown }).cutoffHours ?? null } : { cutoffHours: null };
    await tx.insert(setting).values({ key: VOLUNTEER_SETTINGS_KEY, value: after }).onConflictDoUpdate({ target: setting.key, set: { value: after, updatedAt: new Date() } });
    await writeAudit({ actor: o.actor, action: "volunteer.settings.save", permission: o.permission, targetType: "setting", targetId: VOLUNTEER_SETTINGS_KEY, ip: o.ip, before, after }, tx);
  });
  return { ok: true };
}
