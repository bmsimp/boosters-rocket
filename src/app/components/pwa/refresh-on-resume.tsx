"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { watchResume } from "./resume-watch";

/**
 * Loads the current page's data again when the portal comes back to the front after a while away (resume-watch.ts).
 * An installed app has no reload button. router.refresh() asks the server for the page again and keeps what the
 * person has typed. Draws nothing; mount it once in a layout.
 */
export function RefreshOnResume({ afterMs }: { afterMs?: number }) {
  const router = useRouter();
  useEffect(() => watchResume(() => router.refresh(), { afterMs }), [router, afterMs]);
  return null;
}
