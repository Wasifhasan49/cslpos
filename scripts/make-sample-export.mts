#!/usr/bin/env tsx
// Builds the synthetic BMS exports in bms-export/samples/.
//
// The real export was not available when the importer was written, so these are a
// reconstruction from the BMS screenshots: the same column names, and the same quirks
// a real export has. The point of the quirks is that the importer gets tested against
// messy input rather than against the tidy file nobody actually has.
//
// Quirks deliberately included:
//   * a title row ABOVE the header row (BMS puts the report name there)
//   * "Model No/Caption" and "Product Group" column names
//   * a misspelled category ("Convarter") and brand ("Logitach")
//   * blank rows in the middle
//   * codes with stray leading/trailing spaces
//   * numbers stored as text with thousands commas ("2,900")
//   * a duplicate code, so re-import and conflict handling get exercised
//   * an empty price
//
// Run: pnpm tsx scripts/make-sample-export.mts
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "bms-export", "samples");
fs.mkdirSync(OUT, { recursive: true });

/** A CSV cell: quote it when it contains a comma, quote or newline. */
const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: unknown[][]): string => rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const productRows: unknown[][] = [
  // BMS puts the report title in the first row, so the header is not row 1.
  ["Computer Services - Product List", "", "", "", "", "", "", ""],
  ["Printed: 24/10/2026", "", "", "", "", "", "", ""],
  [],
  ["Product Code", "Model No/Caption", "Product Group", "Brand Name", "Unit", "Sales Price", "MRP", "Warranty"],
  ["VEN-AUD-35", "Vention Audio 3.5mm to 2 Female 3.5mm", "Convarter", "Vention", "Pcs", "500", "600", "1 Year"],
  ["VEN-HDMI-15", "Vention HDMI Cable 1.5m Black", "Cable", "Vention", "Pcs", "450", "550", "1 Year"],
  [" VEN-TC-35 ", "Vention Type-C to 3.5mm Adapter", "Convarter", "Vention", "Pcs", "350", "", "6 Month"],
  [],
  ["LOG-M90", "Logitech M90 Wired Mouse", "Accesories", "Logitach", "Pcs", "450", "500", "1 Year"],
  ["LOG-K120", "Logitech K120 Keyboard", "Accesories", "Logitach", "Pcs", "850", "950", "1 Year"],
  ["CPAD-5F", "Laptop Cooling Pad 5 Fan", "Accesories", "", "Pcs", "1,200", "1,400", "6 Month"],
  ["KVR-8G-32", "Kingston 8GB DDR4 3200 Laptop RAM", "RAM", "Kingston", "Pcs", "2,900", "3,200", "3 Year"],
  ["SAM-980-500", "Samsung 980 500GB NVMe SSD", "SSD", "Samsung", "Pcs", "6,200", "6,800", "5 Year"],
  ["TPL-C6", "TP-Link Archer C6 Router", "Router", "TP-Link", "Pcs", "3,300", "3,600", "1 Year"],
  ["ASU-X1504", "ASUS Vivobook 15 i5 16GB 512GB", "Laptop", "ASUS", "Pcs", "72,000", "75,000", "2 Year"],
  ["HP-680-BK", "HP 680 Black Ink Cartridge", "Printer", "HP", "Pcs", "1,050", "1,150", ""],
  // No price at all: BMS lets this happen, which is how staff end up inventing one.
  ["GEN-USB-HUB", "Generic USB 2.0 4 Port Hub", "Accesories", "", "Pcs", "", "", "6 Month"],
  // Same code twice, with a different price. A real export has these.
  ["LOG-M90", "Logitech M90 Mouse (old entry)", "Accesories", "Logitach", "Pcs", "430", "500", "1 Year"],
];

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

const stockRows: unknown[][] = [
  ["Computer Services - Stock Report", "", "", ""],
  ["As on: 24/10/2026", "", "", ""],
  [],
  ["Product Code", "Model No/Caption", "Store", "Balance Qty"],
  ["VEN-AUD-35", "Vention Audio 3.5mm to 2 Female 3.5mm", "Main Store", "4"],
  ["VEN-HDMI-15", "Vention HDMI Cable 1.5m Black", "Main Store", "9"],
  ["VEN-TC-35", "Vention Type-C to 3.5mm Adapter", "Main Store", "7"],
  ["LOG-M90", "Logitech M90 Wired Mouse", "Main Store", "15"],
  ["LOG-K120", "Logitech K120 Keyboard", "Main Store", "10"],
  [],
  ["CPAD-5F", "Laptop Cooling Pad 5 Fan", "Main Store", "3"],
  ["KVR-8G-32", "Kingston 8GB DDR4 3200 Laptop RAM", "Main Store", "3"],
  ["SAM-980-500", "Samsung 980 500GB NVMe SSD", "Main Store", "3"],
  ["TPL-C6", "TP-Link Archer C6 Router", "Main Store", "2"],
  ["ASU-X1504", "ASUS Vivobook 15 i5 16GB 512GB", "Main Store", "2"],
  ["HP-680-BK", "HP 680 Black Ink Cartridge", "Main Store", "0"],
  // A code that is not in the product list: the review step has to flag it.
  ["MYSTERY-1", "Unknown item from old system", "Main Store", "5"],
];

// ---------------------------------------------------------------------------
// Serials
// ---------------------------------------------------------------------------

const serialRows: unknown[][] = [
  ["Computer Services - Serial/IMEI Report", "", ""],
  [],
  ["Product Code", "Serial/IMEI No", "Status"],
  ["KVR-8G-32", "KVR8A2410933", "In Stock"],
  ["KVR-8G-32", "KVR8A2410941", "In Stock"],
  ["KVR-8G-32", "KVR8A2411007", "In Stock"],
  ["SAM-980-500", "S64DNX0T41822", "In Stock"],
  ["SAM-980-500", "S64DNX0T41907", "In Stock"],
  ["SAM-980-500", " S64DNX0T42015 ", "In Stock"],
  [],
  ["TPL-C6", "22406C6010382", "In Stock"],
  ["TPL-C6", "22406C6010415", "In Stock"],
  ["ASU-X1504", "R9N0CV12A345", "In Stock"],
  ["ASU-X1504", "R9N0CV12A388", "In Stock"],
  // Already sold in BMS: it must not come in as available stock.
  ["ASU-X1504", "R9N0CV12A111", "Sold"],
  // The same serial twice.
  ["KVR-8G-32", "KVR8A2410933", "In Stock"],
];

// ---------------------------------------------------------------------------
// Customers and suppliers
// ---------------------------------------------------------------------------

const customerRows: unknown[][] = [
  ["Computer Services - Customer List", "", "", ""],
  [],
  ["Customer Name", "Mobile No", "Address", "Due Amount"],
  ["Cash Customer", "2026-01-01", "", "0"],
  ["Karim Traders", "01811000000", "Agargaon, Dhaka", "12,500"],
  ["Rahim Enterprise", "01911000000", "Mirpur, Dhaka", "0"],
  [],
  ["Shahin Computers", "01711223344", "IDB Bhaban, Agargaon", "3,200"],
  // No phone number at all, which is how BMS stores most walk-ins.
  ["Walk-in customer", "", "", "0"],
  ["Karim Traders", "01811000000", "Agargaon, Dhaka", "12,500"],
];

const supplierRows: unknown[][] = [
  ["Computer Services - Supplier List", "", "", ""],
  [],
  ["Supplier Name", "Mobile No", "Address", "Due Amount"],
  ["Smart Technologies BD", "01811999001", "Motijheel, Dhaka", "45,000"],
  ["Global Brand Pvt Ltd", "01811999002", "Gulshan, Dhaka", "0"],
  ["Ryans Computers", "01811999003", "Elephant Road, Dhaka", "8,750"],
  [],
  ["Unknown vendor", "", "", "1,000"],
];

// ---------------------------------------------------------------------------

const FILES: [string, unknown[][]][] = [
  ["products", productRows],
  ["stock", stockRows],
  ["serials", serialRows],
  ["customers", customerRows],
  ["suppliers", supplierRows],
];

for (const [name, rows] of FILES) {
  fs.writeFileSync(path.join(OUT, `bms-${name}.csv`), toCsv(rows), "utf8");
}

// One real .xlsx too, so the spreadsheet path is exercised and not just CSV.
const wb = new ExcelJS.Workbook();
for (const [name, rows] of FILES) {
  const ws = wb.addWorksheet(name);
  for (const r of rows) ws.addRow(r);
}
await wb.xlsx.writeFile(path.join(OUT, "bms-export.xlsx"));

console.log(`Wrote ${FILES.length} CSV files and bms-export.xlsx to bms-export/samples/`);
for (const [name, rows] of FILES) {
  console.log(`  bms-${name}.csv — ${rows.length} rows`);
}
