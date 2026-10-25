"use client";

import * as React from "react";
import Link from "next/link";
import { Minus, Plus, ScanBarcode, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { PAYMENT_METHODS, formatTaka, quickCashAmounts, warrantyLabel, type Totals } from "@/lib/sale";
import { useSale } from "@/lib/store/sale-store";
import type { Approver, CustomerLookup, Product, Staff } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  staff: Staff;
  products: Map<string, Product>;
  totals: Totals;
  blocker: string | null;
  nextInvoiceHint: string;
  submitting: boolean;
  error: string;
  /** The customer, once a whole phone number is typed. Their price list is already
   *  applied to the prices on screen. */
  customer: CustomerLookup | null;
  /** Owners and managers who have set an approval PIN. */
  approvers: Approver[];
  checkingPin: boolean;
  /** What verify_manager_pin() said last, in plain words. */
  pinMessage: string;
  approvedBy: string | null;
  onCheckPin: () => void;
  onComplete: () => void;
}

/**
 * The price on one line, and the way to change it.
 *
 * Shown as plain text until someone taps it, because the overwhelmingly common case is
 * that the owner's price is simply correct and a row of editable boxes would invite
 * haggling that BMS's empty price list already caused.
 */
function LinePrice({ product, line }: { product: Product; line: { productId: string; unitPrice?: number | null } }) {
  const s = useSale();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  const charged = line.unitPrice ?? product.price;
  const min = product.minPrice ?? product.price;

  if (editing) {
    return (
      <form
        className="flex flex-wrap items-center gap-1.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(draft);
          s.setLinePrice(product.id, draft === "" || Number.isNaN(n) ? null : n);
          setEditing(false);
        }}
      >
        <Input
          autoFocus
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
          aria-label={`Price for ${product.name}`}
          className="num h-10 w-24"
        />
        <Button type="submit" size="sm" className="h-10">Use it</Button>
        <Button
          type="button" variant="ghost" size="sm" className="h-10"
          onClick={() => { s.setLinePrice(product.id, null); setEditing(false); }}
        >
          Reset
        </Button>
        <span className="w-full text-xs text-muted">
          {min < product.price
            ? `Down to ${formatTaka(min)} without asking. Below that needs a manager.`
            : "Any change here needs a manager."}
        </span>
      </form>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
      <span className={cn("num", charged !== product.price && "font-semibold text-warn-ink")}>
        {formatTaka(charged)}
      </span>
      {charged !== product.price && (
        <span className="num line-through">{formatTaka(product.price)}</span>
      )}
      each · {warrantyLabel(product.warrantyMonths)}
      <button
        type="button"
        onClick={() => { setDraft(String(charged)); setEditing(true); }}
        className="min-h-11 underline"
      >
        change price
      </button>
    </span>
  );
}

export function SalePanel({ staff, products, totals, blocker, nextInvoiceHint, submitting, error, customer, approvers, checkingPin, pinMessage, approvedBy, onCheckPin, onComplete }: Props) {
  const s = useSale();
  const overLimit = totals.discountPct > staff.discountLimitPct;
  const received = parseFloat(s.cashReceived);
  const showChange = s.method === "cash" && !Number.isNaN(received) && received >= totals.total && totals.total > 0;
  const methodLabel = PAYMENT_METHODS.find((m) => m.id === s.method)?.label ?? "";

  return (
    <aside aria-label="Current sale" className="flex min-w-0 max-w-[460px] flex-[1_1_380px] flex-col rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between gap-2.5 border-b border-subtle px-[18px] py-4">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">Current sale</h1>
          <span className="text-[13px] text-muted">{nextInvoiceHint}</span>
        </div>
        {s.lines.length > 0 && <Button variant="outline" size="sm" onClick={s.reset}>Clear</Button>}
      </div>

      {s.lines.length === 0 && (
        <div className="flex flex-col items-center gap-2.5 px-6 py-10 text-center text-[15px] text-muted">
          <ScanBarcode className="size-10 text-line-strong" aria-hidden />
          Scan or tap a product to start the sale.
        </div>
      )}

      <ul className="flex flex-col">
        {s.lines.map((line) => {
          const p = products.get(line.productId);
          if (!p) return null;
          const needSerial = p.isSerial && line.serialIds.length === 0;
          return (
            <li key={line.productId} className="flex flex-col gap-2.5 border-b border-subtle px-[18px] py-3.5">
              <div className="flex justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[15px] font-semibold leading-snug">{p.name}</span>
                  <LinePrice product={p} line={line} />
                </div>
                <Button variant="ghost" size="icon" aria-label={`Remove ${p.name}`} onClick={() => s.removeLine(p.id)}>
                  <X className="size-5 text-muted" />
                </Button>
              </div>

              {p.isSerial && (
                <div className="flex flex-col gap-1.5">
                  <span className={cn("text-[13px]", needSerial ? "font-semibold text-warn-ink" : "text-muted")}>
                    {needSerial ? "Tap the serial number on the box" : "Serial picked · tap more to sell another unit"}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {p.serials.map((sn) => {
                      const on = line.serialIds.includes(sn.id);
                      return (
                        <button
                          key={sn.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => s.toggleSerial(p.id, sn.id)}
                          className={cn(
                            "code h-9 rounded-lg border px-2.5 text-[13px] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus",
                            on ? "border-brand bg-brand text-white" : "border-line-strong bg-surface text-ink hover:bg-subtle",
                          )}
                        >
                          {sn.serial}
                        </button>
                      );
                    })}
                    {p.serials.length === 0 && <span className="text-[13px] text-bad-ink">No serials in stock</span>}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-2.5">
                {p.isSerial ? (
                  <span className="text-sm text-ink-soft">Qty <span className="num">{line.qty}</span></span>
                ) : (
                  <div className="flex items-center overflow-hidden rounded-lg border border-line">
                    <button type="button" aria-label="One less" onClick={() => s.changeQty(p, -1)} className="flex h-10 w-11 items-center justify-center bg-ground hover:bg-subtle">
                      <Minus className="size-4" />
                    </button>
                    <span className="num min-w-11 text-center" aria-live="polite">{line.qty}</span>
                    <button type="button" aria-label="One more" disabled={line.qty >= p.stock} onClick={() => s.changeQty(p, 1)} className="flex h-10 w-11 items-center justify-center bg-ground hover:bg-subtle disabled:opacity-40">
                      <Plus className="size-4" />
                    </button>
                  </div>
                )}
                <span className="num text-[17px] font-semibold">{formatTaka(p.price * line.qty)}</span>
              </div>
            </li>
          );
        })}
      </ul>

      {s.lines.length > 0 && (
        <div className="flex flex-col gap-4 px-[18px] py-4">
          {customer && (
            <div className="flex flex-col gap-0.5 rounded-[10px] bg-ok-bg p-3 text-[13px] text-ok-ink">
              <span className="font-semibold">{customer.name ?? customer.phone}</span>
              <span>
                {customer.priceListName
                  ? `${customer.priceListName} prices are being used`
                  : "Retail prices"}
                {customer.discountPct > 0 && ` · ${customer.discountPct}% standing discount`}
              </span>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-[1_1_130px] flex-col gap-1.5">
              <Label htmlFor="disc">Discount %</Label>
              <Input id="disc" inputMode="decimal" placeholder="0" value={s.discount} onChange={(e) => s.setDiscount(e.target.value)} className="num" />
              <span className="text-xs text-muted">Your limit: {staff.discountLimitPct}% without approval</span>
            </div>
            <div className="flex flex-[2_1_200px] flex-col gap-1.5">
              <Label htmlFor="phone">Customer mobile <span className="font-normal text-muted">(optional)</span></Label>
              <Input id="phone" type="tel" inputMode="numeric" placeholder="01XXXXXXXXX" value={s.phone} onChange={(e) => s.setPhone(e.target.value)} className="num" />
              <span className="text-xs text-muted">For warranty lookup and an SMS receipt</span>
            </div>
          </div>

          {overLimit && !s.approvalId && (
            <div role="alert" className="flex flex-col gap-2 rounded-[10px] border border-warn-line bg-warn-bg p-3">
              <span className="text-sm font-semibold text-warn-ink">
                {totals.discountPct}% is over your {staff.discountLimitPct}% limit. A manager needs to approve it.
              </span>

              {approvers.length === 0 ? (
                /* Surfaced here, at the moment it is needed, rather than as a permanent
                   link in a header that already wraps on a phone. */
                <span className="text-[13px] text-warn-ink">
                  No approval PIN has been set yet.{" "}
                  <Link href="/pin" className="font-semibold underline">Set one</Link>, then come back.
                </span>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="approver" className="text-sm text-warn-ink">Who is approving?</label>
                    <select
                      id="approver"
                      value={s.approverId ?? ""}
                      onChange={(e) => s.setApprover(e.target.value || null)}
                      className="h-11 w-full rounded-lg border border-warn-line bg-surface px-3 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-focus"
                    >
                      <option value="">Pick a manager…</option>
                      {approvers.map((a) => (
                        <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="pin" className="text-sm text-warn-ink">Their PIN</label>
                    <Input
                      id="pin" type="password" inputMode="numeric" autoComplete="off" maxLength={6}
                      value={s.pin} onChange={(e) => s.setPin(e.target.value)} placeholder="••••"
                      className="num h-11 w-28 border-warn-line"
                    />
                    <Button
                      variant="warning" className="h-11" onClick={onCheckPin}
                      disabled={s.pin.length < 4 || !s.approverId || checkingPin}
                    >
                      {checkingPin ? "Checking…" : "Approve"}
                    </Button>
                  </div>
                </>
              )}
              {pinMessage && <span className="text-[13px] font-semibold text-bad-ink">{pinMessage}</span>}
            </div>
          )}
          {overLimit && s.approvalId && (
            <span className="text-[13px] text-ok-ink">
              Approved by {approvedBy ?? "a manager"} · logged
            </span>
          )}

          <div className="flex flex-col gap-1.5 border-t border-subtle pt-3">
            <div className="flex justify-between text-[15px] text-ink-soft">
              <span>Subtotal · {totals.itemCount} {totals.itemCount === 1 ? "item" : "items"}</span>
              <span className="num">{formatTaka(totals.subtotal)}</span>
            </div>
            {totals.discountAmount > 0 && (
              <div className="flex justify-between text-[15px] text-ink-soft">
                <span>Discount {totals.discountPct}%</span><span className="num">− {formatTaka(totals.discountAmount)}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between text-[22px] font-bold">
              <span>Total</span><span className="num">{formatTaka(totals.total)}</span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span id="paylabel" className="text-sm font-semibold">Payment</span>
            <div role="group" aria-labelledby="paylabel" className="grid grid-cols-4 gap-1.5">
              {PAYMENT_METHODS.map((m) => {
                const on = s.method === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => s.setMethod(m.id)}
                    className={cn(
                      "h-12 rounded-lg text-[15px] font-semibold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus",
                      on ? "border-2 border-brand bg-ok-bg text-ok-ink" : "border border-line bg-surface text-ink hover:bg-subtle",
                    )}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {s.method === "cash" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="recv">Cash received</Label>
              <Input id="recv" inputMode="numeric" placeholder="0" value={s.cashReceived} onChange={(e) => s.setCashReceived(e.target.value)} className="num h-12 text-lg" />
              <div className="flex flex-wrap gap-1.5">
                {quickCashAmounts(totals.total).map((v, i) => (
                  <Button key={v} variant="outline" size="sm" className="num h-10" onClick={() => s.setCashReceived(String(v))}>
                    {i === 0 ? `Exact ${formatTaka(v)}` : formatTaka(v)}
                  </Button>
                ))}
              </div>
              {showChange && (
                <div className="flex items-baseline justify-between rounded-lg bg-ok-bg px-3 py-2.5">
                  <span className="text-[15px] font-semibold text-ok-ink">Give change</span>
                  <span className="num text-xl font-bold text-ok-ink">{formatTaka(received - totals.total)}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="txn">{s.method === "card" ? "Card last 4 digits" : `${methodLabel} transaction ID`}</Label>
              <Input id="txn" value={s.paymentRef} onChange={(e) => s.setPaymentRef(e.target.value)} placeholder={s.method === "card" ? "1234" : "e.g. 9JK4L2M8QX"} className="num" />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Button size="lg" className="h-[58px]" disabled={!!blocker || submitting} onClick={onComplete}>
              {submitting ? "Saving…" : `Complete sale · ${formatTaka(totals.total)}`}
            </Button>
            {error ? (
              <span role="alert" className="text-center text-[13px] font-semibold text-bad-ink">{error}</span>
            ) : blocker ? (
              <span className="text-center text-[13px] text-warn-ink">{blocker}</span>
            ) : null}
          </div>
        </div>
      )}
    </aside>
  );
}
