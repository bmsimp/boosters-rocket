"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { blockPerson, renamePerson, unblockPerson } from "@/lib/parents/people";
import { addGuardian, reinstateGuardian, removeGuardian } from "@/lib/parents/guardians";
import { familyRecordAt } from "@/lib/families/address";
import { resendWelcome } from "@/lib/parents/welcome";

const P = "Parents.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
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
const NO_LINK_WORDS = "This family has no customer in QuickBooks linked to it, so a guardian can't be added to it yet.";
const ADD_REFUSED = {
  invalid_name: "Give the guardian's name, up to 100 characters.",
  invalid_email: "That isn't an email address the portal can send a sign-in code to. Check it and try again.",
  no_family: NOT_FROM_PAGE.errors[0]!,
  inactive: "This family is inactive in the portal, so nobody can be added to it.",
  no_link: NO_LINK_WORDS,
  blocked: "The person with this address is blocked. Unblock them on their page first.",
  already: "The person with this address is already one of this family's guardians.",
} as const;

export const addGuardianAction = staffAction(P, async (ctx, familyId: string, name: string, email: string): Promise<Done> => {
  if (!personId(familyId) || !str(name, NAME_FIELD_MAX) || !str(email, EMAIL_FIELD_MAX)) return NOT_FROM_PAGE;
  const family = await familyRecordAt(familyId);
  if (!family) return NOT_FROM_PAGE;
  const r = await addGuardian(family, { name, email }, op(ctx));
  if (!r.ok) return { ok: false, errors: [ADD_REFUSED[r.reason]] };
  refresh();
  const who = r.person === "existing" ? `${r.name}, who already had a sign-in with this address (their name is unchanged),` : r.name;
  return { ok: true, message: r.outcome === "reinstated"
    ? `${who} was a guardian of this family before: their sign-in for it is back. They sign in with this address and a code while parent sign-ins are on.`
    : `Added ${who}. They sign in with this address and a code while parent sign-ins are on, and are sent a welcome email if they have never had one and welcome emails are on.` };
});

export const removeGuardianAction = staffAction(P, async (ctx, guardianId: string, note: string): Promise<Done> => {
  if (!personId(guardianId) || !str(note, NOTE_MAX)) return NOT_FROM_PAGE;
  const r = await removeGuardian(guardianId, note, op(ctx));
  if (!r.ok) {
    if (r.reason === "invalid_note") return { ok: false, errors: ["Say why, in a few words. Only staff see it."] };
    if (r.reason === "not_open") return { ok: true, message: "This guardian can't sign in to this family already." }; // nothing changed
    return NOT_FROM_PAGE;
  }
  refresh();
  return { ok: true, message: "Removed. They can't sign in to this family any more, and are signed out of it." };
});

const REINSTATE_REFUSED = {
  previous_company: "This sign-in was from a different QuickBooks company, so it can't be brought back.",
  blocked: "This person is blocked. Unblock them on their page first.",
  no_family: "This sign-in isn't in a family the portal holds, so it can't be brought back.",
  inactive: "This family is inactive in the portal, so nobody can sign in to it.",
  no_link: NO_LINK_WORDS.replace("a guardian can't be added to it yet", "this sign-in can't be brought back yet"),
} as const;

export const reinstateGuardianAction = staffAction(P, async (ctx, guardianId: string): Promise<Done> => {
  if (!personId(guardianId)) return NOT_FROM_PAGE;
  const r = await reinstateGuardian(guardianId, op(ctx));
  if (!r.ok) {
    if (r.reason === "not_found") return NOT_FROM_PAGE;
    if (r.reason === "already_open") return { ok: true, message: "This guardian's sign-in for this family is open already." }; // nothing changed
    return { ok: false, errors: [REINSTATE_REFUSED[r.reason]] };
  }
  refresh();
  return { ok: true, message: "Reinstated. Their sign-in for this family is back." };
});

export const renamePersonAction = staffAction(P, async (ctx, parentId: string, name: string): Promise<Done> => {
  if (!personId(parentId) || !str(name, NAME_FIELD_MAX)) return NOT_FROM_PAGE;
  const r = await renamePerson(parentId, name, op(ctx));
  if (!r.ok) return r.reason === "invalid" ? { ok: false, errors: ["Give their name, up to 100 characters."] } : { ok: false, errors: ["That person isn't in the portal any more."] };
  if (!r.changed) return { ok: true, message: "That is their name already." };
  refresh();
  return { ok: true, message: "Saved. Their name is changed in the portal." };
});
