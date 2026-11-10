import { describe, it, expect, vi, beforeEach } from "vitest";

const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string } }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async () => {} }));

import { db } from "@/lib/db/client";
import { auditLog, role, roleRule, roleAssignment } from "@/lib/db/schema";
import { saveMailSettingsAction } from "@/app/staff/(app)/settings/mail/actions";
import { AccessDenied } from "@/lib/guards";
import { resetDb, seedStaff } from "../helpers/db";

const form = () => { const f = new FormData(); for (const [k, v] of Object.entries({ method: "smtp", host: "smtp.example.org", port: "587", security: "starttls", username: "u", from: "c@example.org", password: "p" })) f.set(k, v); return f; };

describe("Settings, Mail actions", () => {
  beforeEach(resetDb);

  it("refuses staff whose custom role includes everything, and audits the refusal", async () => {
    const s = await seedStaff({ email: "treasurer@club.org" });
    const [r] = await db.insert(role).values({ key: "everything", name: "Everything" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
    await expect(saveMailSettingsAction(form())).rejects.toBeInstanceOf(AccessDenied);
    expect((await db.select().from(auditLog)).map((a) => [a.action, a.permission])).toEqual([["access.refused", "Settings.Mail.ReadWrite"]]);
  });

  it("lets an Admin save", async () => {
    const s = await seedStaff({ email: "admin@club.org", admin: true });
    who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
    expect(await saveMailSettingsAction(form())).toEqual({ ok: true });
    expect((await db.select().from(auditLog)).find((a) => a.action === "settings.mail.save")).toMatchObject({ actorId: s.id, permission: "Settings.Mail.ReadWrite" });
  });
});
