// The words of Strict's enrolment (/one-more-step; the sign-in release, slice SI-10a): first drafts in PRODUCT.md's
// voice, which the owner will revisit. Plain strings and no imports, so the page's client parts use this file too. The
// app's set-up itself keeps SI-6b's words (SIGNIN_SETTINGS_COPY), but for how long it lasts, which is the enrolment's.

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
  appSetupLost: "Switching to your authenticator app and back to this page is fine. If you reload this page, nothing is kept: you'll start again with a new QR code, and the entry your app saved this time won't work, so delete it from the app.",
  donePasskey: "Done. Next time you sign in, use your passkey.",
  doneApp: "Done. Next time you sign in, enter your password and then a code from your app.",
  /** The backup codes beside a first passkey, as this page says it: nothing here asks again. */
  backupCodesKeepPasskey: "Each backup code works once, in place of your passkey, when you sign in. If you lose the phone or computer that holds your passkey, they're how you get in, so keep them somewhere safe that isn't on that device, like on paper or in a password manager on another device. We won't show them again.",
  saved: "I've saved my backup codes somewhere safe",
  continue: "Continue",
  tickFirst: "Please tick the box once you've saved your backup codes.",
  /** Any press once the window has passed (the gate has ended the session), or the session can't add one now. */
  windowPassed: "It's been more than 30 minutes since you signed in, so please sign in again to finish this step.",
  signIn: "Sign in",
  foot: "Can't do this now? You can sign out and come back to it next time you sign in. If you need help, please ask the club.",
} as const;
