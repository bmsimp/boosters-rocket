import { getClubSettings } from "@/lib/settings/club";
import { linkVerdict, type LinkPurpose } from "@/lib/parents/signin-links";
import { ClubBar } from "@/app/components/club-bar";
import { PasswordLinkBody } from "./password-form";

/**
 * The page a set-up or reset link opens (./set-up/[token], ./reset/[token]). No session: the link is the guard. Opening
 * it changes nothing, since mail scanners open links too: it asks linkVerdict() (which writes nothing) and shows the
 * form, or one message that the link can't be used, the same for every reason (unknown, used, expired, a set-up link for
 * someone with a password, blocked, no family to sign in to, sign-ins off). Only the form's submit acts. It shows no
 * name, no address and nothing of any family; the form is given the token, already in the address, the purpose and
 * whether the link may be used. A set-up while the club's level is Standard signs the parent in once its password is
 * set (./password-actions.ts); a reset, and a set-up under Strict, point to sign in.
 */
export async function PasswordLinkPage({ purpose, token }: { purpose: LinkPurpose; token: string }) {
  const [club, verdict] = await Promise.all([getClubSettings(), linkVerdict(purpose, token)]);
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={[]} />
      <main className="wrap signin">
        {/* The form, or the one message, drawn by one client component, so a sign-in's answer outlives the page being drawn again (./password-form.tsx). */}
        <PasswordLinkBody token={token} purpose={purpose} usable={verdict.ok} />
      </main>
    </>
  );
}
