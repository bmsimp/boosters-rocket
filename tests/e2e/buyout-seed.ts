/**
 * The volunteer requirements with a buy-out that scripts/seed-e2e.ts seeds (v1 spec §11.5): fixed ids, so the specs can
 * ask for their pages. Every customer id in the seed is not digits, so a buy-out confirmed in the browser run is
 * refused before anything is sent (tests/e2e/family-details.spec.ts checks the ids).
 */
export const E2E_BUYOUT = {
  /** "Pit crew hours": 2 hours each family, $12.50 an hour instead: the Quetzalcoatl family has chosen nothing, so it is offered at $25.00. */
  offered: "8d2e3f1a-6f3f-4000-8000-00000000b0b1",
  offeredAmount: "$25.00",
  /**
   * "Concession help": 2 shifts, $50.00 a shift instead: the Quetzalcoatl family's buy-out is invoiced, and its invoice
   * is QZ-1042, one of the two the Payments spec already counts (so no total in any spec changes).
   */
  invoiced: "8d2e3f1a-6f3f-4000-8000-00000000b0b2",
  invoicedAmount: "$100.00",
  invoiceNumber: "QZ-1042",
  /** The buy-out row of "Concession help". */
  buyout: "8d2e3f1a-6f3f-4000-8000-00000000b0b3",
  /** "Rivera trailer shifts": asked of the Rivera family alone, with a buy-out offered. */
  other: "8d2e3f1a-6f3f-4000-8000-00000000b0b4",
} as const;
