import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { role, roleAssignment, staffUser } from "@/lib/db/schema";
import { env } from "@/env";
import { writeAudit } from "@/lib/audit/log";

/** Number of active (not disabled) staff who hold the built-in Admin role. */
export async function adminCount(tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM role_assignment ra
    JOIN role r ON r.id = ra.role_id JOIN staff_user s ON s.id = ra.staff_user_id
    WHERE r.key = 'admin' AND s.status <> 'disabled'`);
  const first = Array.from(rows as ArrayLike<{ n: number }>)[0];
  return Number(first?.n ?? 0);
}

/** Creates the first Admin if none exists and `email` matches BOOTSTRAP_ADMIN_EMAIL. Returns the staff user id. */
export async function claimBootstrapAdmin(email: string): Promise<string | null> {
  const wanted = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const got = email.trim().toLowerCase();
  if (!wanted || wanted !== got) return null;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.bootstrap_admin'))`);
    if ((await adminCount(tx)) > 0) return null;
    const [adminRole] = await tx.select().from(role).where(eq(role.key, "admin"));
    if (!adminRole) throw new Error("Admin role missing");
    const [s] = await tx.insert(staffUser).values({ email: got, name: got, status: "active" })
      .onConflictDoUpdate({ target: staffUser.email, set: { status: "active", updatedAt: new Date() } }).returning();
    await tx.insert(roleAssignment).values({ roleId: adminRole.id, staffUserId: s!.id }).onConflictDoNothing();
    await writeAudit({ actor: { door: "system", id: null, label: "bootstrap" }, action: "admin.bootstrap",
      targetType: "staff_user", targetId: s!.id, after: { email: got, role: "Admin" } }, tx);
    return s!.id;
  });
}
