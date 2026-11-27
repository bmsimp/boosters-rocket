import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/env";
import { requireStaffPage } from "@/lib/guards";
import { isUuid } from "@/lib/seasons/ids";
import { checkInAddress } from "@/lib/volunteer/check-in";
import { checkInSheet } from "@/lib/volunteer/staff-credit";
import { renewCheckInCodeAction } from "../../actions";
import { ConfirmDialog } from "@/app/components/ui";
import { QrCode } from "../../qr-code";

export const metadata = { title: "Check-in code" };
export const dynamic = "force-dynamic";

/**
 * One shift's check-in sheet (v1 spec §11.4), to print or show at the event: the event, the shift's time in words, the
 * code as a QR code drawn on the server, and the address it opens written out. A guardian who scans it signs in, then
 * checks in their own family's people on the shift. Staff can make a new code; the printed one then opens nothing.
 */
export default async function CheckInSheetPage({ params }: { params: Promise<{ shiftId: string }> }) {
  await requireStaffPage("Volunteer.Event.ReadWrite");
  const { shiftId } = await params;
  const sheet = isUuid(shiftId) ? await checkInSheet(shiftId) : null;
  if (!sheet) notFound();
  const address = checkInAddress(env.APP_URL, sheet.code);
  return (
    <main className="wrap single checkin-sheet">
      <section className="box" aria-labelledby="sheet-h">
        <h1 id="sheet-h" className="page-title">Check in: {sheet.event}</h1>
        <p className="lede">{sheet.dateWords}, {sheet.timeWords}{sheet.role ? `, ${sheet.role}` : ""} · {sheet.location}</p>
        {sheet.cancelled && <p className="state">This shift is cancelled, so nobody can check in with this code.</p>}
        <QrCode text={address} label={`Check-in code for ${sheet.event}, ${sheet.timeWords}`} />
        <p>Scan with your phone&apos;s camera, sign in, and check in everyone from your family helping on this shift. It opens in your browser, so sign in there even if you use the app.</p>
        <p className="checkin-address">Or open: {address}</p>
        <p>If your phone can&apos;t scan the code, tell the person running the shift: they can record your check-in for you.</p>
        <p className="hint">Check-in opens half an hour before the shift starts and closes when it ends.</p>
      </section>
      <section className="box checkin-tools" aria-labelledby="tools-h"><h2 id="tools-h">This code</h2>
        <p>Print this page, or show it on a screen at the event. If the code has been shared where it shouldn&apos;t be, make a new one: the old one stops working at once, and credit already earned stays.</p>
        <ConfirmDialog label="Make a new code" variant="outlined" busyLabel="Making a new code…" consequence="The code already printed or shown stops working." act={renewCheckInCodeAction.bind(null, sheet.shiftId)} />
        <p className="help"><Link className="link-line" href={`/staff/volunteer/${sheet.eventId}`}>Back to the event</Link></p>
      </section>
    </main>
  );
}
