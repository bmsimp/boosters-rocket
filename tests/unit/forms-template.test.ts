import { describe, it, expect } from "vitest";
import type { Envelope, EnvelopeField, EnvelopeRecipient } from "@/lib/documenso/client";
import { checkTemplate } from "@/lib/forms/template";

/**
 * The check a Documenso template passes before the portal makes documents from it (v1 spec 9.1; verification 1a):
 * one or two signers, the name fields found by their labels, and every field the portal fills read-only.
 */
const signer = (id: number, order: number | null = id): EnvelopeRecipient => ({ id, role: "SIGNER", email: `g${id}@placeholder.test`, name: `Guardian ${id}`, token: "t", signingStatus: "NOT_SIGNED", signedAt: null, signingOrder: order });
let nextId = 1;
const text = (recipientId: number, label: string | null, readOnly = true): EnvelopeField => ({ id: nextId++, type: "TEXT", recipientId, label, readOnly });
const sig = (recipientId: number): EnvelopeField => ({ id: nextId++, type: "SIGNATURE", recipientId, label: null, readOnly: false });
const envelope = (recipients: EnvelopeRecipient[], fields: EnvelopeField[], o: Partial<Envelope> = {}): Envelope => ({
  id: "envelope_template01", type: "TEMPLATE", status: "DRAFT", externalId: null, title: "Commitment form", updatedAt: "2026-11-15T02:25:59.386Z", completedAt: null, deletedAt: null, recipients, fields, ...o });
/** The template of the verification: two guardians, the student's name on the first. */
const two = () => envelope([signer(1), signer(2)], [text(1, "Student name"), text(1, "Guardian 1 name"), sig(1), text(2, "Guardian 2 name"), sig(2)]);
const errorsOf = (e: Envelope, appliesTo: "family" | "student" = "student") => { const c = checkTemplate(e, appliesTo); return c.ok ? [] : c.errors; };

describe("checking a template", () => {
  it("accepts two signers with their name fields and the student's name, and says which field is which", () => {
    const e = two();
    const check = checkTemplate(e, "student");
    expect(check).toEqual({ ok: true, plan: { templateId: "envelope_template01", title: "Commitment form", updatedAt: "2026-11-15T02:25:59.386Z",
      signers: [{ recipientId: 1, nameFieldIds: [e.fields[1]!.id] }, { recipientId: 2, nameFieldIds: [e.fields[3]!.id] }], subjectFieldIds: [e.fields[0]!.id] } });
  });

  it("accepts one signer, and finds labels whatever their case or spacing", () => {
    const e = envelope([signer(7)], [text(7, "  student   NAME "), text(7, "guardian 1 name"), sig(7)]);
    const check = checkTemplate(e, "student");
    expect(check.ok && check.plan.signers).toEqual([{ recipientId: 7, nameFieldIds: [e.fields[1]!.id] }]);
    expect(check.ok && check.plan.subjectFieldIds).toEqual([e.fields[0]!.id]);
  });

  it("orders the signers by signing order, then by id", () => {
    const e = envelope([signer(5, 2), signer(9, 1)], [text(9, "Student name"), text(9, "Guardian 1 name"), sig(9), text(5, "Guardian 2 name"), sig(5)]);
    const check = checkTemplate(e, "student");
    expect(check.ok && check.plan.signers.map((s) => s.recipientId)).toEqual([9, 5]);
    const unordered = envelope([signer(4, null), signer(3, null)], [text(3, "Student name"), text(3, "Guardian 1 name"), sig(3), text(4, "Guardian 2 name"), sig(4)]);
    const c = checkTemplate(unordered, "student");
    expect(c.ok && c.plan.signers.map((s) => s.recipientId)).toEqual([3, 4]);
  });

  it("fills every field that carries a label, when a name is printed twice", () => {
    const e = envelope([signer(1)], [text(1, "Student name"), text(1, "Student name"), text(1, "Guardian 1 name"), sig(1)]);
    const check = checkTemplate(e, "student");
    expect(check.ok && check.plan.subjectFieldIds).toHaveLength(2);
  });

  it("refuses a document, no signer, three signers, and a recipient who isn't a signer", () => {
    expect(errorsOf(envelope([signer(1)], [], { type: "DOCUMENT" }))).toEqual([expect.stringContaining("That is a document, not a template")]);
    expect(errorsOf(envelope([], []))).toEqual([expect.stringContaining("has no signer")]);
    expect(errorsOf(envelope([signer(1), signer(2), signer(3)], []))).toEqual([expect.stringContaining("has 3 signers")]);
    expect(errorsOf(envelope([signer(1), { ...signer(2), role: "CC" }], [text(1, "Student name"), text(1, "Guardian 1 name"), sig(1)]))).toEqual([expect.stringContaining("Every recipient of the template must be a signer")]);
  });

  it("refuses a template with a name field missing, and says which label to add", () => {
    expect(errorsOf(envelope([signer(1)], [text(1, "Guardian 1 name"), sig(1)]))).toEqual([expect.stringContaining('no field labelled "Student name"')]);
    expect(errorsOf(envelope([signer(1), signer(2)], [text(1, "Student name"), text(1, "Guardian 1 name"), sig(1), sig(2)]))).toEqual([expect.stringContaining('no field labelled "Guardian 2 name"')]);
    // Every problem at once, so staff can mend them in one visit.
    const all = errorsOf(envelope([signer(1), signer(2)], [sig(1)]));
    expect(all).toHaveLength(4);
    expect(all.join(" ")).toContain("Signer 2 has no signature field");
  });

  it("refuses a name field that is not read-only: a signer could change a student's name with the token alone", () => {
    const open = errorsOf(envelope([signer(1)], [text(1, "Student name", false), text(1, "Guardian 1 name"), sig(1)]));
    expect(open).toEqual([expect.stringContaining('The field "Student name" is not read-only')]);
    expect(open[0]).toContain("switch on Read only");
    const both = errorsOf(envelope([signer(1)], [text(1, "Student name", false), text(1, "Guardian 1 name", false), sig(1)]));
    expect(both).toEqual([expect.stringContaining('"Student name", "Guardian 1 name"')]);
    // A text field the portal doesn't fill may be open: it is the signer's to write in.
    expect(errorsOf(envelope([signer(1)], [text(1, "Student name"), text(1, "Guardian 1 name"), text(1, "Allergies", false), text(1, null, false), sig(1)]))).toEqual([]);
  });

  it("refuses a name field on the wrong signer, one for a signer the template doesn't have, and one that isn't text", () => {
    expect(errorsOf(envelope([signer(1), signer(2)], [text(2, "Student name"), text(1, "Guardian 1 name"), sig(1), text(2, "Guardian 2 name"), sig(2)]))).toEqual([expect.stringContaining('"Student name" must belong to the first signer')]);
    expect(errorsOf(envelope([signer(1), signer(2)], [text(1, "Student name"), text(1, "Guardian 1 name"), sig(1), text(1, "Guardian 2 name"), sig(2)]))).toEqual([expect.stringContaining('"Guardian 2 name" must belong to signer 2')]);
    expect(errorsOf(envelope([signer(1)], [text(1, "Student name"), text(1, "Guardian 1 name"), text(1, "Guardian 2 name"), sig(1)]))).toEqual([expect.stringContaining('labelled "Guardian 2 name" and only one signer')]);
    expect(errorsOf(envelope([signer(1)], [{ ...text(1, "Student name"), type: "NAME" }, text(1, "Guardian 1 name"), sig(1)]))).toEqual([expect.stringContaining("must be text fields")]);
  });

  it("for a form asked once of each family: the family's name is optional, and a student's name has no place", () => {
    expect(errorsOf(envelope([signer(1)], [text(1, "Guardian 1 name"), sig(1)]), "family")).toEqual([]);
    const withFamily = envelope([signer(1)], [text(1, "Family name"), text(1, "Guardian 1 name"), sig(1)]);
    const check = checkTemplate(withFamily, "family");
    expect(check.ok && check.plan.subjectFieldIds).toEqual([withFamily.fields[0]!.id]);
    expect(errorsOf(envelope([signer(1)], [text(1, "Student name"), text(1, "Guardian 1 name"), sig(1)]), "family")).toEqual([expect.stringContaining("signed once for each family")]);
    expect(errorsOf(envelope([signer(1)], [text(1, "Family name"), text(1, "Student name"), text(1, "Guardian 1 name"), sig(1)]), "student")).toEqual([expect.stringContaining('labelled "Family name"')]);
    expect(errorsOf(envelope([signer(1)], [text(1, "Family name", false), text(1, "Guardian 1 name"), sig(1)]), "family")).toEqual([expect.stringContaining("not read-only")]);
  });
});
