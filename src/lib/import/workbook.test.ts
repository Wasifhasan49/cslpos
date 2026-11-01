import { describe, expect, it } from "vitest";
import { findHeaderRow, readSheet } from "./parse";
import {
  decodeText, looksBinaryXls, looksZip, readDelimited, readHtmlTables,
  readSpreadsheetMl, readWorkbook, UnreadableFile,
} from "./workbook";

const buf = (parts: (number | string)[]): ArrayBuffer => {
  const bytes: number[] = [];
  for (const p of parts) {
    if (typeof p === "number") bytes.push(p);
    else for (const b of new TextEncoder().encode(p)) bytes.push(b);
  }
  return new Uint8Array(bytes).buffer;
};

const noXlsx = async (): Promise<never> => { throw new Error("should not be called"); };

describe("what kind of file is this", () => {
  it("knows a real binary .xls from its signature", () => {
    expect(looksBinaryXls(buf([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]))).toBe(true);
    expect(looksBinaryXls(buf(["Code,Name\n"]))).toBe(false);
  });

  it("knows an .xlsx by its zip header, whatever it is called", () => {
    expect(looksZip(buf([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
  });

  it("reads the UTF-16 some Windows tools write", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x09, 0x00, 0x42, 0x00]);
    expect(decodeText(utf16.buffer)).toBe("A\tB");
  });

  it("says what to do about a file it cannot read, instead of a stack trace", async () => {
    const real = buf([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    await expect(readWorkbook(real, "sales.xls", noXlsx)).rejects.toBeInstanceOf(UnreadableFile);
    await expect(readWorkbook(real, "sales.xls", noXlsx)).rejects.toThrow(/Save As/);
  });
});

// What BMS's report viewer actually writes when you press Excel: an HTML table with
// the report name across the top, called .xls.
const BMS_HTML = `<html><head><meta charset="utf-8"></head><body>
<table border=1>
<tr><td colspan=4>Product List&nbsp;&nbsp;Printed: 01/11/2026</td></tr>
<tr><td>Code</td><td>Name</td><td>Brand</td><td>Sale Price</td></tr>
<tr><td>VEN-HDMI-15</td><td>Vention HDMI Cable 1.5m&nbsp;Black</td><td>Vention</td><td>450.00</td></tr>
<tr><td>LOG-K120</td><td>Logitech K120 Keyboard</td><td>Logitech</td><td>850.00</td></tr>
</table></body></html>`;

describe("an HTML table called .xls", () => {
  it("comes out as a grid, with the title row kept where it was", () => {
    const grids = readHtmlTables(BMS_HTML);
    const grid = grids.Sheet1;
    expect(grid[0][0]).toBe("Product List Printed: 01/11/2026");
    // colspan=4 means the title row is as wide as the table, so nothing shifts left.
    expect(grid[0]).toHaveLength(4);
    expect(grid[1]).toEqual(["Code", "Name", "Brand", "Sale Price"]);
    expect(grid[2][1]).toBe("Vention HDMI Cable 1.5m Black");
  });

  it("is still read as a product list by the same header-finding as a CSV", async () => {
    const grids = await readWorkbook(buf([BMS_HTML]), "products.xls", noXlsx);
    const grid = grids.Sheet1;
    expect(findHeaderRow(grid)).toBe(1);
    const sheet = readSheet(grid);
    expect(sheet.headers).toContain("Sale Price");
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[1]["Code"]).toBe("LOG-K120");
  });

  it("names the sheets when a report has several tables", () => {
    const two = `<table><tr><td>A</td></tr></table><table><tr><td>B</td></tr></table>`;
    expect(Object.keys(readHtmlTables(two))).toEqual(["Table 1", "Table 2"]);
  });
});

describe("Excel 2003 XML called .xls", () => {
  const XML = `<?xml version="1.0"?><Workbook xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Customers"><Table>
<Row><Cell><Data ss:Type="String">Name</Data></Cell><Cell><Data ss:Type="String">Phone</Data></Cell><Cell><Data ss:Type="String">Limit</Data></Cell></Row>
<Row><Cell><Data ss:Type="String">Karim Traders</Data></Cell><Cell><Data ss:Type="String">01811000000</Data></Cell><Cell><Data ss:Type="Number">25000</Data></Cell></Row>
<Row><Cell><Data ss:Type="String">Rahim</Data></Cell><Cell ss:Index="3"><Data ss:Type="Number">0</Data></Cell></Row>
</Table></Worksheet></Workbook>`;

  it("keeps the sheet name, the numbers as numbers, and the skipped columns", async () => {
    const grids = await readWorkbook(buf([XML]), "customers.xls", noXlsx);
    expect(Object.keys(grids)).toEqual(["Customers"]);
    const grid = grids.Customers;
    expect(grid[1]).toEqual(["Karim Traders", "01811000000", 25000]);
    // ss:Index="3" means the phone column was empty, not that the 0 belongs in it.
    expect(grid[2]).toEqual(["Rahim", null, 0]);
  });

  it("does not read a phone number as a number, which would lose the leading zero", () => {
    const grid = readSpreadsheetMl(XML).Customers;
    expect(grid[1][1]).toBe("01811000000");
  });
});

describe("delimited text", () => {
  it("picks the separator that gives even columns, not the one that gives most", () => {
    // Tab-separated, with commas inside an address: splitting on the comma would make
    // a different number of columns on every line.
    const text = "Name\tAddress\tPhone\nKarim\tShop 9, BCS City, Dhaka\t01811000000\n"
      + "Rahim\tRoad 3, Mirpur\t01911000000\n";
    const grid = readDelimited(text);
    expect(grid[0]).toEqual(["Name", "Address", "Phone"]);
    expect(grid[1]).toEqual(["Karim", "Shop 9, BCS City, Dhaka", "01811000000"]);
  });

  it("still reads an ordinary comma-separated file, quotes and all", async () => {
    const grids = await readWorkbook(
      buf(['Code,Name\nLOG-K120,"Keyboard, black"\n']), "x.csv", noXlsx,
    );
    expect(grids.Sheet1[1]).toEqual(["LOG-K120", "Keyboard, black"]);
  });

  it("sends a zip to the Excel reader instead of guessing at the bytes", async () => {
    const grids = await readWorkbook(
      buf([0x50, 0x4b, 0x03, 0x04, 0x00]), "x.xls",
      async () => ({ Sheet1: [["Code"], ["LOG-K120"]] }),
    );
    expect(grids.Sheet1[1]).toEqual(["LOG-K120"]);
  });

  it("refuses an empty file in words a shopkeeper can act on", async () => {
    await expect(readWorkbook(buf([""]), "empty.xls", noXlsx)).rejects.toThrow(/empty\.xls/);
  });
});
