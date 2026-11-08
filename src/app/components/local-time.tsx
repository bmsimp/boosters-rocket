"use client";
import { useSyncExternalStore } from "react";
import { utcFallback } from "./utc-fallback";

const noSubscribe = () => () => {};

/** A UTC instant shown in the viewer's own time zone. The server and the hydrating render show UTC (no hydration mismatch); the browser then switches to local time. */
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    noSubscribe,
    () => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    () => utcFallback(iso),
  );
  return <time dateTime={iso} title={iso}>{text}</time>;
}
