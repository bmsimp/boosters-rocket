"use client";
import { useSyncExternalStore } from "react";
import { utcFallback } from "./utc-fallback";

const noSubscribe = () => () => {};

/**
 * A UTC instant shown in the viewer's own time zone. The server and the hydrating render show UTC (no hydration
 * mismatch); the browser then switches to local time. `dateOnly` shows the day alone, for a short line (its full time
 * is still in the title).
 */
export function LocalTime({ iso, dateOnly = false }: { iso: string; dateOnly?: boolean }) {
  const text = useSyncExternalStore(
    noSubscribe,
    () => new Date(iso).toLocaleString(undefined, dateOnly ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" }),
    () => (dateOnly ? utcFallback(iso).slice(0, 10) : utcFallback(iso)),
  );
  return <time dateTime={iso} title={iso}>{text}</time>;
}
