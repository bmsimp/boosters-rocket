import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { localhostCertificate } from "../helpers/tls";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { createSmtpSender } from "@/lib/mail/smtp";
import { MailSendError } from "@/lib/mail/types";

let tls: { key: string; cert: string };
let sink: MailSink | null = null;
beforeAll(async () => { tls = await localhostCertificate(); });
afterEach(async () => { await sink?.close(); sink = null; });

const msg = { to: "ana@example.com", subject: "Your FZN Boosters sign-in code: 482913", text: "plain 482913", html: "<p>html 482913</p>" };
const sender = (port: number, security: "tls" | "starttls", password = "sink-password") =>
  createSmtpSender({ host: "127.0.0.1", port, security, username: "sender", password, from: "boosters@example.org", fromName: "FZN Boosters", tls: { ca: tls.cert } });

describe("SMTP sender", () => {
  it("sends over implicit TLS with a login, as the From address, with text and HTML parts", async () => {
    sink = await startMailSink({ secure: true, ...tls });
    await sender(sink.port, "tls")(msg);
    const [m] = sink.messages;
    expect(m).toMatchObject({ from: "boosters@example.org", to: ["ana@example.com"], user: "sender" });
    expect(m!.raw).toMatch(/^From: "?FZN Boosters"? <boosters@example\.org>/m);
    expect(m!.raw).toMatch(/Content-Type: text\/plain/);
    expect(m!.raw).toMatch(/Content-Type: text\/html/);
  });

  it("upgrades with STARTTLS", async () => {
    sink = await startMailSink({ secure: false, ...tls });
    await sender(sink.port, "starttls")(msg);
    expect(sink.messages).toHaveLength(1);
  });

  it("refuses to log in or send when the server doesn't offer STARTTLS", async () => {
    sink = await startMailSink({ secure: false, hideSTARTTLS: true, ...tls });
    await expect(sender(sink.port, "starttls")(msg)).rejects.toBeInstanceOf(MailSendError);
    expect(sink.messages).toHaveLength(0);
  });

  it("says plainly when the password is wrong, without the message", async () => {
    sink = await startMailSink({ secure: true, ...tls });
    const e = await sender(sink.port, "tls", "wrong")(msg).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailSendError);
    expect((e as Error).message).toBe("The mail server refused the username or password.");
  });
});
