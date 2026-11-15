/**
 * The only address a Pay button may open: QuickBooks' own hosted payment page (v1 spec §8.2). `InvoiceLink` arrives
 * from QuickBooks as text, so it is trusted only when it parses as a URL, is https, carries no user name or password,
 * and its host is intuit.com or ends with .intuit.com. Anything else (javascript:, data:, http:, another host, a host
 * that merely contains "intuit.com") gives null: no button, and no error.
 */
export function safePayLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 2000) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, ""); // "connect.intuit.com." is the same host
  if (host !== "intuit.com" && !host.endsWith(".intuit.com")) return null;
  return url.href;
}
