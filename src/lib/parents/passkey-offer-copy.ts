// The words of the passkey offer on Home (the sign-in release, slice SI-8; section 6 of the app-owned families spec,
// "The passkey, offered"): first drafts in PRODUCT.md's voice, which the owner will revisit. Pure, no imports, so the
// box (a client component), the action and the tests read the same words. Nothing here says a parent is less safe
// without a passkey: the offer is a nicety.

export const PASSKEY_OFFER_COPY = {
  /** On a phone (offerDevice(), src/app/components/pwa/install-platform.ts). */
  phoneTitle: "Sign in with Face ID or your fingerprint next time?",
  phoneBody: "Your phone can keep a passkey for the portal. Next time, you sign in with a tap, with no password or code to type.",
  /** On a computer, a tablet that isn't Apple's included. */
  computerTitle: "Sign in with a passkey next time?",
  computerBody: "A passkey lets you sign in with Face ID, your fingerprint, Windows Hello or your password manager, with no password or code to type.",
  removeAnyTime: "You can remove it any time under Sign-in settings.",
  turnOn: "Turn on",
  turnOnBusy: "Turning on…",
  notNow: "Not now",
  turnedOn: "Done. Next time you sign in here, use your passkey.",
  /**
   * How to keep the backup codes a first passkey makes, shown here in place of Sign-in settings' words (which say "this
   * page", and Home never asks the parent to show it's them).
   */
  backupCodesKeep: "Each backup code works once, in place of your passkey, when you sign in and when Sign-in settings asks you to show it's you. If you lose the phone or computer that holds your passkey, they're how you get in, so keep them somewhere safe that isn't on that device, like on paper or in a password manager on another device. We won't show them again.",
  /**
   * Turn on refused because the session may no longer add a passkey from here (most often: the ten minutes after
   * signing in have passed). Home has no way to show it's you again, so this points to Sign-in settings, which has.
   * Followed by a link there.
   */
  cantTurnOnHere: "We can't turn it on from here now. You can add a passkey any time under Sign-in settings.",
  /** "Not now", the first and second time. */
  declined: "No problem. We'll leave it for now.",
  /** "Not now", the third time: Home offers it no more. Followed by a link to Sign-in settings. */
  declinedLast: "No problem. We won't ask again. You can add a passkey any time under Sign-in settings.",
  signInSettings: "Sign-in settings",
} as const;
