import { requireParentPage } from "@/lib/guards";
import { ParentFrame } from "../components/parent-frame";

export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireParentPage();
  return <ParentFrame who={ctx}>{children}</ParentFrame>;
}
