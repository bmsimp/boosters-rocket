// Parent-facing: a parent reads and changes their phone and mailing address (v1 spec §6.2, §6.3), the portal's own since
// stage 3's slice 11a of the app-owned families spec: the person's own in books with a parent type, the family's (shared
// by its guardians) in books with none (open question 6; whoseDetails(), ./my-family.ts). Nothing here reads or writes
// QuickBooks or the roster cache: since stage 3's slice 11b the save queues each change, in its own transaction, to be
// sent on by the write queue's worker (./contact-queue.ts), and the parent waits on none of it. Privacy: whose details are decided from the session's
// ParentCtx and nothing else (ctx.parentId, or ctx.familyId). Nothing a browser sends ever names a person, a family or a
// customer: the form carries the new values and the version it was shown, never an id. This module is in the
// staff-only import scan (tests/integration/page-guards.test.ts), and names none of the client's writes
// (tests/unit/quickbooks-writes.test.ts).
import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, parent, type ContactDetails } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { getShape } from "@/lib/roster/shape";
import { fieldErrors, formVersion, parseContactForm, sameAddress, samePhone, type ContactForm, type ContactValues } from "./contact-fields";
import { queueContactChange, type DetailsOf } from "./contact-queue";
import { readMyDetails, type MyContact, type MyDetails } from "./my-family";
import { takeRateLimit } from "./rate-limit";
import { parentActor } from "./sessions";

export const CONTACT_COPY = {
  saved: "Saved. These are your details now.",
  savedFamily: "Saved. These are your family's details now, for every parent in your family.",
  nothingChanged: "Those are the details you already have here, so there was nothing to change.",
  changed: "Your details changed while you were editing, so nothing was saved. Here they are as they stand now. Please make your change again.",
  tooMany: "You've saved your details a few times in the last hour. Please wait a little while before trying again.",
  askTheClub: "These details can't be changed here. Please ask the club and they'll update them.",
} as const;

const actorOf = (ctx: ParentCtx) => parentActor({ id: ctx.parentId, email: ctx.email });
const formOf = (d: MyDetails): ContactForm => ({ values: d.values, version: formVersion(d.whose, d.version) });
/** The audit row's target: the person, or the app's family whose details they are. */
const targetOf = (of: DetailsOf) =>
  of.kind === "family" ? { targetType: "family", targetId: String(of.familyId) } : { targetType: "parent", targetId: of.parentId };
/** Whose details the session's are, from the session alone: the person's own, or the session's family's. */
const whoseOf = (ctx: ParentCtx, whose: MyDetails["whose"]): DetailsOf =>
  whose === "family" ? { kind: "family", familyId: ctx.familyId } : { kind: "person", parentId: ctx.parentId };

export type ContactView =
  /** A family the portal may not show (its record is not active): nothing to edit. */
  | { state: "none" }
  /** The details as the portal holds them, the person's own or their family's, and the form to change them. */
  | { state: "ok"; me: MyContact & { email: string; edits: "own" | "family" }; form: ContactForm };

/**
 * The signed-in parent's phone and address for the edit page, from the portal's own records alone (readMyDetails()):
 * every guardian the gate lets in gets them, with or without a QuickBooks record. It asks QuickBooks nothing, so it
 * takes no rate limit; a parent reading their own details is not audited.
 */
export async function loadMyContact(ctx: ParentCtx): Promise<ContactView> {
  const details = await readMyDetails(ctx, await getShape());
  if (!details) return { state: "none" };
  return { state: "ok", me: { name: details.name, email: details.email, phone: details.values.phone || null, edits: details.whose === "family" ? "family" : "own" },
    form: formOf(details) };
}

/**
 * `current`, when given, is the details as the portal holds them now: the form shows them in place of what was typed.
 * Otherwise the shape every action returns (AGENTS.md).
 */
export type SaveContactResult = { ok: true; message: string; current: ContactForm } | { ok: false; errors: string[]; current?: ContactForm };

/** Whether the phone or the address changed: the address is saved whole when any part of it did. */
type Change = { phone: boolean; address: boolean };
/** What the audit log keeps of a change: only the part that changed, phone or address. */
const auditValues = (v: ContactValues, change: Change) => ({
  ...(change.phone ? { phone: v.phone } : {}),
  ...(change.address ? { address: { line1: v.line1, line2: v.line2, city: v.city, region: v.region, postalCode: v.postalCode, country: v.country } } : {}),
});
/** The columns a change sets, in a person's or a family's row: what is empty is stored as null. */
const columnsOf = (v: ContactValues, change: Change) => ({
  ...(change.phone ? { phone: v.phone || null } : {}),
  ...(change.address ? { addressLine1: v.line1 || null, addressLine2: v.line2 || null, addressCity: v.city || null, addressRegion: v.region || null,
    addressPostalCode: v.postalCode || null, addressCountry: v.country || null } : {}),
});


/** The details a save reads and writes, from the portal's own row: the person's, or the app family's while its record is active. */
async function heldBy(of: DetailsOf): Promise<{ values: ContactValues; version: number } | null> {
  const cols = (t: typeof parent | typeof family) => ({ phone: t.phone, addressLine1: t.addressLine1, addressLine2: t.addressLine2, addressCity: t.addressCity,
    addressRegion: t.addressRegion, addressPostalCode: t.addressPostalCode, addressCountry: t.addressCountry, contactVersion: t.contactVersion });
  const [r] = of.kind === "family"
    ? await db.select(cols(family)).from(family).where(and(eq(family.id, of.familyId), eq(family.active, true)))
    : await db.select(cols(parent)).from(parent).where(eq(parent.id, of.parentId));
  if (!r) return null;
  return { version: r.contactVersion, values: { phone: r.phone ?? "", line1: r.addressLine1 ?? "", line2: r.addressLine2 ?? "", city: r.addressCity ?? "",
    region: r.addressRegion ?? "", postalCode: r.addressPostalCode ?? "", country: r.addressCountry ?? "" } };
}
/** A change as a queued item carries it (ContactDetails): only the parts that changed, the address whole. */
const detailsOf = (v: ContactValues, change: Change): ContactDetails => auditValues(v, change);

/**
 * What one save came to: `saved` (with the details as they stand now, and how many changes were queued to be sent on);
 * `unchanged`, nothing differed; `stale`, the form was drawn at another version, or for the other row, or the row was
 * saved meanwhile (`current`, the details as they stand, null when the row is gone); `invalid`, a changed field can't be
 * saved (`errors`); `none`, there is no such row (a family whose record is not active).
 */
export type SaveDetailsOutcome =
  | { is: "saved"; current: ContactForm; queued: number }
  | { is: "unchanged"; current: ContactForm }
  | { is: "stale"; current: ContactForm | null }
  | { is: "invalid"; errors: string[] }
  | { is: "none" };

/**
 * The one save of a person's or a family's phone and mailing address in the portal (stage 3's slices 11a and 11b):
 * `of`, whose details (a person's id, or an app family's id with the details the family's), from the caller and never
 * from a browser; `form`, the values and the version it was drawn at, read already (parseContactForm()); `o`, who saves,
 * and the permission they use, where there is one. Called only by saveMyContact() in this slice (S11c adds staff).
 *
 * What changed is found by comparing the form with the details at the form's version. If the version is not the one
 * the row holds now, or was drawn for the other row (`p:` for a person's, `f:` for a family's), nothing is saved (v1 spec
 * §6.3). Otherwise only the fields that differ are checked for length and characters (fieldErrors()): a value taken in
 * from QuickBooks can be longer than the portal lets a parent type. When any part of the address differs the whole
 * address is saved as the form held it.
 *
 * The save is one update that matches only while the row's `contact_version` is still the form's, raising it by one,
 * with, in that same transaction, the changes to send on queued for each record the details go to
 * (queueContactChange(), ./contact-queue.ts: the own Parent customer of each of the person's open memberships, or the
 * family's own linked customer), and `parent.details.save` (before and after, only what changed, and the items queued,
 * `queueIds`). Nothing is sent here, and nothing here waits on QuickBooks or on a lock a sender holds: the write queue's
 * worker sends each at its next wake.
 */
export async function saveDetails(of: DetailsOf, form: ContactForm, o: { actor: Actor; ip: string | null; permission?: string }): Promise<SaveDetailsOutcome> {
  const whose = of.kind === "family" ? "family" : "person";
  const formAt = (h: { values: ContactValues; version: number }): ContactForm => ({ values: h.values, version: formVersion(whose, h.version) });
  const before = await heldBy(of);
  if (!before) return { is: "none" };
  if (formVersion(whose, before.version) !== form.version) return { is: "stale", current: formAt(before) };
  const { values } = form;
  const errors = fieldErrors(values, before.values);
  if (errors.length) return { is: "invalid", errors };

  const change: Change = { phone: !samePhone(values, before.values), address: !sameAddress(values, before.values) };
  if (!change.phone && !change.address) return { is: "unchanged", current: formAt(before) };
  const now: ContactValues = { ...before.values, ...(change.phone ? { phone: values.phone } : {}),
    ...(change.address ? { line1: values.line1, line2: values.line2, city: values.city, region: values.region, postalCode: values.postalCode, country: values.country } : {}) };

  const saved = await db.transaction(async (tx) => {
    const set = { ...columnsOf(values, change), updatedAt: new Date() };
    // Only while the row still holds the version the form was shown: one update, so nothing saved meanwhile is lost.
    const rows = of.kind === "family"
      ? await tx.update(family).set({ ...set, contactVersion: sql`${family.contactVersion} + 1` })
        .where(and(eq(family.id, of.familyId), eq(family.active, true), eq(family.contactVersion, before.version))).returning({ version: family.contactVersion })
      : await tx.update(parent).set({ ...set, contactVersion: sql`${parent.contactVersion} + 1` })
        .where(and(eq(parent.id, of.parentId), eq(parent.contactVersion, before.version))).returning({ version: parent.contactVersion });
    if (rows.length === 0) return null;
    // Sent on after the save, never before (the lead's decision 1): queued here, in the same transaction.
    const queueIds = await queueContactChange(tx, of, { change: detailsOf(values, change), was: detailsOf(before.values, change),
      now: detailsOf(now, { phone: true, address: true }) as Required<ContactDetails> }, o);
    await writeAudit({ actor: o.actor, action: "parent.details.save", permission: o.permission, ...targetOf(of),
      before: auditValues(before.values, change), after: { ...auditValues(values, change), ...(queueIds.length ? { queueIds } : {}) }, ip: o.ip }, tx);
    return { version: rows[0]!.version, queued: queueIds.length };
  });
  if (saved === null) {
    // Saved meanwhile (another device, or another parent of the family): the details as they stand now.
    const current = await heldBy(of);
    return { is: "stale", current: current ? formAt(current) : null };
  }
  return { is: "saved", current: { values: now, version: formVersion(whose, saved.version) }, queued: saved.queued };
}

/**
 * Saves the signed-in parent's phone and address: the person's own, or, in books with no parent type, the session's
 * family's (ctx.familyId, only while its record is active), by the one save (saveDetails()). `input` is what the browser
 * sent, untrusted: it is read whole (parseContactForm) and holds no id; whose details they are comes from the session
 * alone (ctx.parentId, or ctx.familyId while whoseDetails() says the family's). The parent is told only that their
 * details are saved, in today's words, whatever is queued for QuickBooks or later happens there (the lead's decision 4):
 * nothing a parent reads mentions QuickBooks. A refused or failed save is audited with its short code.
 */
export async function saveMyContact(ctx: ParentCtx, input: unknown): Promise<SaveContactResult> {
  const refuse = async (code: string, errors: string[], whose?: MyDetails["whose"], current?: ContactForm): Promise<SaveContactResult> => {
    await writeAudit({ actor: actorOf(ctx), action: "parent.details.save.failed", ...(whose ? targetOf(whoseOf(ctx, whose)) : {}), after: { code: code.slice(0, 40) }, ip: ctx.ip });
    return { ok: false, errors, ...(current ? { current } : {}) };
  };

  // Counted first, so that whatever follows (an audit row for each refusal among it) is bounded per person.
  const take = await takeRateLimit("contact_save_parent", ctx.parentId);
  if (take === "refused") return { ok: false, errors: [CONTACT_COPY.tooMany] };
  if (take === "first_refusal") return refuse("rate_limited", [CONTACT_COPY.tooMany]);

  const parsed = parseContactForm(input);
  if (!parsed.ok) return refuse("invalid", parsed.errors); // not this form at all

  // The session's own details (the person's, or the family's while its record is active): nothing else is saved from here.
  const shown = await readMyDetails(ctx, await getShape());
  if (!shown) return refuse("no_record", [CONTACT_COPY.askTheClub]);
  const r = await saveDetails(whoseOf(ctx, shown.whose), parsed.form, { actor: actorOf(ctx), ip: ctx.ip });
  switch (r.is) {
    case "none": return refuse("no_record", [CONTACT_COPY.askTheClub], shown.whose);
    // The version names whose details the form was drawn for as well as their version: a form drawn for the person's
    // details that comes back after a shape save made them the family's (or the other way round) is answered as details
    // changed while editing.
    case "stale": return r.current ? refuse("stale", [CONTACT_COPY.changed], shown.whose, r.current) : refuse("no_record", [CONTACT_COPY.askTheClub], shown.whose);
    case "invalid": return refuse("invalid", r.errors, shown.whose);
    case "unchanged": return { ok: true, message: CONTACT_COPY.nothingChanged, current: r.current };
    case "saved": return { ok: true, message: shown.whose === "family" ? CONTACT_COPY.savedFamily : CONTACT_COPY.saved, current: r.current };
  }
}
