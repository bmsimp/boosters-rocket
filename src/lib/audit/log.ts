import { isIP } from "node:net";
import { db, type Tx } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

export type Actor = { door: "staff" | "parent" | "system"; id: string | null; label: string | null };
export type AuditEntry = {
  actor: Actor; action: string; permission?: string; targetType?: string; targetId?: string;
  before?: unknown; after?: unknown; ip?: string | null;
};

export async function writeAudit(e: AuditEntry, tx?: Tx): Promise<void> {
  const ip = e.ip && isIP(e.ip) ? e.ip : null;
  await (tx ?? db).insert(auditLog).values({
    door: e.actor.door, actorId: e.actor.id, actorLabel: e.actor.label,
    action: e.action, permission: e.permission ?? null,
    targetType: e.targetType ?? null, targetId: e.targetId ?? null,
    before: (e.before ?? null) as never, after: (e.after ?? null) as never, ip,
  });
}
