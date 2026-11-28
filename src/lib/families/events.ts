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
import type { DetailsOf, QueueAs } from "@/lib/parents/contact-queue";
// The handler is the slot `records.events` of the accounting plugin that is on (its manifest), read at each event.
import { accountingOn } from "@/plugins";

/** A person's or a family's phone and mailing address saved: `change` the fields that changed, `was` them before, `now` all of them as saved. */
export type ContactSaved = { record: "contact"; of: DetailsOf; change: ContactDetails; was: ContactDetails; now: Required<ContactDetails> };
/** A parent's sign-in email changed, `from` the address before and `to` after. */
export type EmailSaved = { record: "email"; parentId: string; from: string; to: string };
export type DetailsEvent = ContactSaved | EmailSaved;

/** Who saved a person's or a family's details, and how a staff member's save holds its items for the try it makes after the commit (QueueAs). */
export type ContactEventOp = { actor: Actor; ip: string | null; permission?: string; queueAs?: QueueAs };
/** Who confirmed a change of sign-in email: the parent, with no permission and nothing held for a try. */
export type EmailEventOp = { actor: Actor; ip: string | null };
/** The options each event takes, and no others. */
export type DetailsEventOp<E extends DetailsEvent> = E extends ContactSaved ? ContactEventOp : EmailEventOp;

/** What an accounting plugin does with each event: queue its writes in `tx`, answering the new items' ids. */
export type DetailsEvents = { [E in DetailsEvent as E["record"]]: (tx: Tx, event: E, o: DetailsEventOp<E>) => Promise<string[]> };

/** With no books, nothing is sent on: no handler queues anything. */
const NO_BOOKS: DetailsEvents = { contact: async () => [], email: async () => [] };

/** The handler of the accounting system that is on, read in the save's transaction at each event. */
const books = async (tx: Tx): Promise<DetailsEvents> => (await accountingOn(tx))?.slots["records.events"] ?? NO_BOOKS;

/** A person's or a family's details saved, inside the save's own transaction: the ids of what was queued to be sent on. */
export async function detailsSaved<E extends DetailsEvent>(tx: Tx, event: E, o: DetailsEventOp<E>): Promise<string[]> {
  const e: DetailsEvent = event;
  const handler = await books(tx);
  return e.record === "contact" ? handler.contact(tx, e, o as ContactEventOp) : handler.email(tx, e, o as EmailEventOp);
}
