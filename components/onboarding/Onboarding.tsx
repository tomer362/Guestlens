"use client";
import { useState } from "react";
import { AnimatePresence, m, type PanInfo } from "motion/react";
import { Camera, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { LangToggle } from "@/components/LangToggle";
import { savedName, updateName } from "@/client/session";
import { GalleryArt, ShootArt, UploadArt, WelcomeArt } from "./Illustrations";
import { InstallGuide } from "./InstallGuide";

export const ONBOARDED_KEY = "gl_onboarded_v1";

export function hasOnboarded(): boolean {
  try { return localStorage.getItem(ONBOARDED_KEY) === "1"; } catch { return false; }
}
function markOnboarded() {
  try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch {}
}

type StepId = "welcome" | "shoot" | "upload" | "gallery" | "install";

export function Onboarding({ eventName, onDone, skipInstall }: { eventName: string; onDone: (openCamera: boolean) => void; skipInstall?: boolean }) {
  const { t, f, lang } = useI18n();
  const steps: StepId[] = ["welcome", "shoot", "upload", "gallery", ...(skipInstall ? [] : ["install" as const])];
  const [[i, delta], setPage] = useState<[number, number]>([0, 0]);
  const [name, setName] = useState(savedName);
  const rtl = lang === "he";
  const side = rtl ? -1 : 1; // which screen edge "next" comes from

  const finish = (openCamera: boolean) => {
    if (name.trim() !== savedName()) updateName(name.trim());
    markOnboarded();
    onDone(openCamera);
  };
  const go = (d: number) => {
    const n = i + d;
    if (n < 0) return;
    if (n >= steps.length) return finish(true);
    if (steps[i] === "welcome" && name.trim() !== savedName()) updateName(name.trim());
    setPage([n, d]);
  };
  const onDragEnd = (_: unknown, info: PanInfo) => {
    const dx = info.offset.x * side;
    if (dx < -60 || info.velocity.x * side < -400) go(1);
    else if (dx > 60 || info.velocity.x * side > 400) go(-1);
  };

  const id = steps[i];
  const last = i === steps.length - 1;
  const content: Record<StepId, { art: React.ReactNode; title: string; body: string; tip?: string }> = {
    welcome: { art: <WelcomeArt />, title: f(t.onboarding.welcomeTitle, { event: eventName }), body: t.onboarding.welcomeBody },
    shoot: { art: <ShootArt />, title: t.onboarding.shootTitle, body: t.onboarding.shootBody, tip: t.onboarding.shootTip },
    upload: { art: <UploadArt />, title: t.onboarding.uploadTitle, body: t.onboarding.uploadBody, tip: t.onboarding.uploadTip },
    gallery: { art: <GalleryArt />, title: t.onboarding.galleryTitle, body: t.onboarding.galleryBody },
    install: { art: <InstallGuide appName={eventName} />, title: t.onboarding.installTitle, body: t.onboarding.installBody },
  };
  const c = content[id];
  const Prev = rtl ? ChevronRight : ChevronLeft;
  const Next = rtl ? ChevronLeft : ChevronRight;

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-gradient-to-b from-cream via-cream to-blush" role="dialog" aria-modal="true" aria-label={t.common.howItWorks}>
      <header className="safe-top flex items-center justify-between px-4">
        <LangToggle />
        {!last && (
          <button type="button" onClick={() => finish(false)} className="rounded-full px-3 py-1.5 text-sm font-medium text-muted">
            {t.common.skip}
          </button>
        )}
      </header>

      <AnimatePresence mode="popLayout" initial={false} custom={delta}>
        <m.section
          key={id}
          custom={delta}
          variants={{
            enter: (d: number) => ({ x: `${d * side * 100}%`, opacity: 0 }),
            center: { x: 0, opacity: 1 },
            exit: (d: number) => ({ x: `${-d * side * 100}%`, opacity: 0 }),
          }}
          initial="enter" animate="center" exit="exit"
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
          drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.25} onDragEnd={onDragEnd}
          className="flex min-h-0 flex-1 touch-pan-y flex-col items-center overflow-y-auto px-6 pb-4 text-center"
        >
          {id !== "install" && <div className="w-full max-w-sm origin-top [@media(max-height:720px)]:-mb-14 [@media(max-height:720px)]:scale-[0.78]">{c.art}</div>}
          <m.h1 className={`${id === "install" ? "mt-4" : "mt-2"} font-display text-[1.9rem] leading-tight text-ink [@media(max-height:720px)]:text-2xl`}
            initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.12 }}>
            {c.title}
          </m.h1>
          <m.p className="mt-3 max-w-sm text-base leading-relaxed text-muted"
            initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.22 }}>
            {c.body}
          </m.p>
          {id === "install" && <div className="mt-4 w-full max-w-sm">{c.art}</div>}
          {c.tip && (
            <m.span className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-sm font-medium text-rose-deep shadow-sm"
              initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.4, type: "spring" }}>
              <Sparkles className="size-4" aria-hidden />{c.tip}
            </m.span>
          )}
          {id === "welcome" && (
            <m.label className="mt-6 block w-full max-w-sm text-start"
              initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.35 }}>
              <span className="mb-1.5 block text-sm font-medium">{t.onboarding.nameLabel}</span>
              <input
                value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
                placeholder={t.onboarding.namePlaceholder} autoComplete="name" enterKeyHint="next"
                onKeyDown={(e) => e.key === "Enter" && go(1)}
                className="w-full rounded-2xl border-0 bg-white px-4 py-3.5 text-base shadow-sm ring-1 ring-black/10 outline-none focus:ring-2 focus:ring-rose"
              />
              <span className="mt-1.5 block text-xs text-muted">{t.onboarding.nameHint}</span>
            </m.label>
          )}
        </m.section>
      </AnimatePresence>

      <footer className="safe-bottom px-6">
        <div className="mb-4 flex justify-center gap-2" aria-hidden>
          {steps.map((s, k) => (
            <m.span key={s} className="h-2 rounded-full bg-rose" animate={{ width: k === i ? 24 : 8, opacity: k === i ? 1 : 0.3 }} />
          ))}
        </div>
        <div className="flex items-center gap-3">
          {i > 0 && (
            <button type="button" onClick={() => go(-1)} aria-label={t.common.back}
              className="grid size-14 shrink-0 place-items-center rounded-full bg-white text-ink shadow-sm ring-1 ring-black/5">
              <Prev className="size-6" aria-hidden />
            </button>
          )}
          <m.button type="button" onClick={() => go(1)} whileTap={{ scale: 0.97 }} layout
            className="flex h-14 flex-1 items-center justify-center gap-2 rounded-full bg-rose-deep text-lg font-bold text-white shadow-lg shadow-rose/30">
            {last ? (<><Camera className="size-5" aria-hidden />{t.onboarding.start}</>) : (<>{t.common.next}<Next className="size-5" aria-hidden /></>)}
          </m.button>
        </div>
      </footer>
    </div>
  );
}
