import { describe, it, expect } from "vitest";
import { signinCodeMessage, welcomeMessage, emailChangeConfirmMessage, emailChangeNoticeMessage, testMessage } from "@/lib/mail/messages";

const b = { clubName: "FZN <Band> Boosters", color: "#5b2a86" };

describe("mail messages", () => {
  it("puts the code in the subject and body, says 10 minutes, and has no link", () => {
    const m = signinCodeMessage(b, "ana@example.com", "482913");
    expect(m.subject).toBe("Your FZN <Band> Boosters sign-in code: 482913");
    expect(m.to).toBe("ana@example.com");
    for (const part of [m.text, m.html]) {
      expect(part).toContain("482913");
      expect(part).toMatch(/expires in 10 minutes/);
      expect(part).toMatch(/didn(?:'|&#39;)t ask for this code/);
      expect(part).not.toMatch(/https?:\/\/|<a\b|<img\b/i);
    }
  });
  it("escapes the club name in HTML and uses the club color", () => {
    const m = signinCodeMessage(b, "ana@example.com", "482913");
    expect(m.html).toContain("FZN &lt;Band&gt; Boosters");
    expect(m.html).not.toContain("<Band>");
    expect(m.html).toContain("#5b2a86");
  });
  it("welcomes a new person with the portal address and no code", () => {
    const m = welcomeMessage(b, "ana@example.com", { appUrl: "https://portal.example.org", familyLabel: null });
    expect(m.text).toContain("You can now sign in to FZN <Band> Boosters at https://portal.example.org with this email address. We'll email you a code each time.");
    expect(m.text).not.toMatch(/\b\d{6}\b/);
  });
  it("names the family when an existing person is added to another one", () => {
    expect(welcomeMessage(b, "a@example.com", { appUrl: "https://p.example.org", familyLabel: "the Smith family" }).text)
      .toContain("You've been added as a guardian for the Smith family.");
  });
  it("puts the confirm link only in the confirm message, and none in the notice", () => {
    expect(emailChangeConfirmMessage(b, "new@example.com", { link: "https://p.example.org/email-change/confirm?token=abc" }).text)
      .toContain("https://p.example.org/email-change/confirm?token=abc");
    expect(emailChangeNoticeMessage(b, "old@example.com", { byStaff: false }).text).not.toMatch(/https?:\/\//);
    expect(emailChangeNoticeMessage(b, "old@example.com", { byStaff: true }).text).toMatch(/The club changed/);
  });
  it("has a plain test message", () => {
    expect(testMessage(b, "admin@example.org").subject).toBe("Test email from FZN <Band> Boosters");
  });
});
