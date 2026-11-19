import { describe, it, expect } from "vitest";
import { signinCodeMessage, welcomeMessage, emailChangeConfirmMessage, emailChangeNoticeMessage, testMessage, signedFormCopyMessage, formReminderMessage, volunteerSignupMessage,
  passwordSetupMessage, passwordResetMessage } from "@/lib/mail/messages";

const b = { clubName: "FZN <Band> Boosters", color: "#5b2a86" };

describe("mail messages", () => {
  const passwordPage = "https://portal.example.org/sign-in/password";
  it("puts the code in the subject and body, says 10 minutes, and says what to do if the reader didn't just sign in", () => {
    const m = signinCodeMessage(b, "ana@example.com", "482913", { passwordPage, minutes: 10 });
    expect(m.subject).toBe("Your FZN <Band> Boosters sign-in code: 482913");
    expect(m.to).toBe("ana@example.com");
    for (const part of [m.text, m.html]) {
      expect(part).toContain("482913");
      expect(part).toMatch(/expires in 10 minutes/);
      // A code is sent only after the right password (the sign-in release, slice SI-3b), so it says so.
      expect(part).toMatch(/your password was entered correctly/);
      expect(part).toMatch(/didn(?:'|&#39;)t just sign in/);
      expect(part).toMatch(/someone may know your password/);
      expect(part).toMatch(/Set up or reset my password/);
      // The one address it names is the page to set a new password; no image, and no link tag.
      expect(part.match(/https?:\/\/[^\s<"]+/g)).toEqual([passwordPage]);
      expect(part).not.toMatch(/<a\b|<img\b/i);
    }
  });
  it("a code resent late in its pending step says the minutes it has left, never 10", () => {
    // A code never outlives its pending step (sendSecondStepCode()), so its mail says what is left of it.
    for (const [minutes, words] of [[4, "expires in 4 minutes"], [1, "expires in 1 minute."]] as const) {
      const m = signinCodeMessage(b, "ana@example.com", "482913", { passwordPage, minutes });
      for (const part of [m.text, m.html]) {
        expect(part).toContain(words);
        expect(part).not.toContain("10 minutes");
      }
    }
  });
  it("escapes the club name in HTML and uses the club color", () => {
    const m = signinCodeMessage(b, "ana@example.com", "482913", { passwordPage, minutes: 10 });
    expect(m.html).toContain("FZN &lt;Band&gt; Boosters");
    expect(m.html).not.toContain("<Band>");
    expect(m.html).toContain("#5b2a86");
  });
  it("the welcome names the club and the address, says how to sign in, and gives the contact when there is one", () => {
    const m = welcomeMessage({ clubName: "FZN Band Boosters", color: "#005102" }, "ana@example.com", { appUrl: "https://portal.example.org", contact: "webmaster@fznband.org" });
    expect(m.to).toBe("ana@example.com");
    expect(m.subject).toBe("You can now sign in to FZN Band Boosters");
    expect(m.text).toContain("https://portal.example.org");
    expect(m.text).toContain("with this email address");
    expect(m.text).toContain("Questions? Write to webmaster@fznband.org.");
    expect(welcomeMessage({ clubName: "C", color: "#005102" }, "a@example.com", { appUrl: "https://p.example", contact: null }).text).not.toContain("Questions?");
  });
  it("the welcome holds no family details", () => {
    const m = welcomeMessage({ clubName: "C", color: "#005102" }, "a@example.com", { appUrl: "https://p.example", contact: null });
    expect(`${m.text}${m.html.replace(/font-family:/g, "")}`).not.toMatch(/family|guardian/i); // the inline CSS property is not wording
  });
  it("puts the confirm link only in the confirm message, and none in the notice", () => {
    expect(emailChangeConfirmMessage(b, "new@example.com", { link: "https://p.example.org/family/email/abc" }).text)
      .toContain("https://p.example.org/family/email/abc");
    const notice = emailChangeNoticeMessage(b, "old@example.com");
    expect(notice.text).not.toMatch(/https?:\/\//);
    expect(notice.text).toContain("Someone asked to change the email address you sign in to");
    expect(notice.text).toContain("If it wasn't you, please tell the club.");
  });
  it("has a plain test message", () => {
    expect(testMessage(b, "admin@example.org").subject).toBe("Test email from FZN <Band> Boosters");
  });

  it("writes QuickBooks' and the club's own text into the HTML as text, never as markup (v1 spec §12, invariant 6)", () => {
    const hostile = `<img src=x onerror="alert(1)"> & <b>`;
    const shift = { event: hostile, role: hostile, when: "Saturday", location: hostile };
    const messages = [
      volunteerSignupMessage(b, "ana@example.com", { who: { self: false, name: hostile }, shift, contact: hostile, cancelUntil: null, link: "https://portal.example/volunteer", calendar: "" }),
      signedFormCopyMessage(b, "ana@example.com", { formTitle: hostile, forName: hostile, pdf: null, link: "https://portal.example/forms" }),
      formReminderMessage(b, "ana@example.com", { formTitle: hostile, forNames: [hostile], due: null, link: "https://portal.example/forms" }),
    ];
    for (const m of messages) {
      expect(m.html).not.toContain("<img");
      expect(m.html).not.toContain("<b>");
      expect(m.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;b&gt;");
      expect(m.text).toContain(hostile);
    }
  });

  // The two links of "Set up or reset my password" (slice SI-3a; src/lib/parents/password-request.ts).
  describe.each([
    ["set-up", passwordSetupMessage, "https://portal.example.org/sign-in/set-up/AbC-123_xyz", "7 days", "Set up your FZN <Band> Boosters password"],
    ["reset", passwordResetMessage, "https://portal.example.org/sign-in/reset/AbC-123_xyz", "1 hour", "Reset your FZN <Band> Boosters password"],
  ] as const)("the %s link's mail", (_name, message, link, life, subject) => {
    const m = message(b, "ana@example.com", { link, life });
    it("goes to the address, with its subject, the link on a line of its own and how long it works", () => {
      expect(m.to).toBe("ana@example.com");
      expect(m.subject).toBe(subject);
      expect(m.text.split("\n")).toContain(link);
      expect(m.html).toContain(`<p style="margin:0 0 16px">${link}</p>`);
      for (const part of [m.text, m.html]) expect(part).toContain(`The link works once, for ${life}.`);
    });
    it("says the club never asks for a password by email or phone, and what to do if the reader didn't ask", () => {
      expect(m.text).toContain("FZN <Band> Boosters will never ask you for your password, by email or by phone.");
      expect(m.text).toContain("If you didn't ask for this, you can ignore this email: nothing changes unless the link is used.");
      expect(m.text).toContain("If these emails keep coming, please tell the club.");
    });
    it("names no family, student or other person, and escapes the club's name", () => {
      expect(`${m.text}${m.html.replace(/font-family:/g, "")}`).not.toMatch(/family|student|guardian/i); // the inline CSS property is not wording
      expect(m.html).toContain("FZN &lt;Band&gt; Boosters");
      expect(m.html).not.toContain("<Band>");
    });
  });
});
