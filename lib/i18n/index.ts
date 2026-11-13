import { en, type Dict } from "./en";
import { he } from "./he";

export type Lang = "he" | "en";
export const LANGS: Lang[] = ["he", "en"];
export const DEFAULT_LANG: Lang = "he";
export const LANG_COOKIE = "gl_lang";

export const dicts: Record<Lang, Dict> = { he, en };
export const dirOf = (l: Lang) => (l === "he" ? "rtl" : "ltr");
export const isLang = (v: unknown): v is Lang => v === "he" || v === "en";

/** Replace {placeholders}. */
export function fmt(s: string, vars?: Record<string, string | number>) {
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : s;
}
export type { Dict };
