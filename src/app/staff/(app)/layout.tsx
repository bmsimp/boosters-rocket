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
    ...(can(e, "Parents.ReadWrite") ? [{ href: "/staff/parents", label: "Parents" }] : []),
    // Two entries: someone who only ticks names off (Season.Progress.*) can't open the set-up pages.
    ...(can(e, "Season.Steps.Read") ? [{ href: "/staff/seasons", label: "Seasons" }] : []),
    ...(can(e, "Season.Progress.Read") ? [{ href: "/staff/seasons/progress", label: "Progress" }] : []),
    ...(can(e, "Finance.Balance.Read") ? [{ href: "/staff/balances", label: "Balances" }] : []),
    ...(can(e, "Volunteer.Event.Read") ? [{ href: "/staff/volunteer", label: "Volunteering" }] : []),
    ...(can(e, "Staff.Users.Read") ? [{ href: "/staff/people", label: "Staff" }] : []),
    ...(can(e, "Admin.Roles.ReadWrite") ? [{ href: "/staff/roles", label: "Roles" }] : []),
    ...(can(e, "Settings.Club.Read") ? [{ href: "/staff/settings/club", label: "Club" }] : []),
    ...(can(e, "Settings.SignIn.ReadWrite") ? [{ href: "/staff/settings/sign-in", label: "Sign-in" }] : []),
    ...(can(e, "Settings.Mail.ReadWrite") ? [{ href: "/staff/settings/mail", label: "Mail" }] : []),
    ...(can(e, "Settings.QuickBooks.ReadWrite") ? [{ href: "/staff/settings/quickbooks", label: "QuickBooks" }] : []),
    ...(can(e, "Settings.Forms.ReadWrite") ? [{ href: "/staff/settings/forms", label: "Forms" }] : []),
    ...(can(e, "Settings.Parents.ReadWrite") ? [{ href: "/staff/settings/parents", label: "Parent sign-ins" }] : []),
    ...(can(e, "Audit.Log.Read") ? [{ href: "/staff/audit", label: "Audit" }] : []),
    ...(can(e, "Admin.Health.Read") ? [{ href: "/staff/health", label: "Health" }] : []),
  ];
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={nav} mobileMenu
        account={{ href: "/staff", initials: initials(ctx.name), label: `Signed in as ${ctx.name}` }} />
      {children}
    </>
  );
}
