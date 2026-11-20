// Parent-facing: a parent reads and changes their phone and mailing address (v1 spec §6.2, §6.3), the portal's own since
// stage 3's slice 11a of the app-owned families spec: the person's own in books with a parent type, the family's (shared
// by its guardians) in books with none (open question 6; whoseDetails(), ./my-family.ts). Nothing here reads or writes
// QuickBooks or the roster cache: S11b sends each change on. Privacy: whose details are decided from the session's
// ParentCtx and nothing else (ctx.parentId, or ctx.familyId). Nothing a browser sends ever names a person, a family or a
// customer: the form carries the new values and the version it was shown, never an id. This module is in the
// staff-only import scan (tests/integration/page-guards.test.ts), and names none of the client's writes
// (tests/unit/quickbooks-writes.test.ts).
import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, parent } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { getShape } from "@/lib/roster/shape";
import { fieldErrors, parseContactForm, sameAddress, samePhone, type ContactForm, type ContactValues } from "./contact-fields";
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
const formOf = (d: MyDetails): ContactForm => ({ values: d.values, version: String(d.version) });
/** The audit row's target: the person, or the app's family whose details they are. */
const targetOf = (ctx: ParentCtx, whose: MyDetails["whose"]) =>
  whose === "family" ? { targetType: "family", targetId: String(ctx.familyId) } : { targetType: "parent", targetId: ctx.parentId };

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

/**
 * Saves the signed-in parent's phone and address in the portal: the person's own, or, in books with no parent type, the
 * session's family's (ctx.familyId, only while its record is active). `input` is what the browser sent, untrusted: it is
 * read whole (parseContactForm) and holds no id.
 *
 * What changed is found by comparing what the browser sent with the details as the form showed them, which are the
 * portal's values at the form's version. If the version is not the one the row holds now, nothing is saved: the parent
 * is told the details changed and given them as they stand (v1 spec §6.3). Otherwise only the fields that differ are
 * checked for length and characters (fieldErrors): a value taken in from QuickBooks can be longer than the portal lets
 * a parent type, and a parent who changes their phone is not asked to fix a city they never touched. When any part of
 * the address differs the whole address is saved as the parent saw it.
 *
 * The save is one update that matches only while the row's `contact_version` is still the form's, raising it by one,
 * with its audit row (before and after, only what changed) in the same transaction: a save made meanwhile, from
 * another family's session or another device, is never overwritten. A refused or failed save is audited with its
 * short code. Nothing is sent to QuickBooks (S11b sends each change on).
 */
export async function saveMyContact(ctx: ParentCtx, input: unknown): Promise<SaveContactResult> {
  const refuse = async (code: string, errors: string[], whose?: MyDetails["whose"], current?: ContactForm): Promise<SaveContactResult> => {
    await writeAudit({ actor: actorOf(ctx), action: "parent.details.save.failed", ...(whose ? targetOf(ctx, whose) : {}), after: { code: code.slice(0, 40) }, ip: ctx.ip });
    return { ok: false, errors, ...(current ? { current } : {}) };
  };

  // Counted first, so that whatever follows (an audit row for each refusal among it) is bounded per person.
  const take = await takeRateLimit("contact_save_parent", ctx.parentId);
  if (take === "refused") return { ok: false, errors: [CONTACT_COPY.tooMany] };
  if (take === "first_refusal") return refuse("rate_limited", [CONTACT_COPY.tooMany]);

  const parsed = parseContactForm(input);
  if (!parsed.ok) return refuse("invalid", parsed.errors); // not this form at all
  const { values, version } = parsed.form;

  const shape = await getShape();
  const before = await readMyDetails(ctx, shape);
  if (!before) return refuse("no_record", [CONTACT_COPY.askTheClub]);
  if (String(before.version) !== version) return refuse("stale", [CONTACT_COPY.changed], before.whose, formOf(before));
  const errors = fieldErrors(values, before.values);
  if (errors.length) return refuse("invalid", errors, before.whose);

  const change: Change = { phone: !samePhone(values, before.values), address: !sameAddress(values, before.values) };
  if (!change.phone && !change.address) return { ok: true, message: CONTACT_COPY.nothingChanged, current: formOf(before) };

  const saved = await db.transaction(async (tx) => {
    const set = { ...columnsOf(values, change), updatedAt: new Date() };
    // Only while the row still holds the version the form was shown: one update, so nothing saved meanwhile is lost.
    const rows = before.whose === "family"
      ? await tx.update(family).set({ ...set, contactVersion: sql`${family.contactVersion} + 1` })
        .where(and(eq(family.id, ctx.familyId), eq(family.active, true), eq(family.contactVersion, before.version))).returning({ version: family.contactVersion })
      : await tx.update(parent).set({ ...set, contactVersion: sql`${parent.contactVersion} + 1` })
        .where(and(eq(parent.id, ctx.parentId), eq(parent.contactVersion, before.version))).returning({ version: parent.contactVersion });
    if (rows.length === 0) return null;
    await writeAudit({ actor: actorOf(ctx), action: "parent.details.save", ...targetOf(ctx, before.whose),
      before: auditValues(before.values, change), after: auditValues(values, change), ip: ctx.ip }, tx);
    return rows[0]!.version;
  });
  if (saved === null) {
    // Saved meanwhile (another device, or another parent of the family): show the details as they stand now.
    const now = await readMyDetails(ctx, shape);
    return now ? refuse("stale", [CONTACT_COPY.changed], before.whose, formOf(now)) : refuse("no_record", [CONTACT_COPY.askTheClub], before.whose);
  }
  const current: ContactForm = { values: { ...before.values, ...(change.phone ? { phone: values.phone } : {}),
    ...(change.address ? { line1: values.line1, line2: values.line2, city: values.city, region: values.region, postalCode: values.postalCode, country: values.country } : {}) },
  version: String(saved) };
  return { ok: true, message: before.whose === "family" ? CONTACT_COPY.savedFamily : CONTACT_COPY.saved, current };
}
