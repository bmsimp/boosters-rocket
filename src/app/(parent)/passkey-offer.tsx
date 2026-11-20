"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { safely } from "@/app/components/action-error";
import { offerDevice, type OfferDevice } from "@/app/components/pwa/install-platform";
import { PASSKEY_OFFER_COPY as WORDS } from "@/lib/parents/passkey-offer-copy";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { BackupCodesShown, Tick, addPasskeyHere } from "./family/sign-in/passkey-add";
import { passkeysAddIn } from "./family/sign-in/passkey-adding";
import { declinePasskeyOfferAction } from "./passkey-offer-actions";

type DeclineAnswer = { ok: true; message: string; last?: true } | { ok: false; errors: string[] };
const FAILED = { ok: false as const, errors: [COPY.failed] };
const Errors = ({ errors }: { errors: string[] }) => <ul role="alert" className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>;

/**
 * The passkey offer on Home (the sign-in release, slice SI-8; src/lib/parents/passkey-offer.ts decides on the server
 * whether it is drawn at all). One box, right after a sign-in: a phone's words or a computer's (offerDevice()),
 * **Turn on** and **Not now**. Turn on is one tap, nothing more asked: SI-7b's add, with no name (addPasskeyHere()),
 * and for a first passkey with no app the ten backup codes, shown once. Not now is the one server action, taking
 * nothing, and the box gives way to its answer. Refused or cancelled, SI-7b's words under the buttons, and the offer
 * stays. Given only APP_URL's origin: in a browser with no WebAuthn, or at another address, it draws nothing at all
 * (Sign-in settings says why it can't add there). Until it has read the browser it draws nothing, so the server's HTML
 * and the first draw agree.
 */
export function PasskeyOffer({ portalOrigin }: { portalOrigin: string }) {
  const [device, setDevice] = useState<OfferDevice | null>(null);
  useEffect(() => {
    if (!passkeysAddIn(window as unknown as Parameters<typeof passkeysAddIn>[0]) || window.location.origin !== portalOrigin) return;
    // Known only in the browser, after mount: nothing is drawn before, so the server's page and the first draw agree.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setDevice(offerDevice({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }));
  }, [portalOrigin]);
  const [busy, setBusy] = useState<"on" | "not-now" | null>(null);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [on, setOn] = useState<{ codes?: string[] } | null>(null);
  const [declined, setDeclined] = useState<{ message: string; last: boolean } | null>(null);
  const said = useRef<HTMLParagraphElement>(null);
  const refused = useRef<HTMLDivElement>(null);
  useEffect(() => { if (on || declined) said.current?.focus(); }, [on, declined]);
  useEffect(() => { if (errors) refused.current?.focus(); }, [errors]);

  if (device === null) return null;

  const turnOn = async () => {
    if (busy) return;
    setBusy("on"); setErrors(null);
    const added = await addPasskeyHere("");
    setBusy(null);
    if (added.ok) setOn({ codes: added.codes });
    else setErrors([added.error]);
  };
  const notNow = async () => {
    if (busy) return;
    setBusy("not-now"); setErrors(null);
    const r: DeclineAnswer = await safely(() => declinePasskeyOfferAction(), FAILED);
    setBusy(null);
    if (r.ok) setDeclined({ message: r.message, last: r.last === true });
    else setErrors(r.errors);
  };

  if (declined) {
    return (
      <div className="passkey-offer passkey-offer-said">
        <p ref={said} role="status" tabIndex={-1} className="paid-up"><Tick />{declined.message}</p>
        {declined.last && <p><Link className="link-line" href="/family/sign-in">{WORDS.signInSettings}</Link></p>}
      </div>
    );
  }

  const phone = device === "phone";
  return (
    <div className="box passkey-offer" role="region" aria-labelledby="passkey-offer-h">
      <h2 id="passkey-offer-h">{phone ? WORDS.phoneTitle : WORDS.computerTitle}</h2>
      {on ? (
        on.codes ? (
          <>
            <BackupCodesShown message={COPY.passkeyCodesMade} list={on.codes} app={false} lineRef={said} />
            <p>{WORDS.turnedOn}</p>
          </>
        ) : <p ref={said} role="status" tabIndex={-1} className="paid-up"><Tick />{WORDS.turnedOn}</p>
      ) : (
        <>
          <p>{phone ? WORDS.phoneBody : WORDS.computerBody}</p>
          <p className="help">{WORDS.removeAnyTime}</p>
          {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
          <div className="box-foot passkey-offer-buttons">
            <button type="button" className="btn" aria-disabled={busy !== null || undefined} onClick={() => void turnOn()}>
              {busy === "on" ? WORDS.turnOnBusy : WORDS.turnOn}
            </button>
            <button type="button" className="btn btn-line" aria-disabled={busy !== null || undefined} onClick={() => void notNow()}>{WORDS.notNow}</button>
          </div>
          {errors && <div ref={refused} tabIndex={-1}><Errors errors={errors} /></div>}
        </>
      )}
    </div>
  );
}
