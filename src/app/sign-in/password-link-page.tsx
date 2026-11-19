import { getClubSettings } from "@/lib/settings/club";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { linkVerdict, type LinkPurpose } from "@/lib/parents/signin-links";
import { ClubBar } from "@/app/components/club-bar";
import { PasswordForm } from "./password-form";

/**
 * The page a set-up or reset link opens (./set-up/[token], ./reset/[token]). No session: the link is the guard. Opening
 * it changes nothing, since mail scanners open links too: it asks linkVerdict() (which writes nothing) and shows the
 * form, or one message that the link can't be used, the same for every reason (unknown, used, expired, a set-up link for
 * someone with a password, blocked, no family to sign in to, sign-ins off). Only the form's submit acts. It shows no
 * name, no address and nothing of any family; the form is given the token, already in the address, and the purpose.
 */
export async function PasswordLinkPage({ purpose, token }: { purpose: LinkPurpose; token: string }) {
  const [club, verdict] = await Promise.all([getClubSettings(), linkVerdict(purpose, token)]);
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={[]} />
      <main className="wrap signin">
        {verdict.ok ? (
          <>
            <h1 className="page-title">{purpose === "reset" ? PASSWORD_COPY.resetTitle : PASSWORD_COPY.setupTitle}</h1>
            <PasswordForm token={token} purpose={purpose} />
          </>
        ) : (
          <>
            <h1 className="page-title">{PASSWORD_COPY.linkNoGoodTitle}</h1>
            <p role="status">{PASSWORD_COPY.linkNoGood}</p>
            <p><a className="link-line" href="/sign-in">Go to sign in</a></p>
          </>
        )}
      </main>
    </>
  );
}
