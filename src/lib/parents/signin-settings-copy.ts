// The words of a parent's sign-in settings (/family/sign-in; the sign-in release, slice SI-5a) and of asking again,
// which /family/email asks too. Plain strings, so the client forms and the actions share them. No imports but the
// door's own words: the client components use this file.
import { TOO_MANY_TRIES } from "./signin-copy";

/**
 * What a parent's authenticator app may hold after a set-up that went another way (decision 2 of SI-6b's second read):
 * said after each of the words for a set-up that is over. It never says which entry by order: an app may save them in
 * any order, and the one that works is the one from the set-up that was finished, whichever window it was in.
 */
const APP_LEFTOVERS = "Only the entry from the set-up you finished works, so you can delete the others. Can't tell them apart? Turn the app off here and set it up again.";

export const SIGNIN_SETTINGS_COPY = {
  title: "Sign-in settings",
  lede: "How you sign in to the portal, and what you can change about it.",
  howTitle: "How you sign in",
  email: "Email",
  password: "Password",
  passwordChosen: "Chosen",
  passwordNotChosen: "Not chosen yet",
  how: "You sign in with this address and your password. On a new device, we also email a code to this address.",
  /** For a person with no password yet (a session from before passwords): they stay signed in, and need one to sign in again. */
  howNoPassword: "You're signed in here, but you haven't chosen a password yet. To sign in again on any device, you'll need one.",
  changeEmail: "Change my sign-in email",
  passwordTitle: "Your password",
  noPassword: "You haven't chosen a password yet. We can email a link to choose one to the address you sign in with.",
  setupButton: "Email me a link to choose a password",
  setupBusy: "Sending…",
  askAgainForPassword: "First, show it's you: enter your password, then the code we email you.",
  askAgainForEmail: "First, show it's you: enter your password, then the code we email you.",
  choosePasswordForEmail: "Before you can change your sign-in email here, please choose a password.",
  signsOutEverywhere: "This signs you out everywhere, this device too. Then sign in with your new password, and the code we email you on each device.",
  newPassword: "New password",
  newPasswordAgain: "New password again",
  changeButton: "Change my password",
  changeBusy: "Changing…",
  changed: "Your password is changed, and you're signed out everywhere, this device too.",
  changedNext: "Sign in again with your new password. On each device you'll also enter a code we email you.",
  signIn: "Sign in",
  everywhereTitle: "Sign out everywhere",
  everywhereLede: "Lost a phone, or used a computer that isn't yours? This signs you out on every device, this one too, and forgets them all.",
  everywhereThen: "Then you sign in again with your email and password, and on each device you enter the code we email you.",
  everywhereButton: "Sign out everywhere",
  everywhereBusy: "Signing out…",
  everywhereDone: "You're signed out everywhere, this device too.",
  everywhereNext: "Sign in again with your email and password. On each device you'll also enter a code we email you.",
  /** The same, for a person with no password yet: they choose one first, from "Set up or reset my password". */
  everywhereThenNoPassword: "You haven't chosen a password yet, so to sign in again, you'll first choose one from a link we email you.",
  everywhereNextNoPassword: "To sign in again, first choose a password: we'll email you a link to choose one.",
  choosePassword: "Choose a password",
  /** The same, for a person with no password under Strict, where no link is mailed on request: only the club can help. */
  everywhereThenStrict: "You haven't chosen a password yet, and for now only the club can help you set one up. If you sign out everywhere, please ask the club to help you sign in again.",
  everywhereNextStrict: "Please ask the club to help you sign in again.",
  devicesTitle: "Remembered devices",
  // The device list (slice SI-5b): what the portal remembers, and forgetting.
  devicesLede: "Phones and computers we remember for you. On these, your password is enough, with no code from us.",
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
  askAgainForDevices: "First, show it's you: enter your password, then the code we email you.",
  choosePasswordForDevices: "To forget a device here, please choose a password first. Signing out everywhere forgets every device too.",
  deviceForgotten: "That device is forgotten. The next time you sign in on it, we'll email you a code.",
  otherDevicesForgotten: "Every other device is forgotten. The next time you sign in on one of them, we'll email you a code.",
  /** The same press when the session kept no device of the person's: every one is gone, the one in use too, if it was one. */
  everyDeviceForgotten: "Every device is forgotten. The next time you sign in on any device, this one included, we'll email you a code.",
  /** One answer for a device that isn't one of the parent's to forget, whatever the reason. */
  deviceNotFound: "That device isn't one we remember for you now. Please reload this page.",
  // The authenticator app (slice SI-6b, in place of SI-5a's words that more ways to sign in would come here): setting it up, its backup codes, making new ones, and turning it off.
  appTitle: "Authenticator app",
  appWhat: "An app like Google or Microsoft Authenticator shows a new 6-digit code every 30 seconds. Once it's set up, on a new device we ask for its code instead of emailing you one.",
  /** The same at Strict (slice SI-10b), where the app is asked for every time: in place of a passkey, not of an emailed code. */
  appWhatStrict: "An app like Google or Microsoft Authenticator shows a new 6-digit code every 30 seconds. Once it's set up, you can enter its code after your password instead of using your passkey.",
  /** Setting one up keeps the remembered devices (open question 26 lists what forgets them): said beside the device list. */
  appKeepsDevices: "Setting up an app doesn't forget the devices we remember for you.",
  appNeedsPassword: "To set up an authenticator app, please choose a password first.",
  askAgainForApp: "First, show it's you: enter your password, then the code we email you.",
  askAgainForPasskeys: "First, show it's you: enter your password, then the code we email you.",
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
  appSetupLost: "Please finish within 10 minutes of showing it's you. You can switch to your app and back. If you reload or run out of time, you'll start over with a new QR code, so delete the entry your app just saved.",
  appSetupWrong: "That code didn't work. Check that it's the newest code the app shows for this portal, and try again.",
  /** The set-up ran out (or there is none): the box goes back to its set-up press. */
  appSetupGone: `That set-up has run out, so nothing was kept. Press "Set up an authenticator app" to start again. ${APP_LEFTOVERS}`,
  /** Another window began a newer set-up since this page's: the box goes back to its set-up press. */
  appSetupReplaced: `You started a newer set-up in another window. Finish it there, or start again here. ${APP_LEFTOVERS}`,
  /** The 10 minutes since the proof ran out before the set-up was finished: the box goes back to its set-up press. */
  appSetupTimedOut: "More than 10 minutes have passed since you showed it's you, so nothing was kept. Delete this portal's entry from your app, then reload this page and start again.",
  /** An app is in force already, finished in another window (or by the other of two presses at once): the page is drawn again with the app on. */
  appSetupDoneElsewhere: `Your authenticator app is already set up, from another window. ${APP_LEFTOVERS}`,
  appAlreadyOn: "You already have an authenticator app set up. Please reload this page.",
  appNotOn: "You don't have an authenticator app set up right now. Please reload this page.",
  appOn: "Your authenticator app is set up.",
  appOnSince: "Set up",
  backupCodesTitle: "Your backup codes",
  backupCodesKeep: "Each code works once, in place of a code from your app. If you lose your phone, they're how you get in, so keep them safe somewhere else, like on paper. We won't show them again.",
  copyCodes: "Copy the backup codes",
  backupCodesLeft: "Backup codes left",
  backupCodesNone: "You've used all your backup codes. Make new ones now, while your app still works.",
  askAgainForAppChange: "First, show it's you: enter your password, then the code from your authenticator app.",
  newCodes: "Make new backup codes",
  newCodesBusy: "Making…",
  newCodesMade: "Here are your new backup codes. Your old ones no longer work.",
  turnOffWords: "If you turn off your authenticator app, your backup codes stop working too, and when you sign in on a new device, we'll email you a code again.",
  turnOff: "Turn off the authenticator app",
  turnOffBusy: "Turning off…",
  turnedOff: "Your authenticator app is turned off, and your backup codes no longer work. When you sign in on a new device, we'll email you a code again.",
  /** Under Strict the app stays while it is the guardian's only second step (open question 33): add a passkey first. */
  turnOffStrict: "The club asks everyone for a second step, so you can't turn off your app while it's your only one. Add a passkey first.",
  /** Turning the app off beside a passkey (slice SI-7b): the backup codes stay, and the passkey is the second step. */
  turnOffWordsBesidePasskey: "If you turn off your app, your passkey stays your second step, and your backup codes keep working in its place.",
  turnedOffBesidePasskey: "Your authenticator app is off. Your passkey is still your second step, and your backup codes still work in its place.",
  // Passkeys (slice SI-7b): adding, naming, listing and removing them, and their backup codes.
  passkeysTitle: "Passkeys",
  passkeysWhat: "A passkey signs you in with your face, fingerprint or PIN instead of a password. You can add one on each phone, computer, password manager or security key you use.",
  passkeysNone: "You haven't added a passkey yet.",
  passkeyNeedsPassword: "To add a passkey, please choose a password first.",
  passkeysUnsupported: "This browser can't add a passkey. Try another browser, or another phone or computer.",
  passkeyName: "A name for it (optional)",
  passkeyNameHelp: "Something to tell it apart later, like “Sam's iPhone” or “Bitwarden”. Up to 50 characters.",
  passkeyAdd: "Add a passkey",
  passkeyAddBusy: "Adding…",
  passkeyAdded: "Your passkey is added. You can sign in with it now.",
  passkeyCancelled: "The passkey wasn't added. You can try again whenever you like.",
  passkeyRejected: "That passkey couldn't be added. Please try again.",
  passkeyAlready: "That passkey is already added here.",
  /** The browser or password manager refused to make a second passkey for this account, as it holds one already (slice SI-7b). */
  passkeyAlreadyHeld: "This phone, computer or password manager already has one of your passkeys for this portal. To add another, use a different one.",
  /** A passkey listed with no name of its own: these words, then the day it was added. */
  passkeyNoName: "Passkey added",
  passkeyAddedOn: "Added",
  passkeyLastUsed: "Last used",
  passkeyNotUsed: "Not used yet",
  passkeyRename: "Rename",
  passkeyRenameLabel: "New name",
  passkeyRenameSave: "Save the name",
  passkeyRenameBusy: "Saving…",
  passkeyRenameCancel: "Cancel",
  passkeyRenamed: "The passkey's name is saved.",
  passkeyNameBad: "Please use a name of up to 50 characters, on one line.",
  passkeyRemove: "Remove",
  passkeyRemoveBusy: "Removing…",
  passkeyRemoved: "That passkey is removed. If your phone or computer still offers it, it won't work here any more.",
  /** Before the press, beside the last passkey (open question 33), at Standard. */
  passkeyRemoveLastWords: "This is your only passkey. If you remove it, your backup codes stop working too, and when you sign in on a new device, we'll email you a code again.",
  passkeyRemoveLastAppWords: "This is your only passkey. If you remove it, when you sign in on a new device, we'll ask for the code from your authenticator app.",
  passkeyRemovedLast: "That passkey is removed, and your backup codes no longer work. When you sign in on a new device, we'll email you a code again.",
  passkeyRemovedLastApp: "That passkey is removed. When you sign in on a new device, we'll ask for the code from your authenticator app.",
  /**
   * The same two beside an app, at Strict (slice SI-10b): no remembered device stands in for a step there
   * (checkPasswordSignin()), so the app's code is asked at every sign-in.
   */
  passkeyRemoveLastAppWordsStrict: "This is your only passkey. If you remove it, each time you sign in we'll ask for your password and then the code from your authenticator app.",
  passkeyRemovedLastAppStrict: "That passkey is removed. Each time you sign in, we'll ask for your password and then the code from your authenticator app.",
  /** Under Strict the last second factor stays (open question 33): add another first. */
  passkeyRemoveStrict: "The club asks everyone for a second step, so you can't remove your only one. Add another passkey or an authenticator app first.",
  passkeyNotFound: "That passkey isn't one of yours now. Please reload this page.",
  /** The backup codes made with a first passkey of a guardian with no app (open question 25). */
  passkeyCodesMade: "Your passkey is added, and here are your backup codes.",
  /**
   * Beside a passkey and no app (open question 25): what the codes do. They are taken in place of the passkey at the
   * sign-in page's passkey step (its backup-code field, offered while the person holds unspent ones) and when this page
   * asks again, so they are the way in when the passkey's device is lost.
   */
  backupCodesKeepPasskey: "Each code works once, in place of your passkey, when you sign in or when this page checks it's you. If you lose the device with your passkey, they're how you get in, so keep them safe somewhere else, like on paper. We won't show them again.",
  /**
   * Under Strict, wherever this page shows new backup codes (open question 25; slice SI-10b): a press under the box's
   * "I've saved my backup codes somewhere safe" (ENROLMENT_COPY.saved) that puts them away, and what the box says then.
   */
  codesDone: "Done",
  codesPutAway: "Your backup codes aren't shown here any more. We won't show them again.",
  // Asking again with a passkey (slice SI-7b): the passkey alone, or the password and then the second step.
  usePasskey: "Use your passkey",
  orPassword: "Or enter your password",
  passkeyAsked: "Now use your passkey to go on. Your phone or computer will ask for your face, fingerprint or PIN.",
  passkeyOrAppAsked: "Now use your passkey to go on. Or enter the 6-digit code from your authenticator app, or one of your backup codes.",
  /** Beside a passkey with no app, for a parent who holds unspent backup codes (slice SI-7b). */
  passkeyOrBackupAsked: "Now use your passkey to go on. If you don't have it with you, enter one of your backup codes instead.",
  backupCode: "Backup code",
  passkeyAgainCancelled: "Your passkey wasn't used. You can try it again, or enter your password.",
  passkeyAgainRejected: "That passkey didn't work. You can try it again, or enter your password.",
  // Asking again (asking-again.ts): the password, then the emailed code.
  yourPassword: "Your password",
  continue: "Continue",
  checking: "Checking…",
  codeSent: "Enter the 6-digit code we've emailed you to go on. It can take a minute, so check your spam folder too.",
  code: "6-digit code",
  /** Asking again of a guardian with an authenticator app (slice SI-6a): nothing is emailed; the app's code or a backup code. */
  appAsked: "Enter the 6-digit code from your authenticator app to go on, or a backup code if your phone isn't with you.",
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
  /**
   * The change asked with no proof that counts: the 10 minutes ran out, the page was drawn before asking again, or
   * (slice SI-6b's second read) the proof was made before an authenticator app was set up, in this window or another.
   * It names no reason, since the 10 minutes may not have run out. The page is drawn again with the asking.
   */
  proveAgain: "We need you to show it's you again before this change. Please reload this page and do that first.",
  tooManyChanges: "You've tried to change your password a few times in the last hour. Please wait a little while before trying again.",
  tooManyPresses: "You've pressed this a few times in the last hour. Please wait a little while before trying again.",
  /** When the action itself couldn't be reached or threw: try again, nothing about why. */
  failed: "That didn't go through. Please try again in a moment.",
} as const;

/** Said in place of "Add a passkey" when the page was reached at an address other than APP_URL's origin (slice SI-7b). */
export const passkeysAddedOnlyAt = (origin: string) => `Passkeys can be added only at ${origin}. Go there to add one.`;

/**
 * The sentences that say how the parent signs in on a new device, for a guardian with an authenticator app in force
 * (slice SI-6b): the code from their app, where the others say the code we email. Each replaces the same key of
 * SIGNIN_SETTINGS_COPY, through howYouSignIn(), so a page or form picks one by whether the person has an app (MySignin.app).
 */
const WITH_APP = {
  how: "You sign in with this address and your password. On a new device, we also ask for the code from your authenticator app, or one of your backup codes.",
  askAgainForPassword: "First, show it's you: enter your password, then the code from your authenticator app.",
  askAgainForEmail: "First, show it's you: enter your password, then the code from your authenticator app.",
  askAgainForDevices: "First, show it's you: enter your password, then the code from your authenticator app.",
  signsOutEverywhere: "This signs you out everywhere, this device too. Then sign in with your new password, and the code from your authenticator app on each device.",
  changedNext: "Sign in again with your new password. On each device you'll also enter the code from your authenticator app.",
  everywhereThen: "Then you sign in again with your email and password, and on each device you enter the code from your authenticator app.",
  everywhereNext: "Sign in again with your email and password. On each device you'll also enter the code from your authenticator app.",
  devicesLede: "Phones and computers we remember for you. On these, your password is enough, with no code from your authenticator app.",
  devicesNone: "We don't remember any device for you right now. The next time you sign in, we'll also ask for the code from your authenticator app, and then remember that device.",
  forgetHere: "Forgetting the device you're using now doesn't sign you out here. The next time you sign in on it, we'll ask for the code from your authenticator app again.",
  deviceForgotten: "That device is forgotten. The next time you sign in on it, we'll ask for the code from your authenticator app.",
  otherDevicesForgotten: "Every other device is forgotten. The next time you sign in on one of them, we'll ask for the code from your authenticator app.",
  everyDeviceForgotten: "Every device is forgotten. The next time you sign in on any device, this one included, we'll ask for the code from your authenticator app.",
  askAgainForApp: SIGNIN_SETTINGS_COPY.askAgainForApp,
  askAgainForAppChange: SIGNIN_SETTINGS_COPY.askAgainForAppChange,
  askAgainForPasskeys: "First, show it's you: enter your password, then the code from your authenticator app.",
} as const;

/**
 * The same sentences for a guardian with a passkey (slice SI-7b): they sign in with it alone, or after their password
 * on a device we don't know yet, and are asked again with it (or, beside an app, the password and the app's code).
 * `second` names what the password is followed by: the passkey, or, beside an app, the passkey or the app's code.
 */
function withPasskey(app: boolean): HowWords {
  const second = app ? "your passkey or the code from your authenticator app" : "your passkey";
  const prove = app ? "with your passkey, or enter your password and then the code from your authenticator app" : "with your passkey";
  return {
    how: `You can sign in with just your passkey. If you use your email and password on a new device, we also ask for ${second}.`,
    askAgainForPassword: `First, show it's you ${prove}.`,
    askAgainForEmail: `First, show it's you ${prove}.`,
    askAgainForDevices: `First, show it's you ${prove}.`,
    signsOutEverywhere: `This signs you out everywhere, this device too. Then sign in again with your passkey, or with your new password and then ${second}.`,
    changedNext: `Sign in again with your passkey, or with your new password and then ${second}.`,
    everywhereThen: `Then you sign in again with your passkey, or with your email and password and then ${second}.`,
    everywhereNext: `Sign in again with your passkey, or with your email and password and then ${second}.`,
    devicesLede: `Phones and computers we remember for you. On these, your password is enough, without ${second}.`,
    devicesNone: `We don't remember any device for you right now. The next time you sign in with your password, we'll also ask for ${second}, and then remember that device.`,
    forgetHere: `Forgetting the device you're using now doesn't sign you out here. The next time you sign in on it with your password, we'll ask for ${second} again.`,
    deviceForgotten: `That device is forgotten. The next time you sign in on it with your password, we'll ask for ${second}.`,
    otherDevicesForgotten: `Every other device is forgotten. The next time you sign in on one of them with your password, we'll ask for ${second}.`,
    everyDeviceForgotten: `Every device is forgotten. The next time you sign in with your password on any device, this one included, we'll ask for ${second}.`,
    askAgainForApp: `First, show it's you ${prove}.`,
    askAgainForAppChange: `First, show it's you ${prove}.`,
    askAgainForPasskeys: `First, show it's you ${prove}.`,
  };
}

// Under Strict a remembered device asks for the second step too (password-signin.ts: no device stands in for a step
// there), so since slice SI-10b `how`, `devicesLede` and their kin are Strict's own for a person with a factor
// (strictWords()), picked by the level beside the factors; every other key is the factor's own, true at either level.
// Outside these keys, the last passkey's words beside an app have Strict versions of their own
// (passkeyRemoveLastAppWordsStrict, passkeyRemovedLastAppStrict).
export type HowWords = { [K in keyof typeof WITH_APP]: string };
/**
 * What the person has of their own, for the words: an authenticator app in force, and (since slice SI-7b) a passkey;
 * and (since slice SI-10b) whether the club is at Strict.
 */
export type Factors = { app: boolean; passkey: boolean; strict: boolean };

/**
 * The keys that say what a remembered device spares, at Strict, where it spares nothing (slice SI-10b). `second` names
 * what follows the password, as withPasskey() names it, or, with the app alone, the app's code.
 */
function strictWords(f: Factors, words: HowWords): HowWords {
  const second = f.passkey ? (f.app ? "your passkey or the code from your authenticator app" : "your passkey") : "the code from your authenticator app";
  return {
    ...words,
    how: f.passkey ? `You can sign in with just your passkey. If you use your email and password, we also ask for ${second} every time, on every phone or computer.`
      : "You sign in with this address and your password, and then the code from your authenticator app or one of your backup codes, every time, on every phone or computer.",
    devicesLede: `Phones and computers we remember for you. The club asks for a second step every time, so here too we ask for ${second} after your password.`,
    devicesNone: `We don't remember any device for you right now. Wherever you sign in with your password, we ask for ${second} too.`,
    forgetHere: "Forgetting the device you're using now doesn't sign you out here, and doesn't change how you sign in on it.",
    deviceForgotten: "That device is forgotten. You sign in on it the same way as before.",
    otherDevicesForgotten: "Every other device is forgotten. You sign in on them the same way as before.",
    everyDeviceForgotten: "Every device is forgotten, this one included. You sign in on each of them the same way as before.",
  };
}

/**
 * The sentences of how the parent signs in on a new device and is asked again: a passkey holder's (with the app beside
 * it when they have one, slice SI-7b), the app's for a guardian with one in force, the emailed code's otherwise; at
 * Strict, for a person with a factor, with Strict's words of what a device spares (strictWords()). At Strict with no
 * factor (which the gate makes unreachable: such a session is signed out or enrolling) Standard's words.
 */
export function howYouSignIn(f: Factors): HowWords {
  if (f.strict && (f.passkey || f.app)) return strictWords(f, howYouSignIn({ ...f, strict: false }));
  if (f.passkey) return withPasskey(f.app);
  if (f.app) return WITH_APP;
  const c = SIGNIN_SETTINGS_COPY;
  return { how: c.how, askAgainForPassword: c.askAgainForPassword, askAgainForEmail: c.askAgainForEmail, askAgainForDevices: c.askAgainForDevices,
    signsOutEverywhere: c.signsOutEverywhere, changedNext: c.changedNext, everywhereThen: c.everywhereThen, everywhereNext: c.everywhereNext,
    devicesLede: c.devicesLede, devicesNone: c.devicesNone, forgetHere: c.forgetHere, deviceForgotten: c.deviceForgotten,
    otherDevicesForgotten: c.otherDevicesForgotten, everyDeviceForgotten: c.everyDeviceForgotten,
    askAgainForApp: c.askAgainForApp, askAgainForAppChange: c.askAgainForAppChange, askAgainForPasskeys: c.askAgainForPasskeys };
}
/** The app's own sentences, for tests and pages that name one. */
export const SIGNIN_WITH_APP_COPY = WITH_APP;
