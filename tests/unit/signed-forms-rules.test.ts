import { describe, it, expect } from "vitest";
import {
  ATTACH_LIMIT_BYTES, CELL_WORDS, EVIDENCE_BACKOFF_MS, UNSEALED_RESTART_MS, cellState, cellTone, clubHour, isReminderDay, nextEvidenceTry, parseSchedule, reminderDates, restartPlan,
  whoStillHasToSign,
} from "@/lib/signed-forms/rules";
import { movedStudentPlan } from "@/lib/forms/moved";

/** The pure rules of signed forms for staff (src/lib/signed-forms/rules.ts) and the moved-student rule (src/lib/forms/moved.ts). */
const at = new Date("2026-11-16T12:00:00.000Z");
const MIN = 60_000;
const signer = (parentId: string, signedAt: string | null = null) => ({ parentId, signedAt });

describe("the back-off after a failed fetch of evidence", () => {
  it("waits 5 minutes after the first failure, 30 after the second, then every 3 hours", () => {
    expect(EVIDENCE_BACKOFF_MS).toEqual([5 * MIN, 30 * MIN, 180 * MIN]);
    expect(nextEvidenceTry(1, at).getTime() - at.getTime()).toBe(5 * MIN);
    expect(nextEvidenceTry(2, at).getTime() - at.getTime()).toBe(30 * MIN);
    for (const n of [3, 4, 10, 100]) expect(nextEvidenceTry(n, at).getTime() - at.getTime()).toBe(180 * MIN);
    expect(nextEvidenceTry(0, at).getTime() - at.getTime()).toBe(5 * MIN);
  });
  it("attaches a sealed PDF under 3 MB only (Graph refuses larger ones in one request)", () => {
    expect(ATTACH_LIMIT_BYTES).toBe(3_000_000);
  });
});

describe("a cell of the staff matrix", () => {
  const req = (state: "not_opened" | "waiting" | "signed" | "complete" | "declined", signed: (string | null)[] = []) => ({ state, signers: signed.map((s) => ({ signedAt: s })) });
  it("says each state in words, with nothing for a form that doesn't cover the student", () => {
    expect(cellState({ covered: false, waived: false, request: req("complete") })).toBe("not_asked");
    expect(CELL_WORDS.not_asked).toBe("");
    expect(cellState({ covered: true, waived: false, request: null })).toBe("not_opened");
    expect(cellState({ covered: true, waived: false, request: req("not_opened") })).toBe("not_opened");
    expect(cellState({ covered: true, waived: false, request: req("waiting", [null]) })).toBe("waiting");
    expect(cellState({ covered: true, waived: false, request: req("waiting", ["2026-11-10T10:00:00Z", null]) })).toBe("waiting_other");
    expect(cellState({ covered: true, waived: false, request: req("signed", ["x"]) })).toBe("sealing");
    expect(cellState({ covered: true, waived: false, request: req("complete", ["x"]) })).toBe("signed");
    expect(cellState({ covered: true, waived: false, request: req("declined") })).toBe("declined");
    expect(Object.values(CELL_WORDS)).toEqual(["", "Not opened yet", "Waiting for a guardian", "Waiting for the other guardian", "Signed, being sealed", "Signed", "Declined", "Waived"]);
  });
  it("reads Signed when signed, even if waived as well; otherwise a waiver comes first", () => {
    expect(cellState({ covered: true, waived: true, request: req("complete") })).toBe("signed");
    expect(cellState({ covered: true, waived: true, request: req("waiting", [null]) })).toBe("waived");
    expect(cellState({ covered: true, waived: true, request: null })).toBe("waived");
  });
  it("draws signed as done, waived as waived, and the rest as still to do", () => {
    expect(cellTone("signed")).toBe("done");
    expect(cellTone("waived")).toBe("waived");
    for (const s of ["not_opened", "waiting", "waiting_other", "sealing", "declined"] as const) expect(cellTone(s)).toBe("todo");
  });
});

describe("who still has to sign", () => {
  const guardians = [{ parentId: "p1" }, { parentId: "p2" }, { parentId: "p2" }];
  it("is nobody once everyone has signed", () => {
    for (const state of ["complete", "signed"] as const) {
      expect(whoStillHasToSign("any", { state, signers: [signer("p1", "x")] }, guardians)).toEqual([]);
      expect(whoStillHasToSign("every", { state, signers: [signer("p1", "x")] }, guardians)).toEqual([]);
    }
  });
  it("any one guardian: every guardian who could sign it, once each", () => {
    expect(whoStillHasToSign("any", null, guardians)).toEqual(["p1", "p2"]);
    expect(whoStillHasToSign("any", { state: "waiting", signers: [signer("p1")] }, guardians)).toEqual(["p1", "p2"]);
    expect(whoStillHasToSign("any", { state: "declined", signers: [signer("p1")] }, guardians)).toEqual(["p1", "p2"]);
  });
  it("every guardian: those who haven't signed yet", () => {
    expect(whoStillHasToSign("every", null, guardians)).toEqual(["p1", "p2"]);
    expect(whoStillHasToSign("every", { state: "waiting", signers: [signer("p1", "2026-11-10T10:00:00Z"), signer("p2")] }, guardians)).toEqual(["p2"]);
  });
  it("every guardian, once anyone has signed: only those its document names, since a guardian it doesn't name can't sign it", () => {
    const three = [{ parentId: "p1" }, { parentId: "p2" }, { parentId: "p3" }];
    expect(whoStillHasToSign("every", { state: "waiting", signers: [signer("p1", "2026-11-10T10:00:00Z"), signer("p2")] }, three)).toEqual(["p2"]);
    // Before anyone signs, a guardian it doesn't name can still open it and have it made again for them.
    expect(whoStillHasToSign("every", { state: "waiting", signers: [signer("p1"), signer("p2")] }, three)).toEqual(["p1", "p2", "p3"]);
  });
  it("never names someone who isn't among the guardians given (blocked, or their link closed)", () => {
    expect(whoStillHasToSign("every", { state: "waiting", signers: [signer("p9")] }, [{ parentId: "p1" }])).toEqual(["p1"]);
    expect(whoStillHasToSign("any", null, [])).toEqual([]);
  });
});

describe("the days a form's reminders fall on, by the club's date", () => {
  it("lists the days chosen before the due date and, weekly, four after it", () => {
    expect(reminderDates("2026-12-15", { before: [14, 7, 3, 1], weeklyAfter: false })).toEqual(["2026-12-01", "2026-12-08", "2026-12-12", "2026-12-14"]);
    expect(reminderDates("2026-12-15", { before: [1], weeklyAfter: true })).toEqual(["2026-12-14", "2026-12-22", "2026-12-29", "2027-01-05", "2027-01-12"]);
    expect(reminderDates("2027-03-01", { before: [1, 3], weeklyAfter: false })).toEqual(["2027-02-26", "2027-02-28"]);
  });
  it("has none without a due date or a schedule, and ignores days that aren't offered", () => {
    expect(reminderDates(null, { before: [7], weeklyAfter: true })).toEqual([]);
    expect(reminderDates("2026-12-15", null)).toEqual([]);
    expect(reminderDates("2026-12-15", { before: [5 as 7], weeklyAfter: false })).toEqual([]);
  });
  it("is a reminder day only on those dates", () => {
    const s = { before: [7] as (14 | 7 | 3 | 1)[], weeklyAfter: true };
    expect(isReminderDay("2026-12-08", "2026-12-15", s)).toBe(true);
    expect(isReminderDay("2026-12-09", "2026-12-15", s)).toBe(false);
    expect(isReminderDay("2026-12-15", "2026-12-15", s)).toBe(false);
    expect(isReminderDay("2027-01-12", "2026-12-15", s)).toBe(true);
    expect(isReminderDay("2027-01-19", "2026-12-15", s)).toBe(false);
  });
  it("reads the hour on the club's clock, not the server's", () => {
    const instant = new Date("2026-11-16T15:30:00.000Z");
    expect(clubHour("UTC", instant)).toBe(15);
    expect(clubHour("America/Chicago", instant)).toBe(9);
    expect(clubHour("Pacific/Kiritimati", instant)).toBe(5);
    expect(clubHour("UTC", new Date("2026-11-16T00:10:00.000Z"))).toBe(0);
  });
  it("takes a schedule from what staff sent, and nothing it doesn't know", () => {
    expect(parseSchedule({ before: [7, "3", 99, "x"], weeklyAfter: false })).toEqual({ before: [7, 3], weeklyAfter: false });
    expect(parseSchedule({ before: [], weeklyAfter: true })).toEqual({ before: [], weeklyAfter: true });
    expect(parseSchedule({ before: [], weeklyAfter: false })).toBeNull();
    expect(parseSchedule({ before: [1, 14], weeklyAfter: "yes" })).toEqual({ before: [14, 1], weeklyAfter: false });
  });
});

describe("what starting a form again does, in each state", () => {
  const row = (state: "not_opened" | "waiting" | "signed" | "complete" | "declined", o: { signed?: boolean; allSignedAgo?: number; envelope?: boolean } = {}) => ({
    state, envelopeId: o.envelope === false || state === "not_opened" ? null : "envelope_abcdefgh",
    allSignedAt: o.allSignedAgo === undefined ? null : new Date(at.getTime() - o.allSignedAgo), signers: [{ signedAt: o.signed ? "2026-11-10T10:00:00Z" : null }],
  });
  it("never touches a complete form, and has nothing to start again without a document", () => {
    for (const reason of ["declined", "not_sealed", "gone", "lost_access"] as const) {
      expect(restartPlan(row("complete", { signed: true }), reason, at).ok).toBe(false);
      expect(restartPlan(row("not_opened"), reason, at).ok).toBe(false);
    }
  });
  it("starts a declined form again: deleted when nobody signed, cancelled when someone did", () => {
    expect(restartPlan(row("declined"), "declined", at)).toEqual({ ok: true, withdraw: "delete" });
    expect(restartPlan(row("declined", { signed: true }), "declined", at)).toEqual({ ok: true, withdraw: "cancel" });
    expect(restartPlan(row("waiting"), "declined", at).ok).toBe(false);
  });
  it("starts one that everyone signed more than six hours ago and isn't sealed: cancelled", () => {
    expect(restartPlan(row("signed", { signed: true, allSignedAgo: UNSEALED_RESTART_MS + 1000 }), "not_sealed", at)).toEqual({ ok: true, withdraw: "cancel" });
    expect(restartPlan(row("signed", { signed: true, allSignedAgo: UNSEALED_RESTART_MS }), "not_sealed", at).ok).toBe(false);
    expect(restartPlan(row("waiting", { allSignedAgo: UNSEALED_RESTART_MS * 2 }), "not_sealed", at).ok).toBe(false);
  });
  it("starts any form that is out and not finished when its document is gone or a guardian lost access", () => {
    expect(restartPlan(row("waiting"), "gone", at)).toEqual({ ok: true, withdraw: "delete" });
    expect(restartPlan(row("waiting", { signed: true }), "lost_access", at)).toEqual({ ok: true, withdraw: "cancel" });
    expect(restartPlan(row("signed", { signed: true, allSignedAgo: 1000 }), "gone", at)).toEqual({ ok: true, withdraw: "cancel" });
  });
});

describe("the moved-student rule", () => {
  it("moves a complete form with the student, and resets the rest, withdrawing any document", () => {
    expect(movedStudentPlan([
      { id: "a", state: "complete", envelopeId: "envelope_done", signers: [{ signedAt: "x" }] },
      { id: "b", state: "waiting", envelopeId: "envelope_unsigned", signers: [{ signedAt: null }] },
      { id: "c", state: "waiting", envelopeId: "envelope_half", signers: [{ signedAt: "x" }, { signedAt: null }] },
      { id: "d", state: "signed", envelopeId: "envelope_sealing", signers: [{ signedAt: "x" }] },
      { id: "e", state: "declined", envelopeId: "envelope_declined", signers: [{ signedAt: null }] },
      { id: "f", state: "not_opened", envelopeId: null, signers: [] },
    ])).toEqual([
      { requestId: "a", do: "move", withdraw: null },
      { requestId: "b", do: "reset", withdraw: { envelopeId: "envelope_unsigned", anySigned: false } },
      { requestId: "c", do: "reset", withdraw: { envelopeId: "envelope_half", anySigned: true } },
      { requestId: "d", do: "reset", withdraw: { envelopeId: "envelope_sealing", anySigned: true } },
      { requestId: "e", do: "reset", withdraw: { envelopeId: "envelope_declined", anySigned: false } },
      { requestId: "f", do: "reset", withdraw: null },
    ]);
  });
});
