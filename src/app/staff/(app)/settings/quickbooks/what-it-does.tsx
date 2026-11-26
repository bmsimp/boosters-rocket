import { QUICKBOOKS_USE } from "@/lib/quickbooks/what-it-does";

/** What the portal does with QuickBooks (`QUICKBOOKS_USE`), on the QuickBooks settings page and in setup's step 2: two sentences. */
export function QuickBooksUse() {
  return <p>{QUICKBOOKS_USE.summary}</p>;
}
