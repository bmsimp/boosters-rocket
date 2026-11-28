// Staff-only: the core's events for a saved guardian, the second half of the slot `records.events`
// (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md, section 3, "Events"; slice P6; the first half, a
// person's or a family's details, is ./events.ts). When staff open a guardian row (an add or a reinstate), close one
// (a removal) or rename the person who holds open rows (src/lib/parents/guardians.ts, people.ts), the save calls
// guardianSaved() inside its own transaction, with the app's ids and what changed. The accounting plugin's handler
// decides and queues the writes to the books in that same transaction and answers them, for the save's audit row and
// the try it makes after the commit; the core never waits on the books.
import "server-only";
import type { Tx } from "@/lib/db/client";
import type { AppFamilyId } from "./ids";
// QuickBooks' handler, the one accounting system there is. Slice P7 moves it into the plugin, which fills the slot from
// its manifest, and this reads it there (accountingOn()): until then it is this one crossing.
import { QUICKBOOKS_GUARDIAN_EVENTS, type GuardianOp, type GuardianQueued } from "@/lib/roster/writes";

export type GuardianEvent =
  /** A row just opened (added, reused at a second press, or reinstated), for the person's name and sign-in email. */
  | { record: "guardian"; change: "opened"; guardianId: string; familyId: AppFamilyId; name: string; email: string }
  /** A row just closed. */
  | { record: "guardian"; change: "closed"; guardianId: string; familyId: AppFamilyId | null }
  /** The person who holds these open rows renamed, from `was` to `name`. */
  | { record: "guardian"; change: "renamed"; rows: { guardianId: string; familyId: AppFamilyId | null }[]; name: string; was: string; email: string };

/** What an accounting plugin does with a guardian's event: queue its writes in `tx`, answering each row's outcome. */
export type GuardianEvents = { guardian: (tx: Tx, event: GuardianEvent, o: GuardianOp) => Promise<GuardianQueued[]> };

/** The handler of the accounting system that is on. */
const books: GuardianEvents = QUICKBOOKS_GUARDIAN_EVENTS;

/** A guardian saved, inside the save's own transaction: what was queued for each row, for the try after the commit. */
export async function guardianSaved(tx: Tx, event: GuardianEvent, o: GuardianOp): Promise<GuardianQueued[]> {
  return books.guardian(tx, event, o);
}
