import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { role, roleAssignment, staffUser } from "@/lib/db/schema";
import { getSetupState } from "@/lib/setup/state";
import { writeAudit } from "@/lib/audit/log";

/** Number of active staff who hold the built-in Admin role. Invited (not yet signed in) and disabled people do not count. */
export async function adminCount(tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM role_assignment ra
    JOIN role r ON r.id = ra.role_id JOIN staff_user s ON s.id = ra.staff_user_id
    WHERE r.key = 'admin' AND s.status = 'active'`);
  const first = Array.from(rows as ArrayLike<{ n: number }>)[0];
  return Number(first?.n ?? 0);
}

/** Creates the first Admin while setup is open at the Admin step, if `email` is the Admin email setup recorded and no Admin exists. */
export async function claimBootstrapAdmin(email: string): Promise<string | null> {
  const got = email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.bootstrap_admin'))`);
    const setup = await getSetupState(tx);
    if (setup.status !== "open" || setup.step !== "admin" || !setup.adminEmail || setup.adminEmail !== got) return null;
    if ((await adminCount(tx)) > 0) return null;
    const [adminRole] = await tx.select().from(role).where(eq(role.key, "admin"));
    if (!adminRole) throw new Error("Admin role missing");
    // The name setup asked for; a record already there keeps its own name unless it was only ever the email.
    const name = setup.adminName ?? got;
    const [s] = await tx.insert(staffUser).values({ email: got, name, status: "active" })
      .onConflictDoUpdate({ target: staffUser.email, set: { status: "active", updatedAt: new Date(),
        name: sql`CASE WHEN ${staffUser.name} = ${staffUser.email} THEN ${name} ELSE ${staffUser.name} END` } }).returning();
    await tx.insert(roleAssignment).values({ roleId: adminRole.id, staffUserId: s!.id }).onConflictDoNothing();
    await writeAudit({ actor: { door: "system", id: null, label: "bootstrap" }, action: "admin.bootstrap",
      targetType: "staff_user", targetId: s!.id, after: { email: got, name: s!.name, role: "Admin" } }, tx);
    return s!.id;
  });
}
