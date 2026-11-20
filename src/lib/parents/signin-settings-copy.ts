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
  // The device list (slice SI-5b): what the portal remembers, and forgetting.
  devicesLede: "These are the phones and computers we remember for you. On them, you sign in with your password, without a code from us.",
  devicesNoNames: "We don't keep a device's name, its browser or where it is, so each one is shown by when we first remembered it and when it was last used.",
  devicesNone: "We don't remember any device for you right now. The next time you sign in, we'll also email you a code, and then remember that device.",
  thisDevice: "This device",
  firstRemembered: "First remembered",
  lastUsed: "Last used",
  /** Said above the list when the session names none of the listed devices (one from before SI-5b, or its device forgotten or run out). */
  devicesWhichUnknown: "We can't tell which of these is the device you're using now.",
  /** The button of the device this session was made on. */
  forgetDevice: "Forget this device",
  /** Every other row's button: "Forget" to the eye, and in its name which device, by the two times its row shows. */
  forgetOne: "Forget",
  forgetWhichFirst: "the device first remembered",
  forgetWhichLast: "last used",
  /** Added to that name only when another row's two times read the same to the minute, so no two buttons share a name. */
  forgetWhichRow: "listed number",
  forgetBusy: "Forgetting…",
  forgetOthers: "Forget every other device",
  /** The same button when the session names none of the listed devices: it forgets them all, whichever is in use. */
  forgetAll: "Forget every device",
  forgetHere: "Forgetting the device you're using now doesn't sign you out here. The next time you sign in on it, we'll email you a code again.",
  askAgainForDevices: "Before you forget a device, please show it's you: enter your password, then the code we email you.",
  choosePasswordForDevices: "To forget a device here, please choose a password first. Signing out everywhere forgets every device too.",
  devicesStrict: "For now, devices can't be forgotten one at a time here. Signing out everywhere forgets every device.",
  deviceForgotten: "That device is forgotten. The next time you sign in on it, we'll email you a code.",
  otherDevicesForgotten: "Every other device is forgotten. The next time you sign in on one of them, we'll email you a code.",
  /** The same press when the session kept no device of the person's: every one is gone, the one in use too, if it was one. */
  everyDeviceForgotten: "Every device is forgotten. The next time you sign in on any device, this one included, we'll email you a code.",
  /** One answer for a device that isn't one of the parent's to forget, whatever the reason. */
  deviceNotFound: "That device isn't one we remember for you now. Please reload this page.",
  // The authenticator app (slice SI-6b, in place of SI-5a's words that more ways to sign in would come here): setting it up, its backup codes, making new ones, and turning it off.
  appTitle: "Authenticator app",
  appWhat: "An authenticator app on your phone, like Google Authenticator or Microsoft Authenticator, shows a new 6-digit code every 30 seconds. Once you set one up, when you sign in on a device we don't know yet we ask for its code instead of emailing you one.",
  /** Setting one up keeps the remembered devices (open question 26 lists what forgets them): said beside the device list. */
  appKeepsDevices: "Setting up an app doesn't forget the devices we remember for you.",
  appNeedsPassword: "To set up an authenticator app, please choose a password first.",
  /** Under Strict (SI-10 stores it) the app is set up when the club first asks for one, not here. */
  appStrictOff: "For now, an authenticator app can't be set up here. Please ask the club if you'd like to use one.",
  askAgainForApp: "Before you set up an authenticator app, please show it's you: enter your password, then the code we email you.",
  appSetUp: "Set up an authenticator app",
  appSetUpBusy: "Starting…",
  appScan: "Scan this QR code with your authenticator app. If the app is on this phone, copy the key below into the app instead.",
  appQrLabel: "QR code to scan with your authenticator app",
  appKey: "Key to type into the app",
  copyKey: "Copy the key",
  copied: "Copied.",
  copyFailed: "We couldn't copy it. Select it and copy it yourself instead.",
  appConfirmLede: "Then enter the 6-digit code the app shows for this portal, to finish.",
  appConfirmCode: "Code from your authenticator app",
  appConfirm: "Finish setting up",
  /**
   * The set-up lives only in this page, and is finished only within the asking-again window (10 minutes from the proof,
   * not from the press): a reload, or running out of time, starts again with a new key, and the app's first entry is dead.
   */
  appSetupLost: "Please finish within 10 minutes of showing it's you. Switching to your authenticator app and back to this page is fine. If you reload this page or take longer, nothing is kept: you'll start again with a new QR code, and the entry your app saved this time won't work, so delete it from the app.",
  appSetupWrong: "That code didn't work. Check that it's the newest code the app shows for this portal, and try again.",
  /** The set-up ran out, or another window began a new one: the box goes back to its set-up press. */
  appSetupGone: "That set-up has run out, so nothing was kept. Please delete this portal's entry from your authenticator app, since it won't work, then press \"Set up an authenticator app\" to start again.",
  /** The 10 minutes since the proof ran out before the set-up was finished: the box goes back to its set-up press. */
  appSetupTimedOut: "It's been more than 10 minutes since you showed it's you, so this set-up can't be finished, and nothing was kept. Please delete this portal's entry from your authenticator app, since it won't work, then reload this page, show it's you again and start over.",
  /** Another window finished a set-up first: the page is drawn again with the app on. */
  appSetupDoneElsewhere: "Your authenticator app is already set up, perhaps in another window, so there's nothing to finish here. If your app saved a second entry for this portal just now, delete it: only the first one works.",
  appAlreadyOn: "You already have an authenticator app set up. Please reload this page.",
  appNotOn: "You don't have an authenticator app set up right now. Please reload this page.",
  appOn: "Your authenticator app is set up.",
  appOnSince: "Set up",
  backupCodesTitle: "Your backup codes",
  backupCodesKeep: "Each backup code works once, in place of a code from your app. If you lose your phone, they're how you get in, so keep them somewhere safe that isn't on your phone, like on paper or in a password manager on another device. We won't show them again.",
  copyCodes: "Copy the backup codes",
  backupCodesLeft: "Backup codes left",
  backupCodesNone: "You've used all your backup codes. Make new ones now, while your app still works.",
  askAgainForAppChange: "Before you make new backup codes or turn off your authenticator app, please show it's you: enter your password, then the code from your authenticator app.",
  newCodes: "Make new backup codes",
  newCodesBusy: "Making…",
  newCodesMade: "Here are your new backup codes. Your old ones no longer work.",
  turnOffWords: "If you turn off your authenticator app, your backup codes stop working too, and when you sign in on a device we don't know yet, we'll email you a code again.",
  turnOff: "Turn off the authenticator app",
  turnOffBusy: "Turning off…",
  turnedOff: "Your authenticator app is turned off, and your backup codes no longer work. When you sign in on a device we don't know yet, we'll email you a code again.",
  /** Under Strict the app is the guardian's only second step until passkeys come (SI-7): it stays. */
  turnOffStrict: "For now, your authenticator app can't be turned off here, since the club asks everyone for a second step and the app is your only one. Please ask the club if you need it changed.",
  // Asking again (asking-again.ts): the password, then the emailed code.
  yourPassword: "Your password",
  continue: "Continue",
  checking: "Checking…",
  codeSent: "We've emailed you a 6-digit code. Enter it here to go on. It can take a minute. Check your spam folder too.",
  code: "6-digit code",
  /** Asking again of a guardian with an authenticator app (slice SI-6a): nothing is emailed; the app's code or a backup code. */
  appAsked: "Enter the 6-digit code from your authenticator app to go on. If you don't have your phone with you, enter one of your backup codes instead.",
  appCode: "Code from your authenticator app, or a backup code",
  /** One answer for a wrong or used app code or backup code, and a step that has ended or that this page never began. */
  appRejected: "That code didn't work. Enter the newest code from your authenticator app, or a backup code you haven't used yet, or start again with your password.",
  /** Said after appRejected when the step can't go on (decision 10 of SI-6b): the page is back at the password. */
  stepOver: "Please enter your password again to start over.",
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

/**
 * The sentences that say how the parent signs in on a new device, for a guardian with an authenticator app in force
 * (slice SI-6b): the code from their app, where the others say the code we email. Each replaces the same key of
 * SIGNIN_SETTINGS_COPY, through howYouSignIn(), so a page or form picks one by whether the person has an app (MySignin.app).
 */
const WITH_APP = {
  how: "You sign in with this address and your password. On a device we don't know yet, we also ask for the code from your authenticator app, or one of your backup codes.",
  askAgainForPassword: "Before you change your password, please show it's you: enter your password, then the code from your authenticator app.",
  askAgainForEmail: "Before you change your sign-in email, please show it's you: enter your password, then the code from your authenticator app.",
  askAgainForDevices: "Before you forget a device, please show it's you: enter your password, then the code from your authenticator app.",
  signsOutEverywhere: "Changing your password signs you out everywhere, this device too. Then you sign in again with your new password, and on each device you enter the code from your authenticator app.",
  changedNext: "Sign in again with your new password. On each device you'll also enter the code from your authenticator app.",
  everywhereThen: "Then you sign in again with your email and password, and on each device you enter the code from your authenticator app.",
  everywhereNext: "Sign in again with your email and password. On each device you'll also enter the code from your authenticator app.",
  devicesLede: "These are the phones and computers we remember for you. On them, you sign in with your password, without a code from your authenticator app.",
  devicesNone: "We don't remember any device for you right now. The next time you sign in, we'll also ask for the code from your authenticator app, and then remember that device.",
  forgetHere: "Forgetting the device you're using now doesn't sign you out here. The next time you sign in on it, we'll ask for the code from your authenticator app again.",
  deviceForgotten: "That device is forgotten. The next time you sign in on it, we'll ask for the code from your authenticator app.",
  otherDevicesForgotten: "Every other device is forgotten. The next time you sign in on one of them, we'll ask for the code from your authenticator app.",
  everyDeviceForgotten: "Every device is forgotten. The next time you sign in on any device, this one included, we'll ask for the code from your authenticator app.",
} as const;

// Under Strict (stored by nothing until SI-10) a remembered device asks for the second step too (password-signin.ts),
// so `how`, `devicesLede` and their kin, here and in SIGNIN_SETTINGS_COPY, promise what Strict doesn't keep: SI-10 adds
// Strict's versions and picks them by the level as well.
export type HowWords = { [K in keyof typeof WITH_APP]: string };
/** The sentences of how the parent signs in on a new device: the app's for a guardian with one in force, the emailed code's otherwise. */
export function howYouSignIn(app: boolean): HowWords {
  if (app) return WITH_APP;
  const c = SIGNIN_SETTINGS_COPY;
  return { how: c.how, askAgainForPassword: c.askAgainForPassword, askAgainForEmail: c.askAgainForEmail, askAgainForDevices: c.askAgainForDevices,
    signsOutEverywhere: c.signsOutEverywhere, changedNext: c.changedNext, everywhereThen: c.everywhereThen, everywhereNext: c.everywhereNext,
    devicesLede: c.devicesLede, devicesNone: c.devicesNone, forgetHere: c.forgetHere, deviceForgotten: c.deviceForgotten,
    otherDevicesForgotten: c.otherDevicesForgotten, everyDeviceForgotten: c.everyDeviceForgotten };
}
/** The app's own sentences, for tests and pages that name one. */
export const SIGNIN_WITH_APP_COPY = WITH_APP;
