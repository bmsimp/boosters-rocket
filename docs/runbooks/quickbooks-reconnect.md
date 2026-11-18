# Reconnecting QuickBooks

The portal's connection to QuickBooks lasts as long as the worker keeps renewing it, and an Admin's sign-in to Intuit
renews it for good. Sometimes it has to be made again: Intuit asks for it every so often, the person who connected it
left, or the Intuit app's keys changed. This is done by an Admin, in the portal, under **Settings**, **QuickBooks**.

There are two different things here: reconnecting the same company, and connecting a different one, which the portal
refuses for now.

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

**Not possible yet.** The portal now keeps each family's season (ticks, waivers, who a requirement is asked of, the
reminders already sent) against its own records of the families and students it read from the first company. Until
families can be linked to another company's customers, on a mapping screen still to come, the portal refuses any
QuickBooks company other than the one its families were read from, so none of that is lost by mistake. Reconnecting
that same company works as always ([The same company](#the-same-company)).

What you see if you try:

- After **Sign in to Intuit** with another company, the QuickBooks steps say "That is a different QuickBooks company
  from the one the portal's families were read from, so it wasn't connected and nothing was changed." Nothing was
  stored: **Change**, sign in to Intuit again and choose the company the club used before.
- If a connection to another company was stored before the portal refused it, the roster refresh stops with "The
  roster was read from another QuickBooks company than the one connected now, so it wasn't read." The portal asks
  that company nothing. Open **Disconnect**, **Disconnect QuickBooks**, then **Change** and connect the first company
  again.

So:

- **To try the portal against an Intuit sandbox company,** use the proof-of-concept host (or another installation of
  its own), never the installation families will use: once an installation has read a sandbox's customers, it can't
  move to the club's real books until the mapping screen ships.
- **To start the club on its real books,** connect them as the first company of the installation families will use
  ([Intuit, part 4](intuit.md#4-connect-the-clubs-real-books)).
- **Moving to another company** (new books, or another QuickBooks subscription) waits for the mapping screen. When it
  ships, this section gets its steps back, starting with a backup (`docker compose run --rm backup --now` in
  `~/booster-rocket/deploy`).
