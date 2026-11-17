import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { adminCount } from "@/lib/auth/bootstrap";

/** Where to send someone who reaches the first Admin step before the club has a name. */
export const CLUB_FIRST_URL = "/setup?step=club&error=club_first";

/** The setting the Club settings are saved under (src/lib/settings/club.ts). */
const CLUB_KEY = "club";

/** True once the club's name, short name, color and time zone have been saved, by setup or on the Club page. */
export async function clubSaved(): Promise<boolean> {
  const [row] = await db.select({ key: setting.key }).from(setting).where(eq(setting.key, CLUB_KEY));
  return row !== undefined;
}

/**
 * Whether setup asks for the club: only on a new installation, one with no Admin yet. A setup reopened on an existing
 * installation (scripts/poc/reopen-setup.sh) has its Admins and its club already, and is not asked again.
 */
export async function setupAsksForClub(): Promise<boolean> {
  return (await adminCount()) === 0;
}

/** Whether the first Admin step must wait for the club step: a new installation whose club isn't saved yet. */
export async function clubStepOwed(): Promise<boolean> {
  return (await setupAsksForClub()) && !(await clubSaved());
}
