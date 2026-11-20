import { and, asc, eq, gt, lte, sql, count } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { rateLimitEvent } from "@/lib/db/schema";

export type RateLimitKind = "code_send_email" | "code_send_ip" | "code_check_ip" | "contact_save_parent" | "contact_open_parent" | "form_open_parent"
  | "volunteer_checkin_parent" | "volunteer_signup_parent" | "email_request_parent" | "email_confirm_parent" | "buyout_parent"
  | "password_link_ip" | "password_link_token" | "password_ask_email" | "password_ask_ip" | "password_try_email" | "password_try_device"
  | "password_try_ip" | "password_reask_parent" | "password_change_parent" | "signin_settings_parent" | "second_step_parent";
const WINDOW_MS = 15 * 60 * 1000;
/**
 * Guessing is stopped per code (5 tries, 10 minutes: signin-codes.ts) and per address (3 codes in 15 minutes). The two
 * per-IP limits only stop a flood: on a registration night a whole room of parents shares the school's one address, so
 * they sit well above what a full room asks for (spec §1 Rate limits). With no address they are not applied at all
 * (signin-codes.ts): every visitor would share one count.
 */
export const RATE_LIMITS: Record<RateLimitKind, { max: number; windowMs: number }> = {
  code_send_email: { max: 3, windowMs: WINDOW_MS },
  code_send_ip: { max: 60, windowMs: WINDOW_MS },
  code_check_ip: { max: 180, windowMs: WINDOW_MS },
  // Choosing a password from a set-up or reset link (password-set.ts). A token is 32 random bytes, so it can't be
  // guessed: the limit per token only bounds the tries one link takes (a password too short, or found in a breach, is
  // tried again) and the breach-service calls and password hashes one link can cause; 10 is far more than choosing a
  // password takes. The limit per IP address stops a flood only, set as the code request's is (code_send_ip), since a
  // registration night may have a room of parents choosing passwords on the school's one address. With no address it
  // is not applied, as with the codes.
  password_link_ip: { max: 60, windowMs: WINDOW_MS },
  password_link_token: { max: 10, windowMs: WINDOW_MS },
  // Asking for a set-up or reset link by email (the page "Set up or reset my password", password-request.ts). Each ask
  // may mail the address, so it is held as the code request is: 3 per address, as code_send_email, since nobody needs
  // more than a few links in a quarter of an hour and each new one replaces the last; counted under a keyed hash of the
  // address, never the address, so no count holds an outsider's address. 60 per IP address, as code_send_ip, a flood
  // stop only, for a room of parents on the school's one address; not applied with no address.
  password_ask_email: { max: 3, windowMs: WINDOW_MS },
  password_ask_ip: { max: 60, windowMs: WINDOW_MS },
  // Signing in with a password (password-signin.ts; the sign-in release, slice SI-3b). 5 wrong tries per typed address
  // in 15 minutes (open question 27), counted under a keyed hash of the address (never the address), whatever it names,
  // so the answer and the count are the same for an address on file and one that isn't. A try takes its place before
  // anything is read, so tries sent at once can't slip past, and a password that proves right gives its place back
  // (giveBackRateLimit()), so only wrong and refused tries stay counted and a parent's own right password never uses
  // one up. A try made on a device the portal remembers for the person the address names is counted against that
  // device instead (`password_try_device`, keyed by the device's row, 5 wrong tries in 15 minutes, given back the same
  // way), so a stranger who keeps the address's count full doesn't keep the parent out on their own device, and a
  // stolen device cookie gets no more guesses than the address would. 180 per IP address, as code_check_ip, a flood
  // stop only, for a room of parents signing in on the school's one address; not applied with no address.
  password_try_email: { max: 5, windowMs: WINDOW_MS },
  password_try_device: { max: 5, windowMs: WINDOW_MS },
  password_try_ip: { max: 180, windowMs: WINDOW_MS },
  // A parent's sign-in settings (signin-settings.ts; the sign-in release, slice SI-5a), counted per person. Changing the
  // password: each try may ask the breach service and make a 32 MiB hash, so it is held to 10 an hour, far more than a
  // parent choosing a new password takes, mistyped or refused a few times. Signing out everywhere (and from SI-5b,
  // forgetting a device): each press is a write and an audit row, and the first press ends the session that made it,
  // so 10 an hour is far more than anyone needs. Asking again counts a signed-in parent's password tries, 5 wrong in 15
  // minutes as at the door, a right password giving its place back: since SI-5b, in a session made on one of the
  // person's unexpired devices, against that device (`password_try_device`, the door's own count for a password typed on
  // it, so whoever holds that session can fill that one device's count, as anyone holding the device could at the door);
  // otherwise against the person (`password_reask_parent`, keyed by the person's id; checkPasswordSignin()'s TryCount).
  // Never against the address's count, so a stranger who keeps `password_try_email` full at the door can't stop the
  // parent proving it's them, and a thief holding only the session can't fill the address's. The per-IP flood stop
  // (password_try_ip), the code's limits (code_send_*, code_check_ip and its five tries) are the door's, and the set-up
  // link offered here is the request page's (password_ask_*).
  password_reask_parent: { max: 5, windowMs: WINDOW_MS },
  // An authenticator app's code or a backup code as the second step (verifySecondFactor(), signin-codes.ts; the sign-in
  // release, slice SI-6a), at the door and in asking again, counted per person, the one a pending step or a stamp names
  // (never a typed address: only a right password makes either). A six-digit code has a million values and three are
  // live at once (a step either way), so 5 wrong tries in 15 minutes, as the emailed code's 5 tries, keeps a guess
  // at about one in sixty thousand a quarter of an hour; a right code gives its place back (giveBackRateLimit()), so a
  // parent's own codes never use one up, and so does a try whose app's secret won't open (no guess was possible), so it
  // never shuts the parent out of their backup codes. Taken before the person's app or codes are read, so tries sent at once can't
  // slip past. The per-IP flood stop is the code check's (code_check_ip).
  second_step_parent: { max: 5, windowMs: WINDOW_MS },
  password_change_parent: { max: 10, windowMs: 60 * 60 * 1000 },
  signin_settings_parent: { max: 10, windowMs: 60 * 60 * 1000 },
  // A parent's own phone and address (contact-edits.ts), counted per person: nobody changes their address more than a
  // few times an hour. Since stage 3's slice 11a opening the edit page reads the portal alone and takes no count, so
  // contact_open_parent is unused (S12 removes it).
  contact_save_parent: { max: 6, windowMs: 60 * 60 * 1000 },
  contact_open_parent: { max: 30, windowMs: WINDOW_MS },
  // Opening a form to sign, and checking how one stands (src/lib/forms/signing.ts), counted per person: each asks the
  // club's Documenso once, and Documenso counts every call the portal makes against one limit of its own. A family
  // signing a dozen forms in a sitting opens and checks each a few times, so this sits well above that.
  form_open_parent: { max: 120, windowMs: WINDOW_MS },
  // Checking in at a volunteer shift (src/lib/volunteer/check-in.ts), counted per person: a guardian checks in
  // themselves and a student or two, a press each, so this sits well above a family's busiest evening.
  volunteer_checkin_parent: { max: 30, windowMs: WINDOW_MS },
  // Signing up for a volunteer shift (src/lib/volunteer/my-volunteer.ts), counted per person: each place taken emails
  // the guardian a confirmation and locks the shift's row. A guardian signing up themselves and a few students for a
  // season's shifts in one sitting stays well under it.
  volunteer_signup_parent: { max: 30, windowMs: WINDOW_MS },
  // A parent's change of their own sign-in address (email-change.ts), counted per person. Each ask mails two
  // addresses, one of them typed by the parent, so it is kept low; each confirmation reads and may write the club's
  // QuickBooks. Nobody changes their address more than once or twice, and a link that met a busy moment is tried again.
  email_request_parent: { max: 5, windowMs: 60 * 60 * 1000 },
  email_confirm_parent: { max: 10, windowMs: 60 * 60 * 1000 },
  // A guardian choosing to pay instead of volunteering, or switching back (src/lib/buyouts/writes.ts), counted per
  // person: each press may make or void an invoice in the club's QuickBooks. A family with a few students chooses for
  // each in a sitting, and may change its mind once or twice; this sits above that.
  buyout_parent: { max: 10, windowMs: 60 * 60 * 1000 },
};

/**
 * "taken": counted. "first_refusal": the window is full and this is the first refusal since it filled, so the caller
 * audits it. "refused": the window is full and its refusal was already audited, so the caller writes nothing.
 */
export type RateLimitTake = "taken" | "first_refusal" | "refused";

/**
 * Counts one event for (kind, subject), or refuses without counting when the sliding window is full. Held in the
 * database, so it survives restarts and holds across servers; a per-subject advisory lock (the setup code's try counter
 * uses the same reserve-then-compare idea) makes a parallel burst count exactly.
 *
 * A full window is audited once: the first refusal marks the window's oldest event. The window stays full, with the
 * same oldest event, until that event ages out (refusals add no rows, so they neither extend the window nor grow the
 * table), and the mark goes with it. The next full window has a new, unmarked oldest event.
 */
export async function takeRateLimit(kind: RateLimitKind, subject: string, now = new Date()): Promise<RateLimitTake> {
  return (await takeRateLimitPlace(kind, subject, now)).take;
}

/**
 * A place taken in a window: the event's row, which giveBackRateLimit() can give back, or null when nothing was counted;
 * and, for a place taken, its number among the window's live events (`number`, 1 for the first), counted under the
 * limit's lock in the transaction that took it, so tries made at once each get their own (a try's audit row,
 * verifySecondFactor()).
 */
export type RateLimitPlace = { take: RateLimitTake; placeId: number | null; number?: number };

/** As takeRateLimit(), with the row of the event it counted, for a caller that may give the place back. */
export async function takeRateLimitPlace(kind: RateLimitKind, subject: string, now = new Date()): Promise<RateLimitPlace> {
  const { max, windowMs } = RATE_LIMITS[kind];
  const since = new Date(now.getTime() - windowMs);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.rate:${kind}:${subject}`}))`);
    const scope = and(eq(rateLimitEvent.kind, kind), eq(rateLimitEvent.subject, subject));
    await tx.delete(rateLimitEvent).where(and(scope, lte(rateLimitEvent.at, since)));
    const live = and(scope, gt(rateLimitEvent.at, since));
    const [{ n }] = (await tx.select({ n: count() }).from(rateLimitEvent).where(live)) as [{ n: number }];
    if (n < max) {
      const [row] = await tx.insert(rateLimitEvent).values({ kind, subject, at: now }).returning({ id: rateLimitEvent.id });
      return { take: "taken" as const, placeId: row!.id, number: n + 1 };
    }
    const [oldest] = await tx.select({ id: rateLimitEvent.id, refusalAudited: rateLimitEvent.refusalAudited }).from(rateLimitEvent)
      .where(live).orderBy(asc(rateLimitEvent.at), asc(rateLimitEvent.id)).limit(1);
    if (!oldest || oldest.refusalAudited) return { take: "refused" as const, placeId: null };
    await tx.update(rateLimitEvent).set({ refusalAudited: true }).where(eq(rateLimitEvent.id, oldest.id));
    return { take: "first_refusal" as const, placeId: null };
  });
}

/**
 * Gives back a place takeRateLimitPlace() counted: its one row, by id, and nothing else, so the window is as if the
 * event had never been counted (a right password's try, password-signin.ts). A row already gone (aged out, or cleaned
 * up) is nothing to give back.
 */
export async function giveBackRateLimit(placeId: number | null): Promise<void> {
  if (placeId === null) return;
  await db.delete(rateLimitEvent).where(eq(rateLimitEvent.id, placeId));
}
