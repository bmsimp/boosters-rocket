# Reconnecting QuickBooks

The portal's connection to QuickBooks lasts as long as the worker keeps renewing it, and an Admin's sign-in to Intuit
renews it for good. Sometimes it has to be made again: Intuit asks for it every so often, the person who connected it
left, or the Intuit app's keys changed. This is done by an Admin, in the portal, under **Settings**, **QuickBooks**.

There are two different things here: reconnecting the same company, which changes nothing, and connecting a different
one, which an Admin asks for first, on its own page, because it ends every family's link to the books.

## The same company

Reconnecting the company the portal already reads changes nothing in the portal: families, parents' access, seasons,
signed forms and everything else stay as they are.

1. Sign in as an Admin and open **Settings**, **QuickBooks**. The page says what is wrong, if anything ("The
   QuickBooks connection couldn't be refreshed", "expires within 30 days").
2. Select **Change**.
3. If the Intuit app's keys changed (a new client secret, or Production keys in place of Development), enter them in
   step 1 and continue. Otherwise go straight to **Step 2: Sign in to Intuit**.
4. Select **Sign in to Intuit**, sign in as an admin of the club's QuickBooks company, choose **the same company** and
   approve. You come back to the portal.
5. Step 3 shows the membership shape already chosen: leave it, or **Skip to step 3** and keep it.
6. Open **Health**: **QuickBooks** says "Connected" with a new **Last token refresh** time, and within a few minutes a
   new **Last roster read**.

## Connecting a different company

A switch moves the portal to another QuickBooks company: new books, another QuickBooks subscription, or from a sandbox
trial to the club's real books. The portal keeps its own families, students and guardians, every sign-in and session,
the seasons' ticks, waivers and chosen lists, volunteering and every signed form, which its family and staff can still
download. What belonged to the earlier company's books ends: every link between a family, student or guardian and a
customer there, what each family was last seen to owe, every request still waiting to be sent there, every unpaid
volunteer buy-out, the product or service chosen for each payment and buy-out requirement, and the membership shape.
Paid buy-outs keep counting.

The portal refuses a different company unless an Admin has said, on the switch page, that they mean to connect one:
picking the wrong company on Intuit's page changes nothing.

1. Take a backup first: on the server, in `~/booster-rocket/deploy`, run `docker compose run --rm backup --now`.
2. Sign in as an Admin and open **Settings**, **QuickBooks**. Open **Disconnect** and select **Disconnect QuickBooks**.
3. On the same page select **Connect a different company** (or **Change**, then **Connect a different company** in
   step 2). The page lists what a switch ends and keeps, with counts. Read it, check the box, and select
   **Switch companies: sign in to Intuit**.
4. At Intuit, sign in as an admin of the new company, choose **the new company** and approve. You come back to the
   portal at step 3. The ask lasts as long as that sign-in does (10 minutes): if Intuit takes longer, start again from
   step 3.
5. Choose the membership shape for the new company and save it. The portal reads its roster.
6. Open **Accounting links** (under **Families**) and link each family, its students and its guardians to the new
   company's customers.
7. Open each season under **Seasons**, and on each payment requirement and each volunteer requirement that offers a
   buy-out, choose its product or service again from the new company's list. Until then a payment requirement shows
   families no invoice, and no family is offered to pay instead of volunteering.

Until a family is linked again, its guardians still sign in and see their students, forms and volunteering as before,
and the money box says the club hasn't connected their payments to the portal yet: no balance, no invoices and no Pay
button. Each unpaid volunteer buy-out ended in the switch that may leave something to settle is listed for the
treasurer on **Reconciliation**, under "From the earlier QuickBooks company", with its invoice or the note to search
for: any invoice made for it stays in the earlier company's books, to settle there by hand.

Going back to the first company later is a switch too, the same way, and ends the links made to the second one. A
buy-out ended at the first switch stays on the treasurer's list, in words that say its invoice is in the company
connected now, and the section is headed "Ended by a change of QuickBooks company" while it lists such a row.

What you see if it was refused:

- After **Sign in to Intuit** with another company and no ask, the QuickBooks steps say "That is a different QuickBooks
  company from the one the portal's families were read from, so nothing was connected and nothing was changed." To
  reconnect the club's company, start again and choose it in Intuit; to move to the other one, select **Connect a
  different company** first.
- If a connection to another company was stored with no switch asked for (from before the portal refused one, or by
  hand), the roster refresh stops with "The roster was read from another QuickBooks company than the one connected now,
  and nobody chose to switch to it, so it wasn't read." The portal asks that company nothing. Open **Disconnect**,
  **Disconnect QuickBooks**, then connect the first company again, or switch as above.

So:

- **To try the portal against an Intuit sandbox company,** the proof-of-concept host (or another installation of its
  own) is still the better place: a trial on the installation families will use leaves its links, ended buy-outs and
  audit rows behind when that installation switches to the club's real books.
- **To start the club on its real books,** connect them as the first company of the installation families will use
  ([Intuit, part 4](intuit.md#4-connect-the-clubs-real-books)).
