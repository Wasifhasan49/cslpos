import { describe, expect, it } from "vitest";
import { CODE128_PATTERNS, code128Modules, code128Svg, numberInWords, takaInWords } from "./invoice";

describe("the amount in words", () => {
  it("writes what the store's own bill writes", () => {
    expect(takaInWords(1600)).toBe("One Thousand Six Hundred");
  });

  it("counts in lakh and crore, not in millions", () => {
    // A bill that says "One Million" to a shopkeeper in Agargaon is written for
    // somebody else.
    expect(numberInWords(125000)).toBe("One Lakh Twenty Five Thousand");
    expect(numberInWords(10000000)).toBe("One Crore");
    expect(numberInWords(12345678)).toBe(
      "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight");
  });

  it("handles the awkward small numbers", () => {
    expect(numberInWords(0)).toBe("Zero");
    expect(numberInWords(11)).toBe("Eleven");
    expect(numberInWords(19)).toBe("Nineteen");
    expect(numberInWords(20)).toBe("Twenty");
    expect(numberInWords(100)).toBe("One Hundred");
    expect(numberInWords(101)).toBe("One Hundred One");
  });

  it("says the paisa separately when there are any", () => {
    expect(takaInWords(1600.5)).toBe("One Thousand Six Hundred and Fifty Paisa");
    expect(takaInWords(0)).toBe("Zero");
  });

  it("says a refund is a refund rather than printing a bare minus", () => {
    expect(takaInWords(-450)).toBe("Minus Four Hundred Fifty");
  });
});

describe("the invoice barcode", () => {
  // A mistyped digit in the pattern table would print a barcode that looks perfect and
  // scans as something else, which is worse than one that does not scan at all.
  it("has one pattern per symbol value, and they are all eleven modules wide", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    for (const p of CODE128_PATTERNS.slice(0, 106)) {
      expect(p).toHaveLength(6);
      expect([...p].reduce((n, d) => n + Number(d), 0)).toBe(11);
    }
    // The stop pattern is the one with a seventh bar.
    expect(CODE128_PATTERNS[106]).toBe("2331112");
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  it("starts in set B and stops where it should", () => {
    const m = code128Modules("A");
    expect(m.slice(0, 6).join("")).toBe("211214");      // Start B
    expect(m.slice(-7).join("")).toBe("2331112");       // Stop
  });

  it("works out the check character the way a scanner will", () => {
    // Start B (104) + 'C'(35)×1 + 'S'(51)×2 + 'L'(44)×3 = 104 + 35 + 102 + 132 = 373,
    // and 373 mod 103 is 64.
    const m = code128Modules("CSL");
    const check = m.slice(6 + 3 * 6, 6 + 3 * 6 + 6).join("");
    expect(check).toBe(CODE128_PATTERNS[64]);
  });

  it("encodes a whole invoice number without complaint", () => {
    const m = code128Modules("CSLINV2026001909");
    // Start + 16 characters + check + stop.
    expect(m).toHaveLength(6 + 16 * 6 + 6 + 7);
  });

  it("refuses what set B cannot carry, instead of printing a lie", () => {
    expect(code128Modules("নম্বর")).toEqual([]);
    expect(code128Modules("")).toEqual([]);
  });

  it("turns the modules into bars that start at the left edge", () => {
    const { rects, width } = code128Svg("CSL", { module: 2 });
    expect(rects[0].x).toBe(0);
    expect(rects[0].width).toBe(4);   // the start pattern's first bar is 2 modules
    expect(width).toBeGreaterThan(0);
    // Bars never overlap and never run past the stated width.
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i].x).toBeGreaterThanOrEqual(rects[i - 1].x + rects[i - 1].width);
    }
    expect(rects[rects.length - 1].x + rects[rects.length - 1].width).toBeLessThanOrEqual(width);
  });
});
