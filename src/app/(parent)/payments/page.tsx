import { requireParentPage } from "@/lib/guards";
import { loadFamilyMoney } from "@/lib/money/family-money";
import { loadMyBuyoutInvoices } from "@/lib/money/my-buyout-invoices";
import { loadMyFamily } from "@/lib/parents/my-family";
import { getClubSettings } from "@/lib/settings/club";
import { NotSetUpBox } from "../family-boxes";
import { MoneySection, PaidSection } from "../money-box";

export const metadata = { title: "Payments" };

export default async function PaymentsPage() {
  const ctx = await requireParentPage("/payments");
  // Money is shown only for a family the portal may show, the rule Home goes by (loadMyFamily): not for a family whose
  // own record is inactive. Whose figures may show, from which company and under which shape, is loadFamilyMoney()'s.
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
  // The money first: a stale row is read again before anything is drawn. Then which invoices are the family's own
  // volunteer buy-outs, by the family's own buy-outs (never an invoice id the browser names).
  const money = await loadFamilyMoney(ctx.familyId);
  const buyouts = await loadMyBuyoutInvoices(ctx.familyId);
  return (
    <main className="wrap single">
      <h1 className="page-title">Payments</h1>
      <p className="lede">What your family owes the boosters, and what you&apos;ve paid.</p>
      <MoneySection money={money} buyouts={buyouts} />
      <PaidSection money={money} buyouts={buyouts} />
    </main>
  );
}
