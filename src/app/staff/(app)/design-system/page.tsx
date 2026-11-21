import { requireStaffPage } from "@/lib/guards";
import { Gallery } from "./gallery";

export const metadata = { title: "Design system" };

/**
 * The design system's gallery (docs/agents/ui.md): every primitive in every state, for whoever builds or reviews a
 * page. It reads nothing and shows only sample content, so opening it is not audited. Its permission is the least a
 * role is likely to hold, the club settings' read (the club's name and color, which the samples are drawn in).
 */
export default async function DesignSystemPage() {
  await requireStaffPage("Settings.Club.Read");
  return (
    <main className="wrap single ds-page">
      <Gallery />
    </main>
  );
}
