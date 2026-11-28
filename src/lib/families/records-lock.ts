/**
 * The club's records lock (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md, section 4): a Postgres
 * advisory lock held, exclusively, by every write that changes which families and students there are or who is in
 * them (a change staff make by hand, and an accounting plugin's reads and writes of the books), and shared by the
 * writes that name families and students (a season's tick, a check-in, a sign-up), so no change of the records runs
 * between such a write's look at them and its commit. The core's: an accounting plugin takes it as it took the roster
 * lock, which it is (QuickBooks' `ROSTER_LOCK`, src/lib/roster/shape.ts).
 */
export const RECORDS_LOCK = 7461001;
