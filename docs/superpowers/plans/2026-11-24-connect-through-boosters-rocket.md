# Connect through Boosters Rocket: the plan

The spec is [2026-11-24-connect-through-boosters-rocket-design.md](../specs/2026-11-24-connect-through-boosters-rocket-design.md);
where this plan and the spec differ, the spec wins. The relay's protocol is its own `SPEC.md`
(`bmsimp/boosters-rocket-connect`), sections 2, 4, 6 and 7, and its `src/sign.ts`. Four slices, one screen each, on one
branch (`feature/connect-relay`) and one pull request (spec section 10). Each brief says what it builds and nothing
else; each slice's report says what it left undone. Read `AGENTS.md`, `docs/agents/quickbooks-writes.md`,
`docs/agents/app-records.md` ("A change of company"), `docs/agents/database.md`, `docs/agents/testing.md` and
`docs/agents/tripwires.md` before writing code. Tests are written with the code.

## Slice 1: foundations

**Goal.** The data, the relay's address, the signer and the relay client exist, tested against a fake relay; the
QuickBooks ball is on the Integrations row and the QuickBooks page head. Nothing a club sees changes otherwise.

**Files and areas.** `src/lib/db/schema.ts` and one migration (`pnpm db:generate --name connect_relay`): `qbo_relay`;
`qbo_connection.connect_mode`, `token_mode`, `state_mode`; the client columns nullable with their check; existing rows
backfilled `own_app` (spec section 4). `src/env.ts`: `QBO_RELAY_URL`, and its line in `deploy/.env.example`.
`src/lib/quickbooks/relay-sign.ts` (the relay's `src/sign.ts` format, key making and import with node's WebCrypto) and
`src/lib/quickbooks/relay.ts` (start, redeem, refresh, revoke; the address check; the mark
`health.mark.quickbooks_relay`). `tests/helpers/relay-stub.ts`, the fake relay. The logos into
`public/integrations/quickbooks/` with `TRADEMARK.txt`; `IntegrationLogo` and the tile's modifier in `booster.css`;
`brand/README.md`'s row, with the clear-space and size numbers read from Intuit's current page. `qbo_relay` in
`KEPT_TABLES`.

**Checklists.** Database conventions. `relay.ts` joins `STAFF_ONLY_IMPORTS`. No colour written into a component; the
logos are files, unchanged.

**Tests.** The signer against the relay's own vector; each signed call against the fake relay (the stub refuses a bad
signature, a stale time and a reused nonce); the go-address check; the error words of spec section 5's table; the mark
written by each answer. Extended: `cleanup`, `tests/unit/no-test-mail-path.test.ts` still passing.

**Done when.** `pnpm typecheck` and `pnpm lint` pass; the files touched pass with `invariants`, `page-guards` and
`parent-isolation`; the migration applies to an empty database and to one holding an own-app connection, which still
refreshes at the Intuit stub.

## Slice 2: mode and registration

**Goal.** On setup step 1, "How to connect", an Admin chooses relay or own-app mode, and in relay mode takes the portal
through "Not registered yet", "Waiting for the id" and "Ready to connect".

**Files and areas.** `src/lib/quickbooks/relay-registration.ts` (the stage, make the key, save the id, a new key) and
the mode's save beside it; `connectionView()` gains the mode and the stage, never the key. The setup page's step 1
(`src/app/staff/(app)/settings/quickbooks/setup/page.tsx`), its forms (`forms.tsx`) and three new actions in
`actions.ts`. The Copy fields, the "Write the email" `mailto:` link, the http-address refusal. The QuickBooks page's
Connection card says how it connects. The `quickbooks` item's keywords in `sections.ts`; the permission's new words.

**Checklists.** New staff server action (three). Audit words in `ACTION_NAMES` (`settings.quickbooks.mode`,
`settings.quickbooks.relay.key_made`, `settings.quickbooks.relay.portal_id`). `PERMISSION_WORDS`. Primitives only.

**Tests.** Spec section 8, registration: each stage rendered; the private key in no HTML, client prop or audit row; a bad
id refused; a new key clears the id; relay to own-app refused while connected through the relay; a custom role refused;
each write audited with before and after. Extended: `settings-sections`, `permission-words`, `audit-actions`.

**Done when.** As slice 1, plus `tests/integration/health-page.test.ts` unchanged and passing.

## Slice 3: connect and refresh

**Goal.** In relay mode, step 2 connects the club's company through the relay, a club on its own app moves to the relay
by connecting again, and the connection renews through the relay.

**Files and areas.** Step 2 of the setup page: the full logo by theme, the environment choice in relay mode, "Connect to
QuickBooks". `beginConnect()` and `beginSwitchConnect()` branching on `connect_mode`; `completeConnect()` refactored so
only "turn the return into tokens" differs, the relay's redemption, the revoke rules of spec section 3, the move from
own-app with the old grant revoked after the store. The new route `src/app/api/quickbooks/relay/callback/route.ts`.
`tokenUnderLock()`'s relay branch in `src/lib/quickbooks/client.ts`; `errorNeedsAdmin()` unchanged but for the table's
codes. The setup page's refusal words for the relay's reasons. The QuickBooks page's `?intuit=` Notices.

**Checklists.** New route handler (`ROUTE_HANDLERS`, with how it is guarded and its test). Audit words
(`quickbooks.relay.connect`, `quickbooks.relay.connect_refused`, `quickbooks.relay.old_grant_revoked`,
`quickbooks.relay.token_refresh.failed`). QuickBooks text as text only.

**Tests.** `tests/integration/quickbooks-relay.test.ts`, spec section 8, connect and refresh, every line. The existing
`tests/integration/quickbooks-connection.test.ts` passes unchanged: own-app mode is today's flow.

**Done when.** As slice 1, plus the QuickBooks, roster and switch integration files pass.

## Slice 4: disconnect, Health and the journey

**Goal.** Disconnect in relay mode needs the acknowledgement on the page and on the server and revokes through the
relay; Health shows the relay's line; the runbooks say how a club connects now; the e2e run covers the pages.

**Files and areas.** `Disconnect` in `forms.tsx` (the warning, the checkbox, the button `aria-disabled` until ticked; the
own-app line of spec section 3); `disconnectAction` taking the form; `disconnect()` revoking through the relay with
`realm_id`. The Health line `quickbooks_relay` in `src/lib/health/report.ts` and its entry in
`docs/runbooks/health-warnings.md`. The runbooks and documents of spec section 6, "Docs", and the rows of
`docs/conformance.md`. `tests/e2e/quickbooks.spec.ts` as spec section 8 says. The roadmap's entry brought up to date.

**Checklists.** New staff server action (the changed Disconnect). Audit words (`quickbooks.relay.disconnect`). A new
outside service's Health line (`health-page`, `ops.spec.ts`).

**Tests.** Spec section 8, disconnect; the Health line's states. Then the full suite in the background and the full e2e
run, both passing, before the one push.

**Done when.** The full suite and `pnpm e2e` pass locally; the branch is ready for one pull request, pushed and merged
only on the owner's word.
