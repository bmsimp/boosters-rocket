"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { isUuid } from "@/lib/seasons/ids";
import { addShift, cancelEvent, cancelShift, copyEvent, createEvent, updateEvent, updateShift, type EventInput, type ShiftInput } from "@/lib/volunteer/setup";
import { CUTOFF_MAX, saveVolunteerSettings } from "@/lib/volunteer/settings";

// Every volunteer write needs the one permission; reading the events and the lists needs Volunteer.Event.Read.
const WRITE = "Volunteer.Event.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: WRITE });
// Parents see events and shifts on their Volunteer pages, and what they count toward on Home and the Season page.
const refresh = () => revalidatePath("/", "layout");

// A server action can be called with any values, not only the ones its page sends: each argument is checked here,
// before the library sees it. A value no page sends gets one plain refusal.
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const TEXT_MAX = 4000;
const str = (v: unknown, max = TEXT_MAX): v is string => typeof v === "string" && v.length <= max;
const eventFields = (v: unknown): v is EventInput => {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return str(f.name) && str(f.onDate, 10) && str(f.location) && str(f.description) && str(f.contactName) && str(f.contactEmail);
};
const shiftFields = (v: unknown): v is ShiftInput => {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return str(f.startsAt, 5) && str(f.endsAt, 5) && typeof f.places === "number" && str(f.role)
    && Array.isArray(f.requirementIds) && f.requirementIds.length <= 50 && f.requirementIds.every(isUuid);
};
// Only the fields named here go on: an object from the browser can carry anything else.
const eventOf = (f: EventInput): EventInput => ({ name: f.name, onDate: f.onDate, location: f.location, description: f.description, contactName: f.contactName, contactEmail: f.contactEmail });
const shiftOf = (f: ShiftInput): ShiftInput => ({ startsAt: f.startsAt, endsAt: f.endsAt, places: f.places, role: f.role, requirementIds: [...f.requirementIds] });

/** What staff are told about the emails a change sent. */
function toldWords(r: { told: number; failed: number }): string {
  if (r.told + r.failed === 0) return "";
  const told = r.told === 0 ? "" : ` ${r.told === 1 ? "The person" : `All ${r.told} people`} signed up ${r.told === 1 ? "has" : "have"} been emailed.`;
  return r.failed === 0 ? told : ` ${r.told} emailed; ${r.failed} couldn't be emailed (see Mail under Settings).`;
}

export const createEventAction = staffAction(WRITE, async (ctx, fields: EventInput): Promise<Done & { eventId?: string }> => {
  if (!eventFields(fields)) return NOT_FROM_PAGE;
  const r = await createEvent(eventOf(fields), op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Event added. Add its shifts next.", eventId: r.eventId };
});

export const updateEventAction = staffAction(WRITE, async (ctx, eventId: string, fields: EventInput): Promise<Done> => {
  if (!isUuid(eventId) || !eventFields(fields)) return NOT_FROM_PAGE;
  const r = await updateEvent(eventId, eventOf(fields), op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: `Saved.${toldWords(r)}` };
});

export const copyEventAction = staffAction(WRITE, async (ctx, eventId: string, onDate: string): Promise<Done & { eventId?: string }> => {
  if (!isUuid(eventId) || !str(onDate, 10)) return NOT_FROM_PAGE;
  const r = await copyEvent(eventId, onDate, op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Copied, with its shifts. Nobody is signed up for the copy yet.", eventId: r.eventId };
});

export const cancelEventAction = staffAction(WRITE, async (ctx, eventId: string): Promise<Done> => {
  if (!isUuid(eventId)) return NOT_FROM_PAGE;
  const r = await cancelEvent(eventId, op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: `The event is cancelled. Parents no longer see it.${toldWords(r)}` };
});

export const addShiftAction = staffAction(WRITE, async (ctx, eventId: string, fields: ShiftInput): Promise<Done> => {
  if (!isUuid(eventId) || !shiftFields(fields)) return NOT_FROM_PAGE;
  const r = await addShift(eventId, shiftOf(fields), op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Shift added. Parents can sign up for it now." };
});

export const updateShiftAction = staffAction(WRITE, async (ctx, shiftId: string, fields: ShiftInput): Promise<Done> => {
  if (!isUuid(shiftId) || !shiftFields(fields)) return NOT_FROM_PAGE;
  const r = await updateShift(shiftId, shiftOf(fields), op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: `Saved.${toldWords(r)}` };
});

export const cancelShiftAction = staffAction(WRITE, async (ctx, shiftId: string): Promise<Done> => {
  if (!isUuid(shiftId)) return NOT_FROM_PAGE;
  const r = await cancelShift(shiftId, op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: `The shift is cancelled.${toldWords(r)}` };
});

/** The cut-off as typed in the field: a blank field is not 0 hours, and nothing but whole digits is a number of hours. */
export const saveCutoffAction = staffAction(WRITE, async (ctx, typed: string): Promise<Done> => {
  if (typeof typed !== "string" || typed.length > 20) return NOT_FROM_PAGE;
  const text = typed.trim();
  if (!/^[0-9]{1,6}$/.test(text)) return { ok: false, errors: [`Enter the cut-off as a whole number of hours, from 0 to ${CUTOFF_MAX}.`] };
  const r = await saveVolunteerSettings({ cutoffHours: Number(text) }, op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Saved." };
});
