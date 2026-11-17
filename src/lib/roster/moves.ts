// The students a roster refresh finds moved from one family to another in QuickBooks (src/lib/roster/refresh.ts),
// so the portal can follow each move as it follows one staff make in the portal (afterStudentMoved() in ./writes.ts).
// Pure: it compares the cache a refresh is about to replace with what QuickBooks now sends, and with where the
// student's records are held, so a move that reached the new family over more than one refresh is still followed.
import type { MembershipShape } from "./shape";

/** Where a customer sits in a roster, as the cache holds it. */
export type Placed = { qboId: string; typeQboId: string | null; parentQboId: string | null; active: boolean };
export type StudentMove = { studentQboId: string; fromFamilyQboId: string; toFamilyQboId: string };
/** A student's record (a form request, a place on a shift still to start) held under a family: where it was made. */
export type Held = { studentQboId: string; familyQboId: string };

/**
 * Every active student directly under a family of the shape's family type, in this roster, with that family: the
 * students whose records belong under that family alone. Empty for a flat shape or one with no student type.
 */
export function studentsUnderFamilies(shape: MembershipShape | null, rows: readonly Placed[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!shape || shape.kind !== "layered" || shape.studentTypeId === null) return out;
  const families = new Set(rows.filter((r) => r.typeQboId === shape.familyTypeId).map((r) => r.qboId));
  for (const r of rows) {
    if (r.typeQboId === shape.studentTypeId && r.active && r.parentQboId !== null && families.has(r.parentQboId) && !out.has(r.qboId)) out.set(r.qboId, r.parentQboId);
  }
  return out;
}

/**
 * The students who were directly under one family and are now directly under another, both of the shape's family type
 * (the old family as the old cache had it, the new one as QuickBooks sends it), each with the student type before and
 * after and active now. Nothing for a flat shape or a layered one with no student type; nothing for a student made
 * inactive, moved to something that isn't a family (a school, a stray with no parent), or met for the first time.
 * A move can also reach the new family over more than one refresh, which no one pair of rosters shows: moved while
 * inactive and taken back into use later, or taken off the family to a stray first and put under the new one later. So
 * `held` (where the student's records are held: ./refresh.ts reads them) counts too: an active student directly under
 * a family whose records are held under another family moved from that one. A move already followed leaves nothing
 * held elsewhere, so it is found once. Ordered by QuickBooks ID, compared as numbers, so the follow-ups run in a steady
 * order.
 */
export function studentMoves(shape: MembershipShape | null, before: readonly Placed[], after: readonly Placed[], held: readonly Held[] = []): StudentMove[] {
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
  const under = studentsUnderFamilies(shape, after);
  for (const h of held) {
    const to = under.get(h.studentQboId);
    if (to === undefined || h.familyQboId === to) continue;
    if (moves.some((m) => m.studentQboId === h.studentQboId && m.fromFamilyQboId === h.familyQboId)) continue;
    moves.push({ studentQboId: h.studentQboId, fromFamilyQboId: h.familyQboId, toFamilyQboId: to });
  }
  return moves.sort((a, b) => a.studentQboId.localeCompare(b.studentQboId, "en", { numeric: true }) || a.fromFamilyQboId.localeCompare(b.fromFamilyQboId, "en", { numeric: true }));
}
