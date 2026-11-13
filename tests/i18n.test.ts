import { describe, expect, it } from "vitest";
import { dicts, fmt } from "@/lib/i18n";

function keys(o: object, p = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
}
function placeholders(o: object, p = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(o).flatMap(([k, v]) => typeof v === "object"
    ? Object.entries(placeholders(v, `${p}${k}.`)) : [[`${p}${k}`, (String(v).match(/\{\w+\}/g) ?? []).sort().join()]]));
}

describe("i18n", () => {
  it("he and en have the same keys", () => expect(keys(dicts.he).sort()).toEqual(keys(dicts.en).sort()));
  it("he and en use the same placeholders", () => expect(placeholders(dicts.he)).toEqual(placeholders(dicts.en)));
  it("no empty strings", () => {
    for (const l of ["he", "en"] as const) for (const k of keys(dicts[l])) {
      const v = k.split(".").reduce((o: any, x) => o[x], dicts[l]);
      expect(v, `${l}.${k}`).not.toBe("");
    }
  });
  it("fmt fills placeholders", () => expect(fmt("{done} of {total}", { done: 3, total: 12 })).toBe("3 of 12"));
});
