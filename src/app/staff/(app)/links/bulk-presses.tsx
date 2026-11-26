"use client";
import { BulkAction, type BulkAnswer } from "@/app/components/ui/bulk-action";
import { PRESS_MAX } from "@/lib/bulk";

// The accounting links screen's bulk presses (src/lib/bulk.ts), each in its list's BulkSelect bar: Link to their
// suggested families, on the Families list's Suggested rows, and Create families, on the customers with no family. Each
// is given only what its Drawer shows (names, the page's own words) and what its press sends back (the ids, and for a
// link the customer and the stamp the row's Confirm is bound to), and the server action, bound on the server.

/** A Suggested row a press can take: the family's app id and name, its suggested customer's name and id, and the row's own stamp. */
export type SuggestedPick = { familyId: string; family: string; customer: string; customerId: string; stamp: string };

export function LinkSuggestedBulk({ rows, act }: { rows: SuggestedPick[]; act: (asks: { familyId: string; customerId: string; stamp: string }[]) => Promise<BulkAnswer> }) {
  const byId = new Map(rows.map((r) => [r.familyId, r]));
  const shown = new Map(rows.map((r) => [r.familyId, { name: r.family, line: `“${r.customer}” to ${r.family}` }]));
  return (
    <BulkAction rows={shown} cap={PRESS_MAX}
      label={(n) => (n === 1 ? "Link 1 to its suggested family" : `Link ${n} to their suggested families`)}
      confirmLabel={(n) => `Link ${n} ${n === 1 ? "customer" : "customers"}`} busyLabel="Linking…" done="Linked"
      description="Each family's guardians then see its customer's open invoices and Pay links. Nothing is sent to QuickBooks."
      act={(ids: string[]) => act(ids.map((id) => byId.get(id)!).map((r) => ({ familyId: r.familyId, customerId: r.customerId, stamp: r.stamp })))} />
  );
}

/** A customer with no family a press can take: its id, its name, and what "Create a family from this" makes of it, in the row's words. */
export type NoFamilyPick = { id: string; name: string; makes: string };

export function CreateFamiliesBulk({ rows, act }: { rows: NoFamilyPick[]; act: (ids: string[]) => Promise<BulkAnswer> }) {
  const shown = new Map(rows.map((r) => [r.id, { name: r.name, line: `${r.name}: ${r.makes}` }]));
  return (
    <BulkAction rows={shown} cap={PRESS_MAX}
      label={(n) => (n === 1 ? "Create 1 family" : `Create ${n} families`)}
      confirmLabel={(n) => (n === 1 ? "Create 1 family" : `Create ${n} families`)} busyLabel="Making the families…" done="Made a family, linked"
      description="Each customer becomes a family here, linked, with its students. Nobody can sign in for one until its guardians are added."
      act={act} />
  );
}
