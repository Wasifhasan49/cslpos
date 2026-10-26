import { describe, expect, it } from "vitest";
import { takaInWords } from "./cheque";

// The same numbers as the taka_in_words() checks in
// supabase/tests/sales_rules_test.sql, so the screen and the database cannot drift.
describe("takaInWords", () => {
  it("writes a plain thousand", () => {
    expect(takaInWords(6000)).toBe("Six Thousand Taka Only");
  });

  it("uses lakh, not a hundred thousand", () => {
    expect(takaInWords(125000)).toBe("One Lakh Twenty Five Thousand Taka Only");
  });

  it("goes crore, lakh, thousand, and then the paisa", () => {
    expect(takaInWords(10550075.5)).toBe(
      "One Crore Five Lakh Fifty Thousand Seventy Five Taka and Fifty Paisa Only");
  });

  it("writes the teens as teens", () => {
    expect(takaInWords(1500)).toBe("One Thousand Five Hundred Taka Only");
    expect(takaInWords(19)).toBe("Nineteen Taka Only");
  });

  it("says zero rather than nothing at all", () => {
    expect(takaInWords(0)).toBe("Zero Taka Only");
  });
});
