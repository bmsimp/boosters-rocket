import { requireParentPage } from "@/lib/guards";
import { DisplaySettings } from "./display-settings";
import { SignOutButton } from "../../components/sign-out-button";
import { InstallHint } from "../../components/pwa/install-hint";

export const metadata = { title: "Display" };

export default async function DisplayPage() {
  // The page guards itself: the layout's guard does not run again when the browser navigates here from another page.
  await requireParentPage();
  return (
    <main className="wrap single">
      <h1 className="page-title">Display</h1>
      <p className="lede">Make the portal easier to see and read. Changes apply right away.</p>
      <DisplaySettings />
      <InstallHint permanent />
      <section className="box" aria-labelledby="signout-h">
        <h2 id="signout-h">Signing out</h2>
        <p>On a shared or borrowed device, sign out when you&apos;re done.</p>
        <SignOutButton door="parent" />
      </section>
    </main>
  );
}
