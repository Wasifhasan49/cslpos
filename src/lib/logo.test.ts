import { describe, expect, it } from "vitest";
import { fitWithin, LOGO_MAX_H, LOGO_MAX_W } from "./logo";

describe("fitting a logo on a letterhead", () => {
  it("leaves a small logo alone, rather than blowing it up", () => {
    expect(fitWithin(120, 60)).toEqual({ w: 120, h: 60 });
  });

  it("keeps the shape when it has to shrink", () => {
    // A wide banner is limited by the width; the height follows it.
    expect(fitWithin(2080, 480)).toEqual({ w: LOGO_MAX_W, h: 120 });
    // A tall one is limited by the height instead.
    expect(fitWithin(480, 1200)).toEqual({ w: 96, h: LOGO_MAX_H });
  });

  it("never comes out as zero pixels, however thin the strip", () => {
    const got = fitWithin(4000, 1);
    expect(got.w).toBe(LOGO_MAX_W);
    expect(got.h).toBe(1);
  });

  it("says nothing of an empty image, instead of dividing by zero", () => {
    expect(fitWithin(0, 0)).toEqual({ w: 0, h: 0 });
  });
});
