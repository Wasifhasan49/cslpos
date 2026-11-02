import { describe, expect, it } from "vitest";
import {
  cellValue, journalToCsv, journalToTallyXml, periodShown, periodWords, reportToCsv,
} from "./reports-export";
import type { JournalExport, ReportResult, ReportRow } from "./types";

const row = (r: Record<string, unknown>): ReportRow =>
  ({ _kind: "detail", _level: 1, ...r }) as ReportRow;

const report = (over: Partial<ReportResult> = {}): ReportResult => ({
  key: "S-1", register: "sales", title: "Sales by date", note: null, noteExtra: null,
  dateMode: "range", landscape: false,
  columns: [
    { f: "d", l: "Date", t: "date" },
    { f: "invoice_no", l: "Invoice No", t: "text" },
    { f: "amount", l: "Amount", t: "money" },
  ],
  rows: [
    row({ d: "2026-10-26", invoice_no: "CSL-MB-2026000001", amount: 1000 }),
    { _kind: "subtotal", _level: 1, d: "2026-10-26", amount: 1000 } as ReportRow,
  ],
  totals: { _kind: "total", _level: 0, amount: 1000 } as ReportRow,
  sections: null, pivot: false, balanced: null, drill: null, opening: null,
  account: null, onOrder: null, stockValue: null, stockOnShelves: null,
  stockNoCost: null, stockAccount: null,
  shop: "Demo Shop", branch: "Main branch",
  runAt: "2026-10-26T10:00:00Z", runBy: "Ovi",
  filters: { from: "2026-10-01", to: "2026-10-26" },
  ...over,
});

describe("getting a report out", () => {
  it("sends money and quantity to Excel as numbers, so the spreadsheet can add them", () => {
    const r = report();
    expect(cellValue(r.rows[0], r.columns[2])).toBe(1000);
    expect(cellValue(r.rows[0], r.columns[1])).toBe("CSL-MB-2026000001");
    // A blank cell is blank, not a zero: a subtotal has no invoice number, and writing
    // 0 there would be inventing one.
    expect(cellValue(r.rows[1], r.columns[1])).toBeNull();
  });

  it("the CSV carries the headings, the rows and the total", () => {
    const csv = reportToCsv(report());
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Sales by date");
    expect(lines[1]).toBe("2026-10-01 to 2026-10-26");
    expect(csv).toContain("Date,Invoice No,Amount");
    expect(csv).toContain("2026-10-26,CSL-MB-2026000001,1000");
    // The total row is last, with nothing in the text columns.
    expect(lines[lines.length - 1]).toBe(",,1000");
  });

  it("quotes a value that would otherwise break the columns", () => {
    const csv = reportToCsv(report({
      rows: [row({ d: "2026-10-26", invoice_no: 'Smith, "Bob" & Co', amount: 5 })],
    }));
    expect(csv).toContain('"Smith, ""Bob"" & Co"');
  });

  it("says the period in ISO for the export, which is what sorts in a spreadsheet", () => {
    expect(periodWords(report())).toBe("2026-10-01 to 2026-10-26");
    expect(periodWords(report({ dateMode: "as_on", filters: { asOn: "2026-10-26" } })))
      .toBe("As on 2026-10-26");
    expect(periodWords(report({ dateMode: "none", filters: {} }))).toBe("");
  });

  it("and in dd/mm/yyyy on the printed page, which is what a shop reads", () => {
    expect(periodShown(report())).toBe("01/10/2026 to 26/10/2026");
    expect(periodShown(report({ dateMode: "as_on", filters: { asOn: "2026-10-26" } })))
      .toBe("As on 26/10/2026");
    // Nothing to rewrite, and nothing broken by looking.
    expect(periodShown(report({ dateMode: "none", filters: {} }))).toBe("");
  });

  it("a report in blocks exports one sheet per block", () => {
    const csv = reportToCsv(report({
      rows: [],
      sections: [
        { title: "What the shop owes", columns: [], rows: [row({ invoice_no: "Capital", amount: 500 })],
          totals: null, opening: null, extra: null },
        { title: "What the shop owns", columns: [], rows: [row({ invoice_no: "Cash", amount: 500 })],
          totals: null, opening: null, extra: null },
      ],
    }));
    expect(csv).toContain("What the shop owes");
    expect(csv).toContain("What the shop owns");
  });
});

const journal = (): JournalExport => ({
  shop: "Demo Shop", from: "2026-10-01", to: "2026-10-26",
  lines: [
    { date: "2026-10-26", entryNo: "VCH-MB-2026000001", kind: "Sales",
      narration: "Sale CSL-MB-2026000001", account: "Cash in hand", accountCode: "1001",
      party: "", debit: 1000, credit: 0, note: "", branch: "Main branch" },
    { date: "2026-10-26", entryNo: "VCH-MB-2026000001", kind: "Sales",
      narration: "Sale CSL-MB-2026000001", account: "Sales", accountCode: "4000",
      party: "", debit: 0, credit: 1000, note: "", branch: "Main branch" },
  ],
});

describe("the accountant's export", () => {
  it("writes every line, both sides", () => {
    const csv = journalToCsv(journal());
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv).toContain("Cash in hand");
    expect(csv).toContain("Sales");
  });

  it("groups a Tally voucher's lines under one voucher", () => {
    const x = journalToTallyXml(journal());
    expect(x.match(/<VOUCHER /g)).toHaveLength(1);
    expect(x.match(/<ALLLEDGERENTRIES.LIST>/g)).toHaveLength(2);
    expect(x).toContain("<VOUCHERNUMBER>VCH-MB-2026000001</VOUCHERNUMBER>");
    // Tally wants the date with no separators.
    expect(x).toContain("<DATE>20261026</DATE>");
  });

  it("marks a debit as deemed positive with a NEGATIVE amount, which is Tally's own convention", () => {
    const x = journalToTallyXml(journal());
    const [first, second] = x.split("<ALLLEDGERENTRIES.LIST>").slice(1);
    expect(first).toContain("<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>");
    expect(first).toContain("<AMOUNT>-1000.00</AMOUNT>");
    expect(second).toContain("<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>");
    expect(second).toContain("<AMOUNT>1000.00</AMOUNT>");
  });

  it("escapes a ledger name with an ampersand in it, which half of Dhaka has", () => {
    const x = journalToTallyXml({
      ...journal(),
      lines: [{ ...journal().lines[0], account: "Rahim & Sons" }],
    });
    expect(x).toContain("<LEDGERNAME>Rahim &amp; Sons</LEDGERNAME>");
  });
});
