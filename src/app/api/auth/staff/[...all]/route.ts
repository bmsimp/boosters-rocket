import { toNextJsHandler } from "better-auth/next-js";
import { getStaffAuth } from "@/lib/auth/staff-auth";

export async function GET(req: Request) { return toNextJsHandler(await getStaffAuth()).GET(req); }
export async function POST(req: Request) { return toNextJsHandler(await getStaffAuth()).POST(req); }
