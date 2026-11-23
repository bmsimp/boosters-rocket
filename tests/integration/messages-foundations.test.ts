import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, asParent, renderPage, pageOutcome } from "../helpers/signed-in";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, clubMessage, messageMail, messageRead, messageVersion, role, roleAssignment, roleRule, setting, staffUser } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { GRANTABLE } from "@/lib/permissions/registry";
import { MESSAGES_SETTING, messagesEmailAllowed } from "@/lib/settings/messages";
import MessagesSettingsPage from "@/app/staff/(app)/settings/messages/page";
import { setMessagesEmailAction } from "@/app/staff/(app)/settings/messages/actions";
import StaffAccountPage from "@/app/staff/(app)/account/page";
import { setMyContactEmailAction } from "@/app/staff/(app)/account/actions";
import { RAIL_STATUS } from "@/app/staff/(app)/settings/statuses";
import { resetDb, seedParent, seedStaff } from "../helpers/db";
import { seedSignedInParent } from "../helpers/parent";

const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const contactOf = async (id: string) => (await db.select({ c: staffUser.contactEmail }).from(staffUser).where(eq(staffUser.id, id)))[0]!.c;

async function staffWith(email: string, ...patterns: string[]) {
  const s = await seedStaff({ email, name: email });
  if (patterns.length) {
    const [r] = await db.insert(role).values({ key: `r-${email}`, name: `Role ${email}` }).returning();
    await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  }
  return s;
}

describe("the club's setting for emailing messages", () => {
  beforeEach(resetDb);

  it("is off until an Admin turns it on, audited with before and after, and back off again", async () => {
    expect(await messagesEmailAllowed()).toBe(false);
    expect(await RAIL_STATUS.messages([])).toEqual({ tone: "neutral", words: "Emailing off" });
    const admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
    asStaff(admin);
    expect(await setMessagesEmailAction(true)).toMatchObject({ ok: true });
    expect(await messagesEmailAllowed()).toBe(true);
    expect(await RAIL_STATUS.messages([])).toEqual({ tone: "done", words: "Emailing on" });
    // Saving what is set writes nothing.
    expect(await setMessagesEmailAction(true)).toMatchObject({ ok: true });
    expect(await setMessagesEmailAction(false)).toMatchObject({ ok: true });
    expect(await messagesEmailAllowed()).toBe(false);
    const rows = await audits("settings.messages.change");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actorId: admin.id, permission: "Settings.Messages.ReadWrite", targetType: "setting", targetId: MESSAGES_SETTING,
      before: { emailAllowed: false }, after: { emailAllowed: true } });
    expect(rows[1]).toMatchObject({ before: { emailAllowed: true }, after: { emailAllowed: false } });
  });

  it("refuses anything but a boolean, and reads anything stored but true as off", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", admin: true }));
    for (const bad of ["true", 1, null, undefined, {}]) expect(await setMessagesEmailAction(bad)).toMatchObject({ ok: false });
    expect(await audits("settings.messages.change")).toHaveLength(0);
    await db.insert(setting).values({ key: MESSAGES_SETTING, value: { emailAllowed: "yes" } });
    expect(await messagesEmailAllowed()).toBe(false);
  });

  it("can't be switched by the widest custom role, nor by a parent or nobody", async () => {
    const widest = await staffWith("wide@club.org", ...GRANTABLE);
    asStaff(widest);
    await expect(setMessagesEmailAction(true)).rejects.toBeInstanceOf(AccessDenied);
    asParent((await seedSignedInParent()).identity);
    await expect(setMessagesEmailAction(true)).rejects.toBeInstanceOf(AccessDenied);
    expect(await messagesEmailAllowed()).toBe(false);
  });

  it("shows an Admin the switch, and someone who may see the club settings what is set with the line saying who can change it", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", admin: true }));
    const admin = await renderPage(MessagesSettingsPage);
    expect(admin).toContain("Off: messages are only in the portal");
    expect(admin).toContain("Allow messages to be emailed to families");
    asStaff(await staffWith("reader@club.org", "Settings.Club.Read"));
    const reader = await renderPage(MessagesSettingsPage);
    expect(reader).toContain("Off: messages are only in the portal");
    expect(reader).toContain("Only an Admin can change this.");
    expect(reader).not.toContain("<button");
    asStaff(await staffWith("roster@club.org", "Roster.Read"));
    expect("html" in await pageOutcome(MessagesSettingsPage)).toBe(false);
  });
});

describe("a staff member's contact email", () => {
  beforeEach(resetDb);

  it("starts as their sign-in address, can be set to another (trimmed, lower-cased) and taken back, audited each time", async () => {
    const me = await staffWith("cam@club.org");
    asStaff(me);
    expect(await renderPage(StaffAccountPage)).toContain('value="cam@club.org"');
    expect(await setMyContactEmailAction("  Band-Director@Club.org ")).toEqual({ ok: true, message: "Saved. Families see this address." });
    expect(await contactOf(me.id)).toBe("band-director@club.org");
    const page = await renderPage(StaffAccountPage);
    expect(page).toContain('value="band-director@club.org"');
    expect(page).toContain("Use my sign-in address");
    expect(await setMyContactEmailAction(null)).toEqual({ ok: true, message: "Saved. Families see your sign-in address." });
    expect(await contactOf(me.id)).toBeNull();
    // Typing the sign-in address is the same as going back to it, so a later change of sign-in address is followed.
    expect(await setMyContactEmailAction("cam@club.org")).toMatchObject({ ok: true });
    expect(await contactOf(me.id)).toBeNull();
    const rows = await audits("staff.contact_email.change");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actorId: me.id, permission: null, targetType: "staff_user", targetId: me.id,
      before: { contactEmail: "cam@club.org", own: false }, after: { contactEmail: "band-director@club.org", own: true } });
    expect(rows[1]).toMatchObject({ before: { contactEmail: "band-director@club.org", own: true }, after: { contactEmail: "cam@club.org", own: false } });
  });

  it("refuses what isn't an address, and changes only the session's own record", async () => {
    const me = await staffWith("cam@club.org");
    const other = await staffWith("dee@club.org");
    asStaff(me);
    for (const bad of ["", "   ", "not an address", `${"a".repeat(250)}@club.org`, 42, {}, undefined, "x".repeat(1001)]) {
      expect(await setMyContactEmailAction(bad), String(bad)).toMatchObject({ ok: false });
    }
    // The action takes no id: a second argument is never read.
    expect(await (setMyContactEmailAction as (...a: unknown[]) => Promise<unknown>)("mine@club.org", other.id)).toMatchObject({ ok: true });
    expect(await contactOf(me.id)).toBe("mine@club.org");
    expect(await contactOf(other.id)).toBeNull();
    expect(await audits("staff.contact_email.change")).toHaveLength(1);
  });

  it("is refused to a parent session and to nobody", async () => {
    const s = await staffWith("eve@club.org");
    await expect(setMyContactEmailAction("x@club.org")).rejects.toBeInstanceOf(AccessDenied);
    asParent((await seedSignedInParent()).identity);
    await expect(setMyContactEmailAction("x@club.org")).rejects.toBeInstanceOf(AccessDenied);
    expect(await contactOf(s.id)).toBeNull();
  });
});

describe("the messages tables", () => {
  beforeEach(resetDb);

  it("hold one version number per message, one read row per message and parent, and one mail row per version and address", async () => {
    const sam = await seedStaff({ email: "sam@club.org" });
    const ana = await seedParent({ name: "Ana" });
    const [m] = await db.insert(clubMessage).values({ postedBy: sam.id }).returning();
    const body = { type: "doc", content: [] };
    const [v] = await db.insert(messageVersion).values({ messageId: m!.id, n: 1, title: "Picture day", body }).returning();
    await expect(db.insert(messageVersion).values({ messageId: m!.id, n: 1, title: "Again", body })).rejects.toThrow();
    await expect(db.insert(messageVersion).values({ messageId: m!.id, n: 0, title: "Zero", body })).rejects.toThrow();
    await expect(db.insert(messageVersion).values({ messageId: m!.id, n: 2, title: "", body })).rejects.toThrow();
    await expect(db.insert(messageVersion).values({ messageId: m!.id, n: 2, title: "x".repeat(121), body })).rejects.toThrow();
    await db.insert(messageRead).values({ messageId: m!.id, parentId: ana.id, versionN: 1 });
    await expect(db.insert(messageRead).values({ messageId: m!.id, parentId: ana.id, versionN: 1 })).rejects.toThrow();
    await db.insert(messageMail).values({ versionId: v!.id, address: "ana@example.com" });
    await expect(db.insert(messageMail).values({ versionId: v!.id, address: "ana@example.com" })).rejects.toThrow();
    await expect(db.insert(messageMail).values({ versionId: v!.id, address: "Ben@Example.com" })).rejects.toThrow();
    // A delete names who deleted it exactly while it says when.
    await expect(db.update(clubMessage).set({ deletedAt: new Date() }).where(eq(clubMessage.id, m!.id))).rejects.toThrow();
    await db.update(clubMessage).set({ deletedAt: new Date(), deletedBy: sam.id }).where(eq(clubMessage.id, m!.id));
  });
});
