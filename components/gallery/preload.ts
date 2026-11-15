"use client";
/**
 * Full-size image preloader for the viewer: one small, ordered wish list instead of firing every
 * neighbour at once. Venue Wi-Fi is shared by a whole wedding, so the image you are about to see
 * must not compete with images you may never open.
 *
 * - `want(urls)` replaces the wish list, highest priority first; anything not on it is never started
 *   (in-flight requests are left to finish, never aborted: their bytes are already paid for)
 * - one download at a time (MAX_INFLIGHT), so the image ranked first arrives as soon as possible
 * - each image is fetched AND decoded (img.decode()) before it counts as ready, and the element is
 *   kept (small LRU) so the browser keeps the decoded bitmap warm: the swap paints in one frame
 * - `useReady(url)` lets a slide render its full image only once it is ready, so mounted neighbours
 *   never start their own uncontrolled downloads
 */
import { useSyncExternalStore } from "react";

// one at a time: on a shared, bandwidth-bound link two parallel downloads just make the next image arrive later
const MAX_INFLIGHT = 1;
// decoded 2048 px bitmaps are ~16 MB each: keep only a few (iOS kills memory-hungry tabs)
const KEEP = 4;

type State = "loading" | "ready" | "error";
const entries = new Map<string, { state: State; img: HTMLImageElement }>(); // insertion order = LRU
let wishes: string[] = [];
let inflight = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

function evict() {
  if (entries.size <= KEEP) return;
  for (const [url, e] of entries) {
    if (entries.size <= KEEP) break;
    if (e.state !== "loading" && !wishes.includes(url)) entries.delete(url);
  }
}

function pump() {
  for (const url of wishes) {
    if (inflight >= MAX_INFLIGHT) return;
    if (entries.has(url)) continue;
    const img = new Image();
    img.decoding = "async";
    (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = url === wishes[0] ? "high" : "low";
    const e = { state: "loading" as State, img };
    entries.set(url, e);
    inflight++;
    img.src = url;
    // decode() resolves once the bytes are in and decoded (rejects on a broken image)
    img.decode().then(() => { e.state = "ready"; }, () => {
      // some browsers reject decode() for images that loaded fine (e.g. detached + evicted): trust `complete`
      e.state = img.complete && img.naturalWidth ? "ready" : "error";
    }).finally(() => {
      inflight--;
      evict();
      emit();
      pump();
    });
  }
}

/** Replace the wish list (highest priority first). Cheap to call often. */
export function want(urls: (string | undefined | null)[]) {
  const next = urls.filter((u): u is string => !!u);
  if (next.length === wishes.length && next.every((u, i) => u === wishes[i])) return;
  wishes = next;
  // a wished url moves to the "recent" end of the LRU
  for (const u of wishes) { const e = entries.get(u); if (e) { entries.delete(u); entries.set(u, e); } }
  pump();
}

export const isReady = (url: string | undefined) => !!url && entries.get(url)?.state === "ready";

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useReady(url: string | undefined) {
  return useSyncExternalStore(subscribe, () => isReady(url), () => false);
}

/** Data saver on, or a 2G/3G-class link: only the immediate neighbours. */
export function constrained() {
  const c = (typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection : undefined);
  return !!c && (!!c.saveData || /(^|-)(2g|3g)$/.test(c.effectiveType ?? ""));
}
