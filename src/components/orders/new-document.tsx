"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatTaka } from "@/lib/sale";
import type { CustomerRow, Product } from "@/lib/types";

interface Line {
  productId: string;
  qty: string;
  unitPrice: string;
  isFree: boolean;
}

/**
 * A new quotation or order.
 *
 * Prices fill in from the customer's price list the moment one is picked, exactly as
 * they do at the counter — a quotation at a price the till will refuse is worse than no
 * quotation at all. An order shows what is free to promise, so nobody promises goods
 * another order is already holding.
 */
export function NewDocument({ kind, onClose, onSaved, onFail }: {
  kind: "quotation" | "order";
  onClose: () => void;
  onSaved: (kind: "quotation" | "order", id: string, words: string) => void;
  onFail: (e: unknown) => void;
}) {
  const { backend, branch } = useStaff();
  const [products, setProducts] = React.useState<Product[]>([]);
  const [customers, setCustomers] = React.useState<CustomerRow[]>([]);
  const [customerId, setCustomerId] = React.useState("");
  const [attention, setAttention] = React.useState("");
  const [validUntil, setValidUntil] = React.useState("");
  const [deliveryDate, setDeliveryDate] = React.useState("");
  const [terms, setTerms] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const list = customers.find((c) => c.id === customerId)?.priceListId ?? null;
    backend.listProducts(branch.id, list).then(setProducts).catch(onFail);
  }, [backend, branch.id, customerId, customers, onFail]);

  React.useEffect(() => {
    backend.listCustomers().then(setCustomers).catch(onFail);
  }, [backend, onFail]);

  const add = () => setLines((xs) => [...xs, { productId: "", qty: "1", unitPrice: "", isFree: false }]);
  const change = (i: number, patch: Partial<Line>) =>
    setLines((xs) => xs.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const priceOf = (productId: string): number =>
    products.find((p) => p.id === productId)?.price ?? 0;

  const total = lines.reduce((n, l) => {
    if (!l.productId) return n;
    const unit = l.isFree ? 0 : (l.unitPrice === "" ? priceOf(l.productId) : Number(l.unitPrice) || 0);
    return n + unit * (Number(l.qty) || 0);
  }, 0);

  const save = async (send: boolean) => {
    setBusy(true);
    try {
      const body = lines
        .filter((l) => l.productId && Number(l.qty) > 0)
        .map((l) => ({
          product_id: l.productId,
          qty: Number(l.qty),
          is_free: l.isFree,
          ...(l.unitPrice === "" || l.isFree ? {} : { unit_price: Number(l.unitPrice) }),
        }));
      if (body.length === 0) throw new Error("Add at least one product.");

      if (kind === "quotation") {
        const r = await backend.saveQuotation(null, {
          branch_id: branch.id,
          customer_id: customerId || null,
          attention: attention || null,
          valid_until: validUntil || null,
          terms: terms || null,
        }, body);
        if (send) await backend.setQuotationStatus(r.id, "sent");
        onSaved("quotation", r.id, `${r.quoteNo} saved${send ? " and marked as sent" : ""}.`);
      } else {
        const r = await backend.saveSalesOrder(null, {
          branch_id: branch.id,
          customer_id: customerId || null,
          attention: attention || null,
          delivery_date: deliveryDate || null,
          terms: terms || null,
          send: send ? "true" : "false",
        }, body);
        onSaved("order", r.id, r.waitingForApproval
          ? `${r.soNo} is waiting for the owner to approve it.`
          : `${r.soNo} saved${send ? " — the stock is now held for them" : ""}.`);
      }
    } catch (e) {
      onFail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-line bg-white">
      <div className="flex items-start justify-between gap-3 border-b border-line p-4">
        <div>
          <h2 className="font-semibold">
            {kind === "quotation" ? "New quotation" : "New order"}
          </h2>
          <p className="text-[13px] text-muted">
            {kind === "quotation"
              ? "Prices come from the customer's own list. Nothing moves until they accept."
              : "Saving and sending holds the stock for this customer until it goes."}
          </p>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close">
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="flex flex-wrap gap-3 p-4">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px] text-muted">
          Customer
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-[15px]"
          >
            <option value="">
              {kind === "order" ? "Pick one — an order needs a name" : "Not on the list yet"}
            </option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name || c.phone}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[160px] flex-col gap-1 text-[13px] text-muted">
          Attention
          <Input value={attention} onChange={(e) => setAttention(e.target.value)}
                 placeholder="Mr Haque" />
        </label>
        {kind === "quotation" ? (
          <label className="flex flex-col gap-1 text-[13px] text-muted">
            Good until
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-[13px] text-muted">
            Wanted by
            <Input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
          </label>
        )}
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[13px] text-muted">
          Terms
          <Input value={terms} onChange={(e) => setTerms(e.target.value)}
                 placeholder="30 days from delivery" />
        </label>
      </div>

      <div className="border-t border-line p-4">
        {lines.length === 0 && (
          <p className="text-[15px] text-muted">Nothing on it yet.</p>
        )}
        <ul className="flex flex-col gap-2">
          {lines.map((l, i) => {
            const product = products.find((p) => p.id === l.productId);
            const free = product ? Math.max(product.stock - (product.reserved ?? 0), 0) : 0;
            return (
              <li key={i} className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[13px] text-muted">
                  Product
                  <select
                    value={l.productId}
                    onChange={(e) => change(i, { productId: e.target.value, unitPrice: "" })}
                    className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-[15px]"
                  >
                    <option value="">Pick one</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex w-[90px] flex-col gap-1 text-[13px] text-muted">
                  Qty
                  <Input inputMode="numeric" value={l.qty} className="num"
                         onChange={(e) => change(i, { qty: e.target.value })} />
                </label>
                <label className="flex w-[120px] flex-col gap-1 text-[13px] text-muted">
                  Price each
                  <Input
                    inputMode="numeric" className="num" disabled={l.isFree}
                    value={l.isFree ? "0" : l.unitPrice}
                    placeholder={product ? String(product.price) : ""}
                    onChange={(e) => change(i, { unitPrice: e.target.value })}
                  />
                </label>
                <label className="flex min-h-[44px] items-center gap-2 text-[14px]">
                  <input type="checkbox" checked={l.isFree}
                         onChange={(e) => change(i, { isFree: e.target.checked })} />
                  Free
                </label>
                {product && kind === "order" && (
                  <span className="min-h-[44px] pt-3 text-[13px] text-muted">
                    {free} free to promise
                    {(product.reserved ?? 0) > 0 && ` · ${product.reserved} already held`}
                  </span>
                )}
                <Button variant="ghost" onClick={() => setLines((xs) => xs.filter((_, n) => n !== i))}
                        aria-label="Take this line off">
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
        <Button variant="outline" className="mt-3" onClick={add}>
          <Plus className="size-4" aria-hidden /> Add a line
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4">
        <p className="text-[17px] font-semibold">
          Total <span className="num">{formatTaka(total)}</span>
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => save(false)} disabled={busy}>
            Save as a draft
          </Button>
          <Button onClick={() => save(true)} disabled={busy}>
            {busy ? "Saving…" : kind === "quotation" ? "Save and mark as sent" : "Save and hold the stock"}
          </Button>
        </div>
      </div>
    </section>
  );
}
