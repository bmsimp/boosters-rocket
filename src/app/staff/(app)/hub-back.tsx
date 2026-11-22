"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** A group's hub and the pages it lists, as the browser gets them: addresses and the group's name only. */
export type HubEntry = { hub: string; label: string; pages: string[] };

/**
 * On a phone, the way back from a group's page to its hub (Roster to Families), above the page: drawn only on a page
 * the hub lists, and only for a group with a hub for this person (two pages or more). Hidden from 760px, where the top
 * nav holds the group. A page's own deeper pages keep their own way back.
 */
export function HubBack({ hubs }: { hubs: HubEntry[] }) {
  const path = usePathname();
  const hub = hubs.find((h) => h.pages.includes(path));
  if (!hub) return null;
  return (
    <p className="wrap hub-back">
      <Link href={hub.hub}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg>{hub.label}</Link>
    </p>
  );
}
