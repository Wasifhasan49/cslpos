"use client";

import * as React from "react";
import { Minus, Plus, ScanBarcode, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { PAYMENT_METHODS, formatTaka, quickCashAmounts, warrantyLabel, type Totals } from "@/lib/sale";
import { useSale } from "@/lib/store/sale-store";
import type { Product, Staff } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  staff: Staff;
  products: Map<string, Product>;
  totals: Totals;
  blocker: string | null;
  nextInvoiceHint: string;
  submitting: boolean;
  error: string;
  pinMode: "local" | "server";
  onCheckPin: () => void;
  pinError: boolean;
  onComplete: () => void;
}

export function SalePanel({ staff, products, totals, blocker, nextInvoiceHint, submitting, error, pinMode, onCheckPin, pinError, onComplete }: Props) {
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
                  <span className="text-[13px] text-muted"><span className="num">{formatTaka(p.price)}</span> each · {warrantyLabel(p.warrantyMonths)}</span>
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

          {overLimit && !s.pinApproved && (
            <div role="alert" className="flex flex-col gap-2 rounded-[10px] border border-warn-line bg-warn-bg p-3">
              <span className="text-sm font-semibold text-warn-ink">
                {totals.discountPct}% is over your {staff.discountLimitPct}% limit. A manager needs to approve it.
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="pin" className="text-sm text-warn-ink">Manager PIN</label>
                <Input id="pin" type="password" inputMode="numeric" autoComplete="off" value={s.pin} onChange={(e) => s.setPin(e.target.value)} placeholder="••••" className="num h-10 w-28 border-warn-line" />
                <Button variant="warning" className="h-10" onClick={onCheckPin} disabled={s.pin.length < 4}>Approve</Button>
              </div>
              {pinError && <span className="text-[13px] text-bad-ink">Wrong PIN. Ask the manager to enter it.</span>}
            </div>
          )}
          {overLimit && s.pinApproved && (
            <span className="text-[13px] text-ok-ink">
              {pinMode === "local" ? "Discount approved by manager · logged" : "PIN entered · checked when the sale is saved"}
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
