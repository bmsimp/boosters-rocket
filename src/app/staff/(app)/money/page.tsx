import { requireStaffPage } from "@/lib/guards";
import { HubPage } from "../hub-page";

export const metadata = { title: "Money" };

/** The Money hub: the phone's tab bar opens it (hub-page.tsx). No permission of its own: it lists only the pages the person may open, and refuses someone with none. */
export default async function MoneyHubPage() {
  const ctx = await requireStaffPage();
  return <HubPage effective={ctx.effective} label="Money" lede="What families owe, and changes on their way to the books." />;
}
