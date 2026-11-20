// The words of a parent's sign-in settings (/family/sign-in; the sign-in release, slice SI-5a) and of asking again,
// which /family/email asks too. Plain strings, so the client forms and the actions share them. No imports but the
// door's own words: the client components use this file.
import { TOO_MANY_TRIES } from "./signin-copy";

export const SIGNIN_SETTINGS_COPY = {
  title: "Sign-in settings",
  lede: "How you sign in to the portal, and what you can change about it.",
  howTitle: "How you sign in",
  email: "Email",
  password: "Password",
  passwordChosen: "Chosen",
  passwordNotChosen: "Not chosen yet",
  how: "You sign in with this address and your password. On a device we don't know yet, we also email a code to this address.",
  /** For a person with no password yet (a session from before passwords): they stay signed in, and need one to sign in again. */
  howNoPassword: "You're signed in here, but you haven't chosen a password yet. To sign in again on any device, you'll need one.",
  changeEmail: "Change my sign-in email",
  passwordTitle: "Your password",
  /** Under Strict (SI-10 stores it): nothing can be changed here until a second factor of the guardian's own exists. */
  strict: "For now, your password and your sign-in email can't be changed here. Please ask the club if you need either changed.",
  noPassword: "You haven't chosen a password yet. We can email a link to choose one to the address you sign in with.",
  setupButton: "Email me a link to choose a password",
  setupBusy: "Sending…",
  askAgainForPassword: "Before you change your password, please show it's you: enter your password, then the code we email you.",
  askAgainForEmail: "Before you change your sign-in email, please show it's you: enter your password, then the code we email you.",
  choosePasswordForEmail: "Before you can change your sign-in email here, please choose a password.",
  signsOutEverywhere: "Changing your password signs you out everywhere, this device too. Then you sign in again with your new password, and on each device you enter the code we email you.",
  newPassword: "New password",
  newPasswordAgain: "New password again",
  changeButton: "Change my password",
  changeBusy: "Changing…",
  changed: "Your password is changed, and you're signed out everywhere, this device too.",
  changedNext: "Sign in again with your new password. On each device you'll also enter a code we email you.",
  signIn: "Sign in",
  everywhereTitle: "Sign out everywhere",
  everywhereLede: "Lost a phone, or signed in on a computer that isn't yours? This signs you out on every device, this one included, and we forget every device we remember for you.",
  everywhereThen: "Then you sign in again with your email and password, and on each device you enter the code we email you.",
  everywhereButton: "Sign out everywhere",
  everywhereBusy: "Signing out…",
  everywhereDone: "You're signed out everywhere, this device too.",
  everywhereNext: "Sign in again with your email and password. On each device you'll also enter a code we email you.",
  /** The same, for a person with no password yet: they choose one first, from "Set up or reset my password". */
  everywhereThenNoPassword: "You haven't chosen a password yet, so to sign in again you'll first choose one from a link we email you. After that, on each device you sign in with your email and password and enter the code we email you.",
  everywhereNextNoPassword: "To sign in again, first choose a password: we'll email you a link to choose one.",
  choosePassword: "Choose a password",
  /** The same, for a person with no password under Strict, where no link is mailed on request: only the club can help. */
  everywhereThenStrict: "You haven't chosen a password yet, and for now only the club can help you set one up. If you sign out everywhere, please ask the club to help you sign in again.",
  everywhereNextStrict: "Please ask the club to help you sign in again.",
  devicesTitle: "Remembered devices",
  devicesSoon: "The phones and computers we remember for you will be listed here, so you can see them and forget any you don't use.",
  moreTitle: "More ways to sign in",
  moreSoon: "More ways to sign in, like a passkey or an authenticator app, will come here.",
  // Asking again (asking-again.ts): the password, then the emailed code.
  yourPassword: "Your password",
  continue: "Continue",
  checking: "Checking…",
  codeSent: "We've emailed you a 6-digit code. Enter it here to go on. It can take a minute. Check your spam folder too.",
  code: "6-digit code",
  confirm: "Confirm",
  startAgain: "Start again",
  /** One answer for every refusal of the password, but too many tries: nothing tells the reasons apart. */
  passwordRejected: "That password didn't work. Please check it and try again.",
  /** One answer for a wrong, expired or used-up code, and a step that has ended or that this page never began. */
  codeRejected: "That code didn't work. Check the newest email from us and try again, or start again with your password.",
  tooManyTries: TOO_MANY_TRIES,
  proved: "Thank you, that's you. You can make the change now.",
  /** The change asked after the 10 minutes ran out (or before asking again): the page is drawn again with the asking. */
  proveAgain: "It's been more than 10 minutes since you showed it's you. Please reload this page and do that again first.",
  tooManyChanges: "You've tried to change your password a few times in the last hour. Please wait a little while before trying again.",
  tooManyPresses: "You've pressed this a few times in the last hour. Please wait a little while before trying again.",
  /** When the action itself couldn't be reached or threw: try again, nothing about why. */
  failed: "That didn't go through. Please try again in a moment.",
} as const;
