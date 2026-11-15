/**
 * Money in the portal is integer cents. QuickBooks sends amounts as decimal numbers (85.0, 1234.56); they are converted
 * here, once, where they come in, and formatted by formatMoney() where they are shown. Nothing else does either.
 */

/** Past this many cents (about ninety trillion dollars) a JavaScript number can no longer count cents exactly. */
const MAX_CENTS = Number.MAX_SAFE_INTEGER;

/**
 * A QuickBooks amount as integer cents, or null when it isn't an amount (missing, text, not finite, too large to count).
 * A third decimal place rounds half away from zero (1.005 is 101 cents, -1.005 is -101), read from the digits as
 * written, so binary floating point never decides a cent.
 */
export function toCents(value: unknown): number | null {
  const written = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(written);
  if (!m) {
    // A number JavaScript writes with an exponent (1e-7, 1e21): too small to be a cent, or too large to count.
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) >= 1e15) return null;
    return Math.round(value * 100) || 0;
  }
  const fraction = (m[3] ?? "").padEnd(3, "0");
  const cents = Number(m[2]) * 100 + Number(fraction.slice(0, 2)) + (fraction[2]! >= "5" ? 1 : 0);
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  return m[1] === "-" && cents !== 0 ? -cents : cents;
}

/** A three-letter currency code as QuickBooks gives it in CurrencyRef, or USD when it is absent or isn't one. */
export function currencyOf(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(code) ? code : "USD";
}

/**
 * Cents as the amount a parent reads: "$1,234.56", "$0.00", "-$5.00"; another currency with its own mark ("CA$85.00").
 * Always US English, so the server and the browser agree, with two decimal places whatever the currency.
 */
export function formatMoney(cents: number, currency = "USD"): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyOf(currency), minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    // A code Intl doesn't know: the plain figure with the code, never a failed page.
    return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} ${currencyOf(currency)}`;
  }
}
