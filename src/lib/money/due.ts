/**
 * How a due date is said: in words first, with the color only confirming them. Pure. "Today"
 * is the club's own date, clubToday() in src/lib/settings/club.ts, for an invoice (src/app/(parent)/due-line.tsx) as
 * for a season requirement (src/app/(parent)/season-parts.tsx): never the server's date, and never the viewer's, so
 * every parent of a club reads the same words on the same day.
 */
export type DueTone = "later" | "soon" | "late";
export type DueState = {
  tone: DueTone;
  /** What goes before the date: "Due Nov 22" or, once the date has passed, "Was due Oct 30". Never an alarm word. */
  lead: "Due" | "Was due";
  /** What goes after it when the date is near: ", today", ", tomorrow", ", in 8 days". */
  tail: string;
};

/** An invoice due within this many days is "due soon". */
export const SOON_DAYS = 14;

const dayNumber = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** `due` and `today` are calendar dates (YYYY-MM-DD); `today` is the club's (clubToday()). */
export function dueState(due: string, today: string): DueState {
  const days = dayNumber(due) - dayNumber(today);
  if (!Number.isFinite(days)) return { tone: "later", lead: "Due", tail: "" };
  if (days < 0) return { tone: "late", lead: "Was due", tail: "" };
  if (days > SOON_DAYS) return { tone: "later", lead: "Due", tail: "" };
  return { tone: "soon", lead: "Due", tail: days === 0 ? ", today" : days === 1 ? ", tomorrow" : `, in ${days} days` };
}
