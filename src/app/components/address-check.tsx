"use client";
import { useSyncExternalStore } from "react";
import { originOf, sameAddress } from "@/lib/health/address";

const noSubscribe = () => () => {};

/**
 * Says whether this browser reached the portal at the address the portal believes it has, and warns in plain words
 * when it didn't. Given the address and nothing else. The server render says nothing (it can't know what was typed);
 * the browser fills it in.
 */
export function AddressCheck({ appUrl }: { appUrl: string }) {
  const reached = useSyncExternalStore(noSubscribe, () => window.location.origin, () => null);
  if (reached === null) return null;
  if (sameAddress(appUrl, reached)) return <p className="hint">Your browser reached it at this same address.</p>;
  return (
    <p role="alert" className="inline-alert">
      <b>These don&apos;t match.</b> Your browser reached the portal at <code>{reached}</code>, but the portal believes its address is <code>{originOf(appUrl) ?? appUrl}</code>.
      {" "}Sign-in, the links in emails and the installed app all use the address the portal believes, so they would send people to the wrong place.
      {" "}Whoever installed the portal sets its address (<code>APP_URL</code> in the server&apos;s env file). Set it to the address people really use, then restart the portal.
    </p>
  );
}
