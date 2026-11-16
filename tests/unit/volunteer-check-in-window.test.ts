import { describe, it, expect } from "vitest";
import { checkInWindow, shiftInstants } from "@/lib/volunteer/clock";

/**
 * Check-in works from 30 minutes before a shift starts until it ends (v1 spec §11.4), in the club's own time: the
 * window is worked out from the shift's instants (shiftInstants), so it holds across a change of the clocks and for a
 * shift that ends the next morning.
 */
const at = (iso: string) => new Date(iso);
const state = (onDate: string, startsAt: string, endsAt: string, zone: string, now: string) => checkInWindow(shiftInstants(onDate, startsAt, endsAt, zone), at(now)).state;

describe("the check-in window", () => {
  it("opens 30 minutes before the start, to the minute, and closes at the end itself", () => {
    // 18:00 to 21:00 UTC.
    expect(state("2027-03-01", "18:00", "21:00", "UTC", "2027-03-01T17:29:59.999Z")).toBe("before");
    expect(state("2027-03-01", "18:00", "21:00", "UTC", "2027-03-01T17:30:00.000Z")).toBe("open");
    expect(state("2027-03-01", "18:00", "21:00", "UTC", "2027-03-01T20:59:59.999Z")).toBe("open");
    expect(state("2027-03-01", "18:00", "21:00", "UTC", "2027-03-01T21:00:00.000Z")).toBe("closed");
    const w = checkInWindow(shiftInstants("2027-03-01", "18:00", "21:00", "UTC"), at("2027-03-01T12:00:00Z"));
    expect(w).toEqual({ state: "before", opensAt: at("2027-03-01T17:30:00Z"), closesAt: at("2027-03-01T21:00:00Z") });
  });

  it("is read in the club's zone, not the server's", () => {
    // 18:00 in Chicago in March (CST) is 00:00 UTC the next day.
    expect(state("2027-03-01", "18:00", "21:00", "America/Chicago", "2027-03-01T18:00:00Z")).toBe("before");
    expect(state("2027-03-01", "18:00", "21:00", "America/Chicago", "2027-03-01T23:30:00Z")).toBe("open");
    expect(state("2027-03-01", "18:00", "21:00", "America/Chicago", "2027-03-02T03:00:00Z")).toBe("closed");
  });

  it("stays open through the night for a shift that ends the next morning", () => {
    // 22:00 to 02:00 the next day, UTC.
    expect(state("2027-03-01", "22:00", "02:00", "UTC", "2027-03-01T21:30:00Z")).toBe("open");
    expect(state("2027-03-01", "22:00", "02:00", "UTC", "2027-03-02T01:59:00Z")).toBe("open");
    expect(state("2027-03-01", "22:00", "02:00", "UTC", "2027-03-02T02:00:00Z")).toBe("closed");
  });

  it("holds its edges on the nights the clocks change", () => {
    // America/Chicago, 2027-03-14: 2:00 am CST becomes 3:00 am CDT. A shift from 1:00 to 5:00 am lasts three hours.
    expect(state("2027-03-14", "01:00", "05:00", "America/Chicago", "2027-03-14T06:29:00Z")).toBe("before"); // 0:29 am CST
    expect(state("2027-03-14", "01:00", "05:00", "America/Chicago", "2027-03-14T06:30:00Z")).toBe("open"); // 0:30 am CST
    expect(state("2027-03-14", "01:00", "05:00", "America/Chicago", "2027-03-14T09:59:00Z")).toBe("open"); // 4:59 am CDT
    expect(state("2027-03-14", "01:00", "05:00", "America/Chicago", "2027-03-14T10:00:00Z")).toBe("closed"); // 5:00 am CDT
    // 2027-11-07: 2:00 am CDT becomes 1:00 am CST. A shift from 11:00 pm the night before to 3:00 am lasts five hours.
    expect(state("2027-11-06", "23:00", "03:00", "America/Chicago", "2027-11-07T03:30:00Z")).toBe("open"); // 10:30 pm CDT
    expect(state("2027-11-06", "23:00", "03:00", "America/Chicago", "2027-11-07T08:59:00Z")).toBe("open"); // 2:59 am CST
    expect(state("2027-11-06", "23:00", "03:00", "America/Chicago", "2027-11-07T09:00:00Z")).toBe("closed"); // 3:00 am CST
  });
});
