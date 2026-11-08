/** Compact text for an audit row's before/after, or null when both are empty. Plain text; the caller renders it as text. */
export function formatAuditDetails(before: unknown, after: unknown): string | null {
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;
  if (!hasBefore && !hasAfter) return null;
  if (hasBefore && hasAfter) return `${JSON.stringify(before)} → ${JSON.stringify(after)}`;
  return JSON.stringify(hasBefore ? before : after);
}
