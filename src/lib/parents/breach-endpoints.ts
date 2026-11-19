/**
 * Where the breach check asks (src/lib/parents/breach-check.ts): Have I Been Pwned's public Pwned Passwords range
 * service, which takes the first five characters of a password's SHA-1 hash and answers every suffix it knows under
 * them. A function so a test can replace it (vi.mock) with a stub server, as src/lib/quickbooks/endpoints.ts is; the
 * app has no other switch.
 */
export type BreachEndpoints = { range: string };

const PWNED_PASSWORDS: BreachEndpoints = { range: "https://api.pwnedpasswords.com/range/" };

export function breachEndpoints(): BreachEndpoints { return PWNED_PASSWORDS; }
