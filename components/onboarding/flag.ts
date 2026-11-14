/** Tiny module so the (large) onboarding UI can be lazy-loaded only when it is shown. */
export const ONBOARDED_KEY = "gl_onboarded_v1";

export function hasOnboarded(): boolean {
  try { return localStorage.getItem(ONBOARDED_KEY) === "1"; } catch { return false; }
}
export function markOnboarded() {
  try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch {}
}
