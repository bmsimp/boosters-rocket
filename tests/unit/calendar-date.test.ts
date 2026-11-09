import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { formatCalendarDate } from "@/app/components/calendar-date-format";

describe("formatCalendarDate", () => {
  const was = process.env.TZ;
  beforeAll(() => { process.env.TZ = "America/Chicago"; });
  afterAll(() => { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; });

  it("shows an expiry date as that calendar day, not the day before, in a zone behind UTC", () => {
    expect(new Date("2028-11-08T00:00:00Z").getDate()).toBe(7); // viewer-local would be wrong for a date
    const text = formatCalendarDate("2028-11-08T00:00:00Z");
    expect(text).toContain("8");
    expect(text).toContain("2028");
    expect(text).not.toContain("7");
  });
});
