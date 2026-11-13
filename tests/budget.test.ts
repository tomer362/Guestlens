import { describe, expect, it, beforeEach } from "vitest";
import { evaluate, monthKey } from "@/lib/budget";
import { getBudget } from "@/lib/config";

describe("budget", () => {
  beforeEach(() => { delete process.env.PLAN; delete process.env.BUDGET_PUTS; delete process.env.BUDGET_STORAGE_BYTES; });

  it("hobby caps stay below Vercel Hobby limits", () => {
    const b = getBudget();
    expect(b.storageBytes).toBeLessThan(1024 ** 3);
    expect(b.puts).toBeLessThan(2000);
  });
  it("pro profile and env overrides raise caps without code changes", () => {
    process.env.PLAN = "pro";
    expect(getBudget().puts).toBeGreaterThan(10_000);
    process.env.BUDGET_PUTS = "123";
    expect(getBudget().puts).toBe(123);
  });
  it("evaluate rejects the item that would cross a cap", () => {
    const b = { storageBytes: 1000, puts: 10 };
    expect(evaluate({ storageBytes: 900, puts: 0 }, { bytes: 100, puts: 2 }, b)).toEqual({ ok: true });
    expect(evaluate({ storageBytes: 901, puts: 0 }, { bytes: 100, puts: 2 }, b)).toEqual({ ok: false, reason: "storage" });
    expect(evaluate({ storageBytes: 0, puts: 9 }, { bytes: 1, puts: 2 }, b)).toEqual({ ok: false, reason: "puts" });
  });
  it("month key is the UTC first of month", () => {
    expect(monthKey(new Date("2026-11-30T23:59:00Z"))).toBe("2026-11-01");
  });
});
