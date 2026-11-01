"use client";

import * as React from "react";
import { Check, FileText, Package, Plus, Truck } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { formatDay, formatTaka } from "@/lib/sale";
import type {
  AdvanceRow, ChallanRow, OrderRow, QuotationRow,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { DocumentView } from "./document-view";
import { NewDocument } from "./new-document";

type Tab = "quotations" | "orders" | "challans";

const TABS: { key: Tab; label: string; icon: React.ElementType; note: string }[] = [
  { key: "quotations", label: "Quotations", icon: FileText,
    note: "A price promised, with a date it runs out. Nothing moves until they accept it." },
  { key: "orders", label: "Orders", icon: Package,
    note: "What a customer has asked for. The stock is held for them until it goes." },
  { key: "challans", label: "Deliveries", icon: Truck,
    note: "Goods gone, on a delivery note. Bill them now or at the end of the month." },
];

/**
 * The paperwork a company order needs: quote, order, delivery note, bill.
 *
 * Any step can be skipped — an order can be billed straight out, and a delivery can
 * exist with no order behind it. The walk-in counter is untouched by all of this.
 */
export function OrdersScreen() {
  const { branch, staff } = useStaff();
  const [tab, setTab] = React.useState<Tab>("orders");
  const [open, setOpen] = React.useState<{ kind: Tab; id: string } | null>(null);
  const [adding, setAdding] = React.useState<"quotation" | "order" | null>(null);
  const [error, setError] = React.useState("");
  const [note, setNote] = React.useState("");
  const [nonce, setNonce] = React.useState(0);

  const say = (e: unknown) => setError(e instanceof Error ? e.message : "That didn't work.");
  const done = (words: string) => {
    setError("");
    setNote(words);
    setNonce((n) => n + 1);
  };

  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="no-print">
        <h1 className="text-xl font-semibold">Orders</h1>
        <p className="text-[13px] text-muted">
          {branch.name} · quote, order, deliver, bill. Any step can be skipped.
        </p>
      </div>

      <nav className="no-print -mx-1 flex gap-1 overflow-x-auto pb-1" aria-label="Sections">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => { setTab(key); setOpen(null); setAdding(null); setError(""); setNote(""); }}
            aria-current={tab === key ? "page" : undefined}
            className={cn(
              "flex min-h-[44px] shrink-0 items-center gap-2 rounded-xl px-3 text-[15px]",
              tab === key ? "bg-ink text-white" : "bg-subtle text-ink-soft hover:bg-line")}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </nav>

      {error && <p role="alert" className="no-print text-bad-ink">{error}</p>}
      {note && (
        <p className="no-print flex items-center gap-2 rounded-xl border border-good-ink/30 bg-good-bg p-3 text-[15px] text-good-ink">
          <Check className="size-5 shrink-0" aria-hidden />
          {note}
        </p>
      )}

      {open ? (
        <DocumentView
          kind={open.kind === "quotations" ? "quotation" : open.kind === "orders" ? "order" : "challan"}
          id={open.id}
          onClose={() => setOpen(null)}
          onDone={(words, go) => {
            done(words);
            if (go) setOpen(go); else setOpen(null);
          }}
          onFail={say}
        />
      ) : adding ? (
        <NewDocument
          kind={adding}
          onClose={() => setAdding(null)}
          onSaved={(kind, id, words) => {
            done(words);
            setAdding(null);
            setTab(kind === "quotation" ? "quotations" : "orders");
            setOpen({ kind: kind === "quotation" ? "quotations" : "orders", id });
          }}
          onFail={say}
        />
      ) : (
        <>
          <p className="no-print text-[13px] text-muted">
            {TABS.find((t) => t.key === tab)?.note}
          </p>
          {tab !== "challans" && (
            <div>
              <Button onClick={() => setAdding(tab === "quotations" ? "quotation" : "order")}>
                <Plus className="size-4" aria-hidden />
                {tab === "quotations" ? "New quotation" : "New order"}
              </Button>
            </div>
          )}
          {tab === "quotations" && <Quotations key={nonce} onOpen={(id) => setOpen({ kind: tab, id })} onFail={say} />}
          {tab === "orders" && <Orders key={nonce} onOpen={(id) => setOpen({ kind: tab, id })} onFail={say} />}
          {tab === "challans" && <Challans key={nonce} onOpen={(id) => setOpen({ kind: tab, id })} onFail={say} />}
          {tab === "orders" && staff.role !== "cashier" && <Advances key={`a${nonce}`} onFail={say} />}
        </>
      )}
    </main>
  );
}

function Quotations({ onOpen, onFail }: { onOpen: (id: string) => void; onFail: (e: unknown) => void }) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<QuotationRow[] | null>(null);
  React.useEffect(() => {
    backend.listQuotations().then(setRows).catch(onFail);
  }, [backend, onFail]);

  if (!rows) return <p className="text-[15px] text-muted">Loading…</p>;
  if (rows.length === 0) {
    return <Empty what="No quotations yet. Make one and send it to a company." />;
  }
  return (
    <Table head={["Quotation", "Date", "Customer", "Good until", "Total", "Where it stands"]}>
      {rows.map((q) => (
        <Row key={q.id} onClick={() => onOpen(q.id)}>
          <td className="p-3"><span className="code">{q.quoteNo}</span></td>
          <td className="p-3 num">{formatDay(q.date)}</td>
          <td className="p-3">{q.customer}</td>
          <td className="p-3 num">
            {q.validUntil ? formatDay(q.validUntil) : "—"}
            {q.outOfDate && <span className="ml-2 text-bad-ink">out of date</span>}
          </td>
          <td className="p-3 text-right num">{formatTaka(q.total)}</td>
          <td className="p-3">{statusWords(q.status)}</td>
        </Row>
      ))}
    </Table>
  );
}

function Orders({ onOpen, onFail }: { onOpen: (id: string) => void; onFail: (e: unknown) => void }) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<OrderRow[] | null>(null);
  React.useEffect(() => {
    backend.listOrders().then(setRows).catch(onFail);
  }, [backend, onFail]);

  if (!rows) return <p className="text-[15px] text-muted">Loading…</p>;
  if (rows.length === 0) return <Empty what="No orders yet." />;
  return (
    <Table head={["Order", "Wanted by", "Customer", "Ordered", "Still to go", "Total", "Where it stands"]}>
      {rows.map((o) => (
        <Row key={o.id} onClick={() => onOpen(o.id)}>
          <td className="p-3"><span className="code">{o.soNo}</span></td>
          <td className={cn("p-3 num", o.late && "text-bad-ink")}>
            {o.deliveryDate ? formatDay(o.deliveryDate) : "—"}
            {o.late && <span className="ml-2">{o.daysLate} days late</span>}
          </td>
          <td className="p-3">{o.customer}</td>
          <td className="p-3 text-right num">{o.ordered}</td>
          <td className="p-3 text-right num">{o.pending}</td>
          <td className="p-3 text-right num">
            {formatTaka(o.total)}
            {o.advance > 0 && (
              <span className="block text-[12px] text-muted">
                {formatTaka(o.advance)} paid up front
              </span>
            )}
          </td>
          <td className="p-3">{statusWords(o.status)}</td>
        </Row>
      ))}
    </Table>
  );
}

function Challans({ onOpen, onFail }: { onOpen: (id: string) => void; onFail: (e: unknown) => void }) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<ChallanRow[] | null>(null);
  React.useEffect(() => {
    backend.listChallans().then(setRows).catch(onFail);
  }, [backend, onFail]);

  if (!rows) return <p className="text-[15px] text-muted">Loading…</p>;
  if (rows.length === 0) {
    return <Empty what="Nothing has gone out on a delivery note yet." />;
  }
  return (
    <Table head={["Delivery note", "Date", "Customer", "Order", "Items", "Where it stands"]}>
      {rows.map((c) => (
        <Row key={c.id} onClick={() => onOpen(c.id)}>
          <td className="p-3"><span className="code">{c.challanNo}</span></td>
          <td className="p-3 num">{formatDay(c.date)}</td>
          <td className="p-3">{c.customer}</td>
          <td className="p-3"><span className="code">{c.orderNo ?? "—"}</span></td>
          <td className="p-3 text-right num">{c.qty}</td>
          <td className="p-3">
            {statusWords(c.status)}
            {/* Goods gone and nobody has asked for the money. The figure to chase on. */}
            {c.daysUnbilled !== null && c.daysUnbilled > 0 && (
              <span className={cn("block text-[12px]", c.daysUnbilled >= 7 ? "text-bad-ink" : "text-muted")}>
                not billed for {c.daysUnbilled} days
              </span>
            )}
          </td>
        </Row>
      ))}
    </Table>
  );
}

/** Money the shop is holding against orders it has not delivered. */
function Advances({ onFail }: { onFail: (e: unknown) => void }) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<AdvanceRow[]>([]);
  React.useEffect(() => {
    backend.listAdvances().then(setRows).catch(() => setRows([]));
  }, [backend, onFail]);

  if (rows.length === 0) return null;
  const held = rows.reduce((n, a) => n + a.amount, 0);
  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <h2 className="font-semibold">Money taken up front</h2>
      <p className="mt-1 text-[13px] text-muted">
        {formatTaka(held)} the shop is holding against orders it has not billed. It is the
        customer&rsquo;s money until the goods go.
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-[14px]">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-wrap justify-between gap-2 border-b border-line/60 py-1">
            <span>
              {a.customer} · <span className="code">{a.orderNo ?? "—"}</span>
              <span className="text-muted"> · {a.method}, {a.daysHeld} days ago</span>
            </span>
            <span className="num">{formatTaka(a.amount)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="w-full text-[15px]">
        <thead>
          <tr className="border-b border-line text-left text-[13px] text-muted">
            {head.map((h, i) => (
              <th key={h} className={cn("p-3 font-normal", i >= head.length - 3 && i !== head.length - 1 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <tr
      className="cursor-pointer border-b border-line/60 hover:bg-subtle"
      onClick={onClick}
    >
      {children}
    </tr>
  );
}

function Empty({ what }: { what: string }) {
  return (
    <p className="rounded-xl border border-dashed border-line p-6 text-[15px] text-muted">
      {what}
    </p>
  );
}

/** Plain English for every state these documents can be in. */
export function statusWords(status: string): string {
  const words: Record<string, string> = {
    draft: "Not sent yet",
    sent: "Sent to the customer",
    accepted: "They accepted it",
    expired: "Ran out of time",
    lost: "Lost",
    awaiting_approval: "Waiting for the owner",
    open: "Waiting to be delivered",
    part_delivered: "Some of it has gone",
    delivered: "All delivered, not billed",
    billed: "Billed",
    part_billed: "Part billed",
    returned: "Came back",
    cancelled: "Called off",
  };
  return words[status] ?? status;
}
