import { describe, expect, it } from "vitest";
import { mergeFirstPage } from "@/lib/feed";

const it_ = (id: string, sec: number) => ({ id, at: `2026-11-14T10:00:${String(sec).padStart(2, "0")}.000Z` });

describe("mergeFirstPage", () => {
  const prev = [it_("e", 50), it_("d", 40), it_("c", 30), it_("b", 20), it_("a", 10)];
  it("first load takes the page", () => {
    expect(mergeFirstPage([], [it_("x", 1)], false)).toEqual({ items: [it_("x", 1)], added: 0, reset: true });
  });
  it("prepends new items and counts them", () => {
    const page = [it_("g", 70), it_("f", 60), it_("e", 50)];
    const r = mergeFirstPage(prev, page, true);
    expect(r.items.map((i) => i.id)).toEqual(["g", "f", "e", "d", "c", "b", "a"]);
    expect(r.added).toBe(2);
    expect(r.reset).toBe(false);
  });
  it("drops items hidden inside the first page, keeps older paged-in ones", () => {
    const page = [it_("e", 50), it_("c", 30)]; // d was hidden
    const r = mergeFirstPage(prev, page, true);
    expect(r.items.map((i) => i.id)).toEqual(["e", "c", "b", "a"]);
    expect(r.added).toBe(0);
  });
  it("resets when a full page is entirely new (possible gap)", () => {
    const page = [it_("z", 99), it_("y", 98)];
    expect(mergeFirstPage(prev, page, true)).toMatchObject({ reset: true, added: 2, items: page });
  });
  it("a short page that is entirely new is still merged (no gap possible)", () => {
    const r = mergeFirstPage([it_("a", 10)], [it_("b", 20), it_("a", 10)], false);
    expect(r.items.map((i) => i.id)).toEqual(["b", "a"]);
  });
});
