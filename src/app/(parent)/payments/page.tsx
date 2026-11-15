import { requireParentPage } from "@/lib/guards";
import { loadFamilyMoney } from "@/lib/money/family-money";
import { loadMyFamily } from "@/lib/parents/my-family";
import { getClubSettings } from "@/lib/settings/club";
import { NotSetUpBox } from "../family-boxes";
import { MoneySection, PaidSection } from "../money-box";

export const metadata = { title: "Payments" };

export default async function PaymentsPage() {
  const ctx = await requireParentPage("/payments");
  // Money is shown only for a family the roster may show, the rule Home goes by (loadMyFamily): not for a family
  // QuickBooks has made inactive, a roster cache from another company than the connected one, or a broken shape.
  const [family, club] = await Promise.all([loadMyFamily(ctx), getClubSettings()]);
  if (!family) {
    return (
      <main className="wrap single">
        <h1 className="page-title">Payments</h1>
        <NotSetUpBox treasurerEmail={club.treasurerEmail} />
      </main>
    );
  }
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
