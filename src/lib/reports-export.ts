/**
 * Getting a report out of the app.
 *
 * Three ways, and none of them needs a new library or a server. **Excel** is built with
 * exceljs, which P4 already uses to read import files. **PDF** is the browser's own
 * print dialogue against the print stylesheet — a report is a page of paper, and the
 * browser is better at making paper than any library we could add. **CSV and Tally**
 * are text.
 *
 * ABOUT THE TALLY FILE. Tally imports XML: an ENVELOPE of VOUCHER elements, each with
 * its ledger entries and an ISDEEMEDPOSITIVE flag saying which side the line is on.
 * That shape is stable across Tally versions, but ledger NAMES have to match the ones
 * in the Tally company exactly or it refuses the voucher, and no export can know what a
 * particular accountant called their accounts. So: check ONE voucher in Tally, fix the
 * names, then import the year. The CSV is there for the accountant who would rather map
 * the columns themselves, which in practice is most of them.
 */
import { formatDay } from "./sale";
import type { JournalExport, ReportColumnOut, ReportResult, ReportRow } from "./types";

/** What a cell should say. Money and quantity come out as numbers, so Excel can add them. */
export function cellValue(row: ReportRow, c: ReportColumnOut): string | number | null {
  const v = row[c.f];
  if (v === null || v === undefined || v === "") return null;
  if (c.t === "money" || c.t === "qty" || c.t === "num" || c.t === "pct") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return String(v);
}

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A sheet is the report's columns, its rows, and its totals at the bottom. */
interface Sheet {
  name: string;
  columns: ReportColumnOut[];
  rows: ReportRow[];
  totals: ReportRow | null;
}

function sheetsOf(r: ReportResult): Sheet[] {
  if (r.sections && r.sections.length > 0) {
    return r.sections.map((s, i) => ({
      // Excel sheet names cannot hold / \ ? * [ ] : and stop at 31 characters.
      name: (s.title || `Part ${i + 1}`).replace(/[/\\?*[\]:]/g, " ").slice(0, 31),
      columns: s.columns.length > 0 ? s.columns : r.columns,
      rows: s.rows,
      totals: s.totals,
    }));
  }
  return [{ name: r.key.replace(/[/\\?*[\]:]/g, " ").slice(0, 31),
            columns: r.columns, rows: r.rows, totals: r.totals }];
}

export function reportToCsv(r: ReportResult): string {
  const out: string[] = [];
  out.push(csvCell(r.title));
  out.push(csvCell(periodWords(r)));
  for (const sheet of sheetsOf(r)) {
    out.push("");
    if (sheetsOf(r).length > 1) out.push(csvCell(sheet.name));
    out.push(sheet.columns.map((c) => csvCell(c.l)).join(","));
    for (const row of sheet.rows) {
      out.push(sheet.columns.map((c) => csvCell(cellValue(row, c))).join(","));
    }
    if (sheet.totals) {
      out.push(sheet.columns.map((c) => csvCell(cellValue(sheet.totals!, c))).join(","));
    }
  }
  return out.join("\n");
}

/**
 * The period, as the export writes it: ISO dates, which sort properly in a spreadsheet
 * column and are what anybody opening the CSV in another tool expects.
 *
 * The screen and the printed page use `periodShown()` instead, because a shopkeeper
 * reads 02/11/2026.
 */
export function periodWords(r: ReportResult): string {
  const f = r.filters;
  if (r.dateMode === "as_on") return `As on ${f.asOn ?? "today"}`;
  if (r.dateMode === "none") return "";
  if (f.from && f.to) return `${f.from} to ${f.to}`;
  if (f.from) return `From ${f.from}`;
  if (f.to) return `Up to ${f.to}`;
  return "Everything so far";
}

/** The same period in the words a shop reads: dd/mm/yyyy, Dhaka. */
export function periodShown(r: ReportResult): string {
  return periodWords(r).replace(/\d{4}-\d{2}-\d{2}/g, (d) => formatDay(`${d}T06:00:00Z`));
}

/** Build the .xlsx. exceljs is loaded only when somebody actually asks for one. */
export async function reportToXlsx(r: ReportResult): Promise<Blob> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = r.shop ?? "CSL Counter";
  wb.created = new Date();

  for (const sheet of sheetsOf(r)) {
    const ws = wb.addWorksheet(sheet.name);
    ws.addRow([r.title]).font = { bold: true, size: 14 };
    const period = periodWords(r);
    if (period) ws.addRow([period]);
    ws.addRow([`${r.shop ?? ""}${r.branch ? ` · ${r.branch}` : ""}`]);
    ws.addRow([]);

    const head = ws.addRow(sheet.columns.map((c) => c.l));
    head.font = { bold: true };
    head.eachCell((cell) => {
      cell.border = { bottom: { style: "thin" } };
    });

    for (const row of sheet.rows) {
      const line = ws.addRow(sheet.columns.map((c) => cellValue(row, c)));
      if (row._kind !== "detail") line.font = { bold: true };
      // Subtotals are indented by how deep they are, same as on screen.
      if (row._kind === "subtotal") line.getCell(1).alignment = { indent: row._level };
    }
    if (sheet.totals) {
      const line = ws.addRow(sheet.columns.map((c) => cellValue(sheet.totals!, c)));
      line.font = { bold: true };
      line.eachCell((cell) => {
        cell.border = { top: { style: "thin" }, bottom: { style: "double" } };
      });
    }

    sheet.columns.forEach((c, i) => {
      const column = ws.getColumn(i + 1);
      column.width = c.t === "text" ? 28 : 14;
      if (c.t === "money") column.numFmt = "#,##0.00";
      if (c.t === "qty") column.numFmt = "#,##0";
      if (c.t === "pct") column.numFmt = '#,##0.0"%"';
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function journalToCsv(x: JournalExport): string {
  const head = ["Date", "Voucher", "Kind", "Narration", "Account code", "Account",
                "Party", "Debit", "Credit", "Note", "Branch"];
  const rows = x.lines.map((l) => [
    l.date, l.entryNo, l.kind, l.narration, l.accountCode, l.account, l.party,
    l.debit, l.credit, l.note, l.branch,
  ].map(csvCell).join(","));
  return [head.join(","), ...rows].join("\n");
}

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The journal as Tally XML.
 *
 * One VOUCHER per entry, with every line as an ALLLEDGERENTRIES.LIST item.
 * ISDEEMEDPOSITIVE is Yes for a debit and No for a credit, and AMOUNT is negative for a
 * debit — that inversion is Tally's, not a mistake here.
 */
export function journalToTallyXml(x: JournalExport): string {
  const byEntry = new Map<string, typeof x.lines>();
  for (const l of x.lines) {
    const got = byEntry.get(l.entryNo) ?? [];
    got.push(l);
    byEntry.set(l.entryNo, got);
  }
  const vouchers = [...byEntry.entries()].map(([entryNo, lines]) => {
    const first = lines[0];
    const date = first.date.replace(/-/g, "");
    const entries = lines.map((l) => {
      const debit = l.debit > 0;
      const amount = debit ? -l.debit : l.credit;
      return [
        "          <ALLLEDGERENTRIES.LIST>",
        `            <LEDGERNAME>${xml(l.account)}</LEDGERNAME>`,
        `            <ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
        `            <AMOUNT>${amount.toFixed(2)}</AMOUNT>`,
        "          </ALLLEDGERENTRIES.LIST>",
      ].join("\n");
    }).join("\n");
    return [
      `        <VOUCHER VCHTYPE="${xml(first.kind)}" ACTION="Create">`,
      `          <DATE>${date}</DATE>`,
      `          <VOUCHERTYPENAME>${xml(first.kind)}</VOUCHERTYPENAME>`,
      `          <VOUCHERNUMBER>${xml(entryNo)}</VOUCHERNUMBER>`,
      `          <NARRATION>${xml(first.narration)}</NARRATION>`,
      entries,
      "        </VOUCHER>",
    ].join("\n");
  });

  return [
    "<ENVELOPE>",
    "  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>",
    "  <BODY>",
    "    <IMPORTDATA>",
    "      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>",
    "      <REQUESTDATA>",
    ...vouchers,
    "      </REQUESTDATA>",
    "    </IMPORTDATA>",
    "  </BODY>",
    "</ENVELOPE>",
  ].join("\n");
}

/** Hand the file to the browser. */
export function download(name: string, data: Blob | string, type = "text/plain"): void {
  const blob = typeof data === "string"
    // The BOM is for Excel on Windows, which otherwise reads a UTF-8 CSV as Latin-1 and
    // turns every ৳ into mojibake.
    ? new Blob([`﻿${data}`], { type: `${type};charset=utf-8` })
    : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** A file name a person can find again: the report, the period, the day. */
export function fileName(r: ReportResult, ext: string): string {
  const bits = [r.key, r.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()];
  if (r.filters.from) bits.push(r.filters.from);
  if (r.filters.to && r.filters.to !== r.filters.from) bits.push(r.filters.to);
  if (r.filters.asOn) bits.push(r.filters.asOn);
  return `${bits.join("_")}.${ext}`;
}
