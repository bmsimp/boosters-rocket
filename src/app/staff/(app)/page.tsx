import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { MailWarning } from "./mail-warning";
import { seesMailWarning } from "./mail-warning-rule";
import { QuickBooksWarning } from "./quickbooks-warning";
import { SecretExpiryWarning } from "./secret-expiry";
import { SignOutButton } from "../../components/sign-out-button";

export default async function StaffHome() {
  const ctx = await requireStaffPage();
  return (
    <main className="wrap single">
      <h1 className="page-title">Hi, {ctx.name.split(/[ @]/)[0]}</h1>
      {seesMailWarning(ctx.effective) && <MailWarning canFix={can(ctx.effective, "Settings.Mail.ReadWrite")} />}
      {can(ctx.effective, "Settings.SignIn.ReadWrite") && <SecretExpiryWarning />}
      {can(ctx.effective, "Settings.QuickBooks.ReadWrite") && <QuickBooksWarning />}
      <section className="box" aria-labelledby="next-h"><h2 id="next-h">What&apos;s here so far</h2>
        <p>{ctx.effective.isAdmin ? "You're an admin. Start by setting the club's name and color, then add the rest of the board under Staff." : "Use the menu above for the parts you have access to."}</p>
      </section>
      <section className="box" aria-labelledby="signout-h"><h2 id="signout-h">Signed in as {ctx.email}</h2>
        <p>Sign out when you&apos;re done, especially on a shared computer.</p>
        <SignOutButton door="staff" />
      </section>
    </main>
  );
}
