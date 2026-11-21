// The words of Strict's enrolment (/one-more-step; the sign-in release, slice SI-10a): first drafts in PRODUCT.md's
// voice, which the owner will revisit. Plain strings and no imports, so the page's client parts use this file too. The
// app's set-up itself keeps SI-6b's words (SIGNIN_SETTINGS_COPY), but for how long it lasts, which is the enrolment's,
// and for the words of a set-up that is over, whose advice points to what this page can do.

/**
 * What the app may hold after a set-up that went another way, as this page says it: Sign-in settings' words
 * (APP_LEFTOVERS, signin-settings-copy.ts) offer to turn the app off there, which this page can't do, and which Strict
 * refuses for the last factor anyway.
 */
const APP_LEFTOVERS = "Once a set-up is finished, only the entry it made in your authenticator app works for this portal, so you can delete any others. If you can't tell them apart, keep them all for now, and when you sign in, use the one whose code works.";

export const ENROLMENT_COPY = {
  title: "One more step",
  lede: "The club now asks everyone to use a passkey or an authenticator app when they sign in, as well as their password. It takes a minute, and you only do it once.",
  passkeyTitle: "Use a passkey",
  passkeyWhat: "A passkey lets you sign in with Face ID, your fingerprint, Windows Hello or your password manager, with no code to type.",
  passkeyAdd: "Add a passkey",
  passkeyAddBusy: "Adding…",
  /** A browser with no WebAuthn, or the page at an address passkeys don't belong to: the app is the way. */
  passkeyNotHere: "This browser can't add a passkey. You can set up an authenticator app instead.",
  appTitle: "Use an authenticator app",
  appWhat: "An app on your phone, like Google Authenticator or Microsoft Authenticator, shows a new 6-digit code every 30 seconds. You'll enter it after your password each time you sign in.",
  appSetUp: "Set up an authenticator app",
  appSetUpBusy: "Starting…",
  /** Under the set-up's QR code and key, in place of Sign-in settings' words, whose time is the asking-again window's. */
  appSetupLost: "Please finish within 30 minutes of signing in. Switching to your authenticator app and back to this page is fine. If you reload this page or take longer, nothing is kept: you'll start again with a new QR code, and the entry your app saved this time won't work, so delete it from the app.",
  /** The confirm's answers for a set-up that is over (ran out, replaced, finished in another window), in place of Sign-in settings'. */
  appSetupGone: `That set-up has run out, so nothing was kept. Press "Set up an authenticator app" to start again. ${APP_LEFTOVERS}`,
  appSetupReplaced: `You started a newer set-up in another window. Finish it there, or start again here. ${APP_LEFTOVERS}`,
  appSetupDoneElsewhere: `Your authenticator app is already set up, from another window. Please reload this page to carry on. ${APP_LEFTOVERS}`,
  donePasskey: "Done. Next time you sign in, use your passkey.",
  doneApp: "Done. Next time you sign in, enter your password and then a code from your app.",
  /** The backup codes beside a first passkey, as this page says it: nothing here asks again. */
  backupCodesKeepPasskey: "Each backup code works once, in place of your passkey, when you sign in. If you lose the phone or computer that holds your passkey, they're how you get in, so keep them somewhere safe that isn't on that device, like on paper or in a password manager on another device. We won't show them again.",
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
  foot: "Can't do this now? You can sign out and come back to it next time you sign in. If you need help, please ask the club.",
} as const;
