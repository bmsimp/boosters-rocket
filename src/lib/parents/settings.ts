import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

export const PARENTS_KEY = "parents.settings";

/**
 * The Admin's switches for parent sign-ins (spec §3). `everEnabled` stays true once sign-ins have been on: before that
 * the reconcile does nothing and hand-seeded sign-ins work; after it, `signin: false` closes the parent door.
 */
export type ParentSettings = { signin: boolean; everEnabled: boolean; welcome: boolean; requireActiveStudents: boolean; reviewEmails: boolean };
export const DEFAULT_PARENT_SETTINGS: ParentSettings = { signin: false, everEnabled: false, welcome: false, requireActiveStudents: false, reviewEmails: true };

const stored = z.object({ signin: z.boolean(), everEnabled: z.boolean(), welcome: z.boolean(), requireActiveStudents: z.boolean(), reviewEmails: z.boolean() });

/**
 * What a stored value that can't be read means: sign-ins were on and are off, so the parent door is closed and the
 * reconcile does nothing, until an Admin saves the settings again. Failing open (the defaults) would let hand-seeded
 * sign-ins in with nothing keeping them in line with QuickBooks.
 */
export const CLOSED_PARENT_SETTINGS: ParentSettings = { signin: false, everEnabled: true, welcome: false, requireActiveStudents: false, reviewEmails: false };

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

/** The door is closed only when sign-ins were on and an Admin switched them off (or a company change did). */
export const parentDoorClosed = (s: ParentSettings): boolean => s.everEnabled && !s.signin;
