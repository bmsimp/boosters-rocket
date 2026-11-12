import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, signinCode } from "@/lib/db/schema";
import type { Actor } from "@/lib/audit/log";

export type GuardianRow = typeof guardian.$inferSelect;

export const parentActor = (p: { id: string; email: string }): Actor => ({ door: "parent", id: p.id, label: p.email });

/** Serializes changes that claim an email address, so two staff adding the same address can't make two people. */
export const lockEmail = (tx: Tx, email: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.parent_email:${email}`}))`);

/** Ends every session the person has, at once (spec §1 The session). Sessions are read from the database on each request. */
export async function endParentSessions(parentId: string, tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ id: string }>(sql`DELETE FROM parent_auth_session
    WHERE user_id IN (SELECT id FROM parent_auth_user WHERE parent_id = ${parentId}) RETURNING id`);
  return Array.from(rows as ArrayLike<{ id: string }>).length;
}

/** Ends the person's sessions that are in one family (spec §2 Closing a link). Sessions in their other families carry on. */
export async function endFamilySessions(parentId: string, familyQboId: string, tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ id: string }>(sql`DELETE FROM parent_auth_session
    WHERE family_qbo_id = ${familyQboId} AND user_id IN (SELECT id FROM parent_auth_user WHERE parent_id = ${parentId}) RETURNING id`);
  return Array.from(rows as ArrayLike<{ id: string }>).length;
}

export async function enabledGuardianRows(parentId: string, tx?: Tx): Promise<GuardianRow[]> {
  return (tx ?? db).select().from(guardian)
    .where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"))).orderBy(guardian.familyQboId);
}

export async function deleteUnusedSigninCodes(parentId: string, tx: Tx): Promise<void> {
  await tx.delete(signinCode).where(and(eq(signinCode.parentId, parentId), isNull(signinCode.usedAt)));
}
