"use client";
/** Fire-and-forget technical log line to /api/diag (see that route). Never throws. */
export function diag(msg: string) {
  try {
    console.info("[guestlens]", msg);
    fetch("/api/diag", {
      method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({ msg: msg.slice(0, 600) }),
    }).catch(() => {});
  } catch {}
}
