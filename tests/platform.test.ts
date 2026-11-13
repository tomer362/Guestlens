import { describe, expect, it } from "vitest";
import { androidChromeIntent, detectPlatform } from "@/lib/pwa/platform";

const UA = {
  iosSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  androidWhatsapp: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 WhatsApp/2.24",
  iosInstagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.0",
  iosFacebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/490.0]",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
  desktopChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};
const d = (ua: string, extra: Partial<Parameters<typeof detectPlatform>[0]> = {}) => detectPlatform({ ua, standalone: false, ...extra });

describe("detectPlatform", () => {
  it("iOS Safari → share-sheet walkthrough", () => expect(d(UA.iosSafari)).toMatchObject({ path: "ios-safari", os: "ios", isIpad: false }));
  it("iOS Chrome → share-sheet in address bar", () => expect(d(UA.iosChrome).path).toBe("ios-other"));
  it("iPadOS (desktop UA + touch) → ios-safari, ipad", () => expect(d(UA.ipad, { maxTouchPoints: 5 })).toMatchObject({ path: "ios-safari", isIpad: true }));
  it("Mac Safari without touch is not iOS", () => expect(d(UA.ipad).os).toBe("desktop"));
  it("Android Chrome → one-tap prompt", () => expect(d(UA.androidChrome)).toMatchObject({ path: "prompt", os: "android" }));
  it("Samsung Internet → prompt", () => expect(d(UA.samsung).path).toBe("prompt"));
  it("WhatsApp webview → in-app", () => expect(d(UA.androidWhatsapp)).toMatchObject({ path: "in-app", inAppName: "WhatsApp" }));
  it("Instagram iOS → in-app", () => expect(d(UA.iosInstagram)).toMatchObject({ path: "in-app", os: "ios", inAppName: "Instagram" }));
  it("Facebook iOS → in-app", () => expect(d(UA.iosFacebook).inAppName).toBe("Facebook"));
  it("Firefox Android → manual", () => expect(d(UA.androidFirefox).path).toBe("manual"));
  it("desktop Chrome → prompt", () => expect(d(UA.desktopChrome)).toMatchObject({ path: "prompt", os: "desktop" }));
  it("standalone wins over everything", () => expect(detectPlatform({ ua: UA.androidWhatsapp, standalone: true }).path).toBe("standalone"));
  it("builds a Chrome intent URL", () => {
    expect(androidChromeIntent("https://x.app/e/noa?a=1")).toBe(
      "intent://x.app/e/noa?a=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fx.app%2Fe%2Fnoa%3Fa%3D1;end");
  });
});
