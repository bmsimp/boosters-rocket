import { describe, it, expect } from "vitest";
import { changeCodeMessage, signinCodeMessage, welcomeMessage, emailChangeConfirmMessage, emailChangeNoticeMessage, testMessage, signedFormCopyMessage, formReminderMessage, volunteerSignupMessage,
  passwordSetupMessage, passwordResetMessage, choosePasswordMessage, passwordChangedMessage, signinResetMessage } from "@/lib/mail/messages";

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
  it("the code for a change asked in a session says what it's for, and what to do if it wasn't them, and nothing of a device", () => {
    // Asking again (the sign-in release, slice SI-5a): the parent is signed in already, so a device the portal doesn't
    // know has nothing to do with it. The sign-in code's mail (above) is unchanged.
    const settingsPage = "https://portal.example.org/family/sign-in";
    const m = changeCodeMessage(b, "ana@example.com", "482913", { settingsPage, minutes: 10 });
    expect(m.to).toBe("ana@example.com");
    // The subject carries the code with the sign-in code's words, which the test helpers read.
    expect(m.subject).toBe("Your FZN <Band> Boosters sign-in code: 482913, to confirm a change");
    expect(m.text).toBe([
      "Your FZN <Band> Boosters sign-in code is 482913.",
      "Someone signed in to the FZN <Band> Boosters portal as you has asked to change how you sign in. This code confirms that change. It expires in 10 minutes.",
      `If that wasn't you, don't share this code. Sign out everywhere from Sign-in settings at ${settingsPage}, or ask the club for help.`,
    ].join("\n\n") + "\n");
    for (const part of [m.text, m.html]) {
      expect(part).toContain("482913");
      expect(part).not.toMatch(/device|entered correctly|reset my password/i);
      // The one address it names is Sign-in settings; no image, and no link tag.
      expect(part.match(/https?:\/\/[^\s<"]+/g)).toEqual([`${settingsPage},`]);
      expect(part).not.toMatch(/<a\b|<img\b/i);
    }
    expect(m.html).toContain("If that wasn&#39;t you, don&#39;t share this code.");
    expect(changeCodeMessage(b, "ana@example.com", "482913", { settingsPage, minutes: 1 }).text).toContain("It expires in 1 minute.");
  });
  it("escapes the club name in HTML and uses the club color", () => {
    const m = signinCodeMessage(b, "ana@example.com", "482913", { passwordPage, minutes: 10 });
    expect(m.html).toContain("FZN &lt;Band&gt; Boosters");
    expect(m.html).not.toContain("<Band>");
    expect(m.html).toContain("#5b2a86");
  });
  it("the welcome names the club and the address, says how to sign in, and gives the contact when there is one", () => {
    for (const link of [null, { url: "https://portal.example.org/sign-in/set-up/AbC-123_xyz", life: "7 days", strict: false }, { earlier: true as const, strict: false }]) {
      const m = welcomeMessage({ clubName: "FZN Band Boosters", color: "#005102" }, "ana@example.com", { appUrl: "https://portal.example.org", contact: "webmaster@fznband.org", link });
      expect(m.to).toBe("ana@example.com");
      expect(m.subject).toBe("You can now sign in to FZN Band Boosters");
      expect(m.text).toContain("https://portal.example.org");
      expect(m.text).toContain("with this email address");
      expect(m.text).toContain("Questions? Write to webmaster@fznband.org.");
      expect(m.text).not.toContain("code");
      expect(welcomeMessage({ clubName: "C", color: "#005102" }, "a@example.com", { appUrl: "https://p.example", contact: null, link }).text).not.toContain("Questions?");
    }
  });
  it("the welcome holds no family details, with a link or without", () => {
    for (const link of [null, { url: "https://p.example/sign-in/set-up/AbC-123_xyz", life: "7 days", strict: false }, { url: "https://p.example/sign-in/set-up/AbC-123_xyz", life: "7 days", strict: true },
      { earlier: true as const, strict: false }, { earlier: true as const, strict: true }]) {
      const m = welcomeMessage({ clubName: "C", color: "#005102" }, "a@example.com", { appUrl: "https://p.example", contact: null, link });
      expect(`${m.text}${m.html.replace(/font-family:/g, "")}`).not.toMatch(/family|guardian|student/i); // the inline CSS property is not wording
    }
  });

  // The welcome and the press's mail since the sign-in release's slice SI-4 (src/lib/parents/welcome.ts).
  describe("the welcome and the mail for those welcomed before", () => {
    const appUrl = "https://portal.example.org";
    const url = "https://portal.example.org/sign-in/set-up/AbC-123_xyz";
    const standard = { url, life: "7 days", strict: false }, strict = { url, life: "7 days", strict: true };
    /** The sentences of the HTML part, as text: every paragraph, unescaped, a link's paragraph as its address. */
    const htmlLines = (h: string) => [...h.matchAll(/<p style="margin:0 0 16px">([\s\S]*?)<\/p>/g)]
      .map((m) => m[1]!.replace(/^<a href="([^"]*)">\1<\/a>$/, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
    const textLines = (t: string) => t.trim().split("\n\n");
    const messages = [
      ["the welcome at Standard", welcomeMessage(b, "ana@example.com", { appUrl, contact: "boosters@example.org", link: standard })],
      ["the welcome at Strict", welcomeMessage(b, "ana@example.com", { appUrl, contact: "boosters@example.org", link: strict })],
      ["the welcome with no link", welcomeMessage(b, "ana@example.com", { appUrl, contact: "boosters@example.org", link: null })],
      ["the mail to choose a password at Standard", choosePasswordMessage(b, "ana@example.com", { appUrl, contact: "boosters@example.org", link: standard })],
      ["the mail to choose a password at Strict", choosePasswordMessage(b, "ana@example.com", { appUrl, contact: null, link: strict })],
      ["the welcome with the link sent earlier, at Standard", welcomeMessage(b, "ana@example.com", { appUrl, contact: "boosters@example.org", link: { earlier: true, strict: false } })],
      ["the welcome with the link sent earlier, at Strict", welcomeMessage(b, "ana@example.com", { appUrl, contact: null, link: { earlier: true, strict: true } })],
    ] as const;

    it.each(messages)("%s: the text and the HTML hold the same sentences", (_name, m) => {
      expect(htmlLines(m.html)).toEqual(textLines(m.text));
    });
    it.each(messages)("%s: names no family, student or other person, and says the club never asks for a password", (_name, m) => {
      expect(`${m.text}${m.html.replace(/font-family:/g, "")}`).not.toMatch(/family|student|guardian/i);
      expect(m.text).toContain("FZN <Band> Boosters will never ask you for your password, by email or by phone.");
      expect(m.html).toContain("FZN &lt;Band&gt; Boosters");
      expect(m.html).not.toContain("<Band>");
    });

    it("a welcome with a link has it on a line of its own, its life in words, and where to ask for a new one, in full", () => {
      const m = messages[0][1];
      expect(m.text.split("\n")).toContain(url);
      expect(m.text).toContain("The link works once, for 7 days. After that, you sign in with this email address and the password you chose.");
      expect(m.text).toContain("If the link runs out before you use it, you can ask for a new one at https://portal.example.org/sign-in/password");
      expect(m.text).not.toContain("ask the club");
      expect(m.text).not.toContain("passkey");
    });
    it("at Strict it says what the password leads to, and to ask the club for a new link, since the request page mails no set-up link there", () => {
      // Slice SI-10b: the third and fourth lines at Strict, word for word; changed on purpose from SI-4's "send this email again".
      for (const [, m] of [messages[1], messages[4]]) {
        expect(m.text.split("\n")).toContain(url);
        const lines = textLines(m.text);
        const at = lines.indexOf(url);
        expect(lines.slice(at + 1, at + 3)).toEqual([
          "The link works once, for 7 days. Once you've chosen your password, the portal asks you to add a passkey or an authenticator app, which you'll use each time you sign in.",
          "If the link runs out before you use it, please ask the club to send you a new one.",
        ]);
        expect(m.text).not.toContain("send this email again");
        expect(m.text).not.toContain("/sign-in/password");
        expect(m.text).not.toContain("After that, you sign in with this email address and the password you chose.");
      }
      // The mail to choose a password says nothing at Strict of a device staying signed in: the switch signs out a guardian with neither.
      expect(messages[4][1].text).not.toContain("stays signed in");
      expect(messages[1][1].text).toContain("First, choose your password with this link:");
    });
    it("a welcome with no link says to sign in with the password, at the sign-in page in full, and carries no link to choose one", () => {
      const m = messages[2][1];
      expect(m.text).toContain("You can now sign in to FZN <Band> Boosters with this email address and your password, at https://portal.example.org/sign-in");
      expect(m.text).not.toContain("/sign-in/set-up/");
      expect(m.text.match(/https?:\/\/[^\s<"]+/g)).toEqual(["https://portal.example.org/sign-in"]);
    });
    it("the mail for those welcomed before says how they sign in, true whenever they were welcomed, and that a device signed in now stays so", () => {
      const m = messages[3][1];
      expect(m.subject).toBe("Choose your password for FZN <Band> Boosters");
      expect(m.text).toContain("You sign in to the FZN <Band> Boosters portal at https://portal.example.org with this email address and a password. To choose your password, open this link:");
      // Nothing about a change, or a code: it goes to someone whose welcome's link ran out unused, too.
      expect(m.text).not.toMatch(/changed|code/);
      expect(m.text.split("\n")).toContain(url);
      expect(m.text).toContain("The link works once, for 7 days.");
      expect(m.text).toContain("you can ask for a new one at https://portal.example.org/sign-in/password");
      expect(m.text).toContain("If you're signed in to the portal on a phone or computer now, it stays signed in, and you'll need your password the next time you sign in.");
      expect(m.text).toContain("Questions? Write to boosters@example.org.");
      expect(messages[4][1].text).not.toContain("Questions?");
    });
    it("a welcome to someone holding a link that still works carries no link, says it still works, and where to ask for another", () => {
      const m = messages[5][1];
      expect(m.subject).toBe("You can now sign in to FZN <Band> Boosters");
      expect(m.text).toContain("You can now sign in to FZN <Band> Boosters at https://portal.example.org with this email address.");
      expect(m.text).toContain("A link to choose your password was emailed to you earlier, and it still works.");
      expect(m.text).toContain("If you can't find it, you can ask for a new one at https://portal.example.org/sign-in/password");
      expect(m.text).not.toContain("/sign-in/set-up/");
      expect(m.html).not.toMatch(/<a\b/);
      const strictOne = messages[6][1];
      expect(strictOne.text).toContain("If you can't find it, please ask the club to send you a new one.");
      expect(strictOne.text).not.toContain("/sign-in/password");
    });
    it.each([messages[0], messages[1], messages[3], messages[4]])("%s: the link is alone on its line in the text, and an anchor of itself alone in its paragraph in the HTML", (_name, m) => {
      expect(m.text.split("\n").filter((l) => l.includes(url))).toEqual([url]);
      expect(m.html).toContain(`<p style="margin:0 0 16px"><a href="${url}">${url}</a></p>`);
      expect(m.html.split(url)).toHaveLength(3); // the anchor's href and its text, and nowhere else
    });
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
      expect(m.html).toContain(`<p style="margin:0 0 16px"><a href="${link}">${link}</a></p>`);
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

  // The notice after a password changed in sign-in settings (slice SI-5a; src/lib/parents/signin-settings.ts).
  describe("the notice that a password was changed", () => {
    const m = passwordChangedMessage(b, "ana@example.com", { passwordPage, contact: "treasurer@boosters.example.org" });
    /** The words of the mail's HTML body, with its markup taken out and its escaping undone. */
    const htmlWords = m.html.replace(/<div style="background[^>]*>[^<]*<\/div>/, "").replace(/<[^>]+>/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => l.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
    it("says where to write to the club when it has an address, and leaves the line out when it has none", () => {
      // The reader is signed out everywhere, so the mail itself says where to tell the club.
      expect(m.text).toContain("You can write to the club at treasurer@boosters.example.org.");
      expect(m.html).toContain("You can write to the club at treasurer@boosters.example.org.");
      const none = passwordChangedMessage(b, "ana@example.com", { passwordPage, contact: null });
      expect(`${none.text}${none.html}`).not.toContain("You can write to the club");
      expect(none.text.trim().split("\n\n")).toHaveLength(m.text.trim().split("\n\n").length - 1);
    });
    it("goes to the address, says the password changed and every device was signed out, and where to set a new one", () => {
      expect(m.to).toBe("ana@example.com");
      expect(m.subject).toBe("Your FZN <Band> Boosters password was changed");
      expect(m.text).toContain("was changed just now, and every phone and computer signed in to the portal was signed out.");
      expect(m.text).toContain(`If you didn't change it, please set a new password straight away from "Set up or reset my password" at ${passwordPage}, and tell the club.`);
      expect(m.text).toContain("FZN <Band> Boosters will never ask you for your password, by email or by phone.");
    });
    it("holds the request page's whole address and no link that acts: no token, no set-up or reset link", () => {
      expect(m.text).toContain("https://portal.example.org/sign-in/password,");
      expect(`${m.text}${m.html}`).not.toMatch(/\/sign-in\/(set-up|reset)\//);
      expect(m.html).not.toMatch(/<a\s/);
    });
    it("says the same in its text and its HTML, names no family, student or other person, and escapes the club's name", () => {
      expect(htmlWords).toEqual(m.text.trim().split("\n\n"));
      expect(`${m.text}${m.html.replace(/font-family:/g, "")}`).not.toMatch(/family|student|guardian/i);
      expect(m.html).toContain("FZN &lt;Band&gt; Boosters");
      expect(m.html).not.toContain("<Band>");
    });
  });

  // An Admin's reset of a parent's sign-in (slice SI-9a; src/lib/parents/signin-reset.ts).
  describe("the mail of a reset of a parent's sign-in", () => {
    const link = "https://portal.example.org/sign-in/set-up/AbC-123_xyz";
    const m = signinResetMessage(b, "ana@example.com", { link, life: "7 days", contact: "treasurer@boosters.example.org", strict: false });
    /** The words of the mail's HTML body, with its markup taken out and its escaping undone. */
    const htmlWords = m.html.replace(/<div style="background[^>]*>[^<]*<\/div>/, "").replace(/<[^>]+>/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => l.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
    it("goes to the address, with its subject, the set-up link on a line of its own and how long it works", () => {
      expect(m.to).toBe("ana@example.com");
      expect(m.subject).toBe("Your FZN <Band> Boosters sign-in was reset");
      expect(m.text.split("\n")).toContain(link);
      expect(m.html).toContain(`<p style="margin:0 0 16px"><a href="${link}">${link}</a></p>`);
      for (const part of [m.text, m.html]) expect(part).toContain("The link works once, for 7 days.");
    });
    it("says what no longer works, what to do next, and to contact the club straight away if the reader didn't ask", () => {
      expect(m.text).toContain("Someone at FZN <Band> Boosters reset how you sign in to the portal with this email address. Your password, passkeys, authenticator app and backup codes no longer work, and every phone and computer that was signed in has been signed out.");
      expect(m.text).toContain("Once you've chosen your password, you can add a passkey or an authenticator app again under Sign-in settings.");
      expect(m.text).toContain("If you asked the club for this, that's all there is to do.");
      expect(m.text).toContain("If you didn't ask the club for this, please contact the club straight away: someone may be trying to get into your account.");
      expect(m.text).toContain("FZN <Band> Boosters will never ask you for your password, by email or by phone.");
    });
    it("says where to write to the club when it has an address, and leaves the line out when it has none", () => {
      expect(m.text).toContain("You can write to the club at treasurer@boosters.example.org.");
      const none = signinResetMessage(b, "ana@example.com", { link, life: "7 days", contact: null, strict: false });
      expect(`${none.text}${none.html}`).not.toContain("You can write to the club");
      expect(none.text.trim().split("\n\n")).toHaveLength(m.text.trim().split("\n\n").length - 1);
    });
    it("at Strict says the password leads first to adding a passkey or an authenticator app, in place of Standard's line (slice SI-10b)", () => {
      const strict = signinResetMessage(b, "ana@example.com", { link, life: "7 days", contact: "treasurer@boosters.example.org", strict: true });
      const lines = strict.text.trim().split("\n\n");
      expect(lines[3]).toBe("The link works once, for 7 days. Once you've chosen your password, the portal asks you to add a passkey or an authenticator app before anything else.");
      expect(m.text.trim().split("\n\n")[3]).toBe("The link works once, for 7 days. Once you've chosen your password, you can add a passkey or an authenticator app again under Sign-in settings.");
      expect(strict.text).not.toContain("again under Sign-in settings");
      // Every other line as Standard's.
      expect(lines.filter((_l, i) => i !== 3)).toEqual(m.text.trim().split("\n\n").filter((_l, i) => i !== 3));
      expect(`${strict.text}${strict.html.replace(/font-family:/g, "")}`).not.toMatch(/family|student|guardian|admin|staff/i);
    });
    it("says the same in its text and its HTML, names no family, student, guardian or Admin, and escapes the club's name", () => {
      expect(htmlWords).toEqual(m.text.trim().split("\n\n"));
      expect(`${m.text}${m.html.replace(/font-family:/g, "")}`).not.toMatch(/family|student|guardian|admin|staff/i);
      expect(m.html).toContain("FZN &lt;Band&gt; Boosters");
      expect(m.html).not.toContain("<Band>");
    });
  });
});
