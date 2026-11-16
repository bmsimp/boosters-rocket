import { describe, it, expect } from "vitest";
import type { Envelope, EnvelopeRecipient } from "@/lib/documenso/client";
import { STATE_WORDS, UNFINISHED, isMet, readDocument, signersFor, stillRight, wordsFor, type SignerIdentity } from "@/lib/forms/states";

/** The state rules of a form to be signed (v1 spec 9.2, as the Documenso verification changed it). Pure. */
const recipient = (id: number, signingStatus = "NOT_SIGNED", role = "SIGNER"): EnvelopeRecipient => ({ id, role, email: `g${id}@example.org`, name: `G ${id}`, token: "t", signingStatus,
  signedAt: signingStatus === "SIGNED" ? `2026-11-15T0${id}:00:00.000Z` : null, signingOrder: id });
const doc = (status: string, recipients: EnvelopeRecipient[], o: Partial<Envelope> = {}): Envelope => ({ id: "envelope_doc0001", type: "DOCUMENT", status, externalId: "x", title: "t",
  updatedAt: "2026-11-15T00:00:00.000Z", completedAt: null, deletedAt: null, recipients, fields: [], ...o });

describe("reading a document's state", () => {
  it("is complete only when Documenso's status is COMPLETED", () => {
    expect(readDocument(doc("COMPLETED", [recipient(1, "SIGNED")], { completedAt: "2026-11-15T03:00:00.000Z" }))).toMatchObject({ state: "complete", status: "COMPLETED", completedAt: "2026-11-15T03:00:00.000Z", anySigned: true });
    // Every signer has signed and the sealed copy is not made yet: signed, not complete.
    expect(readDocument(doc("PENDING", [recipient(1, "SIGNED"), recipient(2, "SIGNED")])).state).toBe("signed");
    // A completedAt alone proves nothing: a rejected document has one too.
    expect(readDocument(doc("PENDING", [recipient(1)], { completedAt: "2026-11-15T03:00:00.000Z" })).state).toBe("waiting");
  });

  it("is waiting while a signer has not signed, and says who has", () => {
    const reading = readDocument(doc("PENDING", [recipient(1, "SIGNED"), recipient(2)]));
    expect(reading).toMatchObject({ state: "waiting", anySigned: true });
    expect([...reading.signedAt]).toEqual([[1, "2026-11-15T01:00:00.000Z"], [2, null]]);
    expect(readDocument(doc("PENDING", [recipient(1), recipient(2)]))).toMatchObject({ state: "waiting", anySigned: false });
  });

  it("is declined when Documenso says REJECTED, or a recipient rejected", () => {
    expect(readDocument(doc("REJECTED", [recipient(1, "REJECTED")], { completedAt: "2026-11-15T03:00:00.000Z" })).state).toBe("declined");
    expect(readDocument(doc("PENDING", [recipient(1, "SIGNED"), recipient(2, "REJECTED")])).state).toBe("declined");
  });

  it("counts a draft, a cancelled or deleted document, a template and an unknown status as gone", () => {
    expect(readDocument(doc("DRAFT", [recipient(1)])).state).toBe("gone");
    expect(readDocument(doc("CANCELLED", [recipient(1, "SIGNED")])).state).toBe("gone");
    expect(readDocument(doc("PENDING", [recipient(1)], { deletedAt: "2026-11-15T03:00:00.000Z" })).state).toBe("gone");
    expect(readDocument(doc("PENDING", [recipient(1)], { type: "TEMPLATE" })).state).toBe("gone");
    expect(readDocument(doc("SOMETHING_NEW", [recipient(1)])).state).toBe("gone");
    // A pending document with no signer at all is not "signed by everyone".
    expect(readDocument(doc("PENDING", [])).state).toBe("waiting");
  });
});

describe("the words for each state", () => {
  const unsigned = [{ signedAt: null }], half = [{ signedAt: "2026-11-15T01:00:00.000Z" }, { signedAt: null }];
  it("says each state in the words a parent reads", () => {
    expect(wordsFor("not_opened", [])).toBe("Not signed yet");
    expect(wordsFor("waiting", unsigned)).toBe("Not signed yet");
    expect(wordsFor("waiting", half)).toBe("Waiting for the other guardian");
    expect(wordsFor("signed", half)).toBe("Signed, being finished");
    expect(wordsFor("complete", half)).toBe("Signed");
    expect(wordsFor("declined", unsigned)).toBe("Declined");
    expect(STATE_WORDS.notReady).toBe("Not ready yet");
  });
  it("meets the requirement only when complete, and keeps asking about the two states in between", () => {
    expect((["not_opened", "waiting", "signed", "complete", "declined"] as const).filter(isMet)).toEqual(["complete"]);
    expect(UNFINISHED).toEqual(["waiting", "signed"]);
  });
});

describe("who a document is made for", () => {
  const ana: SignerIdentity = { parentId: "p-ana", name: "Ana Rivera", email: "ana@example.com" };
  const ben: SignerIdentity = { parentId: "p-ben", name: "Ben Rivera", email: "ben@example.com" };
  const cat: SignerIdentity = { parentId: "p-cat", name: "Cat Rivera", email: "cat@example.com" };

  it("any one guardian: the guardian who opens it", () => {
    expect(signersFor("any", 2, ben, [ana, ben])).toEqual([ben]);
  });
  it("every guardian: those with a sign-in, the opener first, up to the template's signers", () => {
    expect(signersFor("every", 2, ben, [ana, ben])).toEqual([ben, ana]);
    expect(signersFor("every", 2, ana, [ana])).toEqual([ana]);
    expect(signersFor("every", 1, ben, [ana, ben])).toEqual([ben]);
    expect(signersFor("every", 2, cat, [ana, ben, cat])).toEqual([cat, ana]);
  });

  const made = { templateId: "envelope_t1", templateUpdatedAt: 1000, mode: "every" as const, subjectName: "Leo Rivera", signers: [ana, ben] };
  const now = { templateId: "envelope_t1", templateUpdatedAt: 1000, mode: "every" as const, roles: 2, subjectName: "Leo Rivera", viewer: ana, guardians: [ana, ben] };
  it("keeps an unsigned document that is still right, whoever of its guardians opens it", () => {
    expect(stillRight(made, now)).toBe(true);
    expect(stillRight(made, { ...now, viewer: ben })).toBe(true);
    expect(stillRight({ ...made, signers: [{ ...ana, email: "ANA@example.com" }, ben] }, now)).toBe(true);
    // Made from a later state of the template than the one staff attached: still that template.
    expect(stillRight({ ...made, templateUpdatedAt: 2000 }, now)).toBe(true);
  });
  it.each([
    ["the student's name changed", made, { ...now, subjectName: "Leo Rivera-Cruz" }],
    ["a guardian's name changed", made, { ...now, guardians: [ana, { ...ben, name: "Benjamin Rivera" }] }],
    ["a guardian's address changed", made, { ...now, guardians: [ana, { ...ben, email: "ben@new.example" }] }],
    ["a guardian left the family", made, { ...now, guardians: [ana] }],
    ["a guardian joined and the template has room", { ...made, signers: [ana] }, now],
    ["staff attached another template", made, { ...now, templateId: "envelope_t2" }],
    ["staff attached the template again after changing it", made, { ...now, templateUpdatedAt: 3000 }],
    ["who must sign changed", made, { ...now, mode: "any" as const }],
    ["any one guardian, and the other guardian opens it", { ...made, mode: "any" as const, signers: [ana] }, { ...now, mode: "any" as const, viewer: ben }],
    ["the guardian who opens it is not on it", made, { ...now, viewer: cat, guardians: [ana, ben, cat] }],
    ["nothing was recorded of what it was made from", { ...made, templateUpdatedAt: null }, now],
  ])("makes it again when %s", (_why, was, is) => {
    expect(stillRight(was, is)).toBe(false);
  });
});
