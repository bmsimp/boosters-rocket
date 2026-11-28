// Parent-facing (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts): the core's events for a saved
// person's or family's details, the first half of the slot `records.events` (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md,
// section 3, "Events"; slice P6). When the core saves a guardian's phone and mailing address (src/lib/parents/contact-edits.ts)
// or a parent's confirmed sign-in email (src/lib/parents/email-change.ts), it calls detailsSaved() inside its own
// transaction, with whose details they are and what changed. The accounting plugin's handler queues what it sends on,
// in that same transaction, and answers the new items' ids for the save's audit row; the core never waits on the books.
// The other half, a guardian's own record, is ./guardian-events.ts, staff code. It imports nothing staff-only.
import "server-only";
import type { Tx } from "@/lib/db/client";
import type { Actor } from "@/lib/audit/log";
import type { ContactDetails } from "@/lib/db/schema";
// QuickBooks' handler, the one accounting system there is. Slice P7 moves it into the plugin, which fills the slot from
// its manifest, and this reads it there (accountingOn()): until then it is this one crossing.
import { QUICKBOOKS_DETAILS_EVENTS, type DetailsOf, type QueueAs } from "@/lib/parents/contact-queue";

/** A person's or a family's phone and mailing address saved: `change` the fields that changed, `was` them before, `now` all of them as saved. */
export type ContactSaved = { record: "contact"; of: DetailsOf; change: ContactDetails; was: ContactDetails; now: Required<ContactDetails> };
/** A parent's sign-in email changed, `from` the address before and `to` after. */
export type EmailSaved = { record: "email"; parentId: string; from: string; to: string };
export type DetailsEvent = ContactSaved | EmailSaved;

/** Who saved, and how a staff member's save holds its items for the try it makes after the commit (QueueAs). */
export type DetailsEventOp = { actor: Actor; ip: string | null; permission?: string; queueAs?: QueueAs };

/** What an accounting plugin does with each event: queue its writes in `tx`, answering the new items' ids. */
export type DetailsEvents = { [E in DetailsEvent as E["record"]]: (tx: Tx, event: E, o: DetailsEventOp) => Promise<string[]> };

/** The handler of the accounting system that is on. */
const books: DetailsEvents = QUICKBOOKS_DETAILS_EVENTS;

/** A person's or a family's details saved, inside the save's own transaction: the ids of what was queued to be sent on. */
export async function detailsSaved(tx: Tx, event: DetailsEvent, o: DetailsEventOp): Promise<string[]> {
  return event.record === "contact" ? books.contact(tx, event, o) : books.email(tx, event, o);
}
