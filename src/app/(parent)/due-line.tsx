import { CalendarDate } from "../components/calendar-date";
import { dueState, type DueTone } from "@/lib/money/due";
import type { Tone } from "../components/ui/tone";

const CLASS: Record<DueTone, string> = { later: "when", soon: "when soon", late: "when late" };

/**
 * An invoice's due date, said in words: "Due Nov 22", "Due Nov 15, in 8 days", "Was due Oct 30". How near the date is
 * depends on which day it is for the club: `today` is the club's own date, which loadFamilyMoney() returns with the
 * figures (clubToday() in src/lib/settings/club.ts), the day a season requirement's due date is said against too.
 * Worked out on the server, so the words are on the page as it arrives. The color follows the words and never stands alone.
 */
export function DueLine({ due, today }: { due: string; today: string }) {
  const { tone, lead, tail } = dueState(due, today);
  return <span className={CLASS[tone]}>{lead} <CalendarDate iso={due} />{tail}</span>;
}

/** The ring before an invoice (Home, Payments, and staff's view of a family's money): in the tone of its due date, as the due line's words say it. */
const DUE_TONE: Record<DueTone, Tone> = { later: "neutral", soon: "due", late: "late" };
export const dueTone = (due: string | null, today: string): Tone => (due ? DUE_TONE[dueState(due, today).tone] : "neutral");
