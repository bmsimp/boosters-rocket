import { describe, it, expect, beforeEach, vi } from "vitest";
import { installDevice, installHintView, offerDevice, type InstallDevice } from "@/app/components/pwa/install-platform";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const UA = {
  iphoneSafari: `${IPHONE} Version/18.5 Mobile/15E148 Safari/604.1`,
  iphoneChrome: `${IPHONE} CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1`,
  iphoneFirefox: `${IPHONE} FxiOS/140.0 Mobile/15E148 Safari/605.1.15`,
  iphoneFacebook: `${IPHONE} Mobile/15E148 [FBAN/FBIOS;FBAV/520.0.0.38.101;FBBV/750000000;FBDV/iPhone15,3]`,
  iphoneInstagram: `${IPHONE} Mobile/15E148 Instagram 385.0.0.25.87 (iPhone15,3; iOS 18_5; en_US)`,
  iphoneWebView: `${IPHONE} Mobile/15E148`, // a mail or chat app's own browser
  iphoneGoogleApp: `${IPHONE} GSA/370.0.762543316 Mobile/15E148 Safari/604.1`,
  ipadSafari: "Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.7 Mobile/15E148 Safari/604.1",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
  androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
};

describe("which way of installing a browser has", () => {
  it.each([
    ["Safari on an iPhone", UA.iphoneSafari], ["Chrome on an iPhone", UA.iphoneChrome], ["Firefox on an iPhone", UA.iphoneFirefox],
    ["Safari on an iPad", UA.ipadSafari],
  ])("%s: the Share steps", (_what, userAgent) => {
    expect(installDevice({ userAgent, maxTouchPoints: 5 })).toBe("ios");
  });

  it("an iPad that says it is a Mac is still an iPad", () => {
    expect(installDevice({ userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 5 })).toBe("ios");
    expect(installDevice({ userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 0 })).toBe("other");
    expect(installDevice({ userAgent: UA.macSafari, platform: "MacIntel" })).toBe("other");
  });

  it.each([
    ["Facebook", UA.iphoneFacebook], ["Instagram", UA.iphoneInstagram], ["a mail app's own browser", UA.iphoneWebView], ["the Google app", UA.iphoneGoogleApp],
  ])("inside %s on an iPhone: open in Safari first", (_what, userAgent) => {
    expect(installDevice({ userAgent, maxTouchPoints: 5 })).toBe("ios-in-app");
  });

  it.each([["Chrome on Android", UA.androidChrome], ["Edge on Windows", UA.windowsEdge], ["Firefox on Android", UA.androidFirefox]])("%s: not an Apple device", (_what, userAgent) => {
    expect(installDevice({ userAgent, platform: "Linux armv81", maxTouchPoints: 5 })).toBe("other");
  });

  it("is installed when opened from the home screen, on either kind of phone", () => {
    expect(installDevice({ userAgent: UA.iphoneSafari, iosStandalone: true })).toBe("installed");
    expect(installDevice({ userAgent: UA.androidChrome, displayStandalone: true })).toBe("installed");
    expect(installDevice({ userAgent: UA.iphoneWebView, displayStandalone: true })).toBe("installed");
    expect(installDevice({ userAgent: UA.iphoneSafari, iosStandalone: false, displayStandalone: false })).toBe("ios");
  });
});

describe("what the install hint shows", () => {
  const view = (device: InstallDevice | "unknown", o: { offered?: boolean; dismissed?: boolean; permanent?: boolean } = {}) =>
    installHintView({ device, offered: o.offered ?? false, dismissed: o.dismissed ?? false, permanent: o.permanent ?? false });

  it("nothing on the server, and nothing once the portal is installed", () => {
    for (const permanent of [true, false]) {
      expect(view("unknown", { permanent, offered: true })).toBe("none");
      expect(view("installed", { permanent, offered: true })).toBe("none");
    }
  });
  it("an Install button when the browser has offered a prompt", () => {
    expect(view("other", { offered: true })).toBe("install");
    expect(view("other", { offered: true, permanent: true })).toBe("install");
  });
  it("the steps on an iPhone or iPad, with Safari first inside another app", () => {
    expect(view("ios")).toBe("ios");
    expect(view("ios-in-app")).toBe("ios-in-app");
    expect(view("ios", { permanent: true })).toBe("ios");
    expect(view("ios", { offered: true })).toBe("ios"); // Apple gives no prompt; a stray event changes nothing
  });
  it("nothing after it was dismissed, on any device", () => {
    expect(view("other", { offered: true, dismissed: true })).toBe("none");
    expect(view("ios", { dismissed: true })).toBe("none");
    expect(view("ios-in-app", { dismissed: true })).toBe("none");
  });
  it("the permanent box on the Display page stays, dismissed elsewhere or not", () => {
    expect(view("other", { offered: true, dismissed: true, permanent: true })).toBe("install");
    expect(view("ios", { dismissed: true, permanent: true })).toBe("ios");
    expect(view("other", { dismissed: true, permanent: true })).toBe("menu");
  });
  it("with no prompt and no steps to give: the browser's menu in the permanent box, silence elsewhere", () => {
    expect(view("other", { permanent: true })).toBe("menu");
    expect(view("other")).toBe("none");
  });
});

describe("Chromium's install offer is caught once and kept", () => {
  type Offer = typeof import("@/app/components/pwa/install-offer");
  let offer: Offer;
  let target: EventTarget;
  const offerEvent = (outcome: "accepted" | "dismissed", prompt = vi.fn(async () => undefined)) =>
    Object.assign(new Event("beforeinstallprompt"), { prompt, userChoice: Promise.resolve({ outcome }) });

  beforeEach(async () => {
    vi.resetModules();
    offer = await import("@/app/components/pwa/install-offer");
    target = new EventTarget();
    offer.watchInstallOffer(target);
  });

  it("has no offer until the browser makes one, and does nothing without a window", () => {
    expect(offer.installOffer()).toBeNull();
    expect(offer.installedThisVisit()).toBe(false);
    expect(() => offer.watchInstallOffer(undefined)).not.toThrow();
  });

  it("keeps the event, tells whoever is listening, and does not cancel the browser's own banner", () => {
    const heard = vi.fn();
    const stop = offer.subscribeInstallOffer(heard);
    const event = offerEvent("accepted");
    target.dispatchEvent(event);
    expect(offer.installOffer()).toBe(event);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    stop();
    target.dispatchEvent(offerEvent("accepted"));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("listens once however many modules ask", () => {
    const heard = vi.fn();
    offer.subscribeInstallOffer(heard);
    offer.watchInstallOffer(target);
    offer.watchInstallOffer(target);
    target.dispatchEvent(offerEvent("accepted"));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("opens the prompt once, reports the choice and drops the used offer", async () => {
    const prompt = vi.fn(async () => undefined);
    target.dispatchEvent(offerEvent("dismissed", prompt));
    const heard = vi.fn();
    offer.subscribeInstallOffer(heard);
    const [first, second] = await Promise.all([offer.openInstallPrompt(), offer.openInstallPrompt()]); // a double tap
    expect([first, second]).toEqual(["dismissed", "unavailable"]);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(offer.installOffer()).toBeNull();
    expect(heard).toHaveBeenCalled();
    expect(await offer.openInstallPrompt()).toBe("unavailable");
  });

  it("a prompt the browser refuses is not an error for the page", async () => {
    target.dispatchEvent(offerEvent("accepted", vi.fn(async () => { throw new Error("NotAllowedError"); })));
    expect(await offer.openInstallPrompt()).toBe("unavailable");
    expect(offer.installOffer()).toBeNull();
  });

  it("knows the portal was installed during this visit", () => {
    target.dispatchEvent(offerEvent("accepted"));
    target.dispatchEvent(new Event("appinstalled"));
    expect(offer.installedThisVisit()).toBe(true);
    expect(offer.installOffer()).toBeNull();
  });
});

describe("which words the passkey offer uses (slice SI-8)", () => {
  const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
  it.each([
    ["Safari on an iPhone", UA.iphoneSafari], ["Chrome on an iPhone", UA.iphoneChrome], ["an iPhone app's own browser", UA.iphoneWebView],
    ["Safari on an iPad", UA.ipadSafari], ["Chrome on an Android phone", UA.androidChrome], ["Firefox on an Android phone", UA.androidFirefox],
  ])("%s: a phone's", (_what, userAgent) => {
    expect(offerDevice({ userAgent, maxTouchPoints: 5 })).toBe("phone");
  });

  it("an iPad that says it is a Mac is a phone's; a Mac is a computer's", () => {
    expect(offerDevice({ userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 5 })).toBe("phone");
    expect(offerDevice({ userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 0 })).toBe("computer");
    expect(offerDevice({ userAgent: UA.macSafari, platform: "MacIntel" })).toBe("computer");
  });

  it("Windows, and an Android tablet (no Mobile), are a computer's", () => {
    expect(offerDevice({ userAgent: UA.windowsEdge, platform: "Win32", maxTouchPoints: 0 })).toBe("computer");
    expect(offerDevice({ userAgent: ANDROID_TABLET, platform: "Linux armv81", maxTouchPoints: 5 })).toBe("computer");
  });

  it("installed or not, the same words", () => {
    expect(offerDevice({ userAgent: UA.iphoneSafari, iosStandalone: true })).toBe("phone");
    expect(offerDevice({ userAgent: UA.androidChrome, displayStandalone: true })).toBe("phone");
    expect(offerDevice({ userAgent: UA.windowsEdge, displayStandalone: true })).toBe("computer");
  });
});
