"use client";

import * as React from "react";
import {
  Ban, Check, Printer, Receipt as ReceiptIcon, RotateCcw, Search, TriangleAlert,
} from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatDay, formatTaka, refundFor } from "@/lib/sale";
import type {
  Approver, RefundMethod, SaleDetail, SaleDetailLine, SaleRow,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const METHOD_WORDS: Record<string, string> = {
  cash: "Cash", bkash: "bKash", nagad: "Nagad", card: "Card",
  rocket: "Rocket", bank: "Bank transfer", cheque: "Cheque", due: "On due (baki)",
  store_credit: "Store credit", reduce_due: "Off their due",
};

// Every method a sale can be stored with, so "Paid by" can find a credit sale. The
// till only offers the ones the shop has switched on, but the history has to be able
// to look for all of them.
const FILTER_METHODS = ["cash", "bkash", "nagad", "card", "rocket", "bank", "cheque", "due"];

const REFUND_METHODS: { value: RefundMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "bkash", label: "bKash" },
  { value: "nagad", label: "Nagad" },
  { value: "card", label: "Card" },
  { value: "store_credit", label: "Store credit" },
  { value: "reduce_due", label: "Take it off their due" },
];

export function SalesScreen() {
  const { backend, branch, staff } = useStaff();
  const [rows, setRows] = React.useState<SaleRow[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [method, setMethod] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [allBranches, setAllBranches] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [nonce, setNonce] = React.useState(0);

  const search = React.useCallback(async () => {
    try {
      const r = await backend.saleHistory({
        branchId: allBranches ? null : branch.id,
        query: query.trim() || null,
        from: from || null,
        to: to || null,
        method: method || null,
        status: (status || null) as SaleRow["status"] | null,
      });
      setRows(r);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the sales.");
    }
  }, [backend, branch.id, allBranches, query, from, to, method, status]);

  React.useEffect(() => { void search(); }, [search, nonce]);

  const isCashier = staff.role === "cashier";

  return (
    <Main>
      <div>
        <h1 className="text-xl font-semibold">Sales</h1>
        <p className="text-[13px] text-muted">
          {isCashier
            ? `Your sales today at ${branch.name}.`
            : allBranches ? "Every branch" : branch.name}
        </p>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); void search(); }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-[2_1_280px]">
            <Field
              label="Find a sale"
              hint="An invoice number, a phone, a serial or a product name — whichever you have."
            >
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="DEMO-MB-2026000012, 01712…, SN0098, keyboard"
                className="h-12"
              />
            </Field>
          </div>
          <Button type="submit" size="lg">
            <Search className="size-4" aria-hidden /> Search
          </Button>
        </div>

        {!isCashier && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            </div>
            <div className="w-40">
              <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </div>
            <div className="w-36">
              <Field label="Paid by">
                <select
                  value={method} onChange={(e) => setMethod(e.target.value)}
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                >
                  <option value="">Any</option>
                  {FILTER_METHODS.map((m) => (
                    <option key={m} value={m}>{METHOD_WORDS[m] ?? m}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="w-36">
              <Field label="Status">
                <select
                  value={status} onChange={(e) => setStatus(e.target.value)}
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                >
                  <option value="">Any</option>
                  <option value="completed">Completed</option>
                  <option value="void">Voided</option>
                </select>
              </Field>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-[15px]">
              <input
                type="checkbox" checked={allBranches}
                onChange={(e) => setAllBranches(e.target.checked)}
                className="size-5 accent-[var(--color-brand)]"
              />
              Every branch
            </label>
          </div>
        )}
      </form>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {!rows ? (
        <p className="text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
          <ReceiptIcon className="mx-auto mb-2 size-8 text-line-strong" aria-hidden />
          {query.trim()
            ? "Nothing matches that. Try part of a serial, a phone number or a product name."
            : isCashier
              ? "You haven't sold anything yet today."
              : "No sales match."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-line bg-surface">
              <button
                type="button"
                onClick={() => setOpenId(openId === r.id ? null : r.id)}
                aria-expanded={openId === r.id}
                className="flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left hover:bg-subtle"
              >
                <span className="flex min-w-[180px] flex-1 flex-col">
                  <span className="code font-semibold">{r.invoiceNo}</span>
                  <span className="truncate text-[13px] text-muted">
                    {new Date(r.createdAt).toLocaleString("en-GB", {
                      day: "2-digit", month: "2-digit", year: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    })}
                    {" · "}{r.staff}
                    {r.branch && ` · ${r.branch}`}
                    {r.summary && ` · ${r.summary}`}
                  </span>
                </span>
                <span className="flex flex-col text-right">
                  <span className="num font-semibold">{formatTaka(r.total)}</span>
                  <span className="text-xs text-muted">{METHOD_WORDS[r.paymentMethod] ?? r.paymentMethod}</span>
                </span>
                <span className="flex min-w-[96px] justify-end">
                  {r.status === "void" ? (
                    <Tag kind="bad">Voided</Tag>
                  ) : r.approvalStatus === "awaiting_approval" ? (
                    <Tag kind="warn">Waiting</Tag>
                  ) : r.returned > 0 ? (
                    <Tag kind="warn">{r.returned} back</Tag>
                  ) : null}
                </span>
              </button>

              {openId === r.id && (
                <SaleDetailPanel
                  saleId={r.id}
                  onChanged={() => setNonce((n) => n + 1)}
                  onClose={() => setOpenId(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
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
// One sale
// ---------------------------------------------------------------------------

function SaleDetailPanel({
  saleId, onChanged, onClose,
}: {
  saleId: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { backend, staff } = useStaff();
  const [sale, setSale] = React.useState<SaleDetail | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [panel, setPanel] = React.useState<"none" | "print" | "void" | "return">("none");
  const [nonce, setNonce] = React.useState(0);
  const [done, setDone] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    backend.saleDetail(saleId)
      .then((d) => { if (!cancelled) { setSale(d); setError(""); } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't open that sale.");
      });
    return () => { cancelled = true; };
  }, [backend, saleId, nonce]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); setNonce((n) => n + 1); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
    finally { setBusy(false); }
  };

  if (error && !sale) {
    return <p role="alert" className="border-t border-subtle px-3 py-3 text-bad-ink">{error}</p>;
  }
  if (!sale) return <p className="border-t border-subtle px-3 py-3 text-muted">Loading…</p>;

  if (panel === "print") {
    return <ReprintView sale={sale} onBack={() => setPanel("none")} />;
  }

  const anythingLeft = sale.items.some((i) => i.returnedQty < i.qty);
  const canVoid = sale.status === "completed" && sale.sameDay
    && sale.items.every((i) => i.returnedQty === 0);

  return (
    <div className="flex flex-col gap-3 border-t border-subtle px-3 py-3">
      {done && (
        <p className="flex items-center gap-2 text-[15px] font-semibold text-ok-ink">
          <Check className="size-5" aria-hidden /> {done}
        </p>
      )}
      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {sale.status === "void" && (
        <p className="flex items-start gap-2 rounded-lg bg-bad-bg p-2.5 text-[15px] text-bad-ink">
          <Ban className="mt-0.5 size-5 shrink-0" aria-hidden />
          <span>Voided{sale.voidReason && `: ${sale.voidReason}`}</span>
        </p>
      )}

      {sale.approvalStatus === "awaiting_approval" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-bg p-2.5 text-[15px] text-warn-ink">
          <TriangleAlert className="size-5 shrink-0" aria-hidden />
          <span className="flex-1">
            This sale is over the shop&rsquo;s limit, so it is waiting to be approved
            before it reaches the books. The goods have already gone out.
          </span>
          {staff.role !== "cashier" && (
            <Button
              size="sm" disabled={busy}
              onClick={() => run(async () => {
                await backend.setSaleApproval("sale", sale.id, "approve");
                setDone("Approved.");
              })}
            >
              Approve it
            </Button>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-0.5 text-[15px]">
        {sale.items.map((i) => (
          <li key={i.id} className="flex flex-wrap justify-between gap-3">
            <span>
              {i.name}
              {i.isGift && <span className="ml-1.5 text-[13px] text-ok-ink">free</span>}
              {i.serials.length > 0 && (
                <span className="code ml-1.5 text-[13px] text-muted">
                  {i.serials.map((s) => s.serial).join(", ")}
                </span>
              )}
              {i.returnedQty > 0 && (
                <span className="ml-1.5 text-[13px] text-warn-ink">
                  {i.returnedQty} of {i.qty} returned
                </span>
              )}
            </span>
            <span className="num text-muted">
              {i.qty} × {formatTaka(i.unitPrice)} = {formatTaka(i.lineTotal)}
            </span>
          </li>
        ))}
      </ul>

      <dl className="ml-auto flex w-full max-w-[260px] flex-col gap-0.5 text-[15px]">
        <Row label="Subtotal" value={sale.subtotal} />
        {sale.discountAmount > 0 && (
          <Row label={`Discount ${sale.discountPct}%`} value={-sale.discountAmount} />
        )}
        {sale.vatAmount > 0 && <Row label="VAT" value={sale.vatAmount} />}
        {sale.chargesAmount > 0 && <Row label="Charges" value={sale.chargesAmount} />}
        <div className="flex justify-between border-t border-line pt-1 font-bold">
          <dt>Total</dt><dd className="num">{formatTaka(sale.total)}</dd>
        </div>
      </dl>

      {sale.returns.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[13px] text-muted">
          {sale.returns.map((r) => (
            <li key={r.id}>
              <span className="code">{r.returnNo}</span> ·{" "}
              {formatDay(r.createdAt)} · {r.branch} ·{" "}
              <span className="num">{formatTaka(r.total)}</span> back by{" "}
              {METHOD_WORDS[r.refundMethod] ?? r.refundMethod}
              {r.reason && ` · ${r.reason}`}
            </li>
          ))}
        </ul>
      )}

      {panel === "void" && (
        <VoidForm
          sale={sale} busy={busy}
          onCancel={() => setPanel("none")}
          onVoid={(reason, refundMethod, approvalId) => run(async () => {
            const res = await backend.voidSale({
              saleId: sale.id, reason, refundMethod, approvalId,
            });
            setPanel("none");
            setDone(`${res.invoiceNo} voided. ${formatTaka(res.refunded)} went back and the stock is on the shelf again.`);
          })}
        />
      )}

      {panel === "return" && (
        <ReturnForm
          sale={sale} busy={busy}
          onCancel={() => setPanel("none")}
          onReturn={(input) => run(async () => {
            const res = await backend.returnSale({ saleId: sale.id, ...input });
            setPanel("none");
            setDone(`Taken back as ${res.returnNo}. ${formatTaka(res.total)} refunded by ${METHOD_WORDS[res.refundMethod] ?? res.refundMethod}.`);
          })}
        />
      )}

      {panel === "none" && (
        <div className="flex flex-wrap gap-2 border-t border-subtle pt-3">
          <Button variant="outline" size="sm" onClick={() => setPanel("print")}>
            <Printer className="size-4" aria-hidden /> Print it again
          </Button>
          {sale.status === "completed" && anythingLeft && (
            <Button size="sm" onClick={() => setPanel("return")}>
              <RotateCcw className="size-4" aria-hidden /> Take something back
            </Button>
          )}
          {canVoid && staff.role !== "cashier" && (
            <Button variant="ghost" size="sm" onClick={() => setPanel("void")}>
              <Ban className="size-4" aria-hidden /> Void it
            </Button>
          )}
          {sale.status === "completed" && !sale.sameDay && (
            <span className="self-center text-[13px] text-muted">
              Too late to void — that is same-day only. Take it back as a return instead.
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt><dd className="num">{formatTaka(value)}</dd>
    </div>
  );
}

function Tag({ kind, children }: { kind: "warn" | "bad"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[13px] font-semibold",
        kind === "bad" ? "bg-bad-bg text-bad-ink" : "bg-warn-bg text-warn-ink",
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Reprint
// ---------------------------------------------------------------------------

/** The same receipt again, marked COPY so nobody mistakes it for the original. */
function ReprintView({ sale, onBack }: { sale: SaleDetail; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-3 border-t border-subtle px-3 py-3">
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden /> Print
        </Button>
        <Button variant="ghost" onClick={onBack}>Back</Button>
      </div>

      <article className="mx-auto w-full max-w-[380px] rounded-xl border border-line bg-surface p-5">
        <header className="flex flex-col items-center gap-0.5 border-b border-line pb-3 text-center">
          <p className="rounded bg-subtle px-2 py-0.5 text-[13px] font-bold tracking-wide text-muted">
            COPY
          </p>
          <h2 className="text-lg font-bold">{sale.shopName}</h2>
          <p className="text-[13px] text-muted">{sale.branch}</p>
          {sale.branchAddress && <p className="text-[13px] text-muted">{sale.branchAddress}</p>}
          {sale.branchPhone && <p className="num text-[13px] text-muted">{sale.branchPhone}</p>}
          {sale.binVat && <p className="code text-[13px] text-muted">BIN {sale.binVat}</p>}
        </header>

        <div className="flex justify-between py-2 text-[13px]">
          <span className="code font-semibold">{sale.invoiceNo}</span>
          <span className="text-muted">
            {new Date(sale.createdAt).toLocaleString("en-GB", {
              day: "2-digit", month: "2-digit", year: "numeric",
              hour: "2-digit", minute: "2-digit",
            })}
          </span>
        </div>

        <ul className="flex flex-col gap-1 border-y border-subtle py-2 text-[15px]">
          {sale.items.map((i) => (
            <li key={i.id} className="flex flex-col">
              <span className="flex justify-between gap-2">
                <span>{i.name}</span>
                <span className="num">{formatTaka(i.lineTotal)}</span>
              </span>
              <span className="text-[13px] text-muted">
                <span className="num">{i.qty}</span> × <span className="num">{formatTaka(i.unitPrice)}</span>
                {i.warrantyUntil && ` · warranty to ${i.warrantyUntil}`}
              </span>
              {i.serials.length > 0 && (
                <span className="code text-[13px] text-muted">
                  {i.serials.map((s) => s.serial).join(", ")}
                </span>
              )}
            </li>
          ))}
        </ul>

        <dl className="flex flex-col gap-0.5 py-2 text-[15px]">
          <Row label="Subtotal" value={sale.subtotal} />
          {sale.discountAmount > 0 && (
            <Row label={`Discount ${sale.discountPct}%`} value={-sale.discountAmount} />
          )}
          {sale.vatAmount > 0 && <Row label="VAT" value={sale.vatAmount} />}
          {sale.chargesAmount > 0 && <Row label="Charges" value={sale.chargesAmount} />}
          <div className="flex justify-between border-t border-line pt-1 text-lg font-bold">
            <dt>Total</dt><dd className="num">{formatTaka(sale.total)}</dd>
          </div>
        </dl>

        <p className="text-[13px] text-muted">
          {METHOD_WORDS[sale.paymentMethod] ?? sale.paymentMethod}
          {sale.cashReceived != null && ` · given ${formatTaka(sale.cashReceived)}`}
          {sale.changeGiven != null && sale.changeGiven > 0 && ` · change ${formatTaka(sale.changeGiven)}`}
          {sale.paymentRef && ` · ref ${sale.paymentRef}`}
        </p>
        <p className="text-[13px] text-muted">Served by {sale.staff}</p>
        {sale.status === "void" && (
          <p className="pt-1 font-bold text-bad-ink">THIS SALE WAS VOIDED</p>
        )}
        {sale.receiptFooter && (
          <p className="border-t border-subtle pt-2 text-center text-[13px] text-muted">
            {sale.receiptFooter}
          </p>
        )}
      </article>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

function VoidForm({
  sale, busy, onVoid, onCancel,
}: {
  sale: SaleDetail;
  busy: boolean;
  onVoid: (reason: string, refundMethod: string, approvalId: string | null) => void;
  onCancel: () => void;
}) {
  const { backend, staff } = useStaff();
  const [reason, setReason] = React.useState("");
  const [refundMethod, setRefundMethod] = React.useState(sale.paymentMethod);
  const [approvers, setApprovers] = React.useState<Approver[]>([]);
  const [approverId, setApproverId] = React.useState("");
  const [pin, setPin] = React.useState("");
  const [approvalId, setApprovalId] = React.useState<string | null>(null);
  const [pinMessage, setPinMessage] = React.useState("");
  const [checking, setChecking] = React.useState(false);

  // A cashier with the void permission still needs a manager to agree, and the
  // approval names which manager that was.
  const needsPin = staff.role === "cashier";

  React.useEffect(() => {
    if (needsPin) void backend.listApprovers().then(setApprovers).catch(() => {});
  }, [backend, needsPin]);

  return (
    <form
      className="flex flex-col gap-3 border-t border-subtle pt-3"
      onSubmit={(e) => { e.preventDefault(); onVoid(reason, refundMethod, approvalId); }}
    >
      <p className="text-[13px] text-muted">
        Voiding says this sale should never have existed. The stock goes back on the
        shelf and the invoice number stays used, so the numbering has no gap to explain.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-[2_1_240px]">
          <Field label="Why" hint="Needed. It goes in the log with your name.">
            <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <div className="w-40">
          <Field label="Money back by">
            <select
              value={refundMethod}
              onChange={(e) => setRefundMethod(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              {FILTER_METHODS.map((m) => (
                <option key={m} value={m}>{METHOD_WORDS[m] ?? m}</option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      {needsPin && !approvalId && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48">
            <Field label="Approved by">
              <select
                value={approverId}
                onChange={(e) => setApproverId(e.target.value)}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                <option value="">Who is approving?</option>
                {approvers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="w-32">
            <Field label="Their PIN">
              <Input
                type="password" inputMode="numeric" value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                className="num"
              />
            </Field>
          </div>
          <Button
            type="button" variant="outline"
            disabled={checking || !approverId || pin.length < 4}
            onClick={async () => {
              setChecking(true);
              setPinMessage("");
              try {
                const res = await backend.verifyManagerPin(approverId, pin);
                if (res.ok) {
                  setApprovalId(res.approvalId);
                  setPinMessage(`Approved by ${res.approverName}.`);
                } else {
                  setPinMessage(res.locked
                    ? "Too many wrong tries. This manager's PIN is locked for 10 minutes. The owner can see the attempts."
                    : `Wrong PIN. ${res.triesLeft} ${res.triesLeft === 1 ? "try" : "tries"} left before it locks.`);
                }
              } catch (e) {
                setPinMessage(e instanceof Error ? e.message : "Couldn't check that PIN.");
              } finally { setChecking(false); setPin(""); }
            }}
          >
            {checking ? "Checking…" : "Check the PIN"}
          </Button>
          {pinMessage && <p className="w-full text-[13px] text-warn-ink">{pinMessage}</p>}
        </div>
      )}
      {approvalId && <p className="text-[13px] text-ok-ink">{pinMessage}</p>}

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={busy || !reason.trim() || (needsPin && !approvalId)}
        >
          Void this sale
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Keep it
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

interface ReturnDraft {
  qty: string;
  serialIds: string[];
  isFaulty: boolean;
}

function ReturnForm({
  sale, busy, onReturn, onCancel,
}: {
  sale: SaleDetail;
  busy: boolean;
  onReturn: (input: {
    branchId: string;
    lines: { saleItemId: string; qty?: number; serialIds?: string[]; isFaulty?: boolean }[];
    refundMethod: RefundMethod;
    reason?: string | null;
    courierName?: string | null;
    courierTracking?: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const { branch } = useStaff();
  const open = sale.items.filter((i) => i.returnedQty < i.qty);
  const [draft, setDraft] = React.useState<Record<string, ReturnDraft>>(
    Object.fromEntries(open.map((i) => [i.id, { qty: "0", serialIds: [], isFaulty: false }])));
  const [refundMethod, setRefundMethod] = React.useState<RefundMethod>("cash");
  const [reason, setReason] = React.useState("");
  const [byCourier, setByCourier] = React.useState(false);
  const [courierName, setCourierName] = React.useState("");
  const [courierTracking, setCourierTracking] = React.useState("");

  const asked = open.map((i) => {
    const d = draft[i.id];
    const left = i.qty - i.returnedQty;
    const wanted = i.isSerial ? d.serialIds.length : Number(d.qty) || 0;
    // More back than went out is the one mistake worth catching here rather than
    // letting the counter read a refund the database is going to refuse.
    const qty = Math.min(wanted, left);
    // The same arithmetic the database will do, so the figure on screen is the
    // figure that goes back.
    const refund = refundFor(
      { qty: i.qty, lineTotal: i.lineTotal, vatAmount: i.vatAmount, vatInclusive: i.vatInclusive },
      qty, sale.discountPct);
    return { item: i, qty, left, wanted, refund, isFaulty: d.isFaulty, serialIds: d.serialIds };
  });
  const overLine = asked.find((x) => x.wanted > x.left);
  const lines = asked.filter((x) => x.qty > 0);

  const refundTotal = lines.reduce((n, x) => n + x.refund, 0);
  const wholeSale = sale.items.every((i) => {
    const picked = lines.find((x) => x.item.id === i.id)?.qty ?? 0;
    return i.returnedQty + picked >= i.qty;
  });
  const lateByDays = sale.daysOld - sale.returnDays;

  return (
    <form
      className="flex flex-col gap-3 border-t border-subtle pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onReturn({
          branchId: branch.id,
          refundMethod,
          reason: reason || null,
          courierName: byCourier ? courierName || null : null,
          courierTracking: byCourier ? courierTracking || null : null,
          lines: lines.map((x) => ({
            saleItemId: x.item.id,
            qty: x.item.isSerial ? undefined : x.qty,
            serialIds: x.item.isSerial ? x.serialIds : undefined,
            isFaulty: x.isFaulty,
          })),
        });
      }}
    >
      {sale.branchId !== branch.id && (
        <p className="text-[13px] text-muted">
          This was sold at {sale.branch}. It can still be taken back here, and the stock
          goes back on {branch.name}&rsquo;s shelf — that is where the box is.
        </p>
      )}
      {lateByDays > 0 && (
        <p className="flex items-start gap-2 text-[13px] text-warn-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          This sale is {sale.daysOld} days old, past the shop&rsquo;s {sale.returnDays}-day
          window. A manager will have to approve it.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {open.map((i) => (
          <li key={i.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <span className="flex min-w-[180px] flex-1 flex-col">
                <span className="font-semibold">{i.name}</span>
                <span className="text-[13px] text-muted">
                  {i.qty} sold
                  {i.returnedQty > 0 && `, ${i.returnedQty} already back`} ·{" "}
                  <span className="num">{formatTaka(i.refundEach)}</span> back each
                </span>
              </span>
              {!i.isSerial && (
                <div className="w-28">
                  <Field label="How many back">
                    <Input
                      inputMode="numeric" value={draft[i.id].qty} className="num"
                      onChange={(e) => setDraft({
                        ...draft,
                        [i.id]: { ...draft[i.id], qty: e.target.value.replace(/\D/g, "") },
                      })}
                    />
                  </Field>
                </div>
              )}
            </div>

            {i.isSerial && <PickReturnSerials
              line={i}
              picked={draft[i.id].serialIds}
              onChange={(ids) => setDraft({ ...draft, [i.id]: { ...draft[i.id], serialIds: ids } })}
            />}

            <label className="flex min-h-11 items-start gap-2.5 text-[15px]">
              <input
                type="checkbox"
                checked={draft[i.id].isFaulty}
                onChange={(e) => setDraft({
                  ...draft, [i.id]: { ...draft[i.id], isFaulty: e.target.checked },
                })}
                className="mt-0.5 size-5 accent-[var(--color-brand)]"
              />
              <span className="flex flex-col">
                Is it faulty?
                <span className="text-[13px] text-muted">
                  A faulty one does not go back on the shelf. It waits to go to the
                  supplier instead, so nobody sells it again.
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Field label="Money back by">
            <select
              value={refundMethod}
              onChange={(e) => setRefundMethod(e.target.value as RefundMethod)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              {REFUND_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="min-w-[200px] flex-[2_1_240px]">
          <Field label="Why is it coming back?">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </div>

      <label className="flex min-h-11 items-center gap-2.5 text-[15px]">
        <input
          type="checkbox" checked={byCourier}
          onChange={(e) => setByCourier(e.target.checked)}
          className="size-5 accent-[var(--color-brand)]"
        />
        It came back by courier
      </label>
      {byCourier && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48">
            <Field label="Courier">
              <Input value={courierName} onChange={(e) => setCourierName(e.target.value)} />
            </Field>
          </div>
          <div className="w-48">
            <Field label="Tracking number">
              <Input
                value={courierTracking}
                onChange={(e) => setCourierTracking(e.target.value)}
                className="code"
              />
            </Field>
          </div>
        </div>
      )}

      <div className="flex items-baseline justify-between border-t border-subtle pt-3 text-lg font-bold">
        <span>Going back</span><span className="num">{formatTaka(refundTotal)}</span>
      </div>
      {refundTotal > 0 && sale.discountPct > 0 && (
        <p className="text-[13px] text-muted">
          That is after the {sale.discountPct}% the customer was given on this sale —
          refunding the shelf price would hand back more than they paid.
        </p>
      )}
      {wholeSale && sale.chargesAmount > 0 && (
        <p className="text-[13px] text-muted">
          The whole sale is coming back, so the {formatTaka(sale.chargesAmount)} of
          charges goes back with it.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || lines.length === 0 || overLine != null}>
          <RotateCcw className="size-4" aria-hidden /> Take it back
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        {overLine != null ? (
          <span className="self-center text-[13px] text-bad-ink">
            {overLine.item.name}: only {overLine.left} can come back
            {overLine.item.returnedQty > 0 && ", the rest already has"}.
          </span>
        ) : lines.length === 0 && (
          <span className="self-center text-[13px] text-muted">
            Say how many of each is coming back.
          </span>
        )}
      </div>
    </form>
  );
}

/** Which units are coming back. Already-returned serials are not offered again. */
function PickReturnSerials({
  line, picked, onChange,
}: {
  line: SaleDetailLine;
  picked: string[];
  onChange: (ids: string[]) => void;
}) {
  const available = line.serials.filter((s) => s.status === "sold");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label>Which units</Label>
        <span className="num text-[13px] text-muted">{picked.length} picked</span>
      </div>
      {available.length === 0 ? (
        <p className="text-[13px] text-muted">Every unit on this line has already come back.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {available.map((s) => {
            const on = picked.includes(s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(on ? picked.filter((x) => x !== s.id) : [...picked, s.id])}
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
        </ul>
      )}
    </div>
  );
}

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
