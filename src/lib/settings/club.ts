import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { normalizeHex } from "@/lib/theme/contrast";
import { writeAudit, type Actor } from "@/lib/audit/log";

export type ClubSettings = { name: string; shortName: string; colour: string; treasurerEmail: string | null };

export const DEFAULT_COLOUR = "#5b2a86";
const DEFAULTS: ClubSettings = { name: "Booster Rocket", shortName: "BR", colour: DEFAULT_COLOUR, treasurerEmail: null };
const KEY = "club";

const input = z.object({
  name: z.string().trim().min(1, "Club name is required.").max(60, "Club name is too long (60 characters at most)."),
  shortName: z.string().trim().min(1, "Short name is required.").max(4, "Short name must be 4 characters or fewer."),
  colour: z.string().transform((v, ctx) => {
    const hex = normalizeHex(v);
    if (!hex) { ctx.addIssue({ code: "custom", message: "Colour must be a hex value like #5b2a86." }); return z.NEVER; }
    return hex;
  }),
  treasurerEmail: z.string().trim().email("Treasurer email isn't a valid email address.").nullable()
    .or(z.literal("").transform(() => null)),
});

/**
 * The colour is always a validated hex: a stored value that fails normalization falls back to the default,
 * and storedColourValid says whether that happened, so callers can warn instead of failing silently.
 */
export type ClubSettingsRead = ClubSettings & { storedColourValid: boolean };

export async function getClubSettings(): Promise<ClubSettingsRead> {
  const [row] = await db.select().from(setting).where(eq(setting.key, KEY));
  if (!row) return { ...DEFAULTS, storedColourValid: true };
  const merged = { ...DEFAULTS, ...(row.value as Partial<ClubSettings>) };
  const hex = typeof merged.colour === "string" ? normalizeHex(merged.colour) : null;
  return { ...merged, colour: hex ?? DEFAULT_COLOUR, storedColourValid: hex !== null };
}

export async function saveClubSettings(raw: unknown, actor: Actor, ip: string | null):
  Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  const { name, shortName, colour, treasurerEmail } = await getClubSettings();
  const before: ClubSettings = { name, shortName, colour, treasurerEmail };
  await db.transaction(async (tx) => {
    await tx.insert(setting).values({ key: KEY, value: parsed.data })
      .onConflictDoUpdate({ target: setting.key, set: { value: parsed.data, updatedAt: new Date() } });
    await writeAudit({ actor, action: "settings.club.save", permission: "Settings.Club.ReadWrite",
      targetType: "setting", targetId: KEY, before, after: parsed.data, ip }, tx);
  });
  return { ok: true };
}
