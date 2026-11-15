import { parentLayoutCtx } from "@/lib/guards";
import { ParentFrame } from "../components/parent-frame";
import { RefreshOnResume } from "../components/pwa/refresh-on-resume";

/**
 * What surrounds a parent page, for a signed-in parent. Not a guard: with nobody signed in (or no family chosen) it
 * draws the page alone and sends nobody anywhere, and the page's own requireParentPage() then redirects with the page's
 * address, which a redirect from here could not know.
 */
export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  const ctx = await parentLayoutCtx();
  if (!ctx) return children;
  return (
    <ParentFrame who={ctx}>
      {children}
      {/* An installed app has no reload button: the page's data is read again when the app comes back to the front. */}
      <RefreshOnResume />
    </ParentFrame>
  );
}
