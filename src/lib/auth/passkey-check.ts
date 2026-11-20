// A passkey's assertion, verified by the passkey library and never signed in by it (the sign-in release, slice SI-7a,
// the lead's decision 5: the ceremony is the library's, the sign-in the portal's). The door (/portal-passkey/check,
// parent-code-plugin.ts, through checkPasskeySignin(), src/lib/parents/passkey-signin.ts) runs the library's own
// verify-authentication in process, by auth.api and never over HTTP (its path is disabled for browsers,
// PARENT_DISABLED_PATHS), with the request's headers, which carry the signed challenge cookie the options' answer set,
// inside a scope of its own. The library, in this order: spends the challenge (consumeVerificationValue(), so an
// assertion replayed or sent twice at once is verified once), finds the passkey by the assertion's credential id,
// verifies the assertion (@simplewebauthn/server: the origin and the relying party id the instance names, user
// presence and verification, the signature, and a counter that must rise when either it or the stored one is above
// zero), then calls `authentication.afterVerification` (afterPasskeyVerified(), below, which records the verified
// passkey into the scope and returns), writes the new counter, and asks for a session, which the parent instance's
// guard refuses (finish-scope.ts): it throws UNABLE_TO_CREATE_SESSION before it sets any cookie. That error, with a
// verified passkey in the scope, is the one answer taken as verified; every other error, or that one with an empty
// scope, is a refusal. Server only.
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { PASSKEY_ERROR_CODES } from "@better-auth/passkey";
import { credentialTaken, passkeyNamed } from "@/lib/parents/passkeys";

/** The passkey the library verified: its row and its person. */
export type VerifiedPasskey = { passkeyId: string; parentId: string };
type Box = { verified: VerifiedPasskey | null };
const verifying = new AsyncLocalStorage<Box>();

/**
 * The library's `authentication.afterVerification` (parent-auth.ts): called only once the library's verification has
 * succeeded, and before it writes the counter. Inside the door's scope it records the passkey verified, found again by
 * the credential id the library verified (unique in `parent_auth_passkey`), with its person; outside it (anyone calling
 * the library's endpoint some other way) it records nothing, and the session the library then asks for is refused all
 * the same. It never throws, so the library goes on to write the counter itself.
 */
export async function afterPasskeyVerified(o: { verification: { authenticationInfo: { credentialID: string } } }): Promise<void> {
  const box = verifying.getStore();
  if (!box) return;
  try {
    const row = await passkeyNamed(o.verification.authenticationInfo.credentialID);
    box.verified = row ? { passkeyId: row.id, parentId: row.parentId } : null;
  } catch {
    box.verified = null;
  }
}

/** Why the library's verification said no, for the audit row only. */
export type AssertionRefusal = "challenge_used" | "passkey_unknown" | "passkey_failed";

const codeOf = (e: unknown): unknown => (typeof e === "object" && e !== null && "body" in e) ? (e as { body?: { code?: unknown } }).body?.code : undefined;

/**
 * The library's verification of one assertion, with this request's headers: the passkey it verified, or why not
 * (`challenge_used`: no challenge cookie, or its challenge spent or expired, which an assertion for no options is too;
 * `passkey_unknown`: no passkey has the credential id; `passkey_failed`: anything else, a forged signature, another
 * origin or relying party id, user verification not set, a counter that didn't rise). Nothing of the assertion is
 * kept or answered.
 */
export async function verifyAssertion(headers: Headers, response: Record<string, unknown>): Promise<{ ok: true; passkey: VerifiedPasskey } | { ok: false; reason: AssertionRefusal }> {
  const box: Box = { verified: null };
  try {
    await verifying.run(box, async () => {
      // Imported here, not at the top: parent-auth.ts imports this module for afterPasskeyVerified().
      const { getParentAuth } = await import("./parent-auth");
      const auth = await getParentAuth();
      // The library types its body as the browser ceremony's answer; what is passed is that answer, read and bounded (readAssertion()).
      await auth.api.verifyPasskeyAuthentication({ body: { response: response as never }, headers });
    });
  } catch (e) {
    const code = codeOf(e);
    if (code === PASSKEY_ERROR_CODES.UNABLE_TO_CREATE_SESSION.code && box.verified) return { ok: true, passkey: box.verified };
    return { ok: false, reason: code === PASSKEY_ERROR_CODES.CHALLENGE_NOT_FOUND.code ? "challenge_used"
      : code === PASSKEY_ERROR_CODES.PASSKEY_NOT_FOUND.code ? "passkey_unknown" : "passkey_failed" };
  }
  // The library answered with a session of its own: the guard would have to have failed. Never taken as a sign-in.
  return { ok: false, reason: "passkey_failed" };
}

/*
 * A passkey's registration (the sign-in release, slice SI-7b, the lead's decision 2): the library's own
 * verify-registration, run in process by auth.api and never over HTTP (its path stays disabled for browsers,
 * PARENT_DISABLED_PATHS), with the request's headers, which carry the parent's session and the signed challenge cookie
 * the options' answer set, inside a scope of its own, and never with `createSession` (the guard would refuse one
 * regardless). The library, in this order: reads the session (its sensitive and fresh middleware; freshness is the
 * portal's window, so the parent instance's `freshAge` is 0), spends the challenge (consumeVerificationValue()), checks
 * that the challenge's user is the session's, verifies the answer (@simplewebauthn/server's verifyRegistrationResponse():
 * the challenge, the origin and the relying party the instance names, user presence and, since the plugin asks for it,
 * user verification), calls `registration.afterVerification` (afterRegistrationVerified(), below) and only then inserts
 * the passkey's row, outside any transaction of the portal's, and answers it.
 */
/** What the add's scope learns from the library's callback: why it refused, and the credential id it verified. */
type RegistrationBox = { refused: RegistrationRefusal | null; credentialId?: string };
const registering = new AsyncLocalStorage<RegistrationBox>();

/** Why a registration was refused, for the add's audit row only. */
export type RegistrationRefusal = "not_verified" | "already_added" | "challenge_used" | "registration_failed";

/**
 * The library's `registration.afterVerification` (parent-auth.ts): called once the answer has verified and before the
 * row is inserted, so throwing here leaves no row. Outside the add's scope (anyone calling the library's endpoint some
 * other way) it throws: no passkey is added but through the portal's /portal-passkey/add. Inside it, the portal's own
 * reads of what the library verified: the user verified (`registrationInfo.userVerified`, whatever the library asked),
 * and the credential id held by no passkey already, anyone's (the unique `parent_auth_passkey_credential_id_uq` would
 * refuse the insert too, as a failure of the library's own; this says why first). The id it verified is kept in the
 * scope, so an insert the unique index refuses (two adds of one credential at once, each past this check) is told
 * apart from any other failure (verifyRegistration()).
 */
export async function afterRegistrationVerified(o: { verification: { registrationInfo?: { userVerified?: boolean; credential?: { id?: string } } } }): Promise<void> {
  const box = registering.getStore();
  if (!box) throw new Error("passkey registration outside the portal's add");
  const info = o.verification.registrationInfo;
  if (info?.userVerified !== true) { box.refused = "not_verified"; throw new Error("not user-verified"); }
  const id = info.credential?.id;
  if (typeof id !== "string" || id.length === 0) { box.refused = "registration_failed"; throw new Error("no credential id"); }
  box.credentialId = id;
  if (await credentialTaken(id)) { box.refused = "already_added"; throw new Error("already added"); }
}

/**
 * The library's verification and insert of one registration answer, with this request's headers: the new passkey's row
 * id, or why not. The answer passed is what the browser sent, read and bounded by the caller (readRegistration(),
 * passkey-settings.ts); no name is passed (the portal sets it in its own transaction), and no `createSession`.
 */
export async function verifyRegistration(headers: Headers, response: Record<string, unknown>): Promise<{ ok: true; passkeyId: string } | { ok: false; reason: RegistrationRefusal }> {
  const box: RegistrationBox = { refused: null };
  let answered: unknown;
  try {
    answered = await registering.run(box, async () => {
      const { getParentAuth } = await import("./parent-auth");
      const auth = await getParentAuth();
      return auth.api.verifyPasskeyRegistration({ body: { response: response as never }, headers });
    });
  } catch (e) {
    if (box.refused) return { ok: false, reason: box.refused };
    if (codeOf(e) === PASSKEY_ERROR_CODES.CHALLENGE_NOT_FOUND.code) return { ok: false, reason: "challenge_used" };
    // Verified and past the check above, but the insert failed: when the credential is held now, another add of it won
    // (the unique index refused this one, which the library reports as its own failure).
    if (box.credentialId && (await credentialTaken(box.credentialId))) return { ok: false, reason: "already_added" };
    return { ok: false, reason: "registration_failed" };
  }
  const id = typeof answered === "object" && answered !== null ? (answered as { id?: unknown }).id : undefined;
  // A session in the answer would mean the guard had failed: never taken.
  if (typeof id !== "string" || (answered as { session?: unknown }).session !== undefined) return { ok: false, reason: "registration_failed" };
  return { ok: true, passkeyId: id };
}
