"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { Check, Globe, Copy, Download, ExternalLink, Share, SquarePlus } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useInstall } from "@/lib/pwa/install";
import { androidChromeIntent } from "@/lib/pwa/platform";
import { Phone } from "./Illustrations";

const tapRing = (
  <m.span className="pointer-events-none absolute inset-0 rounded-full ring-4 ring-rose"
    animate={{ scale: [0.8, 1.5], opacity: [1, 0] }} transition={{ repeat: Infinity, duration: 1.1 }} />
);

/** Animated iPhone/iPad mock that walks through Share → Add to Home Screen → Add. */
function IosDemo({ step, ipad, appName }: { step: number; ipad: boolean; appName: string }) {
  const { t } = useI18n();
  const bar = (
    <div className={`absolute inset-x-0 ${ipad ? "top-0 pt-6" : "bottom-0"} z-10 flex h-12 items-center justify-around bg-white/95 text-sky-600 ring-1 ring-black/5`}>
      <span className="text-[10px] text-black/40">‹ ›</span>
      <span className="relative grid size-7 place-items-center">
        <Share className="size-4" aria-hidden />
        {step === 0 && tapRing}
      </span>
      <span className="text-[10px] text-black/40">▢</span>
    </div>
  );
  return (
    <Phone>
      <div className="absolute inset-0 bg-gradient-to-b from-cream to-blush" />
      <div className="absolute inset-x-3 top-12 space-y-1.5">
        <div className="h-3 w-3/4 rounded bg-rose/30" /><div className="h-3 w-1/2 rounded bg-rose/20" />
        <div className="mt-3 grid grid-cols-3 gap-1">{[...Array(6)].map((_, i) => <div key={i} className="aspect-square rounded bg-white/70" />)}</div>
      </div>
      {bar}
      <AnimatePresence>
        {(step === 1 || step === 2) && (
          <m.div key="sheet" className="absolute inset-x-0 bottom-0 z-20 rounded-t-2xl bg-[#f2f2f7] p-2 pb-3 shadow-2xl"
            initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "spring", damping: 24, stiffness: 260 }}>
            {step === 1 ? (
              <div className="space-y-1 text-[9px] text-ink">
                <div className="rounded-md bg-white px-2 py-1.5 opacity-60">{t.install.mockCopy}</div>
                <div className="relative flex items-center justify-between rounded-md bg-white px-2 py-1.5 font-semibold">
                  <span>{t.install.mockAddHome}</span><SquarePlus className="size-3" aria-hidden />
                  <m.span className="absolute inset-0 rounded-md ring-2 ring-rose" animate={{ opacity: [0.2, 1, 0.2] }} transition={{ repeat: Infinity, duration: 1 }} />
                </div>
                <div className="rounded-md bg-white px-2 py-1.5 opacity-60">{t.install.mockBookmark}</div>
              </div>
            ) : (
              <div className="text-[9px] text-ink">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sky-600">{t.install.mockCancel}</span><span className="font-semibold">{t.install.mockAddHome}</span>
                  <span className="relative px-1 font-bold text-sky-600">{t.install.mockAdd}{tapRing}</span>
                </div>
                <div className="flex items-center gap-2 rounded-md bg-white p-1.5">
                  <img src="/icons/icon-192.png" alt="" className="size-6 rounded-md" />
                  <span className="truncate">{appName}</span>
                </div>
              </div>
            )}
          </m.div>
        )}
        {step === 3 && (
          <m.div key="home" className="absolute inset-0 z-30 grid grid-cols-4 content-start gap-2 bg-gradient-to-br from-[#8d6c9e] to-[#d9798a] p-3 pt-8"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {[...Array(7)].map((_, i) => <div key={i} className="aspect-square rounded-lg bg-white/25" />)}
            <m.img src="/icons/icon-192.png" alt="" className="aspect-square rounded-lg shadow-lg"
              initial={{ scale: 0 }} animate={{ scale: [0, 1.25, 1] }} transition={{ delay: 0.2, duration: 0.5 }} />
          </m.div>
        )}
      </AnimatePresence>
    </Phone>
  );
}

/** Android/Chromium: tap Install → icon lands on the home screen. */
function AndroidDemo({ label }: { label: string }) {
  const T = 3.4;
  const loop = { repeat: Infinity, duration: T } as const;
  return (
    <Phone>
      <div className="absolute inset-0 bg-gradient-to-br from-[#8d6c9e] to-[#d9798a]" />
      <div className="absolute inset-0 grid grid-cols-4 content-start gap-2 p-3 pt-8">
        {[...Array(7)].map((_, i) => <div key={i} className="aspect-square rounded-full bg-white/25" />)}
        <m.img src="/icons/icon-192.png" alt="" className="aspect-square rounded-full shadow-lg"
          animate={{ scale: [0, 0, 1.25, 1, 1], opacity: [0, 0, 1, 1, 1] }} transition={{ ...loop, times: [0, 0.5, 0.6, 0.68, 1] }} />
      </div>
      {/* install dialog */}
      <m.div className="absolute inset-x-2 bottom-3 z-10 rounded-2xl bg-white p-2.5 text-[9px] text-ink shadow-xl"
        animate={{ y: [0, 0, 0, 120, 120], opacity: [1, 1, 1, 0, 0] }} transition={{ ...loop, times: [0, 0.3, 0.42, 0.5, 1] }}>
        <div className="flex items-center gap-2">
          <img src="/icons/icon-192.png" alt="" className="size-6 rounded-md" />
          <span className="flex-1 font-semibold">GuestLens</span>
          <span className="relative rounded-full bg-rose-deep px-2.5 py-1 font-bold text-white">
            {label}
            <m.span className="absolute inset-0 rounded-full ring-4 ring-rose" animate={{ scale: [0.8, 0.8, 1.6, 1.6], opacity: [0, 1, 0, 0] }} transition={{ ...loop, times: [0, 0.25, 0.4, 1] }} />
          </span>
        </div>
      </m.div>
    </Phone>
  );
}

function Steps({ items, active }: { items: string[]; active: number }) {
  return (
    <ol className="mt-4 space-y-2 text-start">
      {items.map((s, i) => (
        <li key={i} className={`flex items-center gap-3 rounded-xl px-3 py-2 transition-colors ${active === i ? "bg-white shadow-sm" : "opacity-60"}`}>
          <span className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${active > i ? "bg-emerald-500 text-white" : active === i ? "bg-rose text-white" : "bg-blush text-ink"}`}>
            {active > i ? <Check className="size-3.5" aria-hidden /> : i + 1}
          </span>
          <span className="text-sm">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function CopyLink() {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="mt-3 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium shadow-sm ring-1 ring-black/5"
      onClick={async () => { try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch {} }}>
      {copied ? <Check className="size-4 text-emerald-600" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? t.common.copied : t.common.copyLink}
    </button>
  );
}

export function InstallGuide({ appName }: { appName: string }) {
  const { t, f } = useI18n();
  const { info, canPrompt, installed, prompt } = useInstall();
  const [step, setStep] = useState(0);
  const [qr, setQr] = useState<string>();

  const iosLike = info?.path === "ios-safari" || info?.path === "ios-other";
  useEffect(() => {
    if (!iosLike) return;
    const id = setInterval(() => setStep((s) => (s + 1) % 4), 1900);
    return () => clearInterval(id);
  }, [iosLike]);

  useEffect(() => {
    if (info?.os !== "desktop") return;
    import("qrcode")
      .then((Q) => Q.toDataURL(location.href, { margin: 1, width: 220, color: { dark: "#2b1e22", light: "#ffffff" } }))
      .then(setQr)
      .catch(() => {});
  }, [info?.os]);

  if (!info) return <div className="h-[260px]" />;

  if (info.path === "standalone" || installed) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <m.div className="grid size-20 place-items-center rounded-full bg-emerald-500 text-white" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring" }}>
          <Check className="size-10" aria-hidden />
        </m.div>
        <p className="font-medium">{installed ? t.install.installed : t.install.already}</p>
      </div>
    );
  }

  if (iosLike) {
    return (
      <div className="flex flex-col items-center">
        <IosDemo step={step} ipad={info.isIpad} appName={appName} />
        <Steps active={Math.min(step, 3)} items={[info.isIpad ? t.install.iosStep1Ipad : t.install.iosStep1, t.install.iosStep2, t.install.iosStep3]} />
        {info.path === "ios-other" && <p className="mt-2 text-xs text-muted">{t.install.iosOtherBrowser}</p>}
      </div>
    );
  }

  if (info.path === "in-app") {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <ExternalLink className="size-12 text-rose-deep" aria-hidden />
        <p className="font-semibold">{f(t.install.inAppTitle, { app: info.inAppName ?? "app" })}</p>
        <p className="text-sm text-muted">{info.os === "android" ? t.install.inAppBodyAndroid : t.install.inAppBodyIos}</p>
        {info.os === "android" && (
          <a href={androidChromeIntent(location.href)} className="mt-2 inline-flex items-center gap-2 rounded-full bg-rose-deep px-5 py-3 font-semibold text-white shadow-lg">
            <Globe className="size-5" aria-hidden />{t.install.openInChrome}
          </a>
        )}
        <CopyLink />
      </div>
    );
  }

  // Chromium: the single real install button
  return (
    <div className="flex flex-col items-center gap-4 py-2 text-center">
      {info.os !== "desktop" && <AndroidDemo label={t.install.install} />}
      {qr && <img src={qr} alt="QR" className="size-40 rounded-xl shadow" />}
      {info.os === "desktop" && <p className="text-sm text-muted">{t.install.desktop}</p>}
      {canPrompt ? (
        <m.button type="button" onClick={prompt} whileTap={{ scale: 0.95 }}
          className="relative inline-flex items-center gap-2 overflow-hidden rounded-full bg-rose-deep px-7 py-4 text-lg font-bold text-white shadow-xl">
          <m.span className="absolute inset-y-0 w-1/3 -skew-x-12 bg-white/25" animate={{ x: ["-150%", "350%"] }} transition={{ repeat: Infinity, duration: 2.2, repeatDelay: 0.8 }} />
          <Download className="size-5" aria-hidden />{t.install.oneTap}
        </m.button>
      ) : (
        info.os !== "desktop" && <p className="max-w-xs text-sm text-muted">{t.install.manual}</p>
      )}
    </div>
  );
}
