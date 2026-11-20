import type { RosterWrite } from "@/lib/db/schema";
import { NO_TOKEN } from "@/lib/quickbooks/client";
import { detailKey } from "@/lib/parents/contact-fields";
import { nameKey } from "./names";

/**
 * The rules of the write queue (v1 spec §4, §8.4), pure: what a failed write was, when a waiting one is tried again,
 * when it is stuck, and what a queued write that may already have been made is found to be.
 */

/**
 * What a write that didn't go through was, from its short code (src/lib/quickbooks/client.ts):
 * - `stale`: QuickBooks has a newer version of the record (5010). Shown with the record read again; never queued.
 * - `duplicate`: the name is a vendor's or an employee's, or a customer the cache doesn't have yet (6240). A free name is offered.
 * - `refused`: QuickBooks read it and said no (any other 4xx), or the portal wouldn't send it (an id that isn't one).
 * - `not_connected`, `needs_admin`, `other_company`: nothing was sent, and nothing will be until a person acts. Not queued.
 * - `retry`: it may go through later. `sent` says whether QuickBooks may have acted on it: after a timeout, a lost
 *   connection, an answer that couldn't be read or a 5xx it may have; when it was busy, throttled or its token couldn't
 *   be had, it didn't.
 */
export type Failure =
  | { kind: "stale" | "duplicate" | "refused" | "not_connected" | "needs_admin" | "other_company" }
  | { kind: "retry"; sent: boolean };

export function classify(code: string): Failure {
  if (code === "fault_5010") return { kind: "stale" };
  if (code === "fault_6240") return { kind: "duplicate" };
  if (code === "not_connected" || code === `${NO_TOKEN}not_connected`) return { kind: "not_connected" };
  if (code === "needs_admin" || code === `${NO_TOKEN}invalid_grant` || code === `${NO_TOKEN}unreadable`) return { kind: "needs_admin" };
  if (code === "other_company") return { kind: "other_company" };
  if (code.startsWith(NO_TOKEN)) return { kind: "retry", sent: false };   // the token couldn't be had: nothing was sent
  if (code === "http_429" || code === "http_401") return { kind: "retry", sent: false }; // throttled, or not let in: not acted on
  if (code === "timeout" || code === "unreachable" || code === "bad_answer" || /^http_5\d\d(_|$)/.test(code)) return { kind: "retry", sent: true };
  return { kind: "refused" };
}

/** The waits between tries, after the first, second, third and fourth; every one after that waits 6 hours. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const LATE_BACKOFF_MS = 6 * 3_600_000;
/** An item is stuck once it has been tried this often, or is this old: staff then try it again or give it up. */
export const MAX_TRIES = 8;
export const MAX_AGE_MS = 24 * 3_600_000;

/** After try number `tries` failed: tried again at this time, or stuck. */
export function afterFailedTry(tries: number, createdAt: Date, now: Date): { state: "waiting"; nextTryAt: Date } | { state: "stuck" } {
  if (tries >= MAX_TRIES || now.getTime() - createdAt.getTime() >= MAX_AGE_MS) return { state: "stuck" };
  const wait = BACKOFF_MS[tries - 1] ?? LATE_BACKOFF_MS;
  return { state: "waiting", nextTryAt: new Date(now.getTime() + wait) };
}

/**
 * A customer as the roster cache holds it, for the check before a queued write is sent again: with its phone and
 * billing address, which a parent's change of them (stage 3's slice 11b) is compared with.
 */
export type CachedCustomer = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null; syncToken: string } & Partial<DetailColumns>;
/** A customer's phone and billing address, as the roster cache's columns hold them (or the portal's own, `parent` and `family`). */
export type DetailColumns = { phone: string | null; addressLine1: string | null; addressLine2: string | null; addressCity: string | null; addressRegion: string | null;
  addressPostalCode: string | null; addressCountry: string | null };

/** A phone and an address as QuickBooks holds them (the cache's columns, or a live answer), as the form shows them: what isn't set is empty. */
export type HeldContact = { phone: string; address: { line1: string; line2: string; city: string; region: string; postalCode: string; country: string } };
/** What a row of those columns holds of a phone and an address. */
export const heldInCache = (c: Partial<DetailColumns>): HeldContact => ({ phone: c.phone ?? "", address: { line1: c.addressLine1 ?? "", line2: c.addressLine2 ?? "",
  city: c.addressCity ?? "", region: c.addressRegion ?? "", postalCode: c.addressPostalCode ?? "", country: c.addressCountry ?? "" } });

type ContactWrite = Extract<RosterWrite, { op: "contact" }>;
/**
 * How QuickBooks' details (`held`) stand against a parent's change of their phone and address (stage 3's slice 11b),
 * field by field, on the one normal form a phone or an address is compared by (detailKey(), the take-in's): `in_place`,
 * every field it sends holds its new value; `sendable`, each holds its new value, its before-value (`was`, what the
 * portal last knew QuickBooks held), or an earlier change's that may have been sent (`orWas`); `differs`, otherwise:
 * something the portal never knew of, never sent over. A field QuickBooks holds empty is the portal's to fill only where
 * the portal knew it empty (`was`, or an entry of `orWas`, empty for that field): otherwise someone may have cleared it
 * there on purpose, and it is a difference like any other value. No version says the portal knew a field: the link's
 * version moves on with any send QuickBooks takes, the other field's, a rename's or a found change's included.
 */
export function contactStands(held: HeldContact, w: Pick<ContactWrite, "change" | "was" | "orWas">): "in_place" | "sendable" | "differs" {
  const fields = (["phone", "address"] as const).filter((f) => w.change[f] !== undefined);
  if (fields.every((f) => detailKey(held[f]) === detailKey(w.change[f]))) return "in_place";
  return contactDiffers(held, w).length ? "differs" : "sendable";
}

/**
 * One field of a parent's change that QuickBooks holds otherwise than the portal knew (contactStands()'s `differs`, field
 * by field), for the words a kept change is shown in (keptContactWords()): whether the portal knew a value for it when
 * the change was saved (`was` not empty), and whether QuickBooks holds one now. Never the values themselves.
 */
export type ContactDiffer = { field: "phone" | "address"; portalKnew: boolean; quickbooksHolds: boolean };
/** The fields of a contact change `held` holds as neither its new value, nor its before-value, nor an earlier change's. */
export function contactDiffers(held: HeldContact, w: Pick<ContactWrite, "change" | "was" | "orWas">): ContactDiffer[] {
  return (["phone", "address"] as const).filter((f) => w.change[f] !== undefined).flatMap((f): ContactDiffer[] => {
    const now = detailKey(held[f]);
    if (now === detailKey(w.change[f])) return [];
    const known = [w.was[f], ...(w.orWas ?? []).map((e) => e[f])].filter((v) => v !== undefined).map((v) => detailKey(v));
    if (known.includes(now)) return [];
    return [{ field: f, portalKnew: w.was[f] !== undefined && detailKey(w.was[f]) !== null, quickbooksHolds: now !== null }];
  });
}

/**
 * What a queued write is, by a roster read since its last try. Only for one QuickBooks may already have made:
 * - a create whose customer is there (the same name, under the same family, of the same type) is `done`;
 * - an update already in place is `done`;
 * - an update whose record has moved on otherwise is `stuck`: sending it would overwrite someone's change, or meet its own;
 * - a record that is gone from the roster is `stuck`;
 * - anything else is sent again.
 */
export function beforeResend(w: RosterWrite, cache: readonly CachedCustomer[]): { is: "done"; qboId: string } | { is: "stuck"; code: string } | { is: "send" } {
  if (w.op === "create") {
    const made = cache.find((c) => nameKey(c.displayName) === nameKey(w.name) && c.parentQboId === w.familyQboId && c.typeQboId === w.typeQboId);
    return made ? { is: "done", qboId: made.qboId } : { is: "send" };
  }
  const now = cache.find((c) => c.qboId === w.qboId);
  if (!now) return { is: "stuck", code: "gone" };
  // A parent's phone and address (stage 3's slice 11b): in place when QuickBooks holds them; otherwise sent again only
  // while every field it sends holds what the portal last knew of, at the version it was sent with. Anything else is
  // settled by the fields, read live (`moved_on`, which the queue takes to the one path of a change saved first).
  if (w.op === "contact") {
    const stands = contactStands(heldInCache(now), w);
    return stands === "in_place" ? { is: "done", qboId: now.qboId } : stands === "differs" || now.syncToken !== w.syncToken ? { is: "stuck", code: "moved_on" } : { is: "send" };
  }
  const inPlace = w.op === "rename" ? now.displayName === w.name
    : w.op === "move" ? now.parentQboId === w.toFamilyQboId
      : !now.active;
  if (inPlace) return { is: "done", qboId: now.qboId };
  if (now.syncToken !== w.syncToken) return { is: "stuck", code: "moved_on" };
  return { is: "send" };
}
