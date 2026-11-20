"use server";
import { revalidatePath } from "next/cache";
import { parentAction } from "@/lib/guards";
import { askAgainCode, askAgainPassword } from "@/lib/parents/asking-again";
import { askMySetupLink, changeMyPassword, forgetMyDevice, forgetMyOtherDevices, signOutEverywhere } from "@/lib/parents/signin-settings";
import { confirmMyAuthenticator, remakeMyBackupCodes, startMyAuthenticator, turnOffMyAuthenticator } from "@/lib/parents/authenticator-settings";
import { removeMyPasskey, renameMyPasskey } from "@/lib/parents/passkey-settings";

/**
 * A parent's sign-in settings (src/lib/parents/signin-settings.ts) and asking again (src/lib/parents/asking-again.ts).
 *
 * Every argument comes from the browser, whatever its type says, and is handed on as it is, to be checked there for its
 * type and size. None names a person, a session, a family or a customer, and none is looked for: whose password, whose
 * sessions and whose code are decided from the session (ctx) alone. The values the server made are the stamp asking
 * again hands the page between the password and the code, checked against this session and person, and (since slice
 * SI-5b) a remembered device's row id, the value of its forget button, deleted only with the session's own person in
 * the delete's WHERE.
 *
 * A proof revalidates, since it changes what the pages draw (the change form in place of the asking), and so does a
 * device forgotten, since the list changes and the session goes on. A password
 * changed and a press of "Sign out everywhere" end this session too, so drawing the page again would only send the
 * parent to sign in before they had read the answer; the answer itself offers the way there.
 */
export const askAgainPasswordAction = parentAction(async (ctx, password: string) => askAgainPassword(ctx, password as unknown));

export const askAgainCodeAction = parentAction(async (ctx, stamp: string, code: string) => {
  const result = await askAgainCode(ctx, stamp as unknown, code as unknown);
  if (result.ok) for (const path of ["/family/sign-in", "/family/email"]) revalidatePath(path);
  return result;
});

export const changePasswordAction = parentAction(async (ctx, password: string, again: string) =>
  changeMyPassword(ctx, { password: password as unknown, again: again as unknown }));

export const signOutEverywhereAction = parentAction(async (ctx) => signOutEverywhere(ctx));

export const askSetupLinkAction = parentAction(async (ctx) => askMySetupLink(ctx));

export const forgetDeviceAction = parentAction(async (ctx, deviceId: string) => {
  const result = await forgetMyDevice(ctx, deviceId as unknown);
  if (result.ok) revalidatePath("/family/sign-in");
  return result;
});

export const forgetOtherDevicesAction = parentAction(async (ctx) => {
  const result = await forgetMyOtherDevices(ctx);
  if (result.ok) revalidatePath("/family/sign-in");
  return result;
});

/*
 * The authenticator app (slice SI-6b; src/lib/parents/authenticator-settings.ts). None takes an id: the app, an
 * unfinished set-up and the backup codes are the session's own person's. The first press answers the key and the QR
 * code once, with the set-up's stamp (an HMAC the server made, which the confirm sends back beside the code and which is
 * checked there for this session), and is not revalidated, so the page drawn again never holds them; a confirm, new
 * codes and turning off change what the page draws, and are.
 */
export const startAuthenticatorAction = parentAction(async (ctx) => startMyAuthenticator(ctx));

export const confirmAuthenticatorAction = parentAction(async (ctx, code: string, stamp: string) => {
  const result = await confirmMyAuthenticator(ctx, code as unknown, stamp as unknown);
  // An app finished in another window changes what the page draws too.
  if (result.ok || result.setupOver) for (const path of ["/family/sign-in", "/family/email", "/family"]) revalidatePath(path);
  return result;
});

export const newBackupCodesAction = parentAction(async (ctx) => {
  const result = await remakeMyBackupCodes(ctx);
  if (result.ok) revalidatePath("/family/sign-in");
  return result;
});

export const turnOffAuthenticatorAction = parentAction(async (ctx) => {
  const result = await turnOffMyAuthenticator(ctx);
  if (result.ok) for (const path of ["/family/sign-in", "/family/email", "/family"]) revalidatePath(path);
  return result;
});

/*
 * Passkeys (slice SI-7b; src/lib/parents/passkey-settings.ts). Adding is the portal's own endpoint, /portal-passkey/add
 * (src/lib/auth/parent-code-plugin.ts), since the ceremony's cookies are the auth instance's. Renaming and removing take
 * the passkey's row id from the page, the value of its buttons, looked for only among the session's own person's
 * passkeys; the name is checked there for its type and size. Both change what the page draws, and are revalidated.
 */
export const renamePasskeyAction = parentAction(async (ctx, passkeyId: string, name: string) => {
  const result = await renameMyPasskey(ctx, passkeyId as unknown, name as unknown);
  if (result.ok) revalidatePath("/family/sign-in");
  return result;
});

export const removePasskeyAction = parentAction(async (ctx, passkeyId: string) => {
  const result = await removeMyPasskey(ctx, passkeyId as unknown);
  if (result.ok) for (const path of ["/family/sign-in", "/family/email", "/family"]) revalidatePath(path);
  return result;
});
