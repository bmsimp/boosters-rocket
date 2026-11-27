import type postgres from "postgres";
import { BULK, seedBulk } from "./bulk-seed";

/**
 * What the Accounting links checks (tests/e2e/links.spec.ts, and its pictures in screenshots.spec.ts) add to the seed
 * for their own test, and take away after it: the bulk seed's two (The Bulkleys, Suggested by email, with a phone on
 * each side so Show details has something to compare; Brightwater Family, with no family), a second Suggested family
 * (The Ostranders, on Ostrander Family) so two rows can be ticked, and a family nothing matches (The Nakamuras), whose
 * row offers Pick a customer. Nothing here is linked, and nothing is sent to QuickBooks.
 */
export const LINKS = { ...BULK, phone: "(555) 201-4410", booksPhone: "555-201-4400", other: "The Ostranders", otherName: "Ostrander Family", otherId: "7000003",
  otherEmail: "ostrander@example.org", nomatch: "The Nakamuras", nomatchEmail: "nakamura@example.org" } as const;

export async function seedLinks(sql: postgres.Sql): Promise<{ drop: () => Promise<void> }> {
  const bulk = await seedBulk(sql);
  await sql`UPDATE parent SET phone = ${LINKS.phone} WHERE email = ${LINKS.email}`;
  await sql`UPDATE qbo_customer SET phone = ${LINKS.booksPhone} WHERE qbo_id = ${LINKS.linkId}`;
  await sql`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, email, phone, sync_token)
            VALUES (${LINKS.otherId}, ${LINKS.otherName}, true, null, 'E2E-T1', ${LINKS.otherEmail}, null, '0')`;
  const families: string[] = [];
  const parents: string[] = [];
  for (const [name, who, email] of [[LINKS.other, "Olga Ostrander", LINKS.otherEmail], [LINKS.nomatch, "Ken Nakamura", LINKS.nomatchEmail]] as const) {
    const [f] = await sql`INSERT INTO family (name, active) VALUES (${name}, true) RETURNING id`;
    const [p] = await sql`INSERT INTO parent (name, email) VALUES (${who}, ${email}) RETURNING id`;
    await sql`INSERT INTO guardian (family_id, parent_id, is_primary, status) VALUES (${f!.id}, ${p!.id}, true, 'invited')`;
    families.push(f!.id as string); parents.push(p!.id as string);
  }
  return {
    drop: async () => {
      await sql`DELETE FROM accounting_link WHERE customer_id = ${LINKS.otherId} OR family_id IN ${sql(families)}`;
      await sql`DELETE FROM guardian WHERE parent_id IN ${sql(parents)}`;
      await sql`DELETE FROM parent WHERE id IN ${sql(parents)}`;
      await sql`DELETE FROM family WHERE id IN ${sql(families)}`;
      await sql`DELETE FROM qbo_customer WHERE qbo_id = ${LINKS.otherId}`;
      await bulk.drop();
    },
  };
}
