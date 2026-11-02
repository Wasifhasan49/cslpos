// Turning whatever file somebody picked into grids of cells.
//
// BMS's report viewer offers "Excel" and saves a file called .xls, but a report viewer
// almost never writes a real Excel workbook: what comes out is usually an HTML table,
// or Excel 2003's XML, or tab-separated text, with .xls on the end. A shop also renames
// files, so a .xls may really be a .xlsx and a .txt may really be a CSV. So the bytes
// decide what this is, not the extension.
//
// The one thing that cannot be read here is a REAL .xls — the old binary workbook Excel
// itself writes, which starts with the OLE2 signature. Reading that needs a BIFF parser;
// `looksBinaryXls()` spots it so the screen can say what to do instead.
import { readBmsPdf, type BmsReport } from "./bms-pdf";
import type { PdfPage } from "./pdf-text";
import type { Grid } from "./parse";

export type Grids = Record<string, Grid>;

const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** A real binary Excel workbook (BIFF), which this cannot read. */
export function looksBinaryXls(buf: ArrayBuffer): boolean {
  const head = new Uint8Array(buf.slice(0, 8));
  return OLE2.every((b, i) => head[i] === b);
}

/** A PDF, which is what BMS's report viewer can actually produce. */
export function looksPdf(buf: ArrayBuffer): boolean {
  const head = new Uint8Array(buf.slice(0, 5));
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
}

/** A zip, so an .xlsx — whatever it is called. */
export function looksZip(buf: ArrayBuffer): boolean {
  const head = new Uint8Array(buf.slice(0, 4));
  return head[0] === 0x50 && head[1] === 0x4b;
}

/** Decode as text, tolerating the UTF-16 some Windows tools write. */
export function decodeText(buf: ArrayBuffer): string {
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  return new TextDecoder().decode(buf).replace(/^﻿/, "");
}

const DECODE: [RegExp, string][] = [
  [/&nbsp;/gi, " "], [/&amp;/gi, "&"], [/&lt;/gi, "<"], [/&gt;/gi, ">"],
  [/&quot;/gi, '"'], [/&#39;|&apos;/gi, "'"],
];

function unentity(s: string): string {
  let out = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  for (const [re, to] of DECODE) out = out.replace(re, to);
  return out;
}

/** The cell's text, with the markup taken out. */
function cellText(html: string): string {
  return unentity(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Tables out of an HTML export. Read with regular expressions rather than DOMParser so
 * the same code runs in a test, and because these files are machine-written: there is
 * no hand-made markup to be clever about. `colspan` is honoured, because a report
 * viewer uses it to put a title across the top and the columns would otherwise shift.
 */
export function readHtmlTables(html: string): Grids {
  const out: Grids = {};
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  tables.forEach((table, i) => {
    const grid: Grid = [];
    for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells: (string | number | null)[] = [];
      for (const cell of row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) ?? []) {
        const span = Math.min(Number(/colspan\s*=\s*"?(\d+)/i.exec(cell)?.[1] ?? 1) || 1, 50);
        const value = cellText(cell);
        cells.push(value === "" ? null : value);
        for (let k = 1; k < span; k++) cells.push(null);
      }
      if (cells.length > 0) grid.push(cells);
    }
    if (grid.length > 0) out[tables.length === 1 ? "Sheet1" : `Table ${i + 1}`] = grid;
  });
  return out;
}

/** Excel 2003's XML ("SpreadsheetML"), which some viewers write as .xls too. */
export function readSpreadsheetMl(xml: string): Grids {
  const out: Grids = {};
  const sheets = xml.match(/<Worksheet[\s\S]*?<\/Worksheet>/gi) ?? [];
  sheets.forEach((sheet, i) => {
    const name = unentity(/ss:Name\s*=\s*"([^"]*)"/i.exec(sheet)?.[1] ?? `Sheet${i + 1}`);
    const grid: Grid = [];
    for (const row of sheet.match(/<Row[\s\S]*?<\/Row>/gi) ?? []) {
      const cells: (string | number | null)[] = [];
      for (const cell of row.match(/<Cell[\s\S]*?(?:<\/Cell>|\/>)/gi) ?? []) {
        // An empty run of columns is written once, as an index on the next cell.
        const at = Number(/ss:Index\s*=\s*"(\d+)"/i.exec(cell)?.[1] ?? 0);
        if (at > 0) while (cells.length < at - 1) cells.push(null);
        const data = /<Data[^>]*>([\s\S]*?)<\/Data>/i.exec(cell);
        if (!data) { cells.push(null); continue; }
        const isNumber = /ss:Type\s*=\s*"Number"/i.test(cell);
        const value = unentity(data[1].replace(/<[^>]*>/g, "")).trim();
        cells.push(value === "" ? null : isNumber && value !== "" && !Number.isNaN(Number(value)) ? Number(value) : value);
      }
      grid.push(cells);
    }
    if (grid.length > 0) out[name] = grid;
  });
  return out;
}

/**
 * Delimited text. The separator is whichever of tab, comma or semicolon is most even
 * across the first few lines — a Bengali address with a comma in it would otherwise
 * split a tab-separated file into the wrong columns.
 */
export function readDelimited(text: string): Grid {
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sample = src.split("\n").filter((l) => l.trim() !== "").slice(0, 10);
  let sep = ",";
  let bestScore = -1;
  for (const candidate of ["\t", ",", ";", "|"]) {
    const counts = sample.map((l) => l.split(candidate).length - 1);
    const most = Math.max(0, ...counts);
    if (most === 0) continue;
    // Even columns beat many columns: a stray comma shows up as an uneven count.
    const even = counts.filter((c) => c === most).length;
    const score = most * 100 + even;
    if (score > bestScore) { bestScore = score; sep = candidate; }
  }

  const rows: Grid = [];
  let row: (string | number | null)[] = [];
  let cur = "";
  let quoted = false;
  const push = () => { row.push(cur === "" ? null : cur); cur = ""; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) push();
    else if (c === "\n") { push(); rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== "" || row.length > 0) { push(); rows.push(row); }
  return rows;
}

/** What `readWorkbook` could not do, in words the screen can show as they are. */
export class UnreadableFile extends Error {}

/**
 * Every sheet in the file, whatever the file turns out to be. `loadXlsx` is passed in
 * so this module does not drag the Excel library into a test that has no need of it.
 */
export async function readWorkbook(
  buf: ArrayBuffer,
  name: string,
  loadXlsx: (buf: ArrayBuffer) => Promise<Grids>,
): Promise<Grids> {
  if (looksBinaryXls(buf)) {
    throw new UnreadableFile(
      "That is an older Excel file (.xls) saved by Excel itself, which can't be read here. " +
      "Open it in Excel and use File → Save As → Excel Workbook (.xlsx), or CSV, then pick it again.",
    );
  }
  if (looksZip(buf)) return loadXlsx(buf);

  const text = decodeText(buf);
  const head = text.slice(0, 2000).toLowerCase();

  if (head.includes("<?xml") && /spreadsheet|<workbook/i.test(head)) {
    const grids = readSpreadsheetMl(text);
    if (Object.keys(grids).length > 0) return grids;
  }
  if (/<table|<html|<!doctype html/i.test(head)) {
    const grids = readHtmlTables(text);
    if (Object.keys(grids).length > 0) return grids;
  }

  const grid = readDelimited(text);
  if (grid.length === 0) {
    throw new UnreadableFile(
      `"${name}" has nothing this can read. Save it from BMS as CSV or Excel (.xlsx) and try again.`,
    );
  }
  return { Sheet1: grid };
}

/**
 * Everything a picked file turns into: its sheets, plus whatever has to be said about
 * it before anybody maps a column.
 *
 * A spreadsheet says nothing — its rows are its rows. A BMS report PDF has plenty to
 * say: which report it is, what its own totals came to, and which rows look like the
 * same trader entered twice.
 */
export interface FileRead {
  grids: Grids;
  /** Which BMS report this was, when it was one. */
  report: BmsReport | null;
  /** Things a person has to decide. Shown in the review step, word for word. */
  warnings: string[];
}

/**
 * Read whatever was picked: a spreadsheet, a text file, or one of BMS's report PDFs.
 *
 * Both readers run here in the browser, so the shop's whole customer list never leaves
 * the machine. Both libraries are loaded only when the bytes turn out to need them —
 * between them they are much the biggest thing this screen could pull in.
 */
export async function readImportFile(
  buf: ArrayBuffer,
  name: string,
  loaders: {
    xlsx: (bytes: ArrayBuffer) => Promise<Grids>;
    pdf: (bytes: ArrayBuffer) => Promise<PdfPage[]>;
  },
): Promise<FileRead> {
  if (looksPdf(buf)) {
    const read = readBmsPdf(await loaders.pdf(buf));
    return { grids: read.grids, report: read.report, warnings: read.warnings };
  }
  return { grids: await readWorkbook(buf, name, loaders.xlsx), report: null, warnings: [] };
}
