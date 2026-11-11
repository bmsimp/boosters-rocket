import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { getClubSettings } from "@/lib/settings/club";
import { ClubBar, initials } from "../../components/club-bar";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const [ctx, club] = await Promise.all([requireStaffPage(), getClubSettings()]);
  const e = ctx.effective;
  const nav = [
    { href: "/staff", label: "Home" },
    ...(can(e, "Roster.Read") ? [{ href: "/staff/roster", label: "Roster" }] : []),
    ...(can(e, "Staff.Users.Read") ? [{ href: "/staff/people", label: "Staff" }] : []),
    ...(can(e, "Admin.Roles.ReadWrite") ? [{ href: "/staff/roles", label: "Roles" }] : []),
    ...(can(e, "Settings.Club.Read") ? [{ href: "/staff/settings/club", label: "Club" }] : []),
    ...(can(e, "Settings.SignIn.ReadWrite") ? [{ href: "/staff/settings/sign-in", label: "Sign-in" }] : []),
    ...(can(e, "Settings.Mail.ReadWrite") ? [{ href: "/staff/settings/mail", label: "Mail" }] : []),
    ...(can(e, "Settings.QuickBooks.ReadWrite") ? [{ href: "/staff/settings/quickbooks", label: "QuickBooks" }] : []),
    ...(can(e, "Audit.Log.Read") ? [{ href: "/staff/audit", label: "Audit" }] : []),
  ];
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={nav} mobileMenu
        account={{ href: "/staff", initials: initials(ctx.name), label: `Signed in as ${ctx.name}` }} />
      {children}
    </>
  );
}
