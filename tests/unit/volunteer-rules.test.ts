import { describe, it, expect } from "vitest";
import type { Requirement } from "@/lib/seasons/progress";
import { amountWords, countsFor, placesWords, shiftCredit, volunteerStanding, whoMustWords } from "@/lib/volunteer/rules";
import { calendarFile, foldLine, icsText } from "@/lib/volunteer/calendar";

const req = (o: Partial<Requirement>): Requirement => ({ id: "r1", kind: "volunteer", title: "Concessions", required: true, appliesTo: "family", amount: 2, amountUnit: "shifts",
  dueOn: null, covers: "everyone", coveredQboIds: [], ...o });

describe("how volunteering counts", () => {
  it("counts a shift as one shift, or its length in hours, as the requirement counts", () => {
    expect(shiftCredit(req({ amountUnit: "shifts" }), 180)).toBe(1);
    expect(shiftCredit(req({ amountUnit: "hours" }), 180)).toBe(3);
    expect(shiftCredit(req({ amountUnit: "hours" }), 150)).toBe(2.5);
  });

  it("is met by anyone in the family for a per-family requirement, and by that student alone for a per-student one", () => {
    const family = req({ appliesTo: "family" }), student = req({ appliesTo: "student" });
    expect(countsFor(family, { kind: "guardian" }, "FAM", "FAM")).toBe(true);
    expect(countsFor(family, { kind: "student", studentQboId: "S1" }, "FAM", "FAM")).toBe(true);
    expect(countsFor(family, { kind: "guardian" }, "FAM", "OTHER")).toBe(false);
    expect(countsFor(student, { kind: "student", studentQboId: "S1" }, "FAM", "S1")).toBe(true);
    expect(countsFor(student, { kind: "student", studentQboId: "S1" }, "FAM", "S2")).toBe(false);
    expect(countsFor(student, { kind: "guardian" }, "FAM", "S1")).toBe(false);
    expect(whoMustWords(family, null)).toBe("Anyone in your family can do it");
    expect(whoMustWords(student, "Leo Rivera")).toBe("Leo Rivera must do it");
  });

  it("says how much is needed, done and signed up for, and is met only by confirmed volunteering", () => {
    expect(volunteerStanding(req({}), { confirmed: 0, signedUp: 0 })).toEqual({ met: false, words: "0 of 2 shifts done" });
    expect(volunteerStanding(req({}), { confirmed: 0, signedUp: 1 })).toEqual({ met: false, words: "0 of 2 shifts done, signed up for 1" });
    expect(volunteerStanding(req({ amount: 1 }), { confirmed: 0, signedUp: 3 })).toEqual({ met: false, words: "0 of 1 shift done, signed up for 3" });
    expect(volunteerStanding(req({ amount: 4, amountUnit: "hours" }), { confirmed: 0, signedUp: 2.5 })).toEqual({ met: false, words: "0 of 4 hours done, signed up for 2.5" });
    // What the check-in slice will pass: confirmed credit reaching the amount meets it.
    expect(volunteerStanding(req({}), { confirmed: 2, signedUp: 0 })).toEqual({ met: true, words: "2 of 2 shifts done" });
    expect(volunteerStanding(req({ amount: 4, amountUnit: "hours" }), { confirmed: 3.5, signedUp: 3 })).toEqual({ met: false, words: "3.5 of 4 hours done, signed up for 3" });
    expect(amountWords("hours", 1)).toBe("1 hour");
    expect(amountWords("shifts", 2)).toBe("2 shifts");
    expect(placesWords({ filled: 3, places: 5 })).toBe("3 of 5 places filled");
    expect(placesWords({ filled: 0, places: 1 })).toBe("0 of 1 place filled");
  });
});

describe("the calendar file", () => {
  const file = calendarFile({ signupId: "6d1c2a0e-0000-4000-8000-000000000001", revision: 2, start: new Date("2027-03-01T18:00:00Z"), end: new Date("2027-03-01T21:00:00Z"),
    stamp: new Date("2027-02-01T12:34:56.789Z"), summary: "Volunteering: Home game, concessions; snacks", location: "North stand\nGate 3", description: "Bring\\gloves" });

  it("holds one event at its instants in UTC, named by the sign-up so a later copy replaces it", () => {
    expect(file.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(file.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    for (const line of ["UID:volunteer-signup-6d1c2a0e-0000-4000-8000-000000000001@booster-rocket", "SEQUENCE:2", "DTSTART:20270301T180000Z", "DTEND:20270301T210000Z",
      "DTSTAMP:20270201T123456Z", "METHOD:PUBLISH", "STATUS:CONFIRMED"]) expect(file).toContain(`\r\n${line}\r\n`);
  });

  it("escapes text and folds long lines without breaking a character", () => {
    expect(file).toContain("SUMMARY:Volunteering: Home game\\, concessions\\; snacks\r\n");
    expect(file).toContain("LOCATION:North stand\\nGate 3\r\n");
    expect(file).toContain("DESCRIPTION:Bring\\\\gloves\r\n");
    expect(icsText("a,b;c\\d\r\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const long = `SUMMARY:${"é".repeat(60)}`;
    const folded = foldLine(long);
    for (const line of folded.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(long);
  });
});
