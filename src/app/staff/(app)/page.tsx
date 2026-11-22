import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { MailWarning } from "./mail-warning";
import { seesMailWarning } from "./mail-warning-rule";
import { QuickBooksWarning } from "./quickbooks-warning";
import { SecretExpiryWarning } from "./secret-expiry";
import { SigninResets } from "./signin-resets";
import { TodayBox } from "./today";
import { PageHeader } from "@/app/components/ui";

/**
 * The staff home: what needs doing today, each item to those who hold its permission, then the warnings about the
 * portal's own connections. Counts only, from staff-only queries, but for the line of other Admins' sign-in resets, shown
 * to Admins alone, which names each person reset; like the other lists of many families, not audited. The staff
 * member's own name, display and sign out are on their account page (/staff/account), reached from the bar's initials.
 */
export default async function StaffHome() {
  const ctx = await requireStaffPage();
  const e = ctx.effective;
  return (
    <main className="wrap single staff-home">
      <PageHeader title={<>Hi, {ctx.name.split(/[ @]/)[0]}</>}
        lede={e.isAdmin ? "You're an admin, so the menu above has every part of the portal. Start by adding the rest of the board under Staff." : "The menu above has the parts of the portal you have access to."} />
      <TodayBox writes={can(e, "Roster.Read")} forms={can(e, "Forms.Signature.Read")} shifts={can(e, "Volunteer.Event.Read")} />
      {seesMailWarning(e) && <MailWarning canFix={can(e, "Settings.Mail.ReadWrite")} />}
      {can(e, "Settings.SignIn.ReadWrite") && <SecretExpiryWarning />}
      {can(e, "Settings.QuickBooks.ReadWrite") && <QuickBooksWarning />}
      {/* Every other Admin's sign-in resets of the last 7 days (the sign-in release, slice SI-9a): Admin-only, as the reset is. */}
      {can(e, "Parents.SignInReset.ReadWrite") && <SigninResets viewerStaffId={ctx.staffUserId} />}
    </main>
  );
}
