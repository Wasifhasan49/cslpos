import { describe, expect, it } from "vitest";
import {
  cleanPhone, detectReport, duplicateWarnings, readBmsPdf, readDueList,
  readInformation, readSerials, readStock,
} from "./bms-pdf";
import { linesFrom, money, type PdfPage, type PdfWord } from "./pdf-text";

/**
 * Made-up pages in the real reports' shape.
 *
 * The real exports are the shop's whole customer list, so they are never committed.
 * These fixtures copy what matters — the x positions of each column, the type size of a
 * heading, the way a long name wraps — straight from them, and `pnpm check:pdf` is what
 * runs the parsers over the genuine files.
 */
const w = (text: string, x: number, y: number, size = 7.15): PdfWord => ({ text, x, y, size });
const page = (words: PdfWord[]): PdfPage => ({ lines: linesFrom(words), width: 612, height: 792 });

const LETTERHEAD = (y: number) => [
  w("COMPUTER SERVICES", 103, y, 11),
  w("Shop No: 9 & 10, (Ground Floor), BCS Computer City, IDB Bhaban, Agargaon, Dhaka-1207.", 103, y - 15),
];
const FOOTER = [w("02/11/2026", 396, 22), w("2:11:37PM", 452, 22), w("Page 1 of 1", 519, 22)];

describe("reading a line off a page", () => {
  it("puts words on one line even when their baselines differ by a point", () => {
    const lines = linesFrom([w("PCS", 400, 627.4), w("181.00", 354, 627.6), w("3D STICKER", 41, 627.6)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("3D STICKER 181.00 PCS");
  });

  it("reads down the page, not up it", () => {
    const lines = linesFrom([w("second", 40, 600), w("first", 40, 650)]);
    expect(lines.map((l) => l.text)).toEqual(["first", "second"]);
  });

  it("knows a figure from a word, commas and minus and all", () => {
    expect(money("1,459,863.00")).toBe(1459863);
    expect(money("-9,500.00")).toBe(-9500);
    expect(money("PCS")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const STOCK = [page([
  ...LETTERHEAD(755),
  w("Current Stock(Combined)", 227, 699, 12),
  w("Product Model", 41, 668), w("Qty", 357, 668), w("UoM", 400, 668),
  w("Unit Cost", 443, 668), w("Total Cost", 522, 668),
  w("Adapter", 41, 652, 8.75),
  w("HOCO", 46, 638, 8.75),
  w("Type C to USB Short Cable 100W X96", 41, 627),
  w("10.00", 356, 627), w("PCS", 400, 627), w("100.00", 457, 627), w("1,000.00", 532, 627),
  w("Brand Sub Total :", 254, 613), w("10.00", 353, 613), w("1,000.00", 529, 613),
  w("N/A", 46, 599, 8.75),
  w("Web Camera A4 Tech", 41, 585),
  w("2.00", 356, 585), w("PCS", 400, 585), w("500.00", 457, 585), w("1,000.00", 532, 585),
  w("Brand Sub Total :", 254, 571), w("2.00", 353, 571), w("1,000.00", 529, 571),
  w("Group Sub Total :", 254, 557), w("12.00", 352, 557), w("2,000.00", 528, 557),
  w("Grand Total :", 254, 543), w("12.00", 351, 543), w("2,000.00", 520, 543),
  ...FOOTER,
])];

describe("Current Stock (Combined) with cost", () => {
  it("knows which report it is from the title", () => {
    expect(detectReport(STOCK)).toBe("stock");
  });

  it("carries the group and the brand down onto every product row", () => {
    const { grids } = readStock(STOCK);
    expect(grids.Products.slice(1)).toEqual([
      ["Type C to USB Short Cable 100W X96", "Type C to USB Short Cable 100W X96",
       "Adapter", "HOCO", "PCS", 100],
      // "N/A" is BMS for "no brand", so it is left empty rather than imported as a brand.
      ["Web Camera A4 Tech", "Web Camera A4 Tech", "Adapter", "", "PCS", 500],
    ]);
  });

  it("leaves the subtotals out of the rows but checks itself against the total", () => {
    const read = readStock(STOCK);
    expect(read.grids["Opening stock"]).toHaveLength(3);
    expect(read.totals.qty).toBe(12);
    expect(read.totals.qty).toBe(read.totals.reportQty);
    expect(read.totals.cost).toBe(read.totals.reportCost);
    expect(read.warnings).toEqual([]);
  });

  it("says so when the rows do not add up to what the report printed", () => {
    const short = [page([
      ...LETTERHEAD(755),
      w("Current Stock(Combined)", 227, 699, 12),
      w("Adapter", 41, 652, 8.75), w("HOCO", 46, 638, 8.75),
      w("One thing", 41, 627), w("10.00", 356, 627), w("PCS", 400, 627),
      w("100.00", 457, 627), w("1,000.00", 532, 627),
      w("Grand Total :", 254, 543), w("99.00", 351, 543), w("9,900.00", 520, 543),
    ])];
    expect(readStock(short).warnings[0]).toMatch(/99 units and these rows add up to 10/);
  });
});

// ---------------------------------------------------------------------------

const SERIALS = [page([
  ...LETTERHEAD(757),
  w("Current Stock(Combined) with Serial And Cost", 164, 681, 12),
  w("21.45 M2253B", 276, 554),
  w('RealView 21.45" INCH FHD LED Monitor', 206, 541),
  w("Invoice No", 38, 519), w("Date", 132, 519), w("Supplier Name", 182, 519),
  w("Qty", 301, 519), w("Status", 349, 519), w("Serial", 451, 519), w("Unit Cost", 542, 519),
  w("CSLPUR202300000", 38, 505), w("02/08/2023", 130, 505), w("Opening Stock", 183, 505),
  // The invoice number is too long for its column, so its last digit wraps under it.
  w("3", 38, 493),
  w("1.00", 323, 484), w("Purchase", 342, 484), w("GB225322104401106", 423, 484), w("7,650.00", 552, 484),
  w("Sub Total", 250, 470), w("1.00", 327, 470),
  w("Sub Total:", 244, 450), w("1.00", 365, 450),
  w("22.5W Mini Power Bank", 276, 430),
  w("22.5W Dual Cable Mini Power Bank 10000mAh", 206, 417),
  w("Invoice No", 38, 395), w("Date", 132, 395), w("Supplier Name", 182, 395),
  w("Qty", 301, 395), w("Status", 349, 395), w("Serial", 451, 395), w("Unit Cost", 542, 395),
  w("CSLPUR202600066", 38, 381), w("29/08/2026", 130, 381), w("Raisa & Ramisha Telicom", 183, 381),
  w("5", 38, 369),
  w("2.00", 323, 360), w("Purchase", 342, 360), w("1,470.00", 552, 360),
  w("Sub Total:", 244, 330), w("2.00", 365, 330),
  ...FOOTER,
])];

describe("Current Stock with Serial And Cost", () => {
  it("is told apart from the plain stock report, whose title it contains", () => {
    expect(detectReport(SERIALS)).toBe("stock_serials");
  });

  it("takes the product's code and description from the two lines above the table", () => {
    const { grids } = readSerials(SERIALS);
    expect(grids["Serial numbers"][1]).toEqual([
      "21.45 M2253B", 'RealView 21.45" INCH FHD LED Monitor', "GB225322104401106",
      "Purchase", "CSLPUR2023000003", "02/08/2023", "Opening Stock", 7650,
    ]);
  });

  it("puts the wrapped tail back on the invoice number", () => {
    const { grids } = readSerials(SERIALS);
    expect(grids["Serial numbers"][1][4]).toBe("CSLPUR2023000003");
  });

  it("counts every unit, including the ones with no serial", () => {
    // This is the figure that has to agree with the stock report's grand total.
    expect(readSerials(SERIALS).totals.qty).toBe(3);
  });

  it("gives every product a dated opening stock line, which no other report can", () => {
    // The stock report knows the quantity and the cost but not the day the goods
    // arrived. Without a date an imported shelf looks as though all of it turned up on
    // go-live day, and the stock ageing report has nothing to say.
    const { grids } = readSerials(SERIALS);
    expect(grids["Opening stock"].slice(1)).toEqual([
      ["21.45 M2253B", 1, 7650, "02/08/2023"],
      ["22.5W Mini Power Bank", 2, 1470, "29/08/2026"],
    ]);
  });

  it("averages the cost over the deliveries, weighted by how many came on each", () => {
    const twice = page([
      w("Current Stock(Combined) with Serial And Cost", 164, 681, 12),
      w("ABC", 276, 554), w("A thing", 206, 541),
      w("Invoice No", 38, 519), w("Qty", 301, 519), w("Serial", 451, 519), w("Unit Cost", 542, 519),
      w("CSLPUR202600001", 38, 505), w("02/03/2026", 130, 505), w("IT SOURCE", 183, 505),
      w("3.00", 323, 484), w("Purchase", 342, 484), w("100.00", 552, 484),
      w("CSLPUR202600002", 38, 450), w("01/01/2026", 130, 450), w("IT SOURCE", 183, 450),
      w("1.00", 323, 430), w("Purchase", 342, 430), w("200.00", 552, 430),
    ]);
    const { grids } = readSerials([twice]);
    // (3 × 100 + 1 × 200) ÷ 4 = 125, and the oldest delivery dates the layer.
    expect(grids["Opening stock"][1]).toEqual(["ABC", 4, 125, "01/01/2026"]);
  });

  it("calls a product serial-tracked only when its units came with serials", () => {
    const { grids } = readSerials(SERIALS);
    expect(grids.Products.slice(1)).toEqual([
      ["21.45 M2253B", 'RealView 21.45" INCH FHD LED Monitor', "Yes", 1],
      ["22.5W Mini Power Bank", "22.5W Dual Cable Mini Power Bank 10000mAh", "No", 0],
    ]);
  });

  it("treats a block that opens with one heading as the same product carrying on", () => {
    // A page break in the middle of a product prints the description again and not the
    // code. Taking that for a new product would invent one with no code, and hang its
    // serials on it.
    const second = page([
      ...LETTERHEAD(757),
      w("Current Stock(Combined) with Serial And Cost", 164, 681, 12),
      w("22.5W Dual Cable Mini Power Bank 10000mAh", 206, 659),
      w("Invoice No", 38, 638), w("Qty", 301, 638), w("Serial", 451, 638), w("Unit Cost", 542, 638),
      w("CSLPUR202600001", 38, 624), w("03/01/2026", 130, 624), w("IT SOURCE", 183, 624),
      w("1.00", 323, 603), w("Purchase", 342, 603), w("PB99001", 423, 603), w("1,470.00", 552, 603),
    ]);
    const { grids, totals } = readSerials([SERIALS[0], second]);
    expect(totals.products).toBe(2);
    expect(grids["Serial numbers"].slice(1).map((r) => [r[0], r[2]])).toEqual([
      ["21.45 M2253B", "GB225322104401106"],
      ["22.5W Mini Power Bank", "PB99001"],
    ]);
  });
});

// ---------------------------------------------------------------------------

const DUE = [page([
  ...LETTERHEAD(807),
  w("All Traders Due List", 241, 756, 12),
  w("02/11/2026", 273, 736),
  w("Receivable", 34, 714, 8.75),
  w("SL", 30, 697), w("Customer Name", 51, 697), w("Address", 190, 697),
  w("Mobile", 419, 697), w("Due", 556, 697),
  w("Customer", 49, 680, 8.75),
  w("Local Customer", 60, 663, 8.75),
  w("1", 33, 652), w("AQSA TECH", 48, 652), w("Anamica Concord Tower, Shewrapara", 189, 652),
  w("01723666638", 419, 652), w("400.00", 545, 652),
  w("2", 33, 638), w("CSL HEAD OFFICE", 48, 638), w("12B, ATATURK TOWER", 189, 638),
  w("01678090035", 419, 638), w("83,217.00", 534, 638),
  // The address runs onto a second line, under where it started.
  w("AVENUE BANANI, DHAKA-1213", 189, 628),
  w("Group Wise Sub Total :", 325, 616), w("83,617.00", 535, 616),
  w("Payable", 34, 598, 8.75),
  w("Supplier", 49, 580, 8.75),
  w("Supplier", 60, 563, 8.75),
  w("6", 33, 550), w("Business Computer@23", 48, 550), w("Out of idb", 189, 550),
  w("00000000", 419, 550), w("-5,375.00", 534, 550),
  w("Grand Total :", 325, 520), w("78,242.00", 535, 520),
  ...FOOTER,
])];

describe("All Traders Due List", () => {
  it("splits the traders by what BMS filed them as, not by which half they are in", () => {
    const { grids } = readDueList(DUE);
    expect(grids.Customers.slice(1).map((r) => r[0])).toEqual(["AQSA TECH", "CSL HEAD OFFICE"]);
    expect(grids.Suppliers.slice(1).map((r) => r[0])).toEqual(["Business Computer@23"]);
  });

  it("joins an address back together when it wraps", () => {
    const { grids } = readDueList(DUE);
    expect(grids.Customers[2][1]).toBe("12B, ATATURK TOWER AVENUE BANANI, DHAKA-1213");
  });

  it("turns a supplier's sign over, because our books hold what we owe them", () => {
    // BMS prints one signed column for both halves, so a payable reads as a negative.
    const { grids } = readDueList(DUE);
    expect(grids.Suppliers[1][4]).toBe(5375);
    expect(grids.Customers[1][4]).toBe(400);
  });

  it("blanks a made-up mobile number rather than importing it", () => {
    const { grids } = readDueList(DUE);
    expect(grids.Suppliers[1][2]).toBe("");
    expect(grids.Customers[1][2]).toBe("01723666638");
  });

  it("checks itself against the grand total the report printed", () => {
    const read = readDueList(DUE);
    expect(read.totals.total).toBe(read.totals.reportTotal);
    expect(read.warnings.filter((x) => /grand total/.test(x))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const INFO = [page([
  ...LETTERHEAD(806),
  w("Supplier Information", 247, 716, 12),
  w("SL", 32, 692), w("Code", 59, 692), w("Name", 91, 692), w("Address", 187, 692),
  w("Mobile", 329, 692), w("Contact Person", 394, 692), w("Opening Balance", 479, 692),
  w("Supplier", 90, 671, 8.75),
  w("1", 35, 660), w("A.Z Computer", 90, 660), w("IDB Bhaban", 185, 660),
  w("01676-626924", 327, 660), w("0.00", 522, 660), w("central", 547, 660),
  w("2", 35, 645), w("Asia Computer Bazar", 90, 645), w("Multiplan Center", 185, 645),
  w("01844168600", 327, 645), w("0.00", 522, 645), w("Enamul Haque", 534, 645),
  // The name is too long for its column and finishes on the next line.
  w("LTD", 90, 634),
  w("3", 35, 620), w("Businessland Limited23@", 90, 620), w("IDB", 185, 620),
  w("01000023", 327, 620), w("74,865.00", 500, 620), w("central", 547, 620),
  ...FOOTER,
])];

describe("Supplier Information", () => {
  it("reads the columns by where they are on the page", () => {
    const { grids } = readInformation(INFO, "suppliers");
    expect(grids.Suppliers[0]).toEqual(
      ["Code", "Name", "Address", "Mobile", "Contact Person", "Group", "Opening Balance"]);
    expect(grids.Suppliers[1]).toEqual(
      ["", "A.Z Computer", "IDB Bhaban", "01676626924", "", "Supplier", 0]);
  });

  it("joins a wrapped name onto the row above instead of making a row of it", () => {
    const { grids } = readInformation(INFO, "suppliers");
    expect(grids.Suppliers).toHaveLength(4);
    expect(grids.Suppliers[2][1]).toBe("Asia Computer Bazar LTD");
  });

  it("tells a group heading from a wrapped name by the size BMS sets it in", () => {
    // Both sit at the same indent, which is why the type size has to decide.
    const { grids } = readInformation(INFO, "suppliers");
    expect(grids.Suppliers.slice(1).every((r) => r[5] === "Supplier")).toBe(true);
  });

  it("keeps the opening balance apart from whoever entered the row", () => {
    const { grids } = readInformation(INFO, "suppliers");
    expect(grids.Suppliers[3][6]).toBe(74865);
    expect(grids.Suppliers[2][6]).toBe(0);
  });

  it("flags the traders entered twice rather than merging them quietly", () => {
    const read = readInformation(INFO, "suppliers");
    expect(readBmsPdf(INFO).report).toBe("suppliers");
    expect(read.warnings).toEqual([]);
    expect(duplicateWarnings(["Businessland Limited", "Businessland Limited23@"])[0])
      .toMatch(/same trader entered twice/);
  });
});

describe("a mobile number that is not one", () => {
  it("keeps a real Bangladeshi mobile, with or without the country code", () => {
    expect(cleanPhone("01723666638")).toBe("01723666638");
    expect(cleanPhone("8801706789314")).toBe("01706789314");
    expect(cleanPhone("01676-626924")).toBe("01676626924");
  });

  it("drops what BMS made up to get past its own required field", () => {
    for (const made of ["-1192", "00000000", "025", "0352", "-1133"]) {
      expect(cleanPhone(made)).toBe("");
    }
  });
});

describe("a PDF that is not one of the five", () => {
  it("says which reports it takes, rather than failing silently", () => {
    const other = [page([w("Income Statement", 200, 700, 12)])];
    expect(() => readBmsPdf(other)).toThrow(/Current Stock/);
  });
});
