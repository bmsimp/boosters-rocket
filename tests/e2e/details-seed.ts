/**
 * Zelda's phone and mailing address as scripts/seed-e2e.ts stores them on her person row (stage 3's slice 11a: the
 * portal's own), shared by the seed and the specs that read or change them. tests/e2e/family-details.spec.ts changes
 * them and puts them back, so both passes of a run read the seed as it was.
 */
export const E2E_DETAILS = {
  phone: "505-555-0142", line1: "7 Quetzal Mesa Road", line2: "", city: "Albuquerque", region: "NM", postalCode: "87104", country: "",
} as const;
