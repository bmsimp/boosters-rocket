// A guardian's name and address as the portal takes them: pure, with no database import, so the import's proposer
// (src/lib/accounting/import-proposals.ts, stage 4's slice M6) works them out by the same rule the add does
// (./guardians.ts, which exports them on).
import { normalizeEmail } from "@/lib/email";

/** The longest name staff may give a person, and the longest address the portal reads. */
export const PERSON_NAME_MAX = 100;
export const EMAIL_MAX = 320;

/** A person's name as staff typed it, trimmed, with its spaces closed up: 1 to 100 characters, none a control character. */
export function personName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= PERSON_NAME_MAX && !/\p{Cc}/u.test(name) ? name : null;
}

/** The address staff typed, by the portal's own rule (normalizeEmail(): trimmed, lower-cased, a valid address). */
export const guardianEmail = (raw: string): string | null => (raw.length <= EMAIL_MAX ? normalizeEmail(raw) : null);
