import { env } from "@/env";
import { originOf } from "@/lib/health/address";
import { AddressCheck } from "./address-check";

/**
 * The address the portal believes it has, with the check that the browser reached it there (the setup page and the
 * staff Health page). The address is whatever APP_URL was set to when the portal was installed.
 */
export function PortalAddress() {
  const appUrl = originOf(env.APP_URL) ?? env.APP_URL;
  return (
    <>
      <p>This portal&apos;s address is <code>{appUrl}</code>. It was set when the portal was installed. Sign-in, the links in emails and the installed app are all built on it.</p>
      <AddressCheck appUrl={appUrl} />
    </>
  );
}
