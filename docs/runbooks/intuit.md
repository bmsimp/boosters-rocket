# Intuit: registering the portal and its production assessment

The portal reads the club's families and invoices from QuickBooks Online, and writes back only what someone asks it to
(a parent's own phone, address and sign-in email; the roster changes staff make; and the invoice for a volunteer
buy-out, made when a guardian chooses to pay instead of volunteering and voided if they switch back before paying). To
do that it is registered with Intuit as an app of the club's own, and it connects to the club's company with that
app's keys.

Intuit gives an app two sets of keys. **Development** keys connect only to sandbox companies (test companies that hold
no real books). **Production** keys connect to the club's real books, and Intuit gives them only after the app passes
its production assessment. Start that early: it can take weeks.

Intuit's screens change. Where one doesn't match these steps, trust the screen; the developer site's own help is at
https://developer.intuit.com.

## 1. Register the app

1. Go to https://developer.intuit.com and sign in, or create an Intuit developer account, with an address that belongs
   to the club rather than to one person (a board mailbox), so the app outlives anyone's term.
2. Open the **Dashboard** and create an app for **QuickBooks Online and Payments**. Name it after the club, for
   example "Example Boosters portal".
3. When asked for permissions (scopes), choose **Accounting** only (`com.intuit.quickbooks.accounting`). The portal
   needs nothing else.
4. Open the app's **Keys and credentials** (or **Development settings**). Note the **Client ID** and **Client secret**
   of the Development keys. Treat the secret like a password: paste it only into the portal.
5. The redirect address is on another page: the app's **Settings**, **Redirect URIs**. Under **Development**, add
   exactly:
   ```
   <APP_URL>/api/quickbooks/callback
   ```
   with the portal's address from `deploy/.env` (for example `https://portal.example.org/api/quickbooks/callback`).
   No trailing slash.

## 2. Try it on a sandbox company first

1. On the developer site, open **Sandbox** and create a sandbox company if there is none.
2. In the sandbox, set the company up like the club's books: the customer types the club uses (for example Family,
   Student and Parent), with students and parents as sub-customers of a family, and a few invoices.
3. In the portal, as an Admin: **Settings**, **QuickBooks**, **Set up**.
4. Enter the Development **Client ID** and **Client secret**, choose **Sandbox**, **Save**, then **Next: sign in to
   Intuit** in the note that appears.
5. **Sign in to Intuit**, choose the sandbox company and **Connect**. You come back to the portal.
6. Choose the membership shape (**Layered** when families have students and parents under them; **Flat** when each
   member is a customer of their own) and the customer types, select **Preview**, check the counts and names, then
   **Save this shape**.
7. Open **Roster** in the staff menu: the families are listed. **Health** says QuickBooks is "Connected" and names
   the company as a sandbox.
8. Check the portal's requests: **Settings**, **QuickBooks**, **Check the portal's requests**, **Run the check**. In a
   sandbox company it tries every request the portal makes, on a few test records of its own, and says for each
   whether QuickBooks answered as the portal expects. [Before the first family](before-the-first-family.md#2-check-the-portals-requests-in-the-intuit-sandbox)
   says what to do with what it finds.

## 3. The production assessment

1. On the developer site, open the app's **Production settings** (or **Keys and credentials**, **Production**).
2. Fill in what Intuit asks about the app. The portal's own pages answer most of it:
   - the app's address: the portal's `APP_URL`;
   - the production redirect address: `<APP_URL>/api/quickbooks/callback`, as in part 1;
   - the end-user licence: the portal is open source under the AGPL-3.0 (the `LICENSE` file in the repository); the
     club may want its own terms of use page as well;
   - a privacy policy: the club's own, saying the portal keeps a copy of the club's customer list and open invoices to
     show each family its own, and changes in QuickBooks only what a parent or staff member asks it to.
3. Answer the assessment questionnaire. It asks how the app uses QuickBooks data and keeps it safe. True answers for
   the portal: it runs on the club's own server; it stores the connection's tokens encrypted; families see only their
   own records; it reads customers, invoices and items; it writes a parent's own phone, address and email when that
   parent changes them, the roster changes staff make, and one kind of invoice, a volunteer buy-out, which it creates
   when a guardian chooses it and voids if they switch back before paying; it never deletes anything or touches a
   payment; it keeps an audit log of every change.
4. Submit it, and answer Intuit's follow-up questions by email.
5. When Intuit approves the app, the **Production** **Client ID** and **Client secret** appear.

## 4. Connect the club's real books

Connecting a different company deletes what the portal holds from the sandbox: read
[reconnecting QuickBooks](quickbooks-reconnect.md#connecting-a-different-company) first.

1. In the portal: **Settings**, **QuickBooks**, open **Disconnect**, then **Disconnect QuickBooks**.
2. **Change** (the app's keys are kept after a disconnect, so the button reads Change, not Set up; its steps open at
   step 1, where the keys go): the Production keys, **Production**, sign in to Intuit with an account that can open the club's
   company, choose it and **Connect**.
3. Choose the membership shape again, **Preview**, check, **Save this shape**.
4. Open **Health**: QuickBooks says "Connected" to the club's company, with no word of a sandbox.
