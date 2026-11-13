import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Heebo, Suez_One } from "next/font/google";
import { I18nProvider } from "@/lib/i18n/client";
import { DEFAULT_LANG, LANG_COOKIE, dirOf, isLang, type Lang } from "@/lib/i18n";
import { EARLY_PWA_SCRIPT } from "@/lib/pwa/early";
import { MotionRoot } from "@/components/MotionRoot";
import "./globals.css";

const heebo = Heebo({ subsets: ["hebrew", "latin"], variable: "--font-heebo", display: "swap" });
const display = Suez_One({ subsets: ["hebrew", "latin"], weight: "400", variable: "--font-display-face", display: "swap" });

export const metadata: Metadata = {
  title: "GuestLens",
  description: "Shared wedding album",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "GuestLens" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#fff8f3",
};

async function resolveLang(): Promise<Lang> {
  const c = (await cookies()).get(LANG_COOKIE)?.value;
  if (isLang(c)) return c;
  // First visit: always Hebrew (the event is Hebrew-first); guests switch with the toggle.
  return DEFAULT_LANG;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await resolveLang();
  return (
    <html lang={lang} dir={dirOf(lang)} className={`${heebo.variable} ${display.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: EARLY_PWA_SCRIPT }} />
      </head>
      <body className="antialiased">
        <I18nProvider initial={lang}>
          <MotionRoot>{children}</MotionRoot>
        </I18nProvider>
      </body>
    </html>
  );
}
