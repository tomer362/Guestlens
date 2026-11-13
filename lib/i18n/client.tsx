"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { dicts, dirOf, fmt, LANG_COOKIE, type Dict, type Lang } from "./index";

interface Ctx { lang: Lang; t: Dict; setLang: (l: Lang) => void; f: typeof fmt; }
const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ initial, children }: { initial: Lang; children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    try { localStorage.setItem(LANG_COOKIE, l); } catch {}
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    el.lang = lang;
    el.dir = dirOf(lang);
  }, [lang]);

  const value = useMemo(() => ({ lang, t: dicts[lang], setLang, f: fmt }), [lang, setLang]);
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n() {
  const c = useContext(I18nCtx);
  if (!c) throw new Error("useI18n outside I18nProvider");
  return c;
}
