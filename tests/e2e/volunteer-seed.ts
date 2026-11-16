/** The volunteer event scripts/seed-e2e.ts seeds, and its two shifts: fixed ids, so the specs can ask for them. */
export const E2E_VOLUNTEER = {
  event: "7c1d2f0e-5e2e-4000-8000-00000000e2e0",
  /** 7:00 to 9:00 am, four places, one taken by the Rivera family's Leo. */
  griddle: "7c1d2f0e-5e2e-4000-8000-00000000e2e1",
  /** 9:00 to 11:00 am, two places, none taken. */
  cleanup: "7c1d2f0e-5e2e-4000-8000-00000000e2e2",
} as const;
