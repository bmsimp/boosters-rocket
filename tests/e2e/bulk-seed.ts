import type postgres from "postgres";

/**
 * What the bulk actions' browser checks add to the seed for their own test, and take away after it, so both passes of
 * the run (phone, then desktop) and every other spec find scripts/seed-e2e.ts's data as it was: a family with no link,
 * The Bulkleys, whose guardian's sign-in address is on Bulkley Family (so Accounting links suggests it), and Brightwater
 * Family, a family customer no family is linked to (so "Create a family from this" offers it). A link and a family made
 * need a customer id of digits (isQboId()); both are removed in `drop()`, so tests/e2e/family-details.spec.ts still finds
 * none. Linking and making a family send nothing to QuickBooks, and no page these checks open reads money.
 */
export const BULK = { linkId: "7000001", makeId: "7000002", family: "The Bulkleys", linkName: "Bulkley Family", makeName: "Brightwater Family", email: "bulkley@example.org" } as const;

export async function seedBulk(sql: postgres.Sql): Promise<{ drop: () => Promise<void> }> {
  await sql`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, email, phone, sync_token) VALUES
          (${BULK.linkId}, ${BULK.linkName}, true, null, 'E2E-T1', ${BULK.email}, null, '0'),
          (${BULK.makeId}, ${BULK.makeName}, true, null, 'E2E-T1', null, null, '0')`;
  const [f] = await sql`INSERT INTO family (name, active) VALUES (${BULK.family}, true) RETURNING id`;
  const [p] = await sql`INSERT INTO parent (name, email) VALUES ('Bea Bulkley', ${BULK.email}) RETURNING id`;
  await sql`INSERT INTO guardian (family_id, parent_id, is_primary, status) VALUES (${f!.id}, ${p!.id}, true, 'invited')`;
  return {
    drop: async () => {
      const made = (await sql`SELECT family_id FROM accounting_link WHERE customer_id IN (${BULK.linkId}, ${BULK.makeId}) AND family_id IS NOT NULL`).map((r) => r.family_id as string);
      await sql`DELETE FROM accounting_link WHERE customer_id IN (${BULK.linkId}, ${BULK.makeId})`;
      await sql`DELETE FROM guardian WHERE parent_id = ${p!.id}`;
      await sql`DELETE FROM parent WHERE id = ${p!.id}`;
      await sql`DELETE FROM family WHERE id IN ${sql([f!.id as string, ...made])}`;
      await sql`DELETE FROM qbo_customer WHERE qbo_id IN (${BULK.linkId}, ${BULK.makeId})`;
    },
  };
}
