"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { PAYMENT_METHODS, formatDate, formatTaka } from "@/lib/sale";
import type { Receipt } from "@/lib/types";

export function ReceiptDialog({ receipt, onNewSale }: { receipt: Receipt; onNewSale: () => void }) {
  const [note, setNote] = React.useState("");
  const newSaleRef = React.useRef<HTMLButtonElement>(null);
  const method = PAYMENT_METHODS.find((m) => m.id === receipt.paymentMethod)?.label ?? receipt.paymentMethod;
  const paidLine =
    receipt.paymentMethod === "cash"
      ? `Paid in cash · ${formatTaka(receipt.total)}`
      : `Paid by ${method} · ${formatTaka(receipt.total)} · Ref ${receipt.paymentRef}`;
  const when = new Date(receipt.createdAt).toLocaleString("en-GB", {
    timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
  });

  React.useEffect(() => {
    newSaleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onNewSale(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewSale]);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-ink/55 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="done-title" className="flex max-h-[92vh] w-full max-w-[440px] flex-col overflow-auto rounded-2xl bg-surface">
        <div className="flex flex-col gap-1 bg-ok-bg px-5 py-4">
          <span id="done-title" className="text-xl font-bold text-ok-ink">Sale complete</span>
          <span className="text-sm text-ok-ink">{paidLine}</span>
        </div>

        <div id="print-receipt" className="flex flex-col gap-3 px-5 py-4 text-sm">
          <div className="flex flex-col items-center gap-0.5 text-center">
            <span className="text-base font-bold">{receipt.shopName}</span>
            {receipt.shopAddress && <span className="text-xs text-muted">{receipt.shopAddress}</span>}
            <span className="text-xs text-muted"><span className="code">{receipt.invoiceNo}</span> · {when} · {receipt.staffName}</span>
          </div>
          <div className="border-t border-dashed border-line-strong" />
          {receipt.items.map((r, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <div className="flex justify-between gap-2.5"><span className="font-semibold">{r.name}</span><span className="num">{formatTaka(r.lineTotal)}</span></div>
              <span className="num text-xs text-muted">{r.qty} × {formatTaka(r.unitPrice)}</span>
              {r.serials.length > 0 && <span className="code text-xs text-ink-soft">S/N: {r.serials.join(", ")}</span>}
              <span className="text-xs text-ok-ink">{r.warrantyUntil ? `Warranty until ${formatDate(r.warrantyUntil)}` : "No warranty"}</span>
            </div>
          ))}
          <div className="border-t border-dashed border-line-strong" />
          {receipt.discountAmount > 0 && (
            <div className="flex justify-between"><span>Discount {receipt.discountPct}%</span><span className="num">− {formatTaka(receipt.discountAmount)}</span></div>
          )}
          <div className="flex justify-between text-[17px] font-bold"><span>Total</span><span className="num">{formatTaka(receipt.total)}</span></div>
          {receipt.paymentMethod === "cash" ? (
            <div className="flex justify-between text-ink-soft">
              <span>Cash received · change</span>
              <span className="num">{formatTaka(receipt.cashReceived ?? 0)} · {formatTaka(receipt.changeGiven ?? 0)}</span>
            </div>
          ) : (
            <div className="flex justify-between text-ink-soft"><span>{method}</span><span className="num">{receipt.paymentRef}</span></div>
          )}
          {receipt.customerPhone && <div className="text-xs text-muted">Customer: <span className="num">{receipt.customerPhone}</span></div>}
          <p className="text-center text-xs text-muted">Keep this receipt for warranty claims.</p>
        </div>

        {note && <p role="status" className="mx-5 mb-3 rounded-lg bg-subtle px-3 py-2 text-sm text-ink-soft">{note}</p>}

        <div className="grid grid-cols-2 gap-2 px-5 pb-5">
          <Button variant="outline" className="h-12 font-semibold" onClick={() => window.print()}>Print receipt</Button>
          <Button
            variant="outline"
            className="h-12 font-semibold"
            disabled={!receipt.customerPhone}
            onClick={() => setNote("SMS sending isn't connected yet. It's on the next-steps list.")}
          >
            SMS receipt
          </Button>
          <Button ref={newSaleRef} size="lg" className="col-span-2 h-[52px]" onClick={onNewSale}>New sale</Button>
        </div>
      </div>
    </div>
  );
}
