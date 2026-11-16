/**
 * The portal's own address is set by whoever installs it (APP_URL, src/env.ts): no host name is written into the code.
 * Sign-in, the links in emails, the QuickBooks return address and the installed app are all built on it, so a portal
 * that people reach under one address while it believes another sends them to the wrong place. These two functions
 * compare the two; the comparing is done in the browser (src/app/components/address-check.tsx), the only place that
 * knows which address was really typed.
 */

/** An address as scheme, host and port ("https://portal.yourclub.org"), or null when it isn't an http or https address. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch { return null; }
}

/** True when the browser reached the portal at the address the portal believes it has. */
export function sameAddress(appUrl: string, browserOrigin: string): boolean {
  const believed = originOf(appUrl), reached = originOf(browserOrigin);
  return believed !== null && believed === reached;
}
