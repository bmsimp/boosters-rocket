import { requireStaffPage } from "@/lib/guards";
import { HubPage } from "../hub-page";

export const metadata = { title: "Season" };

/** The Season hub: the phone's tab bar opens it (hub-page.tsx). No permission of its own: it lists only the pages the person may open, and refuses someone with none. */
export default async function SeasonHubPage() {
  const ctx = await requireStaffPage();
  return <HubPage effective={ctx.effective} label="Season" lede="The season's steps, signed forms and volunteering." />;
}
