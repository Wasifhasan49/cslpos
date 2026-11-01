"use client";

import * as React from "react";
import {
  ArrowDownRight, ArrowUpRight, Clock, Minus, Package, TriangleAlert, Users, Wallet,
} from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { dhakaToday, formatTaka } from "@/lib/sale";
import type { Dashboard, DashboardDetailKind, DashboardDetailRow } from "@/lib/types";
import { cn, plural } from "@/lib/utils";

const METHOD_WORDS: Record<string, string> = {
  cash: "Cash", bkash: "bKash", nagad: "Nagad", card: "Card", due: "On due",
  rocket: "Rocket", bank: "Bank", cheque: "Cheque",
};

/** The watch list in plain words. An owner should not have to read event names. */
const WATCH_WORDS: Record<string, string> = {
  discount_approved: "A discount was approved",
  price_overridden: "A price was changed at the till",
  po_price_overridden: "A purchase price was overridden",
  sale_voided: "A sale was voided",
  sale_returned: "Something was returned",
  price_set: "A price was changed",
  bulk_price_change: "Prices were changed in bulk",
  credit_limit_overridden: "A credit limit was overridden",
  transfer_disputed: "A transfer arrived short",
  stock_corrected: "Stock was corrected",
  shift_closed: "A till was closed",
  cash_out: "Cash was taken out",
  opening_balance_set: "An opening balance was recorded",
};

/**
 * The screen that sells the product.
 *
 * Phone first, and in ONE round trip: on 4G in a shop, six requests is six chances to
 * be slow. Everything below comes from a single `dashboard()` call, and every headline
 * figure can be tapped to see what is behind it — a number an owner cannot open is a
 * number they have to take on trust, which is the whole complaint about BMS.
 */
export function DashboardScreen() {
  const { backend, branch, branches, staff } = useStaff();
  const [data, setData] = React.useState<Dashboard | null>(null);
  const [scope, setScope] = React.useState<string>("all");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [detail, setDetail] = React.useState<DashboardDetailKind | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    backend.dashboard(scope === "all" ? null : scope, from || null, to || null)
      .then((d) => { if (!cancelled) { setData(d); setError(""); } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the figures.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [backend, scope, from, to]);

  if (staff.role === "cashier") {
    return (
      <Main>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-ink-soft">
          The shop&rsquo;s takings and profit are the owner&rsquo;s. Your own sales are on
          the Sales screen.
        </p>
      </Main>
    );
  }

  const sameDay = data && data.from === data.to;

  return (
    <Main>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {sameDay && data.to === dhakaToday() ? "Today" : "Dashboard"}
          </h1>
          <p className="text-[13px] text-muted">
            {scope === "all" ? "Every branch" : data?.branch ?? branch.name}
            {data && !sameDay && ` · ${data.from} to ${data.to}`}
          </p>
        </div>

        {branches.length > 1 && (
          <div className="w-48">
            <Field label="Which branch">
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                <option value="all">All branches</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          </div>
        )}
      </div>

      <details className="rounded-lg border border-line bg-surface">
        <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-semibold">
          Pick some dates
        </summary>
        <div className="flex flex-wrap items-end gap-3 border-t border-subtle p-3">
          <div className="w-40">
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          </div>
          <div className="w-40">
            <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
          {(from || to) && (
            <Button variant="ghost" onClick={() => { setFrom(""); setTo(""); }}>
              Back to today
            </Button>
          )}
        </div>
      </details>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}
      {loading && !data && <p className="text-muted">Loading the figures…</p>}

      {data && (
        <>
          {/* The two numbers an owner opens the app for. */}
          <div className="grid grid-cols-2 gap-2">
            <Big
              label="Sales"
              value={data.today.sales}
              before={data.before.sales}
              weekBefore={data.weekBefore.sales}
              onTap={() => setDetail("sales")}
            />
            <Big
              label="Profit"
              value={data.today.profit}
              before={data.before.profit}
              weekBefore={data.weekBefore.profit}
              onTap={() => setDetail("profit")}
              warn={data.today.linesWithoutCost > 0
                ? `${data.today.linesWithoutCost} ${data.today.linesWithoutCost === 1 ? "line has" : "lines have"} no cost yet, so the profit is short by them.`
                : undefined}
            />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Small label="Sales made" value={String(data.today.saleCount)} />
            <Small label="Average sale" value={formatTaka(data.today.averageSale)} />
            <Small
              label="Customers owe"
              value={formatTaka(data.owed.byCustomers)}
              onTap={() => setDetail("dues")}
            />
            <Small
              label="Owed to suppliers"
              value={formatTaka(data.owed.toSuppliers)}
              onTap={() => setDetail("supplier_dues")}
            />
          </div>

          {Object.keys(data.byMethod).length > 0 && (
            <Section title="How it was paid">
              <ul className="flex flex-wrap gap-2">
                {Object.entries(data.byMethod)
                  .sort((a, b) => b[1] - a[1])
                  .map(([m, amount]) => (
                    <li key={m} className="flex min-w-[110px] flex-col rounded-lg border border-line bg-surface px-3 py-2">
                      <span className="num font-semibold">{formatTaka(amount)}</span>
                      <span className="text-xs text-muted">{METHOD_WORDS[m] ?? m}</span>
                    </li>
                  ))}
              </ul>
            </Section>
          )}

          {scope === "all" && data.branches.length > 1 && (
            <Section title="Branch by branch">
              <ul className="flex flex-col gap-1.5">
                {data.branches.map((b) => (
                  <li
                    key={b.branchId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5"
                  >
                    <button
                      type="button"
                      onClick={() => setScope(b.branchId)}
                      className="flex min-h-11 min-w-[140px] flex-1 items-center text-left font-semibold underline-offset-2 hover:underline"
                    >
                      {b.branch}
                    </button>
                    <span className="flex flex-col text-right">
                      <span className="num font-semibold">{formatTaka(b.sales)}</span>
                      <span className="text-xs text-muted">{plural(b.saleCount, "sale")}</span>
                    </span>
                    <span className="flex min-w-[100px] flex-col text-right">
                      <span className="num text-[13px] text-muted">{formatTaka(b.profit)}</span>
                      <span className="text-xs text-muted">profit</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="The summary row">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[15px] sm:grid-cols-3">
              <Pair label="Cash sales" value={data.summary.cashSales} />
              <Pair label="Credit sales" value={data.summary.creditSales} />
              <Pair label="Sales returns" value={data.summary.salesReturns} />
              <Pair label="Cash purchases" value={data.summary.cashPurchases} />
              <Pair label="Credit purchases" value={data.summary.creditPurchases} />
              <Pair label="Purchase returns" value={data.summary.purchaseReturns} />
              <Pair label="Money in" value={data.summary.moneyIn} />
              <Pair label="Money out" value={data.summary.moneyOut} />
              <div className="flex flex-col">
                <dt className="text-xs text-muted">Claims taken in</dt>
                <dd className="num font-semibold">{data.summary.claimsTaken}</dd>
              </div>
            </dl>
          </Section>

          {data.busyHours.length > 0 && <BusyHours hours={data.busyHours} />}

          {data.bestByProfit.length > 0 && (
            <Section title="Best sellers">
              <div className="flex flex-wrap gap-4">
                <div className="min-w-[240px] flex-1">
                  <p className="pb-1 text-[13px] font-semibold text-muted">By profit</p>
                  <ul className="flex flex-col gap-0.5 text-[15px]">
                    {data.bestByProfit.slice(0, 5).map((p) => (
                      <li key={p.productId} className="flex justify-between gap-3">
                        <span className="truncate">{p.product}</span>
                        <span className="num shrink-0">{formatTaka(p.profit ?? 0)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="min-w-[240px] flex-1">
                  <p className="pb-1 text-[13px] font-semibold text-muted">By quantity</p>
                  <ul className="flex flex-col gap-0.5 text-[15px]">
                    {data.bestByQty.slice(0, 5).map((p) => (
                      <li key={p.productId} className="flex justify-between gap-3">
                        <span className="truncate">{p.product}</span>
                        <span className="num shrink-0">{p.qty}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Section>
          )}

          {data.staff.length > 0 && (
            <Section title="Who sold what" icon={<Users className="size-4" aria-hidden />}>
              <ul className="flex flex-col gap-1.5">
                {data.staff.map((s) => (
                  <li
                    key={s.staffId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5"
                  >
                    <span className="min-w-[120px] flex-1 font-semibold">{s.staff}</span>
                    <span className="flex flex-col text-right">
                      <span className="num font-semibold">{formatTaka(s.sales)}</span>
                      <span className="text-xs text-muted">{plural(s.saleCount, "sale")}</span>
                    </span>
                    {s.discountGiven > 0 && (
                      <span className="flex min-w-[100px] flex-col text-right">
                        <span className="num text-[13px] text-warn-ink">
                          {formatTaka(s.discountGiven)}
                        </span>
                        <span className="text-xs text-muted">given away</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {data.lowStock.length > 0 && (
            <Section title="About to run out" icon={<Package className="size-4" aria-hidden />}>
              <ul className="flex flex-col gap-1.5">
                {data.lowStock.slice(0, 10).map((p) => (
                  <li
                    key={`${p.productId}-${p.branchId}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5"
                  >
                    <span className="flex min-w-[180px] flex-1 flex-col">
                      <span className="font-semibold">{p.product}</span>
                      <span className="text-[13px] text-muted">
                        <span className="code">{p.code}</span>
                        {scope === "all" && ` · ${p.branch}`}
                        {" · "}{p.stock} left, re-order at {p.reorderLevel}
                        {p.sold30 > 0 && ` · ${p.sold30} sold in 30 days`}
                      </span>
                      {p.elsewhere.length > 0 && (
                        <span className="text-[13px] text-ok-ink">
                          {p.elsewhere.map((e) => `${e.branch} has ${e.qty}`).join(", ")}
                        </span>
                      )}
                    </span>
                    <span className={cn("num font-semibold", p.stock === 0 && "text-bad-ink")}>
                      {p.stock}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {data.dustyStock.length > 0 && (
            <Section
              title="Money sitting on a shelf"
              icon={<Wallet className="size-4" aria-hidden />}
            >
              <p className="pb-1 text-[13px] text-muted">
                Nothing sold for 60 days or more, valued at what it cost.
              </p>
              <ul className="flex flex-col gap-1.5">
                {data.dustyStock.slice(0, 10).map((p) => (
                  <li
                    key={p.productId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5"
                  >
                    <span className="flex min-w-[180px] flex-1 flex-col">
                      <span className="font-semibold">{p.product}</span>
                      <span className="text-[13px] text-muted">
                        <span className="code">{p.code}</span> · {p.stock} on the shelf
                        {p.lastSold ? ` · last sold ${p.lastSold}` : " · never sold"}
                      </span>
                    </span>
                    <span className="num font-semibold text-warn-ink">
                      {formatTaka(p.tiedUp)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {data.watch.length > 0 && (
            <Section
              title="Worth a look"
              icon={<TriangleAlert className="size-4" aria-hidden />}
            >
              <ul className="flex flex-col gap-0.5 text-[15px]">
                {data.watch.map((w, i) => (
                  <li key={`${w.at}-${i}`} className="flex flex-wrap justify-between gap-2">
                    <span>
                      <span className="text-[13px] text-muted">
                        {new Date(w.at).toLocaleString("en-GB", {
                          day: "2-digit", month: "2-digit",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </span>{" "}
                      {WATCH_WORDS[w.action] ?? w.action}
                      {w.who && <span className="text-[13px] text-muted"> · {w.who}</span>}
                      {w.branch && <span className="text-[13px] text-muted"> · {w.branch}</span>}
                    </span>
                    <span className="text-[13px] text-muted">{watchDetail(w.details)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      {detail && (
        <DetailPanel
          kind={detail}
          branchId={scope === "all" ? null : scope}
          from={from || null}
          to={to || null}
          onClose={() => setDetail(null)}
        />
      )}
    </Main>
  );
}

/** The one or two facts from an audit entry worth putting on a list. */
function watchDetail(details: Record<string, unknown> | null): string {
  if (!details) return "";
  const bits: string[] = [];
  for (const key of ["invoice_no", "invoice", "claim_no", "transfer_no", "return_no",
                     "product", "name", "customer", "supplier"]) {
    const v = details[key];
    if (typeof v === "string" && v) { bits.push(v); break; }
  }
  for (const key of ["amount", "total", "difference", "pct", "change"]) {
    const v = details[key];
    if (typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)))) {
      bits.push(key === "pct" ? `${v}%` : formatTaka(Number(v)));
      break;
    }
  }
  if (typeof details.reason === "string" && details.reason) bits.push(details.reason);
  return bits.join(" · ");
}

function Main({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {children}
    </main>
  );
}

// ---------------------------------------------------------------------------

function Big({
  label, value, before, weekBefore, onTap, warn,
}: {
  label: string;
  value: number;
  before: number;
  weekBefore: number;
  onTap?: () => void;
  warn?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-4">
      <button
        type="button"
        onClick={onTap}
        className="flex flex-col items-start text-left"
        aria-label={`${label}: see what is behind it`}
      >
        <span className="text-[13px] text-muted">{label}</span>
        <span className="num text-[28px] font-bold leading-tight underline-offset-4 hover:underline">
          {formatTaka(value)}
        </span>
      </button>
      <div className="flex flex-col gap-0.5 text-[13px]">
        <Change now={value} then={before} what="the day before" />
        <Change now={value} then={weekBefore} what="a week ago" />
      </div>
      {warn && (
        <p className="flex items-start gap-1.5 pt-1 text-[13px] text-warn-ink">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {warn}
        </p>
      )}
    </div>
  );
}

/** Up or down on a figure, in words a person reads rather than a percentage alone. */
function Change({ now, then, what }: { now: number; then: number; what: string }) {
  if (then === 0) {
    return (
      <span className="text-muted">
        {now > 0 ? `nothing ${what}` : `nothing ${what} either`}
      </span>
    );
  }
  const diff = now - then;
  const pct = Math.round((Math.abs(diff) / Math.abs(then)) * 100);
  if (diff === 0) {
    return (
      <span className="flex items-center gap-1 text-muted">
        <Minus className="size-3.5" aria-hidden /> same as {what}
      </span>
    );
  }
  return (
    <span className={cn("flex items-center gap-1", diff > 0 ? "text-ok-ink" : "text-bad-ink")}>
      {diff > 0
        ? <ArrowUpRight className="size-3.5" aria-hidden />
        : <ArrowDownRight className="size-3.5" aria-hidden />}
      <span className="num">{pct}%</span> {diff > 0 ? "up on" : "down on"} {what}
      <span className="text-muted">({formatTaka(Math.abs(then))})</span>
    </span>
  );
}

function Small({ label, value, onTap }: { label: string; value: string; onTap?: () => void }) {
  const body = (
    <>
      <span className="num font-semibold">{value}</span>
      <span className="text-xs text-muted">{label}</span>
    </>
  );
  if (!onTap) {
    return <div className="flex flex-col rounded-lg border border-line bg-surface px-3 py-2">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onTap}
      className="flex min-h-11 flex-col items-start rounded-lg border border-line bg-surface px-3 py-2 text-left hover:bg-subtle"
    >
      {body}
    </button>
  );
}

function Section({
  title, icon, children,
}: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 pt-1 text-lg font-semibold">
        {icon}{title}
      </h2>
      {children}
    </section>
  );
}

function Pair({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num font-semibold">{formatTaka(value)}</dd>
    </div>
  );
}

/**
 * Busy hours as plain bars.
 *
 * Bars, not a line: the question is "which hour should I have two people on?", which is
 * a comparison between separate hours rather than a trend through them. And drawn as
 * divs rather than pulling in a charting library for one picture — on 4G, 90 KB of
 * JavaScript to draw nine rectangles is a bad trade.
 */
function BusyHours({ hours }: { hours: { hour: number; sales: number; count: number }[] }) {
  const peak = Math.max(...hours.map((h) => h.sales), 1);
  const label = (h: number) => {
    const am = h < 12;
    const twelve = h % 12 === 0 ? 12 : h % 12;
    return `${twelve}${am ? "am" : "pm"}`;
  };
  return (
    <Section title="When the shop is busy" icon={<Clock className="size-4" aria-hidden />}>
      <p className="pb-1 text-[13px] text-muted">Takings by hour, over the last 7 days.</p>
      <ul className="flex items-end gap-1 overflow-x-auto">
        {hours.map((h) => (
          <li key={h.hour} className="flex min-w-[36px] flex-col items-center gap-1">
            <span className="num text-[11px] text-muted">{Math.round(h.sales / 1000)}k</span>
            <div
              className="w-full rounded-t bg-brand"
              style={{ height: `${Math.max(Math.round((h.sales / peak) * 80), 3)}px` }}
              role="img"
              aria-label={`${label(h.hour)}: ${formatTaka(h.sales)} from ${plural(h.count, "sale")}`}
            />
            <span className="text-[11px] text-muted">{label(h.hour)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// What is behind a number
// ---------------------------------------------------------------------------

const DETAIL_TITLES: Record<DashboardDetailKind, string> = {
  sales: "The sales behind that figure",
  profit: "What each sale earned",
  returns: "What came back",
  dues: "Who owes the shop",
  supplier_dues: "Who the shop owes",
};

function DetailPanel({
  kind, branchId, from, to, onClose,
}: {
  kind: DashboardDetailKind;
  branchId: string | null;
  from: string | null;
  to: string | null;
  onClose: () => void;
}) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<DashboardDetailRow[] | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    backend.dashboardDetail(kind, branchId, from, to)
      .then((r) => { if (!cancelled) { setRows(r); setError(""); } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't open that.");
      });
    return () => { cancelled = true; };
  }, [backend, kind, branchId, from, to]);

  const money = (v: unknown) => formatTaka(Number(v ?? 0));

  return (
    <section className="flex flex-col gap-2 rounded-xl border-2 border-brand bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{DETAIL_TITLES[kind]}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      {error && <p role="alert" className="text-sm text-bad-ink">{error}</p>}
      {!rows ? (
        <p className="text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted">Nothing here.</p>
      ) : kind === "dues" || kind === "supplier_dues" ? (
        <ul className="flex flex-col gap-0.5 text-[15px]">
          {rows.map((r, i) => (
            <li key={String(r.id ?? i)} className="flex flex-wrap justify-between gap-2">
              <span>
                {String(r.name ?? "")}
                {r.phone ? <span className="num text-[13px] text-muted"> · {String(r.phone)}</span> : null}
                {r.company ? <span className="text-[13px] text-muted"> · {String(r.company)}</span> : null}
              </span>
              <span className="num font-semibold">{money(r.owed)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="flex flex-col gap-1 text-[15px]">
          {rows.map((r, i) => (
            <li key={String(r.id ?? i)} className="flex flex-wrap justify-between gap-2">
              <span className="min-w-[180px] flex-1">
                <span className="code">{String(r.invoice_no ?? r.return_no ?? "")}</span>
                <span className="text-[13px] text-muted">
                  {" · "}
                  {new Date(String(r.at)).toLocaleString("en-GB", {
                    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                  })}
                  {r.staff ? ` · ${String(r.staff)}` : ""}
                  {r.customer ? ` · ${String(r.customer)}` : ""}
                </span>
                {r.items ? (
                  <span className="block truncate text-[13px] text-muted">{String(r.items)}</span>
                ) : null}
              </span>
              <span className="flex shrink-0 flex-col text-right">
                <span className="num font-semibold">{money(r.total)}</span>
                {kind === "profit" && (
                  <span className="num text-[13px] text-muted">
                    {money(r.profit)} earned
                    {Number(r.lines_without_cost ?? 0) > 0 && " *"}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {kind === "profit" && rows?.some((r) => Number(r.lines_without_cost ?? 0) > 0) && (
        <p className="text-[13px] text-muted">
          * Some lines on that sale have no cost recorded yet, so what it earned is short
          by them. Fill the cost in on the delivery (Stock → Goods in).
        </p>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
    </div>
  );
}
