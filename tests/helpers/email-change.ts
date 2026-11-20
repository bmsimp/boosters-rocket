import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import type { AppFamilyId } from "@/lib/families/ids";
import { familyOfSession } from "./db";
import type { SeededParent } from "./parent";

const authUserOf = async (parentId: string) => (await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId)))[0]!.id;

/**
 * Requests to change a parent's sign-in address (src/lib/parents/email-change.ts), stored as an ask would store them:
 * the token's hash, the person, the link and family it was asked under, and the record it would change. The family is
 * the app's own record: `familyId`, or the one a family's QuickBooks id comes to for that person (familyOfSession(), as
 * a session's), or none. The token itself is returned, as the link in the email would carry it.
 */
export const emailChangeToken = () => randomBytes(32).toString("base64url");
export const hashOfToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function seedEmailChange(o: {
  parentId: string; guardianId: string | null; familyQboId?: string | null; familyId?: AppFamilyId | null; newEmail: string;
  token?: string; expiresAt?: Date; usedAt?: Date | null;
}): Promise<{ id: string; token: string }> {
  const token = o.token ?? emailChangeToken();
  const familyId = o.familyId ?? (o.familyQboId ? await familyOfSession(await authUserOf(o.parentId), o.familyQboId) : null);
  const [row] = await db.insert(parentEmailChange).values({
    parentId: o.parentId, guardianId: o.guardianId, familyId, newEmail: o.newEmail,
    tokenHash: hashOfToken(token), expiresAt: o.expiresAt ?? new Date(Date.now() + 24 * 3_600_000), usedAt: o.usedAt ?? null,
  }).returning({ id: parentEmailChange.id });
  return { id: row!.id, token };
}

/** A family's pending change of sign-in address: the token its link carries, the address it would change to, and both as markers. */
export type FamilyEmailChange = { token: string; newEmail: string; markers: string[] };

/** For seedTwoFamilies(): each parent has asked to change their sign-in address, and not yet opened the link. */
export async function seedTwoFamilyEmailChanges(a: SeededParent, b: SeededParent): Promise<{ a: FamilyEmailChange; b: FamilyEmailChange }> {
  const one = async (p: SeededParent, newEmail: string): Promise<FamilyEmailChange> => {
    const { token } = await seedEmailChange({ parentId: p.identity.parentId, guardianId: p.identity.guardianId, familyId: p.identity.familyId,
      newEmail });
    return { token, newEmail, markers: [newEmail, token] };
  };
  return { a: await one(a, "ansgar.newmail@family-a-moving.example"), b: await one(b, "bettina.newmail@family-b-moving.example") };
}
