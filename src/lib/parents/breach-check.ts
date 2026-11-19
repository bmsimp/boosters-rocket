// Whether a password is among those known from breaches (the sign-in release; section 6 of the app-owned families spec,
// "Signing in"). Server only. It asks the public Pwned Passwords range service (./breach-endpoints.ts) by k-anonymity:
// only the first five characters of the password's SHA-1 hash leave the server, with the padding header, so the
// answer's size says nothing either; the rest of the hash is compared here. Nothing of the password, its hash or the
// suffix is logged, thrown, kept or sent anywhere else, and the function never throws: when the service can't answer
// (unreachable, slow, or an answer it doesn't understand) the password could not be checked, and the spec's rule is
// that it is then taken and its audit row says it was not checked. Called by choosePasswordFromLink()
// (./password-set.ts), the set-up and reset links' form, since slice SI-2.
import "server-only";
import { createHash } from "node:crypto";
import { breachEndpoints } from "./breach-endpoints";

/** A sign-in waits this long at most for the service. */
export const BREACH_TIMEOUT_MS = 3_000;
/** An answer larger than this is not one the service gives (a padded range is some tens of kilobytes): not understood. */
const MOST_BYTES = 1_000_000;

/** Why a password could not be checked: a short code an audit row may carry. */
export type BreachNotChecked = "timeout" | "unreachable" | "bad_answer";
export type BreachCheck = { outcome: "found" } | { outcome: "not_found" } | { outcome: "not_checked"; why: BreachNotChecked };

/** One line of a range answer: the 35 characters of a hash after its first five, and how often it was seen (0 for padding). */
const LINE = /^([0-9A-F]{35}):(\d+)$/;

/** The answer to a range request, read strictly: every line well formed and at least one of them, or null. */
function seenCount(body: string, suffix: string): number | null {
  const lines = body.split(/\r?\n/).filter((line, i, all) => line !== "" || i < all.length - 1);
  if (lines.length === 0) return null;
  let seen = 0;
  for (const line of lines) {
    const m = LINE.exec(line.toUpperCase());
    if (!m) return null;
    if (m[1] === suffix) seen = Math.max(seen, Number(m[2]));
  }
  return seen;
}

export async function checkBreach(password: string, o: { timeoutMs?: number } = {}): Promise<BreachCheck> {
  const hash = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5), suffix = hash.slice(5);
  let body: string;
  try {
    const res = await fetch(`${breachEndpoints().range}${prefix}`, {
      method: "GET",
      headers: { "add-padding": "true", accept: "text/plain" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(o.timeoutMs ?? BREACH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { outcome: "not_checked", why: "bad_answer" };
    }
    body = await res.text();
  } catch (e) {
    return { outcome: "not_checked", why: (e as { name?: string } | null)?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
  if (body.length > MOST_BYTES) return { outcome: "not_checked", why: "bad_answer" };
  const seen = seenCount(body, suffix);
  if (seen === null) return { outcome: "not_checked", why: "bad_answer" };
  return seen > 0 ? { outcome: "found" } : { outcome: "not_found" };
}
