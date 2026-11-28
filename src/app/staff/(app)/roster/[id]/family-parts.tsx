// The parts of a family's page that stand without the books (stage 5's slice P2): the family's portal sign-ins with
// adding a guardian, and the way to its other staff pages. Both the page with QuickBooks and the page with no books
// draw them (./page.tsx, ../by-hand.tsx).
import Link from "next/link";
import type { AppFamilyId } from "@/lib/families/ids";
import type { FamilySignin } from "@/lib/parents/directory";
import { AddGuardianForm } from "@/app/staff/(app)/parents/forms";
import { GuardianChange } from "@/app/staff/(app)/parents/guardian-change";
import { addGuardianAction } from "@/app/staff/(app)/parents/actions";
import { Card, DataTable, EmptyState, List, ListRow, Notice, StatusBadge, type Column } from "@/app/components/ui";
import { accessTone } from "@/app/staff/(app)/parents/access-state";
import { familyBalancePage, familyBuyoutsPage, familyCreditPage, familyProgressPage } from "@/app/staff/(app)/family-pages";

/**
 * `links` is for staff with `Parents.ReadWrite`, who may open a person's page. `changes` is for staff with
 * `Roster.Family.ReadWrite`, who change the family: only they get the ways to remove, reinstate and add a guardian
 * (stage 3's slice 7b, in the portal only), which give or end an address's sign-in for it. `addable` says why a
 * guardian can't be added now, or null when one can: the action checks it again, under the roster lock. A family with
 * no link takes guardians too (stage 3's slice 9d).
 */
export function SignIns({ familyId, signins, links, changes, addable, inQuickBooks }: { familyId: AppFamilyId; signins: FamilySignin[]; links: boolean; changes: boolean; addable: string | null;
  /** Where the books stand for each guardian's own customer, in words; null with no books, and the column is left out. */
  inQuickBooks: Map<string, string> | null }) {
  const columns: Column<FamilySignin>[] = [
    { key: "name", header: "Person", rowHeader: true, cell: (s) => (links ? <Link href={`/staff/parents/${s.parentId}`}>{s.name}</Link> : s.name) },
    { key: "email", header: "Email", cell: (s) => s.email },
    { key: "words", header: "Sign-in", cell: (s) => <StatusBadge tone={accessTone(s.kind, s.hasPassword)}>{s.words}</StatusBadge> },
    // Where QuickBooks stands for the guardian's own Parent customer (stage 3's slice 9h), in words.
    ...(inQuickBooks ? [{ key: "quickbooks", header: "In QuickBooks", cell: (s: FamilySignin) => inQuickBooks.get(s.guardianId) ?? "Nothing in QuickBooks for this membership." }] : []),
    ...(changes ? [{ key: "change", header: "Change", quiet: true, cell: (s: FamilySignin) => <GuardianChange name={s.name} removeLabel={`Remove ${s.name} from this family`} guardianId={s.guardianId} open={s.open} reinstatable={s.reinstatable} /> }] : []),
  ];
  return (
    <Card title="Portal sign-ins" titleId="entry-signins-h" description={<>The family&apos;s guardians in the portal, and whether each can sign in.</>}>
      {signins.length === 0 ? <EmptyState title="Nobody can sign in for it yet." /> : (
        <DataTable caption="Each person, and whether they can sign in" captionHidden rows={signins} rowKey={(s) => s.guardianId} columns={columns} />
      )}
      {changes && (
        <>
          <h3 className="table-head">Add a guardian</h3>
          {addable !== null ? <Notice tone="info" live="none">{addable}</Notice> : (
            <>
              <p>They sign in with this address and a password they choose from the welcome email{inQuickBooks ? ", and where the books have parents they get their own Parent customer under the family" : ""}. If someone in the portal already has this address, you&apos;re asked first whether it&apos;s the same person.</p>
              <AddGuardianForm act={addGuardianAction.bind(null, String(familyId))} />
            </>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * The family's other staff pages, each for staff who may open it: the way from the roster to a family's money, its
 * season, its volunteering and its buy-outs, without going back to a list. Each of those pages records its own read.
 */
export function Elsewhere({ familyId, money, season, credit, buyouts }: { familyId: AppFamilyId; money: boolean; season: boolean; credit: boolean; buyouts: boolean }) {
  if (!money && !season && !credit && !buyouts) return null;
  return (
    <Card title="More about this family" titleId="entry-elsewhere-h">
      <List>
        {money && <ListRow title={<Link className="link-line" href={familyBalancePage(familyId)}>What it owes</Link>} />}
        {season && <ListRow title={<Link className="link-line" href={familyProgressPage(familyId)}>Where it stands this season</Link>} />}
        {credit && <ListRow title={<Link className="link-line" href={familyCreditPage(familyId)}>Its volunteering credit</Link>} />}
        {buyouts && <ListRow title={<Link className="link-line" href={familyBuyoutsPage(familyId)}>Its volunteer buy-outs</Link>} />}
      </List>
    </Card>
  );
}
