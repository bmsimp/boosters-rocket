// The worker's money job (./runner.ts): one wake's share of the read of every family's invoices
// (src/lib/money/sweep.ts) and, once a run has read every family, the products and services a payment requirement is
// met by, through the reader the staff button uses (readItems, src/lib/money/items.ts: strict, audited, never an
// answer with nothing in it over a list that holds items). Both read every family or the whole company, so this is
// worker and staff code only; it lives here, not in src/lib/money, whose files parent pages may import.
import { WORKER_ACTOR } from "@/lib/quickbooks/client";
import { readItems } from "@/lib/money/items";
import { PACE_MS, pacer, runMoneyJob, type MoneyJobResult } from "@/lib/money/sweep";

export type MoneyAndItems = MoneyJobResult & { items?: boolean };

/**
 * Runs the read of every family as runMoneyJob() does; when that run has just read every family, reads the products and
 * services too, at the same gentle pace. `items` says whether that read was kept: a failure is audited by readItems
 * (`money.items.read.failed`) and leaves the stored list as it was, and the run's figures stand either way.
 */
export async function runMoneyAndItems(o: Parameters<typeof runMoneyJob>[0] = {}): Promise<MoneyAndItems> {
  const r = await runMoneyJob(o);
  if (!r.ran || !r.finished || !r.ok) return r;
  let items: boolean;
  try { items = (await readItems({ actor: WORKER_ACTOR, ip: null, pace: pacer(o.paceMs ?? PACE_MS) })).ok; } catch { items = false; }
  return { ...r, items };
}
