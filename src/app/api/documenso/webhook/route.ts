import { WEBHOOK_BODY_MAX, hearWebhook } from "@/lib/forms/webhook";

export const dynamic = "force-dynamic";

const answer = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * Where the club's Documenso sends its webhooks (v1 spec §9.2 step 5). What guards it is the shared secret Documenso
 * sends in X-Documenso-Secret, compared in constant time (src/lib/forms/settings.ts); without it the answer is a
 * bare 404 that says nothing about why, the same as when forms aren't set up.
 *
 * A message is only a hint: the portal reads the one request it names from Documenso's own API and stores what the
 * API says, so a forged, repeated or out-of-order message changes nothing. Nothing of the body is logged, stored or
 * echoed: it holds every recipient's signing token. Documenso does not retry a failed delivery in any useful way, so
 * a message that carries the secret is always answered 200, whether or not Documenso could be read just then: the
 * worker's job asks about every unfinished form every few minutes.
 */
export async function POST(req: Request): Promise<Response> {
  const secret = req.headers.get("x-documenso-secret");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!secret || !Number.isFinite(declared) || declared > WEBHOOK_BODY_MAX) return answer(404, '{"ok":false}');
  let body: string;
  try { body = await req.text(); } catch { return answer(404, '{"ok":false}'); }
  if (body.length > WEBHOOK_BODY_MAX) return answer(404, '{"ok":false}');
  const outcome = await hearWebhook(secret, body);
  return outcome === "refused" ? answer(404, '{"ok":false}') : answer(200, '{"ok":true}');
}

/** Only a POST is a webhook. */
export async function GET(): Promise<Response> {
  return answer(404, '{"ok":false}');
}
