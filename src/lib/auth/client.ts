"use client";
import { createAuthClient } from "better-auth/react";

export const staffAuthClient = createAuthClient({ basePath: "/api/auth/staff" });
// The parent door signs in through the portal's own /portal-code endpoints; this client is used for sign-out.
export const parentAuthClient = createAuthClient({ basePath: "/api/auth/parent" });
