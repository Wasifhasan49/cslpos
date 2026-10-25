"use client";

import * as React from "react";
import { Check, ScanBarcode, Trash2, TriangleAlert, X } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatTaka, searchProducts } from "@/lib/sale";
import { checkSerials, expandSerialRange, generateSerials, parseSerialList } from "@/lib/serials";
import type {
  CountDifference, GoodsReceivedRow, Product, StockMovementRow, StockReason, Supplier,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Tab = "receive" | "correct" | "count" | "history";

const TABS: { key: Tab; label: string }[] = [
  { key: "receive", label: "Goods in" },
  { key: "correct", label: "Corrections" },
  { key: "count", label: "Stock count" },
  { key: "history", label: "History" },
];

const REASONS: { value: StockReason; label: string }[] = [
  { value: "damaged", label: "Damaged" },
  { value: "lost", label: "Lost or missing" },
  { value: "found_in_count", label: "Found in a count" },
  { value: "internal_use", label: "Used by the shop" },
  { value: "expired", label: "Expired" },
  { value: "other", label: "Other" },
];

const REASON_LABEL: Record<string, string> = {
  purchase: "Received", sale: "Sold", return: "Customer return",
  adjust_in: "Correction up", adjust_out: "Correction down",
  return_to_supplier: "Returned to supplier", transfer_in: "Transferred in",
  transfer_out: "Transferred out", count: "Stock count",
};

export function StockScreen() {
  const { backend, branch, staff } = useStaff();
  const [tab, setTab] = React.useState<Tab>("receive");
  const [products, setProducts] = React.useState<Product[]>([]);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, s] = await Promise.all([
          backend.listProducts(branch.id),
          backend.listSuppliers().catch(() => [] as Supplier[]),
        ]);
        if (cancelled) return;
        setProducts(p);
        setSuppliers(s);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the stock.");
      }
    })();
    return () => { cancelled = true; };
  }, [backend, branch.id, nonce]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
    finally { setBusy(false); }
  };

  if (staff.role === "cashier") {
    return (
      <Main>
        <h1 className="text-xl font-semibold">Stock</h1>
        <p className="text-ink-soft">
          Receiving goods and correcting stock is for managers and owners. Ask the owner
          if you need to do it.
        </p>
      </Main>
    );
  }

  return (
    <Main>
      <div>
        <h1 className="text-xl font-semibold">Stock</h1>
        <p className="text-[13px] text-muted">{branch.name}</p>
      </div>

      <nav aria-label="Stock sections" className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn(
              "min-h-11 whitespace-nowrap border-b-2 px-3 text-sm font-medium",
              tab === t.key ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {tab === "receive" && (
        <ReceiveGoods products={products} suppliers={suppliers} busy={busy} run={run} />
      )}
      {tab === "correct" && <Corrections products={products} busy={busy} run={run} />}
      {tab === "count" && <StockCount products={products} busy={busy} run={run} />}
      {tab === "history" && <History products={products} />}
    </Main>
  );
}

function Main({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {children}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Goods in
// ---------------------------------------------------------------------------

interface DraftLine {
  productId: string;
  qty: string;
  unitCost: string;
  serials: string[];
}

function ReceiveGoods({
  products, suppliers, busy, run,
}: {
  products: Product[];
  suppliers: Supplier[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch } = useStaff();
  const [lines, setLines] = React.useState<DraftLine[]>([]);
  const [query, setQuery] = React.useState("");
  const [supplierId, setSupplierId] = React.useState("");
  const [invoiceNo, setInvoiceNo] = React.useState("");
  const [isCredit, setIsCredit] = React.useState(false);
  const [discount, setDiscount] = React.useState("");
  const [extraCosts, setExtraCosts] = React.useState("");
  const [payAmount, setPayAmount] = React.useState("");
  const [payMethod, setPayMethod] = React.useState("cash");
  const [payRef, setPayRef] = React.useState("");
  const [done, setDone] = React.useState<{ grnNo: string; total: number; due: number | null; costMissing: boolean } | null>(null);
  const [recent, setRecent] = React.useState<GoodsReceivedRow[]>([]);

  React.useEffect(() => {
    void backend.listGoodsReceived(branch.id, 10).then(setRecent).catch(() => {});
  }, [backend, branch.id, done]);

  const byId = new Map(products.map((p) => [p.id, p]));
  const results = searchProducts(products, query, null).slice(0, 8);

  const add = (p: Product) => {
    if (lines.some((l) => l.productId === p.id)) return;
    setLines([...lines, { productId: p.id, qty: "1", unitCost: "", serials: [] }]);
    setQuery("");
  };

  const subtotal = lines.reduce((sum, l) => {
    const p = byId.get(l.productId);
    const qty = p?.isSerial ? l.serials.length : Number(l.qty) || 0;
    return sum + (Number(l.unitCost) || 0) * qty;
  }, 0);
  const total = Math.max(subtotal - (Number(discount) || 0), 0) + (Number(extraCosts) || 0);

  const supplier = suppliers.find((s) => s.id === supplierId);
  const blocker = (): string | null => {
    if (lines.length === 0) return "Add what came in.";
    for (const l of lines) {
      const p = byId.get(l.productId);
      if (!p) continue;
      if (p.isSerial && l.serials.length === 0) return `Scan the serial numbers for ${p.name}.`;
      if (!p.isSerial && (Number(l.qty) || 0) <= 0) return `How many ${p.name}?`;
    }
    if (isCredit && !supplierId) return "A credit purchase needs a supplier.";
    if (isCredit && supplier?.isCashOnly) return `${supplier.name} is cash only, so they can't be owed anything.`;
    if (Number(payAmount) > 0 && !supplierId) return "Pick who is being paid.";
    return null;
  };
  const stop = blocker();

  if (done) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <h2 className="flex items-center gap-2 font-semibold text-ok-ink">
          <Check className="size-5" aria-hidden /> Received as {done.grnNo}
        </h2>
        <p className="num text-lg font-bold">{formatTaka(done.total)}</p>
        {done.costMissing && (
          <p className="flex items-start gap-2 text-[13px] text-warn-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Some lines have no cost yet. They&rsquo;re marked &ldquo;cost missing&rdquo; until
            you fill them in, because stock with no cost reports endless profit.
          </p>
        )}
        {done.due != null && (
          <p className="text-[15px]">
            Owed to {supplier?.name ?? "the supplier"} now:{" "}
            <span className="num font-semibold">{formatTaka(done.due)}</span>
          </p>
        )}
        <Button
          className="self-start"
          onClick={() => {
            setDone(null); setLines([]); setInvoiceNo(""); setDiscount("");
            setExtraCosts(""); setPayAmount(""); setPayRef(""); setIsCredit(false);
          }}
        >
          Receive something else
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <div className="flex-[2_1_220px]">
          <Field label="Supplier" hint="Leave empty for a one-off purchase with no paperwork.">
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">No supplier</option>
              {suppliers.filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.isCashOnly ? " (cash only)" : ""}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex-[1_1_160px]">
          <Field label="Their invoice number">
            <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="code" />
          </Field>
        </div>
      </div>

      <label className="flex min-h-11 items-start gap-2.5 text-[15px]">
        <input
          type="checkbox" checked={isCredit}
          onChange={(e) => setIsCredit(e.target.checked)}
          className="mt-0.5 size-5 accent-[var(--color-brand)]"
        />
        <span className="flex flex-col">
          On credit
          <span className="text-[13px] text-muted">
            Adds it to what the shop owes this supplier. Leave off if it is paid for.
          </span>
        </span>
      </label>

      {/* Same one-box search as the counter, so nobody has to learn a second way. */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recv-search">What came in?</Label>
        <Input
          id="recv-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Scan a barcode, or type a name or code"
          className="h-12"
        />
        {query.trim() !== "" && (
          <ul className="flex flex-col gap-1">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => add(p)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 text-left hover:bg-subtle"
                >
                  <span>
                    {p.name} <span className="code text-[13px] text-muted">{p.code}</span>
                  </span>
                  <span className="text-[13px] text-muted">{p.stock} in stock here</span>
                </button>
              </li>
            ))}
            {results.length === 0 && <li className="text-[13px] text-muted">Nothing matches.</li>}
          </ul>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {lines.map((l) => {
          const p = byId.get(l.productId);
          if (!p) return null;
          return (
            <li key={l.productId} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="flex flex-col">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-[13px] text-muted">
                    <span className="code">{p.code}</span> · {p.stock} in stock here
                  </span>
                </span>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>

              <div className="flex flex-wrap gap-3">
                {!p.isSerial && (
                  <div className="flex-[1_1_120px]">
                    <Field label="How many">
                      <Input
                        inputMode="numeric" value={l.qty} className="num"
                        onChange={(e) => setLines(lines.map((x) =>
                          x.productId === l.productId ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x))}
                      />
                    </Field>
                  </div>
                )}
                <div className="flex-[1_1_140px]">
                  <Field label="Cost each" hint="Leave empty if the invoice hasn't come yet.">
                    <Input
                      inputMode="decimal" value={l.unitCost} className="num"
                      onChange={(e) => setLines(lines.map((x) =>
                        x.productId === l.productId ? { ...x, unitCost: e.target.value.replace(/[^0-9.]/g, "") } : x))}
                    />
                  </Field>
                </div>
              </div>

              {p.isSerial && (
                <SerialEntry
                  product={p}
                  serials={l.serials}
                  otherSerials={lines.filter((x) => x.productId !== l.productId).flatMap((x) => x.serials)}
                  onChange={(serials) => setLines(lines.map((x) =>
                    x.productId === l.productId ? { ...x, serials } : x))}
                />
              )}
            </li>
          );
        })}
      </ul>

      {lines.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap gap-3">
            <div className="flex-[1_1_140px]">
              <Field label="Discount on the whole lot">
                <Input inputMode="decimal" value={discount} className="num"
                  onChange={(e) => setDiscount(e.target.value.replace(/[^0-9.]/g, ""))} />
              </Field>
            </div>
            <div className="flex-[1_1_140px]">
              <Field label="Transport, labour" hint="Spread across the lines by value, so a laptop carries more than an adapter.">
                <Input inputMode="decimal" value={extraCosts} className="num"
                  onChange={(e) => setExtraCosts(e.target.value.replace(/[^0-9.]/g, ""))} />
              </Field>
            </div>
          </div>

          <div className="flex items-baseline justify-between border-t border-subtle pt-3 text-lg font-bold">
            <span>Total</span><span className="num">{formatTaka(total)}</span>
          </div>

          {supplierId && (
            <div className="flex flex-wrap items-end gap-3 border-t border-subtle pt-3">
              <div className="flex-[1_1_140px]">
                <Field label="Pay now" hint="Full or part. Leave empty to pay later.">
                  <Input inputMode="decimal" value={payAmount} className="num"
                    onChange={(e) => setPayAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
                </Field>
              </div>
              {Number(payAmount) > 0 && (
                <>
                  <div className="flex-[1_1_140px]">
                    <Field label="How">
                      <select
                        value={payMethod}
                        onChange={(e) => setPayMethod(e.target.value)}
                        className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                      >
                        {["cash", "bank", "bkash", "nagad", "cheque", "card"].map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="flex-[1_1_160px]">
                    <Field label="Reference">
                      <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} className="num" />
                    </Field>
                  </div>
                </>
              )}
            </div>
          )}

          <Button
            size="lg"
            disabled={busy || Boolean(stop)}
            onClick={() => run(async () => {
              const res = await backend.receiveGoods({
                branchId: branch.id,
                lines: lines.map((l) => {
                  const p = byId.get(l.productId)!;
                  return {
                    productId: l.productId,
                    qty: p.isSerial ? l.serials.length : Number(l.qty) || 0,
                    unitCost: l.unitCost === "" ? null : Number(l.unitCost),
                    serials: p.isSerial ? l.serials : undefined,
                  };
                }),
                supplierId: supplierId || null,
                supplierInvoiceNo: invoiceNo || null,
                isCredit,
                discount: Number(discount) || 0,
                extraCosts: Number(extraCosts) || 0,
                payAmount: Number(payAmount) || null,
                payMethod: Number(payAmount) > 0 ? payMethod : null,
                payReference: payRef || null,
              });
              setDone({ grnNo: res.grnNo, total: res.total, due: res.supplierDue, costMissing: res.costMissing });
            })}
          >
            {busy ? "Saving…" : `Receive · ${formatTaka(total)}`}
          </Button>
          {stop && <p className="text-center text-[13px] text-warn-ink">{stop}</p>}
        </div>
      )}

      {recent.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="pt-2 font-semibold">Recent deliveries</h2>
          <ul className="flex flex-col gap-1.5">
            {recent.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2">
                <span className="code text-[13px]">{g.grnNo}</span>
                <span className="flex-1 text-[15px]">
                  {g.supplierName ?? "No supplier"}
                  {g.supplierInvoiceNo && <span className="text-[13px] text-muted"> · {g.supplierInvoiceNo}</span>}
                </span>
                {g.costMissing && <span className="text-[13px] font-semibold text-warn-ink">cost missing</span>}
                {g.isCredit && <span className="text-[13px] text-muted">on credit</span>}
                <span className="num font-semibold">{formatTaka(g.total)}</span>
              </li>
            ))}
          </ul>
          <MissingCosts recent={recent} busy={busy} run={run} />
        </section>
      )}
    </div>
  );
}

/** Fill in the costs of a "receive now, price later" delivery once the invoice arrives. */
function MissingCosts({
  recent, busy, run,
}: {
  recent: GoodsReceivedRow[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend } = useStaff();
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const open = recent.filter((g) => g.costMissing);
  if (open.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-bg p-4">
      <h3 className="font-semibold text-warn-ink">Costs still to fill in</h3>
      <p className="text-[13px] text-warn-ink">
        These came in before the invoice did. Until a cost is set, the margin on them is
        meaningless.
      </p>
      {open.flatMap((g) => g.lines.filter((l) => l.unitCost == null).map((l) => (
        <form
          key={l.id}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => backend.amendGrnCost(l.id, Number(drafts[l.id]) || 0));
          }}
        >
          <span className="flex-1 text-[15px]">
            <span className="code text-[13px]">{g.grnNo}</span> {l.product} × {l.qty}
          </span>
          <Input
            inputMode="decimal"
            value={drafts[l.id] ?? ""}
            onChange={(e) => setDrafts({ ...drafts, [l.id]: e.target.value.replace(/[^0-9.]/g, "") })}
            placeholder="Cost each"
            aria-label={`Cost each for ${l.product}`}
            className="num h-11 w-32"
          />
          <Button type="submit" variant="outline" className="h-11" disabled={busy || !drafts[l.id]}>
            Save
          </Button>
        </form>
      )))}
    </div>
  );
}

/**
 * Getting serials in without typing each one: scan them (the scanner sends Enter),
 * paste a block, give a sequential range, or make them up for items that came with none.
 */
function SerialEntry({
  product, serials, otherSerials, onChange,
}: {
  product: Product;
  serials: string[];
  otherSerials: string[];
  onChange: (serials: string[]) => void;
}) {
  const [one, setOne] = React.useState("");
  const [paste, setPaste] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [mode, setMode] = React.useState<"scan" | "paste" | "range" | "make">("scan");
  const [problems, setProblems] = React.useState<{ serial: string; why: string }[]>([]);

  const accept = (incoming: string[]) => {
    const r = checkSerials(incoming, {
      alreadyHere: [...serials, ...otherSerials],
      expectedLength: null,
    });
    setProblems(r.problems);
    if (r.serials.length > 0) onChange([...serials, ...r.serials]);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-subtle pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label>Serial numbers</Label>
        <span className="num text-[13px] text-muted">{serials.length} scanned</span>
        <span className="flex gap-1">
          {([["scan", "Scan"], ["paste", "Paste"], ["range", "Range"], ["make", "Make up"]] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "min-h-11 rounded-lg px-2.5 text-[13px]",
                mode === m ? "border-2 border-brand bg-ok-bg font-semibold text-ok-ink"
                  : "border border-line hover:bg-subtle",
              )}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      {mode === "scan" && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); accept([one]); setOne(""); }}
        >
          <ScanBarcode className="size-5 text-muted" aria-hidden />
          <Input
            autoFocus
            value={one}
            onChange={(e) => setOne(e.target.value)}
            placeholder="Scan or type, then Enter"
            aria-label={`Scan a serial for ${product.name}`}
            className="code h-11 max-w-[280px] flex-1"
          />
          <Button type="submit" variant="outline" className="h-11" disabled={one.trim() === ""}>Add</Button>
        </form>
      )}

      {mode === "paste" && (
        <div className="flex flex-col gap-2">
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={3}
            aria-label={`Paste serials for ${product.name}`}
            placeholder="One a line, or separated by commas"
            className="code w-full rounded-lg border border-line-strong bg-surface p-3 text-base"
          />
          <Button
            variant="outline" className="h-11 self-start"
            onClick={() => { accept(parseSerialList(paste)); setPaste(""); }}
            disabled={paste.trim() === ""}
          >
            Add these
          </Button>
        </div>
      )}

      {mode === "range" && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const r = expandSerialRange(from, to);
            if (r.problems.length > 0) { setProblems(r.problems); return; }
            accept(r.serials);
            setFrom(""); setTo("");
          }}
        >
          <Field label="First">
            <Input value={from} onChange={(e) => setFrom(e.target.value)} className="code h-11 w-40" />
          </Field>
          <Field label="Last">
            <Input value={to} onChange={(e) => setTo(e.target.value)} className="code h-11 w-40" />
          </Field>
          <Button type="submit" variant="outline" className="h-11" disabled={!from.trim() || !to.trim()}>
            Add the range
          </Button>
          <span className="w-full text-xs text-muted">
            For serials that run in order, like SN0098 to SN0102. The padding is kept.
          </span>
        </form>
      )}

      {mode === "make" && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="How many">
            <Input
              id="make-count" inputMode="numeric" defaultValue="1"
              aria-label="How many serials to make up"
              className="num h-11 w-24"
            />
          </Field>
          <Button
            variant="outline" className="h-11"
            onClick={() => {
              const el = document.getElementById("make-count") as HTMLInputElement | null;
              const n = Number(el?.value) || 0;
              accept(generateSerials(product.code, n, serials.length + 1));
            }}
          >
            Make them up
          </Button>
          <span className="w-full text-xs text-muted">
            For items that arrived with no serial of their own. They are marked as the
            shop&rsquo;s own so nobody mistakes one for the maker&rsquo;s.
          </span>
        </div>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-0.5 text-[13px] text-bad-ink">
          {problems.map((p) => <li key={p.serial}><span className="code">{p.serial}</span>: {p.why}</li>)}
        </ul>
      )}

      {serials.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {serials.map((s) => (
            <li key={s} className="flex items-center gap-1 rounded-lg bg-subtle px-2 py-1 text-[13px]">
              <span className="code">{s}</span>
              <button
                type="button"
                onClick={() => onChange(serials.filter((x) => x !== s))}
                aria-label={`Remove ${s}`}
                className="flex size-6 items-center justify-center rounded text-muted hover:bg-line"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

function Corrections({
  products, busy, run,
}: {
  products: Product[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch } = useStaff();
  const [query, setQuery] = React.useState("");
  const [productId, setProductId] = React.useState("");
  const [direction, setDirection] = React.useState<"down" | "up">("down");
  const [qty, setQty] = React.useState("1");
  const [reason, setReason] = React.useState<StockReason>("damaged");
  const [note, setNote] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);

  const product = products.find((p) => p.id === productId);
  const results = searchProducts(products, query, null).slice(0, 8);
  const change = (direction === "up" ? 1 : -1) * (Number(qty) || 0);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted">
        Put stock up or down when the shelf and the computer disagree. The reason is
        required, so the owner can tell damage from theft.
      </p>

      {!product ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="corr-search">Which product?</Label>
          <Input
            id="corr-search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Scan a barcode, or type a name or code" className="h-12"
          />
          <ul className="flex flex-col gap-1">
            {query.trim() !== "" && results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => { setProductId(p.id); setQuery(""); setPicked([]); }}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 text-left hover:bg-subtle"
                >
                  <span>{p.name} <span className="code text-[13px] text-muted">{p.code}</span></span>
                  <span className="text-[13px] text-muted">{p.stock} here</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <div className="flex items-start justify-between gap-2">
            <span className="flex flex-col">
              <span className="font-semibold">{product.name}</span>
              <span className="text-[13px] text-muted">
                <span className="code">{product.code}</span> · {product.stock} in stock here
              </span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => { setProductId(""); setPicked([]); }}>
              <X className="size-4" aria-hidden />
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {(["down", "up"] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={direction === d}
                onClick={() => setDirection(d)}
                className={cn(
                  "min-h-11 flex-1 rounded-lg px-3 text-[15px] font-semibold",
                  direction === d ? "border-2 border-brand bg-ok-bg text-ok-ink"
                    : "border border-line hover:bg-subtle",
                )}
              >
                {d === "down" ? "Take off the shelf" : "Put on the shelf"}
              </button>
            ))}
          </div>

          {product.isSerial ? (
            direction === "down" ? (
              <div className="flex flex-col gap-1.5">
                <Label>Which units?</Label>
                <ul className="flex flex-wrap gap-1.5">
                  {product.serials.map((s) => {
                    const on = picked.includes(s.id);
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          aria-pressed={on}
                          onClick={() => setPicked(on ? picked.filter((x) => x !== s.id) : [...picked, s.id])}
                          className={cn(
                            "code min-h-11 rounded-lg px-2.5 text-[13px]",
                            on ? "border-2 border-brand bg-ok-bg font-semibold text-ok-ink"
                              : "border border-line hover:bg-subtle",
                          )}
                        >
                          {s.serial}
                        </button>
                      </li>
                    );
                  })}
                  {product.serials.length === 0 && (
                    <li className="text-[13px] text-muted">None in stock here.</li>
                  )}
                </ul>
              </div>
            ) : (
              <SerialEntry
                product={product}
                serials={picked}
                otherSerials={[]}
                onChange={setPicked}
              />
            )
          ) : (
            <Field label="How many">
              <Input
                inputMode="numeric" value={qty} className="num h-11 w-28"
                onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
          )}

          <Field label="Why">
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as StockReason)}
              className="h-11 w-full max-w-[280px] rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>

          <Field
            label="What happened"
            hint={reason === "other" ? "Needed, because the reason is Other." : "Optional."}
          >
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          <Button
            disabled={busy
              || (reason === "other" && note.trim() === "")
              || (product.isSerial ? picked.length === 0 : (Number(qty) || 0) <= 0)}
            onClick={() => run(async () => {
              const amount = product.isSerial ? picked.length : Number(qty) || 0;
              await backend.correctStock({
                branchId: branch.id,
                productId: product.id,
                change: (direction === "up" ? 1 : -1) * amount,
                reason,
                note: note || null,
                serials: product.isSerial ? picked : undefined,
              });
              setProductId(""); setPicked([]); setNote(""); setQty("1");
            })}
          >
            {busy ? "Saving…"
              : `${direction === "up" ? "Add" : "Remove"} ${product.isSerial ? picked.length : qty || 0}`}
          </Button>
          {!product.isSerial && (
            <p className="text-[13px] text-muted">
              {product.stock} → {Math.max(product.stock + change, 0)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stock count
// ---------------------------------------------------------------------------

function StockCount({
  products, busy, run,
}: {
  products: Product[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch } = useStaff();
  const [counted, setCounted] = React.useState<Record<string, string>>({});
  const [preview, setPreview] = React.useState<{ corrected: number; alreadyRight: number; differences: CountDifference[] } | null>(null);
  const [note, setNote] = React.useState("");

  // Serial items are counted by scanning serials, not by typing a number, so they are
  // corrected one at a time in Corrections instead.
  const countable = products.filter((p) => !p.isSerial && p.isInventory !== false);
  const typed = Object.entries(counted).filter(([, v]) => v !== "");

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted">
        Type what is actually on the shelf. Anything left blank is skipped, so you can
        count a shelf at a time. Serial-tracked items are counted in Corrections, by
        their serial numbers.
      </p>

      <Field label="Note" hint="What this count covers, e.g. 'Cables shelf, Monday'.">
        <Input value={note} onChange={(e) => setNote(e.target.value)} className="max-w-[360px]" />
      </Field>

      <ul className="flex flex-col gap-1">
        {countable.map((p) => {
          const v = counted[p.id] ?? "";
          const diff = v === "" ? null : (Number(v) || 0) - p.stock;
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
              <span className="min-w-[200px] flex-1">
                {p.name} <span className="code text-[13px] text-muted">{p.code}</span>
              </span>
              <span className="num text-[13px] text-muted">system says {p.stock}</span>
              <Input
                inputMode="numeric"
                value={v}
                onChange={(e) => setCounted({ ...counted, [p.id]: e.target.value.replace(/\D/g, "") })}
                placeholder="count"
                aria-label={`Counted ${p.name}`}
                className="num h-11 w-24"
              />
              {diff !== null && diff !== 0 && (
                <span className={cn("num text-[13px] font-semibold", diff > 0 ? "text-ok-ink" : "text-bad-ink")}>
                  {diff > 0 ? `+${diff}` : diff}
                </span>
              )}
              {diff === 0 && <Check className="size-4 text-ok-ink" aria-label="Matches" />}
            </li>
          );
        })}
      </ul>

      {/* Nothing moves until the differences have been looked at: a count applied blind
          is indistinguishable from stock being written off. */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || typed.length === 0}
          onClick={() => run(async () => {
            setPreview(await backend.applyStockCount({
              branchId: branch.id,
              counted: typed.map(([productId, v]) => ({ productId, counted: Number(v) || 0 })),
              note: note || null,
              dryRun: true,
            }));
          })}
        >
          Show me the differences
        </Button>
        {preview && preview.differences.length > 0 && (
          <Button
            disabled={busy}
            onClick={() => run(async () => {
              await backend.applyStockCount({
                branchId: branch.id,
                counted: typed.map(([productId, v]) => ({ productId, counted: Number(v) || 0 })),
                note: note || null,
                dryRun: false,
              });
              setPreview(null);
              setCounted({});
            })}
          >
            {busy ? "Saving…" : `Fix ${preview.differences.length} figure${preview.differences.length === 1 ? "" : "s"}`}
          </Button>
        )}
      </div>

      {preview && (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
          <h3 className="font-semibold">
            {preview.differences.length} difference{preview.differences.length === 1 ? "" : "s"}
            {preview.alreadyRight > 0 && `, ${preview.alreadyRight} already right`}
          </h3>
          {preview.differences.length === 0 && (
            <p className="text-[15px] text-ok-ink">Everything counted matches. Nothing to fix.</p>
          )}
          <ul className="flex flex-col gap-1 text-[15px]">
            {preview.differences.map((d) => (
              <li key={d.productId} className="flex justify-between gap-3">
                <span className="truncate">{d.name}</span>
                <span className="num shrink-0">
                  {d.expected} → <span className="font-semibold">{d.counted}</span>
                  <span className={cn("ml-2", d.change > 0 ? "text-ok-ink" : "text-bad-ink")}>
                    {d.change > 0 ? `+${d.change}` : d.change}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function History({ products }: { products: Product[] }) {
  const { backend, branch } = useStaff();
  const [rows, setRows] = React.useState<StockMovementRow[] | null>(null);
  const [productId, setProductId] = React.useState("");
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await backend.stockHistory(branch.id, productId || null, 200);
        if (!cancelled) { setRows(r); setError(""); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the history.");
      }
    })();
    return () => { cancelled = true; };
  }, [backend, branch.id, productId]);

  return (
    <div className="flex flex-col gap-3">
      <Field label="Product" hint="Leave on everything to see the whole branch.">
        <select
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          className="h-11 w-full max-w-[360px] rounded-lg border border-line-strong bg-surface px-3 text-base"
        >
          <option value="">Everything</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}
      {!rows && !error && <p className="text-muted">Loading…</p>}

      {rows && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
          Nothing has moved yet.
        </p>
      )}

      <ul className="flex flex-col gap-1">
        {(rows ?? []).map((m, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-line bg-surface px-3 py-2">
            <span className="num min-w-[150px] text-[13px] text-muted">
              {new Date(m.at).toLocaleString("en-GB", {
                timeZone: "Asia/Dhaka", day: "numeric", month: "short",
                hour: "2-digit", minute: "2-digit",
              })}
            </span>
            <span className="min-w-[180px] flex-1">{m.product}</span>
            <span className={cn("num min-w-[52px] text-right font-semibold",
              m.change > 0 ? "text-ok-ink" : "text-bad-ink")}>
              {m.change > 0 ? `+${m.change}` : m.change}
            </span>
            <span className="min-w-[140px] text-[13px]">
              {REASON_LABEL[m.reason] ?? m.reason}
              {m.why && <span className="text-muted"> · {REASONS.find((r) => r.value === m.why)?.label ?? m.why}</span>}
            </span>
            <span className="min-w-[120px] text-[13px] text-muted">{m.who ?? "—"}</span>
            {m.note && <span className="w-full text-[13px] text-muted">{m.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}
