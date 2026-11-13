import { describe, expect, it } from "vitest";
import { encodeLqipPixels, lqipToDataUrl, LQIP_RE } from "@/lib/lqip";

describe("lqip", () => {
  it("round-trips a 4x3 grid into a valid 24-bit BMP", () => {
    const rgba = new Uint8ClampedArray(4 * 3 * 4);
    for (let i = 0; i < 12; i++) rgba.set([i * 20, 255 - i * 20, 7, 255], i * 4);
    const p = encodeLqipPixels(rgba, 4, 3);
    expect(p).toMatch(LQIP_RE);
    expect(p.length).toBeLessThan(60);
    const url = lqipToDataUrl(p)!;
    const bmp = Buffer.from(url.split(",")[1], "base64");
    expect(bmp.toString("latin1", 0, 2)).toBe("BM");
    expect(bmp.readInt32LE(18)).toBe(4);
    expect(bmp.readInt32LE(22)).toBe(3);
    // top-left pixel (row 0) is stored in the last row, as BGR
    const rowSize = 12, lastRow = 54 + 2 * rowSize;
    expect([bmp[lastRow + 2], bmp[lastRow + 1], bmp[lastRow]]).toEqual([0, 255, 7]);
  });
  it("rejects malformed input", () => {
    expect(lqipToDataUrl("4x3:abc")).toBeUndefined();
    expect(lqipToDataUrl("data:image/webp;base64,AAAA")).toBeUndefined();
  });
});
