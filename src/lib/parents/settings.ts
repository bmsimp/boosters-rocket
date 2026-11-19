import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

export const PARENTS_KEY = "parents.settings";

/**
 * The Admin's switches for parent sign-ins (spec §3; open question 15 of the app-owned families spec: the switch is how
 * an Admin says the club is ready). The parent door is open only while `signin` is on (parentDoorClosed()), so a
 * guardian staff add before then can't sign in until it is. `requireActiveStudents` is read by the gate
 * (enterableGuardianRows(), ./sessions.ts). `level` is the club's sign-in level of the sign-in release (section 6 of
 * the app-owned families spec, "Signing in"; open questions 21 and 24): Standard or Strict. Nothing writes it or reads
 * it yet (slice SI-1): every value reads Standard, and every save keeps the level stored. No page names it; it is in
 * the before and after of each `settings.parents.save` audit row, as stored, which the audit page shows as JSON. A save
 * after a stored value that failed to parse stores the closed state, at Standard: harmless while nothing stores Strict,
 * and SI-10, which first stores it, keeps a readable level through such a save or refuses it.
 */
export const SIGNIN_LEVELS = ["standard", "strict"] as const;
export type SigninLevel = (typeof SIGNIN_LEVELS)[number];
export type ParentSettings = { signin: boolean; welcome: boolean; requireActiveStudents: boolean; level: SigninLevel };
export const DEFAULT_PARENT_SETTINGS: ParentSettings = { signin: false, welcome: false, requireActiveStudents: false, level: "standard" };

/**
 * A plain object, which strips keys it doesn't name: a value stored before the held-address review went (stage 3 of
 * the app-owned families spec) still holds `reviewEmails`, and one stored before stage 3's slice 7b `everEnabled`
 * (which once left the door open until sign-ins were first switched on); each reads as the same switches. A key added
 * here later needs a default, or every value stored before it fails to parse and closes the door
 * (CLOSED_PARENT_SETTINGS): `level`, added by the sign-in release's first slice, reads Standard when absent, and a
 * level that is neither word fails the parse, so it closes the door rather than reading as either.
 */
const stored = z.object({ signin: z.boolean(), welcome: z.boolean(), requireActiveStudents: z.boolean(), level: z.enum(SIGNIN_LEVELS).default("standard") });

/**
 * What a stored value that can't be read means: sign-ins are off, so the parent door is closed, until an Admin saves
 * the settings again. Since stage 3's slice 7b the defaults close the door too.
 */
export const CLOSED_PARENT_SETTINGS: ParentSettings = { signin: false, welcome: false, requireActiveStudents: false, level: "standard" };

/** `undefined` is no stored row: the defaults. Anything stored that doesn't parse is the closed state. */
export function parseParentSettings(value: unknown): ParentSettings {
  if (value === undefined) return { ...DEFAULT_PARENT_SETTINGS };
  const parsed = stored.safeParse(value);
  return parsed.success ? parsed.data : { ...CLOSED_PARENT_SETTINGS };
}

export async function getParentSettings(tx?: Tx): Promise<ParentSettings> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, PARENTS_KEY));
  return row ? parseParentSettings(row.value) : { ...DEFAULT_PARENT_SETTINGS };
}

/** Writes the setting. The caller audits (`settings.parents.save`) in the same transaction. */
export async function putParentSettings(tx: Tx, next: ParentSettings): Promise<void> {
  const value = stored.parse(next);
  await tx.insert(setting).values({ key: PARENTS_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
}

/**
 * The door is closed unless an Admin has switched sign-ins on (the lead's reading of open question 15): before they are
 * first switched on, as after they are switched off. Nothing else opens it.
 */
export const parentDoorClosed = (s: ParentSettings): boolean => !s.signin;
