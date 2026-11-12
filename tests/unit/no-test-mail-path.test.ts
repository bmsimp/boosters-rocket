import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const files = readdirSync(path.join(root, "src"), { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f));

describe("the app has one way to send mail", () => {
  it("never imports the test SMTP server, never trusts extra CAs, and never turns off certificate checks", () => {
    for (const f of files) {
      const s = readFileSync(path.join(root, "src", f), "utf8");
      expect(s, f).not.toMatch(/smtp-server|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized|ignoreTLS|checkServerIdentity|jsonTransport|streamTransport|sendmail:/);
    }
  });
  it("the pattern above does catch each way of weakening mail delivery", () => {
    const weakened = ['import "smtp-server"', "process.env.NODE_EXTRA_CA_CERTS", 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"', "tls: { rejectUnauthorized: false }",
      "ignoreTLS: true", "checkServerIdentity: () => undefined", "jsonTransport: true", "streamTransport: true", "{ sendmail: true }"];
    for (const line of weakened) expect(line).toMatch(/smtp-server|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized|ignoreTLS|checkServerIdentity|jsonTransport|streamTransport|sendmail:/);
  });
  it("chooses a sender only from the saved settings", () => {
    const s = readFileSync(path.join(root, "src/lib/mail/senders.ts"), "utf8");
    expect(s).not.toMatch(/process\.env/);
  });
});
