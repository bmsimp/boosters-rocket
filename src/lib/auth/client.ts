"use client";
import { createAuthClient } from "better-auth/react";

export const staffAuthClient = createAuthClient({ basePath: "/api/auth/staff" });
// Generic OAuth providers sign in through the core `signIn.social({ provider: "parent-oidc" })`; no client plugin exists in this version.
export const parentAuthClient = createAuthClient({ basePath: "/api/auth/parent" });
