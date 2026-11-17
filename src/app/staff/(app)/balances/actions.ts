"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { askForMoneyRun } from "@/lib/money/sweep";

const P = "Finance.Balance.Read" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };

const REFUSED: Record<string, string> = {
  running: "Every family is being read now. This page shows how far it has got.",
  asked: "A read of every family is already asked for. It starts within a minute.",
  too_soon: "Every family was read a few minutes ago. Ask again in a little while: this keeps the portal gentle with QuickBooks.",
  not_connected: "QuickBooks isn't connected, or its roster hasn't been read yet, so there is nothing to read. See QuickBooks under Settings.",
};

/**
 * Asks the worker to read every family's invoices from QuickBooks now (src/lib/money/sweep.ts). It takes no argument:
 * nothing from the browser chooses what is read. The page never waits on QuickBooks; the worker starts within a minute.
 */
export const askForMoneyRunAction = staffAction(P, async (ctx): Promise<Done> => {
  const r = await askForMoneyRun({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
  if (!r.ok) return { ok: false, errors: [REFUSED[r.reason]!] };
  revalidatePath("/staff/balances");
  return { ok: true, message: "Asked. The worker starts within a minute and reads one family at a time; this page shows how far it has got." };
});
