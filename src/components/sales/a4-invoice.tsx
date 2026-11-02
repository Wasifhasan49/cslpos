"use client";

import * as React from "react";
import { PrintSheet } from "@/components/print/print-sheet";
import { code128Svg, takaInWords } from "@/lib/invoice";
import { formatDay, formatTaka, phoneShown } from "@/lib/sale";
import type { SaleDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The shop's A4 bill.
 *
 * Laid out like the one the store already hands customers, down to where the boxes sit,
 * because a shop judges a printout by whether it looks like the one it files — and
 * because the people reading it (a corporate buyer's accounts department, a dealer
 * checking a delivery) know where on the page to look. What is NOT copied is the line
 * at the foot naming the software house: this is the shop's bill, nobody else's.
 *
 * Three things its own bill lacks are added, because they are the three a counter
 * actually gets asked about afterwards:
 *  - the serial numbers that went out, under the line they went out on;
 *  - the date each item's warranty runs to, rather than "1 Year" and a guess;
 *  - how it was paid and what change was given — BMS prints "PAID" without anyone
 *    having entered the cash, which is the whole reason its drawer never balances.
 */
export function A4Invoice({ sale, copy }: { sale: SaleDetail; copy?: boolean }) {
  const due = sale.dueAmount ?? 0;
  const billType = sale.status === "void" ? "VOID" : due > 0 ? "DUE" : "PAID";
  const totalQty = sale.items.reduce((n, i) => n + i.qty, 0);
  const at = new Date(sale.createdAt);
  const entryTime = at.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <PrintSheet
      align="centre"
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-6 print:border-0 print:p-0"
      footNote={
        <div className="flex flex-col gap-8">
          <p>Narration : {sale.narration ?? ""}</p>
          <div className="flex justify-between gap-8 text-[12px]">
            <p className="w-[45%] border-t border-ink pt-1">Customer Signature</p>
            <p className="w-[45%] border-t border-ink pt-1 text-right">Authorised Signature</p>
          </div>
        </div>
      }
    >
      {/* The barcode, the title and who it is for down the left; the invoice's own
          details down the right — which is where the store's bill puts them, and where
          anybody used to reading one will look. */}
      <div className="flex flex-wrap items-start gap-4 pt-1">
        <div className="flex min-w-[260px] flex-1 flex-col gap-2">
          <div className="flex flex-col items-center gap-1">
            {/* Scanned rather than typed: a customer brings the paper back and the
                counter finds the sale without reading sixteen characters off a crease. */}
            <Barcode value={sale.invoiceNo} />
            <h2 className="text-[17px] font-bold underline">Sales Invoice</h2>
            {copy && <p className="text-[12px] font-semibold tracking-wide">COPY — not the original</p>}
          </div>

          <dl className="border border-ink text-[13px]">
            <Box label="Customer" value={sale.customerName || "Cash customer"} wide />
            <Box label="Address" value={sale.customerAddress ?? ""} wide />
            {/* A made-up number is worse than a blank one: BMS would not store a trader
                without one, so most of the store's are invented. */}
            <Box label="Mobile" value={<span className="num">{phoneShown(sale.customerPhone)}</span>} wide />
            <Box label="Attention" value={sale.attention ?? ""} wide last />
          </dl>
        </div>

        <dl className="w-[300px] shrink-0 border border-ink text-[13px]">
          <Box label="Invoice No." value={<span className="code font-semibold">{sale.invoiceNo}</span>} />
          <Box label="Date" value={<span className="num">{formatDay(sale.createdAt)}</span>} />
          <Box label="Ref No" value={sale.extraFields?.["Ref No"] ?? ""} />
          <Box label="Prepared By" value={sale.staff} />
          <Box label="Entry Time" value={<span className="num">{entryTime}</span>} />
          <Box label="Bill Type" value={<span className="font-semibold">{billType}</span>} />
          <Box
            label="Payment Date"
            value={due > 0 ? "" : <span className="num">{formatDay(sale.createdAt)}</span>}
          />
          <Box label="Sales Person" value={sale.soldBy ?? sale.staff} last />
        </dl>
      </div>

      <table className="w-full border border-ink text-[13px]">
        <thead>
          <tr className="border-b border-ink text-left">
            <th className="w-10 border-r border-ink p-1 text-center font-bold">SL</th>
            <th className="border-r border-ink p-1 font-bold">Product Description</th>
            <th className="w-24 border-r border-ink p-1 text-center font-bold">Warranty</th>
            <th className="w-14 border-r border-ink p-1 text-right font-bold">Qty</th>
            <th className="w-24 border-r border-ink p-1 text-right font-bold">Price</th>
            <th className="w-28 p-1 text-right font-bold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((line, i) => (
            <tr key={line.id} className="border-b border-line">
              <td className="num border-r border-ink p-1 text-center">{i + 1}</td>
              <td className="border-r border-ink p-1">
                {line.name}
                {line.serials.length > 0 && (
                  <span className="code block text-[11px]">
                    {line.serials.length === 1 ? "Serial: " : "Serials: "}
                    {line.serials.map((x) => x.serial).join(", ")}
                  </span>
                )}
                {line.isGift && <span className="block text-[11px]">free of charge</span>}
              </td>
              <td className="border-r border-ink p-1 text-center">
                {line.warrantyUntil
                  ? <span className="num">to {formatDay(line.warrantyUntil)}</span>
                  : "N/A"}
              </td>
              <td className="num border-r border-ink p-1 text-right">{line.qty}</td>
              <td className="num border-r border-ink p-1 text-right">{formatTaka(line.unitPrice)}</td>
              <td className="num p-1 text-right">{formatTaka(line.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-start gap-4">
        <p className="flex-1 pt-1 text-[13px]">
          Taka in word : <span className="font-semibold">{takaInWords(sale.total)}</span> Only
        </p>
        <dl className="w-[300px] shrink-0 text-[13px]">
          <Sum label="Total Qty" value={<span className="num">{totalQty}</span>} />
          <Sum label="Total Amount" value={formatTaka(sale.subtotal)} />
          <Sum label="Extra Charges" value={formatTaka(sale.chargesAmount)} />
          <Sum label="VAT & AIT" value={formatTaka(sale.vatAmount)} />
          <Sum label="Less Discount" value={formatTaka(sale.discountAmount)} />
          <Sum label="Net Payable Amount" value={formatTaka(sale.total)} strong />
          {/* BMS prints "PAID" without anybody having entered the cash. This says what
              was actually handed over, which is what the drawer is checked against. */}
          <Sum label={`Paid (${methodWords(sale.paymentMethod)})`} value={formatTaka(sale.total - due)} />
          {sale.cashReceived != null && (
            <Sum label="Cash received" value={formatTaka(sale.cashReceived)} />
          )}
          {sale.changeGiven != null && sale.changeGiven > 0 && (
            <Sum label="Change given" value={formatTaka(sale.changeGiven)} />
          )}
          {due > 0 && <Sum label="On account" value={formatTaka(due)} strong />}
          {sale.paymentRef && <Sum label="Reference" value={sale.paymentRef} />}
        </dl>
      </div>

      {sale.status === "void" && (
        <p className="pt-2 text-center font-bold text-bad-ink">THIS SALE WAS VOIDED</p>
      )}
    </PrintSheet>
  );
}

/** One labelled line of a bordered box, the way the bill draws them. */
function Box({ label, value, wide, last }: {
  label: string; value: React.ReactNode; wide?: boolean; last?: boolean;
}) {
  return (
    <div className={cn("flex", !last && "border-b border-ink")}>
      <dt className={cn("shrink-0 border-r border-ink p-1 font-semibold", wide ? "w-28" : "w-32")}>
        {label}
      </dt>
      <dd className="min-w-0 flex-1 p-1">{value}</dd>
    </div>
  );
}

function Sum({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-4 py-0.5", strong && "border-t border-ink font-bold")}>
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

/** The invoice number as Code 128, drawn here rather than fetched from anywhere. */
function Barcode({ value }: { value: string }) {
  const { rects, width, height } = code128Svg(value, { module: 1.6, height: 34 });
  if (rects.length === 0) return null;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`Barcode of invoice ${value}`}
      className="max-w-full"
    >
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={0} width={r.width} height={height} fill="#000" />
      ))}
    </svg>
  );
}

const METHODS: Record<string, string> = {
  cash: "Cash", bkash: "bKash", nagad: "Nagad", card: "Card", rocket: "Rocket",
  bank: "Bank transfer", cheque: "Cheque", due: "On account",
};
const methodWords = (m: string): string => METHODS[m] ?? m;
