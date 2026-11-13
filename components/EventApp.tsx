"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, m } from "motion/react";
import { Camera, CircleHelp, Download, Images, X } from "lucide-react";
import { InstallGuide } from "./onboarding/InstallGuide";
import { useI18n } from "@/lib/i18n/client";
import { LangToggle } from "./LangToggle";
import { Onboarding, hasOnboarded } from "./onboarding/Onboarding";
import { UploadScreen, type UploadScreenHandle } from "./upload/UploadScreen";
import { Gallery } from "./gallery/Gallery";
import { ensureJoined } from "@/client/session";
import { startQueue } from "@/client/queue";
import { isStandalone } from "@/lib/pwa/install";

export function EventApp({ slug, eventName, uploadOpen, view }: { slug: string; eventName: string; uploadOpen: boolean; view: "upload" | "gallery" }) {
  const { t } = useI18n();
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const uploadRef = useRef<UploadScreenHandle>(null);

  useEffect(() => {
    setStandalone(isStandalone());
    const forced = new URLSearchParams(location.search).get("help") === "1";
    setOnboarding(forced || !hasOnboarded());
    ensureJoined(slug).then(() => startQueue());
  }, [slug]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col">
      <div inert={!!onboarding || installOpen} className="contents">
      <header className="safe-top sticky top-0 z-30 flex items-center gap-2 bg-cream/85 px-4 pb-2 backdrop-blur">
        <h1 className="min-w-0 flex-1 truncate font-display text-xl">{eventName}</h1>
        {!standalone && (
          <button type="button" onClick={() => setInstallOpen(true)} aria-label={t.install.install}
            className="inline-flex h-9 items-center gap-1 rounded-full bg-rose-deep px-3 text-sm font-semibold text-white shadow-sm">
            <Download className="size-4" aria-hidden /><span className="max-[380px]:hidden">{t.install.install}</span>
          </button>
        )}
        <button type="button" onClick={() => setOnboarding(true)} aria-label={t.common.howItWorks}
          className="grid size-9 place-items-center rounded-full bg-white/80 text-muted shadow-sm ring-1 ring-black/5">
          <CircleHelp className="size-5" aria-hidden />
        </button>
        <LangToggle />
      </header>

      <main className="flex-1 px-4 pb-28">
        {view === "upload"
          ? <UploadScreen ref={uploadRef} slug={slug} uploadOpen={uploadOpen} />
          : <Gallery slug={slug} />}
      </main>

      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-lg justify-around bg-white/90 px-6 pt-2 shadow-[0_-4px_20px_rgba(0,0,0,0.05)] backdrop-blur">
        {([["upload", `/e/${slug}`, Camera, t.common.camera], ["gallery", `/e/${slug}/gallery`, Images, t.common.gallery]] as const).map(([k, href, Icon, label]) => (
          <Link key={k} href={href} className={`relative flex flex-col items-center gap-0.5 px-6 py-1 text-xs font-medium ${view === k ? "text-rose-deep" : "text-muted"}`}>
            <Icon className="size-6" aria-hidden />{label}
            {view === k && <m.span layoutId="navdot" className="absolute -top-2 h-1 w-8 rounded-full bg-rose-deep" />}
          </Link>
        ))}
      </nav>
      </div>

      <AnimatePresence>
        {installOpen && (
          <m.div key="inst" className="fixed inset-0 z-40 flex items-end bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setInstallOpen(false)}>
            <m.div role="dialog" aria-modal="true" aria-label={t.onboarding.installTitle} onClick={(e) => e.stopPropagation()}
              className="safe-bottom mx-auto max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-cream px-6 pt-4"
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "spring", damping: 28, stiffness: 280 }}>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-display text-xl">{t.onboarding.installTitle}</h2>
                <button type="button" onClick={() => setInstallOpen(false)} aria-label={t.common.close} className="grid size-9 place-items-center rounded-full bg-white"><X className="size-5" aria-hidden /></button>
              </div>
              <p className="mb-2 text-sm text-muted">{t.onboarding.installBody}</p>
              <InstallGuide appName={eventName} />
            </m.div>
          </m.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {onboarding && (
          <m.div key="ob" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 1.04 }} transition={{ duration: 0.3 }}>
            <Onboarding eventName={eventName} skipInstall={standalone}
              onDone={(openCamera) => {
                setOnboarding(false);
                // must run synchronously inside the tap, or iOS blocks the file picker
                if (openCamera && view === "upload") uploadRef.current?.openCamera();
              }} />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
