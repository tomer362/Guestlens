/**
 * Decide the fewest-taps install path for this device.
 *
 * - "prompt"     Chromium (Android Chrome/Samsung/Edge, desktop Chrome/Edge): beforeinstallprompt → 1 tap
 * - "ios-safari" iOS Safari: Share → Add to Home Screen → Add (no API exists)
 * - "ios-other"  Chrome/Firefox/Edge on iOS 16.4+: same flow, Share button is in the address bar
 * - "in-app"     WhatsApp/Instagram/Facebook/Telegram/TikTok/LinkedIn webviews: can't install, must escape
 * - "standalone" already running as an installed app
 * - "manual"     anything else (Firefox Android, desktop Safari…): generic menu hint
 */
export type InstallPath = "prompt" | "ios-safari" | "ios-other" | "in-app" | "standalone" | "manual";

export interface PlatformInfo {
  path: InstallPath;
  os: "ios" | "android" | "desktop";
  isIpad: boolean;
  inAppName?: string;
}

const IN_APP: [RegExp, string][] = [
  [/WhatsApp/i, "WhatsApp"],
  [/Instagram/i, "Instagram"],
  [/FBAN|FBAV|FB_IAB|FBIOS/i, "Facebook"],
  [/Messenger/i, "Messenger"],
  [/Telegram/i, "Telegram"],
  [/musical_ly|TikTok|BytedanceWebview/i, "TikTok"],
  [/LinkedInApp/i, "LinkedIn"],
  [/Snapchat/i, "Snapchat"],
  [/Line\//i, "LINE"],
  [/GSA\//i, "Google"],
];

export function detectPlatform(opts: {
  ua: string;
  standalone: boolean;
  /** navigator.maxTouchPoints, used to spot iPadOS which reports a Mac UA */
  maxTouchPoints?: number;
  hasPromptEvent?: boolean;
}): PlatformInfo {
  const { ua, standalone, maxTouchPoints = 0, hasPromptEvent = false } = opts;
  const isIpad = /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  const isIos = /iPhone|iPod/.test(ua) || isIpad;
  const isAndroid = /Android/i.test(ua);
  const os = isIos ? "ios" : isAndroid ? "android" : "desktop";

  if (standalone) return { path: "standalone", os, isIpad };

  const inApp = IN_APP.find(([re]) => re.test(ua));
  // Android webviews also mark themselves with "; wv)"
  if (inApp || (isAndroid && /; wv\)/.test(ua))) {
    return { path: "in-app", os, isIpad, inAppName: inApp?.[1] ?? "app" };
  }

  if (isIos) {
    const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|DuckDuckGo/i.test(ua);
    return { path: otherBrowser ? "ios-other" : "ios-safari", os, isIpad };
  }

  if (hasPromptEvent) return { path: "prompt", os, isIpad };
  // Chromium fires beforeinstallprompt a moment after load; treat Chromium as "prompt"
  // optimistically, and the UI falls back to the manual hint if the event never arrives.
  if (/Chrome|Chromium|EdgA|Edg\/|SamsungBrowser/i.test(ua) && !/Firefox/i.test(ua)) {
    return { path: "prompt", os, isIpad };
  }
  return { path: "manual", os, isIpad };
}

/** intent:// URL that re-opens the current page in Chrome from an Android webview. */
export function androidChromeIntent(href: string): string {
  const u = new URL(href);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(":", "")};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`;
}
