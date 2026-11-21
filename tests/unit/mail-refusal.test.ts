import { describe, it, expect } from "vitest";
import { enhancedStatus, refusedThisRecipient } from "@/lib/mail/refusal";

// What counts as one recipient's own trouble and what as the mail failing (the lead's decision for SI-4's last round):
// a reply at RCPT TO, 4xx or 5xx, is the recipient's own unless its enhanced status is of class x.7.x, x.3.x or x.4.x;
// everything that is not a reply at RCPT TO is the mail failing. The shapes are nodemailer's (code, command,
// responseCode, response), as smtp-connection's _formatError() builds them.
const rcpt = (response: string) => ({ code: "EENVELOPE", command: "RCPT TO", responseCode: Number(response.slice(0, 3)), response });

describe("refusedThisRecipient", () => {
  it.each([
    // The recipient's own: a bad or unknown mailbox, a full one, a refusal with no enhanced code.
    ["550 5.1.1 The email account that you tried to reach does not exist", true],
    ["553 5.1.3 Mailbox name not allowed", true],
    ["552 5.2.2 Mailbox full", true],
    ["550 Mailbox unavailable", true],
    ["452 4.2.2 The email account that you tried to reach is over quota", true],
    ["450 4.2.1 The user you are trying to contact is receiving mail too quickly", true],
    ["550-5.1.1 The email account that you tried to reach does not exist", true],
    // The mail failing: policy or relaying refused, the mail system, the network.
    ["554 5.7.1 Relay access denied", false],
    ["550 5.7.54 SMTP; Unable to relay recipient in non-accepted domain", false],
    ["550 5.7.0 Mail relay denied", false],
    ["451 4.7.1 Greylisted, try again later", false],
    ["452 4.3.1 Insufficient system storage", false],
    ["451 4.4.1 No answer from host", false],
    ["550 5.3.4 Message too big for system", false],
    ["421 4.4.2 Connection dropped", false],
  ] as const)("a reply at RCPT TO of %s: the recipient's own is %s", (response, own) => {
    expect(refusedThisRecipient(rcpt(response))).toBe(own);
  });

  it.each([
    ["signing in", { code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, response: "535 5.7.8 Authentication credentials invalid" }],
    ["MAIL FROM", { code: "EENVELOPE", command: "MAIL FROM", responseCode: 550, response: "550 5.1.0 Sender rejected" }],
    ["DATA", { code: "EMESSAGE", command: "DATA", responseCode: 550, response: "550 5.1.1 Recipient rejected after DATA" }],
    ["connecting", { code: "ECONNECTION" }],
    ["a timeout", { code: "ETIMEDOUT", command: "CONN" }],
    ["a reply at RCPT TO with no code", { code: "EENVELOPE", command: "RCPT TO" }],
    ["a 2xx at RCPT TO, read oddly", { code: "EENVELOPE", command: "RCPT TO", responseCode: 250, response: "250 2.1.5 OK" }],
    ["nothing at all", {}],
  ] as const)("anything that is not a refusal at RCPT TO is the mail failing: %s", (_what, failure) => {
    expect(refusedThisRecipient(failure)).toBe(false);
  });
});

describe("enhancedStatus", () => {
  it("reads the enhanced code after the reply's code, or none", () => {
    expect(enhancedStatus("550 5.7.54 Unable to relay")).toEqual({ class: 5, subject: 7, detail: 54 });
    expect(enhancedStatus("452-4.2.2 Over quota")).toEqual({ class: 4, subject: 2, detail: 2 });
    expect(enhancedStatus("550 Mailbox unavailable")).toBeNull();
    expect(enhancedStatus("550 5.1")).toBeNull();
    expect(enhancedStatus(undefined)).toBeNull();
  });
});
