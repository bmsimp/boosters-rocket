import postgres from "postgres";

/**
 * A family's staff pages are addressed by the app's own family record (stage 3 of the app-owned families spec), whose
 * id the seed doesn't fix: scripts/seed-e2e.ts runs migration 0023's fill, which makes the records with new ids on
 * every seed. So a spec finds the record by the customer it seeded: the one that customer's family link names in the
 * roster's company. Both passes of a run (phone, then desktop) read one seed, so each id is read once per worker.
 */
const known = new Map<string, Promise<string>>();

export function familyIdOf(customerId: string): Promise<string> {
  let found = known.get(customerId);
  if (!found) {
    found = read(customerId);
    known.set(customerId, found);
    found.catch(() => known.delete(customerId));
  }
  return found;
}

async function read(customerId: string): Promise<string> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const [row] = await sql`SELECT family_id::text AS id FROM accounting_link
      WHERE system = 'quickbooks' AND customer_id = ${customerId} AND family_id IS NOT NULL
        AND realm_id = (SELECT value->>'realmId' FROM setting WHERE key = 'roster.source')`;
    if (!row) throw new Error(`the seed has no family record for the customer ${customerId}: seed again (pnpm tsx scripts/seed-e2e.ts)`);
    return row.id as string;
  } finally {
    await sql.end();
  }
}

/** The addresses of a seeded family's staff pages, by the customer the seed gave it. */
export const familyPages = {
  roster: async (customerId: string) => `/staff/roster/${await familyIdOf(customerId)}`,
  buyouts: async (customerId: string) => `/staff/roster/${await familyIdOf(customerId)}/buyouts`,
  balance: async (customerId: string) => `/staff/balances/${await familyIdOf(customerId)}`,
  progress: async (customerId: string) => `/staff/seasons/progress/family/${await familyIdOf(customerId)}`,
  credit: async (customerId: string) => `/staff/volunteer/credit/${await familyIdOf(customerId)}`,
};
