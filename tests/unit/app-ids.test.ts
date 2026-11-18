import { describe, it, expect } from "vitest";
import { asAppFamilyId, asAppStudentId, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";

/**
 * The app's own family and student ids are typed apart from a QuickBooks id (src/lib/families/ids.ts), so the two can't
 * be compared or passed for each other by mistake while stage 2 moves one area at a time. `pnpm typecheck` checks the
 * lines marked @ts-expect-error: each must be an error, or the typecheck fails.
 */
function takesQboId(qboId: string): string { return qboId; }
function takesFamilyId(id: AppFamilyId): AppFamilyId { return id; }
function takesStudentId(id: AppStudentId): AppStudentId { return id; }

// Never called: it is here for the typecheck alone.
export function misuses(qboId: string, familyId: AppFamilyId, studentId: AppStudentId): unknown[] {
  return [
    // @ts-expect-error an app family id is not a QuickBooks id
    takesQboId(familyId),
    // @ts-expect-error an app student id is not a QuickBooks id
    takesQboId(studentId),
    // @ts-expect-error a QuickBooks id is not an app family id
    takesFamilyId(qboId),
    // @ts-expect-error a QuickBooks id is not an app student id
    takesStudentId(qboId),
    // @ts-expect-error a student's id is not a family's
    takesFamilyId(studentId),
    // @ts-expect-error the two kinds of id can't be compared
    familyId === qboId,
    // @ts-expect-error nor a student's with a QuickBooks id
    studentId === qboId,
  ];
}

describe("the app's own ids", () => {
  it("are the uuid at run time, and their text is String(id)", () => {
    const uuid = "0b6c9d2e-4f1a-4c3b-9e8d-7a6b5c4d3e2f";
    expect(String(asAppFamilyId(uuid))).toBe(uuid);
    expect(String(asAppStudentId(uuid))).toBe(uuid);
    expect(takesFamilyId(asAppFamilyId(uuid))).toBe(asAppFamilyId(uuid));
  });
});
