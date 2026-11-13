"use client";
import { useEffect, useState } from "react";
import { detectPlatform, type PlatformInfo } from "./platform";

interface BIPEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
declare global {
  interface Window { __bip?: BIPEvent | null; __installed?: boolean; }
}


export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useInstall() {
  const [info, setInfo] = useState<PlatformInfo | null>(null);
  const [canPrompt, setCanPrompt] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const update = () => {
      setCanPrompt(!!window.__bip);
      setInstalled(!!window.__installed);
      setInfo(detectPlatform({
        ua: navigator.userAgent,
        standalone: isStandalone(),
        maxTouchPoints: navigator.maxTouchPoints,
        hasPromptEvent: !!window.__bip,
      }));
    };
    update();
    addEventListener("gl:bip", update);
    return () => removeEventListener("gl:bip", update);
  }, []);

  async function prompt(): Promise<boolean> {
    const e = window.__bip;
    if (!e) return false;
    await e.prompt();
    const { outcome } = await e.userChoice;
    window.__bip = null;
    setCanPrompt(false);
    if (outcome === "accepted") setInstalled(true);
    return outcome === "accepted";
  }

  return { info, canPrompt, installed, prompt };
}
