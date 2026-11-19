import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { localhostCertificate } from "../helpers/tls";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { createSmtpSender } from "@/lib/mail/smtp";
import { MailSendError } from "@/lib/mail/types";
import { randomBytes } from "node:crypto";
import { choosePasswordMessage, passwordSetupMessage, welcomeMessage } from "@/lib/mail/messages";
import { mailPart } from "../helpers/signin-links";

const BRAND = { clubName: "FZN Boosters", color: "#005102" };
const APP = "https://portal.example.org";

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

  it("carries a file such as a calendar file as an attachment", async () => {
    sink = await startMailSink({ secure: true, ...tls });
    const calendar = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nSUMMARY:Car wash, rinse crew\r\nEND:VCALENDAR\r\n";
    await sender(sink.port, "tls")({ ...msg, attachments: [{ filename: "volunteer-shift.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH", content: calendar }] });
    const raw = sink.messages[0]!.raw;
    expect(raw).toMatch(/Content-Type: multipart\/mixed/);
    expect(raw).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=PUBLISH/);
    expect(raw).toMatch(/Content-Disposition: attachment; filename=volunteer-shift\.ics/);
    // The part's body, however nodemailer chose to encode it.
    const part = raw.slice(raw.indexOf("Content-Type: text/calendar"));
    const head = part.slice(0, part.indexOf("\r\n\r\n")), body = part.slice(part.indexOf("\r\n\r\n") + 4, part.indexOf("\r\n--"));
    const decoded = /base64/.test(head) ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8") : body;
    expect(decoded).toContain("SUMMARY:Car wash, rinse crew");
  });

  // A mail that carries a link (the sign-in release, slice SI-4): in the text, the address alone on its line; in the
  // HTML, an anchor whose text and href are both the whole address, alone in its paragraph. Each part holds the one token.
  it.each([
    ["the welcome", (url: string) => welcomeMessage(BRAND, "ana@example.com", { appUrl: APP, contact: null, link: { url, life: "7 days", strict: false } })],
    ["the mail to choose a password", (url: string) => choosePasswordMessage(BRAND, "ana@example.com", { appUrl: APP, contact: null, link: { url, life: "7 days", strict: false } })],
    ["the set-up link's mail", (url: string) => passwordSetupMessage(BRAND, "ana@example.com", { link: url, life: "7 days" })],
  ] as const)("%s carries its link once in its text and once, as an anchor, in its HTML", async (_name, write) => {
    sink = await startMailSink({ secure: true, ...tls });
    const token = randomBytes(32).toString("base64url");
    const url = `${APP}/sign-in/set-up/${token}`;
    await sender(sink.port, "tls")(write(url));
    const raw = sink.messages[0]!.raw;
    const plain = mailPart(raw, "plain"), html = mailPart(raw, "html");
    expect(plain.split(/\r?\n/).filter((l) => l.includes(token))).toEqual([url]);
    expect(plain.split(token)).toHaveLength(2);
    expect(html.split(`<a href="${url}">${url}</a>`)).toHaveLength(2);
    expect(html.split(token)).toHaveLength(3); // the anchor's href and its text, and nowhere else
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
    expect(sink.logins).toHaveLength(0); // the password never went over the unencrypted connection
  });

  it("says plainly when the password is wrong, without the message", async () => {
    sink = await startMailSink({ secure: true, ...tls });
    const e = await sender(sink.port, "tls", "wrong")(msg).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailSendError);
    expect((e as Error).message).toBe("The mail server refused the username or password.");
    expect(sink.logins).toEqual([{ user: "sender", ok: false }]);
    expect((e as MailSendError).recipientRefused).toBe(false); // the mail's own problem, not the address's
  });

  it("marks a 550 to RCPT TO as the one address refused, not the mail failing", async () => {
    sink = await startMailSink({ secure: true, ...tls });
    sink.rejectRecipient = "ana@example.com";
    const e = await sender(sink.port, "tls")(msg).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailSendError);
    expect((e as Error).message).toBe("The mail server didn't accept the message (EENVELOPE 550).");
    expect((e as MailSendError).recipientRefused).toBe(true);
    expect(sink.messages).toHaveLength(0);
  });
});
