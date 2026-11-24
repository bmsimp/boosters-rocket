# Connect through Boosters Rocket — design

**Status:** the owner's decisions of 2026-11-23 and 2026-11-24, approved by him on 2026-11-24 with two relay endpoints
added (section 2a). Until each slice is built, the code and `AGENTS.md` describe what is built.
**Builds on:** `main` at `93d0b0b6`, and the relay, Boosters Rocket Connect (its own repository,
`bmsimp/boosters-rocket-connect`), live at `https://connect.boostersrocket.app`. The relay's `SPEC.md` is the source of
truth for the protocol: its section 2 (the flows), 4 (signing), 6 (Intuit facts) and 7 (the changes it asks of the
portal). This spec is the portal's half of it and doesn't repeat it.

Words used here. The **relay** is Boosters Rocket Connect. **Relay mode** is "Connect through Boosters Rocket": the
portal connects through the relay's one Intuit app. **Own-app mode** is "Use our own Intuit app", today's flow. The
**portal id** is the id the relay's owner gives a registered portal (`brp_` and 16 letters or digits). The **key** is the
portal's Ed25519 key pair; its **public key** is the 43 characters the relay registers. *(Proposed)* marks the lead's
own details, which the owner may change at review.

---

## 1. Why

Today each club registers an Intuit app of its own and waits weeks for Intuit's production assessment before it can
read its real books. With the relay, an Admin registers the portal once by email, presses Connect and signs in to
Intuit. Own-app mode stays, unchanged, as the fallback and for clubs that prefer it.

## 2. What the owner decided

1. **Two modes.** The QuickBooks settings offer "Connect through Boosters Rocket" (the default for a new club) or "Use
   our own Intuit app" (today's flow, unchanged). An existing own-app connection keeps working untouched.
2. **Moving to the relay** is choosing relay mode and connecting again to the same company. That is not a switch of
   company. The old app's grant is revoked with the old keys only after the new tokens are stored.
3. **Registration is by email.** The portal makes the key pair and keeps the private key sealed by `secretBox()`. The
   page shows the public key and the portal's address with Copy buttons and says to email them to
   support@boostersrocket.com. The owner registers the portal and sends back its id; the Admin pastes it in. The page
   names each stage plainly: not registered yet, waiting for the id, ready to connect.
4. **The relay's address** defaults to `https://connect.boostersrocket.app`.
5. **Disconnect in relay mode warns and asks.** Two portals on one QuickBooks company share one grant, so disconnecting
   either may end both. The Admin sees that and must tick a plainly worded acknowledgement before Disconnect works; the
   server refuses a disconnect without it, and the acknowledgement goes in the audit row.
6. **QuickBooks' own logos**, from Intuit's files: the ball on the Integrations row and the QuickBooks page head, the full
   logo (black or white by theme) on the connect step, with a note that they are Intuit's marks, not covered by AGPL.
7. **The rest of the relay's section 7 as written:** the signing helper; the callback
   `/api/quickbooks/relay/callback` through the same store path; refresh and revoke through the relay, the new refresh
   token stored first and `invalid_grant` treated as Intuit's own; Health with the mode, the last refresh and whether
   the relay can be reached; audit actions for the relay's connect, refresh failure and revoke.

## 2a. Approved on 2026-11-24

- **Intuit's terms (the relay's question 6) are settled, not open.** The owner chose on 2026-11-22 to submit the
  assessment without asking Intuit in writing, and Intuit approved the relay's production credentials.
- **Two more signed relay endpoints**, being built in the relay, are used in the flows below:
  - `POST /v1/portal/check`, body `{}`: answers 200 `{"status":"ok","portal":{"name":"…","environments":["production","sandbox"]}}`,
    or 401 `unauthorized` like the other signed routes. Registration calls it once the portal id is saved, to show
    "Registered" or to say the id or the key doesn't match (section 5, Registration).
  - `POST /v1/connection/forget`, body `{"environment":"production"|"sandbox","realm_id":"…"}`: always answers 200
    `{"status":"ok"}` and never calls Intuit. A refused relay connect calls it so the relay drops its record of the
    connection without revoking the shared grant (section 3, section 5, Connect).

### Against the relay's SPEC.md

Where the portal's half reads the relay's `SPEC.md` differently, or adds to it:

1. **Registration is by email** (SPEC section 2, "a form or an email"): the owner chose email (decision 3).
2. **The relay's address is an env setting** (SPEC section 7, item 2, "relay settings"): not a page setting
   (section 3).
3. **The id and key can be checked before Connect** (SPEC section 7, item 3, which named only the four calls of the
   flows): the portal also calls `POST /v1/portal/check`, so a wrong id or key shows at registration, not first at
   Connect.
4. **A refused connect forgets, it doesn't revoke** (SPEC section 7, item 4, which named refresh and revoke only):
   revoking would end the shared grant, so the portal calls `POST /v1/connection/forget` instead, and the relay ends its
   record of which portal connected the company.

## 2b. The lead's changes of 2026-11-24, after review

The review of the four slices found these; the lead decided each, and the sections below say them in place.

1. **The relay's environment has its own column** (section 4). `qbo_connection.environment` is what the club's own
   Intuit app's keys are for, and becomes nullable with them; the relay's choice, made with step 2's press, is
   `relay_environment`. A relay connect started and left (for the sandbox, say) never changes what the own app
   connects to, and going back to the own app never inherits the relay's choice. Everything relay-side (start, the
   stored connection's tokens, refresh, revoke, forget, Health) reads the relay's column, by `token_mode` for tokens
   held. Migration 0059 was changed in place, since it hadn't merged.
2. **The registration can't change under a connect.** While a connect through the relay is in progress (`state_mode`
   `relay` and its state not expired), "Make a new key" and saving a portal id are refused: "A connect through
   Boosters Rocket is in progress. Finish it, or wait N minutes, then try again.", and no stage offers the id form. The
   store checks again under a lock of `qbo_relay`, taken before the connection row: a redemption signed under a portal
   id or public key that is no longer the portal's is refused `state`, its tokens thrown away and nothing revoked. The
   forget is sent under the id that redeemed them while the key is the same; after a new key nothing can sign for the
   old registration, so no forget is sent, and the relay keeps its record until a later disconnect.
3. **A relay 5xx is marked `unreachable`**, as its code `relay_unreachable` is (section 5, Refresh).
4. **The relay's own 400s on refresh are the relay's.** `environment_not_allowed` and `bad_request` are read before
   anything is read as Intuit's, as `relay_environment_not_allowed` ("Boosters Rocket doesn't allow this portal to
   connect to this QuickBooks. Email support@boostersrocket.com.") and `relay_bad_request`; neither needs an Admin.
5. **A stale page's Disconnect.** The form sends which app the page was drawn for (`drawnFor`). Through the relay, a
   page drawn for another app, which showed no box, is answered "This page is out of date. Reload it and try again.",
   changing nothing.
6. **The registration's check.** A 401 says the id and the key don't match what Boosters Rocket registered, "or this
   server's clock is more than 5 minutes off". A check's failures (its 401, 429 or no answer) don't change Health's
   mark; only the real calls, connect, refresh, revoke and forget, do. A check the relay answers marks it as answering.
7. **A redeem that fails after the relay's callback** (refused, late, or no answer) leaves the relay's record of the
   connection standing until a later disconnect: the company is known only from the redemption, so the portal can't
   name it in a forget.
8. **A start refused with `relay_code`** (the relay answering start as it answers a spent code) is reported as
   `relay_refused`, step 2's word for a start the relay wouldn't make.
9. **Step 2 is "Connect to QuickBooks"** in either mode, and step 1's link "Next: connect to QuickBooks".

## 3. The lead's decisions

- **The relay's address is an env setting, never a UI one.** `QBO_RELAY_URL` in `src/env.ts`, optional, default
  `https://connect.boostersrocket.app`, an origin only, https (http only for `localhost`). The page shows it, read-only.
  Why: whoever sets it receives every refresh token the portal holds, and the private key signs whatever is sent there.
  An env setting is changed only by the installer with access to the server, the same trust as
  `SETTINGS_ENCRYPTION_KEY`; a staff session, even a phished Admin's, can't point the tokens elsewhere. It has real uses
  beyond the default (a fork running its own relay) and the tests replace it from outside like `qboEndpoints()`, so it is
  no test switch (`tests/unit/no-test-mail-path.test.ts` stands).
- **Own-app mode gets no checkbox, one line instead.** Its grant is shared only when a club has put the same Intuit
  app's keys into two portals, which the club itself did and can see. Relay portals all share one app, so the sharing is
  invisible to the Admin; that is what the acknowledgement is for. Own-app Disconnect gains one sentence: "If another
  portal uses this same Intuit app's keys for this company, it is disconnected too."
- **A refused relay connect revokes nothing.** Today a connect refused after Intuit issued tokens (`other_company`,
  `roster_company`, a store that failed) revokes them. Through the relay that would revoke the relay app's grant to the
  company, which may be another portal's live connection: the trial and real portals of one club are exactly the case.
  So in relay mode the tokens are dropped, not revoked: the portal sends `POST /v1/connection/forget` with the
  environment and the company, so the relay ends its record of this portal's connection, and the audit row says
  `revoked: false, why: "shared_grant"` and whether the relay confirmed the forget.
- **Leaving relay mode while connected through it needs Disconnect first.** Moving back to own-app would otherwise
  revoke the shared grant without the acknowledgement. Own-app to relay while connected is allowed (decision 2).
- **Renewing through the relay revokes nothing.** Connecting again through the relay to the company already connected
  through it replaces the tokens; the old ones are from the same app and grant, so revoking them would end the new ones.
  Only tokens of own-app mode are ever revoked after a move.
- **Reachability is marked by real calls, not pinged.** Every signed call records a counts-only mark (when the relay
  last answered, when it last failed and with which word). Health reads it; it doesn't call the relay on load. The
  worker refreshes at least daily, so the mark is never more than a day old while connected.
- **The email is a `mailto:` link too.** Beside the Copy buttons, "Write the email" opens the Admin's mail app with the
  subject, the club's name, the portal's address and the public key filled in. All of it is public; the private key is in
  no address.
- **A new key is offered** only while nothing is connected through the relay, and clears the saved portal id (the owner
  registers the new key and sends the id again).
- **The logos' sizes** follow the stricter of Intuit's two published rules (section 9).

## 4. Data

*(Proposed names; the builder follows `docs/agents/database.md` and takes the next migration number, 0059 at the time
of writing.)*

- **`qbo_relay`**, a new singleton (the `qbo_connection` pattern: `id` = "singleton", checked): `public_key` (base64url,
  43 characters), `private_key_ciphertext` and `private_key_key_id` (the PKCS#8 key, sealed by `secretBox()` under a new
  AAD, `QBO_AAD.relayKey` = "qbo:relay-key"), `key_made_at`, `key_made_by` (staff_user), `portal_id` (nullable,
  checked against `^brp_[a-z0-9]{16}$`), `portal_id_saved_at`, `portal_id_saved_by`. Its stage is read from it: no row,
  not registered; a key and no id, waiting for the id; both, ready to connect. Not keyed by a QuickBooks id, so a change
  of company clears nothing here; `KEPT_TABLES` in the clean-up, with why.
- **`qbo_connection`** gains:
  - `connect_mode` (`own_app` | `relay`, not null): what the next Connect does. Existing rows become `own_app` in the
    migration; new rows default to `relay`.
  - `token_mode` (`own_app` | `relay`, nullable): which app issued the tokens held now; null while disconnected, set
    with every store. Refresh and revoke follow this, never `connect_mode`, so a club that has chosen relay mode but not
    yet connected again keeps refreshing with its own keys. Backfilled `own_app` where a refresh token is held.
  - `state_mode` (nullable): the mode a pending connect's state was made for. Each callback accepts only its own.
  - `client_id`, `client_secret_ciphertext` and `client_secret_key_id` become nullable, with a check that they are set
    whenever `connect_mode` or `token_mode` is `own_app`. A relay club never has them; a club that moved keeps them, so it
    can move back. `environment`, which the keys are for, becomes nullable with them, under the same check (section 2b).
  - `relay_environment` (nullable): the QuickBooks the relay connects to, chosen with step 2's press, set whenever
    `token_mode` or `state_mode` is `relay` (`qbo_connection_relay_environment`).
- **A mark**, the setting `health.mark.quickbooks_relay` *(proposed key)*: `lastOkAt`, `lastFailAt`, `lastFailWord`
  (a fixed word: `unauthorized`, `busy`, `unreachable`, `relay_error`). No token, code, body or id.
- **Env:** `QBO_RELAY_URL` (section 3), in `deploy/.env.example` commented out with its default.

The private key is never shown, never returned by `connectionView()` or any view a page reads, never passed to a client
component, never in an audit row (rows name the public key's first 8 characters at most) and never logged.

## 5. The flows

### Choosing a mode (setup step 1, "How to connect")

1. Step 1 of the setup steps becomes "How to connect": two choices, "Connect through Boosters Rocket" (checked for a
   new club) and "Use our own Intuit app", each with one line on what it means. Saving a choice is audited
   (`settings.quickbooks.mode`, before and after).
2. Under the choice, relay mode shows registration (below); own-app mode shows today's step 1, the Intuit app's keys,
   unchanged.
3. Refused: own-app to relay is always allowed; relay to own-app while `token_mode` is `relay` answers "Disconnect
   first, from QuickBooks settings" and changes nothing.

### Registration

1. **Not registered yet.** "Make this portal's key" (a form button). The server makes an Ed25519 pair
   (`crypto.subtle.generateKey`, as the relay's `src/sign.ts` `newPortalKey()` does), seals the PKCS#8 private key and
   stores both halves in `qbo_relay`, in one transaction with its audit row (`settings.quickbooks.relay.key_made`).
2. **Waiting for the id.** The page shows the portal's address (`APP_URL`) and the public key, each in a `CopyField`;
   "Email these to support@boostersrocket.com. Boosters Rocket registers the portal and emails you back its id."
   *(Proposed wording)*; the "Write the email" link; and a form with one field, "Portal id". The form checks the pattern
   and saves (`settings.quickbooks.relay.portal_id`, audited with before and after). When `APP_URL` is http on a host
   that isn't `localhost`, the stage says the relay needs an https address and offers no form.
3. **Ready to connect.** The address, the public key and the id shown as set, with "Change the portal id" and, while
   nothing is connected through the relay, "Make a new key" (a `details` section, as Disconnect is).
4. **Checking the registration.** Saving the portal id calls the signed `POST /v1/portal/check` (body `{}`), after the
   save's transaction. A 200 shows "Registered", with the name the relay holds (rendered as text) and the environments
   it allows; a 401 says the id or the key doesn't match what Boosters Rocket registered, or the server's clock is more
   than 5 minutes off, to check the id and email support; no answer says the relay couldn't be reached and offers
   "Check again". An answer marks the relay as answering; a failure marks nothing (section 2b). The check changes nothing in the portal's records: the id stays saved whatever it answers, and a wrong
   one is still refused by the relay at Connect.

### Connect

1. **Step 2, "Connect to QuickBooks"**, shows the full QuickBooks logo above the press. In relay mode it also asks which
   QuickBooks: "The club's real books" or "An Intuit sandbox (test) company", saved to `qbo_connection.relay_environment`
   with the press (changing it while connected is refused, as today). The press is "Connect to QuickBooks".
2. `beginConnect()` (and `beginSwitchConnect()`, from the switch page, which already requires disconnecting first)
   branch on `connect_mode`. In relay mode they make the state exactly as today, with `state_mode` = `relay` and, for a
   switch, the same ask; then send the signed `POST /v1/connect/start` with `environment` and `portal_state` (the
   state itself: the relay returns it to the browser anyway). No row lock is held during the call.
3. The answer's `url` is followed only if it starts with `QBO_RELAY_URL` + `/v1/connect/go/`; anything else, a 401, a
   429 or no answer is a refusal on step 2 (`relay_refused`, `relay_busy`, `relay_unreachable`), audited.
4. The Admin goes through the relay to Intuit and back (relay section 2, steps 3 to 6). The relay sends the browser to
   `/api/quickbooks/relay/callback?code=<redemption code>&state=<state>`, or with `error=access_denied`, `denied` or
   `intuit`.
5. **The callback route** is guarded exactly as `/api/quickbooks/callback` is (a staff session holding
   `Settings.QuickBooks.ReadWrite`, checked first in the handler) and calls the same `completeConnect()`, refactored so
   that only "turn the return into tokens" differs:
   - step 1, spending the state, is unchanged, and also requires `state_mode` = `relay`; an error from the relay is
     `denied` (or `intuit`, its own word) after the state is spent;
   - step 2 is the signed `POST /v1/connect/redeem` with the code, instead of the code exchange. The answer must carry
     `portal_state` equal to the state just spent and `environment` equal to the connection's, and its `realm_id`
     (digits, at most 32) becomes the company; the callback's address carries none. A refused or late redemption is
     `relay_code` ("That connection took too long to finish. Press Connect again.");
   - step 3, storing, is unchanged: the same company and switch checks under the row lock, `sealTokens()`, the switch
     record, `token_mode` = `relay`. The other differences are the revoke rules of section 3: a refusal here drops the
     tokens, revokes nothing and sends `POST /v1/connection/forget` with the environment and the refused company, after
     the refusal's transaction;
   - **moving from own-app** (the row held own-app tokens for this company): the old refresh token is taken from the row
     under the same lock as the store, and after the store commits it is revoked at Intuit with the old keys
     (`revokeAtIntuit()`), audited `quickbooks.relay.old_grant_revoked` with `revoked`; if Intuit doesn't confirm, the
     settings page says the old app's access may still stand in QuickBooks' Apps list;
   - steps 3b and 4 (the clear, the company's name) and the roster's first read are unchanged. The audit row is
     `quickbooks.relay.connect` (company, environment, `movedFromOwnApp`, `switchedFrom` when it switched), and a
     refusal `quickbooks.relay.connect_refused` with its reason.
6. The redemption code is spent before the route answers; the route answers only redirects to the setup page, sent
   `no-store`. No token is ever in a URL, the portal's or the relay's.

### Refresh

`tokenUnderLock()` (`src/lib/quickbooks/client.ts`) branches on `token_mode`. In relay mode the refresh is the signed
`POST /v1/token/refresh` with `environment` and `refresh_token`, still under the row lock and in its transaction; the
answer is parsed as Intuit's own (it is Intuit's, passed through) and stored by `sealTokens()` in that transaction
before anything else uses it. Errors keep today's shape, `QboError` with a short code:

| The relay answers | Code | Only an Admin can fix it (`errorNeedsAdmin`) |
| --- | --- | --- |
| 400 with Intuit's word (`invalid_grant`, …) | that word | `invalid_grant`, as today |
| 400 with the relay's own word (`environment_not_allowed`, `bad_request`) | `relay_environment_not_allowed`, `relay_bad_request` | no: email support |
| 401 | `relay_unauthorized` | no: the clock, or the owner's registry; Health says which to check |
| 429 | `relay_busy` | no |
| 502, 5xx, no answer in 15 seconds | `relay_unreachable`, marked `unreachable` | no |

A failure is audited `quickbooks.relay.token_refresh.failed` only when its words change, as today's
`quickbooks.token_refresh.failed` is.

### Disconnect

1. In relay mode (`token_mode` = `relay`) the Disconnect section shows the warning: "Every portal connected to this
   QuickBooks company through Boosters Rocket shares one connection. Disconnecting here may disconnect the others too,
   such as a trial copy of this portal." *(proposed)*, then the checkbox "I understand that disconnecting may also
   disconnect any other portal connected to this company through Boosters Rocket." The button is `aria-disabled` until
   it is ticked.
2. `disconnectAction` takes the form. In relay mode it refuses, changing nothing, unless `ack` is exactly one value,
   "yes" ("Tick the box to say you understand, then try again."), and first, unless `drawnFor`, the app the page was
   drawn for, is `relay` ("This page is out of date. Reload it and try again."). In own-app mode it reads no field.
3. `disconnect()` sends the signed `POST /v1/token/revoke` with `environment`, `token` (the refresh token) and
   `realm_id`, so the relay ends its record of the connection too; then forgets the tokens whatever the answer, as today.
   Audited `quickbooks.relay.disconnect` with `acknowledged: true`, `revoked` and the company; own-app keeps
   `quickbooks.disconnect`.

### Visits from QuickBooks

The relay sends a person from QuickBooks' Apps list to `/staff/settings/quickbooks`, with `?intuit=connect` or
`?intuit=disconnected`. The page shows a fixed Notice for each known value ("QuickBooks says the portal was
disconnected there. Connect again to carry on." / "Connect QuickBooks from the steps below.") and ignores anything else.

## 6. Pages, routes and actions, and the checklists they meet

- **No new page.** The QuickBooks page and its setup steps change; both already start with
  `requireStaffPage("Settings.QuickBooks.ReadWrite")`, an Admin-only permission. The `quickbooks` item of
  `SETTINGS_ITEMS` keeps its guard and gains keywords ("Boosters Rocket", "connect", "relay", "register").
  `RAIL_STATUS` and the Integrations row read `connectionView()`, which gains `connectMode`, `tokenMode` and the
  registration's stage (never the key). The page's Connection card shows "How it connects", with the relay's address in
  relay mode. Primitives only (`Card`, `KeyValue`, `Notice`, `ChoiceGroup`, `TextInput`, `Checkbox`, `Button`,
  `ActionOutcome`, `CopyField`).
- **New route handler** `src/app/api/quickbooks/relay/callback/route.ts`: in `ROUTE_HANDLERS`
  (`tests/integration/page-guards.test.ts`) as "A staff session with Settings.QuickBooks.ReadWrite, checked in the
  handler, the state value from the connect step and its mode, and the relay's redemption, signed
  (tests/integration/quickbooks-relay.test.ts)". It is under `/api/`, so the setup redirect leaves it alone.
- **New staff server actions**, in `src/app/staff/(app)/settings/quickbooks/actions.ts`, each
  `staffAction("Settings.QuickBooks.ReadWrite", …)`, each checking its argument (`NOT_FROM_PAGE`), the write in
  `src/lib/quickbooks/` in one transaction with its audit row, `revalidatePath`, then the result shape: choose the mode,
  make the key, save the portal id. `beginConnectAction` takes the environment in relay mode; `disconnectAction` takes
  the form.
- **`ACTION_NAMES`** (`src/lib/audit/actions.ts`): `settings.quickbooks.mode`, `settings.quickbooks.relay.key_made`,
  `settings.quickbooks.relay.portal_id`, `quickbooks.relay.connect`, `quickbooks.relay.connect_refused`,
  `quickbooks.relay.old_grant_revoked`, `quickbooks.relay.token_refresh.failed`, `quickbooks.relay.disconnect`.
- **`PERMISSION_WORDS`:** no new permission. The words of `Settings.QuickBooks.ReadWrite` become "Connect QuickBooks,
  register the portal with Boosters Rocket, and choose the membership shape" *(proposed)*.
- **Modules:** `src/lib/quickbooks/relay-sign.ts` (the signer, the relay's `src/sign.ts` copied with its format, plus
  key making and import), `src/lib/quickbooks/relay.ts` (the six signed calls, the mark, the address check),
  `src/lib/quickbooks/relay-registration.ts` (the stages, the key, the id). All are staff and worker code, imported by no
  parent page; `relay.ts` joins `STAFF_ONLY_IMPORTS` with the QuickBooks client.
- **Health:** a new line, `quickbooks_relay`, shown only in relay mode: the mode, the last renewal, and when the relay
  last answered, from the mark. Attention when the last signed call failed with no success since, with its fix ("Open
  QuickBooks settings") and, for `relay_unauthorized`, "Check that the server's clock is right, then email
  support@boostersrocket.com". Its entry in `docs/runbooks/health-warnings.md`; its key in
  `tests/integration/health-page.test.ts` and `tests/e2e/ops.spec.ts`. The QuickBooks line itself says "Connected
  through Boosters Rocket" or "Connected with the club's own Intuit app".
- **Docs** changed in the same slices: `docs/runbooks/intuit.md` (relay mode first; own-app as the fallback),
  `docs/runbooks/quickbooks-reconnect.md`, `docs/runbooks/first-install.md`, `docs/runbooks/before-the-first-family.md`
  (registering the portal replaces waiting for Intuit's assessment, for a relay club), `docs/agents/operations.md`
  (Health), the 2026-11-10 QuickBooks spec's connection section (a pointer here), `brand/README.md` and
  `docs/conformance.md`.

## 7. Privacy and security

- **No token in a URL.** Tokens travel only in the bodies of signed server-to-server calls. The callback's `code` is a
  redemption code, single use, two minutes, worthless without the portal's private key; it is spent before the route
  answers and never logged.
- **The state check is today's,** spent under the row lock, tied to the Admin who started it, ten minutes, and now to
  its mode. The redemption's `portal_state` must equal it as well, so a code redeemed for another attempt is refused.
- **The relay's answers are untrusted.** The go address must start with `QBO_RELAY_URL` + `/v1/connect/go/`; `realm_id`
  is digits; the token answer is parsed as Intuit's is; nothing from the relay is rendered except fixed words. Calls
  use `redirect: "error"` and a 15-second timeout, as the calls to Intuit do.
- **The private key never leaves the server.** Sealed at rest, opened only to sign, never in a view, a prop, an audit
  row or a log. `scripts/check-client-bundle.mjs` can't see it (it is in the database, not the env), so a test renders
  every stage of the page and searches the HTML and the client props for the PKCS#8 base64.
- **No secret in the client bundle:** `QBO_RELAY_URL` is not secret and is still read only on the server.
- **The signature** is the relay's format exactly (`BRC1`, method, path, Unix seconds, a fresh 24-character nonce, the
  body's SHA-256), over the exact body bytes sent. The server's clock must be within 5 minutes of the relay's.
- **The refresh token is stored before the answer is used,** in the transaction that holds the row lock, so no two
  callers can spend it and a lost answer is the only way to lose it (the Admin then connects again).

## 8. Tests

- **A fake relay**, `tests/helpers/relay-stub.ts`: an HTTP server on a free port, set as `QBO_RELAY_URL` by replacing
  the module that reads it (as `qboEndpoints()` is replaced today). It checks every signed request as the relay does
  (the registered public key, the clock window, a spent nonce, the body's hash) and answers start, redeem, refresh,
  revoke, check and forget, keeping what it was sent. Knobs: refuse the next call (401), Intuit's word on refresh (`invalid_grant`), a 502,
  a 429, a slow answer, a token rotated on refresh. `grantFor(state, realmId)` makes the redemption code the relay would
  have put in the browser's return, so a test can call the callback route with it.
- **The signer** (unit): a fixed key, time, nonce and body give the signature the relay's own `signedHeaders()` gives
  (a vector made with the relay repository's `src/sign.ts`, kept in the test); a changed byte of the body fails the
  stub's check.
- **Registration** (integration): the three stages; the key made once, sealed, its public half shown; the check's
  three answers (registered, not matching, unreachable) shown, the id kept whichever; the private key
  in no rendered HTML, client prop or audit row; a bad portal id refused; a new key clears the id; only
  `Settings.QuickBooks.ReadWrite` may do any of it (a custom role with everything grantable is refused); each audited.
- **Connect** (integration, `tests/integration/quickbooks-relay.test.ts`, with the fake relay and `qbo-stub`): a first
  connect stores the tokens and `token_mode`; a wrong, used, expired or own-app state is refused and redeems nothing; a
  redemption whose `portal_state` or environment differs is refused; another company is `other_company` or
  `roster_company` exactly as today, with no revoke sent and a forget for that company; a switch through the relay with the ask works and clears; a
  move from own-app stores first, then revokes the old grant at the Intuit stub with the old keys, and a failed store
  revokes nothing anywhere; renewing through the relay revokes nothing; a go address off the relay is refused.
- **Refresh:** the new refresh token is in the row before the call returns; `invalid_grant` needs an Admin; 401, 429
  and 502 don't, and each marks the relay; an own-app connection with `connect_mode` relay still refreshes at Intuit.
- **Disconnect:** relay mode without `ack`, or with two, changes nothing and sends nothing; with it, the revoke carries
  `realm_id` and the audit row `acknowledged: true`; own-app mode reads no field, as today.
- **The usual gates:** `page-guards` (the route), `invariants`, `audit-actions`, `audit-rows`, `permission-words`,
  `settings-sections`, `cleanup` (`qbo_relay` kept), `health-page`.
- **End to end** (`tests/e2e/quickbooks.spec.ts`, at 390 and 1440 wide, with axe), with no relay and no Intuit: an Admin
  chooses relay mode, makes the key, sees the address and public key with Copy buttons, pastes an id and reaches "Ready
  to connect"; step 2 shows the black logo in light and the white one in dark (`colorScheme` and `data-theme`); with
  `token_mode` set to `relay` in the database, Disconnect's button stays unusable until the box is ticked; the ball is
  on the Integrations row and the page head. As today, the run never presses Connect or Disconnect, and the test puts
  the seed's mode, registration and `token_mode` back when it ends.

## 9. The QuickBooks logos

- Files, unchanged, in `public/integrations/quickbooks/`: `qb-ball.svg` (Intuit's
  `sbseg-logo-qb-ball-50-50-gwp-wr-us.svg`), `qb-logo-black.png` and `qb-logo-white.png` (2345 × 600), and
  `TRADEMARK.txt`: "QuickBooks, Intuit and these logos are trademarks of Intuit Inc. They are not covered by this
  repository's license (AGPL-3.0) or by TRADEMARKS.md, and are used only to name the system the portal connects to."
  `brand/README.md`'s table gains the row and loses the "no official file" paragraph. The other sizes Intuit sent are
  not needed.
- **Never recolored, cropped, outlined or put on a tile of color.** The ball keeps its green and white in both themes;
  the full logo is the black file on a light page and the white file on a dark one, switched by CSS on the same
  selectors as the tokens (`[data-theme]` and `prefers-color-scheme`), not `<picture media>`, which can't see the
  portal's own theme setting.
- **Sizes and clear space:** Intuit's two published rules differ (design.intuit.com: the symbol never under 16px;
  the partner guidelines PDF: never under 26px, with clear space of half the symbol's height). The portal meets both:
  the ball is drawn at 26px, with 13px clear on every side, so QuickBooks' tile is larger than the others (`logo-tile`
  gains a modifier; the other tiles don't change); the full logo is drawn at least 2rem tall, with clear space of half
  its ball's height. Slice 1 reads Intuit's current page and records the numbers it followed in `brand/README.md`.
- `IntegrationLogo` gives QuickBooks `{ src: "/integrations/quickbooks/qb-ball.svg" }` in place of the text tile.

## 10. Build order: four slices, one pull request

1. **Foundations:** the data and migration, `QBO_RELAY_URL`, the signer, the relay client and its mark, the fake relay,
   the logos.
2. **Mode and registration:** setup step 1 with the two modes and the three stages.
3. **Connect and refresh:** step 2, the callback route, the store path, the move from own-app, refresh.
4. **Disconnect and Health:** the acknowledgement, the revoke, the Health line, the runbooks and the e2e run.

The plan is `docs/superpowers/plans/2026-11-24-connect-through-boosters-rocket.md`. The full suite and the e2e run pass
locally before the one push; push and merge only on the owner's word.

## 11. Not in scope

Self-service registration (the relay's question 2); a webhook; moving tokens between apps (Intuit doesn't allow it);
the relay's own terms and privacy pages. The relay's question 6, Intuit's written answer, is settled (section 2a).

## 12. Open questions

None the owner must answer before building. The *(proposed)* wording, the mark's key and the permission's new words are
the lead's, for the owner to change at review.
