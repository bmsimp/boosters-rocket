import type { AddressInfo } from "node:net";
import smtp from "smtp-server";

export type Captured = { from: string; to: string[]; user: string | null; raw: string };
export type MailSink = { port: number; messages: Captured[]; /** Every login tried, whether or not it worked. */ logins: { user: string; ok: boolean }[]; /** When set, the server answers `rejectReply` to RCPT TO for this address, or for every address when it is "*" (a relay that refuses everyone). */ rejectRecipient: string | null;
  /** The reply to a refused RCPT TO: its code, and its text, which may start with an enhanced status code ("5.7.1 Relay access denied"). Default 550 "Mailbox unavailable". */ rejectReply: { code: number; text: string }; close(): Promise<void> };

/** A local SMTP server that requires TLS and a login, and keeps every message it gets. */
export async function startMailSink(o: { secure: boolean; key: string; cert: string; port?: number; user?: string; pass?: string; hideSTARTTLS?: boolean }): Promise<MailSink> {
  const messages: Captured[] = [];
  const logins: { user: string; ok: boolean }[] = [];
  const refuse = { address: null as string | null, reply: { code: 550, text: "Mailbox unavailable" } };
  const user = o.user ?? "sender", pass = o.pass ?? "sink-password";
  const server = new smtp.SMTPServer({
    secure: o.secure, key: o.key, cert: o.cert, hideSTARTTLS: o.hideSTARTTLS ?? false,
    // hideSTARTTLS only hides the advertisement; a client that insists still gets the upgrade. Refuse it too.
    disabledCommands: o.hideSTARTTLS ? ["STARTTLS"] : [], disableReverseLookup: true, logger: false,
    onAuth(auth, _session, cb) {
      logins.push({ user: String(auth.username), ok: auth.username === user && auth.password === pass });
      if (auth.username === user && auth.password === pass) cb(null, { user: auth.username });
      else cb(Object.assign(new Error("Invalid username or password"), { responseCode: 535 }));
    },
    onRcptTo(address, _session, cb) {
      // smtp-server sends the code and the message as the reply line (no enhanced code of its own: hideENHANCEDSTATUSCODES is its default).
      if (refuse.address !== null && (refuse.address === "*" || address.address.toLowerCase() === refuse.address.toLowerCase())) cb(Object.assign(new Error(refuse.reply.text), { responseCode: refuse.reply.code }));
      else cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        messages.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          user: typeof session.user === "string" ? session.user : null,
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port, messages, logins, close: () => new Promise<void>((r) => server.close(() => r())),
    get rejectRecipient() { return refuse.address; }, set rejectRecipient(v: string | null) { refuse.address = v; },
    get rejectReply() { return refuse.reply; }, set rejectReply(v: { code: number; text: string }) { refuse.reply = v; },
  };
}
