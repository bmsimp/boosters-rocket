import { getClubSettings } from "@/lib/settings/club";
import { mailWorking } from "@/lib/mail/settings";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import { SIGNIN_UNAVAILABLE } from "@/lib/parents/signin-copy";
import { CodeSignIn } from "./code-sign-in";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function ParentSignIn() {
  const [club, mail, settings] = await Promise.all([getClubSettings(), mailWorking(), getParentSettings()]);
  const ready = mail && !parentDoorClosed(settings);
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name}</h1>
      {ready ? <CodeSignIn /> : <p role="status">{SIGNIN_UNAVAILABLE}</p>}
      <p className="lede"><a href="/staff/sign-in">Board and staff sign in here</a></p>
    </main>
  );
}
