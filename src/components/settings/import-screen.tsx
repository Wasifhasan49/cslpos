"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, FileSpreadsheet, TriangleAlert, Upload } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { suggestCleanups, type Cleanup } from "@/lib/import/clean";
import { guessMapping, readSheet, type Grid, type Mapping, type Sheet } from "@/lib/import/parse";
import { readWorkbook, UnreadableFile, type Grids } from "@/lib/import/workbook";
import { importableRows, reviewRows, type ReviewResult } from "@/lib/import/review";
import { IMPORT_KINDS, kindSpec, type ImportKind } from "@/lib/import/schema";
import type { PriceList } from "@/lib/types";
import { cn } from "@/lib/utils";

type Step = "pick" | "upload" | "map" | "review" | "done";

export function ImportScreen() {
  const { backend, staff, branch, reload } = useStaff();
  const [kind, setKind] = React.useState<ImportKind | null>(null);
  const [step, setStep] = React.useState<Step>("pick");
  const [sheets, setSheets] = React.useState<Record<string, Sheet>>({});
  const [sheetName, setSheetName] = React.useState("");
  const [fileName, setFileName] = React.useState("");
  const [mapping, setMapping] = React.useState<Mapping>({});
  const [cleanups, setCleanups] = React.useState<Cleanup[]>([]);
  const [accepted, setAccepted] = React.useState<Set<string>>(new Set());
  const [review, setReview] = React.useState<ReviewResult | null>(null);
  const [lists, setLists] = React.useState<PriceList[]>([]);
  const [priceListId, setPriceListId] = React.useState("");
  const [result, setResult] = React.useState<Record<string, number> | null>(null);
  const [dryRun, setDryRun] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => { void backend.listPriceLists().then(setLists).catch(() => {}); }, [backend]);

  const sheet = sheets[sheetName];

  /** Read the file in the browser. It never leaves the machine except as the rows that
   *  are actually imported, which matters: this is the shop's whole customer list. */
  const onFile = async (file: File) => {
    setBusy(true);
    setError("");
    try {
      const buf = await file.arrayBuffer();

      // Only a real .xlsx goes through the Excel library, and only then is it loaded —
      // it is the biggest thing on the page, and most of these files are text.
      const loadXlsx = async (bytes: ArrayBuffer): Promise<Grids> => {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(bytes);
        const out: Grids = {};
        wb.eachSheet((ws) => {
          const grid: Grid = [];
          ws.eachRow({ includeEmpty: true }, (row) => {
            const cells: (string | number | null)[] = [];
            row.eachCell({ includeEmpty: true }, (cell) => {
              const v = cell.value;
              cells.push(
                v === null || v === undefined ? null
                : typeof v === "object" && "result" in v ? String((v as { result?: unknown }).result ?? "")
                : typeof v === "object" && "text" in v ? String((v as { text?: unknown }).text ?? "")
                : typeof v === "number" ? v
                : String(v),
              );
            });
            grid.push(cells);
          });
          out[ws.name] = grid;
        });
        return out;
      };

      const grids = await readWorkbook(buf, file.name, loadXlsx);

      const found: Record<string, Sheet> = {};
      for (const [name, grid] of Object.entries(grids)) {
        const sheetRead = readSheet(grid);
        if (sheetRead.rows.length > 0) found[name] = sheetRead;
      }

      if (Object.keys(found).length === 0) {
        setError("That file has no rows this can read. Check it has a header row with column names.");
        return;
      }
      setSheets(found);
      const first = Object.keys(found)[0];
      setSheetName(first);
      setFileName(file.name);

      // The mapping the shop used last time beats a fresh guess.
      const remembered = kind ? await backend.loadImportMapping(kind) : null;
      const guessed = guessMapping(found[first].headers, kind!);
      setMapping(remembered ? { ...guessed, ...remembered } : guessed);
      setStep("map");
    } catch (e) {
      // UnreadableFile already says what to do, so it is shown word for word.
      setError(
        e instanceof UnreadableFile ? e.message
        : e instanceof Error ? `Couldn't read that file: ${e.message}`
        : "Couldn't read that file.",
      );
    } finally {
      setBusy(false);
    }
  };

  const toReview = async () => {
    if (!kind || !sheet) return;
    setBusy(true);
    setError("");
    try {
      const existingKeys = await backend.existingKeys(kind);
      const knownProductCodes = kind === "stock" || kind === "serials"
        ? await backend.existingKeys("products")
        : undefined;

      // Suggest clean-ups only where names are involved.
      const names: string[] = [];
      for (const field of ["category", "brand"]) {
        const header = mapping[field];
        if (header) names.push(...sheet.rows.map((r) => r[header] ?? "").filter((v) => v !== ""));
      }
      const existingNames = (await backend.listCategories()).map((c) => c.name);
      const fixes = names.length > 0 ? suggestCleanups(names, existingNames) : [];
      setCleanups(fixes);
      setAccepted(new Set(fixes.map((f) => f.from)));

      setReview(reviewRows({
        kind, rows: sheet.rows, mapping, existingKeys, knownProductCodes,
        renames: Object.fromEntries(fixes.map((f) => [f.from, f.to])),
      }));
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check the file.");
    } finally {
      setBusy(false);
    }
  };

  /** Re-review whenever the owner unticks a suggested clean-up. */
  const reReview = React.useCallback(async (nextAccepted: Set<string>) => {
    if (!kind || !sheet) return;
    const existingKeys = await backend.existingKeys(kind);
    const knownProductCodes = kind === "stock" || kind === "serials"
      ? await backend.existingKeys("products") : undefined;
    setReview(reviewRows({
      kind, rows: sheet.rows, mapping, existingKeys, knownProductCodes,
      renames: Object.fromEntries(cleanups.filter((f) => nextAccepted.has(f.from)).map((f) => [f.from, f.to])),
    }));
  }, [backend, kind, sheet, mapping, cleanups]);

  const doImport = async () => {
    if (!kind || !review) return;
    setBusy(true);
    setError("");
    try {
      const rows = importableRows(review);
      const counts = await backend.runImport({
        kind, rows, dryRun, fileName,
        branchId: branch.id,
        priceListId: priceListId || lists.find((l) => l.isDefault)?.id,
      });
      if (!dryRun) {
        await backend.saveImportMapping(kind, mapping);
        reload();
      }
      setResult(counts);
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import didn't finish.");
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setKind(null); setStep("pick"); setSheets({}); setSheetName(""); setFileName("");
    setMapping({}); setCleanups([]); setAccepted(new Set()); setReview(null);
    setResult(null); setDryRun(true); setError("");
  };

  // Checked after every hook has run, so the hook order never changes between renders.
  // The database refuses a non-owner anyway; this is so they see why.
  if (staff.role !== "owner") {
    return (
      <Main>
        <h1 className="text-xl font-semibold">Import</h1>
        <p className="text-ink-soft">
          Only the owner can import. It replaces prices and stock figures across the whole
          shop, so it isn&rsquo;t something to do by accident.
        </p>
        <Back />
      </Main>
    );
  }

  return (
    <Main>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Import</h1>
        {kind && <Button variant="ghost" size="sm" onClick={restart}>Start again</Button>}
      </div>

      {kind && <Steps step={step} />}
      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {step === "pick" && (
        <>
          <p className="text-ink-soft">
            Move a shop in from BMS, or from any spreadsheet. Do products first: stock and
            serial numbers are matched to them by code.
          </p>
          <ul className="flex flex-col gap-2">
            {IMPORT_KINDS.map((k) => (
              <li key={k.kind}>
                <button
                  type="button"
                  onClick={() => { setKind(k.kind); setStep("upload"); }}
                  className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 text-left hover:bg-subtle"
                >
                  <FileSpreadsheet className="size-5 shrink-0 text-muted" aria-hidden />
                  <span className="flex flex-col">
                    <span className="font-semibold">{k.label}</span>
                    <span className="text-[13px] text-muted">{k.what}</span>
                    <span className="text-xs text-muted">{k.from}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {step === "upload" && kind && (
        <div className="flex flex-col gap-3">
          <h2 className="font-semibold">Choose the {kindSpec(kind).label.toLowerCase()} file</h2>
          <p className="text-[13px] text-muted">
            An Excel or CSV file — including the .xls that BMS&rsquo;s report viewer saves.
            It&rsquo;s read here on your own computer, and only the rows you confirm are sent
            anywhere.
          </p>
          <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line-strong bg-subtle p-6 text-center">
            <Upload className="size-8 text-line-strong" aria-hidden />
            <span className="font-semibold">{busy ? "Reading…" : "Pick a file"}</span>
            <span className="text-[13px] text-muted">.xlsx, .xls, .csv or .txt</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.txt,.tsv,text/csv,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
            />
          </label>
          <Button variant="outline" className="self-start" onClick={() => setStep("pick")}>Back</Button>
        </div>
      )}

      {step === "map" && kind && sheet && (
        <div className="flex flex-col gap-3">
          <h2 className="font-semibold">Which column is which?</h2>
          <p className="text-[13px] text-muted">
            Found {sheet.rows.length} rows in <span className="code">{fileName}</span>
            {sheet.blankRows > 0 && `, and skipped ${sheet.blankRows} blank row${sheet.blankRows === 1 ? "" : "s"}`}.
            The header row was row {sheet.headerRow + 1}.
          </p>

          {Object.keys(sheets).length > 1 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sheet">Sheet</Label>
              <select
                id="sheet"
                value={sheetName}
                onChange={(e) => {
                  setSheetName(e.target.value);
                  setMapping(guessMapping(sheets[e.target.value].headers, kind));
                }}
                className="h-11 max-w-[320px] rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                {Object.entries(sheets).map(([n, s]) => (
                  <option key={n} value={n}>{n} ({s.rows.length} rows)</option>
                ))}
              </select>
            </div>
          )}

          <ul className="flex flex-col gap-2">
            {kindSpec(kind).fields.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
                <span className="flex min-w-[180px] flex-1 flex-col">
                  <span className="font-semibold">
                    {f.label}
                    {f.required && <span className="font-normal text-muted"> (needed)</span>}
                  </span>
                  {f.hint && <span className="text-xs text-muted">{f.hint}</span>}
                </span>
                <select
                  value={mapping[f.key] ?? ""}
                  onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                  aria-label={`Column for ${f.label}`}
                  className={cn(
                    "h-11 min-w-[200px] rounded-lg border bg-surface px-3 text-base",
                    f.required && !mapping[f.key] ? "border-bad-ink" : "border-line-strong",
                  )}
                >
                  <option value="">Not in this file</option>
                  {sheet.headers.filter((h) => h !== "").map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                {mapping[f.key] && (
                  <span className="min-w-[140px] truncate text-[13px] text-muted">
                    e.g. {sheet.rows[0]?.[mapping[f.key]] || "(empty)"}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {kind === "prices" && lists.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plist">Which price list are these for?</Label>
              <select
                id="plist"
                value={priceListId || lists.find((l) => l.isDefault)?.id || ""}
                onChange={(e) => setPriceListId(e.target.value)}
                className="h-11 max-w-[320px] rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}

          {(kind === "stock" || kind === "serials") && (
            <p className="text-[13px] text-muted">
              These will go into <span className="font-semibold">{branch.name}</span>. Switch
              branch at the top of the screen if that&rsquo;s wrong.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void toReview()}
              disabled={busy || kindSpec(kind).fields.some((f) => f.required && !mapping[f.key])}
            >
              {busy ? "Checking…" : "Check the rows"}
            </Button>
            <Button variant="outline" onClick={() => setStep("upload")}>Back</Button>
          </div>
          {kindSpec(kind).fields.some((f) => f.required && !mapping[f.key]) && (
            <p className="text-[13px] text-warn-ink">
              Every column marked &ldquo;needed&rdquo; has to be matched first.
            </p>
          )}
        </div>
      )}

      {step === "review" && kind && review && (
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold">What will happen</h2>

          <div className="flex flex-wrap gap-2">
            <Tally label="to add" n={review.counts.add} tone="ok" />
            <Tally label="to update" n={review.counts.update} tone="plain" />
            <Tally label="ignored" n={review.counts.skip} tone="plain" />
            <Tally label="with a problem" n={review.counts.problem} tone="bad" />
          </div>

          {cleanups.length > 0 && (
            <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
              <h3 className="font-semibold">Spelling to tidy up</h3>
              <p className="text-[13px] text-muted">
                Untick anything that is actually right. Leaving these ticked keeps the
                shop from ending up with two spellings of the same category.
              </p>
              {cleanups.map((c) => (
                <label key={c.from} className="flex min-h-11 items-center gap-2.5 text-[15px]">
                  <input
                    type="checkbox"
                    checked={accepted.has(c.from)}
                    onChange={(e) => {
                      const next = new Set(accepted);
                      if (e.target.checked) next.add(c.from); else next.delete(c.from);
                      setAccepted(next);
                      void reReview(next);
                    }}
                    className="size-5 accent-[var(--color-brand)]"
                  />
                  <span>
                    <span className="line-through">{c.from}</span> → <span className="font-semibold">{c.to}</span>
                    <span className="text-[13px] text-muted">
                      {" "}· {c.count} row{c.count === 1 ? "" : "s"}, {c.why}
                    </span>
                  </span>
                </label>
              ))}
            </section>
          )}

          {review.counts.problem > 0 && (
            <section className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-bg p-4">
              <h3 className="flex items-center gap-2 font-semibold text-warn-ink">
                <TriangleAlert className="size-4" aria-hidden />
                {review.counts.problem} row{review.counts.problem === 1 ? "" : "s"} can&rsquo;t be imported
              </h3>
              <p className="text-[13px] text-warn-ink">
                The rest will still go in. Fix these in the spreadsheet and import it again
                — re-importing never duplicates anything.
              </p>
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto text-[13px] text-warn-ink">
                {review.rows.filter((r) => r.verdict === "problem").slice(0, 50).map((r) => (
                  <li key={r.line}>Row {r.line}: {r.reason}</li>
                ))}
              </ul>
            </section>
          )}

          {review.counts.skip > 0 && (
            <details className="rounded-xl border border-line bg-surface p-4">
              <summary className="cursor-pointer font-semibold">
                {review.counts.skip} row{review.counts.skip === 1 ? "" : "s"} ignored — why?
              </summary>
              <ul className="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto text-[13px] text-muted">
                {review.rows.filter((r) => r.verdict === "skip").slice(0, 50).map((r) => (
                  <li key={r.line}>Row {r.line}: {r.reason}</li>
                ))}
              </ul>
            </details>
          )}

          <label className="flex min-h-11 items-start gap-2.5 text-[15px]">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="mt-0.5 size-5 accent-[var(--color-brand)]"
            />
            <span className="flex flex-col">
              Practice run
              <span className="text-[13px] text-muted">
                Reports what would happen and writes nothing. Leave it on the first time.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void doImport()} disabled={busy || review.counts.add + review.counts.update === 0}>
              {busy ? "Working…"
                : dryRun ? "Do a practice run"
                : `Import ${review.counts.add + review.counts.update} row${review.counts.add + review.counts.update === 1 ? "" : "s"}`}
            </Button>
            <Button variant="outline" onClick={() => setStep("map")}>Back to the columns</Button>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-semibold text-ok-ink">
            <Check className="size-5" aria-hidden />
            {dryRun ? "Practice run finished" : "Imported"}
          </h2>
          {dryRun && (
            <p className="text-ink-soft">
              Nothing was saved. Untick &ldquo;practice run&rdquo; and do it again for real.
            </p>
          )}
          <ul className="flex flex-col gap-1 text-[15px]">
            {Object.entries(result).map(([k, v]) => (
              <li key={k}>
                <span className="num font-semibold">{v}</span>{" "}
                {k.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {dryRun ? (
              <Button onClick={() => { setDryRun(false); setStep("review"); }}>Do it for real</Button>
            ) : (
              <Button onClick={restart}>Import something else</Button>
            )}
            <Link href="/products" className="inline-flex min-h-11 items-center text-sm underline">
              See the products
            </Link>
          </div>
        </div>
      )}

      <Back />
    </Main>
  );
}

function Main({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {children}
    </main>
  );
}

function Back() {
  return (
    <Link href="/settings" className="inline-flex items-center gap-1.5 self-start pt-2 text-sm text-ink-soft underline">
      <ArrowLeft className="size-4" aria-hidden /> Back to settings
    </Link>
  );
}

const STEP_LABELS: [Step, string][] = [
  ["upload", "File"], ["map", "Columns"], ["review", "Check"], ["done", "Import"],
];

function Steps({ step }: { step: Step }) {
  const order = STEP_LABELS.map(([s]) => s);
  const at = order.indexOf(step);
  return (
    <ol className="flex flex-wrap gap-1 text-[13px]">
      {STEP_LABELS.map(([s, label], i) => (
        <li
          key={s}
          aria-current={s === step ? "step" : undefined}
          className={cn(
            "flex min-h-11 items-center gap-1.5 rounded-lg px-3",
            s === step ? "bg-ok-bg font-semibold text-ok-ink"
            : i < at ? "text-muted" : "text-line-strong",
          )}
        >
          {i < at && <Check className="size-3.5" aria-hidden />}
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

function Tally({ label, n, tone }: { label: string; n: number; tone: "ok" | "bad" | "plain" }) {
  return (
    <span
      className={cn(
        "flex flex-col rounded-lg px-3 py-2",
        tone === "ok" && n > 0 ? "bg-ok-bg text-ok-ink"
        : tone === "bad" && n > 0 ? "bg-warn-bg text-warn-ink"
        : "bg-subtle text-ink-soft",
      )}
    >
      <span className="num text-lg font-bold">{n}</span>
      <span className="text-[13px]">{label}</span>
    </span>
  );
}

