import { describe, expect, it } from "vitest";
import { sheetFor } from "./sheets";

/**
 * A BMS report PDF comes out as more than one sheet, and the one that matters is rarely
 * the first. Opening the stock report on its Products sheet is what made somebody
 * importing opening stock find no Quantity column to map.
 */
describe("which sheet to open on", () => {
  it("opens the stock report on its stock, not on its products", () => {
    expect(sheetFor("stock", ["Products", "Opening stock"])).toBe("Opening stock");
    expect(sheetFor("products", ["Products", "Opening stock"])).toBe("Products");
  });

  it("opens the serial report on its serials", () => {
    const sheets = ["Serial numbers", "Products", "Opening stock"];
    expect(sheetFor("serials", sheets)).toBe("Serial numbers");
    expect(sheetFor("products", sheets)).toBe("Products");
    expect(sheetFor("stock", sheets)).toBe("Opening stock");
  });

  it("splits the due list the way it is asked for", () => {
    expect(sheetFor("customers", ["Customers", "Suppliers"])).toBe("Customers");
    expect(sheetFor("suppliers", ["Customers", "Suppliers"])).toBe("Suppliers");
  });

  it("falls back to the first sheet rather than to nothing", () => {
    expect(sheetFor("prices", ["Sheet1"])).toBe("Sheet1");
    expect(sheetFor("stock", [])).toBe("");
    expect(sheetFor(null, ["Sheet1", "Sheet2"])).toBe("Sheet1");
  });
});
