"use client";

import * as React from "react";
import {
  Check, ClipboardList, FileText, Printer, ShoppingCart, Trash2, TriangleAlert,
} from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { SerialEntry } from "@/components/stock/serial-entry";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatDay, formatTaka, searchProducts } from "@/lib/sale";
import type {
  LedgerEntry, Product, PurchaseOrderRow, PurchaseOrderStatus, ReorderSuggestion,
  RequisitionRow, RequisitionStatus, Supplier, SupplierAging,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Tab = "orders" | "requests" | "reorder" | "dues";

const TABS: { key: Tab; label: string }[] = [
  { key: "orders", label: "Orders" },
  { key: "requests", label: "Requests" },
  { key: "reorder", label: "What to buy" },
  { key: "dues", label: "Supplier dues" },
];

const REQ_WORDS: Record<RequisitionStatus, string> = {
  draft: "Draft", submitted: "Waiting for a decision", approved: "Approved",
  rejected: "Rejected", ordered: "Ordered", cancelled: "Cancelled",
};

const PO_WORDS: Record<PurchaseOrderStatus, string> = {
  draft: "Draft", awaiting_approval: "Waiting for the owner", sent: "Sent to the supplier",
  partly_received: "Part of it has arrived", received: "All arrived", closed: "Closed",
  cancelled: "Cancelled",
};

/** Warn-coloured while something is waiting on a person; plain otherwise. */
const WAITING = new Set<string>(["submitted", "awaiting_approval", "partly_received"]);

const PAY_METHODS = ["cash", "bank", "bkash", "nagad", "cheque", "card"];

export function PurchasesScreen() {
  const { backend, branch, staff } = useStaff();
  const [tab, setTab] = React.useState<Tab>("orders");
  const [products, setProducts] = React.useState<Product[]>([]);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [requests, setRequests] = React.useState<RequisitionRow[]>([]);
  const [orders, setOrders] = React.useState<PurchaseOrderRow[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, s, r, o] = await Promise.all([
          backend.listProducts(branch.id),
          backend.listSuppliers(),
          backend.listRequisitions(branch.id),
          backend.listPurchaseOrders(branch.id),
        ]);
        if (cancelled) return;
        setProducts(p);
        setSuppliers(s);
        setRequests(r);
        setOrders(o);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the purchases.");
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
        <h1 className="text-xl font-semibold">Purchases</h1>
        <p className="text-ink-soft">
          Orders and what the shop owes suppliers are for managers and owners. You can
          still ask for stock — tell the manager what the branch is short of.
        </p>
      </Main>
    );
  }

  const waiting = requests.filter((r) => r.status === "submitted").length
    + orders.filter((o) => o.status === "awaiting_approval").length;

  return (
    <Main>
      <div>
        <h1 className="text-xl font-semibold">Purchases</h1>
        <p className="text-[13px] text-muted">
          {branch.name}
          {waiting > 0 && <> · <span className="font-semibold text-warn-ink">{waiting} waiting for a decision</span></>}
        </p>
      </div>

      <nav aria-label="Purchase sections" className="flex gap-1 overflow-x-auto border-b border-line">
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

      {tab === "orders" && (
        <Orders
          orders={orders} products={products} suppliers={suppliers} requests={requests}
          busy={busy} run={run}
        />
      )}
      {tab === "requests" && (
        <Requests requests={requests} products={products} busy={busy} run={run} />
      )}
      {tab === "reorder" && (
        <WhatToBuy products={products} busy={busy} run={run} onPlaced={() => setTab("orders")} />
      )}
      {tab === "dues" && <SupplierDues suppliers={suppliers} busy={busy} run={run} />}
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
// Requests (purchase requisitions)
// ---------------------------------------------------------------------------

function Requests({
  requests, products, busy, run,
}: {
  requests: RequisitionRow[];
  products: Product[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch } = useStaff();
  const [adding, setAdding] = React.useState(false);
  const [lines, setLines] = React.useState<{ productId: string; qty: string }[]>([]);
  const [query, setQuery] = React.useState("");
  const [neededBy, setNeededBy] = React.useState("");
  const [note, setNote] = React.useState("");
  const [deciding, setDeciding] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  const byId = new Map(products.map((p) => [p.id, p]));
  const results = searchProducts(products, query, null).slice(0, 8);

  const reset = () => {
    setAdding(false); setLines([]); setQuery(""); setNeededBy(""); setNote("");
  };

  return (
    <div className="flex flex-col gap-4">
      {!adding && (
        <Button className="self-start" onClick={() => setAdding(true)}>
          <ClipboardList className="size-4" aria-hidden /> Ask for stock
        </Button>
      )}

      {adding && (
        <div className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-surface p-4">
          <h2 className="font-semibold">What does {branch.name} need?</h2>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="req-search">Add an item</Label>
            <Input
              id="req-search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a name or code" className="h-12"
            />
            {query.trim() !== "" && (
              <ul className="flex flex-col gap-1">
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!lines.some((l) => l.productId === p.id)) {
                          setLines([...lines, { productId: p.id, qty: "1" }]);
                        }
                        setQuery("");
                      }}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line px-3 text-left hover:bg-subtle"
                    >
                      <span>{p.name} <span className="code text-[13px] text-muted">{p.code}</span></span>
                      <span className="text-[13px] text-muted">{p.stock} here</span>
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
                <li key={l.productId} className="flex flex-wrap items-end gap-3 rounded-lg border border-line p-3">
                  <span className="flex min-w-[180px] flex-1 flex-col">
                    <span className="font-semibold">{p.name}</span>
                    <span className="text-[13px] text-muted">
                      <span className="code">{p.code}</span> · {p.stock} here
                    </span>
                  </span>
                  <div className="w-24">
                    <Field label="How many">
                      <Input
                        inputMode="numeric" value={l.qty} className="num"
                        onChange={(e) => setLines(lines.map((x) =>
                          x.productId === l.productId
                            ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x))}
                      />
                    </Field>
                  </div>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}
                    aria-label={`Remove ${p.name}`}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap gap-3">
            <div className="flex-[1_1_160px]">
              <Field label="Needed by" hint="Leave empty if it isn't urgent.">
                <Input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
              </Field>
            </div>
            <div className="flex-[2_1_220px]">
              <Field label="Note">
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              disabled={busy || lines.length === 0}
              onClick={() => run(async () => {
                await backend.saveRequisition({
                  branchId: branch.id, neededBy: neededBy || null, note: note || null,
                  submit: true,
                  lines: lines.map((l) => ({ productId: l.productId, qty: Number(l.qty) || 1 })),
                });
                reset();
              })}
            >
              Send it for a decision
            </Button>
            <Button
              variant="outline" size="lg"
              disabled={busy || lines.length === 0}
              onClick={() => run(async () => {
                await backend.saveRequisition({
                  branchId: branch.id, neededBy: neededBy || null, note: note || null,
                  lines: lines.map((l) => ({ productId: l.productId, qty: Number(l.qty) || 1 })),
                });
                reset();
              })}
            >
              Save as a draft
            </Button>
            <Button variant="ghost" size="lg" onClick={reset} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}

      {requests.length === 0 && <Empty what="No requests yet." icon={<ClipboardList />} />}

      <ul className="flex flex-col gap-2">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-col">
                <span className="code font-semibold">{r.reqNo}</span>
                <span className="text-[13px] text-muted">
                  {r.askedBy ? `Asked by ${r.askedBy}` : "Asked for"}
                  {r.neededBy && ` · needed by ${r.neededBy}`}
                </span>
              </span>
              <Pill status={r.status} words={REQ_WORDS[r.status]} />
            </div>

            <ul className="flex flex-col gap-0.5 text-[15px]">
              {r.lines.map((l) => (
                <li key={l.id} className="flex justify-between gap-3">
                  <span>{l.product}</span><span className="num">{l.qty}</span>
                </li>
              ))}
            </ul>

            {r.note && <p className="text-[13px] text-muted">{r.note}</p>}
            {r.decidedBy && (
              <p className="text-[13px] text-muted">
                {r.status === "rejected" ? "Rejected" : "Decided"} by {r.decidedBy}
                {r.decisionNote && `: ${r.decisionNote}`}
              </p>
            )}

            {r.status === "submitted" && (
              deciding === r.id ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-subtle pt-2">
                  <div className="flex-[1_1_200px]">
                    <Field label="Why" hint="Kept with the decision, so the branch knows.">
                      <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                    </Field>
                  </div>
                  <Button
                    disabled={busy}
                    onClick={() => run(async () => {
                      await backend.decideRequisition(r.id, true, reason || null);
                      setDeciding(null); setReason("");
                    })}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="outline" disabled={busy}
                    onClick={() => run(async () => {
                      await backend.decideRequisition(r.id, false, reason || null);
                      setDeciding(null); setReason("");
                    })}
                  >
                    Reject
                  </Button>
                  <Button variant="ghost" onClick={() => { setDeciding(null); setReason(""); }}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline" size="sm" className="self-start"
                  onClick={() => { setDeciding(r.id); setReason(""); }}
                >
                  Decide
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

interface OrderLine {
  productId: string;
  qty: string;
  unitPrice: string;
  reqItemId?: string | null;
}

function Orders({
  orders, products, suppliers, requests, busy, run,
}: {
  orders: PurchaseOrderRow[];
  products: Product[];
  suppliers: Supplier[];
  requests: RequisitionRow[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch } = useStaff();
  const [adding, setAdding] = React.useState(false);
  const [lines, setLines] = React.useState<OrderLine[]>([]);
  const [fromReqs, setFromReqs] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const [supplierId, setSupplierId] = React.useState("");
  const [termsDays, setTermsDays] = React.useState("");
  const [discount, setDiscount] = React.useState("");
  const [charges, setCharges] = React.useState("");
  const [note, setNote] = React.useState("");
  const [receiving, setReceiving] = React.useState<PurchaseOrderRow | null>(null);
  const [cancelling, setCancelling] = React.useState<string | null>(null);
  const [cancelReason, setCancelReason] = React.useState("");
  const [printing, setPrinting] = React.useState<PurchaseOrderRow | null>(null);

  const byId = new Map(products.map((p) => [p.id, p]));
  const results = searchProducts(products, query, null).slice(0, 8);
  const approved = requests.filter((r) => r.status === "approved");

  const reset = () => {
    setAdding(false); setLines([]); setFromReqs([]); setQuery(""); setSupplierId("");
    setTermsDays(""); setDiscount(""); setCharges(""); setNote("");
  };

  const subtotal = lines.reduce(
    (n, l) => n + Math.max((Number(l.unitPrice) || 0) * (Number(l.qty) || 0), 0), 0);
  const total = Math.max(subtotal - (Number(discount) || 0), 0) + (Number(charges) || 0);

  const pull = (r: RequisitionRow) => {
    setFromReqs((ids) => (ids.includes(r.id) ? ids : [...ids, r.id]));
    setLines((cur) => {
      const next = [...cur];
      for (const l of r.lines) {
        const found = next.find((x) => x.productId === l.productId);
        if (found) found.qty = String((Number(found.qty) || 0) + l.qty);
        else next.push({ productId: l.productId, qty: String(l.qty), unitPrice: "", reqItemId: l.id });
      }
      return next;
    });
    setAdding(true);
  };

  if (printing) return <PoPrint po={printing} onBack={() => setPrinting(null)} />;
  if (receiving) {
    return (
      <ReceiveAgainstPo
        po={receiving} products={products} busy={busy} run={run}
        onDone={() => setReceiving(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!adding && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setAdding(true)}>
            <ShoppingCart className="size-4" aria-hidden /> New order
          </Button>
          {approved.length > 0 && (
            <span className="text-[13px] text-muted">
              {approved.length} approved {approved.length === 1 ? "request" : "requests"} ready to order
            </span>
          )}
        </div>
      )}

      {!adding && approved.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {approved.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-line-strong bg-subtle px-3 py-2.5"
            >
              <span className="code font-semibold">{r.reqNo}</span>
              <span className="min-w-[160px] flex-1 text-[13px] text-muted">
                {r.lines.map((l) => `${l.product} ×${l.qty}`).join(", ")}
              </span>
              <Button variant="outline" size="sm" onClick={() => pull(r)}>Turn into an order</Button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-surface p-4">
          <h2 className="font-semibold">
            New order{fromReqs.length > 0 && ` · from ${fromReqs.length} request${fromReqs.length === 1 ? "" : "s"}`}
          </h2>

          <div className="flex flex-wrap gap-3">
            <div className="flex-[2_1_220px]">
              <Field label="Supplier" required>
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                >
                  <option value="">Pick a supplier</option>
                  {suppliers.filter((s) => s.active).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex-[1_1_140px]">
              <Field label="Payment terms (days)" hint="0 means pay on delivery.">
                <Input
                  inputMode="numeric" value={termsDays} className="num"
                  onChange={(e) => setTermsDays(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="po-search">Add an item</Label>
            <Input
              id="po-search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a name or code" className="h-12"
            />
            {query.trim() !== "" && (
              <ul className="flex flex-col gap-1">
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!lines.some((l) => l.productId === p.id)) {
                          setLines([...lines, { productId: p.id, qty: "1", unitPrice: "" }]);
                        }
                        setQuery("");
                      }}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line px-3 text-left hover:bg-subtle"
                    >
                      <span>{p.name} <span className="code text-[13px] text-muted">{p.code}</span></span>
                      <span className="text-[13px] text-muted">{p.stock} here</span>
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
                <li key={l.productId} className="flex flex-wrap items-end gap-3 rounded-lg border border-line p-3">
                  <span className="flex min-w-[160px] flex-1 flex-col">
                    <span className="font-semibold">{p.name}</span>
                    <span className="code text-[13px] text-muted">{p.code}</span>
                  </span>
                  <div className="w-24">
                    <Field label="How many">
                      <Input
                        inputMode="numeric" value={l.qty} className="num"
                        onChange={(e) => setLines(lines.map((x) =>
                          x.productId === l.productId
                            ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x))}
                      />
                    </Field>
                  </div>
                  <div className="w-32">
                    <Field label="Agreed price">
                      <Input
                        inputMode="decimal" value={l.unitPrice} className="num"
                        onChange={(e) => setLines(lines.map((x) =>
                          x.productId === l.productId
                            ? { ...x, unitPrice: e.target.value.replace(/[^0-9.]/g, "") } : x))}
                      />
                    </Field>
                  </div>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}
                    aria-label={`Remove ${p.name}`}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>

          {lines.length > 0 && (
            <>
              <div className="flex flex-wrap gap-3">
                <div className="flex-[1_1_140px]">
                  <Field label="Discount on the whole order">
                    <Input
                      inputMode="decimal" value={discount} className="num"
                      onChange={(e) => setDiscount(e.target.value.replace(/[^0-9.]/g, ""))}
                    />
                  </Field>
                </div>
                <div className="flex-[1_1_140px]">
                  <Field label="Transport, labour">
                    <Input
                      inputMode="decimal" value={charges} className="num"
                      onChange={(e) => setCharges(e.target.value.replace(/[^0-9.]/g, ""))}
                    />
                  </Field>
                </div>
                <div className="flex-[2_1_200px]">
                  <Field label="Note">
                    <Input value={note} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                </div>
              </div>
              <div className="flex items-baseline justify-between border-t border-subtle pt-3 text-lg font-bold">
                <span>Order total</span><span className="num">{formatTaka(total)}</span>
              </div>
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              disabled={busy || lines.length === 0 || !supplierId}
              onClick={() => run(async () => {
                await backend.savePurchaseOrder({
                  branchId: branch.id, supplierId,
                  lines: lines.map((l) => ({
                    productId: l.productId, qty: Number(l.qty) || 1,
                    unitPrice: Number(l.unitPrice) || 0, reqItemId: l.reqItemId ?? null,
                  })),
                  termsDays: Number(termsDays) || 0,
                  discount: Number(discount) || 0,
                  charges: Number(charges) || 0,
                  note: note || null,
                  reqIds: fromReqs.length > 0 ? fromReqs : null,
                });
                reset();
              })}
            >
              Save the order
            </Button>
            <Button variant="ghost" size="lg" onClick={reset} disabled={busy}>Cancel</Button>
          </div>
          <p className="text-[13px] text-muted">
            It is saved as a draft. Send it once the prices are right — an order over the
            shop&rsquo;s limit waits for the owner instead.
          </p>
        </div>
      )}

      {orders.length === 0 && <Empty what="No orders yet." icon={<ShoppingCart />} />}

      <ul className="flex flex-col gap-2">
        {orders.map((o) => {
          const pending = o.lines.reduce((n, l) => n + (l.qty - l.receivedQty), 0);
          return (
            <li key={o.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-col">
                  <span className="code font-semibold">{o.poNo}</span>
                  <span className="text-[13px] text-muted">
                    {o.supplierName ?? "No supplier"}
                    {o.paymentTermsDays > 0 && ` · ${o.paymentTermsDays} days to pay`}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="num font-semibold">{formatTaka(o.total)}</span>
                  <Pill status={o.status} words={PO_WORDS[o.status]} />
                </span>
              </div>

              <ul className="flex flex-col gap-0.5 text-[15px]">
                {o.lines.map((l) => (
                  <li key={l.id} className="flex flex-wrap justify-between gap-3">
                    <span>{l.product}</span>
                    <span className="num text-muted">
                      {l.receivedQty} of {l.qty} in
                      {l.receivedQty < l.qty && ` · ${l.qty - l.receivedQty} still to come`}
                      {" · "}{formatTaka(l.unitPrice)} each
                    </span>
                  </li>
                ))}
              </ul>

              {o.note && <p className="text-[13px] text-muted">{o.note}</p>}
              {o.cancelReason && (
                <p className="text-[13px] text-warn-ink">Cancelled: {o.cancelReason}</p>
              )}

              {cancelling === o.id ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-subtle pt-2">
                  <div className="flex-[1_1_220px]">
                    <Field label="Why is it being cancelled?">
                      <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                    </Field>
                  </div>
                  <Button
                    disabled={busy || !cancelReason.trim()}
                    onClick={() => run(async () => {
                      await backend.setPoStatus(o.id, "cancel", cancelReason);
                      setCancelling(null); setCancelReason("");
                    })}
                  >
                    Cancel the order
                  </Button>
                  <Button variant="ghost" onClick={() => { setCancelling(null); setCancelReason(""); }}>
                    Keep it
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 border-t border-subtle pt-2">
                  {o.status === "draft" && (
                    <Button
                      size="sm" disabled={busy}
                      onClick={() => run(async () => { await backend.setPoStatus(o.id, "send"); })}
                    >
                      Send to the supplier
                    </Button>
                  )}
                  {o.status === "awaiting_approval" && (
                    <Button
                      size="sm" disabled={busy}
                      onClick={() => run(async () => { await backend.setPoStatus(o.id, "approve"); })}
                    >
                      Approve and send
                    </Button>
                  )}
                  {(o.status === "sent" || o.status === "partly_received") && (
                    <Button size="sm" onClick={() => setReceiving(o)}>
                      Receive {pending > 0 ? `${pending} still to come` : "goods"}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setPrinting(o)}>
                    <Printer className="size-4" aria-hidden /> Print
                  </Button>
                  {/* Once something has arrived, cancelling is refused — closing it
                      short is the honest move, so only that is offered. */}
                  {!["received", "closed", "cancelled"].includes(o.status)
                    && o.lines.every((l) => l.receivedQty === 0) && (
                    <Button variant="ghost" size="sm" onClick={() => setCancelling(o.id)}>
                      Cancel
                    </Button>
                  )}
                  {o.status === "partly_received" && (
                    <Button
                      variant="ghost" size="sm" disabled={busy}
                      onClick={() => run(async () => { await backend.setPoStatus(o.id, "close"); })}
                    >
                      Close it short
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Receiving against an order
// ---------------------------------------------------------------------------

function ReceiveAgainstPo({
  po, products, busy, run, onDone,
}: {
  po: PurchaseOrderRow;
  products: Product[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onDone: () => void;
}) {
  const { backend } = useStaff();
  const byId = new Map(products.map((p) => [p.id, p]));
  const open = po.lines.filter((l) => l.receivedQty < l.qty);

  const [qty, setQty] = React.useState<Record<string, string>>(
    Object.fromEntries(open.map((l) => [l.id, String(l.qty - l.receivedQty)])));
  const [serials, setSerials] = React.useState<Record<string, string[]>>({});
  const [invoiceNo, setInvoiceNo] = React.useState("");
  const [isCredit, setIsCredit] = React.useState(true);
  const [payAmount, setPayAmount] = React.useState("");
  const [payMethod, setPayMethod] = React.useState("cash");
  const [payRef, setPayRef] = React.useState("");

  const taking = open
    .map((l) => {
      const p = byId.get(l.productId);
      const n = p?.isSerial ? (serials[l.id] ?? []).length : Number(qty[l.id]) || 0;
      return { line: l, product: p, n };
    })
    .filter((x) => x.n > 0);

  const value = taking.reduce((n, x) => n + x.n * x.line.unitPrice, 0);

  const blocker = (): string | null => {
    if (taking.length === 0) return "Say how many of each turned up.";
    for (const x of taking) {
      if (x.n > x.line.qty - x.line.receivedQty) {
        return `More ${x.line.product} turned up than was ordered. Change the order first.`;
      }
    }
    return null;
  };
  const stop = blocker();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">
            What turned up against <span className="code">{po.poNo}</span>?
          </h2>
          <p className="text-[13px] text-muted">
            {po.supplierName} · prices come from the order, so nobody has to retype them.
          </p>
        </div>
        <Button variant="ghost" onClick={onDone}>Back to the orders</Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_180px]">
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
            Adds it to what the shop owes {po.supplierName}. Leave off if it is paid for.
          </span>
        </span>
      </label>

      <ul className="flex flex-col gap-2">
        {open.map((l) => {
          const p = byId.get(l.productId);
          const left = l.qty - l.receivedQty;
          return (
            <li key={l.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <span className="flex min-w-[180px] flex-1 flex-col">
                  <span className="font-semibold">{l.product}</span>
                  <span className="text-[13px] text-muted">
                    <span className="code">{l.code}</span> · ordered {l.qty}, {l.receivedQty} in,{" "}
                    {left} still to come · {formatTaka(l.unitPrice)} each
                  </span>
                </span>
                {!p?.isSerial && (
                  <div className="w-28">
                    <Field label="How many">
                      <Input
                        inputMode="numeric" value={qty[l.id] ?? ""} className="num"
                        onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/\D/g, "") })}
                      />
                    </Field>
                  </div>
                )}
              </div>
              {p?.isSerial && (
                <SerialEntry
                  product={p}
                  serials={serials[l.id] ?? []}
                  otherSerials={Object.entries(serials)
                    .filter(([k]) => k !== l.id).flatMap(([, v]) => v)}
                  onChange={(next) => setSerials({ ...serials, [l.id]: next })}
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-baseline justify-between text-lg font-bold">
          <span>Worth</span><span className="num">{formatTaka(value)}</span>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-subtle pt-3">
          <div className="flex-[1_1_140px]">
            <Field label="Pay now" hint="Full or part. Leave empty to pay later.">
              <Input
                inputMode="decimal" value={payAmount} className="num"
                onChange={(e) => setPayAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              />
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
                    {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
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
        {stop && (
          <p className="flex items-start gap-2 text-[13px] text-warn-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {stop}
          </p>
        )}
        <Button
          size="lg" className="self-start"
          disabled={busy || Boolean(stop)}
          onClick={() => run(async () => {
            await backend.receiveAgainstPo({
              poId: po.id,
              lines: taking.map((x) => ({
                poItemId: x.line.id,
                qty: x.n,
                serials: x.product?.isSerial ? serials[x.line.id] : undefined,
              })),
              supplierInvoiceNo: invoiceNo || null,
              isCredit,
              payAmount: Number(payAmount) || null,
              payMethod: Number(payAmount) > 0 ? payMethod : null,
              payReference: payRef || null,
            });
            onDone();
          })}
        >
          Take it in
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The order, as the supplier sees it
// ---------------------------------------------------------------------------

function PoPrint({ po, onBack }: { po: PurchaseOrderRow; onBack: () => void }) {
  const { branch, staff } = useStaff();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden /> Print this
        </Button>
        <Button variant="ghost" onClick={onBack}>Back to the orders</Button>
      </div>

      <article className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
          <div>
            <h2 className="text-lg font-bold">{staff.shopName}</h2>
            <p className="text-[13px] text-muted">Purchase order</p>
          </div>
          <div className="text-right">
            <p className="code font-bold">{po.poNo}</p>
            <p className="text-[13px] text-muted">{formatDay(po.createdAt)}</p>
          </div>
        </header>

        <div className="flex flex-wrap justify-between gap-4">
          <div>
            <p className="text-[13px] text-muted">To</p>
            <p className="font-semibold">{po.supplierName ?? "—"}</p>
            {po.paymentTermsDays > 0 && (
              <p className="text-[13px] text-muted">Payment terms: {po.paymentTermsDays} days</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-[13px] text-muted">Deliver to</p>
            <p className="font-semibold">{branch.name}</p>
          </div>
        </div>

        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-line text-left text-[13px] text-muted">
              <th className="py-1.5 font-medium">Item</th>
              <th className="py-1.5 text-right font-medium">Qty</th>
              <th className="py-1.5 text-right font-medium">Price</th>
              <th className="py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l) => (
              <tr key={l.id} className="border-b border-subtle">
                <td className="py-1.5">
                  {l.product} <span className="code text-[13px] text-muted">{l.code}</span>
                </td>
                <td className="num py-1.5 text-right">{l.qty}</td>
                <td className="num py-1.5 text-right">{formatTaka(l.unitPrice)}</td>
                <td className="num py-1.5 text-right">
                  {formatTaka(Math.max(l.unitPrice * l.qty - l.lineDiscount, 0))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="ml-auto flex w-full max-w-[280px] flex-col gap-1 text-[15px]">
          <Row label="Subtotal" value={po.subtotal} />
          {po.discount > 0 && <Row label="Discount" value={-po.discount} />}
          {po.charges > 0 && <Row label="Transport, labour" value={po.charges} />}
          {po.vat > 0 && <Row label="VAT" value={po.vat} />}
          <div className="flex justify-between border-t border-line pt-1 text-lg font-bold">
            <dt>Total</dt><dd className="num">{formatTaka(po.total)}</dd>
          </div>
        </dl>

        {po.note && <p className="text-[13px] text-muted">{po.note}</p>}
      </article>
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

// ---------------------------------------------------------------------------
// What to buy
// ---------------------------------------------------------------------------

function WhatToBuy({
  products, busy, run, onPlaced,
}: {
  products: Product[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onPlaced: () => void;
}) {
  const { backend, branch } = useStaff();
  const [rows, setRows] = React.useState<ReorderSuggestion[] | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [loadError, setLoadError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    backend.reorderSuggestions(branch.id, 30)
      .then((r) => { if (!cancelled) { setRows(r); setPicked(new Set(r.map((x) => x.productId))); } })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't work out what to buy.");
      });
    return () => { cancelled = true; };
  }, [backend, branch.id]);

  if (loadError) return <p role="alert" className="text-bad-ink">{loadError}</p>;
  if (!rows) return <p className="text-muted">Working it out…</p>;
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center">
        <Check className="mx-auto size-8 text-ok-ink" aria-hidden />
        <p className="font-semibold">Nothing is low at {branch.name}.</p>
        <p className="text-[13px] text-muted">
          This list is everything at or below its re-order level. Set those levels on the
          products screen to make it useful.
        </p>
      </div>
    );
  }

  const chosen = rows.filter((r) => picked.has(r.productId));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        At or below the re-order level at {branch.name}, soonest to run out first. The
        suggested quantity brings the shelf back to twice the re-order level.
      </p>

      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.productId}>
            <label className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5">
              <input
                type="checkbox"
                checked={picked.has(r.productId)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(r.productId); else next.delete(r.productId);
                  setPicked(next);
                }}
                className="size-5 accent-[var(--color-brand)]"
              />
              <span className="flex min-w-[180px] flex-1 flex-col">
                <span className="font-semibold">{r.name}</span>
                <span className="text-[13px] text-muted">
                  <span className="code">{r.code}</span> · {r.stock} left, re-order at {r.reorderLevel}
                </span>
              </span>
              <span className="flex flex-col text-right text-[13px] text-muted">
                <span>
                  {r.daysLeft == null
                    ? "none sold lately"
                    : <>about <span className="num">{r.daysLeft}</span> days left</>}
                </span>
                <span>
                  suggest <span className="num font-semibold text-ink">{r.suggestQty}</span>
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2 border-t border-subtle pt-3">
        <Button
          disabled={busy || chosen.length === 0}
          onClick={() => run(async () => {
            await backend.saveRequisition({
              branchId: branch.id,
              note: "From what to buy",
              submit: true,
              lines: chosen.map((r) => ({ productId: r.productId, qty: r.suggestQty })),
            });
            onPlaced();
          })}
        >
          <ClipboardList className="size-4" aria-hidden /> Ask for these {chosen.length}
        </Button>
        <span className="self-center text-[13px] text-muted">
          {products.length > 0 && "Prices go on the order, once you know which supplier."}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplier dues
// ---------------------------------------------------------------------------

function SupplierDues({
  suppliers, busy, run,
}: {
  suppliers: Supplier[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch, staff } = useStaff();
  const owing = suppliers.filter((s) => !s.isCashOnly);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [ledger, setLedger] = React.useState<LedgerEntry[] | null>(null);
  const [aging, setAging] = React.useState<SupplierAging | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [method, setMethod] = React.useState("cash");
  const [reference, setReference] = React.useState("");
  const [opening, setOpening] = React.useState("");
  const [openingDate, setOpeningDate] = React.useState("");
  const [showOpening, setShowOpening] = React.useState(false);

  React.useEffect(() => {
    if (!openId) { setLedger(null); setAging(null); return; }
    let cancelled = false;
    setLoadError("");
    Promise.all([backend.supplierLedger(openId), backend.supplierAging(openId)])
      .then(([l, a]) => { if (!cancelled) { setLedger(l); setAging(a); } })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load the ledger.");
      });
    return () => { cancelled = true; };
  }, [backend, openId, busy]);

  const open = owing.find((s) => s.id === openId) ?? null;
  const totalOwed = owing.reduce((n, s) => n + Math.max(s.balance, 0), 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">
        Owed to suppliers in total: <span className="num font-semibold">{formatTaka(totalOwed)}</span>
      </p>

      <ul className="flex flex-col gap-1.5">
        {owing.length === 0 && <Empty what="No suppliers with an account yet." icon={<FileText />} />}
        {owing.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => { setOpenId(openId === s.id ? null : s.id); setShowOpening(false); }}
              aria-expanded={openId === s.id}
              className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5 text-left hover:bg-subtle"
            >
              <span className="min-w-[160px] flex-1 font-semibold">{s.name}</span>
              <span className={cn("num font-semibold", s.balance > 0 && "text-warn-ink")}>
                {formatTaka(s.balance)}
              </span>
              <span className="text-[13px] text-muted">
                {s.balance > 0 ? "we owe them" : s.balance < 0 ? "they owe us" : "settled"}
              </span>
            </button>

            {openId === s.id && (
              <div className="mt-1.5 flex flex-col gap-3 rounded-lg border border-line bg-subtle p-3">
                {loadError && <p role="alert" className="text-sm text-bad-ink">{loadError}</p>}

                {aging && (
                  <div className="flex flex-wrap gap-2">
                    <Bucket label="0–30 days" value={aging.days0to30} />
                    <Bucket label="31–60 days" value={aging.days31to60} />
                    <Bucket label="60+ days" value={aging.days60plus} warn />
                    {aging.unapplied > 0 && (
                      <Bucket label="paid in advance" value={aging.unapplied} />
                    )}
                  </div>
                )}

                {ledger && (
                  ledger.length === 0 ? (
                    <p className="text-[13px] text-muted">Nothing has moved this balance yet.</p>
                  ) : (
                    <ul className="flex flex-col gap-0.5 text-[15px]">
                      {ledger.map((e, i) => (
                        <li key={`${e.at}-${i}`} className="flex flex-wrap justify-between gap-2">
                          <span>
                            <span className="text-[13px] text-muted">
                              {formatDay(e.at)}
                            </span>{" "}
                            {LEDGER_WORDS[e.kind]} · <span className="code">{e.document}</span>
                            {e.note && <span className="text-[13px] text-muted"> · {e.note}</span>}
                          </span>
                          <span className={cn("num", e.change < 0 && "text-ok-ink")}>
                            {e.change < 0 ? "−" : ""}{formatTaka(Math.abs(e.change))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )
                )}

                <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
                  <div className="flex-[1_1_140px]">
                    <Field label="Pay them">
                      <Input
                        inputMode="decimal" value={amount} className="num"
                        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                      />
                    </Field>
                  </div>
                  <div className="flex-[1_1_120px]">
                    <Field label="How">
                      <select
                        value={method}
                        onChange={(e) => setMethod(e.target.value)}
                        className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                      >
                        {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </Field>
                  </div>
                  <div className="flex-[1_1_160px]">
                    <Field label="Reference" hint="Cheque or transaction number.">
                      <Input value={reference} onChange={(e) => setReference(e.target.value)} className="num" />
                    </Field>
                  </div>
                  <Button
                    disabled={busy || !(Number(amount) > 0)}
                    onClick={() => run(async () => {
                      await backend.paySupplier({
                        branchId: branch.id, supplierId: s.id,
                        amount: Number(amount), method,
                        reference: reference || null,
                      });
                      setAmount(""); setReference("");
                    })}
                  >
                    Record the payment
                  </Button>
                  <span className="w-full text-[13px] text-muted">
                    It comes off the oldest invoices first, which is what the supplier assumes.
                  </span>
                </div>

                {staff.role === "owner" && (
                  showOpening ? (
                    <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
                      <div className="flex-[1_1_140px]">
                        <Field label="Already owed" hint="What the shop owed before it moved across.">
                          <Input
                            inputMode="decimal" value={opening} className="num"
                            onChange={(e) => setOpening(e.target.value.replace(/[^0-9.]/g, ""))}
                          />
                        </Field>
                      </div>
                      <div className="flex-[1_1_160px]">
                        <Field label="As of" hint="So it ages into the right bucket.">
                          <Input
                            type="date" value={openingDate}
                            onChange={(e) => setOpeningDate(e.target.value)}
                          />
                        </Field>
                      </div>
                      <Button
                        disabled={busy || opening === ""}
                        onClick={() => run(async () => {
                          await backend.setOpeningBalance({
                            partyKind: "supplier", partyId: s.id,
                            amount: Number(opening) || 0,
                            asOf: openingDate || null,
                          });
                          setOpening(""); setOpeningDate(""); setShowOpening(false);
                        })}
                      >
                        Save it
                      </Button>
                      <Button variant="ghost" onClick={() => setShowOpening(false)}>Cancel</Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost" size="sm" className="self-start"
                      onClick={() => setShowOpening(true)}
                    >
                      Record what was already owed
                    </Button>
                  )
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {open && (
        <p className="text-[13px] text-muted">
          Showing {open.name}. Tap the name again to close it.
        </p>
      )}
    </div>
  );
}

const LEDGER_WORDS: Record<LedgerEntry["kind"], string> = {
  opening: "Already owed", purchase: "Bought on credit",
  payment: "Paid", return: "Sent back",
};

function Bucket({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex min-w-[110px] flex-col rounded-lg border border-line bg-surface px-3 py-2">
      <span className={cn("num font-semibold", warn && value > 0 && "text-bad-ink")}>
        {formatTaka(value)}
      </span>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Pill({ status, words }: { status: string; words: string }) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-[13px] font-semibold",
        WAITING.has(status) ? "bg-warn-bg text-warn-ink"
          : status === "rejected" || status === "cancelled" ? "bg-subtle text-muted"
          : status === "received" || status === "approved" ? "bg-ok-bg text-ok-ink"
          : "bg-subtle text-ink-soft",
      )}
    >
      {words}
    </span>
  );
}

function Empty({ what, icon }: { what: string; icon: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
      <span className="mx-auto mb-2 flex size-8 items-center justify-center text-line-strong" aria-hidden>
        {icon}
      </span>
      {what}
    </p>
  );
}

function Field({
  label, hint, required, children,
}: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label} {required && <span className="font-normal text-muted">(needed)</span>}
      </Label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}
