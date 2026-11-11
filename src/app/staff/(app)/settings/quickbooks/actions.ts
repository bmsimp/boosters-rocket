"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { qboCustomerType } from "@/lib/db/schema";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { getConnection, parseQboAppForm, saveQboApp, beginConnect, disconnect } from "@/lib/quickbooks/connection";
import { parseShapeForm, saveShape, type TypeRow } from "@/lib/roster/shape";
import { previewShape, type ShapePreview } from "@/lib/roster/queries";
import { refreshRoster } from "@/lib/roster/refresh";

const P = "Settings.QuickBooks.ReadWrite" as const;
const SETUP = "/staff/settings/quickbooks/setup";
const actor = (ctx: StaffCtx) => ({ door: "staff" as const, id: ctx.staffUserId, label: ctx.email });
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const shapeOf = async (f: FormData) => {
  const types: TypeRow[] = (await db.select().from(qboCustomerType)).map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }));
  return parseShapeForm({ kind: text(f, "kind"), family: text(f, "family"), student: text(f, "student"), parent: text(f, "parent"), members: f.getAll("members").map(String) }, types);
};

export const saveQboAppAction = staffAction(P, async (ctx, form: FormData): Promise<{ ok: true } | { ok: false; errors: string[] }> => {
  const parsed = parseQboAppForm({ clientId: text(form, "clientId"), clientSecret: text(form, "clientSecret"), environment: text(form, "environment") }, (await getConnection()) !== null);
  if (!parsed.ok) return parsed;
  const r = await saveQboApp(parsed.draft, { actor: actor(ctx), ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r;
});

/** A plain form action: it always ends in a redirect, to Intuit or back to step 1. */
export const beginConnectAction = staffAction(P, async (ctx): Promise<void> => {
  const r = await beginConnect(ctx.staffUserId);
  redirect(r.ok ? r.url : `${SETUP}?step=app&error=keys`);
});

export const disconnectAction = staffAction(P, async (ctx): Promise<{ ok: true } | { ok: false; error: string }> => {
  const r = await disconnect({ actor: actor(ctx), ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r.ok ? { ok: true } : { ok: false, error: "QuickBooks isn't connected." };
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
