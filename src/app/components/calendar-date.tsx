"use client";
import { useSyncExternalStore } from "react";
import { formatCalendarDate } from "./calendar-date-format";

const noSubscribe = () => () => {};

/**
 * A calendar date (such as a secret's expiry) shown as the same day for every viewer. Unlike LocalTime, this is
 * deliberately NOT converted to the viewer's zone: an expiry is a date, not an instant, so its UTC date parts are intended.
 * The server and the hydrating render show the ISO date (no hydration mismatch); the browser then switches to the viewer's date format.
 */
export function CalendarDate({ iso }: { iso: string }) {
  const text = useSyncExternalStore(noSubscribe, () => formatCalendarDate(iso), () => iso.slice(0, 10));
  return <time dateTime={iso.slice(0, 10)}>{text}</time>;
}
