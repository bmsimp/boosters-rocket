import { mailAttention } from "@/lib/mail/settings";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";
import { LinkButton } from "@/app/components/ui";

/** Shown on the staff home and the Settings pages while parents can't be sent sign-in codes or password links. */
export async function MailWarning({ canFix }: { canFix: boolean }) {
  const a = await mailAttention();
  if (!a) return null;
  return (
    <Notice tone="warning" title="Outgoing mail needs attention" titleId="mail-warn-h">
      <p>{a.kind === "failing"
        ? <>The last email failed{a.since && <> (<LocalTime iso={a.since} />)</>}: {a.lastError} Parents can&apos;t be sent sign-in codes or password links until a send works again.</>
        : a.kind === "not_tested"
          ? "The mail settings changed and haven't been tested since, so parents can't sign in. Open the mail steps and send a test email."
          : "Outgoing mail isn't set up, so parents can't sign in. The mail steps take you through it."}</p>
      <p className="box-foot">{canFix ? <LinkButton plain variant="outlined" href="/staff/settings/mail/setup">Open the mail steps</LinkButton> : "An Admin can fix this under Settings, Outgoing mail."}</p>
    </Notice>
  );
}
