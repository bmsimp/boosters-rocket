// The students a roster refresh finds moved from one family to another in QuickBooks (src/lib/roster/refresh.ts),
// so the portal can follow each move as it follows one staff make in the portal (afterStudentMoved() in ./writes.ts).
// Pure: it compares the cache a refresh is about to replace with what QuickBooks now sends.
import type { MembershipShape } from "./shape";

/** Where a customer sits in a roster, as the cache holds it. */
export type Placed = { qboId: string; typeQboId: string | null; parentQboId: string | null; active: boolean };
export type StudentMove = { studentQboId: string; fromFamilyQboId: string; toFamilyQboId: string };

/**
 * The students who were directly under one family and are now directly under another, both of the shape's family type
 * (the old family as the old cache had it, the new one as QuickBooks sends it), each with the student type before and
 * after and active now. Nothing for a flat shape or a layered one with no student type; nothing for a student made
 * inactive, moved to something that isn't a family (a school, a stray with no parent), or met for the first time.
 * Ordered by QuickBooks ID, compared as numbers, so the follow-ups run in a steady order.
 */
export function studentMoves(shape: MembershipShape | null, before: readonly Placed[], after: readonly Placed[]): StudentMove[] {
  if (!shape || shape.kind !== "layered" || shape.studentTypeId === null) return [];
  const { familyTypeId, studentTypeId } = shape;
  const byId = (rows: readonly Placed[]) => { const m = new Map<string, Placed>(); for (const r of rows) if (!m.has(r.qboId)) m.set(r.qboId, r); return m; };
  const was = byId(before), now = byId(after);
  const familyIn = (m: Map<string, Placed>, id: string | null): string | null => (id !== null && m.get(id)?.typeQboId === familyTypeId ? id : null);
  const moves: StudentMove[] = [];
  for (const s of now.values()) {
    if (s.typeQboId !== studentTypeId || !s.active) continue;
    const to = familyIn(now, s.parentQboId);
    const old = was.get(s.qboId);
    if (to === null || !old || old.typeQboId !== studentTypeId) continue;
    const from = familyIn(was, old.parentQboId);
    if (from === null || from === to) continue;
    moves.push({ studentQboId: s.qboId, fromFamilyQboId: from, toFamilyQboId: to });
  }
  return moves.sort((a, b) => a.studentQboId.localeCompare(b.studentQboId, "en", { numeric: true }));
}
