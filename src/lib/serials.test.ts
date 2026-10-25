import { describe, expect, it } from "vitest";
import { checkSerials, expandSerialRange, generateSerials, parseSerialList } from "./serials";

describe("expanding a from–to range", () => {
  it("counts up and keeps the zero padding", () => {
    // SN0098 to SN0102 must not turn into SN102 halfway through.
    expect(expandSerialRange("SN0098", "SN0102").serials)
      .toEqual(["SN0098", "SN0099", "SN0100", "SN0101", "SN0102"]);
  });

  it("handles a range of one", () => {
    expect(expandSerialRange("ABC001", "ABC001").serials).toEqual(["ABC001"]);
  });

  it("trims what was typed", () => {
    expect(expandSerialRange("  SN01 ", " SN03 ").serials).toEqual(["SN01", "SN02", "SN03"]);
  });

  it("refuses two serials that don't share a start", () => {
    // Counting from SNA001 to SNB003 is not a range, it is a guess.
    const r = expandSerialRange("SNA001", "SNB003");
    expect(r.serials).toEqual([]);
    expect(r.problems[0].why).toContain("don't share a start");
  });

  it("refuses a range that runs backwards", () => {
    expect(expandSerialRange("SN010", "SN005").problems[0].why).toContain("lower than the first");
  });

  it("refuses serials with no digits to count", () => {
    expect(expandSerialRange("ABCDEF", "ABCDEG").problems[0].why).toContain("end in digits");
  });

  it("refuses a range big enough to be a mistake", () => {
    // Someone typing SN1 to SN999999 has made a typo, not a delivery.
    const r = expandSerialRange("SN1", "SN100000");
    expect(r.serials).toEqual([]);
    expect(r.problems[0].why).toMatch(/batches of 500/);
  });

  it("asks for both ends", () => {
    expect(expandSerialRange("SN1", "").problems[0].why).toContain("first and a last");
  });
});

describe("pasting or scanning a block of serials", () => {
  it("splits on the things a person or a scanner uses", () => {
    expect(parseSerialList("A1\nA2,A3;A4|A5\tA6")).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
  });

  it("keeps spaces inside a serial, because some have them", () => {
    expect(parseSerialList("AB 123\nCD 456")).toEqual(["AB 123", "CD 456"]);
  });

  it("drops blank lines and stray separators", () => {
    expect(parseSerialList("A1\n\n,A2,\n")).toEqual(["A1", "A2"]);
  });
});

describe("checking serials before anything is saved", () => {
  it("accepts a clean batch", () => {
    const r = checkSerials(["A1", "A2", "A3"]);
    expect(r.serials).toEqual(["A1", "A2", "A3"]);
    expect(r.problems).toEqual([]);
  });

  it("catches the same serial scanned twice in one delivery", () => {
    const r = checkSerials(["A1", "A2", "A1"]);
    expect(r.serials).toEqual(["A1", "A2"]);
    expect(r.problems).toEqual([{ serial: "A1", why: "Already scanned for this delivery." }]);
  });

  it("catches a serial already on another line of the same delivery", () => {
    const r = checkSerials(["A2"], { alreadyHere: ["A1", "A2"] });
    expect(r.serials).toEqual([]);
    expect(r.problems[0].why).toContain("Already scanned");
  });

  it("catches a serial the shop already has", () => {
    const r = checkSerials(["OLD-1", "NEW-1"], { alreadyKnown: new Set(["OLD-1"]) });
    expect(r.serials).toEqual(["NEW-1"]);
    expect(r.problems[0].why).toContain("already has this serial");
  });

  it("catches a mis-scan by length, and says both lengths", () => {
    // A short scan found now is a re-scan; found at a warranty claim it is an argument.
    const r = checkSerials(["S64DNX0T41822", "S64DNX"], { expectedLength: 13 });
    expect(r.serials).toEqual(["S64DNX0T41822"]);
    expect(r.problems[0].why).toContain("13 characters");
    expect(r.problems[0].why).toContain("that one is 6");
  });

  it("catches a serial that doesn't match the product's shape", () => {
    const r = checkSerials(["KVR8A2410933", "nonsense"], { pattern: "^KVR" });
    expect(r.serials).toEqual(["KVR8A2410933"]);
    expect(r.problems).toHaveLength(1);
  });

  it("ignores a broken pattern rather than failing mid-scan", () => {
    // The pattern comes from the shop's own settings, so a bad one must not stop work.
    const r = checkSerials(["ANYTHING"], { pattern: "([unclosed" });
    expect(r.serials).toEqual(["ANYTHING"]);
    expect(r.problems).toEqual([]);
  });

  it("reports every problem, not just the first", () => {
    const r = checkSerials(["A1", "A1", "TOOLONGSERIAL"], { expectedLength: 2 });
    expect(r.problems).toHaveLength(2);
  });
});

describe("making up serials for items that arrived without any", () => {
  it("marks them as the shop's own, with the date and a counter", () => {
    const made = generateSerials("CSL", 3, 1, new Date("2026-10-25T00:00:00Z"));
    expect(made).toEqual(["CSL-261025-0001", "CSL-261025-0002", "CSL-261025-0003"]);
  });

  it("carries on from a number", () => {
    expect(generateSerials("CSL", 2, 98, new Date("2026-10-25T00:00:00Z")))
      .toEqual(["CSL-261025-0098", "CSL-261025-0099"]);
  });

  it("falls back to a usable prefix when given rubbish", () => {
    expect(generateSerials("!!!", 1, 1, new Date("2026-10-25T00:00:00Z"))[0]).toMatch(/^SHOP-/);
  });

  it("makes none when asked for none", () => {
    expect(generateSerials("CSL", 0)).toEqual([]);
  });
});
