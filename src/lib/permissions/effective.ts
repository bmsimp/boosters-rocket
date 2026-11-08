import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { role, roleRule, roleAssignment } from "@/lib/db/schema";
import { expandRules } from "./rules";
import { PERMISSIONS, type Permission } from "./registry";

export type Effective = { isAdmin: boolean; permissions: Set<Permission> };

export async function effectivePermissions(staffUserId: string): Promise<Effective> {
  const rows = await db.select({ roleId: role.id, key: role.key, kind: roleRule.kind, pattern: roleRule.pattern })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .leftJoin(roleRule, eq(roleRule.roleId, role.id))
    .where(eq(roleAssignment.staffUserId, staffUserId));
  if (rows.some((r) => r.key === "admin")) return { isAdmin: true, permissions: new Set(PERMISSIONS) };
  const byRole = new Map<string, { include: string[]; exclude: string[] }>();
  for (const r of rows) {
    const rules = byRole.get(r.roleId) ?? { include: [], exclude: [] };
    if (r.kind && r.pattern) rules[r.kind].push(r.pattern);
    byRole.set(r.roleId, rules);
  }
  const permissions = new Set<Permission>();
  for (const rules of byRole.values()) for (const p of expandRules(rules)) permissions.add(p);
  return { isAdmin: false, permissions };
}

export function can(e: Effective, p: Permission): boolean {
  return e.isAdmin || e.permissions.has(p);
}
