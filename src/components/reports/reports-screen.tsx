"use client";

import * as React from "react";
import {
  Check, FileSpreadsheet, Lock, LockOpen, Pencil, Search, TriangleAlert,
} from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { REGISTERS, notYetBecause } from "@/lib/reports";
import { dhakaDate } from "@/lib/sale";
import { download, journalToCsv, journalToTallyXml } from "@/lib/reports-export";
import type {
  ChartAccount, PeriodLock, Product, ReportFilters, ReportListItem, ReportRegisterKey,
  ReportResult,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { ReportView } from "./report-view";

/**
 * The reports.
 *
 * BMS has nine register screens with a hundred-odd printouts between them, and the
 * thing that makes them hard to use is not the number: it is that each one is its own
 * screen with its own filters in a different place. Here there is one screen — pick the
 * register, pick the report, set the dates, read it — and every report prints and
 * exports the same way, because they all come back in the same shape.
 */
export function ReportsScreen() {
  const { backend, branch, branches, staff } = useStaff();
  const [list, setList] = React.useState<ReportListItem[] | null>(null);
  const [register, setRegister] = React.useState<ReportRegisterKey>("sales");
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState<ReportListItem | null>(null);
  const [report, setReport] = React.useState<ReportResult | null>(null);
  const [error, setError] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // The month so far, which is what somebody opening this screen almost always wants.
  const today = dhakaDate(new Date().toISOString());
  const [from, setFrom] = React.useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = React.useState(today);
  const [asOn, setAsOn] = React.useState(today);
  const [branchId, setBranchId] = React.useState<string | null>(branch.id);
  const [accountId, setAccountId] = React.useState("");
  const [productId, setProductId] = React.useState("");
  const [accounts, setAccounts] = React.useState<ChartAccount[]>([]);
  const [products, setProducts] = React.useState<Product[]>([]);

  const say = (e: unknown) => setError(e instanceof Error ? e.message : "That didn't work.");

  React.useEffect(() => {
    backend.listReports().then(setList).catch(say);
  }, [backend]);

  const run = React.useCallback(async (item: ReportListItem, extra: ReportFilters = {}) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const filters: ReportFilters = {
        branchId, from, to, asOn,
        accountId: accountId || null,
        productId: productId || null,
        ...extra,
      };
      setReport(await backend.runReport(item.key, filters));
    } catch (e) {
      setReport(null);
      say(e);
    } finally {
      setBusy(false);
    }
  }, [backend, branchId, from, to, asOn, accountId, productId]);

  // The pickers, loaded only when a report actually asks for one.
  const pick = async (item: ReportListItem) => {
    setPicked(item);
    setReport(null);
    setError("");
    if (needsAccount(item.key) && accounts.length === 0) {
      backend.chartOfAccounts().then(setAccounts).catch(() => setAccounts([]));
    }
    if (needsProduct(item.key) && products.length === 0) {
      backend.listProducts(branch.id).then(setProducts).catch(() => setProducts([]));
    }
    if (!needsAccount(item.key) && !needsProduct(item.key)) await run(item);
  };

  const shown = (list ?? [])
    .filter((r) => (query
      ? `${r.key} ${r.title} ${r.note ?? ""}`.toLowerCase().includes(query.toLowerCase())
      : r.register === register));

  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="no-print">
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-[13px] text-muted">
          Every register BMS prints, and a few it hasn&rsquo;t got. Each one prints, goes
          to Excel, or saves as a PDF.
        </p>
      </div>

      <div className="no-print flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every report"
            aria-label="Search every report"
            className="pl-9"
          />
        </div>
        {!query && REGISTERS.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRegister(r.key)}
            aria-current={register === r.key ? "page" : undefined}
            className={cn(
              "min-h-[44px] shrink-0 rounded-xl px-3 text-[15px]",
              register === r.key ? "bg-ink text-white" : "bg-subtle text-ink-soft hover:bg-line")}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="no-print text-bad-ink">{error}</p>}
      {note && (
        <p className="no-print flex items-center gap-2 rounded-xl border border-good-ink/30 bg-good-bg p-3 text-[15px] text-good-ink">
          <Check className="size-5 shrink-0" aria-hidden />
          {note}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="no-print flex flex-col gap-3">
          {!query && (
            <p className="text-[13px] text-muted">
              {REGISTERS.find((r) => r.key === register)?.note}
            </p>
          )}
          <ul className="flex flex-col gap-1">
            {(list === null) && <li className="text-[15px] text-muted">Loading…</li>}
            {shown.map((r) => (
              <li key={r.key}>
                <button
                  type="button"
                  disabled={!r.allowed}
                  onClick={() => pick(r)}
                  aria-current={picked?.key === r.key ? "true" : undefined}
                  className={cn(
                    "w-full rounded-xl border p-3 text-left text-[15px]",
                    picked?.key === r.key
                      ? "border-ink bg-subtle"
                      : "border-line hover:bg-subtle",
                    !r.allowed && "cursor-not-allowed opacity-60")}
                >
                  <span className="flex items-center gap-2">
                    <span className="code text-[12px] text-muted">{r.key}</span>
                    <span className="font-medium">{r.title}</span>
                  </span>
                  {!r.allowed && r.needs && (
                    <span className="mt-1 block text-[13px] text-muted">
                      {notYetBecause(r.needs as "P14a" | "P14c" | "later")}
                    </span>
                  )}
                  {!r.allowed && !r.needs && (
                    <span className="mt-1 block text-[13px] text-muted">
                      Shows cost or profit, which you are not allowed to see.
                    </span>
                  )}
                </button>
              </li>
            ))}
            {list !== null && shown.length === 0 && (
              <li className="text-[15px] text-muted">
                Nothing matches &ldquo;{query}&rdquo;.
              </li>
            )}
          </ul>

          {staff.role === "owner" && <ClosingCard onFail={say} onDone={setNote} />}
          {staff.role === "owner" && <AccountantCard onFail={say} />}
        </div>

        <div className="flex flex-col gap-4">
          {picked && (
            <div className="no-print flex flex-wrap items-end gap-3 rounded-xl border border-line bg-white p-4">
              {picked.dateMode === "range" && (
                <>
                  <Field label="From">
                    <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                  </Field>
                  <Field label="To">
                    <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                  </Field>
                </>
              )}
              {picked.dateMode === "as_on" && (
                <Field label="As on">
                  <Input type="date" value={asOn} onChange={(e) => setAsOn(e.target.value)} />
                </Field>
              )}
              <Field label="Which branch">
                <select
                  value={branchId ?? ""}
                  onChange={(e) => setBranchId(e.target.value || null)}
                  className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-[15px]"
                >
                  <option value="">Every branch</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </Field>
              {needsAccount(picked.key) && (
                <Field label="Which account">
                  <select
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    className="min-h-[44px] max-w-[260px] rounded-xl border border-line bg-white px-3 text-[15px]"
                  >
                    <option value="">Pick one</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              {needsProduct(picked.key) && (
                <Field label="Which product">
                  <select
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                    className="min-h-[44px] max-w-[260px] rounded-xl border border-line bg-white px-3 text-[15px]"
                  >
                    <option value="">Pick one</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Button onClick={() => run(picked)} disabled={busy}>
                {busy ? "Working it out…" : "Show it"}
              </Button>
              {staff.role === "owner" && report && (
                <RenameButton
                  item={picked}
                  onDone={(words) => {
                    setNote(words);
                    backend.listReports().then(setList).catch(say);
                    run(picked);
                  }}
                  onFail={say}
                />
              )}
            </div>
          )}

          {!picked && (
            <p className="no-print rounded-xl border border-dashed border-line p-6 text-[15px] text-muted">
              Pick a report on the left. There are {list?.length ?? 0} of them; the search
              box takes a name or a code like <span className="code">A-8</span>.
            </p>
          )}

          {report && (
            <ReportView
              report={report}
              onDrill={(field, value) => {
                // Tapping a line opens the thing behind it: an account's ledger, or one
                // product's stock history. A number nobody can open is a number you have
                // to take on trust, which is the whole complaint about BMS.
                if (field === "account_id") {
                  const ledger = (list ?? []).find((r) => r.key === "A-3");
                  if (!ledger) return;
                  setAccountId(value);
                  setPicked(ledger);
                  run(ledger, { accountId: value });
                } else if (field === "product_id") {
                  const ledger = (list ?? []).find((r) => r.key === "ST-7");
                  if (!ledger) return;
                  setProductId(value);
                  setPicked(ledger);
                  run(ledger, { productId: value });
                }
              }}
            />
          )}
        </div>
      </div>
    </main>
  );
}

const needsAccount = (key: string): boolean => key === "A-3";
const needsProduct = (key: string): boolean =>
  key === "ST-7" || key === "ST-14" || key === "ST-19";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[13px] text-muted">
      {label}
      {children}
    </label>
  );
}

/** Renaming a report, which BMS calls "Customising Report Caption". */
function RenameButton({ item, onDone, onFail }: {
  item: ReportListItem;
  onDone: (words: string) => void;
  onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState(item.title);

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => { setOpen(true); setTitle(item.title); }}>
        <Pencil className="size-4" aria-hidden /> Rename it
      </Button>
    );
  }
  return (
    <div className="flex items-end gap-2">
      <Field label="Call this report">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Button
        onClick={async () => {
          try {
            await backend.saveReportSetting(item.key, { title });
            setOpen(false);
            onDone(`${item.key} is now called “${title}”.`);
          } catch (e) { onFail(e); }
        }}
      >
        Save
      </Button>
      <Button
        variant="ghost"
        onClick={async () => {
          try {
            await backend.saveReportSetting(item.key, { reset: true });
            setOpen(false);
            onDone(`${item.key} is back to its own name.`);
          } catch (e) { onFail(e); }
        }}
      >
        Use the original
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
}

/**
 * Closing a month (BMS's "Transaction Lock").
 *
 * Once the figures have gone to the accountant, nothing in that month may change: a
 * September sale voided in October makes every report printed since then wrong, and
 * nobody finds out. Opening a month again needs a reason, and the reason is kept.
 */
function ClosingCard({ onDone, onFail }: {
  onDone: (words: string) => void;
  onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [locks, setLocks] = React.useState<PeriodLock[]>([]);
  const [month, setMonth] = React.useState(lastMonth());
  const [why, setWhy] = React.useState("");
  const [opening, setOpening] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    backend.listPeriodLocks().then(setLocks).catch(() => setLocks([]));
  }, [backend]);
  React.useEffect(load, [load]);

  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <h2 className="flex items-center gap-2 font-semibold">
        <Lock className="size-4" aria-hidden /> Closing the books
      </h2>
      <p className="mt-1 text-[13px] text-muted">
        Once a month is closed, nothing dated in it can be added, changed, voided or
        returned until you open it again.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Month">
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
        <Button
          onClick={async () => {
            try {
              await backend.lockPeriod(`${month}-01`, true, null);
              load();
              onDone(`${month} is closed.`);
            } catch (e) { onFail(e); }
          }}
        >
          Close it
        </Button>
      </div>

      {locks.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {locks.map((l) => (
            <li key={l.month} className="rounded-xl bg-subtle p-3 text-[14px]">
              <p className="font-medium">{monthWords(l.month)} is closed</p>
              <p className="text-[13px] text-muted">
                {l.who}, {new Date(l.at).toLocaleDateString("en-GB")}
                {l.note ? ` · ${l.note}` : ""}
              </p>
              {opening === l.month ? (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Field label="Why open it again?">
                    <Input
                      value={why}
                      onChange={(e) => setWhy(e.target.value)}
                      placeholder="The accountant found a missing bill"
                    />
                  </Field>
                  <Button
                    onClick={async () => {
                      try {
                        await backend.lockPeriod(l.month, false, why);
                        setOpening(null);
                        setWhy("");
                        load();
                        onDone(`${monthWords(l.month)} is open again, and that is on the record.`);
                      } catch (e) { onFail(e); }
                    }}
                  >
                    Open it
                  </Button>
                  <Button variant="ghost" onClick={() => setOpening(null)}>Cancel</Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  className="mt-1"
                  onClick={() => { setOpening(l.month); setWhy(""); }}
                >
                  <LockOpen className="size-4" aria-hidden /> Open it again
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The journal itself, for whoever does the shop's tax return. */
function AccountantCard({ onFail }: { onFail: (e: unknown) => void }) {
  const { backend } = useStaff();
  const today = dhakaDate(new Date().toISOString());
  const [from, setFrom] = React.useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = React.useState(today);
  const [busy, setBusy] = React.useState(false);

  const get = async (kind: "csv" | "tally") => {
    setBusy(true);
    try {
      const x = await backend.journalExport(from, to, null);
      if (kind === "csv") {
        download(`journal_${from}_${to}.csv`, journalToCsv(x), "text/csv");
      } else {
        download(`journal_${from}_${to}.xml`, journalToTallyXml(x), "application/xml");
      }
    } catch (e) { onFail(e); } finally { setBusy(false); }
  };

  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <h2 className="flex items-center gap-2 font-semibold">
        <FileSpreadsheet className="size-4" aria-hidden /> For the accountant
      </h2>
      <p className="mt-1 text-[13px] text-muted">
        Every entry on the books, as a spreadsheet or as a Tally import.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button variant="outline" onClick={() => get("csv")} disabled={busy}>CSV</Button>
        <Button variant="ghost" onClick={() => get("tally")} disabled={busy}>Tally XML</Button>
      </div>
      <p className="mt-2 flex items-start gap-2 text-[13px] text-muted">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        Tally only accepts a voucher whose ledger names match its own exactly. Import one
        voucher first, fix the names, then import the rest.
      </p>
    </section>
  );
}

function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthWords(month: string): string {
  const [y, m] = month.split("-");
  return `${new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-GB", { month: "long" })} ${y}`;
}
