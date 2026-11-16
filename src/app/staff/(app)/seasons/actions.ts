"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import type { Permission } from "@/lib/permissions/registry";
import { isUuid } from "@/lib/seasons/ids";
import {
  addRequirement, addStep, createSeason, moveStep, removeRequirement, removeStep, renameSeason, setCoverage, setCurrentSeason, updateRequirement, updateStep,
  type RequirementInput,
} from "@/lib/seasons/setup";
import { BULK_MAX, removeWaiver, setTicks, waiveRequirement } from "@/lib/seasons/staff-progress";

// Setting a season up, and recording who has done what, are two permissions: a volunteer who ticks names off at a
// uniform fitting doesn't need to be able to change what the club asks of everyone.
const SETUP = "Season.Steps.ReadWrite" as const, PROGRESS = "Season.Progress.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const op = (ctx: StaffCtx, permission: Permission) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission });
// Parents see the current season on Home and on the Season page, so every page is shown again, not only the staff ones.
const refresh = () => revalidatePath("/", "layout");

// A server action can be called with any values, not only the ones its page sends: each argument is checked here,
// before the library sees it. A value no page sends gets one plain refusal.
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const TEXT_MAX = 2000, ID_MAX = 64, DATE_MAX = 10;
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
// The portal's own ids are UUIDs; anything else would reach Postgres as a bad cast and throw.
const uuid = isUuid;
// A QuickBooks id from the roster: short text, never trusted to name anyone until the library finds it on the roster.
const qboId = (v: unknown): v is string => str(v, ID_MAX) && v.length > 0;
const qboIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= BULK_MAX && v.every(qboId);
const date = (v: unknown): v is string | null => v === null || str(v, DATE_MAX);

type RequirementFields = { title: string; required: boolean; amount: number | null; amountUnit: "shifts" | "hours" | null; dueOn: string | null };
const requirementFields = (v: unknown): v is RequirementFields => {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return str(f.title, TEXT_MAX) && typeof f.required === "boolean" && (f.amount === null || typeof f.amount === "number")
    && (f.amountUnit === null || f.amountUnit === "shifts" || f.amountUnit === "hours") && date(f.dueOn);
};
// Only the fields named here go on: an object from the browser can carry anything else.
const fieldsOf = (f: RequirementFields): RequirementInput => ({ title: f.title, required: f.required, amount: f.amount, amountUnit: f.amountUnit, dueOn: f.dueOn });

/* ---- Seasons ---- */

export const createSeasonAction = staffAction(SETUP, async (ctx, name: string, start: "empty" | "template" | "last"): Promise<Done> => {
  if (!str(name, TEXT_MAX) || (start !== "empty" && start !== "template" && start !== "last")) return NOT_FROM_PAGE;
  const r = await createSeason(name, start, op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: start === "last" ? "Copied. Dates were left out, and chosen lists were copied as they were: check both before parents see it."
    : "Started. Parents don't see it until you make it the current season." };
});

export const renameSeasonAction = staffAction(SETUP, async (ctx, seasonId: string, name: string): Promise<Done> => {
  if (!uuid(seasonId) || !str(name, TEXT_MAX)) return NOT_FROM_PAGE;
  const r = await renameSeason(seasonId, name, op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Renamed." };
});

export const setCurrentSeasonAction = staffAction(SETUP, async (ctx, seasonId: string): Promise<Done> => {
  if (!uuid(seasonId)) return NOT_FROM_PAGE;
  const r = await setCurrentSeason(seasonId, op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "This is the current season now. Parents see it on Home." };
});

export const clearCurrentSeasonAction = staffAction(SETUP, async (ctx): Promise<Done> => {
  const r = await setCurrentSeason(null, op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "No season is current now. Parents see no season on Home." };
});

/* ---- Steps ---- */

export const addStepAction = staffAction(SETUP, async (ctx, seasonId: string, name: string): Promise<Done> => {
  if (!uuid(seasonId) || !str(name, TEXT_MAX)) return NOT_FROM_PAGE;
  const r = await addStep(seasonId, name, op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Added at the end." };
});

export const updateStepAction = staffAction(SETUP, async (ctx, stepId: string, name: string, startsOn: string | null, endsOn: string | null): Promise<Done> => {
  if (!uuid(stepId) || !str(name, TEXT_MAX) || !date(startsOn) || !date(endsOn)) return NOT_FROM_PAGE;
  const r = await updateStep(stepId, { name, startsOn, endsOn }, op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Saved." };
});

export const moveStepAction = staffAction(SETUP, async (ctx, stepId: string, direction: "earlier" | "later"): Promise<Done> => {
  if (!uuid(stepId) || (direction !== "earlier" && direction !== "later")) return NOT_FROM_PAGE;
  const r = await moveStep(stepId, direction, op(ctx, SETUP));
  if (!r.ok) return r;
  if (!r.moved) return { ok: true, message: direction === "earlier" ? "It is the first step already." : "It is the last step already." };
  refresh();
  return { ok: true, message: "Moved." };
});

export const removeStepAction = staffAction(SETUP, async (ctx, stepId: string): Promise<Done> => {
  if (!uuid(stepId)) return NOT_FROM_PAGE;
  const r = await removeStep(stepId, op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Removed." };
});

/* ---- Requirements ---- */

export const addRequirementAction = staffAction(SETUP, async (ctx, stepId: string, kind: string, appliesTo: "family" | "student", fields: RequirementFields): Promise<Done> => {
  if (!uuid(stepId) || !str(kind, ID_MAX) || (appliesTo !== "family" && appliesTo !== "student") || !requirementFields(fields)) return NOT_FROM_PAGE;
  if (kind !== "checklist" && kind !== "form" && kind !== "payment" && kind !== "volunteer") return NOT_FROM_PAGE;
  const r = await addRequirement(stepId, { kind, appliesTo, ...fieldsOf(fields) }, op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  if (kind === "form") return { ok: true, message: "Added. Open it to attach its template: until then parents read that it isn't ready." };
  return { ok: true, message: "Added. It is asked of everyone until you choose a list." };
});

export const updateRequirementAction = staffAction(SETUP, async (ctx, requirementId: string, fields: RequirementFields): Promise<Done> => {
  if (!uuid(requirementId) || !requirementFields(fields)) return NOT_FROM_PAGE;
  const r = await updateRequirement(requirementId, fieldsOf(fields), op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Saved." };
});

export const setCoverageAction = staffAction(SETUP, async (ctx, requirementId: string, covers: "everyone" | "chosen", subjectQboIds: string[]): Promise<Done> => {
  if (!uuid(requirementId) || (covers !== "everyone" && covers !== "chosen") || !qboIds(subjectQboIds)) return NOT_FROM_PAGE;
  const r = await setCoverage(requirementId, covers, covers === "chosen" ? [...subjectQboIds] : [], op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: covers === "everyone" ? "Saved. It is asked of everyone." : "Saved. It is asked only of those you chose." };
});

export const removeRequirementAction = staffAction(SETUP, async (ctx, requirementId: string): Promise<Done> => {
  if (!uuid(requirementId)) return NOT_FROM_PAGE;
  const r = await removeRequirement(requirementId, op(ctx, SETUP));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Removed." };
});

/* ---- Ticks and waivers ---- */

export const setTicksAction = staffAction(PROGRESS, async (ctx, requirementId: string, subjectQboIds: string[], ticked: boolean): Promise<Done> => {
  if (!uuid(requirementId) || !qboIds(subjectQboIds) || typeof ticked !== "boolean") return NOT_FROM_PAGE;
  const r = await setTicks(requirementId, [...subjectQboIds], ticked, op(ctx, PROGRESS));
  if (!r.ok) return r;
  if (r.changed === 0) return { ok: true, message: ticked ? "Already ticked." : "Nothing was ticked." }; // nothing changed: nothing to show again
  refresh();
  return { ok: true, message: ticked ? (r.changed === 1 ? "Ticked." : `Ticked ${r.changed}.`) : (r.changed === 1 ? "Unticked." : `Unticked ${r.changed}.`) };
});

export const waiveAction = staffAction(PROGRESS, async (ctx, requirementId: string, subjectQboId: string, reason: string): Promise<Done> => {
  if (!uuid(requirementId) || !qboId(subjectQboId) || !str(reason, TEXT_MAX)) return NOT_FROM_PAGE;
  const r = await waiveRequirement(requirementId, subjectQboId, reason, op(ctx, PROGRESS));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Waived." };
});

export const removeWaiverAction = staffAction(PROGRESS, async (ctx, requirementId: string, subjectQboId: string): Promise<Done> => {
  if (!uuid(requirementId) || !qboId(subjectQboId)) return NOT_FROM_PAGE;
  const r = await removeWaiver(requirementId, subjectQboId, op(ctx, PROGRESS));
  if (!r.ok) return r;
  if (!r.changed) return { ok: true, message: "There was no waiver to remove." };
  refresh();
  return { ok: true, message: "The waiver is removed." };
});
