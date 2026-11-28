import { createHash, createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";

/**
 * One upload to S3-compatible storage (docs/superpowers/specs/2026-11-28-in-app-backups-design.md, section 6): a PUT
 * signed with AWS Signature Version 4, path-style (<address>/<bucket>/<key>), the body streamed and left unsigned
 * (UNSIGNED-PAYLOAD, which every S3-compatible service takes over https). Our own code on Node's crypto: no client
 * library. It sends nothing but the object, and returns only the status, never the storage's answer, which could quote
 * the request.
 */
export type Storage = { endpoint: string; region: string; bucket: string; accessKeyId: string; secret: string };

const hex = (b: Buffer) => b.toString("hex");
const sha256 = (s: string) => hex(createHash("sha256").update(s, "utf8").digest());
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986 encoding of one segment of a key, as Signature Version 4 asks. */
export const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The headers a signed PUT of `key` carries at `at`: the date, the payload's mark and the Authorization. */
export function signPut(storage: Storage, key: string, at: Date): { url: URL; headers: Record<string, string> } {
  const url = new URL(storage.endpoint);
  const path = `/${encodeSegment(storage.bucket)}/${key.split("/").map(encodeSegment).join("/")}`;
  url.pathname = path;
  const amzDate = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payload = "UNSIGNED-PAYLOAD";
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["PUT", path, "", `host:${url.host}`, `x-amz-content-sha256:${payload}`, `x-amz-date:${amzDate}`, "", signed, payload].join("\n");
  const scope = `${day}/${storage.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kDate = hmac(`AWS4${storage.secret}`, day), kRegion = hmac(kDate, storage.region), kService = hmac(kRegion, "s3"), kSigning = hmac(kService, "aws4_request");
  const signature = hex(hmac(kSigning, toSign));
  return { url, headers: {
    "x-amz-date": amzDate, "x-amz-content-sha256": payload,
    authorization: `AWS4-HMAC-SHA256 Credential=${storage.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  } };
}

/** PUTs a body of a known length; resolves with the HTTP status (0 when the storage couldn't be reached). */
export function putObject(storage: Storage, key: string, body: Buffer | Readable, length: number, o: { timeoutMs?: number; at?: Date } = {}): Promise<number> {
  const { url, headers } = signPut(storage, key, o.at ?? new Date());
  const send = url.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve) => {
    let settled = false;
    const end = (status: number) => { if (!settled) { settled = true; resolve(status); } };
    const req = send(url, { method: "PUT", headers: { ...headers, "content-length": String(length), "content-type": "application/octet-stream" }, timeout: o.timeoutMs ?? 30 * 60_000 }, (res) => {
      res.resume(); // the answer's body is never read: it could quote the request
      res.on("end", () => end(res.statusCode ?? 0));
      res.on("error", () => end(0));
    });
    req.on("timeout", () => { req.destroy(); end(0); });
    req.on("error", () => end(0));
    if (Buffer.isBuffer(body)) req.end(body);
    else { body.on("error", () => { req.destroy(); end(0); }); body.pipe(req); }
  });
}
