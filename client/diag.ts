"use client";
/**
 * Technical log line → /api/diag (no media, no names). Each line is a serverless invocation, so
 * by default only the lines that explain a problem are sent (errors, fallbacks, one summary per
 * video), at most MAX_PER_SESSION per page; everything goes to the console.
 * Set NEXT_PUBLIC_DIAG=1 to send everything while debugging. Never throws.
 */
const VERBOSE = process.env.NEXT_PUBLIC_DIAG === "1";
const IMPORTANT = /fail|error|lost|timeout|stall|fallback|can't|takeover|uploaded|no-webcodecs|forceOriginal|wasm|paused|old gl-queue|too slow/i;
const MAX_PER_SESSION = 30;
let sent = 0;

export function diag(msg: string) {
  try {
    console.info("[guestlens]", msg);
    if (!VERBOSE && !IMPORTANT.test(msg)) return;
    if (sent >= MAX_PER_SESSION) return;
    sent++;
    fetch("/api/diag", {
      method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({ msg: msg.slice(0, 600) }),
    }).catch(() => {});
  } catch {}
}
