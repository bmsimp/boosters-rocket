import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { staffUser } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

export const STAFF_NAME_MAX = 100;

/** A staff member's name: trimmed, 1 to 100 characters, on one line. The first Admin's name in setup follows it too. */
export function parseStaffName(raw: unknown): { ok: true; name: string } | { ok: false; errors: string[] } {
  if (typeof raw !== "string" || raw.length > 1000) return { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
  const name = raw.trim();
  if (name === "") return { ok: false, errors: ["Enter a name."] };
  if (name.length > STAFF_NAME_MAX) return { ok: false, errors: [`A name can be ${STAFF_NAME_MAX} characters at most.`] };
  if (/[\r\n\t]/.test(name)) return { ok: false, errors: ["A name goes on one line."] };
  return { ok: true, name };
}

/**
 * Changes a staff member's name, audited with before and after in the same transaction. `permission` is what the caller
 * was let in by: Staff.Users.ReadWrite for anyone's name, or null for a person changing their own (staffSelfAction),
 * whose caller passes their own id.
 */
export async function renameStaff(id: string, raw: unknown, o: { actor: Actor; ip: string | null; permission: string | null }):
  Promise<{ ok: true; message: string } | { ok: false; errors: string[] }> {
  const parsed = parseStaffName(raw);
  if (!parsed.ok) return parsed;
  return db.transaction(async (tx) => {
    const [person] = await tx.select().from(staffUser).where(eq(staffUser.id, id)).for("update");
    if (!person) return { ok: false as const, errors: ["That person is no longer on the staff list."] };
    if (person.name === parsed.name) return { ok: true as const, message: "Saved." };
    await tx.update(staffUser).set({ name: parsed.name, updatedAt: new Date() }).where(eq(staffUser.id, id));
    await writeAudit({ actor: o.actor, action: "staff.name.save", permission: o.permission ?? undefined, targetType: "staff_user", targetId: id,
      before: { name: person.name }, after: { name: parsed.name }, ip: o.ip }, tx);
    return { ok: true as const, message: "Saved." };
  });
}
