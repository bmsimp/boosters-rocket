// The words of Strict's enrolment (/one-more-step; the sign-in release, slice SI-10a): first drafts in PRODUCT.md's
// voice, which the owner will revisit. Plain strings and no imports, so the page's client parts use this file too. The
// app's set-up itself keeps SI-6b's words (SIGNIN_SETTINGS_COPY), but for how long it lasts, which is the enrolment's,
// and for the words of a set-up that is over, whose advice points to what this page can do.

/**
 * What the app may hold after a set-up that went another way, as this page says it: Sign-in settings' words
 * (APP_LEFTOVERS, signin-settings-copy.ts) offer to turn the app off there, which this page can't do, and which Strict
 * refuses for the last factor anyway.
 */
const APP_LEFTOVERS = "Only the entry from the set-up you finished works, so you can delete the others. Can't tell them apart? Keep them all, and use the one whose code works.";

export const ENROLMENT_COPY = {
  title: "One more step",
  lede: "The club now asks everyone for a passkey or an authenticator app as well as a password. It takes a minute, and you only do it once.",
  passkeyTitle: "Use a passkey",
  passkeyWhat: "A passkey signs you in with Face ID, your fingerprint, Windows Hello or your password manager. No code to type.",
  passkeyAdd: "Add a passkey",
  passkeyAddBusy: "Adding…",
  /** A browser with no WebAuthn, or the page at an address passkeys don't belong to: the app is the way. */
  passkeyNotHere: "This browser can't add a passkey. You can set up an authenticator app instead.",
  appTitle: "Use an authenticator app",
  appWhat: "An app like Google or Microsoft Authenticator shows a new 6-digit code every 30 seconds. You'll enter it after your password each time you sign in.",
  appSetUp: "Set up an authenticator app",
  appSetUpBusy: "Starting…",
  /** Under the set-up's QR code and key, in place of Sign-in settings' words, whose time is the asking-again window's. */
  appSetupLost: "Please finish within 30 minutes of signing in. You can switch to your app and back. If you reload or run out of time, you'll start over with a new QR code, so delete the entry your app just saved.",
  /** The confirm's answers for a set-up that is over (ran out, replaced, finished in another window), in place of Sign-in settings'. */
  appSetupGone: `That set-up has run out, so nothing was kept. Press "Set up an authenticator app" to start again. ${APP_LEFTOVERS}`,
  appSetupReplaced: `You started a newer set-up in another window. Finish it there, or start again here. ${APP_LEFTOVERS}`,
  appSetupDoneElsewhere: `Your authenticator app is already set up, from another window. Please reload this page to carry on. ${APP_LEFTOVERS}`,
  donePasskey: "Done. Next time you sign in, use your passkey.",
  doneApp: "Done. Next time you sign in, enter your password and then a code from your app.",
  /** The backup codes beside a first passkey, as this page says it: nothing here asks again. */
  backupCodesKeepPasskey: "Each code works once, in place of your passkey, when you sign in. If you lose the device with your passkey, they're how you get in, so keep them safe somewhere else, like on paper. We won't show them again.",
  saved: "I've saved my backup codes somewhere safe",
  continue: "Continue",
  tickFirst: "Please tick the box once you've saved your backup codes.",
  /** A press refused because the enrolment's window has passed: said only when it has. */
  windowPassed: "It's been more than 30 minutes since you signed in, so please sign in again to finish this step.",
  /** A press refused because the session may no longer add one for another reason (a factor added in another browser, the club's level changed). */
  signInAgain: "This page can't do that now. Please sign in again to carry on.",
  /** After either of those two, when the refused press was the app's confirm: the entry the app saved is dead. */
  appEntryDead: "The entry your authenticator app saved for this set-up won't work, so please delete it from the app.",
  /** A press that threw (a lost connection, the server, or the session no longer enrolling): one answer that holds for each. */
  failed: "That didn't go through. Please reload this page to carry on.",
  signIn: "Sign in",
  foot: "Can't do this now? Sign out and finish it next time you sign in. Need help? Ask the club.",
} as const;
