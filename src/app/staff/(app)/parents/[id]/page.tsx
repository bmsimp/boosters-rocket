import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { getPerson, type PersonFamily } from "@/lib/parents/directory";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import { LocalTime } from "@/app/components/local-time";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { StateWords } from "@/app/components/state-words";
import { NameForm, NoteAction, OneButton } from "../forms";
import { blockAction, unblockAction, resendWelcomeAction, renamePersonAction } from "../actions";
import { GuardianChange } from "../guardian-change";
import { accessState } from "../access-state";
import { familyPage } from "@/app/staff/(app)/family-pages";
import { lifeWords } from "@/lib/parents/link-delivery";
import { LINK_LIFE_MS } from "@/lib/parents/signin-links";
import { guardianStandings } from "@/lib/roster/writes";

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
  return (
    <main className="wrap single">
      <h1 className="page-title">{p.name}</h1>
      <p className="lede">{p.email}. <Link href="/staff/parents">Back to Parents</Link></p>

      <section className="box" aria-labelledby="pf-h"><h2 id="pf-h">Families</h2>
        <StateWords state={p.blocked ? "waived" : canSignIn && p.hasPassword ? "done" : "todo"}
          words={p.blocked ? "Blocked: can't sign in to any family" : canSignIn ? (p.hasPassword ? "Can sign in" : "Can sign in once they choose a password") : "Can't sign in to any family right now"} />
        {p.families.length === 0 ? <p>This person isn&apos;t linked to any family.</p> : (
          <DataTable caption="Each family this person is linked to, and whether they can sign in to it" captionHidden
            rows={p.families} rowKey={(f) => f.guardianId} columns={[
              // A previous company's row carries that company's ID, which names some other family (or none) now; a family
              // made inactive in the portal with no link has no page to open (stage 3's slice 9d).
              { key: "family", header: "Family", rowHeader: true, cell: (f) => (f.previousCompany || f.familyId === null || !f.pageStands ? f.familyName
                : <Link href={familyPage(f.familyId)}>{f.familyName}</Link>) },
              { key: "access", header: "Sign-in", cell: (f) => <StateWords state={accessState(f.kind, p.hasPassword)} words={f.words} /> },
              { key: "quickbooks", header: "In QuickBooks", cell: (f) => inQuickBooks.get(f.guardianId) ?? "Nothing in QuickBooks for this membership." },
              ...(changesGuardians ? [{ key: "change", header: "Change", quiet: true, cell: (f: PersonFamily) => <GuardianChange name={f.familyName} guardianId={f.guardianId} open={f.open} reinstatable={f.reinstatable} /> }] : []),
            ]} />
        )}
        <dl className="details">
          <dt>Last signed in</dt><dd>{p.lastSigninAt ? <LocalTime iso={p.lastSigninAt} /> : "Never"}</dd>
          <dt>Password</dt><dd>{p.hasPassword ? "Chosen" : "Not chosen yet"}</dd>
          {/* Owed while welcomed before: the mail an Admin asked for on the parents' settings page, with a link to choose a password. */}
          <dt>Welcome email</dt><dd>{p.welcomedAt ? <>Sent <LocalTime iso={p.welcomedAt} />{p.welcomeOwed ? ". An email with a link to choose a password is waiting to be sent" : null}</>
            : p.welcomeOwed ? "Waiting to be sent" : "Not sent"}</dd>
        </dl>
        <p className="hint">The name and sign-in email are the portal&apos;s own. A parent changes their own sign-in email from the Family page; a change made in QuickBooks doesn&apos;t change them. A guardian is added to a family from that family&apos;s page. Where the club&apos;s books have parents of their own, each membership has its own Parent customer in QuickBooks under the family: a new name here is sent to each, and removing them makes theirs inactive only when it has no balance the portal can read, owed or a credit.</p>
      </section>

      <section className="box" aria-labelledby="pn-h"><h2 id="pn-h">Name</h2>
        <p>Changes their name in the portal: what staff see, and what the portal calls them. QuickBooks isn&apos;t changed.</p>
        <NameForm name={p.name} act={renamePersonAction.bind(null, p.parentId)} />
      </section>

      <section className="box" aria-labelledby="pw-h"><h2 id="pw-h">Welcome email</h2>
        <p>{p.hasPassword ? "Sends the welcome again, now: where to sign in, and that they sign in with this address and the password they chose."
          : `Sends the welcome again, now, with a new link to choose their password. The link works once, for ${lifeWords(LINK_LIFE_MS.setup)}, and takes the place of any earlier one they haven't used, once the email has gone.`}</p>
        {parentDoorClosed(settings) ? <Notice tone="info" live="none">Parent sign-ins are switched off, so no welcome can be sent.</Notice>
          : canSignIn ? <OneButton label="Resend welcome email" pendingLabel="Sending…" act={resendWelcomeAction.bind(null, p.parentId)} />
          : <Notice tone="info" live="none">{p.blocked ? "This person is blocked, so no email can be sent." : "This person can't sign in to any family right now, so there is nothing to welcome them to."}</Notice>}
      </section>

      <section className="box" aria-labelledby="pb-h"><h2 id="pb-h">{p.blocked ? "Blocked" : "Block"}</h2>
        {p.blocked ? (
          <>
            <Notice tone="warning" live="none">Blocked{p.blockedAt ? <> <LocalTime iso={p.blockedAt} /></> : null}. Reason: {p.blockedReason ?? "none recorded"}</Notice>
            <p>{p.hasPassword
              ? "Unblocking lets them sign in again with the password they had, to each family whose sign-in is still open. The phones and computers the portal remembered for them stay forgotten, and a link they had before the block no longer works."
              : "Unblocking lets them sign in again to each family whose sign-in is still open, once they choose a password: they haven't chosen one, and a link they had before the block no longer works, so send them the welcome again (Resend welcome email) once they are unblocked. The phones and computers the portal remembered for them stay forgotten."}</p>
            <OneButton label="Unblock" pendingLabel="Unblocking…" act={unblockAction.bind(null, p.parentId)} />
          </>
        ) : (
          <>
            <p>Blocking signs this person out of every family at once, and stops them signing in, getting sign-in codes or using a password link. The phones and computers the portal remembered for them are forgotten; their password is kept. They aren&apos;t told. Use it for a custody matter or misuse.</p>
            <NoteAction label="Block" field="Why? (staff only)" pendingLabel="Blocking…" act={blockAction.bind(null, p.parentId)} />
          </>
        )}
      </section>
    </main>
  );
}
