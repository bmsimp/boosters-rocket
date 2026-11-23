import { describe, it, expect, beforeEach } from "vitest";
import { asParent, asRefusedStaff, asStaff, pageOutcome, renderPage, signedOut } from "../helpers/signed-in";

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, clubMessage, messageFile, messageVersion, messageVersionFile, role, roleAssignment, roleRule } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { MESSAGE_FILE_MAX_BYTES } from "@/lib/messages/file-types";
import { editMessageAction, postMessageAction, removeHeldFileAction } from "@/app/staff/(app)/messages/actions";
import { GET as fileRoute } from "@/app/staff/(app)/messages/files/[id]/route";
import { POST as uploadRoute } from "@/app/staff/(app)/messages/files/route";
import { env } from "@/env";
import MessagesPage from "@/app/staff/(app)/messages/page";
import NewMessagePage from "@/app/staff/(app)/messages/new/page";
import MessagePage from "@/app/staff/(app)/messages/[id]/page";
import EditMessagePage from "@/app/staff/(app)/messages/[id]/edit/page";
import { resetDb, seedStaff } from "../helpers/db";
import { seedSignedInParent } from "../helpers/parent";
import { EXE, JPEG, PDF, pdfOfSize, PNG, DOCX, SVG } from "../helpers/message-files";

/**
 * Club messages, slice 2 (docs/superpowers/specs/2026-11-23-club-messages-design.md, sections 4, 6, 7 and 9): staff who
 * may post upload pictures and files, post, and edit their own message as a new version; the staff pages and the staff
 * file route (src/app/staff/(app)/messages/files/[id]/route.ts) with its guards and headers.
 */
type Staff = { id: string; name: string; email: string };
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.id));
const askFile = (id: string) => fileRoute(new Request(`http://localhost/staff/messages/files/${id}`), { params: Promise.resolve({ id }) });

async function staffWith(email: string, name: string, ...patterns: string[]): Promise<Staff> {
  const s = await seedStaff({ email, name });
  const [r] = await db.insert(role).values({ key: `r-${email}`, name: `Role ${email}` }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
}

type UploadOpts = { message?: string; listed?: string[]; origin?: string | null; length?: string | null; body?: BodyInit };
/** The request the form sends: the file's bytes, its name and the form's state in the query string, from the portal's own page. */
function uploadRequest(name: string, bytes: Uint8Array, o: UploadOpts = {}): Request {
  const q = new URLSearchParams({ name });
  if (o.message !== undefined) q.set("message", o.message);
  for (const id of o.listed ?? []) q.append("listed", id);
  const headers = new Headers({ "content-type": "application/octet-stream" });
  const origin = o.origin === undefined ? new URL(env.APP_URL).origin : o.origin;
  if (origin !== null) headers.set("origin", origin);
  const length = o.length === undefined ? String(bytes.byteLength) : o.length;
  if (length !== null) headers.set("content-length", length);
  return new Request(`http://localhost/staff/messages/files?${q}`, { method: "POST", headers, body: o.body ?? (bytes as Uint8Array<ArrayBuffer>), duplex: "half" } as RequestInit);
}
/** Uploads a file through the staff upload route as the signed-in staff member; its status and its JSON answer. */
async function uploadAnswer(name: string, bytes: Uint8Array, o: UploadOpts = {}) {
  const res = await uploadRoute(uploadRequest(name, bytes, o));
  return { status: res.status, headers: res.headers, body: await res.json() as { ok: true; message: string; file: { id: string } } | { ok: false; errors: string[] } };
}
async function upload(name: string, bytes: Uint8Array, o: UploadOpts = {}) {
  return (await uploadAnswer(name, bytes, o)).body;
}
async function uploaded(name: string, bytes: Uint8Array, o: UploadOpts = {}): Promise<string> {
  const r = await upload(name, bytes, o);
  if (!r.ok) throw new Error(r.errors.join(" "));
  return r.file.id;
}

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const picture = (id: string, alt = "The team") => ({ type: "image", attrs: { attachment: id, alt } });

let coach: Staff, admin: Staff;
beforeEach(async () => {
  await resetDb();
  coach = await staffWith("coach@club.org", "Casey Coach", "Messages.Post.ReadWrite");
  admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
});

async function postAsCoach(title = "Practice moved", body: unknown = doc(para("We meet at the high school on Friday.")), files: string[] = []) {
  asStaff(coach);
  const r = await postMessageAction({ title, body, files });
  if (!r.ok) throw new Error(r.errors.join(" "));
  return r.id;
}

describe("posting a message", () => {
  it("posts version 1 with its pictures and files, which belong to it once saved, audited without its title or a file's name", async () => {
    asStaff(coach);
    const pic = await uploaded("team.jpg", JPEG);
    const pdf = await uploaded("Schedule FINAL.pdf", PDF);
    const id = await postAsCoach("Spring schedule", doc(para("Here it is."), picture(pic)), [pic, pdf]);

    const [m] = await db.select().from(clubMessage).where(eq(clubMessage.id, id));
    expect(m).toMatchObject({ postedBy: coach.id, deletedAt: null });
    const [v] = await db.select().from(messageVersion).where(eq(messageVersion.messageId, id));
    expect(v).toMatchObject({ n: 1, title: "Spring schedule", emailed: false, body: doc(para("Here it is."), picture(pic)) });
    const files = await db.select({ id: messageFile.id, heldBy: messageFile.heldBy, messageId: messageFile.messageId, type: messageFile.type, name: messageFile.name }).from(messageFile).orderBy(asc(messageFile.uploadedAt));
    expect(files).toEqual([
      { id: pic, heldBy: null, messageId: id, type: "jpeg", name: "team.jpg" },
      { id: pdf, heldBy: null, messageId: id, type: "pdf", name: "Schedule FINAL.pdf" },
    ]);
    expect((await db.select().from(messageVersionFile).orderBy(asc(messageVersionFile.position))).map((r) => [r.fileId, r.position])).toEqual([[pic, 0], [pdf, 1]]);

    const [post] = await audits("message.post");
    expect(post).toMatchObject({ actorId: coach.id, permission: "Messages.Post.ReadWrite", targetType: "message", targetId: id, after: { version: 1, files: 2, emailed: false } });
    const ups = await audits("message.file.upload");
    expect(ups.map((u) => u.after)).toEqual([{ type: "jpeg", size: JPEG.byteLength, messageId: null }, { type: "pdf", size: PDF.byteLength, messageId: null }]);
    const all = JSON.stringify(await db.select().from(auditLog));
    for (const text of ["Spring schedule", "Here it is", "team.jpg", "Schedule FINAL"]) expect(all).not.toContain(text);
  });

  it("refuses a title missing or over 120 characters, a body off the allowlist, and a picture that isn't the form's own", async () => {
    asStaff(coach);
    expect(await postMessageAction({ title: "  ", body: doc(para("x")), files: [] })).toEqual({ ok: false, errors: ["Give the message a title."] });
    expect(await postMessageAction({ title: "a".repeat(121), body: doc(para("x")), files: [] })).toMatchObject({ ok: false });
    expect((await postMessageAction({ title: "a".repeat(120), body: doc(para("x")), files: [] })).ok).toBe(true);
    expect(await postMessageAction({ title: "T", body: doc({ type: "codeBlock", content: [] }), files: [] })).toMatchObject({ ok: false });
    expect(await postMessageAction({ title: "T", body: doc({ type: "image", attrs: { src: "https://evil.example/x.png" } }), files: [] })).toMatchObject({ ok: false });
    // A picture uploaded but not listed, a PDF given as a picture: neither is one of the form's pictures.
    const pic = await uploaded("a.png", PNG), pdf = await uploaded("a.pdf", PDF);
    expect(await postMessageAction({ title: "T", body: doc(picture(pic)), files: [] })).toMatchObject({ ok: false });
    expect(await postMessageAction({ title: "T", body: doc(picture(pdf)), files: [pdf] })).toMatchObject({ ok: false });
    for (const bad of [null, "x", { title: "T", body: doc(), files: "nope" }, { title: "T", body: doc(), files: ["not-an-id"] }]) {
      expect(await postMessageAction(bad)).toMatchObject({ ok: false });
    }
    expect(await audits("message.post")).toHaveLength(1);
  });

  it("refuses another staff member's held file, and a file already posted", async () => {
    asStaff(admin);
    const theirs = await uploaded("theirs.pdf", PDF);
    asStaff(coach);
    expect(await postMessageAction({ title: "T", body: doc(), files: [theirs] })).toMatchObject({ ok: false, errors: [expect.stringContaining("no longer here")] });
    const mine = await uploaded("mine.pdf", PDF);
    await postAsCoach("First", doc(), [mine]);
    expect(await postMessageAction({ title: "Second", body: doc(), files: [mine] })).toMatchObject({ ok: false, errors: [expect.stringContaining("no longer here")] });
  });

  it("is refused to staff who may not post, to a parent and to nobody", async () => {
    asStaff(await staffWith("roster@club.org", "Rory Roster", "Roster.Read"));
    await expect(postMessageAction({ title: "T", body: doc(), files: [] })).rejects.toBeInstanceOf(AccessDenied);
    expect(await uploadAnswer("a.pdf", PDF)).toMatchObject({ status: 403, body: { ok: false } });
    asParent((await seedSignedInParent()).identity);
    await expect(postMessageAction({ title: "T", body: doc(), files: [] })).rejects.toBeInstanceOf(AccessDenied);
    signedOut();
    await expect(postMessageAction({ title: "T", body: doc(), files: [] })).rejects.toBeInstanceOf(AccessDenied);
    expect(await db.select().from(clubMessage)).toHaveLength(0);
  });
});

describe("uploading a file", () => {
  it("keeps a file sent to the upload route, held by its uploader, audited with its type and size, answered no-store", async () => {
    asStaff(coach);
    const r = await uploadAnswer("Schedule.pdf", PDF);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({ ok: true, message: "Added Schedule.pdf.", file: { name: "Schedule.pdf", type: "pdf", size: PDF.byteLength, picture: false } });
    const [f] = await db.select().from(messageFile);
    expect(f).toMatchObject({ heldBy: coach.id, messageId: null, type: "pdf", size: PDF.byteLength });
    expect(new Uint8Array(f!.bytes)).toEqual(PDF);
    expect(await audits("message.file.upload")).toMatchObject([{ actorId: coach.id, targetId: f!.id, after: { type: "pdf", size: PDF.byteLength, messageId: null } }]);
  });

  it("refuses nobody and staff without Messages.Post.ReadWrite in the same words, before the body is read, the second audited", async () => {
    const refused = { status: 403, body: { ok: false, errors: ["That didn't go through. Please try again. If it keeps happening, sign out and back in."] } };
    expect(await uploadAnswer("a.pdf", PDF)).toMatchObject(refused);
    asRefusedStaff();
    expect(await uploadAnswer("a.pdf", PDF)).toMatchObject(refused);
    asParent((await seedSignedInParent()).identity);
    expect(await uploadAnswer("a.pdf", PDF)).toMatchObject(refused);
    const roster = await staffWith("roster@club.org", "Rory Roster", "Roster.Read");
    asStaff(roster);
    let pulled = false;
    const watched = new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.enqueue(PDF); c.close(); } }, { highWaterMark: 0 });
    expect(await uploadAnswer("a.pdf", PDF, { body: watched })).toMatchObject(refused);
    expect(pulled).toBe(false);
    expect(await audits("access.refused")).toMatchObject([{ actorId: roster.id, permission: "Messages.Post.ReadWrite" }]);
    // A request from another site's page, or one that doesn't say where it came from, is refused as well.
    asStaff(coach);
    expect(await uploadAnswer("a.pdf", PDF, { origin: "https://elsewhere.example" })).toMatchObject(refused);
    expect(await uploadAnswer("a.pdf", PDF, { origin: null })).toMatchObject(refused);
    expect(await db.select().from(messageFile)).toHaveLength(0);
  });

  it("refuses a body over 10 MB by its length before reading it, one longer than it said, and one with no length", async () => {
    asStaff(coach);
    const over = (name: string) => [`${name} is over 10 MB. Make it smaller, or share it another way.`];
    expect(await uploadAnswer("huge.pdf", pdfOfSize(MESSAGE_FILE_MAX_BYTES + 1))).toMatchObject({ status: 413, body: { ok: false, errors: over("huge.pdf") } });
    // A length over the limit is refused without a byte of the body read: the stream is never pulled.
    let pulled = false;
    const never = new ReadableStream<Uint8Array>({ pull() { pulled = true; } }, { highWaterMark: 0 });
    expect(await uploadAnswer("huge.pdf", PDF, { length: String(MESSAGE_FILE_MAX_BYTES + 1), body: never })).toMatchObject({ status: 413, body: { errors: over("huge.pdf") } });
    expect(pulled).toBe(false);
    // A body that says it is small and goes on is dropped as soon as it passes what it said.
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { sent += 1; c.enqueue(new Uint8Array(1024 * 1024)); } });
    expect(await uploadAnswer("sneaky.pdf", PDF, { length: String(2 * 1024 * 1024), body: endless })).toMatchObject({ status: 413, body: { errors: over("sneaky.pdf") } });
    expect(sent).toBeLessThan(6);
    const unsized = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(PDF); c.close(); } });
    expect(await uploadAnswer("a.pdf", PDF, { length: null, body: unsized })).toMatchObject({ status: 411, body: { ok: false } });
    expect(await db.select().from(messageFile)).toHaveLength(0);
    expect(await audits("message.file.upload")).toHaveLength(0);
  });

  it("refuses a renamed program, an SVG, an empty file and a request not from the form, keeping nothing", async () => {
    asStaff(coach);
    expect(await uploadAnswer("minutes.pdf", EXE)).toMatchObject({ status: 400, body: { ok: false, errors: [expect.stringContaining("minutes.pdf isn't a picture")] } });
    expect(await upload("logo.svg", SVG)).toMatchObject({ ok: false, errors: [expect.stringContaining("logo.svg isn't a picture")] });
    expect(await upload("empty.pdf", new Uint8Array())).toEqual({ ok: false, errors: ["empty.pdf is empty."] });
    expect(await upload("a.pdf", PDF, { message: "not-an-id" })).toMatchObject({ ok: false });
    const noName = await uploadRoute(new Request("http://localhost/staff/messages/files", { method: "POST", headers: { origin: new URL(env.APP_URL).origin, "content-length": String(PDF.byteLength) }, body: PDF as Uint8Array<ArrayBuffer> }));
    expect(noName.status).toBe(400);
    expect(await db.select().from(messageFile)).toHaveLength(0);
    expect(await audits("message.file.upload")).toHaveLength(0);
  });

  it("refuses an eleventh file held for a message, counted on the server whatever the browser says it lists, and a post that lists eleven", async () => {
    asStaff(coach);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await uploaded(`f${i}.pdf`, PDF, { listed: [] }));
    expect(await upload("f10.pdf", PDF, { listed: [] })).toMatchObject({ ok: false, errors: [expect.stringContaining("at most 10 files")] });
    expect(await upload("f10.pdf", PDF)).toMatchObject({ ok: false, errors: [expect.stringContaining("at most 10 files")] });
    expect(await db.select().from(messageFile)).toHaveLength(10);
    // Another staff member's held file is theirs, and counts for them alone.
    asStaff(admin);
    await uploaded("theirs.pdf", PDF);
    asStaff(coach);
    expect(await postMessageAction({ title: "T", body: doc(), files: [...ids, randomUUID()] })).toMatchObject({ ok: false, errors: [expect.stringContaining("at most 10 files")] });
    const id = await postAsCoach("T", doc(), ids);
    // Posted, they are held no longer: the form, and an edit of the message, may hold ten again.
    for (let i = 0; i < 10; i++) await uploaded(`e${i}.pdf`, PDF, { message: id });
    expect(await upload("e10.pdf", PDF, { message: id })).toMatchObject({ ok: false, errors: [expect.stringContaining("at most 10 files")] });
    expect(await upload("n0.pdf", PDF)).toMatchObject({ ok: true });
  });

  it("refuses a file that takes what one staff member holds unposted over 100 MB in all, across their messages", async () => {
    asStaff(coach);
    const id = await postAsCoach("T", doc(), []);
    // Nine held files of 10 MB for an edit and one for a new message: 100 MB, the most one person may hold.
    const big = (messageId: string | null) => ({ messageId, heldBy: coach.id, name: "big.pdf", type: "pdf" as const, size: MESSAGE_FILE_MAX_BYTES, bytes: Buffer.from(PDF) });
    await db.insert(messageFile).values([...Array.from({ length: 9 }, () => big(id)), big(null)]);
    expect(await upload("one more.pdf", PDF)).toEqual({ ok: false, errors: [expect.stringContaining("more than 100 MB")] });
    expect(await audits("message.file.upload")).toHaveLength(0);
    // Another staff member's held files are theirs: they don't count.
    asStaff(admin);
    expect(await upload("admin.pdf", PDF)).toMatchObject({ ok: true });
    // Removing one makes room.
    asStaff(coach);
    const [one] = await db.select({ id: messageFile.id }).from(messageFile).where(and(eq(messageFile.heldBy, coach.id), isNull(messageFile.messageId)));
    expect(await removeHeldFileAction(one!.id)).toMatchObject({ ok: true });
    expect(await upload("one more.pdf", PDF)).toMatchObject({ ok: true });
  });

  it("removes a held file of the form's own, audited, and leaves another's and a posted one", async () => {
    asStaff(coach);
    const held = await uploaded("held.pdf", PDF), posted = await uploaded("posted.pdf", PDF);
    await postAsCoach("T", doc(), [posted]);
    asStaff(admin);
    const theirs = await uploaded("theirs.pdf", PDF);
    asStaff(coach);
    for (const id of [held, posted, theirs]) expect(await removeHeldFileAction(id)).toMatchObject({ ok: true });
    expect((await db.select({ id: messageFile.id }).from(messageFile)).map((f) => f.id).sort()).toEqual([posted, theirs].sort());
    const [removed] = await audits("message.file.remove");
    expect(removed).toMatchObject({ actorId: coach.id, targetId: held, before: { type: "pdf", size: PDF.byteLength, messageId: null } });
    expect(await audits("message.file.remove")).toHaveLength(1);
    expect(await removeHeldFileAction("not-an-id")).toMatchObject({ ok: false });
  });
});

describe("editing a message", () => {
  it("saves the poster's edit as version 2 and leaves version 1 as it was, a kept file the same row and a dropped one with version 1", async () => {
    asStaff(coach);
    const keep = await uploaded("keep.pdf", PDF), drop = await uploaded("drop.docx", DOCX);
    const id = await postAsCoach("Old title", doc(para("Old words")), [keep, drop]);
    const [v1before] = await db.select().from(messageVersion).where(eq(messageVersion.messageId, id));
    const added = await uploaded("new.png", PNG, { message: id });
    const [heldForEdit] = await db.select().from(messageFile).where(eq(messageFile.id, added));
    expect(heldForEdit).toMatchObject({ heldBy: coach.id, messageId: id });

    expect(await editMessageAction(id, { title: "New title", body: doc(para("New words"), picture(added)), files: [keep, added] })).toMatchObject({ ok: true });
    const versions = await db.select().from(messageVersion).where(eq(messageVersion.messageId, id)).orderBy(asc(messageVersion.n));
    expect(versions.map((v) => [v.n, v.title])).toEqual([[1, "Old title"], [2, "New title"]]);
    expect(versions[0]).toEqual(v1before);
    const filesOf = async (versionId: string) => (await db.select().from(messageVersionFile).where(eq(messageVersionFile.versionId, versionId)).orderBy(asc(messageVersionFile.position))).map((r) => r.fileId);
    expect(await filesOf(versions[0]!.id)).toEqual([keep, drop]);
    expect(await filesOf(versions[1]!.id)).toEqual([keep, added]);
    expect(await db.select().from(messageFile)).toHaveLength(3);
    const [edit] = await audits("message.edit");
    expect(edit).toMatchObject({ actorId: coach.id, targetType: "message", targetId: id, after: { version: 2, files: 2, emailed: false } });
    expect(JSON.stringify(edit)).not.toContain("New title");
  });

  it("refuses an edit by anyone but the poster, an Admin's included, audited as refused, and changes nothing", async () => {
    const id = await postAsCoach();
    asStaff(admin);
    expect(await editMessageAction(id, { title: "Taken over", body: doc(), files: [] })).toEqual({ ok: false, errors: ["Only the person who posted a message can edit it."] });
    expect(await upload("x.pdf", PDF, { message: id })).toEqual({ ok: false, errors: ["Only the person who posted a message can edit it."] });
    const other = await staffWith("other@club.org", "Olive Other", "Messages.Post.ReadWrite");
    asStaff(other);
    expect(await editMessageAction(id, { title: "Taken over", body: doc(), files: [] })).toMatchObject({ ok: false });
    expect(await db.select().from(messageVersion)).toHaveLength(1);
    const refused = (await audits("access.refused")).filter((r) => r.targetId === id);
    expect(refused.map((r) => r.actorId)).toEqual([admin.id, other.id]);
    expect(await audits("message.edit")).toHaveLength(0);
  });

  it("refuses an edit that changes nothing, another message's file, and an unknown message", async () => {
    asStaff(coach);
    const a = await uploaded("a.pdf", PDF);
    const first = await postAsCoach("First", doc(para("x")), [a]);
    const b = await uploaded("b.pdf", PDF);
    const second = await postAsCoach("Second", doc(), [b]);
    expect(await editMessageAction(first, { title: "First", body: doc(para("x")), files: [a] })).toEqual({ ok: false, errors: ["Nothing has changed since the last version, so nothing was saved."] });
    expect(await editMessageAction(first, { title: "First", body: doc(para("x")), files: [a, b] })).toMatchObject({ ok: false, errors: [expect.stringContaining("no longer here")] });
    expect(await editMessageAction("00000000-0000-4000-8000-000000000000", { title: "T", body: doc(), files: [] })).toMatchObject({ ok: false });
    expect(await editMessageAction("nope", { title: "T", body: doc(), files: [] })).toMatchObject({ ok: false });
    expect(second).not.toBe(first);
    expect(await db.select().from(messageVersion)).toHaveLength(2);
  });
});

describe("the staff pages", () => {
  it("list every message, newest first, with its poster and whether it was edited, and a New message button", async () => {
    asStaff(coach);
    expect(await renderPage(MessagesPage)).toContain("No messages yet");
    const first = await postAsCoach("First news");
    await db.update(clubMessage).set({ postedAt: new Date(Date.now() - 86_400_000) }).where(eq(clubMessage.id, first));
    const second = await postAsCoach("Second news");
    expect((await editMessageAction(first, { title: "First news, again", body: doc(), files: [] })).ok).toBe(true);
    const html = await renderPage(MessagesPage);
    expect(html.indexOf("Second news")).toBeLessThan(html.indexOf("First news, again"));
    expect(html).toContain(`href="/staff/messages/${second}"`);
    expect(html).toContain("Casey Coach");
    expect(html).toContain("Edited");
    expect(html).toContain('href="/staff/messages/new"');
  });

  it("show a message with its earlier versions, Edit for its poster alone", async () => {
    asStaff(coach);
    const pdf = await uploaded("Waiver.pdf", PDF);
    const id = await postAsCoach("Waivers due", doc(para("<script>alert(1)</script>")), [pdf]);
    expect((await editMessageAction(id, { title: "Waivers due Friday", body: doc(para("Friday.")), files: [pdf] })).ok).toBe(true);
    const mine = await renderPage(MessagePage, { params: { id } });
    expect(mine).toContain("Waivers due Friday");
    expect(mine).toContain("Posted by Casey Coach");
    expect(mine).toContain("Earlier versions");
    expect(mine).toContain("Version 1");
    expect(mine).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(mine).not.toContain("<script>alert");
    expect(mine).toContain(`href="/staff/messages/files/${pdf}"`);
    expect(mine).toContain(`href="/staff/messages/${id}/edit"`);
    asStaff(admin);
    const theirs = await renderPage(MessagePage, { params: { id } });
    expect(theirs).not.toContain(`href="/staff/messages/${id}/edit"`);
    expect(theirs).toContain("Only Casey Coach, who posted it, can edit it.");
  });

  it("open the edit form for the poster, refuse it to anyone else as a guard does, and answer 404 for an id that isn't a message", async () => {
    const id = await postAsCoach("Car pool");
    asStaff(coach);
    expect(await renderPage(EditMessagePage, { params: { id } })).toContain("Edit message");
    asStaff(admin);
    expect(await pageOutcome(EditMessagePage, { params: { id } })).toEqual({ redirect: "/refused" });
    expect((await audits("access.refused")).at(-1)).toMatchObject({ actorId: admin.id, targetType: "message", targetId: id });
    for (const bad of ["nope", "00000000-0000-4000-8000-000000000000"]) {
      expect(await pageOutcome(MessagePage, { params: { id: bad } })).toEqual({ notFound: true });
      expect(await pageOutcome(EditMessagePage, { params: { id: bad } })).toEqual({ notFound: true });
    }
  });

  it("say how many families a new message goes to, and are refused to staff who may not post", async () => {
    asStaff(coach);
    expect(await renderPage(NewMessagePage)).toContain("This goes to 0 families.");
    asStaff(await staffWith("roster@club.org", "Rory Roster", "Roster.Read"));
    for (const page of [MessagesPage, NewMessagePage]) expect(await pageOutcome(page)).toEqual({ redirect: "/refused" });
  });
});

describe("the staff file route", () => {
  it("sends a posted file, no-store and nosniff, a picture inline and anything else as attachment.<ext>", async () => {
    asStaff(coach);
    const pic = await uploaded("Our <team>.jpg", JPEG), pdf = await uploaded("Schedule\".pdf", PDF);
    await postAsCoach("T", doc(picture(pic)), [pic, pdf]);
    asStaff(await staffWith("reader@club.org", "Reese Reader", "Messages.Post.ReadWrite"));
    const p = await askFile(pic);
    expect(p.status).toBe(200);
    expect(Object.fromEntries(p.headers)).toMatchObject({ "content-type": "image/jpeg", "content-disposition": 'inline; filename="attachment.jpg"', "cache-control": "no-store", "x-content-type-options": "nosniff" });
    expect(new Uint8Array(await p.arrayBuffer())).toEqual(JPEG);
    const d = await askFile(pdf);
    expect(Object.fromEntries(d.headers)).toMatchObject({ "content-type": "application/pdf", "content-disposition": 'attachment; filename="attachment.pdf"', "cache-control": "no-store", "x-content-type-options": "nosniff" });
  });

  it("sends a held file to the staff member whose form holds it alone, and answers 404 for an unknown id", async () => {
    asStaff(coach);
    const held = await uploaded("draft.png", PNG);
    expect((await askFile(held)).status).toBe(200);
    asStaff(admin);
    const theirs = await askFile(held);
    expect(theirs.status).toBe(404);
    expect(theirs.headers.get("cache-control")).toBe("no-store");
    expect((await theirs.text())).toBe("Not found");
    for (const bad of ["nope", "00000000-0000-4000-8000-000000000000"]) expect((await askFile(bad)).status).toBe(404);
  });

  it("redirects nobody to sign in and anyone refused to the refusal page, with no bytes", async () => {
    asStaff(coach);
    const pdf = await uploaded("a.pdf", PDF);
    await postAsCoach("T", doc(), [pdf]);
    signedOut();
    const out = await askFile(pdf);
    expect(out.status).toBe(307);
    expect(out.headers.get("location")).toMatch(/\/staff\/sign-in$/);
    asRefusedStaff();
    expect((await askFile(pdf)).headers.get("location")).toMatch(/\/refused$/);
    asStaff(await staffWith("roster@club.org", "Rory Roster", "Roster.Read"));
    const refused = await askFile(pdf);
    expect(refused.headers.get("location")).toMatch(/\/refused$/);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    asParent((await seedSignedInParent()).identity);
    const parent = await askFile(pdf);
    expect(parent.status).toBe(307);
    expect(parent.headers.get("location")).toMatch(/\/(refused|staff\/sign-in)$/);
  });
});
