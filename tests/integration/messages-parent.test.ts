import { describe, it, expect, beforeEach } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage } from "../helpers/signed-in";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clubMessage, messageFile, messageRead, messageVersion, messageVersionFile, staffUser } from "@/lib/db/schema";
import ParentHome from "@/app/(parent)/page";
import MessagesPage from "@/app/(parent)/messages/page";
import MessagePage from "@/app/(parent)/messages/[id]/page";
import StaffProfilePage from "@/app/(parent)/messages/from/[staffId]/page";
import { GET as fileRoute } from "@/app/(parent)/messages/files/[id]/route";
import { resetDb, seedStaff } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedParentIn, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { seedMessage } from "../helpers/messages";
import { JPEG, PDF } from "../helpers/message-files";
import type { ParentIdentity } from "@/lib/auth/resolve";

/**
 * Club messages, slice 3 (docs/superpowers/specs/2026-11-23-club-messages-design.md, section 5): the parent pages, read
 * state kept per parent, Home's card, staff profiles and the parent file route. tests/integration/parent-isolation.test.ts
 * renders the same pages for two families with B's read row among B's markers.
 */
type Staff = { id: string; name: string; email: string };
const askFile = (id: string) => fileRoute(new Request(`http://localhost/messages/files/${id}`), { params: Promise.resolve({ id }) });
const readRows = (parentId: string) => db.select({ messageId: messageRead.messageId, versionN: messageRead.versionN }).from(messageRead).where(eq(messageRead.parentId, parentId));
const open = (id: string) => renderPage(MessagePage, { params: { id } });

/** A file posted with a message's version, as a save leaves it: held by nobody, listed by the version. */
async function attach(messageId: string, n: number, name: string, bytes: Uint8Array, type: "pdf" | "jpeg") {
  const [v] = await db.select({ id: messageVersion.id }).from(messageVersion).where(and(eq(messageVersion.messageId, messageId), eq(messageVersion.n, n)));
  const [f] = await db.insert(messageFile).values({ messageId, heldBy: null, name, type, size: bytes.byteLength, bytes: Buffer.from(bytes) }).returning({ id: messageFile.id });
  await db.insert(messageVersionFile).values({ versionId: v!.id, fileId: f!.id, position: 0 });
  return f!.id;
}

let coach: Staff, a: SeededParent, partner: ParentIdentity, b: SeededParent;
beforeEach(async () => {
  await resetDb();
  coach = await seedStaff({ email: "coach@club.org", name: "Casey Coach" });
  a = await seedSignedInParent(FAMILY_A);
  b = await seedSignedInParent(FAMILY_B);
  // A second guardian of family A, who reads on their own.
  partner = (await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Sigrid Secondguardian", email: "sigrid.second@family-a.example" })).identity;
});

describe("read and new, per parent", () => {
  it("marks a message read for the parent who opens it alone: not the other guardian of the family, nor another family's parent", async () => {
    const id = await seedMessage({ postedBy: coach.id, titles: ["Picture day"] });
    asParent(a.identity);
    expect(await renderPage(MessagesPage)).toContain(">New<");
    await open(id);
    expect(await readRows(a.identity.parentId)).toEqual([{ messageId: id, versionN: 1 }]);
    expect(await renderPage(MessagesPage)).not.toContain(">New<");
    for (const other of [partner, b.identity]) {
      expect(await readRows(other.parentId)).toEqual([]);
      asParent(other);
      expect(await renderPage(MessagesPage), other.name).toContain(">New<");
    }
  });

  it("moves the read row on to the version shown when the parent opens it again after an edit", async () => {
    const id = await seedMessage({ postedBy: coach.id, titles: ["Picture day"] });
    asParent(a.identity);
    await open(id);
    await db.insert(messageVersion).values({ messageId: id, n: 2, title: "Picture day moved", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Now on Friday." }] }] } });
    await open(id);
    expect(await readRows(a.identity.parentId)).toEqual([{ messageId: id, versionN: 2 }]);
  });

  it("Home: a card counting this parent's new messages with the newest one's title, then a quiet line once all are read, and nothing with none", async () => {
    asParent(a.identity);
    let home = await renderPage(ParentHome);
    expect(home).not.toContain("home-messages");
    const first = await seedMessage({ postedBy: coach.id, titles: ["Car wash Saturday"], postedAt: new Date(Date.now() - 86_400_000) });
    const second = await seedMessage({ postedBy: coach.id, titles: ["Banquet tickets"] });
    home = await renderPage(ParentHome);
    expect(home).toContain("2 new messages from the club");
    expect(home).toContain(`href="/messages/${second}">Banquet tickets</a>`);
    await open(second);
    home = await renderPage(ParentHome);
    expect(home).toContain("1 new message from the club");
    expect(home).toContain(`href="/messages/${first}">Car wash Saturday</a>`);
    await open(first);
    home = await renderPage(ParentHome);
    expect(home).not.toContain("new message");
    expect(home).toContain('href="/messages">Messages</a>');
    // The other guardian of the family still has both to read.
    asParent(partner);
    expect(await renderPage(ParentHome)).toContain("2 new messages from the club");
  });

  it("leaves a deleted message out of every count and list, and answers 404 for it", async () => {
    const admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
    const gone = await seedMessage({ postedBy: coach.id, titles: ["Wrong family's details"], deleted: { by: admin.id } });
    asParent(a.identity);
    expect(await renderPage(MessagesPage)).not.toContain("Wrong family");
    expect(await renderPage(ParentHome)).not.toContain("home-messages");
    expect(await pageOutcome(MessagePage, { params: { id: gone } })).toEqual({ notFound: true });
    expect(await readRows(a.identity.parentId)).toEqual([]);
    for (const bad of ["nope", "00000000-0000-4000-8000-000000000000"]) expect(await pageOutcome(MessagePage, { params: { id: bad } })).toEqual({ notFound: true });
  });
});

describe("a message's page", () => {
  it("shows the current version with its poster's link and Edited, and each earlier version by its date with its own files", async () => {
    const id = await seedMessage({ postedBy: coach.id, titles: ["Practice moved", "Practice moved to Friday"], text: "We meet <script>alert(1)</script> at the field" });
    const oldPdf = await attach(id, 1, "Old schedule.pdf", PDF, "pdf");
    const pic = await attach(id, 2, "Team.jpg", JPEG, "jpeg");
    asParent(a.identity);
    const html = await open(id);
    expect(html).toContain("<h1 class=\"page-title\">Practice moved to Friday</h1>");
    expect(html).toContain(`href="/messages/from/${coach.id}">Casey Coach</a>`);
    expect(html).toContain("Edited");
    expect(html).toContain("Earlier versions");
    expect(html).toContain("Version 1");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain(`href="/messages/files/${oldPdf}"`);
    expect(html).toContain(`href="/messages/files/${pic}"`);
    expect(html).toContain("Old schedule.pdf");
  });

  it("says nothing of an edit for a message with one version", async () => {
    const id = await seedMessage({ postedBy: coach.id, titles: ["Picture day"] });
    asParent(a.identity);
    const html = await open(id);
    expect(html).not.toContain("Edited");
    expect(html).not.toContain("Earlier versions");
  });
});

describe("a staff member's profile", () => {
  it("shows the name, the contact email as a mailto link and their messages, for someone with a message that isn't deleted", async () => {
    await seedMessage({ postedBy: coach.id, titles: ["Picture day"] });
    asParent(a.identity);
    let html = await renderPage(StaffProfilePage, { params: { staffId: coach.id } });
    expect(html).toContain("Casey Coach");
    expect(html).toContain('href="mailto:coach@club.org"');
    expect(html).toContain("Picture day");
    await db.update(staffUser).set({ contactEmail: "band-director@club.org" }).where(eq(staffUser.id, coach.id));
    html = await renderPage(StaffProfilePage, { params: { staffId: coach.id } });
    expect(html).toContain('href="mailto:band-director@club.org"');
    expect(html).not.toContain("coach@club.org");
  });

  it("is not found for a staff member who never posted, one whose only message is deleted, and an id that isn't one", async () => {
    const quiet = await seedStaff({ email: "quiet@club.org", name: "Quinn Quiet" });
    const admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
    await seedMessage({ postedBy: coach.id, titles: ["Gone"], deleted: { by: admin.id } });
    asParent(a.identity);
    for (const staffId of [quiet.id, coach.id, admin.id, "nope", a.identity.parentId]) {
      expect(await pageOutcome(StaffProfilePage, { params: { staffId } }), staffId).toEqual({ notFound: true });
    }
  });
});

describe("the parent file route", () => {
  it("sends a posted file to a signed-in parent, an earlier version's too, no-store and nosniff, a picture inline and anything else as attachment.<ext>", async () => {
    const id = await seedMessage({ postedBy: coach.id, titles: ["Schedule", "Schedule, again"] });
    const pdf = await attach(id, 1, "Schedule \"final\".pdf", PDF, "pdf");
    const pic = await attach(id, 2, "Our <team>.jpg", JPEG, "jpeg");
    asParent(a.identity);
    const d = await askFile(pdf);
    expect(d.status).toBe(200);
    expect(Object.fromEntries(d.headers)).toMatchObject({ "content-type": "application/pdf", "content-disposition": 'attachment; filename="attachment.pdf"', "cache-control": "no-store", "x-content-type-options": "nosniff" });
    expect(new Uint8Array(await d.arrayBuffer())).toEqual(PDF);
    const p = await askFile(pic);
    expect(Object.fromEntries(p.headers)).toMatchObject({ "content-type": "image/jpeg", "content-disposition": 'inline; filename="attachment.jpg"', "cache-control": "no-store" });
  });

  it("answers the same 404 with no bytes for no session, a staff session, a held file, a deleted message's file and an unknown id", async () => {
    const admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
    const id = await seedMessage({ postedBy: coach.id, titles: ["Schedule"] });
    const pdf = await attach(id, 1, "a.pdf", PDF, "pdf");
    const gone = await seedMessage({ postedBy: coach.id, titles: ["Gone"] });
    const goneFile = await attach(gone, 1, "gone.pdf", PDF, "pdf");
    await db.update(clubMessage).set({ deletedAt: new Date(), deletedBy: admin.id }).where(eq(clubMessage.id, gone));
    const [held] = await db.insert(messageFile).values({ messageId: null, heldBy: coach.id, name: "draft.pdf", type: "pdf", size: PDF.byteLength, bytes: Buffer.from(PDF) }).returning({ id: messageFile.id });

    const expectNotFound = async (fileId: string, why: string) => {
      const r = await askFile(fileId);
      expect(r.status, why).toBe(404);
      expect(r.headers.get("cache-control"), why).toBe("no-store");
      expect(await r.text(), why).toBe("Not found");
    };
    await expectNotFound(pdf, "no session");
    asStaff(admin);
    await expectNotFound(pdf, "a staff session");
    asParent(a.identity);
    expect((await askFile(pdf)).status).toBe(200);
    await expectNotFound(held!.id, "a held file");
    await expectNotFound(goneFile, "a deleted message's file");
    await expectNotFound("00000000-0000-4000-8000-000000000000", "an unknown id");
    await expectNotFound("nope", "not an id");
  });
});
