import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { normalizeHex } from "@/lib/theme/contrast";
import { writeAudit, type Actor } from "@/lib/audit/log";

/** `timeZone` is the IANA name of the zone the club keeps its calendar in ("America/Chicago"): what "today" means for a step's dates and a due date. */
export type ClubSettings = { name: string; shortName: string; color: string; treasurerEmail: string | null; timeZone: string };

export const DEFAULT_COLOR = "#1e1b4b";
export const DEFAULT_TIME_ZONE = "UTC";
const DEFAULTS: ClubSettings = { name: "Boosters Rocket", shortName: "BR", color: DEFAULT_COLOR, treasurerEmail: null, timeZone: DEFAULT_TIME_ZONE };
const KEY = "club";

/** True for a time zone name this server can keep a calendar in: an IANA name such as "America/Chicago", or "UTC". Never an offset such as "+05:00". */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

/** The time zones offered on the Club page: UTC first, then every zone this server knows, by name, and the club's own if it goes by another name. */
export function timeZoneChoices(current?: string): string[] {
  const zones = [DEFAULT_TIME_ZONE, ...Intl.supportedValuesOf("timeZone").filter((z) => z !== DEFAULT_TIME_ZONE)];
  return current && !zones.includes(current) ? [...zones, current] : zones;
}

/** The calendar date (YYYY-MM-DD) it is in a time zone at an instant. Pure. */
export function calendarDayIn(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const input = z.object({
  name: z.string().trim().min(1, "Club name is required.").max(60, "Club name is too long (60 characters at most)."),
  shortName: z.string().trim().min(1, "Short name is required.").max(4, "Short name must be 4 characters or fewer."),
  color: z.string().transform((v, ctx) => {
    const hex = normalizeHex(v);
    if (!hex) { ctx.addIssue({ code: "custom", message: "Color must be a hex value like #5b2a86." }); return z.NEVER; }
    return hex;
  }),
  treasurerEmail: z.string().trim().email("Treasurer email isn't a valid email address.").nullable()
    .or(z.literal("").transform(() => null)),
  // Left out (a caller that doesn't set it), the stored zone is kept.
  timeZone: z.string().trim().refine(isTimeZone, "Choose a time zone from the list.").optional(),
});

/**
 * The color is always a validated hex: a stored value that fails normalization falls back to the default,
 * and storedColorValid says whether that happened, so callers can warn instead of failing silently.
 */
export type ClubSettingsRead = ClubSettings & { storedColorValid: boolean };

export async function getClubSettings(): Promise<ClubSettingsRead> {
  const [row] = await db.select().from(setting).where(eq(setting.key, KEY));
  if (!row) return { ...DEFAULTS, storedColorValid: true };
  const stored = row.value as Partial<ClubSettings>;
  const merged = { ...DEFAULTS, ...stored };
  const raw: unknown = stored.color !== undefined ? stored.color : DEFAULTS.color;
  const hex = typeof raw === "string" ? normalizeHex(raw) : null;
  // A stored zone this server can't use falls back to UTC, so a date is always computable.
  return { ...merged, color: hex ?? DEFAULT_COLOR, timeZone: isTimeZone(stored.timeZone) ? stored.timeZone : DEFAULT_TIME_ZONE, storedColorValid: hex !== null };
}

/**
 * Today's calendar date (YYYY-MM-DD) for the club: the date in the club's own time zone, whatever zone the server or
 * the viewer is in. The one place the portal decides which day it is for a step's date range or a due date.
 */
export async function clubToday(at: Date = new Date()): Promise<string> {
  return calendarDayIn((await getClubSettings()).timeZone, at);
}

export async function saveClubSettings(raw: unknown, actor: Actor, ip: string | null):
  Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  const { name, shortName, color, treasurerEmail, timeZone } = await getClubSettings();
  const before: ClubSettings = { name, shortName, color, treasurerEmail, timeZone };
  const after: ClubSettings = { ...parsed.data, timeZone: parsed.data.timeZone ?? timeZone };
  await db.transaction(async (tx) => {
    await tx.insert(setting).values({ key: KEY, value: after })
      .onConflictDoUpdate({ target: setting.key, set: { value: after, updatedAt: new Date() } });
    await writeAudit({ actor, action: "settings.club.save", permission: "Settings.Club.ReadWrite",
      targetType: "setting", targetId: KEY, before, after, ip }, tx);
  });
  return { ok: true };
}
