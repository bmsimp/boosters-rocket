import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

export const PARENTS_KEY = "parents.settings";

/**
 * The Admin's switches for parent sign-ins (spec §3; open question 15 of the app-owned families spec). `everEnabled`
 * stays true once sign-ins have been on: before that hand-seeded sign-ins work; after it, `signin: false` closes the
 * parent door. `requireActiveStudents` is read by the gate (enterableGuardianRows(), ./sessions.ts).
 */
export type ParentSettings = { signin: boolean; everEnabled: boolean; welcome: boolean; requireActiveStudents: boolean };
export const DEFAULT_PARENT_SETTINGS: ParentSettings = { signin: false, everEnabled: false, welcome: false, requireActiveStudents: false };

/**
 * A plain object, which strips keys it doesn't name: a value stored before the held-address review went (stage 3 of
 * the app-owned families spec) still holds `reviewEmails`, and reads as the same switches. A key added here later
 * needs a default, or every value stored before it fails to parse and closes the door (CLOSED_PARENT_SETTINGS).
 */
const stored = z.object({ signin: z.boolean(), everEnabled: z.boolean(), welcome: z.boolean(), requireActiveStudents: z.boolean() });

/**
 * What a stored value that can't be read means: sign-ins were on and are off, so the parent door is closed, until an
 * Admin saves the settings again. Failing open (the defaults) would let hand-seeded sign-ins in.
 */
export const CLOSED_PARENT_SETTINGS: ParentSettings = { signin: false, everEnabled: true, welcome: false, requireActiveStudents: false };

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

/** The door is closed only when sign-ins were on and an Admin switched them off. */
export const parentDoorClosed = (s: ParentSettings): boolean => s.everEnabled && !s.signin;
