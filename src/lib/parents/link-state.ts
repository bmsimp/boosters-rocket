// Which of a person's set-up and reset links (`parent_signin_token`, signin-links.ts) are not yet spent. It imports
// nothing but the schema, so any writer that ends a person's sign-in can use it without importing anything else.
import { isNull, or, sql } from "drizzle-orm";
import { parentSigninToken } from "@/lib/db/schema";

/**
 * A held link (holdSigninLink(), signin-links.ts): stored with `used_at` set to its own `created_at` while its mail is
 * on its way, so it works for nobody yet. A spent link is spent later than it was made, so this marks a held one alone.
 */
export const heldLink = sql`${parentSigninToken.usedAt} = ${parentSigninToken.createdAt}`;

/**
 * A link not spent: unused, or held on its way to being put in place. Everything that ends all of a person's sign-in
 * deletes these, so a link held before the end never comes to life after it (a close and a reinstate, a block and an
 * unblock, sign-ins switched off and on again, all while its mail was on its way).
 */
export const unspentLink = or(isNull(parentSigninToken.usedAt), heldLink)!;
