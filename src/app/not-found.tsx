import Link from "next/link";
import { getParentState } from "@/lib/auth/identity";
import { ParentFrame } from "./components/parent-frame";
import { PoweredBy } from "@/app/components/powered-by";

export const metadata = { title: "We can't find that page" };

/**
 * Every address with no page, and every page that answers notFound(). A signed-in parent keeps the club bar and the
 * tabs around it; anyone else gets the plain page, which says nothing about who is signed in or what exists.
 * The words are true whatever the cause (a mistyped address, a link that is out of date, a check-in code staff have
 * made again, a page for something that has ended) and never say which.
 */
export default async function NotFound() {
  const state = await getParentState();
  const words = (
    <>
      <h1 className="page-title">We can&apos;t find that page</h1>
      <p className="lede">The link may be out of date, or the page may have moved. Everything else is still where you left it.</p>
      <p className="lede">If you scanned a check-in code at a shift, ask the person running the shift: they can check you in.</p>
      <p className="lede"><Link className="link-line" href="/">Back to the home page</Link></p>
    </>
  );
  if (state.status !== "ok") return <><main className="wrap signin">{words}</main><footer className="signin-foot"><PoweredBy /></footer></>;
  return <ParentFrame who={state.identity}><main className="wrap single">{words}</main></ParentFrame>;
}
