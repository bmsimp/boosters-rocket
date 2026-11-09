import { providerSummaries } from "@/lib/auth/providers";
import { PROVIDER_LABELS } from "@/app/components/sign-in-settings/labels";
import { CalendarDate } from "@/app/components/calendar-date";
import { expiringSecrets } from "./secret-expiry-rule";

/** Shown to people who manage sign-in: secrets that expire within 30 days, or that can't be read. */
export async function SecretExpiryWarning() {
  const items = expiringSecrets(await providerSummaries());
  if (items.length === 0) return null;
  return (
    <section className="box" role="status" aria-labelledby="exp-h"><h2 id="exp-h">Sign-in needs attention</h2>
      <ul>{items.map((i) => (
        <li key={i.key}>{PROVIDER_LABELS[i.key]}: {i.unreadable
          ? "the saved secret can't be read with this server's encryption key. Enter it again."
          : <>the client secret expires <CalendarDate iso={i.expiresAt!.toISOString()} />. Create a new one and save it.</>}</li>
      ))}</ul>
      <p className="box-foot"><a className="btn btn-line" href="/staff/settings/sign-in">Open sign-in settings</a></p>
    </section>
  );
}
