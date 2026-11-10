import { createHash } from "node:crypto";
import type { StoredMailConfig } from "./types";

/** Identifies exactly these settings. A test send records it; any change to the settings changes it. */
export function mailConfigHash(c: StoredMailConfig): string {
  const sorted = Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
