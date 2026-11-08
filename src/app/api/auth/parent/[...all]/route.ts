import { toNextJsHandler } from "better-auth/next-js";
import { parentAuth } from "@/lib/auth/parent-auth";
export const { GET, POST } = toNextJsHandler(parentAuth);
