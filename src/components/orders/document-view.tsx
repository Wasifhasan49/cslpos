"use client";

import * as React from "react";
import { Check, Printer, Truck, X } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDay, formatTaka } from "@/lib/sale";
import type { SalesDocument } from "@/lib/types";
import { cn } from "@/lib/utils";
import { statusWords } from "./orders-screen";

type Tab = "quotations" | "orders" | "challans";

/**
 * One quotation, order or delivery note, with whatever can be done to it next.
 *
 * The buttons are on the document, not on a menu somewhere else: a decision belongs
 * where the thing being decided is visible. The same reasoning as the purchase chain.
 */
export function DocumentView({ kind, id, onClose, onDone, onFail }: {
  kind: "quotation" | "order" | "challan";
  id: string;
  onClose: () => void;
  onDone: (words: string, go?: { kind: Tab; id: string }) => void;
  onFail: (e: unknown) => void;
}) {
  const { backend, staff } = useStaff();
  const [doc, setDoc] = React.useState<SalesDocument | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [asking, setAsking] = React.useState<"advance" | "lost" | "cancel" | "deliver" | "bill" | null>(null);
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [qtys, setQtys] = React.useState<Record<string, string>>({});

  const load = React.useCallback(() => {
    backend.salesDocument(kind, id).then(setDoc).catch(onFail);
  }, [backend, kind, id, onFail]);
  React.useEffect(load, [load]);

  if (!doc) return <p className="text-[15px] text-muted">Loading…</p>;

  const run = async (what: () => Promise<string>, go?: { kind: Tab; id: string }) => {
    setBusy(true);
    try {
      onDone(await what(), go);
    } catch (e) {
      onFail(e);
    } finally {
      setBusy(false);
      setAsking(null);
      setReason("");
      setAmount("");
    }
  };

  return (
    <section className="rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4">
        <div>
          <h2 className="text-[17px] font-semibold">
            <span className="code">{doc.no}</span>
          </h2>
          <p className="text-[13px] text-muted">
            {doc.customer}
            {doc.attention && ` · for the attention of ${doc.attention}`}
            {" · "}{formatDay(doc.date)} · {statusWords(doc.status)}
          </p>
          {doc.orderNo && (
            <p className="text-[13px] text-muted">
              Against order <span className="code">{doc.orderNo}</span>
            </p>
          )}
          {doc.invoiceNo && (
            <p className="text-[13px] text-good-ink">
              Billed on <span className="code">{doc.invoiceNo}</span>
            </p>
          )}
          {doc.validUntil && (
            <p className="text-[13px] text-muted">
              Prices good until <span className="num">{formatDay(doc.validUntil)}</span>
            </p>
          )}
          {doc.deliveryDate && (
            <p className="text-[13px] text-muted">
              Wanted by <span className="num">{formatDay(doc.deliveryDate)}</span>
            </p>
          )}
        </div>
        <div className="no-print flex gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Print
          </Button>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <div id="print-report">
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-line text-left text-[13px] text-muted">
                <th className="p-3 font-normal">Product</th>
                <th className="p-3 text-right font-normal">Qty</th>
                {kind === "order" && <th className="p-3 text-right font-normal">Gone</th>}
                {kind === "order" && <th className="p-3 text-right font-normal">Still to go</th>}
                {kind === "challan" && <th className="p-3 text-right font-normal">Back</th>}
                {kind === "challan" && <th className="p-3 text-right font-normal">To bill</th>}
                <th className="p-3 text-right font-normal">Price each</th>
                <th className="p-3 text-right font-normal">Amount</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={l.id} className={cn("border-b border-line/60", l.cancelled && "opacity-50")}>
                  <td className="p-3">
                    {l.product}
                    <span className="block text-[12px] text-muted">
                      <span className="code">{l.code}</span>
                      {l.isFree && " · free of charge"}
                      {l.cancelled && " · called off"}
                      {l.serials && l.serials.length > 0 && (
                        <> · {l.serials.map((s) => s.serial).join(", ")}</>
                      )}
                    </span>
                  </td>
                  <td className="p-3 text-right num">{l.qty}</td>
                  {kind === "order" && <td className="p-3 text-right num">{l.deliveredQty ?? 0}</td>}
                  {kind === "order" && (
                    <td className="p-3 text-right num">
                      {l.pendingQty ?? 0}
                      {(l.pendingQty ?? 0) > 0 && (l.inStock ?? 0) < (l.pendingQty ?? 0) && (
                        <span className="block text-[12px] text-bad-ink">
                          only {l.inStock ?? 0} free
                        </span>
                      )}
                    </td>
                  )}
                  {kind === "challan" && <td className="p-3 text-right num">{l.returnedQty ?? 0}</td>}
                  {kind === "challan" && <td className="p-3 text-right num">{l.toBill ?? 0}</td>}
                  <td className="p-3 text-right num">{formatTaka(l.unitPrice)}</td>
                  <td className="p-3 text-right num">{formatTaka(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {kind !== "challan" && (
          <div className="flex justify-end border-t border-line p-4">
            <dl className="min-w-[240px] text-[15px]">
              <Money label="Subtotal" value={doc.subtotal} />
              {doc.discountAmount > 0 && (
                <Money label={`Less discount (${doc.discountPct}%)`} value={-doc.discountAmount} />
              )}
              {doc.vatAmount > 0 && <Money label="VAT" value={doc.vatAmount} />}
              <Money label="Total" value={doc.total} strong />
              {doc.advance > 0 && (
                <>
                  <Money label="Paid up front" value={-doc.advance} />
                  <Money label="Left to pay" value={doc.total - doc.advance} strong />
                </>
              )}
            </dl>
          </div>
        )}

        {doc.terms && (
          <p className="border-t border-line p-4 text-[13px] text-muted">{doc.terms}</p>
        )}
        {doc.carrier && (
          <p className="border-t border-line p-4 text-[13px] text-muted">
            Sent with {doc.carrier}{doc.vehicleNo && ` · ${doc.vehicleNo}`}
          </p>
        )}
      </div>

      {doc.challans.length > 0 && (
        <div className="no-print border-t border-line p-4">
          <h3 className="text-[15px] font-semibold">Deliveries against this order</h3>
          <ul className="mt-1 flex flex-col gap-1 text-[14px]">
            {doc.challans.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => onDone("", { kind: "challans", id: c.id })}
                >
                  <span className="code">{c.challanNo}</span>
                  <span className="text-muted"> · {formatDay(c.date)} · {statusWords(c.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {doc.advanceWaiting > 0 && (
        <p className="no-print border-t border-line bg-subtle p-4 text-[15px]">
          {formatTaka(doc.advanceWaiting)} was taken up front on this order. Billing this
          delivery will put it against the bill.
        </p>
      )}

      {/* What can be done next, on the document itself. */}
      <div className="no-print flex flex-wrap gap-2 border-t border-line p-4">
        {kind === "quotation" && doc.status === "draft" && (
          <Button onClick={() => run(async () => {
            await backend.setQuotationStatus(doc.id, "sent");
            return `${doc.no} marked as sent.`;
          })} disabled={busy}>
            Mark as sent
          </Button>
        )}
        {kind === "quotation" && ["draft", "sent"].includes(doc.status) && (
          <>
            <Button onClick={() => run(async () => {
              await backend.setQuotationStatus(doc.id, "accepted");
              const r = await backend.saveSalesOrder(null, {
                branch_id: doc.branchId, customer_id: doc.customerId,
                quote_id: doc.id, attention: doc.attention, send: "true",
              }, doc.lines.map((l) => ({
                product_id: l.productId, qty: l.qty, is_free: l.isFree,
                unit_price: l.unitPrice,
              })));
              return r.waitingForApproval
                ? `${r.soNo} is waiting for the owner to approve it.`
                : `${r.soNo} created — the stock is now held for them.`;
            })} disabled={busy}>
              They accepted it — make an order
            </Button>
            <Button variant="ghost" onClick={() => setAsking("lost")} disabled={busy}>
              We lost it
            </Button>
          </>
        )}

        {kind === "order" && doc.status === "draft" && (
          <Button onClick={() => run(async () => {
            await backend.setOrderStatus(doc.id, "send");
            return `${doc.no} is live — the stock is held for them.`;
          })} disabled={busy}>
            Send it, and hold the stock
          </Button>
        )}
        {kind === "order" && doc.status === "awaiting_approval" && staff.role !== "cashier" && (
          <Button onClick={() => run(async () => {
            await backend.setOrderStatus(doc.id, "approve");
            return `${doc.no} approved.`;
          })} disabled={busy}>
            Approve it
          </Button>
        )}
        {kind === "order" && ["open", "part_delivered"].includes(doc.status) && (
          <>
            <Button onClick={() => setAsking("deliver")} disabled={busy}>
              <Truck className="size-4" aria-hidden /> Deliver some of it
            </Button>
            <Button variant="outline" onClick={() => setAsking("advance")} disabled={busy}>
              Take money up front
            </Button>
          </>
        )}
        {kind === "order" && !["billed", "cancelled"].includes(doc.status)
          && staff.role !== "cashier" && (
          <Button variant="ghost" onClick={() => setAsking("cancel")} disabled={busy}>
            Call it off
          </Button>
        )}

        {kind === "challan" && ["delivered", "part_billed"].includes(doc.status) && (
          <Button onClick={() => setAsking("bill")} disabled={busy}>
            Bill it
          </Button>
        )}
      </div>

      {/* The handful of things that need a figure or a reason typed. Inline, never a
          browser prompt: a dialog nobody can read later is not a record. */}
      {asking === "lost" && (
        <AskFor label="Who did they buy from, and why?" value={reason} onChange={setReason}
                action="Mark it lost" busy={busy} onCancel={() => setAsking(null)}
                onGo={() => run(async () => {
                  await backend.setQuotationStatus(doc.id, "lost", reason);
                  return `${doc.no} marked as lost. That is worth knowing.`;
                })} />
      )}
      {asking === "cancel" && (
        <AskFor label="Why is it being called off?" value={reason} onChange={setReason}
                action="Call it off" busy={busy} onCancel={() => setAsking(null)}
                onGo={() => run(async () => {
                  await backend.setOrderStatus(doc.id, "cancel", reason);
                  return `${doc.no} called off, and the stock is free again.`;
                })} />
      )}
      {asking === "advance" && (
        <AskFor label="How much are they paying now?" value={amount} onChange={setAmount}
                numeric action="Take it" busy={busy} onCancel={() => setAsking(null)}
                hint="This is the customer's money until the goods go, so it is held rather than earned."
                onGo={() => run(async () => {
                  const r = await backend.recordAdvance({
                    orderId: doc.id, amount: Number(amount) || 0, method: "cash",
                  });
                  return `${formatTaka(r.amount)} taken. ${formatTaka(r.advanceTotal)} held against this order.`;
                })} />
      )}

      {asking === "deliver" && (
        <div className="no-print border-t border-line p-4">
          <h3 className="text-[15px] font-semibold">What is going out today?</h3>
          <p className="text-[13px] text-muted">
            It comes off the shelf now, because it has gone. Bill it whenever you like.
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {doc.lines.filter((l) => !l.cancelled && (l.pendingQty ?? 0) > 0).map((l) => (
              <li key={l.id} className="flex flex-wrap items-end gap-2">
                <span className="min-w-[220px] flex-1 text-[15px]">
                  {l.product}
                  <span className="block text-[12px] text-muted">
                    {l.pendingQty} still to go · {l.inStock ?? 0} free to send
                  </span>
                </span>
                <label className="flex w-[110px] flex-col gap-1 text-[13px] text-muted">
                  Sending
                  <Input
                    inputMode="numeric" className="num"
                    value={qtys[l.id] ?? String(Math.min(l.pendingQty ?? 0, l.inStock ?? 0))}
                    onChange={(e) => setQtys((q) => ({ ...q, [l.id]: e.target.value }))}
                  />
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button
              disabled={busy}
              onClick={() => run(async () => {
                const lines = doc.lines
                  .filter((l) => !l.cancelled && (l.pendingQty ?? 0) > 0)
                  .map((l) => ({
                    product_id: l.productId,
                    order_item_id: l.id,
                    qty: Number(qtys[l.id] ?? Math.min(l.pendingQty ?? 0, l.inStock ?? 0)) || 0,
                  }))
                  .filter((l) => l.qty > 0);
                if (lines.length === 0) throw new Error("Nothing to send.");
                const r = await backend.saveChallan(doc.branchId, { order_id: doc.id }, lines);
                return `${r.challanNo} — the goods have left. Bill it when you are ready.`;
              })}
            >
              <Check className="size-4" aria-hidden /> Send it
            </Button>
            <Button variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {asking === "bill" && (
        <AskFor
          label="How much are they paying now?" value={amount} onChange={setAmount} numeric
          action="Bill it" busy={busy} onCancel={() => setAsking(null)}
          hint={doc.advanceWaiting > 0
            ? `${formatTaka(doc.advanceWaiting)} taken up front comes off the bill first.`
            : "Leave it empty to put the whole bill on their account."}
          onGo={() => run(async () => {
            const paid = Number(amount) || 0;
            const r = await backend.billChallan({
              challanId: doc.id,
              paymentMethod: paid > 0 ? "cash" : "due",
              cashReceived: paid > 0 ? paid : null,
              dueAmount: paid > 0 ? undefined : null,
            });
            return r.advanceUsed > 0
              ? `${r.invoiceNo} — ${formatTaka(r.advanceUsed)} of their advance used, ${formatTaka(r.stillOwed)} still owed.`
              : `${r.invoiceNo} — ${formatTaka(r.total)} billed.`;
          })}
        />
      )}
    </section>
  );
}

function Money({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-6 py-1", strong && "font-semibold")}>
      <dt>{label}</dt>
      <dd className="num">{formatTaka(value)}</dd>
    </div>
  );
}

function AskFor({ label, hint, value, onChange, action, busy, numeric, onGo, onCancel }: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  action: string;
  busy: boolean;
  numeric?: boolean;
  onGo: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="no-print flex flex-wrap items-end gap-2 border-t border-line p-4">
      <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[13px] text-muted">
        {label}
        <Input
          value={value}
          inputMode={numeric ? "numeric" : undefined}
          className={numeric ? "num" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {hint && <span className="text-[12px]">{hint}</span>}
      </label>
      <Button onClick={onGo} disabled={busy}>{busy ? "Working…" : action}</Button>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}
