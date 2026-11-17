import Link from "next/link";
import { getParentState } from "@/lib/auth/identity";
import { ParentFrame } from "./components/parent-frame";

export const metadata = { title: "Not ready yet" };

/**
 * Every address with no page, and every page that answers notFound(). A signed-in parent keeps the club bar and the
 * tabs around it; anyone else gets the plain page, which says nothing about who is signed in or what exists.
 * It also covers the parent pages that are not built yet (Forms).
 */
export default async function NotFound() {
  const state = await getParentState();
  const words = (
    <>
      <h1 className="page-title">This part of the portal isn&apos;t ready yet</h1>
      <p className="lede">We&apos;re still building some pages, and this is one of them. It may also have moved. Everything else is still where you left it.</p>
      <p className="lede"><Link className="link-line" href="/">Back to the home page</Link></p>
    </>
  );
  if (state.status !== "ok") return <main className="wrap signin">{words}</main>;
  return <ParentFrame who={state.identity}><main className="wrap single">{words}</main></ParentFrame>;
}
