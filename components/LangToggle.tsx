"use client";
import { Languages } from "lucide-react";
import { m } from "motion/react";
import { useI18n } from "@/lib/i18n/client";

export function LangToggle({ className = "" }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  return (
    <m.button
      type="button"
      whileTap={{ scale: 0.92 }}
      onClick={() => setLang(lang === "he" ? "en" : "he")}
      aria-label={t.switchAria}
      className={`inline-flex items-center gap-1.5 rounded-full bg-white/80 px-3 py-1.5 text-sm font-medium text-ink shadow-sm ring-1 ring-black/5 backdrop-blur ${className}`}
    >
      <m.span key={lang} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} className="inline-flex">
        <Languages className="size-4 text-rose-deep" aria-hidden />
      </m.span>
      <span lang={lang === "he" ? "en" : "he"}>{t.switchTo}</span>
    </m.button>
  );
}
