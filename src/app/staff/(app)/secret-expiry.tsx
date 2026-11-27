import { providerSummaries } from "@/lib/auth/providers";
import { PROVIDER_LABELS } from "@/app/components/sign-in-settings/labels";
import { usesCertificate } from "@/lib/auth/provider-fields";
import { CalendarDate } from "@/app/components/calendar-date";
import { Notice } from "@/app/components/notice";
import { LinkButton } from "@/app/components/ui";
import { expiringSecrets, certificateNextStep } from "./secret-expiry-rule";

/** Shown to people who manage sign-in: secrets and certificates that expire within 30 days, or that can't be read. */
export async function SecretExpiryWarning() {
  const items = expiringSecrets(await providerSummaries());
  if (items.length === 0) return null;
  return (
    <Notice tone="warning" title="Sign-in needs attention" titleId="exp-h">
      <ul className="notice-list">{items.map((i) => (
        <li key={i.key}>{PROVIDER_LABELS[i.key]}: {usesCertificate(i.key)
          ? (i.unreadable
            ? <>the certificate&apos;s key can&apos;t be read with this server&apos;s encryption key{i.pendingCertificate ? ", and " : ". "}{certificateNextStep(i)}</>
            : <>the certificate expires <CalendarDate iso={i.expiresAt!.toISOString()} />{i.pendingCertificate ? ", and " : ". "}{certificateNextStep(i)}</>)
          : (i.unreadable
            ? "the saved secret can't be read with this server's encryption key. Enter it again."
            : <>the client secret expires <CalendarDate iso={i.expiresAt!.toISOString()} />. Create a new one and save it.</>)}</li>
      ))}</ul>
      <p className="box-foot"><LinkButton plain variant="outlined" href="/staff/settings/sign-in">Open sign-in settings</LinkButton></p>
    </Notice>
  );
}
