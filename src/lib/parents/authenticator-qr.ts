// The QR code of an authenticator app's set-up (the sign-in release, slice SI-6b; Appendix A of the app-owned families
// spec: "a QR code drawn on the server with the `qrcode` package the check-in sheet uses, never by an outside service").
// The text it encodes is the standard key URI apps read, which holds the secret: it is built and drawn here, on the
// server, and only the drawing's squares leave, in the set-up's one answer (startMyAuthenticator(),
// authenticator-settings.ts); the URI itself is never sent, logged or audited. Server only; parent code.
import "server-only";
import QRCode from "qrcode";
import { TOTP_DIGITS, TOTP_STEP_SECONDS } from "./totp";

/**
 * A QR code as the browser draws it: the side of its square in modules, the four-module quiet zone included, and one SVG
 * path of the dark modules, each a unit square, drawn black on white (AuthenticatorBox, signin-forms.tsx), as the
 * check-in sheet draws its own (src/app/staff/(app)/volunteer/qr-code.tsx).
 */
export type QrSquares = { size: number; path: string };

/** The quiet zone scanners need around a code, in modules. */
const QUIET = 4;

/** The squares of a QR code of `text`, from the package's matrix (QRCode.create(), error correction M). */
export function qrSquares(text: string): QrSquares {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const squares: string[] = [];
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) if (modules.get(row, col)) squares.push(`M${col + QUIET} ${row + QUIET}h1v1h-1z`);
  }
  return { size: modules.size + QUIET * 2, path: squares.join("") };
}

/**
 * The key URI an authenticator app reads (the "otpauth" form every app takes): `otpauth://totp/<label>?secret=…`, the
 * label the club's name and the person's own sign-in address, the issuer the club's name, each URI-encoded, with the
 * portal's code: SHA-1, six digits, 30-second steps (totp.ts).
 */
export function authenticatorKeyUri(clubName: string, email: string, secretBase32: string): string {
  const label = `${encodeURIComponent(clubName)}:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(clubName)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
