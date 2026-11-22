"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { getConnection } from "@/lib/quickbooks/connection";
import { runSandboxCheck } from "@/lib/quickbooks/sandbox-check/run";
import { checkReadiness, NOT_READY_WORDS } from "@/lib/quickbooks/sandbox-check/view";

const P = "Settings.QuickBooks.ReadWrite" as const;
/** `attention`: the check finished, or stopped, with something to look at: said as needing attention, never as done. */
type Result = { ok: true; message: string; attention?: true } | { ok: false; errors: string[] };

/**
 * Runs the whole check of the portal's QuickBooks requests (src/lib/quickbooks/sandbox-check/run.ts). Admin only. It
 * takes nothing from the browser. The writes are asked for only when the connection is an Intuit sandbox now; for the
 * club's real books it reads, and changes nothing. The module that sends the writes checks that again before each one.
 */
export const runCheckAction = staffAction(P, async (ctx): Promise<Result> => {
  const ready = await checkReadiness();
  if (!ready.ok) return { ok: false, errors: [NOT_READY_WORDS[ready.reason]] };
  const writes = (await getConnection())?.environment === "sandbox";
  const r = await runSandboxCheck({ staffUserId: ctx.staffUserId, label: ctx.email, ip: ctx.ip, writes });
  revalidatePath("/staff/settings/quickbooks", "layout");
  revalidatePath("/staff/settings/health");
  if (!r.ok) return { ok: false, errors: [r.reason === "running" ? "A check is running already. Wait for it to finish, then reload the page." : NOT_READY_WORDS.not_connected] };
  return {
    ok: true,
    ...(r.outcome === "passed" ? {} : { attention: true as const }),
    message: r.outcome === "passed" ? "The check is done: every request answered as the portal expects. The results are below."
      : r.outcome === "not_as_expected" ? "The check is done, and some requests didn't answer as the portal expects. The results are below."
        : r.outcome === "incomplete" ? "The check is done, but some changes weren't tried. The results below say which and why; run it again once that is put right."
          : "The check stopped before it finished. The results below say where and why.",
  };
});
