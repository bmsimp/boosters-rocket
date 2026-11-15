import { parentLayoutCtx } from "@/lib/guards";
import { ParentFrame } from "../components/parent-frame";

/**
 * What surrounds a parent page, for a signed-in parent. Not a guard: with nobody signed in (or no family chosen) it
 * draws the page alone and sends nobody anywhere, and the page's own requireParentPage() then redirects with the page's
 * address, which a redirect from here could not know.
 */
export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  const ctx = await parentLayoutCtx();
  if (!ctx) return children;
  return <ParentFrame who={ctx}>{children}</ParentFrame>;
}
