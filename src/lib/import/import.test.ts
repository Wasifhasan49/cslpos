import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanCode, cleanPhone, isSoldStatus, parseMoney, parseQty, parseWarrantyMonths,
  suggestCleanups,
} from "./clean";
import { findHeaderRow, guessMapping, readSheet, type Grid } from "./parse";
import { importableRows, reviewRows } from "./review";

/** The committed sample exports, read as a grid the way the browser would. */
function sampleGrid(name: string): Grid {
  const file = path.join(process.cwd(), "bms-export", "samples", `bms-${name}.csv`);
  const text = fs.readFileSync(file, "utf8");
  // The samples are plain CSV with quoting only where needed, so a small split is
  // enough here; the app itself uses exceljs so it never has to parse CSV by hand.
  return text.replace(/\r\n/g, "\n").split("\n").filter((l, i, a) => l !== "" || i < a.length - 1)
    .map((line) => {
      const cells: string[] = [];
      let cur = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') quoted = false;
          else cur += c;
        } else if (c === '"') quoted = true;
        else if (c === ",") { cells.push(cur); cur = ""; }
        else cur += c;
      }
      cells.push(cur);
      return cells;
    });
}

describe("reading numbers and words out of a real export", () => {
  it("reads money with commas, currency marks and brackets", () => {
    expect(parseMoney("2,900")).toBe(2900);
    expect(parseMoney("৳ 1,200.50")).toBe(1200.5);
    expect(parseMoney("72,000")).toBe(72000);
    expect(parseMoney("(1,000)")).toBe(-1000); // accounting exports do this
    expect(parseMoney("0")).toBe(0);
  });

  it("tells an unreadable price apart from a price of zero", () => {
    // A price of 0 is a real price. "We couldn't read it" is not, and importing it as
    // 0 would hand the shop a shelf of free products.
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("-")).toBeNull();
    expect(parseMoney("n/a")).toBeNull();
    expect(parseMoney("0")).toBe(0);
  });

  it("reads BMS warranty wording", () => {
    expect(parseWarrantyMonths("1 Year")).toBe(12);
    expect(parseWarrantyMonths("3 Year")).toBe(36);
    expect(parseWarrantyMonths("6 Month")).toBe(6);
    expect(parseWarrantyMonths("36")).toBe(36);
    expect(parseWarrantyMonths("2 Years")).toBe(24);
  });

  it("treats no warranty as no warranty, not as a parse failure", () => {
    for (const v of ["", "-", "N/A", "na", "nil", "No"]) {
      expect(parseWarrantyMonths(v)).toBe(0);
    }
  });

  it("normalises codes, because everything is matched on them", () => {
    expect(cleanCode(" VEN-TC-35 ")).toBe("VEN-TC-35");
    expect(cleanCode("ven-tc-35")).toBe("VEN-TC-35");
    expect(cleanCode("VEN  TC  35")).toBe("VEN TC 35");
  });

  it("accepts the ways a Bangladeshi mobile gets written", () => {
    expect(cleanPhone("01811000000")).toBe("01811000000");
    expect(cleanPhone("+8801811000000")).toBe("01811000000");
    expect(cleanPhone("01811-000000")).toBe("01811000000");
    expect(cleanPhone("1811000000")).toBe("01811000000");
  });

  it("refuses BMS's placeholder mobile number", () => {
    // Every walk-in in CSL's BMS has "2026-01-01" as their mobile.
    expect(cleanPhone("2026-01-01")).toBeNull();
    expect(cleanPhone("")).toBeNull();
    expect(cleanPhone("0123")).toBeNull();
  });

  it("knows which serials are already gone", () => {
    expect(isSoldStatus("Sold")).toBe(true);
    expect(isSoldStatus("Delivered")).toBe(true);
    expect(isSoldStatus("In Stock")).toBe(false);
  });

  it("reads quantities as whole units", () => {
    expect(parseQty("15")).toBe(15);
    expect(parseQty("1,200")).toBe(1200);
    expect(parseQty("3.9")).toBe(3);
    expect(parseQty("")).toBeNull();
  });
});

describe("finding the header row in a BMS export", () => {
  it("skips the report title and the print date", () => {
    const grid = sampleGrid("products");
    // Row 0 is the shop name, row 1 the date, row 2 blank, row 3 the headers.
    expect(findHeaderRow(grid)).toBe(3);
  });

  it("reads the headers and drops the blank rows", () => {
    const sheet = readSheet(sampleGrid("products"));
    expect(sheet.headers).toContain("Model No/Caption");
    expect(sheet.headers).toContain("Product Group");
    expect(sheet.blankRows).toBeGreaterThan(0);
    // 13 data rows in the sample, with the blank ones removed.
    expect(sheet.rows).toHaveLength(13);
    expect(sheet.rows[0]["Product Code"]).toBe("VEN-AUD-35");
  });

  it("copes with a file that is only a header and one row", () => {
    const sheet = readSheet([["Product Code", "Model No/Caption"], ["A-1", "A thing"]]);
    expect(sheet.headerRow).toBe(0);
    expect(sheet.rows).toEqual([{ "Product Code": "A-1", "Model No/Caption": "A thing" }]);
  });

  it("says so rather than guessing when there is no header at all", () => {
    expect(findHeaderRow([[""], [""]])).toBe(-1);
    expect(readSheet([[""], [""]]).rows).toEqual([]);
  });
});

describe("guessing which column is which", () => {
  it("finds BMS's own column names", () => {
    const sheet = readSheet(sampleGrid("products"));
    const m = guessMapping(sheet.headers, "products");
    // "Model No/Caption" is the product name, which is nobody's first guess.
    expect(m.name).toBe("Model No/Caption");
    expect(m.category).toBe("Product Group");
    expect(m.code).toBe("Product Code");
    expect(m.brand).toBe("Brand Name");
    expect(m.price).toBe("Sales Price");
    expect(m.warranty).toBe("Warranty");
  });

  it("never gives two fields the same column", () => {
    // Mapping both price and MRP to "Sales Price" would silently mis-price a catalogue.
    const m = guessMapping(["Product Code", "Caption", "Sales Price"], "products");
    const used = Object.values(m).filter((v) => v !== "");
    expect(new Set(used).size).toBe(used.length);
  });

  it("matches a decorated header", () => {
    const m = guessMapping(["Item Code", "Product Name", "Sales Price (BDT)"], "products");
    expect(m.code).toBe("Item Code");
    expect(m.name).toBe("Product Name");
    expect(m.price).toBe("Sales Price (BDT)");
  });

  it("leaves a column it cannot place empty rather than guessing", () => {
    const m = guessMapping(["Code", "Thingummy"], "products");
    expect(m.code).toBe("Code");
    expect(m.name).toBe("");
  });

  it("maps the stock, serial, customer and supplier reports too", () => {
    expect(guessMapping(readSheet(sampleGrid("stock")).headers, "stock").qty).toBe("Balance Qty");
    expect(guessMapping(readSheet(sampleGrid("serials")).headers, "serials").serial).toBe("Serial/IMEI No");
    expect(guessMapping(readSheet(sampleGrid("customers")).headers, "customers").due).toBe("Due Amount");
    expect(guessMapping(readSheet(sampleGrid("suppliers")).headers, "suppliers").name).toBe("Supplier Name");
  });
});

describe("suggesting category and brand clean-ups", () => {
  it("catches the misspelling that cost CSL time on camera", () => {
    const fixes = suggestCleanups(["Convarter", "Cable", "Convarter"]);
    expect(fixes.find((f) => f.from === "Convarter")?.to).toBe("Converter");
    expect(fixes.find((f) => f.from === "Convarter")?.count).toBe(2);
  });

  it("catches a near-miss of something the shop already has", () => {
    // "Cabels" is not in the known-misspellings list, so this really is the
    // close-to-an-existing-name path rather than the dictionary one.
    const fixes = suggestCleanups(["Cabels"], ["Cables", "Laptops"]);
    expect(fixes[0]).toMatchObject({ from: "Cabels", to: "Cables" });
    expect(fixes[0].why).toContain("already has");
  });

  it("prefers the known spelling even when the shop has not used it yet", () => {
    const fixes = suggestCleanups(["Accesories"], ["Cables"]);
    expect(fixes[0]).toMatchObject({ from: "Accesories", to: "Accessories" });
  });

  it("picks the more common spelling when a file disagrees with itself", () => {
    const fixes = suggestCleanups(["Converter", "Converter", "Converer"]);
    expect(fixes.find((f) => f.from === "Converer")?.to).toBe("Converter");
  });

  it("leaves names alone when they are already right", () => {
    expect(suggestCleanups(["Cables", "Laptops"], ["Cables", "Laptops"])).toEqual([]);
  });

  it("does not suggest changing a name to itself", () => {
    for (const f of suggestCleanups(["Converter"], ["Converter"])) {
      expect(f.from).not.toBe(f.to);
    }
  });
});

describe("reviewing the products file before anything is written", () => {
  const sheet = readSheet(sampleGrid("products"));
  const mapping = guessMapping(sheet.headers, "products");

  it("calls every readable row an add on a fresh shop", () => {
    const r = reviewRows({ kind: "products", rows: sheet.rows, mapping });
    expect(r.counts.add).toBeGreaterThan(8);
    expect(r.counts.problem).toBe(0);
  });

  it("spots the duplicate code and ignores the second one", () => {
    const r = reviewRows({ kind: "products", rows: sheet.rows, mapping });
    const dup = r.rows.find((x) => x.verdict === "skip");
    expect(dup?.reason).toMatch(/same code is on line \d+/i);
    expect(r.counts.skip).toBe(1);
    // The surviving row is the first one, so a re-export cannot reorder the catalogue.
    expect(importableRows(r).filter((v) => v.code === "LOG-M90")).toHaveLength(1);
  });

  it("trims the code that came with spaces around it", () => {
    const r = reviewRows({ kind: "products", rows: sheet.rows, mapping });
    expect(importableRows(r).some((v) => v.code === "VEN-TC-35")).toBe(true);
  });

  it("reads 2,900 as a number and 1 Year as 12 months", () => {
    const r = reviewRows({ kind: "products", rows: sheet.rows, mapping });
    const ram = importableRows(r).find((v) => v.code === "KVR-8G-32");
    expect(ram?.price).toBe(2900);
    expect(ram?.warranty).toBe(36);
  });

  it("brings in a product with no price as null, not as free", () => {
    const r = reviewRows({ kind: "products", rows: sheet.rows, mapping });
    const hub = importableRows(r).find((v) => v.code === "GEN-USB-HUB");
    expect(hub).toBeDefined();
    expect(hub?.price).toBeNull();
  });

  it("calls a row an update once the shop already has that code", () => {
    const r = reviewRows({
      kind: "products", rows: sheet.rows, mapping,
      existingKeys: new Set(["VEN-AUD-35", "LOG-M90"]),
    });
    expect(r.counts.update).toBe(2);
    expect(r.rows.find((x) => x.values.code === "VEN-AUD-35")?.verdict).toBe("update");
  });

  it("applies the accepted clean-ups", () => {
    const r = reviewRows({
      kind: "products", rows: sheet.rows, mapping,
      renames: { Convarter: "Converter", Accesories: "Accessories", Logitach: "Logitech" },
    });
    const cats = importableRows(r).map((v) => v.category);
    expect(cats).toContain("Converter");
    expect(cats).not.toContain("Convarter");
    expect(importableRows(r).map((v) => v.brand)).not.toContain("Logitach");
  });

  it("explains a problem in words a shopkeeper can act on", () => {
    const r = reviewRows({
      kind: "products",
      rows: [{ "Product Code": "X-1", "Model No/Caption": "", "Sales Price": "abc" }],
      mapping,
    });
    expect(r.rows[0].verdict).toBe("problem");
    expect(r.rows[0].reason).toMatch(/product name is empty/i);
    expect(r.rows[0].reason).toMatch(/isn't a selling price/i);
  });
});

describe("reviewing stock and serials", () => {
  it("flags stock for a product the catalogue has never heard of", () => {
    const sheet = readSheet(sampleGrid("stock"));
    const mapping = guessMapping(sheet.headers, "stock");
    const known = new Set(["VEN-AUD-35", "VEN-HDMI-15", "VEN-TC-35", "LOG-M90", "LOG-K120",
                            "CPAD-5F", "KVR-8G-32", "SAM-980-500", "TPL-C6", "ASU-X1504", "HP-680-BK"]);
    const r = reviewRows({ kind: "stock", rows: sheet.rows, mapping, knownProductCodes: known });
    const bad = r.rows.find((x) => x.verdict === "problem");
    expect(bad?.values.code).toBe("MYSTERY-1");
    expect(bad?.reason).toContain("Import the products first");
  });

  it("brings a zero-stock line in as a real zero", () => {
    const sheet = readSheet(sampleGrid("stock"));
    const mapping = guessMapping(sheet.headers, "stock");
    const r = reviewRows({ kind: "stock", rows: sheet.rows, mapping });
    expect(importableRows(r).find((v) => v.code === "HP-680-BK")?.qty).toBe(0);
  });

  it("skips a serial that was already sold, and says why", () => {
    const sheet = readSheet(sampleGrid("serials"));
    const mapping = guessMapping(sheet.headers, "serials");
    const r = reviewRows({ kind: "serials", rows: sheet.rows, mapping });
    const sold = r.rows.find((x) => x.values.serial === "R9N0CV12A111");
    expect(sold?.verdict).toBe("skip");
    expect(sold?.reason).toMatch(/already sold/i);
  });

  it("ignores the serial listed twice", () => {
    const sheet = readSheet(sampleGrid("serials"));
    const mapping = guessMapping(sheet.headers, "serials");
    const r = reviewRows({ kind: "serials", rows: sheet.rows, mapping });
    expect(importableRows(r).filter((v) => v.serial === "KVR8A2410933")).toHaveLength(1);
  });

  it("trims a serial that came with spaces", () => {
    const sheet = readSheet(sampleGrid("serials"));
    const mapping = guessMapping(sheet.headers, "serials");
    const r = reviewRows({ kind: "serials", rows: sheet.rows, mapping });
    expect(importableRows(r).some((v) => v.serial === "S64DNX0T42015")).toBe(true);
  });
});

describe("reviewing customers and suppliers", () => {
  it("skips the walk-ins BMS gave a fake mobile number", () => {
    const sheet = readSheet(sampleGrid("customers"));
    const mapping = guessMapping(sheet.headers, "customers");
    const r = reviewRows({ kind: "customers", rows: sheet.rows, mapping });
    const cash = r.rows.find((x) => x.line === 1);
    expect(cash?.verdict).toBe("problem");
    expect(cash?.reason).toMatch(/isn't a mobile number/i);
  });

  it("reads a due of 12,500 as a number", () => {
    const sheet = readSheet(sampleGrid("customers"));
    const mapping = guessMapping(sheet.headers, "customers");
    const r = reviewRows({ kind: "customers", rows: sheet.rows, mapping });
    expect(importableRows(r).find((v) => v.phone === "01811000000")?.due).toBe(12500);
  });

  it("keeps one row for a customer listed twice", () => {
    const sheet = readSheet(sampleGrid("customers"));
    const mapping = guessMapping(sheet.headers, "customers");
    const r = reviewRows({ kind: "customers", rows: sheet.rows, mapping });
    expect(importableRows(r).filter((v) => v.phone === "01811000000")).toHaveLength(1);
  });

  it("takes a supplier with no phone number, because the name is the key", () => {
    const sheet = readSheet(sampleGrid("suppliers"));
    const mapping = guessMapping(sheet.headers, "suppliers");
    const r = reviewRows({ kind: "suppliers", rows: sheet.rows, mapping });
    const unknown = importableRows(r).find((v) => v.name === "Unknown vendor");
    expect(unknown).toBeDefined();
    expect(unknown?.phone).toBeNull();
    expect(unknown?.due).toBe(1000);
  });
});

describe("re-running the same file", () => {
  it("turns every add into an update and adds nothing new", () => {
    // The prompt's done-when: re-running the real export must change nothing.
    const sheet = readSheet(sampleGrid("products"));
    const mapping = guessMapping(sheet.headers, "products");
    const first = reviewRows({ kind: "products", rows: sheet.rows, mapping });
    const codes = new Set(importableRows(first).map((v) => String(v.code)));

    const second = reviewRows({ kind: "products", rows: sheet.rows, mapping, existingKeys: codes });
    expect(second.counts.add).toBe(0);
    expect(second.counts.update).toBe(first.counts.add);
    expect(importableRows(second)).toHaveLength(importableRows(first).length);
  });
});
