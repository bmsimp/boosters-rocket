import type { MailMessage } from "./types";

export type Brand = { clubName: string; color: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const COLOR = /^#[0-9a-f]{6}$/i;

/** Simple HTML: a colored bar with the club name, then paragraphs. No images, no remote content. */
function html(b: Brand, paragraphs: string[], big?: string): string {
  const color = COLOR.test(b.color) ? b.color : "#5b2a86";
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p)}</p>`).join("");
  const code = big ? `<p style="margin:0 0 16px;font-size:32px;letter-spacing:6px;font-weight:bold">${esc(big)}</p>` : "";
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">`
    + `<div style="background:${color};color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold">${esc(b.clubName)}</div>`
    + `<div style="padding:24px">${code}${body}</div></body></html>`;
}
const text = (lines: string[]) => `${lines.join("\n\n")}\n`;

export function signinCodeMessage(b: Brand, to: string, code: string): MailMessage {
  const lines = [
    `Your ${b.clubName} sign-in code is ${code}.`,
    "It expires in 10 minutes.",
    "If you didn't ask for this code, you can ignore this email. Nobody can sign in without it.",
  ];
  return { to, subject: `Your ${b.clubName} sign-in code: ${code}`, text: text(lines), html: html(b, lines, code) };
}

/** The welcome (parents spec §3). It holds no family details: the address alone decides what the person sees after signing in. */
export function welcomeMessage(b: Brand, to: string, o: { appUrl: string; contact: string | null }): MailMessage {
  const lines = [
    `You can now sign in to ${b.clubName} at ${o.appUrl} with this email address. We'll email you a code each time, so there is no password.`,
    ...(o.contact ? [`Questions? Write to ${o.contact}.`] : []),
  ];
  return { to, subject: `You can now sign in to ${b.clubName}`, text: text(lines), html: html(b, lines) };
}

/** To staff who can decide held addresses (parents spec §5). Two numbers and a link: no family, person or address. */
export function reviewNoticeMessage(b: Brand, to: string, o: { newCount: number; waiting: number; link: string }): MailMessage {
  const items = (n: number) => `${n} parent ${n === 1 ? "sign-in" : "sign-ins"}`;
  const lines = [
    `${o.newCount} new, ${o.waiting} waiting in all: some email addresses in QuickBooks are under more than one family, so the people at those addresses can't sign in until someone reviews them.`,
    `Review them here: ${o.link}`,
    "You won't be reminded about these again. They stay on the staff home page until they are decided.",
  ];
  return { to, subject: `${b.clubName}: ${items(o.newCount)} to review`, text: text(lines), html: html(b, lines) };
}

export function emailChangeConfirmMessage(b: Brand, to: string, o: { link: string }): MailMessage {
  const lines = [
    `Someone asked to use this address to sign in to ${b.clubName}. If it was you, open this link within 24 hours to confirm:`,
    o.link,
    "If it wasn't you, ignore this email and nothing changes.",
  ];
  return { to, subject: `Confirm your new email for ${b.clubName}`, text: text(lines), html: html(b, lines) };
}

export function emailChangeNoticeMessage(b: Brand, to: string, o: { byStaff: boolean }): MailMessage {
  const lines = o.byStaff
    ? [`The club changed the email address you sign in to ${b.clubName} with. This address no longer works for signing in.`, "If this is a surprise, contact the club."]
    : [`Someone asked to change the email address you sign in to ${b.clubName} with. Nothing changes until the new address is confirmed.`, "If it wasn't you, contact the club."];
  return { to, subject: `Your ${b.clubName} sign-in email`, text: text(lines), html: html(b, lines) };
}

export function testMessage(b: Brand, to: string): MailMessage {
  const lines = [`This is a test from the ${b.clubName} portal. Outgoing mail works.`];
  return { to, subject: `Test email from ${b.clubName}`, text: text(lines), html: html(b, lines) };
}
