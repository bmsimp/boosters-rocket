import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { normalizeHex } from "@/lib/theme/contrast";
import { writeAudit, type Actor } from "@/lib/audit/log";

export type ClubSettings = { name: string; shortName: string; colour: string; treasurerEmail: string | null };

const DEFAULTS: ClubSettings = { name: "Booster Rocket", shortName: "BR", colour: "#5b2a86", treasurerEmail: null };
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

export async function getClubSettings(): Promise<ClubSettings> {
  const [row] = await db.select().from(setting).where(eq(setting.key, KEY));
  return row ? { ...DEFAULTS, ...(row.value as Partial<ClubSettings>) } : DEFAULTS;
}

export async function saveClubSettings(raw: unknown, actor: Actor, ip: string | null):
  Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  const before = await getClubSettings();
  await db.transaction(async (tx) => {
    await tx.insert(setting).values({ key: KEY, value: parsed.data })
      .onConflictDoUpdate({ target: setting.key, set: { value: parsed.data, updatedAt: new Date() } });
    await writeAudit({ actor, action: "settings.club.save", permission: "Settings.Club.ReadWrite",
      targetType: "setting", targetId: KEY, before, after: parsed.data, ip }, tx);
  });
  return { ok: true };
}
