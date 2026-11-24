"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { qboCustomerType } from "@/lib/db/schema";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { getConnection, parseQboAppForm, saveQboApp, beginConnect, beginSwitchConnect, disconnect, parseConnectMode, saveConnectMode } from "@/lib/quickbooks/connection";
import { checkRegistration, makeRelayKey, parsePortalId, savePortalId } from "@/lib/quickbooks/relay-registration";
import type { RelayCheck } from "@/lib/quickbooks/relay";
import { parseShapeForm, saveShape, type TypeRow } from "@/lib/roster/shape";
import { previewShape, type ShapePreview } from "@/lib/roster/queries";
import { refreshRoster } from "@/lib/roster/refresh";
import { SWITCH_PAGE } from "./switch-words";

const P = "Settings.QuickBooks.ReadWrite" as const;
const SETUP = "/staff/settings/quickbooks/setup";
const actor = (ctx: StaffCtx) => ({ door: "staff" as const, id: ctx.staffUserId, label: ctx.email });
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE = { ok: false as const, errors: ["That didn't go through. Reload the page and try again."] };
/** One field sent once, as a string of at most `max` characters; anything else isn't from the page. */
const only = (f: unknown, k: string, max: number): string | null => {
  if (!(f instanceof FormData)) return null;
  const all = f.getAll(k);
  return all.length === 1 && typeof all[0] === "string" && all[0].length <= max ? all[0] : null;
};
const op = (ctx: StaffCtx) => ({ actor: actor(ctx), staffUserId: ctx.staffUserId, ip: ctx.ip, permission: P });
const shapeOf = async (f: FormData) => {
  const types: TypeRow[] = (await db.select().from(qboCustomerType)).map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }));
  return parseShapeForm({ kind: text(f, "kind"), family: text(f, "family"), student: text(f, "student"), parent: text(f, "parent"), members: f.getAll("members").map(String) }, types);
};

export const saveQboAppAction = staffAction(P, async (ctx, form: FormData): Promise<{ ok: true } | { ok: false; errors: string[] }> => {
  const parsed = parseQboAppForm({ clientId: text(form, "clientId"), clientSecret: text(form, "clientSecret"), environment: text(form, "environment") }, Boolean((await getConnection())?.clientSecretCiphertext));
  if (!parsed.ok) return parsed;
  const r = await saveQboApp(parsed.draft, { actor: actor(ctx), ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r;
});

/** Step 1, "How to connect": through Boosters Rocket, or with the club's own Intuit app (saveConnectMode()). */
export const saveConnectModeAction = staffAction(P, async (ctx, form: unknown): Promise<Done> => {
  const mode = parseConnectMode(only(form, "mode", 20));
  if (!mode) return NOT_FROM_PAGE;
  const r = await saveConnectMode(mode, op(ctx));
  revalidatePath("/staff", "layout");
  return r;
});

/**
 * Registration: "Make this portal's key", or with `replace` = "yes", "Make a new key" (makeRelayKey()). The form sends
 * no other field.
 */
export const makeRelayKeyAction = staffAction(P, async (ctx, form: unknown): Promise<Done> => {
  if (!(form instanceof FormData)) return NOT_FROM_PAGE;
  const asked = form.getAll("replace");
  if (asked.length > 1 || (asked.length === 1 && asked[0] !== "yes")) return NOT_FROM_PAGE;
  const r = await makeRelayKey(op(ctx), asked.length === 1);
  revalidatePath("/staff", "layout");
  return r;
});

export type PortalIdSaved = { ok: true; message: string; check: RelayCheck | null } | { ok: false; errors: string[] };

/**
 * Registration: saves the portal id Boosters Rocket sent back, then, after the save's transaction, asks the relay
 * whether it knows the portal by it (checkRegistration()). The id stays saved whatever the check answers.
 */
export const savePortalIdAction = staffAction(P, async (ctx, form: unknown): Promise<PortalIdSaved> => {
  const raw = only(form, "portalId", 200);
  if (raw === null) return NOT_FROM_PAGE;
  const parsed = parsePortalId(raw);
  if (!parsed.ok) return parsed;
  const r = await savePortalId(parsed.portalId, op(ctx));
  if (!r.ok) return r;
  revalidatePath("/staff", "layout");
  return { ...r, check: await checkRegistration() };
});

/** "Check again": the relay's answer for the saved id and key. Writes nothing but the relay's mark, so no audit row. */
export const checkRegistrationAction = staffAction(P, async (): Promise<{ ok: true; check: RelayCheck | null }> => {
  return { ok: true, check: await checkRegistration() };
});

/** A plain form action: it always ends in a redirect, to Intuit or back to step 1. */
export const beginConnectAction = staffAction(P, async (ctx): Promise<void> => {
  const r = await beginConnect(ctx.staffUserId);
  redirect(r.ok ? r.url : `${SETUP}?step=app&error=keys`);
});

/**
 * The switch page's press (stage 4's slice M8): a plain form action that always ends in a redirect. It reads nothing
 * from the form but its one checkbox, which must say "yes"; anything else goes back to the switch page to be checked.
 * Then a connect starts with an ask recorded (beginSwitchConnect()), so the company chosen at Intuit may be another.
 */
export const switchConnectAction = staffAction(P, async (ctx, form: unknown): Promise<void> => {
  const confirmed = form instanceof FormData && form.getAll("confirm").length === 1 && form.get("confirm") === "yes";
  if (!confirmed) redirect(`${SWITCH_PAGE}?error=confirm`);
  const r = await beginSwitchConnect(ctx.staffUserId, { actor: actor(ctx), ip: ctx.ip, permission: P });
  redirect(r.ok ? r.url : `${SETUP}?step=app&error=keys`);
});

export const disconnectAction = staffAction(P, async (ctx): Promise<{ ok: true; revoked: boolean } | { ok: false; error: string }> => {
  const r = await disconnect({ actor: actor(ctx), ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  // `revoked` is whether Intuit confirmed it canceled the portal's access; the connection is deleted here either way.
  return r.ok ? { ok: true, revoked: r.revoked } : { ok: false, error: "QuickBooks isn't connected." };
});

export const previewShapeAction = staffAction(P, async (_ctx, form: FormData): Promise<{ ok: true; preview: ShapePreview } | { ok: false; errors: string[] }> => {
  const parsed = await shapeOf(form);
  return parsed.ok ? { ok: true, preview: await previewShape(parsed.shape) } : parsed;
});

export const saveShapeAction = staffAction(P, async (ctx, form: FormData): Promise<{ ok: true; refreshed: boolean } | { ok: false; errors: string[] }> => {
  const parsed = await shapeOf(form);
  if (!parsed.ok) return parsed;
  await saveShape(parsed.shape, { actor: actor(ctx), ip: ctx.ip, permission: P });
  // Contact details are kept only for customers the shape names, so the cache is read again under the new shape (spec §1).
  const r = await refreshRoster({ startedBy: ctx.staffUserId, actor: actor(ctx), ip: ctx.ip });
  revalidatePath("/staff", "layout");
  return { ok: true, refreshed: r.ok };
});
