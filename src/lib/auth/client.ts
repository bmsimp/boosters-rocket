"use client";
import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";

export const staffAuthClient = createAuthClient({ basePath: "/api/auth/staff" });
// The parent door signs in through the portal's own endpoints (/portal-password/check, /portal-code/*, /portal-app/check,
// /portal-passkey/check); this client is used for sign-out and, since the sign-in release's slice SI-7a, for the passkey
// library's browser ceremony (signIn.passkey(), whose one verify request the sign-in page sends to the portal's own
// /portal-passkey/check instead of the library's: src/app/sign-in/passkey-ceremony.ts).
export const parentAuthClient = createAuthClient({ basePath: "/api/auth/parent", plugins: [passkeyClient()] });
