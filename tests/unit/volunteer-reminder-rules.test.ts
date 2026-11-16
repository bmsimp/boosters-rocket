import { describe, it, expect } from "vitest";
import { daysAfter, reminderDay } from "@/lib/volunteer/clock";
import { placesToGiveUp } from "@/lib/volunteer/rules";

/** The pure rules behind the volunteer reminders (src/lib/volunteer/reminders.ts) and a moved student's places (moved-student.ts). */
describe("the reminders' day", () => {
  it("is the club's today and tomorrow from 9:00 on the club's clock, and nothing before", () => {
    expect(reminderDay("UTC", new Date("2027-03-10T08:59:59Z"))).toBeNull();
    expect(reminderDay("UTC", new Date("2027-03-10T09:00:00Z"))).toEqual({ today: "2027-03-10", tomorrow: "2027-03-11" });
    expect(reminderDay("UTC", new Date("2027-03-10T23:59:00Z"))).toEqual({ today: "2027-03-10", tomorrow: "2027-03-11" });
    // 9:00 in Chicago (CST, UTC-6) is 15:00 UTC; at 03:00 UTC it is still the evening before there.
    expect(reminderDay("America/Chicago", new Date("2027-03-10T14:59:00Z"))).toBeNull();
    expect(reminderDay("America/Chicago", new Date("2027-03-10T15:00:00Z"))).toEqual({ today: "2027-03-10", tomorrow: "2027-03-11" });
    expect(reminderDay("America/Chicago", new Date("2027-03-11T03:00:00Z"))).toEqual({ today: "2027-03-10", tomorrow: "2027-03-11" });
    // The two zones that never share a calendar day.
    expect(reminderDay("Pacific/Kiritimati", new Date("2027-03-10T20:00:00Z"))!.today).toBe("2027-03-11");
    expect(reminderDay("Pacific/Pago_Pago", new Date("2027-03-10T20:00:00Z"))!.today).toBe("2027-03-10");
  });

  it("counts days on the calendar, across months and years", () => {
    expect(daysAfter("2027-03-10", 14)).toBe("2027-03-24");
    expect(daysAfter("2027-02-27", 3)).toBe("2027-03-02");
    expect(daysAfter("2027-12-30", 3)).toBe("2028-01-02");
  });
});

describe("a moved student's places", () => {
  const now = new Date("2027-03-10T12:00:00Z");
  const place = (id: string, startIso: string, o: { cancelled?: boolean; checkedIn?: boolean } = {}) => ({ id, start: new Date(startIso), cancelled: o.cancelled ?? false, checkedIn: o.checkedIn ?? false });
  it("gives up only places on shifts still to start, the club hasn't cancelled, and not checked in", () => {
    expect(placesToGiveUp([
      place("later", "2027-03-20T10:00:00Z"),
      place("soon", "2027-03-10T12:00:01Z"),
      place("started", "2027-03-10T12:00:00Z"),
      place("over", "2027-03-01T10:00:00Z"),
      place("cancelled", "2027-03-20T10:00:00Z", { cancelled: true }),
      // Checked in in the half hour before its start: volunteering being done, so its place and credit stay.
      place("checked-in", "2027-03-10T12:20:00Z", { checkedIn: true }),
    ], now)).toEqual(["later", "soon"]);
  });
});
