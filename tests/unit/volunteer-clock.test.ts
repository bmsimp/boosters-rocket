import { describe, it, expect } from "vitest";
import {
  beforeCutoff, clockWords, dateWords, endsNextDay, hoursWords, instantWords, isClockTime, nextDay, shiftInstants, shiftMinutes, shiftTimeWords, wallTimeToInstant,
} from "@/lib/volunteer/clock";

/** Volunteer time: an event's date and a shift's times are the club's wall clock, read in the club's time zone. */
describe("wallTimeToInstant", () => {
  it("reads a wall-clock time in the club's zone, whatever zone the server is in", () => {
    expect(wallTimeToInstant("2027-03-01", "18:00", "UTC").toISOString()).toBe("2027-03-01T18:00:00.000Z");
    expect(wallTimeToInstant("2027-03-01", "18:00", "America/Chicago").toISOString()).toBe("2027-03-02T00:00:00.000Z"); // CST, UTC-6
    expect(wallTimeToInstant("2027-07-01", "18:00", "America/Chicago").toISOString()).toBe("2027-07-01T23:00:00.000Z"); // CDT, UTC-5
    expect(wallTimeToInstant("2027-03-01", "09:30", "Asia/Kolkata").toISOString()).toBe("2027-03-01T04:00:00.000Z");
  });

  it("puts the same wall time a whole day apart in the two zones that never share a calendar day", () => {
    const kiritimati = wallTimeToInstant("2027-03-01", "10:00", "Pacific/Kiritimati"), pagoPago = wallTimeToInstant("2027-03-01", "10:00", "Pacific/Pago_Pago");
    expect((pagoPago.getTime() - kiritimati.getTime()) / 3_600_000).toBe(25);
  });

  it("on the night the clocks go forward, reads a time that never happens as the same minutes past the jump", () => {
    // America/Chicago, 2027-03-14: 2:00 am CST becomes 3:00 am CDT.
    expect(wallTimeToInstant("2027-03-14", "02:30", "America/Chicago").toISOString()).toBe("2027-03-14T08:30:00.000Z"); // 3:30 am CDT
    expect(wallTimeToInstant("2027-03-14", "01:59", "America/Chicago").toISOString()).toBe("2027-03-14T07:59:00.000Z");
    expect(wallTimeToInstant("2027-03-14", "03:00", "America/Chicago").toISOString()).toBe("2027-03-14T08:00:00.000Z");
  });

  it("on the night the clocks go back, reads a time that happens twice as the first", () => {
    // America/Chicago, 2027-11-07: 2:00 am CDT becomes 1:00 am CST, so 1:30 happens at 06:30Z and again at 07:30Z.
    expect(wallTimeToInstant("2027-11-07", "01:30", "America/Chicago").toISOString()).toBe("2027-11-07T06:30:00.000Z");
    expect(wallTimeToInstant("2027-11-07", "02:30", "America/Chicago").toISOString()).toBe("2027-11-07T08:30:00.000Z");
  });
});

describe("a shift's start and end", () => {
  it("ends on the event's day, or the next morning when the end is at or before the start", () => {
    expect(shiftInstants("2027-03-01", "18:00", "21:00", "UTC")).toEqual({ start: new Date("2027-03-01T18:00:00Z"), end: new Date("2027-03-01T21:00:00Z") });
    expect(shiftInstants("2027-03-01", "22:00", "01:00", "UTC")).toEqual({ start: new Date("2027-03-01T22:00:00Z"), end: new Date("2027-03-02T01:00:00Z") });
    expect(shiftInstants("2027-12-31", "23:00", "00:00", "UTC").end).toEqual(new Date("2028-01-01T00:00:00Z"));
    expect(endsNextDay("22:00", "01:00")).toBe(true);
    expect(endsNextDay("08:00", "08:30")).toBe(false);
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(nextDay("2027-02-28")).toBe("2027-03-01");
  });

  it("is as long as it is lived, even across a change of the clocks", () => {
    expect(shiftMinutes(shiftInstants("2027-03-01", "18:00", "21:30", "America/Chicago"))).toBe(210);
    // 10 pm to 6 am across the night the clocks go back is nine hours.
    expect(shiftMinutes(shiftInstants("2027-11-06", "22:00", "06:00", "America/Chicago"))).toBe(540);
    // and across the night they go forward, seven.
    expect(shiftMinutes(shiftInstants("2027-03-13", "22:00", "06:00", "America/Chicago"))).toBe(420);
  });
});

describe("times in words", () => {
  it("says a clock time the way a parent says it", () => {
    expect(clockWords("18:30")).toBe("6:30 pm");
    expect(clockWords("09:05:00")).toBe("9:05 am");
    expect(clockWords("12:00")).toBe("noon");
    expect(clockWords("12:30")).toBe("12:30 pm");
    expect(clockWords("00:00")).toBe("midnight");
    expect(clockWords("00:15")).toBe("12:15 am");
    expect(shiftTimeWords("18:00", "21:00")).toBe("6:00 pm to 9:00 pm");
    expect(shiftTimeWords("22:00", "01:00")).toBe("10:00 pm to 1:00 am the next day");
    expect(shiftTimeWords("22:00", "00:00")).toBe("10:00 pm to midnight");
  });

  it("says a date and an instant as the club's calendar and clocks show them", () => {
    expect(dateWords("2027-03-06")).toBe("Saturday, March 6, 2027");
    expect(instantWords(new Date("2027-03-02T00:00:00Z"), "America/Chicago")).toBe("Monday, March 1, 6:00 pm");
    expect(instantWords(new Date("2027-03-02T00:00:00Z"), "UTC")).toBe("Tuesday, March 2, midnight");
    expect(hoursWords(180)).toBe("3");
    expect(hoursWords(150)).toBe("2.5");
    expect(hoursWords(100)).toBe("1.67");
  });

  it("knows a clock time from anything else", () => {
    for (const ok of ["00:00", "09:30", "23:59"]) expect(isClockTime(ok)).toBe(true);
    for (const bad of ["24:00", "9:30", "09:60", "09:30:00", "", null, 930]) expect(isClockTime(bad)).toBe(false);
  });
});

describe("the cancelling cut-off", () => {
  const start = new Date("2027-03-03T18:00:00Z");
  it("lets a guardian cancel until the cut-off, and not at it or after", () => {
    expect(beforeCutoff(start, 48, new Date("2027-03-01T17:59:59Z"))).toBe(true);
    expect(beforeCutoff(start, 48, new Date("2027-03-01T18:00:00Z"))).toBe(false);
    expect(beforeCutoff(start, 48, new Date("2027-03-02T18:00:00Z"))).toBe(false);
    expect(beforeCutoff(start, 0, new Date("2027-03-03T17:59:59Z"))).toBe(true);
    expect(beforeCutoff(start, 0, start)).toBe(false);
  });
});
