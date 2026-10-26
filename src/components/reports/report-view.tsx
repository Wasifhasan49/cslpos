"use client";

import * as React from "react";
import { Download, Printer, Sheet, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTaka } from "@/lib/sale";
import {
  download, fileName, periodWords, reportToCsv, reportToXlsx,
} from "@/lib/reports-export";
import type { ReportColumnOut, ReportResult, ReportRow, ReportSection } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * One report, drawn.
 *
 * Every report comes back in the same shape — columns, rows, a total, and sometimes
 * blocks — so this one component draws all hundred-odd of them. A subtotal row is
 * indented by how deep its grouping is and printed in bold; a text column is blank on
 * a subtotal, because a subtotal has no one invoice number and printing the first one
 * is how a report starts telling lies.
 *
 * The printed page is the same markup with a print stylesheet over it (globals.css):
 * the shop's name, the report's name, the period, and the column headings repeated on
 * every sheet of paper. No PDF library — the browser is better at making paper than
 * anything we could add, and it is already installed.
 */
export function ReportView({ report, onDrill }: {
  report: ReportResult;
  onDrill?: (field: string, value: string) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const sheets: ReportSection[] = report.sections && report.sections.length > 0
    ? report.sections.map((s) => ({
        ...s, columns: s.columns.length > 0 ? s.columns : report.columns }))
    : [{ title: "", columns: report.columns, rows: report.rows,
         totals: report.totals, opening: report.opening, extra: null }];

  const empty = sheets.every((s) => s.rows.length === 0);

  const excel = async () => {
    setBusy(true);
    try {
      download(fileName(report, "xlsx"), await reportToXlsx(report));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4 no-print">
        <div>
          <h2 className="text-[17px] font-semibold">{report.title}</h2>
          <p className="text-[13px] text-muted">
            <span className="code">{report.key}</span>
            {periodWords(report) && ` · ${periodWords(report)}`}
            {report.branch ? ` · ${report.branch}` : " · every branch"}
          </p>
          {report.note && <p className="mt-1 max-w-[70ch] text-[13px] text-muted">{report.note}</p>}
          {report.noteExtra && (
            <p className="mt-1 flex max-w-[70ch] items-start gap-2 text-[13px] text-ink-soft">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {report.noteExtra}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Print or PDF
          </Button>
          <Button variant="outline" onClick={excel} disabled={busy}>
            <Sheet className="size-4" aria-hidden /> {busy ? "Making it…" : "Excel"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => download(fileName(report, "csv"), reportToCsv(report), "text/csv")}
          >
            <Download className="size-4" aria-hidden /> CSV
          </Button>
        </div>
      </div>

      {/* What the reports whose whole job is to balance have to say. */}
      {report.balanced !== null && (
        <p className={cn(
          "px-4 py-3 text-[15px]",
          report.balanced ? "text-good-ink" : "border-y border-bad-ink/30 bg-bad-bg text-bad-ink")}
        >
          {report.balanced ? balancedWords(report.key) : notBalancedWords(report)}
        </p>
      )}

      <div id="print-report">
        {report.landscape && <style>{"@page { size: A4 landscape; margin: 8mm; }"}</style>}
        <header className="hidden print:block">
          <p style={{ fontWeight: 700, fontSize: 13 }}>{report.shop}</p>
          <p style={{ fontWeight: 700 }}>{report.title}</p>
          <p>
            {periodWords(report)}
            {report.branch ? ` · ${report.branch}` : " · every branch"}
          </p>
        </header>

        {empty && (
          <p className="p-4 text-[15px] text-muted">
            Nothing to show for that. Try a wider range of dates, or every branch.
          </p>
        )}

        {sheets.map((sheet, i) => (
          <div key={sheet.title || i} className="sheet">
            {sheet.title && (
              <h3 className="border-b border-line bg-subtle px-4 py-2 text-[15px] font-semibold">
                {sheet.title}
              </h3>
            )}
            {sheet.opening !== null && sheet.opening !== undefined && (
              <p className="px-4 py-2 text-[13px] text-muted">
                Before this period: <span className="num">{formatTaka(sheet.opening)}</span>
              </p>
            )}
            {sheet.rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[13px] text-muted">
                      {sheet.columns.map((c) => (
                        <th
                          key={c.f}
                          className={cn("p-2 font-normal", isNumber(c) && "right text-right")}
                        >
                          {c.l}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.rows.map((row, n) => (
                      <Line
                        key={n}
                        row={row}
                        columns={sheet.columns}
                        drill={report.drill}
                        onDrill={onDrill}
                      />
                    ))}
                  </tbody>
                  {sheet.totals && (
                    <tfoot>
                      <tr className="border-t-2 border-ink font-semibold">
                        {sheet.columns.map((c) => (
                          <td
                            key={c.f}
                            className={cn("p-2", isNumber(c) && "right text-right")}
                          >
                            {show(sheet.totals!, c)}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
            {sheet.extra && <ExtraBits extra={sheet.extra} />}
          </div>
        ))}

        <footer className="hidden print:block" style={{ marginTop: 8, fontSize: 9 }}>
          Printed {new Date(report.runAt).toLocaleString("en-GB")} by {report.runBy}
        </footer>
      </div>
    </section>
  );
}

function Line({ row, columns, drill, onDrill }: {
  row: ReportRow;
  columns: ReportColumnOut[];
  drill: string | null;
  onDrill?: (field: string, value: string) => void;
}) {
  const subtotal = row._kind === "subtotal";
  const id = drill ? row[drill] : null;
  const clickable = Boolean(onDrill && drill && id && row._kind === "detail");
  return (
    <tr
      // A subtotal is bold, shaded and indented by its depth, and it carries the group
      // it totals — which is how every accounts package shows one. Writing the word
      // "total" into a spare column as well only repeats what the row already says.
      className={cn(
        "border-b border-line/60",
        subtotal && "bg-subtle font-semibold",
        clickable && "cursor-pointer hover:bg-subtle")}
      onClick={clickable ? () => onDrill!(drill!, String(id)) : undefined}
    >
      {columns.map((c, i) => (
        <td
          key={c.f}
          className={cn("p-2", isNumber(c) && "right text-right")}
          style={subtotal && i === 0 ? { paddingLeft: 8 + row._level * 12 } : undefined}
        >
          {show(row, c)}
        </td>
      ))}
    </tr>
  );
}

/** The odds and ends a block of a report carries: a bill's VAT, its narration. */
function ExtraBits({ extra }: { extra: Record<string, unknown> }) {
  const bits = Object.entries(extra).filter(
    ([k, v]) => v !== null && v !== "" && v !== 0 && k !== "sale_id");
  if (bits.length === 0) return null;
  return (
    <p className="px-4 py-2 text-[13px] text-muted">
      {bits.map(([k, v]) => `${k.replace(/_/g, " ")}: ${
        typeof v === "number" ? formatTaka(v) : String(v)}`).join(" · ")}
    </p>
  );
}

const isNumber = (c: ReportColumnOut): boolean =>
  c.t === "money" || c.t === "qty" || c.t === "num" || c.t === "pct";

function show(row: ReportRow, c: ReportColumnOut): React.ReactNode {
  const v = row[c.f];
  if (v === null || v === undefined || v === "") return "";
  if (c.t === "money") return <span className="num">{formatTaka(Number(v))}</span>;
  if (c.t === "qty" || c.t === "num") {
    return <span className="num">{Number(v).toLocaleString("en-GB")}</span>;
  }
  if (c.t === "pct") return <span className="num">{Number(v).toFixed(1)}%</span>;
  if (c.t === "date") return <span className="num">{String(v).slice(0, 10)}</span>;
  return String(v);
}

function balancedWords(key: string): string {
  if (key === "R-4") return "The books and the shelves agree, to the taka.";
  if (key === "A-16" || key === "A-23") return "The two sides match.";
  return "The two columns match, which is what this report is for.";
}

function notBalancedWords(r: ReportResult): string {
  if (r.key === "R-4") {
    return `The books and the shelves differ by ${
      formatTaka(Math.abs((r.stockAccount ?? 0) - (r.stockValue ?? 0)))}. `
      + "Something moved stock without recording what it cost. Catch the books up on the "
      + "Accounts screen, then look at a product's stock ledger (ST-7) for the movement "
      + "that did it.";
  }
  return "These two should be the same figure and they are not. "
    + "Something is wrong — look at the day book for the period, and at any reversal.";
}
