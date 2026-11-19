import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { getPerson } from "@/lib/parents/directory";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import { LocalTime } from "@/app/components/local-time";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { StateWords } from "@/app/components/state-words";
import { NoteAction, OneButton } from "../forms";
import { blockAction, unblockAction, resendWelcomeAction } from "../actions";
import { accessState } from "../access-state";
import { familyPage } from "@/app/staff/(app)/family-pages";

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
  return (
    <main className="wrap single">
      <h1 className="page-title">{p.name}</h1>
      <p className="lede">{p.email}. <Link href="/staff/parents">Back to Parents</Link></p>

      <section className="box" aria-labelledby="pf-h"><h2 id="pf-h">Families</h2>
        <StateWords state={p.blocked ? "waived" : canSignIn ? "done" : "todo"}
          words={p.blocked ? "Blocked: can't sign in to any family" : canSignIn ? "Can sign in" : "Can't sign in to any family right now"} />
        {p.families.length === 0 ? <p>This person isn&apos;t linked to any family.</p> : (
          <DataTable caption="Each family this person is linked to, and whether they can sign in to it" captionHidden
            rows={p.families} rowKey={(f) => `${f.previousCompany ? "old" : "now"}|${f.familyQboId}`} columns={[
              // A previous company's row carries that company's ID, which names some other family (or none) now.
              { key: "family", header: "Family", rowHeader: true, cell: (f) => (f.previousCompany || f.familyId === null ? f.familyName
                : <Link href={familyPage(f.familyId)}>{f.familyName}</Link>) },
              { key: "access", header: "Sign-in", cell: (f) => <StateWords state={accessState(f.kind)} words={f.words} /> },
            ]} />
        )}
        <dl className="details">
          <dt>Last signed in</dt><dd>{p.lastSigninAt ? <LocalTime iso={p.lastSigninAt} /> : "Never"}</dd>
          <dt>Welcome email</dt><dd>{p.welcomedAt ? <>Sent <LocalTime iso={p.welcomedAt} /></> : p.welcomeOwed ? "Waiting to be sent" : "Not sent"}</dd>
        </dl>
        <p className="hint">The name and email address come from QuickBooks. Staff who may change the roster can rename a parent from their family&apos;s page under Roster; an email address is changed in QuickBooks, followed by Refresh now on the roster.</p>
      </section>

      <section className="box" aria-labelledby="pw-h"><h2 id="pw-h">Welcome email</h2>
        <p>Sends the welcome again, now: where to sign in, and that they sign in with this address and a code.</p>
        {parentDoorClosed(settings) ? <Notice tone="info" live="none">Parent sign-ins are switched off, so no welcome can be sent.</Notice>
          : canSignIn ? <OneButton label="Resend welcome email" pendingLabel="Sending…" act={resendWelcomeAction.bind(null, p.parentId)} />
          : <Notice tone="info" live="none">{p.blocked ? "This person is blocked, so no email can be sent." : "This person can't sign in to any family right now, so there is nothing to welcome them to."}</Notice>}
      </section>

      <section className="box" aria-labelledby="pb-h"><h2 id="pb-h">{p.blocked ? "Blocked" : "Block"}</h2>
        {p.blocked ? (
          <>
            <Notice tone="warning" live="none">Blocked{p.blockedAt ? <> <LocalTime iso={p.blockedAt} /></> : null}. Reason: {p.blockedReason ?? "none recorded"}</Notice>
            <p>Unblocking gives back exactly the access they had.</p>
            <OneButton label="Unblock" pendingLabel="Unblocking…" act={unblockAction.bind(null, p.parentId)} />
          </>
        ) : (
          <>
            <p>Blocking signs this person out of every family at once and stops sign-in codes. They aren&apos;t told. Use it for a custody matter or misuse; a family that has left is handled by making it inactive in QuickBooks.</p>
            <NoteAction label="Block" field="Why? (staff only)" pendingLabel="Blocking…" act={blockAction.bind(null, p.parentId)} />
          </>
        )}
      </section>
    </main>
  );
}
