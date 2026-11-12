import Link from "next/link";
import { reviewWaiting } from "@/lib/parents/review-notice";

/** On the staff home for people who can decide held addresses, while any are waiting (parents spec §5). */
export async function ParentsReview() {
  const waiting = await reviewWaiting();
  if (!waiting) return null;
  return (
    <section className="box" role="status" aria-labelledby="parents-review-h"><h2 id="parents-review-h">Parent sign-ins</h2>
      <p>{waiting} {waiting === 1 ? "address" : "addresses"} to review. Nobody at {waiting === 1 ? "that address" : "those addresses"} can sign in until someone decides.</p>
      <p className="box-foot"><Link className="btn btn-line" href="/staff/parents">Open Parents</Link></p>
    </section>
  );
}
