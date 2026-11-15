import { requireParentPage } from "@/lib/guards";
import { loadFamilyMoney } from "@/lib/money/family-money";
import { MoneySection, PaidSection } from "../money-box";

export const metadata = { title: "Payments" };

export default async function PaymentsPage() {
  const ctx = await requireParentPage();
  // The family comes from the session and nothing else: no address, query string or form chooses whose invoices these are.
  const money = await loadFamilyMoney(ctx.familyQboId);
  return (
    <main className="wrap single">
      <h1 className="page-title">Payments</h1>
      <p className="lede">What your family owes the boosters, and what you&apos;ve paid.</p>
      <MoneySection money={money} />
      <PaidSection money={money} />
    </main>
  );
}
