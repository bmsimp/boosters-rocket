import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ db: {} }));
import { parseMailForm } from "@/lib/mail/settings";

describe("parseMailForm", () => {
  it("accepts Microsoft 365 with one mailbox, normalized", () => {
    expect(parseMailForm({ method: "graph", mailbox: " Webmaster@FznBand.org " }))
      .toEqual({ ok: true, draft: { method: "graph", mailbox: "webmaster@fznband.org" } });
  });
  it("accepts SMTP and treats a blank password as keep-the-saved-one", () => {
    expect(parseMailForm({ method: "smtp", host: "smtp.example.org", port: "587", security: "starttls", username: "u", from: "Club@Example.org", password: "" }))
      .toEqual({ ok: true, draft: { method: "smtp", host: "smtp.example.org", port: 587, security: "starttls", username: "u", from: "club@example.org", password: null } });
  });
  it("refuses plaintext SMTP, a bad port and a host with a scheme", () => {
    const r = parseMailForm({ method: "smtp", host: "https://smtp.example.org", port: "70000", security: "none", username: "u", from: "c@example.org", password: "p" });
    expect(r).toEqual({ ok: false, errors: [
      "Host is a server name like smtp.example.org, without https:// or a path.",
      "Port must be a number from 1 to 65535.",
      "Choose STARTTLS or TLS. Boosters Rocket doesn't send mail unencrypted.",
    ] });
  });
  it("asks which way to send", () => {
    expect(parseMailForm({})).toEqual({ ok: false, errors: ["Choose how to send mail."] });
  });
});
