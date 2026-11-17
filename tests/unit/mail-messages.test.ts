import { describe, it, expect } from "vitest";
import { signinCodeMessage, welcomeMessage, emailChangeConfirmMessage, emailChangeNoticeMessage, testMessage, reviewNoticeMessage, signedFormCopyMessage, formReminderMessage, volunteerSignupMessage } from "@/lib/mail/messages";

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
  it("the staff review notice gives two numbers and a link, and names nobody", () => {
    const m = reviewNoticeMessage({ clubName: "FZN Band Boosters", color: "#005102" }, "reg@club.org", { newCount: 2, waiting: 5, link: "https://portal.example.org/staff/parents" });
    expect(m.subject).toBe("FZN Band Boosters: 2 parent sign-ins to review");
    expect(m.text).toContain("2 new");
    expect(m.text).toContain("5 waiting in all");
    expect(m.text).toContain("https://portal.example.org/staff/parents");
    expect(reviewNoticeMessage({ clubName: "C", color: "#005102" }, "r@c.org", { newCount: 1, waiting: 1, link: "x" }).subject).toBe("C: 1 parent sign-in to review");
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
});
