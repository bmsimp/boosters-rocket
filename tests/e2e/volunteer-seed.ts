/** The volunteer event scripts/seed-e2e.ts seeds, and its two shifts: fixed ids, so the specs can ask for them. */
export const E2E_VOLUNTEER = {
  event: "7c1d2f0e-5e2e-4000-8000-00000000e2e0",
  /** 7:00 to 9:00 am, four places, one taken by the Rivera family's Leo. */
  griddle: "7c1d2f0e-5e2e-4000-8000-00000000e2e1",
  /** 9:00 to 11:00 am, two places, none taken. */
  cleanup: "7c1d2f0e-5e2e-4000-8000-00000000e2e2",
  /** The griddle's check-in code: a shift where only another family has a place. */
  griddleCode: "e2eGriddleCheckInCode00000000000001",
  /**
   * "Concession stand", worked out when the seed runs so that its check-in window is open for hours: it started an hour
   * before the seed and ends four hours after it. Zelda has a place on it.
   */
  openEvent: "7c1d2f0e-5e2e-4000-8000-00000000e2e3",
  openShift: "7c1d2f0e-5e2e-4000-8000-00000000e2e4",
  openCode: "e2eOpenCheckInCode0000000000000001",
  /** "Car wash", yesterday 10:00 to 11:00 am: over, so its check-in has closed. Zelda had a place on it. */
  closedEvent: "7c1d2f0e-5e2e-4000-8000-00000000e2e5",
  closedShift: "7c1d2f0e-5e2e-4000-8000-00000000e2e6",
  closedCode: "e2eClosedCheckInCode00000000000001",
} as const;
