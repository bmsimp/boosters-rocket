import { createHash } from "node:crypto";

/**
 * The changes of sign-in address scripts/seed-e2e.ts seeds for Zelda (src/lib/parents/email-change.ts), with fixed
 * tokens, so the specs can open their links (PARAMS in tests/e2e/parent-params.ts; tests/e2e/family-email.spec.ts
 * puts the first back as it was after asking for a change of its own).
 */
export const E2E_EMAIL = {
  /** Asked under her link to the Quetzalcoatl family, for her own record there (E2E-P1), and not opened yet. */
  own: { token: "e2e-own-email-change-token".padEnd(43, "0"), newEmail: "zelda.newmail@e2e-moving.example" },
  /** Asked under her link to the second family, and used: nothing of it is shown in the Quetzalcoatl family. */
  other: { token: "e2e-other-email-change-token".padEnd(43, "0"), newEmail: "zelda.secondfamily@second-moving.example" },
} as const;

/** How the portal stores a token: its SHA-256, in hex. */
export const emailTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
