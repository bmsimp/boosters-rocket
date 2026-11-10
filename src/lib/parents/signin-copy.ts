// The sign-in page's fixed sentences (spec §1). No imports: the client component uses this file.
export const CODE_SENT = "If this email belongs to a family in the club, we've sent a 6-digit code. It can take a minute. Check your spam folder too.";
/** One answer for a wrong, expired, used-up or never-sent code, so the code screen can't tell anyone whether an address is on file. */
export const CODE_REJECTED = "That code didn't work. Check the newest email from us, or request a new code.";
export const TOO_MANY_TRIES = "Too many tries. Wait a few minutes and request a new code.";
export const SIGNIN_UNAVAILABLE = "Parent sign-in isn't available yet.";
export const SIGNIN_NETWORK_FAILED = "We couldn't reach the portal just then. Please try again in a moment.";
