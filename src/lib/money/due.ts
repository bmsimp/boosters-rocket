/**
 * How a due date is said (DESIGN.md, Money lines): in words first, with the color only confirming them. Pure, and free
 * of server code: the browser runs it with the viewer's own "today" (src/app/(parent)/due-line.tsx).
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

/** `due` and `today` are calendar dates (YYYY-MM-DD). */
export function dueState(due: string, today: string): DueState {
  const days = dayNumber(due) - dayNumber(today);
  if (!Number.isFinite(days)) return { tone: "later", lead: "Due", tail: "" };
  if (days < 0) return { tone: "late", lead: "Was due", tail: "" };
  if (days > SOON_DAYS) return { tone: "later", lead: "Due", tail: "" };
  return { tone: "soon", lead: "Due", tail: days === 0 ? ", today" : days === 1 ? ", tomorrow" : `, in ${days} days` };
}

/** A Date's own calendar day in the zone the code runs in: the viewer's, in the browser. */
export function localDay(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}
