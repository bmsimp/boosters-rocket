import Link from "next/link";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";
import { NO_FILTERS, filtersQuery } from "@/lib/audit/query";
import { recentSigninResets } from "@/lib/parents/signin-reset";

/**
 * Shown on the staff home to every Admin but the one who did it, for 7 days after an Admin reset a parent's sign-in (the
 * sign-in release, slice SI-9a; open question 22): the reset's only email goes to the address being reset, the very
 * mailbox a caller may hold, so another Admin seeing a reset nobody expected is the second notice. Read from the audit
 * rows; who reset, whose sign-in and when, never the reason, which the audit log holds and the line links to. Showing
 * it writes no audit row, as the rest of the home doesn't.
 */
export async function SigninResets({ viewerStaffId }: { viewerStaffId: string }) {
  const resets = await recentSigninResets(viewerStaffId);
  if (resets.length === 0) return null;
  return (
    <Notice tone="info" title="Sign-in resets this week" titleId="resets-h">
      <ul className="notice-list">{resets.map((r) => {
        const who = r.by ?? "Someone";
        const audit = `/staff/audit${filtersQuery({ ...NO_FILTERS, action: "parent.signin.reset", record: { type: "parent", id: r.parentId } })}`;
        return (
          <li key={r.auditId}>
            {r.name !== null
              ? <>{who} reset <Link href={`/staff/parents/${r.parentId}`}>{r.name}</Link>&apos;s sign-in <LocalTime iso={r.at.toISOString()} />.</>
              : <>{who} reset the sign-in of a person no longer in the portal <LocalTime iso={r.at.toISOString()} />.</>}
            {" "}<Link href={audit}>In the audit log<span className="visually-hidden">: the reset of {r.name ?? "a person no longer in the portal"}</span></Link>
          </li>
        );
      })}</ul>
      <p>If you didn&apos;t expect one of these, ask whoever did it, and read their reason in the audit log.</p>
    </Notice>
  );
}
