// The staff pages about one family take the app's own family id in their address (stage 3 of the app-owned families
// spec), and this is where each of them first checks it. It reads one row, by the id it is given.
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family } from "@/lib/db/schema";
import { isUuid } from "@/lib/seasons/ids";
import { asAppFamilyId, type AppFamilyId } from "./ids";

/**
 * The family record a staff page's address names, active or not: the segment comes from the browser, so anything that
 * isn't a uuid is refused before it reaches a uuid column (where it would throw), and a uuid that names no family
 * record (a student's, a guardian's, one never made) answers null. The id returned is the one read from the table.
 * Each page then finds what it needs of the family through its own area's lookup, which takes this id.
 */
export async function familyRecordAt(segment: string): Promise<AppFamilyId | null> {
  if (!isUuid(segment)) return null;
  const [f] = await db.select({ id: family.id }).from(family).where(eq(family.id, asAppFamilyId(segment.toLowerCase())));
  return f?.id ?? null;
}
