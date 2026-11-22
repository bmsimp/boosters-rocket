import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { getPerson, personContact, type PersonFamily } from "@/lib/parents/directory";
import { whoseDetails } from "@/lib/parents/my-family";
import { getShape } from "@/lib/roster/shape";
import { familyPagesStand } from "@/lib/roster/queries";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import { Card, DataTable, EmptyState, HowThisWorks, KeyValue, List, ListRow, LocalTime, Notice, PageHeader, StatusBadge } from "@/app/components/ui";
import { DetailsForm, NameForm, NoteAction, OneButton, ResetSigninForm } from "../forms";
import { blockAction, unblockAction, resendWelcomeAction, renamePersonAction, resetSigninAction, savePersonDetailsAction } from "../actions";
import { GuardianChange } from "../guardian-change";
import { accessTone } from "../access-state";
import { familyPage } from "@/app/staff/(app)/family-pages";
import { lifeWords } from "@/lib/parents/link-delivery";
import { LINK_LIFE_MS } from "@/lib/parents/signin-links";
import { guardianStandings, keptContactsOf } from "@/lib/roster/writes";
import { signinHeld } from "@/lib/parents/signin-reset";

export const metadata = { title: "Parent" };

export const dynamic = "force-dynamic";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Parents.ReadWrite");
  const { id } = await params;
  const [p, settings] = await Promise.all([getPerson(id), getParentSettings()]);
  if (!p) notFound();
  // A staff read of family data (spec §7): recorded before anything is shown.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "parent.read", permission: "Parents.ReadWrite",
    targetType: "parent", targetId: p.parentId, ip: ctx.ip });
  const canSignIn = !p.blocked && p.families.some((f) => f.kind === "can");
  // Removing and reinstating give or end the person's sign-in for a family: Roster.Family.ReadWrite's, beside this page's own.
  const changesGuardians = can(ctx.effective, "Roster.Family.ReadWrite");
  // Where QuickBooks stands for each membership's own Parent customer (stage 3's slice 9h), in words; QuickBooks text as text.
  const inQuickBooks = await guardianStandings(p.families.filter((f) => !f.previousCompany).map((f) => ({ guardianId: f.guardianId, familyId: f.familyId, name: p.name, open: f.open })));
  // A guardian's phone and mailing address are the portal's own (stage 3's slices 11a to 11c): each person's in books with
  // parents of their own, shown and changed here; otherwise each family's, on each family's page. What QuickBooks holds
  // for a kept difference is shown only in Reconciliation's compare view, audited there, which is linked for a reader
  // who may open that page (its own guard, Roster.Read).
  const whose = whoseDetails(await getShape());
  const contact = whose === "person" ? await personContact(p.parentId) : null;
  const kept = await keptContactsOf(p.families.filter((f) => !f.previousCompany && f.open).map((f) => f.guardianId));
  const mayCompare = can(ctx.effective, "Roster.Read");
  // Only the families they are a guardian of now: a removed membership's family details are no longer theirs.
  // A family's page answers Not found while the membership shape is missing or names a customer type QuickBooks no
  // longer has, or the roster cache is another company's: then none is linked for the details, and the page says why.
  const pagesStand = whose === "family" ? await familyPagesStand() : true;
  // An Admin's reset of their sign-in (the sign-in release, slice SI-9a): Admin-only, beside this page's own permission.
  // What they sign in with now is read only for a reader who may reset it, counts only.
  const mayReset = can(ctx.effective, "Parents.SignInReset.ReadWrite");
  const held = mayReset ? await signinHeld(p.parentId) : null;
  const familyPages = !pagesStand ? [] : p.families.flatMap((f) => (!f.previousCompany && f.open && f.familyId !== null && f.pageStands ? [{ key: f.guardianId, id: f.familyId, name: f.familyName }] : []));
  // When they last signed in, their password and their welcome: shown to every reader of the page.
  const signinFacts = [
    { key: "signin", label: "Last signed in", value: p.lastSigninAt ? <LocalTime iso={p.lastSigninAt} /> : "Never" },
    { key: "password", label: "Password", value: p.hasPassword ? "Chosen" : "Not chosen yet" },
    // Owed while welcomed before: the mail an Admin asked for on the parents' settings page, with a link to choose a password.
    { key: "welcome", label: "Welcome email", value: p.welcomedAt ? <>Sent <LocalTime iso={p.welcomedAt} />{p.welcomeOwed ? ". An email with a link to choose a password is waiting to be sent" : null}</>
      : p.welcomeOwed ? "Waiting to be sent" : "Not sent" },
  ];
  return (
    <main className="wrap single">
      <PageHeader title={p.name} back={{ href: "/staff/parents", label: "Back to Parents" }} lede={p.email} />

      <Card title="Families" titleId="pf-h">
        {p.families.length === 0 ? <EmptyState title={<>This person isn&apos;t linked to any family.</>} /> : (
          <DataTable caption="Each family this person is linked to, and whether they can sign in to it" captionHidden
            rows={p.families} rowKey={(f) => f.guardianId} columns={[
              // A previous company's row carries that company's ID, which names some other family (or none) now; a family
              // made inactive in the portal with no link has no page to open (stage 3's slice 9d).
              { key: "family", header: "Family", rowHeader: true, cell: (f) => (f.previousCompany || f.familyId === null || !f.pageStands ? f.familyName
                : <Link href={familyPage(f.familyId)}>{f.familyName}</Link>) },
              { key: "access", header: "Sign-in", cell: (f) => <StatusBadge tone={accessTone(f.kind, p.hasPassword)}>{f.words}</StatusBadge> },
              { key: "quickbooks", header: "In QuickBooks", cell: (f) => {
                const said = inQuickBooks.get(f.guardianId) ?? "Nothing in QuickBooks for this membership.";
                const item = kept.get(f.guardianId);
                if (item === undefined) return said;
                return <>{said}{mayCompare ? <Link className="link-line" href={`/staff/reconciliation?compare=${item}#writes-h`}>Compare the two<span className="visually-hidden"> for {f.familyName}</span></Link>
                  : <span className="when">Someone who may see the Reconciliation page can compare the two there.</span>}</>;
              } },
              ...(changesGuardians ? [{ key: "change", header: "Change", quiet: true, cell: (f: PersonFamily) => <GuardianChange name={f.familyName} guardianId={f.guardianId} open={f.open} reinstatable={f.reinstatable} /> }] : []),
            ]} />
        )}
        <p className="hint">Their name, sign-in email, phone and mailing address are the portal&apos;s own. A change made in QuickBooks doesn&apos;t change them. Add a guardian to a family from that family&apos;s page.</p>
        <HowThisWorks>
          <p>Each family they&apos;re in has its own Parent customer in QuickBooks, where the books have parents. A new name here is sent to each. Removing them makes theirs inactive only if it has no balance the portal can read, owed or a credit.</p>
        </HowThisWorks>
      </Card>

      {/* How they sign in: its own card, or, for an Admin who may reset it, the top of Reset sign-in. */}
      {!held && <Card title="Sign-in" titleId="ps-h"><KeyValue items={signinFacts} /></Card>}

      <Card title="Phone and mailing address" titleId="pd-h">
        {contact ? (
          <>
            <p>They can change these on their Family page, and you can change them here. Each change is saved here first, then sent to their Parent customer in each family. If QuickBooks has details the portal didn&apos;t know of, nothing is sent over them. Reconciliation lists those, so you can compare the two.</p>
            <DetailsForm initial={contact} act={savePersonDetailsAction.bind(null, p.parentId)} />
          </>
        ) : (
          <>
            <p>The books have no parents of their own, so each family has one phone and mailing address, shared by its guardians. Change them on the family&apos;s page.</p>
            {!pagesStand && <Notice tone="info" live="none">Staff can&apos;t see or change a family&apos;s phone and mailing address right now: family pages are closed until the customer types are set again in Settings, QuickBooks. The parent can still change them on their Family page.</Notice>}
            {familyPages.length > 0 && <List>{familyPages.map((f) => <ListRow key={f.key} title={<Link className="link-line" href={familyPage(f.id)}>{f.name}</Link>} />)}</List>}
          </>
        )}
      </Card>

      <Card title="Name" titleId="pn-h" description={<>Changes the name staff see and the portal uses. Where the books have parents, it&apos;s sent to their Parent customer in each family.</>}>
        <NameForm name={p.name} act={renamePersonAction.bind(null, p.parentId)} />
      </Card>

      <Card title="Welcome email" titleId="pw-h">
        <p>{p.hasPassword ? "Sends the welcome again: where to sign in, with this address and their password."
          : `Sends the welcome again, with a new link to choose a password. It works once, for ${lifeWords(LINK_LIFE_MS.setup)}, and replaces any earlier unused link once the email has gone.`}</p>
        {parentDoorClosed(settings) ? <Notice tone="info" live="none">Parent sign-ins are switched off, so no welcome can be sent.</Notice>
          : canSignIn ? <OneButton label="Resend welcome email" pendingLabel="Sending…" act={resendWelcomeAction.bind(null, p.parentId)} />
          : <Notice tone="info" live="none">{p.blocked ? "This person is blocked, so no email can be sent." : "This person can't sign in to any family right now, so there is nothing to welcome them to."}</Notice>}
      </Card>

      <Card title={p.blocked ? "Blocked" : "Block"} titleId="pb-h">
        {p.blocked ? (
          <>
            <Notice tone="warning" live="none">Blocked{p.blockedAt ? <> <LocalTime iso={p.blockedAt} /></> : null}. Reason: {p.blockedReason ?? "none recorded"}</Notice>
            <p>{p.hasPassword
              ? "They can sign in again with their old password, to each family still open to them. Remembered devices stay forgotten, and links from before the block don't work."
              : "They can sign in again to each family still open to them once they choose a password. Links from before the block don't work, so resend the welcome after unblocking. Remembered devices stay forgotten."}</p>
            <OneButton label="Unblock" pendingLabel="Unblocking…" act={unblockAction.bind(null, p.parentId)} />
          </>
        ) : (
          <>
            <p>Signs them out of every family at once, and stops them signing in, getting codes or using a password link. Remembered devices are forgotten, and their password is kept. They aren&apos;t told. For a custody matter or misuse.</p>
            <NoteAction label="Block" field="Why? (staff only)" pendingLabel="Blocking…" variant="danger" act={blockAction.bind(null, p.parentId)} />
          </>
        )}
      </Card>

      {held && (
        <Card title="Reset sign-in" titleId="pr-h">
          <KeyValue items={[
            ...signinFacts,
            { key: "passkeys", label: "Passkeys", value: held.passkeys },
            { key: "app", label: "Authenticator app", value: held.app ? "On" : "Off" },
            { key: "backup", label: "Backup codes left", value: held.backupCodes },
            { key: "devices", label: "Phones and computers remembered", value: held.devices },
            { key: "sessions", label: "Signed in now", value: held.sessions === 1 ? "On 1 phone or computer" : `On ${held.sessions} phones or computers` },
          ]} />
          {p.blocked ? <Notice tone="info" live="none">This person is blocked, so there&apos;s nothing to reset. Unblock them first if they should sign in again.</Notice>
            : !canSignIn ? <Notice tone="info" live="none">This person can&apos;t sign in to any family right now, so there&apos;s nothing to reset.</Notice>
            : parentDoorClosed(settings) ? <Notice tone="info" live="none">Parent sign-ins are switched off, so there&apos;s nothing to reset.</Notice>
            : (
              <>
                <p>Resetting signs this person out everywhere and removes their password, passkeys, authenticator app and backup codes, and the phones and computers the portal remembered for them. They&apos;re emailed a new link to choose a password, which works once, for {lifeWords(LINK_LIFE_MS.setup)}. {settings.level === "strict"
                  ? "The club is at Strict: once they've chosen a password, the portal asks them to add a passkey or an authenticator app before they see anything else."
                  : "Choosing it signs them in on that phone or computer; on another one they sign in with that password and a code emailed to them. They can then add a passkey or an authenticator app again."} Their families and forms stay as they are.</p>
                <p>Use it when they&apos;ve lost their phone, passkey or authenticator app and their backup codes, or when passkeys stopped working because the portal&apos;s address changed.</p>
                <Notice tone="warning" live="none">Before you reset, call them back on a number the club already holds (on this page, on their family&apos;s page, or in the club&apos;s own records), never one the caller gives you, and make sure they asked for this. The link goes to the email address being reset, so whoever reads that mailbox can use it.</Notice>
                <p className="hint">Only Admins can do this, and every other Admin sees it on their home page for a week.</p>
                <ResetSigninForm act={resetSigninAction.bind(null, p.parentId)} />
              </>
            )}
        </Card>
      )}
    </main>
  );
}
