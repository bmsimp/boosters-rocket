"use client";
import { useSyncExternalStore } from "react";
import { CalendarDate } from "../components/calendar-date";
import { dueState, localDay, type DueTone } from "@/lib/money/due";

const noSubscribe = () => () => {};
const CLASS: Record<DueTone, string> = { later: "when", soon: "when soon", late: "when late" };

/**
 * An invoice's due date, said in words: "Due Nov 22", "Due Nov 15, in 8 days", "Was due Oct 30". How near the date is
 * depends on the viewer's own today, so the server and the hydrating render say only "Due" and the date (no hydration
 * mismatch); the browser then adds the rest. The color follows the words and never stands alone.
 */
export function DueLine({ due }: { due: string }) {
  const today = useSyncExternalStore(noSubscribe, () => localDay(), () => null);
  const { tone, lead, tail } = today === null ? ({ tone: "later", lead: "Due", tail: "" } as const) : dueState(due, today);
  return <span className={CLASS[tone]}>{lead} <CalendarDate iso={due} />{tail}</span>;
}
