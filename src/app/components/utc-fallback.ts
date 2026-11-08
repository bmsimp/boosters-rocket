/** Server-safe text for a timestamp before the browser knows the viewer's zone, e.g. "2026-11-08 17:27 UTC". */
export function utcFallback(iso: string): string {
  return iso.replace("T", " ").slice(0, 16) + " UTC";
}
