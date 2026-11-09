import { toNextJsHandler } from "better-auth/next-js";
import { getParentAuth } from "@/lib/auth/parent-auth";

export async function GET(req: Request) { return toNextJsHandler(await getParentAuth()).GET(req); }
export async function POST(req: Request) { return toNextJsHandler(await getParentAuth()).POST(req); }
