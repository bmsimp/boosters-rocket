import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { MailWarning } from "./mail-warning";
import { seesMailWarning } from "./mail-warning-rule";
import { QuickBooksWarning } from "./quickbooks-warning";
import { SecretExpiryWarning } from "./secret-expiry";
import { TodayBox } from "./today";
import { SignOutButton } from "../../components/sign-out-button";

/**
 * The staff home: what needs doing today, each item to those who hold its permission, then the warnings about the
 * portal's own connections. Counts only, from staff-only queries; like the other lists of many families, not audited.
 */
export default async function StaffHome() {
  const ctx = await requireStaffPage();
  const e = ctx.effective;
  return (
    <main className="wrap single staff-home">
      <h1 className="page-title">Hi, {ctx.name.split(/[ @]/)[0]}</h1>
      <p className="lede">{e.isAdmin ? "You're an admin, so the menu above has every part of the portal. Club, in the menu, sets the club's name and color." : "The menu above has the parts of the portal you have access to."}</p>
      <TodayBox reviews={can(e, "Parents.ReadWrite")} writes={can(e, "Roster.Read")} forms={can(e, "Forms.Signature.Read")} shifts={can(e, "Volunteer.Event.Read")} />
      {seesMailWarning(e) && <MailWarning canFix={can(e, "Settings.Mail.ReadWrite")} />}
      {can(e, "Settings.SignIn.ReadWrite") && <SecretExpiryWarning />}
      {can(e, "Settings.QuickBooks.ReadWrite") && <QuickBooksWarning />}
      <section className="box" aria-labelledby="signout-h"><h2 id="signout-h">Signed in as {ctx.email}</h2>
        <p>Sign out when you&apos;re done, especially on a shared computer.</p>
        <SignOutButton door="staff" />
      </section>
    </main>
  );
}
