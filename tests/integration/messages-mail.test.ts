import { describe, it, expect, beforeEach, vi } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string; attachments?: unknown[] };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[], refuse: new Set<string>(), down: false, tried: 0 }));
vi.mock("@/lib/mail/senders", async () => {
  const { MailSendError } = await import("@/lib/mail/types");
  return {
    SMTP_PASSWORD_AAD: "mail:smtp-password",
    buildSender: async () => async (m: Msg) => {
      mail.tried++;
      if (mail.down) throw new MailSendError("The mail server couldn't be reached. (ECONNREFUSED)");
      if (mail.refuse.has(m.to)) throw new MailSendError("The mail server refused this address. (550)", true);
      mail.outbox.push(m);
    },
  };
});

import { asParent, asStaff, pageOutcome, renderPage } from "../helpers/signed-in";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, clubMessage, messageFile, messageMail, messageRead, messageVersion } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { deleteMessageAction, editMessageAction, postMessageAction } from "@/app/staff/(app)/messages/actions";
import { POST as uploadRoute } from "@/app/staff/(app)/messages/files/route";
import StaffMessagesPage from "@/app/staff/(app)/messages/page";
import NewMessagePage from "@/app/staff/(app)/messages/new/page";
import StaffMessagePage from "@/app/staff/(app)/messages/[id]/page";
import EditMessagePage from "@/app/staff/(app)/messages/[id]/edit/page";
import ParentMessagesPage from "@/app/(parent)/messages/page";
import ParentMessagePage from "@/app/(parent)/messages/[id]/page";
import { GET as parentFileRoute } from "@/app/(parent)/messages/files/[id]/route";
import { runDueJobs } from "@/lib/jobs/runner";
import { MESSAGE_MAIL_BATCH, sendMessageMail } from "@/lib/messages/mail";
import { MESSAGES_SETTING } from "@/lib/settings/messages";
import { setting } from "@/lib/db/schema";
import { env } from "@/env";
import { resetDb, seedGuardian, seedParent, seedStaff, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedParentIn, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { JPEG, PDF } from "../helpers/message-files";

/**
 * Club messages, slice 4 (docs/superpowers/specs/2026-11-23-club-messages-design.md, sections 8 and 9, and the email and
 * delete lists of section 13): a post or an edit emailed to every parent's sign-in address once, only while the club
 * allows it and the box is ticked; the worker's batches, three tries and the results staff see; an emailed edit making
 * the message new again; and an Admin's delete. No real mail: the sender is replaced above.
 */
type Staff = { id: string; name: string; email: string };
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.id));
const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const allowEmail = (on: boolean) => db.insert(setting).values({ key: MESSAGES_SETTING, value: { emailAllowed: on } })
  .onConflictDoUpdate({ target: setting.key, set: { value: { emailAllowed: on } } });
const rows = () => db.select({ address: messageMail.address, status: messageMail.status, tries: messageMail.tries, reason: messageMail.reason }).from(messageMail).orderBy(asc(messageMail.address));

function uploadRequest(name: string, bytes: Uint8Array, listed: string[] = []): Request {
  const q = new URLSearchParams({ name });
  for (const id of listed) q.append("listed", id);
  const headers = new Headers({ "content-type": "application/octet-stream", origin: new URL(env.APP_URL).origin, "content-length": String(bytes.byteLength) });
  return new Request(`http://localhost/staff/messages/files?${q}`, { method: "POST", headers, body: bytes as Uint8Array<ArrayBuffer>, duplex: "half" } as RequestInit);
}
async function uploaded(name: string, bytes: Uint8Array, listed: string[] = []): Promise<string> {
  asStaff(coach);
  const r = await (await uploadRoute(uploadRequest(name, bytes, listed))).json() as { ok: true; file: { id: string } } | { ok: false; errors: string[] };
  if (!r.ok) throw new Error(r.errors.join(" "));
  return r.file.id;
}

let coach: Staff, admin: Staff, a: SeededParent, b: SeededParent;
/** Every address the club's message goes to: A's and B's parents, A's second guardian, and one parent in both families. */
let everyone: string[];
beforeEach(async () => {
  await resetDb();
  mail.outbox.length = 0; mail.refuse.clear(); mail.down = false; mail.tried = 0;
  coach = await seedStaff({ email: "coach@club.org", name: "Casey Coach" });
  const { roleAssignment, role, roleRule } = await import("@/lib/db/schema");
  const [r] = await db.insert(role).values({ key: "poster", name: "Poster" }).returning();
  await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "Messages.Post.ReadWrite" });
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: coach.id });
  admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
  a = await seedSignedInParent(FAMILY_A);
  b = await seedSignedInParent(FAMILY_B);
  await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Sigrid Second", email: "sigrid.second@family-a.example" });
  // One person who is a guardian of both families: emailed once.
  const both = (await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Bo Both", email: "bo.both@families.example" })).identity;
  await seedGuardian({ parentId: both.parentId, familyQboId: FAMILY_B.family.qboId, status: "active" });
  // A blocked person, and a person with no family: neither is emailed.
  const blocked = await seedParent({ name: "Blake Blocked", email: "blake.blocked@family-b.example", blocked: true });
  await seedGuardian({ parentId: blocked.id, familyQboId: FAMILY_B.family.qboId, status: "active" });
  await seedParent({ name: "Nora Nofamily", email: "nora.nofamily@example.org" });
  everyone = [a.spec.parent.email, b.spec.parent.email, "sigrid.second@family-a.example", "bo.both@families.example"].sort();
  await seedWorkingMail();
});

async function post(o: { email?: boolean; title?: string; body?: unknown; files?: string[] } = {}): Promise<string> {
  asStaff(coach);
  const r = await postMessageAction({ title: o.title ?? "Spring schedule", body: o.body ?? doc(para("Practice moves to Fridays.")), files: o.files ?? [], email: o.email ?? true });
  if (!r.ok) throw new Error(r.errors.join(" "));
  return r.id;
}

describe("queueing a message's email", () => {
  it("queues nothing while the club doesn't allow it, whatever the form sent", async () => {
    const id = await post({ email: true });
    expect(await rows()).toEqual([]);
    expect((await db.select().from(messageVersion).where(eq(messageVersion.messageId, id)))[0]!.emailed).toBe(false);
    expect((await audits("message.post"))[0]!.after).toMatchObject({ emailed: false });
    await sendMessageMail();
    expect(mail.outbox).toEqual([]);
  });

  it("queues nothing when the box is unticked", async () => {
    await allowEmail(true);
    await post({ email: false });
    expect(await rows()).toEqual([]);
  });

  it("queues one row per sign-in address that may sign in, however many families share it, in the post's transaction", async () => {
    await allowEmail(true);
    const id = await post({ email: true });
    expect((await rows()).map((r) => [r.address, r.status, r.tries])).toEqual(everyone.map((e) => [e, "queued", 0]));
    expect((await db.select().from(messageVersion).where(eq(messageVersion.messageId, id)))[0]!.emailed).toBe(true);
    const [audit] = await audits("message.post");
    expect(audit!.after).toEqual({ version: 1, files: 0, emailed: true, addresses: 4 });
    expect(JSON.stringify(audit)).not.toContain("family-a.example");
  });

  it("shows the box only while the club allows it, ticked, and says how many addresses in the preview's words", async () => {
    asStaff(coach);
    expect(await renderPage(NewMessagePage)).not.toContain("Also email families");
    await allowEmail(true);
    const html = await renderPage(NewMessagePage);
    expect(html).toMatch(/<input type="checkbox" id="msg-email"[^>]*checked=""/);
    expect(html).toContain("Also email families");
    expect(html).toContain("and is emailed to 4 addresses.");
    const id = await post();
    asStaff(coach);
    expect(await renderPage(EditMessagePage, { params: { id } })).toContain("Email families about this change");
  });
});

describe("the worker's mail", () => {
  it("sends each address its email once, with the title, the poster, the body and the portal's address, no file and nothing loaded", async () => {
    await allowEmail(true);
    const pic = await uploaded("team.jpg", JPEG);
    const pdf = await uploaded("Schedule <v2>.pdf", PDF, [pic]);
    asStaff(coach);
    const id = await post({ title: "Spring <schedule>", body: doc(para("<script>alert(1)</script>"), { type: "image", attrs: { attachment: pic, alt: "Team" } }), files: [pic, pdf] });
    expect(await runDueJobs()).toMatchObject({ ran: expect.arrayContaining([{ job: "messages.mail", ok: true }]) });
    expect(mail.outbox.map((m) => m.to).sort()).toEqual(everyone);
    const m = mail.outbox[0]!;
    expect(m.subject).toBe("Spring <schedule>");
    expect(m.attachments).toBeUndefined();
    expect(m.text).toContain("Casey Coach posted a message");
    expect(m.text).toContain("<script>alert(1)</script>");
    expect(m.text).toContain("There's a picture here: view it in the portal.");
    expect(m.text).toContain("- Schedule <v2>.pdf");
    expect(m.text).not.toContain("team.jpg");
    expect(m.text).toContain(`${env.APP_URL.replace(/\/+$/, "")}/messages/${id}`);
    expect(m.text.endsWith("Powered by Boosters Rocket\n")).toBe(true);
    expect(m.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(m.html).not.toMatch(/<script|<img\b|src=/i);
    expect(m.html).not.toContain(pic);
    expect((await rows()).every((r) => r.status === "sent")).toBe(true);
    // Each once: a later wake sends nothing more.
    await sendMessageMail();
    expect(mail.outbox).toHaveLength(4);
    expect((await audits("message.mail.sent")).map((r) => r.after)).toEqual([{ sent: 4, failed: 0, retrying: 0 }]);
    expect(JSON.stringify(await audits("message.mail.sent"))).not.toContain("@");
  });

  it("sends an emailed edit as an update", async () => {
    await allowEmail(true);
    const id = await post({ email: false });
    asStaff(coach);
    expect((await editMessageAction(id, { title: "Spring schedule, changed", body: doc(para("Thursdays now.")), files: [], email: true })).ok).toBe(true);
    await sendMessageMail();
    expect(mail.outbox).toHaveLength(4);
    expect(mail.outbox[0]!.subject).toBe("Updated: Spring schedule, changed");
    expect(mail.outbox[0]!.text).toContain("Casey Coach updated a message");
    expect((await audits("message.edit"))[0]!.after).toEqual({ version: 2, files: 0, emailed: true, addresses: 4 });
  });

  it("tries a refused address at three wakes, then counts it failed with its reason, and the others still go", async () => {
    await allowEmail(true);
    const id = await post();
    mail.refuse.add(b.spec.parent.email);
    await sendMessageMail();
    expect(mail.outbox).toHaveLength(3);
    expect((await rows()).find((r) => r.address === b.spec.parent.email)).toMatchObject({ status: "queued", tries: 1 });
    await sendMessageMail();
    await sendMessageMail();
    expect((await rows()).find((r) => r.address === b.spec.parent.email)).toEqual({ address: b.spec.parent.email, status: "failed", tries: 3, reason: "The mail server refused this address. (550)" });
    await sendMessageMail();
    expect(mail.outbox).toHaveLength(3);
    // Staff see the counts and the failed address; the list says so too.
    asStaff(coach);
    const page = await renderPage(StaffMessagePage, { params: { id } });
    expect(page).toContain("Version 1: Emailed 3 · 1 couldn&#x27;t be delivered");
    expect(page).toContain(b.spec.parent.email);
    expect(page).toContain("The mail server refused this address. (550)");
    expect(await renderPage(StaffMessagesPage)).toContain("Emailed 3 · 1 couldn&#x27;t be delivered");
  });

  it("stops a wake's batch when the mail itself fails, counting no try, and sends nothing while mail isn't working", async () => {
    await allowEmail(true);
    await post();
    mail.down = true;
    await sendMessageMail();
    expect(mail.outbox).toEqual([]);
    expect(mail.tried).toBe(1);
    expect((await rows()).map((r) => r.tries)).toEqual([0, 0, 0, 0]);
    expect((await rows()).every((r) => r.status === "queued")).toBe(true);
    mail.down = false;
    await sendMessageMail(new Date(Date.now() + 5 * 60_000));
    expect(mail.outbox).toHaveLength(4);
    expect((await rows()).every((r) => r.status === "sent")).toBe(true);
    // Mail not set up (or not verified): nothing is tried.
    await db.delete(setting).where(eq(setting.key, "mail.status"));
    asStaff(coach);
    await post({ title: "Second" });
    await sendMessageMail();
    expect(mail.outbox).toHaveLength(4);
  });

  it("leaves every email queued through a run of outage wakes, its tries untouched, asking the mail 5, 15, then 60 minutes apart", async () => {
    await allowEmail(true);
    await post();
    mail.down = true;
    const t0 = Date.now(), at = (minutes: number) => new Date(t0 + minutes * 60_000);
    // Queued a minute before the first wake, by the test's clock, not the database's.
    await db.update(messageMail).set({ createdAt: at(-1) });
    const nextTries = async () => [...new Set((await db.select({ at: messageMail.nextTryAt }).from(messageMail)).map((r) => r.at?.getTime()))];
    // A wake every minute for the first 25, then every 5 to five hours: the mail is asked only when the queue is due again.
    const askedAt: number[] = [];
    for (let minute = 0; minute <= 300; minute += minute < 25 ? 1 : 5) {
      const before = mail.tried;
      await sendMessageMail(at(minute));
      if (mail.tried > before) askedAt.push(minute);
      if (minute === 0) expect(await nextTries()).toEqual([at(5).getTime()]);
    }
    expect(askedAt).toEqual([0, 5, 20, 80, 140, 200, 260]);
    expect(mail.outbox).toEqual([]);
    const after = await rows();
    expect(after.map((r) => [r.status, r.tries])).toEqual(everyone.map(() => ["queued", 0]));
    expect(after.filter((r) => r.reason !== null).map((r) => r.reason)).toEqual(["The mail server couldn't be reached. (ECONNREFUSED)"]);
    // Once the mail works, the next wake that is due sends every one.
    mail.down = false;
    await sendMessageMail(at(301));
    expect(mail.outbox).toEqual([]);
    await sendMessageMail(at(320));
    expect(mail.outbox.map((m) => m.to).sort()).toEqual(everyone);
    expect((await rows()).map((r) => [r.status, r.tries, r.reason])).toEqual(everyone.map(() => ["sent", 0, null]));
  });

  it("sends at most a batch at a wake", async () => {
    await allowEmail(true);
    for (let i = 0; i < MESSAGE_MAIL_BATCH; i++) await seedParentIn({ familyQboId: FAMILY_B.family.qboId, name: `Extra ${i}`, email: `extra.${i}@family-b.example` });
    await post();
    await sendMessageMail();
    expect(mail.outbox).toHaveLength(MESSAGE_MAIL_BATCH);
    await sendMessageMail();
    expect(mail.outbox).toHaveLength(MESSAGE_MAIL_BATCH + 4);
  });
});

describe("an edit and the email still queued for an earlier version", () => {
  const edit = async (id: string, words: string, email: boolean) => {
    asStaff(coach);
    const r = await editMessageAction(id, { title: "Spring schedule, changed", body: doc(para(words)), files: [], email });
    if (!r.ok) throw new Error(r.errors.join(" "));
  };
  const toB = () => mail.outbox.filter((m) => m.to === b.spec.parent.email);

  it("a quiet edit moves it onto the new version, sent as an ordinary first email with what the message now says", async () => {
    await allowEmail(true);
    const id = await post({ body: doc(para("Old words")) });
    mail.refuse.add(b.spec.parent.email);
    await sendMessageMail();
    expect(mail.outbox).toHaveLength(3);
    await edit(id, "New words", false);
    const [v1, v2] = await db.select({ id: messageVersion.id }).from(messageVersion).where(eq(messageVersion.messageId, id)).orderBy(asc(messageVersion.n));
    const byVersion = await db.select({ versionId: messageMail.versionId, address: messageMail.address, status: messageMail.status, tries: messageMail.tries }).from(messageMail);
    expect(byVersion.filter((r) => r.versionId === v2!.id)).toEqual([{ versionId: v2!.id, address: b.spec.parent.email, status: "queued", tries: 1 }]);
    expect(byVersion.filter((r) => r.versionId === v1!.id).map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
    mail.refuse.clear();
    await sendMessageMail();
    expect(toB()).toHaveLength(1);
    expect(toB()[0]!.subject).toBe("Spring schedule, changed");
    expect(toB()[0]!.text).toContain("Casey Coach posted a message");
    expect(toB()[0]!.text).toContain("New words");
    expect(toB()[0]!.text).not.toContain("Old words");
    expect(mail.outbox).toHaveLength(4);
    // Staff see it under the version it went with.
    asStaff(coach);
    const page = await renderPage(StaffMessagePage, { params: { id } });
    expect(page).toContain("Version 2: Emailed 1");
    expect(page).toContain("Version 1: Emailed 3");
  });

  it("an emailed edit drops it: those addresses get the edit's email alone, one for the edit, and nothing of the old version", async () => {
    await allowEmail(true);
    const id = await post({ body: doc(para("Old words")) });
    mail.refuse.add(b.spec.parent.email);
    await sendMessageMail();
    await edit(id, "New words", true);
    const queued = await db.select({ versionId: messageMail.versionId, address: messageMail.address }).from(messageMail).where(eq(messageMail.status, "queued"));
    const [, v2] = await db.select({ id: messageVersion.id }).from(messageVersion).where(eq(messageVersion.messageId, id)).orderBy(asc(messageVersion.n));
    expect(queued.map((r) => r.versionId)).toEqual(everyone.map(() => v2!.id));
    mail.refuse.clear();
    await sendMessageMail();
    await sendMessageMail();
    expect(toB()).toHaveLength(1);
    expect(toB()[0]!.subject).toBe("Updated: Spring schedule, changed");
    expect(toB()[0]!.text).toContain("New words");
    expect(mail.outbox).toHaveLength(3 + 4);
    expect(mail.outbox.filter((m) => m.text.includes("Old words"))).toHaveLength(3);
  });

  it("the worker drops, unsent, any queued email whose version is no longer the message's newest", async () => {
    await allowEmail(true);
    const id = await post({ email: false });
    await edit(id, "New words", false);
    const [v1] = await db.select({ id: messageVersion.id }).from(messageVersion).where(eq(messageVersion.messageId, id)).orderBy(asc(messageVersion.n));
    // A row the edit's transaction didn't see, written straight to the queue.
    await db.insert(messageMail).values({ versionId: v1!.id, address: a.spec.parent.email });
    expect(await sendMessageMail()).toEqual({ sent: 0, failed: 0, retrying: 0 });
    expect(mail.outbox).toEqual([]);
    expect(await db.select().from(messageMail)).toEqual([]);
  });
});

describe("an emailed edit and new", () => {
  it("makes the message new again for a parent who read it, and a quiet edit doesn't", async () => {
    await allowEmail(true);
    const id = await post({ email: false });
    asParent(a.identity);
    await renderPage(ParentMessagePage, { params: { id } });
    expect(await renderPage(ParentMessagesPage)).not.toContain(">New<");
    asStaff(coach);
    expect((await editMessageAction(id, { title: "Spring schedule", body: doc(para("A typo fixed.")), files: [], email: false })).ok).toBe(true);
    asParent(a.identity);
    expect(await renderPage(ParentMessagesPage)).not.toContain(">New<");
    asStaff(coach);
    expect((await editMessageAction(id, { title: "Spring schedule", body: doc(para("Moved to Thursdays.")), files: [], email: true })).ok).toBe(true);
    asParent(a.identity);
    expect(await renderPage(ParentMessagesPage)).toContain(">New<");
    await renderPage(ParentMessagePage, { params: { id } });
    expect(await renderPage(ParentMessagesPage)).not.toContain(">New<");
  });
});

describe("an Admin's delete", () => {
  it("erases every version's content and files and drops unsent mail, keeps who deleted it, sends nothing, audited without content", async () => {
    await allowEmail(true);
    const pdf = await uploaded("Roster with phone numbers.pdf", PDF);
    const id = await post({ title: "Wrong family's details", body: doc(para("Secret words")), files: [pdf] });
    asStaff(coach);
    expect((await editMessageAction(id, { title: "Still wrong", body: doc(para("More secret words")), files: [pdf], email: false })).ok).toBe(true);
    asParent(a.identity);
    await renderPage(ParentMessagePage, { params: { id } });

    asStaff(admin);
    expect(await renderPage(StaffMessagePage, { params: { id } })).toContain("Delete message");
    expect(await deleteMessageAction(id)).toMatchObject({ ok: true });
    expect(await db.select().from(messageVersion)).toEqual([]);
    expect(await db.select().from(messageFile)).toEqual([]);
    expect(await db.select().from(messageMail)).toEqual([]);
    expect(await db.select().from(messageRead)).toEqual([]);
    expect((await db.select().from(clubMessage))[0]).toMatchObject({ id, deletedBy: admin.id, deletedAt: expect.any(Date) });
    await sendMessageMail();
    expect(mail.outbox).toEqual([]);

    const [audit] = await audits("message.delete");
    expect(audit).toMatchObject({ actorId: admin.id, permission: "Messages.Delete.ReadWrite", targetType: "message", targetId: id,
      before: { versions: 2, files: 1 }, after: { unsentEmails: 4 } });
    const all = JSON.stringify(await db.select().from(auditLog));
    for (const text of ["Wrong family", "Still wrong", "Secret words", "Roster with phone"]) expect(all).not.toContain(text);

    // Staff see who deleted it and when; parents, and a link to it or its file, find nothing.
    expect(await renderPage(StaffMessagesPage)).toContain("Deleted by Ada Admin on");
    asParent(a.identity);
    expect(await renderPage(ParentMessagesPage)).not.toContain("Wrong family");
    expect(await pageOutcome(ParentMessagePage, { params: { id } })).toEqual({ notFound: true });
    expect((await parentFileRoute(new Request(`http://localhost/messages/files/${pdf}`), { params: Promise.resolve({ id: pdf }) })).status).toBe(404);
  });

  it("is refused to anyone but an Admin, the poster included, and shows them no Delete", async () => {
    const id = await post({ email: false });
    asStaff(coach);
    expect(await renderPage(StaffMessagePage, { params: { id } })).not.toContain("Delete message");
    await expect(deleteMessageAction(id)).rejects.toBeInstanceOf(AccessDenied);
    asParent(a.identity);
    await expect(deleteMessageAction(id)).rejects.toBeInstanceOf(AccessDenied);
    expect((await db.select().from(clubMessage))[0]!.deletedAt).toBeNull();
    expect(await audits("message.delete")).toEqual([]);
    asStaff(admin);
    expect(await deleteMessageAction("not-an-id")).toMatchObject({ ok: false });
    expect(await deleteMessageAction(id)).toMatchObject({ ok: true });
    expect(await deleteMessageAction(id)).toEqual({ ok: false, errors: ["This message was already deleted."] });
  });
});
