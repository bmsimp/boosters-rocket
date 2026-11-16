import type { RosterWrite } from "@/lib/db/schema";
import { NO_TOKEN } from "@/lib/quickbooks/client";
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

/** A customer as the roster cache holds it, for the check before a queued write is sent again. */
export type CachedCustomer = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null; syncToken: string };

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
  const inPlace = w.op === "rename" ? now.displayName === w.name
    : w.op === "move" ? now.parentQboId === w.toFamilyQboId
      : !now.active;
  if (inPlace) return { is: "done", qboId: now.qboId };
  if (now.syncToken !== w.syncToken) return { is: "stuck", code: "moved_on" };
  return { is: "send" };
}
