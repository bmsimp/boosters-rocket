"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { blockPerson, renamePerson, unblockPerson } from "@/lib/parents/people";
import { addGuardian, reinstateGuardian, releaseSigninHold, removeGuardian, signinHeldOfGuardian, signinHoldOf } from "@/lib/parents/guardians";
import { familyRecordAt } from "@/lib/families/address";
import { resendWelcome } from "@/lib/parents/welcome";
import { resetSignin } from "@/lib/parents/signin-reset";
import { can } from "@/lib/permissions/effective";
import { getPerson } from "@/lib/parents/directory";
import { parseContactForm, type ContactForm } from "@/lib/parents/contact-fields";
import { saveDetails } from "@/lib/parents/contact-edits";
import { whoseDetails } from "@/lib/parents/my-family";
import { getShape } from "@/lib/roster/shape";
import { contactSavedWords, SAVED_LEASE_MS, sendContactSaved, STAFF_DETAILS_COPY } from "@/lib/roster/writes";

// Seeing parents, their names, blocking and the welcome are Parents.ReadWrite's. Giving an address a family's sign-in,
// or ending one, is Roster.Family.ReadWrite's (with the Roster.Read it brings): the permission that changes a family
// (the lead's choice in stage 3's slice 7b; spec section 6). Each audit row records the permission used.
const P = "Parents.ReadWrite" as const;
const R = "Roster.Family.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const op = (ctx: StaffCtx, permission: typeof P | typeof R = P) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission });
// A successful change re-renders the page, so a person's page records one more `parent.read`: by design, as the staff
// member is shown the person again.
const refresh = () => revalidatePath("/staff", "layout");

// A server action can be called with any values, not only the ones its page sends: each argument is checked here,
// before the library sees it. A value no page sends gets one plain refusal.
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const ID_MAX = 64, TEXT_MAX = 2000;
// A person's ID is a UUID; anything else would reach Postgres as a bad cast and throw.
const personId = (v: unknown): v is string => str(v, ID_MAX) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export const blockAction = staffAction(P, async (ctx, parentId: string, reason: string): Promise<Done> => {
  if (!personId(parentId) || !str(reason, TEXT_MAX)) return NOT_FROM_PAGE;
  const r = await blockPerson(parentId, reason, op(ctx));
  if (!r.ok) return { ok: false, errors: [r.reason === "invalid" ? "Say why, in a few words. Only staff see it." : "That person isn't in the portal any more."] };
  refresh();
  return { ok: true, message: "Blocked. They are signed out, and can't sign in, get a sign-in code or use a password link." };
});

export const unblockAction = staffAction(P, async (ctx, parentId: string): Promise<Done> => {
  if (!personId(parentId)) return NOT_FROM_PAGE;
  const r = await unblockPerson(parentId, op(ctx));
  if (!r.ok) return { ok: false, errors: ["That person isn't in the portal any more."] };
  if (!r.changed) return { ok: true, message: "This person isn't blocked." }; // nothing changed: nothing to show again
  refresh();
  return { ok: true, message: "Unblocked." };
});

const RESEND_FAILED = {
  not_found: "That person isn't in the portal any more.", blocked: "This person is blocked, so no email was sent.",
  no_access: "This person can't sign in to any family right now, so no email was sent.",
  on_its_way: "An email with a link to choose a password is on its way to this person, or went to them less than a minute ago, so no other was sent: a new one would stop that link working. If they still need one, try again in a minute.",
  mail_failed: "The email couldn't be sent. Check outgoing mail under Mail.",
  link_not_in_place: "The email went, but something changed for this person while it was on its way, so the link in it to choose a password won't work. Look at their page again before sending another.",
} as const;
// What the welcome carried, never the link itself.
const RESENT = {
  setup: "Sent, with a link to choose a password.",
  none: "Sent. They have a password, so it says to sign in with it.",
  not_in_place: "Sent. They chose a password while it was on its way, so they can sign in with it.",
} as const;
export const resendWelcomeAction = staffAction(P, async (ctx, parentId: string): Promise<Done> => {
  if (!personId(parentId)) return NOT_FROM_PAGE;
  const r = await resendWelcome(parentId, op(ctx));
  if (!r.ok) return { ok: false, errors: [RESEND_FAILED[r.reason]] };
  refresh();
  return { ok: true, message: RESENT[r.link] };
});

// An Admin's reset of a parent's sign-in (the sign-in release, slice SI-9a; open question 22): Admin-only, kept apart
// from Parents.ReadWrite, which this page needs too. The box says the Admin called the person back on a number the club
// already holds and they asked for it; the reason is for staff only. Each answer in its own words.
const RESET = "Parents.SignInReset.ReadWrite" as const;
const RESET_REFUSED = {
  invalid: "Tick the box to say you called them back, and say why, in a few words. Only staff see it.",
  blocked: "This person is blocked. Unblock them first if they should sign in again.",
  no_access: "This person can't sign in to any family right now, so there's nothing to reset.",
  signins_off: "Parent sign-ins are switched off, so nothing was reset.",
  rate_limited: "This person's sign-in has been reset three times today already. Try again tomorrow, or ask another Admin to look.",
  not_found: "That person isn't in the portal any more.",
} as const;
// The Resend welcome email press waits a minute after a set-up link was made (resendWelcome()'s `on_its_way`), so the
// mail-failed words say so. The link the reset made works but was never mailed, and the worker's welcome to a person still
// owed one takes it as the link "emailed to you earlier" (welcome.ts's `earlier`) and carries none: the words say so, so
// the Admin presses Resend all the same.
const RESET_UNMAILED = "Their sign-in was reset and they're signed out everywhere, but the email with the link couldn't be sent. Check outgoing mail under Settings, Outgoing mail, then, in a minute, send them a link with Resend welcome email. A welcome email the portal sends them meanwhile won't carry one.";
// A reset whose mail couldn't be handed over went through, and needs attention: the answer says so, and what to do next.
type ResetDone = Done | { ok: true; message: string; status: "attention" };
export const resetSigninAction = staffAction(RESET, async (ctx, parentId: string, reason: string, calledBack: boolean): Promise<ResetDone> => {
  if (!personId(parentId) || !str(reason, TEXT_MAX) || typeof calledBack !== "boolean") return NOT_FROM_PAGE;
  if (!calledBack || !reason.trim()) return { ok: false, errors: [RESET_REFUSED.invalid] };
  const r = await resetSignin(parentId, { reason, calledBack }, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: RESET });
  if (!r.ok) return { ok: false, errors: [RESET_REFUSED[r.reason]] };
  refresh();
  return r.mailed ? { ok: true, message: `Reset. They're signed out everywhere, and a link to choose a new password is on its way to ${r.to}.` }
    : { ok: true, message: RESET_UNMAILED, status: "attention" };
});

// A family's guardians (stage 3's slice 7b), from a family's roster page or a person's page. Each id is the app's own
// (a family record's, a guardian row's, a person's): one that isn't a uuid, or isn't there, gets the plain refusal.
const NAME_FIELD_MAX = 200, EMAIL_FIELD_MAX = 320, NOTE_MAX = 2000;
// A roster read holds the roster lock for its whole QuickBooks read: a write that can't have it within a few seconds
// changes nothing and says so.
const BUSY_WORDS = "The roster is being read from QuickBooks just now, so nothing was changed. Try again in a minute.";
const WAITING_WORDS = "Making this family in QuickBooks is still waiting on the queue, so nobody can be added to it for now. Once it has gone through, or been given up on the Reconciliation page, try again.";
const MAKING_WORDS = "This family is being made in QuickBooks at this moment, so nobody can be added to it. Try again in a minute.";
// The family being changed in QuickBooks at this moment (made inactive with everyone under it, or renamed): stage 3's slice 9h.
const CHANGING_WORDS = "This family is being changed in QuickBooks at this moment, so nobody can be added to it. Try again in a minute.";
// A change to the guardian's own Parent customer in QuickBooks waiting or stuck on the queue (stage 3's slice 9h).
const QBO_PENDING_WORDS = "A change to this guardian's Parent customer in QuickBooks is waiting or stuck on the Reconciliation page, so nothing was changed. Once it has gone through, or been given up there, try again.";
// Someone holds the guardian row's "being sent" lock at this moment: another staff member's change to them being saved,
// or a change to their Parent customer on its way to QuickBooks. Each refusal says its own cause.
const BEING_CHANGED_WORDS = "This guardian is being changed at this moment (by someone else here, or a change to their Parent customer on its way to QuickBooks), so nothing was changed. Try again in a minute.";
// Another add of the same address to the same family got there first.
const RACED_WORDS = "Someone else changed this guardian at the same moment, so nothing was changed. Reload the page to see where they stand, then try again if you need to.";
/** What became of the Parent customer in QuickBooks, after the portal's own sentence (stage 3's slice 9h). */
const withQuickBooks = (said: string, quickbooks: string[]) => [said, ...quickbooks].join(" ");
const OTHER_COMPANY_WORDS = "QuickBooks is connected to a different company from the one this roster was read from, so the portal can't tell which customer this family is linked to, and nobody was added. An Admin can sort that out under QuickBooks.";
const ADD_REFUSED = {
  invalid_name: "Give the guardian's name, up to 100 characters.",
  invalid_email: "That isn't an email address the portal can send sign-in emails to. Check it and try again.",
  no_family: NOT_FROM_PAGE.errors[0]!,
  inactive: "This family is inactive in the portal, so nobody can be added to it.",
  waiting: WAITING_WORDS,
  making: MAKING_WORDS,
  changing: CHANGING_WORDS,
  other_company: OTHER_COMPANY_WORDS,
  blocked: "The person with this address is blocked. Unblock them on their page first.",
  already: "The person with this address is already one of this family's guardians.",
  busy: BUSY_WORDS,
  qbo_pending: QBO_PENDING_WORDS,
  being_changed: BEING_CHANGED_WORDS,
  raced: RACED_WORDS,
} as const;

/** An add that found the address held by a person already: nothing was written, and staff are asked whether it is them. */
type AddDone = Done | { ok: false; errors: string[]; samePerson: string };
const listed = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

// `samePerson`: null on a first press; on the press that answers "Is this the same person?", the id of the person the
// page was shown. The library checks it again under the locks and asks again if the address belongs to anyone else now.
export const addGuardianAction = staffAction(R, async (ctx, familyId: string, name: string, email: string, samePerson: string | null = null): Promise<AddDone> => {
  if (!personId(familyId) || !str(name, NAME_FIELD_MAX) || !str(email, EMAIL_FIELD_MAX) || (samePerson !== null && !personId(samePerson))) return NOT_FROM_PAGE;
  const family = await familyRecordAt(familyId);
  if (!family) return NOT_FROM_PAGE;
  const r = await addGuardian(family, { name, email, samePerson }, op(ctx, R));
  if (!r.ok && r.reason === "same_person") {
    const where = r.person.families.length === 0 ? "who isn't a guardian of any family now" : `a guardian of ${listed(r.person.families)}`;
    return { ok: false, samePerson: r.person.id, errors: [`This address already belongs to ${r.person.name}, ${where}. Nothing has been changed yet. If this is the same person, press "Yes, add them": they are added under the name they have. If not, check the address.`] };
  }
  if (!r.ok) return { ok: false, errors: [ADD_REFUSED[r.reason]] };
  refresh();
  // Said of a person who held the address already, between their name and what follows it.
  const known = r.person === "existing" ? ", who already had a sign-in with this address (their name is unchanged)" : "";
  const held = (await signinHoldOf(family)) !== null ? ` ${HELD_STILL}` : "";
  return { ok: true, message: withQuickBooks(r.outcome === "reinstated"
    ? `${r.name}${known}${known ? "," : ""} was a guardian of this family before: their sign-in for it is back. They sign in with this address and their password while parent sign-ins are on; if they haven't chosen one, Resend welcome email on their page sends them a link to choose it.${held}`
    : `Added ${r.name}${known}. They sign in with this address and a password while parent sign-ins are on. If they have never had a welcome email and welcome emails are on, they are sent one, with a link to choose a password if they have none.${held}`, r.quickbooks) };
});

export const removeGuardianAction = staffAction(R, async (ctx, guardianId: string, note: string): Promise<Done> => {
  if (!personId(guardianId) || !str(note, NOTE_MAX)) return NOT_FROM_PAGE;
  const r = await removeGuardian(guardianId, note, op(ctx, R));
  if (!r.ok) {
    if (r.reason === "busy") return { ok: false, errors: [BUSY_WORDS] };
    if (r.reason === "invalid_note") return { ok: false, errors: ["Say why, in a few words. Only staff see it."] };
    if (r.reason === "not_open") return { ok: true, message: "This guardian can't sign in to this family already." }; // nothing changed
    return NOT_FROM_PAGE;
  }
  refresh();
  return { ok: true, message: withQuickBooks("Removed. They can't sign in to this family any more, and are signed out of it.", r.quickbooks) };
});

const REINSTATE_REFUSED = {
  previous_company: "This sign-in was from a different QuickBooks company, so it can't be brought back.",
  blocked: "This person is blocked. Unblock them on their page first.",
  no_family: "This sign-in isn't in a family the portal holds, so it can't be brought back.",
  inactive: "This family is inactive in the portal, so nobody can sign in to it.",
  waiting: WAITING_WORDS.replace("nobody can be added to it for now", "this sign-in can't be brought back for now"),
  making: MAKING_WORDS.replace("nobody can be added to it", "this sign-in can't be brought back just now"),
  changing: CHANGING_WORDS.replace("nobody can be added to it", "this sign-in can't be brought back just now"),
  other_company: OTHER_COMPANY_WORDS.replace("and nobody was added", "and this sign-in wasn't brought back"),
  busy: BUSY_WORDS,
  qbo_pending: QBO_PENDING_WORDS,
  being_changed: BEING_CHANGED_WORDS,
} as const;

// Said after an add or a reinstate in a family whose sign-ins a take from the books held (stage 4's slice M4b): the
// guardian's row is open, and the gate still keeps them out until the hold is ended on the family's page.
const HELD_STILL = "This family's sign-ins are held all the same, so they can't sign in to it until someone who may change families lets its guardians in, under Sign-ins held on this page.";

export const reinstateGuardianAction = staffAction(R, async (ctx, guardianId: string): Promise<Done> => {
  if (!personId(guardianId)) return NOT_FROM_PAGE;
  const r = await reinstateGuardian(guardianId, op(ctx, R));
  if (!r.ok) {
    if (r.reason === "not_found") return NOT_FROM_PAGE;
    if (r.reason === "already_open") return { ok: true, message: "This guardian's sign-in for this family is open already." }; // nothing changed
    return { ok: false, errors: [REINSTATE_REFUSED[r.reason]] };
  }
  refresh();
  const held = (await signinHeldOfGuardian(guardianId)) ? ` ${HELD_STILL}` : "";
  return { ok: true, message: withQuickBooks(`Reinstated. Their sign-in for this family is back.${held}`, r.quickbooks) };
});

/**
 * "Let its guardians sign in", on a family's page (stage 4's slice M4b): a family whose sign-ins a take from the books
 * held (made active again, or opened by a student's take, on Accounting links) lets its guardians sign in again. Under
 * the permission that gives and ends sign-ins, as reinstating does (the lead's decision 2 on the owner's choice 5): the
 * linking permission alone brings a record back and lets nobody in. `familyId`, bound by the page, is the app's family
 * record's id, checked here and found again (familyRecordAt()); the library clears the hold only while it is set.
 */
export const releaseSigninHoldAction = staffAction(R, async (ctx, familyId: string): Promise<Done> => {
  if (!personId(familyId)) return NOT_FROM_PAGE;
  const found = await familyRecordAt(familyId);
  if (!found) return NOT_FROM_PAGE;
  const r = await releaseSigninHold(found, op(ctx, R));
  if (!r.ok) {
    if (r.reason === "busy") return { ok: false, errors: [BUSY_WORDS] };
    if (r.reason === "not_held") return { ok: false, errors: ["This family's guardians aren't held back from signing in, so nothing was changed. Reload the page."] };
    return NOT_FROM_PAGE;
  }
  refresh();
  // By the people who can sign in now: an open row that counts, of a person who isn't blocked (`signingIn`).
  return { ok: true, message: r.signingIn === 0
    ? `Done. Nobody can sign in to ${r.name} yet all the same: it has no open guardian who isn't blocked, or none the portal lets in now (the family may be inactive, or have no active student while the club asks for one).`
    : `Done. ${r.signingIn === 1 ? "Its 1 open guardian" : `Its ${r.signingIn} open guardians`} can sign in to ${r.name} now, while parent sign-ins are on.` };
});

/**
 * A person's phone and mailing address, changed by staff on the person's page (stage 3's slice 11c), in books where they
 * are each person's own (whoseDetails()): `parentId`, bound by the page, a uuid of a person the portal holds; `sent`,
 * the seven fields and the version the form was shown (`p:<n>`), read whole by parseContactForm(). The one save
 * (saveDetails()), its items held for the at-once try (QueueAs), then, after its commit, that try (sendContactSaved()).
 * `current`: the details as they stand, shown in place of what was typed. `compare`: the kept items whose compare view
 * the reader may open (Reconciliation's own guard, Roster.Read, beside this page's Parents.ReadWrite).
 */
type DetailsDone = { ok: true; message: string; status?: "waiting" | "attention"; current: ContactForm; compare: string[] } | { ok: false; errors: string[]; current?: ContactForm };
export const savePersonDetailsAction = staffAction(P, async (ctx, parentId: string, sent: unknown): Promise<DetailsDone> => {
  if (!personId(parentId)) return NOT_FROM_PAGE;
  const parsed = parseContactForm(sent);
  if (!parsed.ok) return NOT_FROM_PAGE;
  const person = await getPerson(parentId);
  if (!person) return NOT_FROM_PAGE;
  // Whose details these are, read before the save as a parent's save reads it: a form drawn for the person's details that
  // comes back after a shape save made them each family's is answered as changed, and nothing is saved on either row.
  if (whoseDetails(await getShape()) !== "person") return { ok: false, errors: [STAFF_DETAILS_COPY.whoseChanged] };
  const of = { kind: "person" as const, parentId: person.parentId };
  const r = await saveDetails(of, parsed.form, { ...op(ctx), queueAs: { askedBy: ctx.staffUserId, nextTryAt: new Date(Date.now() + SAVED_LEASE_MS) } });
  if (r.is === "none") return NOT_FROM_PAGE;
  if (r.is === "invalid") return { ok: false, errors: r.errors };
  if (r.is === "stale") return r.current ? { ok: false, errors: [STAFF_DETAILS_COPY.changed], current: r.current } : NOT_FROM_PAGE;
  if (r.is === "unchanged") return { ok: true, message: STAFF_DETAILS_COPY.unchanged, current: r.current, compare: [] };
  refresh();
  const said = contactSavedWords(await sendContactSaved(of, r.queueIds, { ...op(ctx), staffUserId: ctx.staffUserId }), "person",
    { mayCompare: can(ctx.effective, "Roster.Read"), whoCompares: "someone who may see the Reconciliation page can compare the two there." });
  return { ok: true, message: [STAFF_DETAILS_COPY.savedPerson, ...said.sentences].join(" "), ...(said.status ? { status: said.status } : {}), current: r.current, compare: said.compare };
});

export const renamePersonAction = staffAction(P, async (ctx, parentId: string, name: string): Promise<Done> => {
  if (!personId(parentId) || !str(name, NAME_FIELD_MAX)) return NOT_FROM_PAGE;
  const r = await renamePerson(parentId, name, op(ctx));
  if (!r.ok) {
    if (r.reason === "busy") return { ok: false, errors: [BUSY_WORDS] };
    if (r.reason === "qbo_pending") return { ok: false, errors: ["A change to one of this person's Parent customers in QuickBooks is waiting or stuck on the Reconciliation page, so their name wasn't changed. Once it has gone through, or been given up there, try again."] };
    if (r.reason === "being_changed") return { ok: false, errors: ["This person is being changed at this moment (by someone else here, or a change to one of their Parent customers on its way to QuickBooks), so their name wasn't changed. Try again in a minute."] };
    if (r.reason === "raced") return { ok: false, errors: ["This person's memberships changed at that same moment, so their name wasn't changed. Reload the page and try again."] };
    return r.reason === "invalid" ? { ok: false, errors: ["Give their name, up to 100 characters."] } : { ok: false, errors: ["That person isn't in the portal any more."] };
  }
  if (!r.changed) return { ok: true, message: "That is their name already." };
  refresh();
  return { ok: true, message: withQuickBooks("Saved. Their name is changed in the portal.", r.quickbooks) };
});
