"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { blockPerson, renamePerson, unblockPerson } from "@/lib/parents/people";
import { addGuardian, reinstateGuardian, removeGuardian } from "@/lib/parents/guardians";
import { familyRecordAt } from "@/lib/families/address";
import { resendWelcome } from "@/lib/parents/welcome";

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
  return { ok: true, message: "Blocked. They are signed out and can't get a code." };
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
  no_access: "This person can't sign in to any family right now, so no email was sent.", mail_failed: "The email couldn't be sent. Check outgoing mail under Mail.",
} as const;
export const resendWelcomeAction = staffAction(P, async (ctx, parentId: string): Promise<Done> => {
  if (!personId(parentId)) return NOT_FROM_PAGE;
  const r = await resendWelcome(parentId, op(ctx));
  if (!r.ok) return { ok: false, errors: [RESEND_FAILED[r.reason]] };
  refresh();
  return { ok: true, message: "Sent." };
});

// A family's guardians (stage 3's slice 7b), from a family's roster page or a person's page. Each id is the app's own
// (a family record's, a guardian row's, a person's): one that isn't a uuid, or isn't there, gets the plain refusal.
const NAME_FIELD_MAX = 200, EMAIL_FIELD_MAX = 320, NOTE_MAX = 2000;
// A roster read holds the roster lock for its whole QuickBooks read: a write that can't have it within a few seconds
// changes nothing and says so.
const BUSY_WORDS = "The roster is being read from QuickBooks just now, so nothing was changed. Try again in a minute.";
const WAITING_WORDS = "Making this family in QuickBooks is still waiting on the queue, so nobody can be added to it for now. Once it has gone through, or been given up on the Reconciliation page, try again.";
const MAKING_WORDS = "This family is being made in QuickBooks at this moment, so nobody can be added to it. Try again in a minute.";
// A change to the guardian's own Parent customer in QuickBooks waiting, stuck or being sent (stage 3's slice 9h).
const QBO_PENDING_WORDS = "A change to this guardian's Parent customer in QuickBooks is waiting, stuck or being sent just now, so nothing was changed. Once it has gone through, or been given up on the Reconciliation page, try again.";
/** What became of the Parent customer in QuickBooks, after the portal's own sentence (stage 3's slice 9h). */
const withQuickBooks = (said: string, quickbooks: string[]) => [said, ...quickbooks].join(" ");
const OTHER_COMPANY_WORDS = "QuickBooks is connected to a different company from the one this roster was read from, so the portal can't tell which customer this family is linked to, and nobody was added. An Admin can sort that out under QuickBooks.";
const ADD_REFUSED = {
  invalid_name: "Give the guardian's name, up to 100 characters.",
  invalid_email: "That isn't an email address the portal can send a sign-in code to. Check it and try again.",
  no_family: NOT_FROM_PAGE.errors[0]!,
  inactive: "This family is inactive in the portal, so nobody can be added to it.",
  waiting: WAITING_WORDS,
  making: MAKING_WORDS,
  other_company: OTHER_COMPANY_WORDS,
  blocked: "The person with this address is blocked. Unblock them on their page first.",
  already: "The person with this address is already one of this family's guardians.",
  busy: BUSY_WORDS,
  qbo_pending: QBO_PENDING_WORDS,
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
  return { ok: true, message: withQuickBooks(r.outcome === "reinstated"
    ? `${r.name}${known}${known ? "," : ""} was a guardian of this family before: their sign-in for it is back. They sign in with this address and a code while parent sign-ins are on.`
    : `Added ${r.name}${known}. They sign in with this address and a code while parent sign-ins are on, and are sent a welcome email if they have never had one and welcome emails are on.`, r.quickbooks) };
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
  other_company: OTHER_COMPANY_WORDS.replace("and nobody was added", "and this sign-in wasn't brought back"),
  other_customer: "This sign-in was made for a different customer in QuickBooks than this family's own, so it can't be brought back here.",
  busy: BUSY_WORDS,
  qbo_pending: QBO_PENDING_WORDS,
} as const;

export const reinstateGuardianAction = staffAction(R, async (ctx, guardianId: string): Promise<Done> => {
  if (!personId(guardianId)) return NOT_FROM_PAGE;
  const r = await reinstateGuardian(guardianId, op(ctx, R));
  if (!r.ok) {
    if (r.reason === "not_found") return NOT_FROM_PAGE;
    if (r.reason === "already_open") return { ok: true, message: "This guardian's sign-in for this family is open already." }; // nothing changed
    return { ok: false, errors: [REINSTATE_REFUSED[r.reason]] };
  }
  refresh();
  return { ok: true, message: withQuickBooks("Reinstated. Their sign-in for this family is back.", r.quickbooks) };
});

export const renamePersonAction = staffAction(P, async (ctx, parentId: string, name: string): Promise<Done> => {
  if (!personId(parentId) || !str(name, NAME_FIELD_MAX)) return NOT_FROM_PAGE;
  const r = await renamePerson(parentId, name, op(ctx));
  if (!r.ok) {
    if (r.reason === "busy") return { ok: false, errors: [BUSY_WORDS] };
    if (r.reason === "qbo_pending") return { ok: false, errors: ["A change to one of this person's Parent customers in QuickBooks is waiting, stuck or being sent just now, so their name wasn't changed. Once it has gone through, or been given up on the Reconciliation page, try again."] };
    return r.reason === "invalid" ? { ok: false, errors: ["Give their name, up to 100 characters."] } : { ok: false, errors: ["That person isn't in the portal any more."] };
  }
  if (!r.changed) return { ok: true, message: "That is their name already." };
  refresh();
  return { ok: true, message: withQuickBooks("Saved. Their name is changed in the portal.", r.quickbooks) };
});
