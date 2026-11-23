import { requireStaffPage } from "@/lib/guards";
import { Card, PageHeader } from "@/app/components/ui";
import { SignOutButton } from "@/app/components/sign-out-button";
import { DisplaySettings } from "@/app/(parent)/display/display-settings";
import { NameEdit } from "../settings/staff/people-client";
import { ownContactEmail } from "@/lib/staff/contact-email";
import { ContactEmailForm } from "./contact-email-form";

export const metadata = { title: "Your account" };

/**
 * The signed-in staff member's own page, reached from the initials at the end of the staff bar: their name with Change
 * my name (renameMyselfAction, a staffSelfAction that takes no id), the contact email families see beside their
 * messages (setMyContactEmailAction, a staffSelfAction too), the display choices the parent's Display page has,
 * saved on this device in the same way (`br-display`, src/app/display-script.ts), and Sign out. It is about the staff
 * member themself, so it takes no family or person id and, like the staff home, asks for no permission: every
 * signed-in staff member may open it. It shows nobody else's data, so it is not audited.
 */
export default async function StaffAccountPage() {
  const ctx = await requireStaffPage();
  const contact = await ownContactEmail(ctx.staffUserId);
  return (
    <main className="wrap single staff-account">
      <PageHeader title="Your account" lede="Your name, the email families see, how the portal looks on this device, and signing out." />
      <Card title="Your name" titleId="me-h">
        <p>{ctx.name}</p>
        <NameEdit name={ctx.name} />
      </Card>
      {contact && (
        <Card title="Contact email shown to families" titleId="contact-h"
          description="Families see it on your profile, beside the messages you post. It starts as your sign-in address.">
          <ContactEmailForm shown={contact.shown} own={contact.own} signIn={ctx.email} />
        </Card>
      )}
      <DisplaySettings title={{ text: "Display", id: "display-h" }} />
      <Card title={<>Signed in as {ctx.email}</>} titleId="signout-h" description="Sign out when you're done, especially on a shared computer.">
        <SignOutButton door="staff" />
      </Card>
    </main>
  );
}
