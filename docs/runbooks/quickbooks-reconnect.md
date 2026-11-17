# Reconnecting QuickBooks

The portal's connection to QuickBooks lasts as long as the worker keeps renewing it, and an Admin's sign-in to Intuit
renews it for good. Sometimes it has to be made again: Intuit asks for it every so often, the person who connected it
left, or the Intuit app's keys changed. This is done by an Admin, in the portal, under **Settings**, **QuickBooks**.

There are two different things here, and they do very different things to the portal.

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

Everything the portal holds about the old company's customers belongs to another set of books, so connecting a
different company (for example, moving from Intuit's sandbox to the club's real books) clears it. The portal warns on
the QuickBooks page before you disconnect. It:

- clears the roster and the membership shape, which must be chosen again;
- ends every parent's access: each parent's link to a family is closed and parents are signed out; parent sign-ins and
  welcome emails are switched off until an Admin switches them on again;
- deletes each family's stored invoices and money figures, the item list, the seasons' ticks, waivers and chosen lists,
  every volunteer sign-up, credit, reminder and buy-out, every form being signed with its consents and reminders,
  parents' pending email changes, and staff changes and buy-out invoices waiting to reach QuickBooks (a buy-out invoice
  already made stays in the old company's books, like any invoice);
- keeps every signed form's evidence (the club's record), marked as the earlier company's and shown to no parent: staff
  find it on the Forms page under "Earlier company";
- keeps a list of the old company's families, and who could sign in to them, for the match review under **Parent
  sign-ins**, deleted after 90 days or sooner by an Admin.

Each of those deletions stays in the audit log. Steps:

1. Take a backup first: on the server, in `~/booster-rocket/deploy`, `docker compose run --rm backup --now`.
2. In the portal: **Settings**, **QuickBooks**, open **Disconnect**, read the warning, then **Disconnect QuickBooks**.
3. **Set up**: the app's keys for that company (Production keys for real books), **Sign in to Intuit**, choose the new
   company, approve.
4. Choose the membership shape, **Preview**, check the counts and names, **Save this shape**.
5. Check **Roster**, then switch parent sign-ins back on under **Settings**, **Parent sign-ins** and go through the
   match review (**Review matches** there).
6. Set up the season's requirements again where they were cleared, and tell families what to expect.
