import { requireStaffPage } from "@/lib/guards";
import { HubPage } from "../hub-page";

export const metadata = { title: "Families" };

/** The Families hub: the phone's tab bar opens it (hub-page.tsx). No permission of its own: it lists only the pages the person may open, and refuses someone with none. */
export default async function FamiliesHubPage() {
  const ctx = await requireStaffPage();
  return <HubPage effective={ctx.effective} label="Families" lede="Families, their students and guardians, and who can sign in." />;
}
