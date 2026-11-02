"use client";

import * as React from "react";
import {
  Check as CheckIcon, Copy, HandCoins, Pencil, Plus, Printer, Search, TriangleAlert, Users,
} from "lucide-react";
import { PrintSheet } from "@/components/print/print-sheet";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatDay, formatTaka } from "@/lib/sale";
import type {
  CustomerGroup, CustomerRow, CustomerStatement, DueRow, PaymentReceipt, PriceList,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Distribution } from "./distribution-tab";

type Tab = "people" | "dues" | "groups" | "dealers";

const TABS: { key: Tab; label: string; feature?: string }[] = [
  { key: "people", label: "Customers" },
  { key: "dues", label: "Who owes what" },
  { key: "groups", label: "Groups" },
  // Only for a shop that sells through reps and dealers (P14c).
  { key: "dealers", label: "Dealers and reps", feature: "distribution" },
];

const COLLECT_METHODS = ["cash", "bkash", "nagad", "card", "bank", "cheque"];

const METHOD_WORDS: Record<string, string> = {
  cash: "Cash", bkash: "bKash", nagad: "Nagad", card: "Card", rocket: "Rocket",
  bank: "Bank transfer", cheque: "Cheque", store_credit: "Store credit",
  reduce_due: "Off their due",
};

export function CustomersScreen() {
  const { backend, staff, features } = useStaff();
  const [tab, setTab] = React.useState<Tab>("people");
  const [groups, setGroups] = React.useState<CustomerGroup[]>([]);
  const [priceLists, setPriceLists] = React.useState<PriceList[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [g, l] = await Promise.all([
          backend.listCustomerGroups(),
          backend.listPriceLists().catch(() => [] as PriceList[]),
        ]);
        if (cancelled) return;
        setGroups(g);
        setPriceLists(l);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the customers.");
      }
    })();
    return () => { cancelled = true; };
  }, [backend, nonce]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); setNonce((n) => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't save."); }
    finally { setBusy(false); }
  };

  const isManager = staff.role !== "cashier";

  return (
    <Main>
      <div>
        <h1 className="text-xl font-semibold">Customers</h1>
        <p className="text-[13px] text-muted">
          {isManager
            ? "Who buys from the shop, what they owe, and on what terms."
            : "Put a name to a phone number so warranty claims and dues can be traced."}
        </p>
      </div>

      {isManager && (
        <nav aria-label="Customer sections" className="flex gap-1 overflow-x-auto border-b border-line">
          {TABS.filter((t) => !t.feature || features[t.feature]).map((t) => (
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
      )}

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {(tab === "people" || !isManager) && (
        <People
          key={nonce} groups={groups} priceLists={priceLists} busy={busy} run={run}
        />
      )}
      {tab === "dues" && isManager && <Dues key={nonce} busy={busy} run={run} />}
      {tab === "groups" && isManager && (
        <Groups groups={groups} priceLists={priceLists} busy={busy} run={run} />
      )}
      {tab === "dealers" && isManager && features.distribution && (
        <Distribution key={nonce} busy={busy} run={run} />
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
// The customer list
// ---------------------------------------------------------------------------

function People({
  groups, priceLists, busy, run,
}: {
  groups: CustomerGroup[];
  priceLists: PriceList[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, staff } = useStaff();
  const [rows, setRows] = React.useState<CustomerRow[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomerRow | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState("");

  const load = React.useCallback(async (q: string) => {
    try {
      setRows(await backend.listCustomers(q.trim() || null));
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load the customers.");
    }
  }, [backend]);

  React.useEffect(() => { void load(""); }, [load]);

  const isManager = staff.role !== "cashier";

  if (loadError) return <p role="alert" className="text-bad-ink">{loadError}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <form
          className="flex min-w-[240px] flex-[2_1_280px] items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); void load(query); }}
        >
          <div className="flex-1">
            <Field label="Find a customer" hint="A phone, a name or a company.">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} className="h-12" />
            </Field>
          </div>
          <Button type="submit" size="lg"><Search className="size-4" aria-hidden /> Search</Button>
        </form>
        {!adding && !editing && (
          <Button onClick={() => { setAdding(true); setEditing(null); }}>
            <Plus className="size-4" aria-hidden /> Add a customer
          </Button>
        )}
      </div>

      {(adding || editing) && (
        <CustomerForm
          customer={editing}
          groups={groups}
          priceLists={priceLists}
          canSetCredit={isManager}
          busy={busy}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSave={async (values) => {
            await run(async () => {
              await backend.saveCustomer(editing?.id ?? null, values);
              await load(query);
            });
            setAdding(false);
            setEditing(null);
          }}
        />
      )}

      {!rows ? (
        <p className="text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
          <Users className="mx-auto mb-2 size-8 text-line-strong" aria-hidden />
          {query.trim() ? "Nobody matches that." : "No customers yet. They get added as sales are rung up with a phone number."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((c) => (
            <li key={c.id} className="rounded-lg border border-line bg-surface">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <span className="flex min-w-[180px] flex-1 flex-col">
                  <span className="font-semibold">
                    {c.name}
                    {!c.active && <span className="ml-2 text-[13px] font-normal text-warn-ink">turned off</span>}
                  </span>
                  <span className="text-[13px] text-muted">
                    <span className="num">{c.phone}</span>
                    {c.company && ` · ${c.company}`}
                    {c.group && ` · ${c.group}`}
                    {c.priceList && ` · ${c.priceList} prices`}
                    {c.discountPct > 0 && ` · ${c.discountPct}% standing discount`}
                  </span>
                </span>
                {c.owed > 0 ? (
                  <span className="flex flex-col text-right">
                    <span className="num font-semibold text-warn-ink">{formatTaka(c.owed)}</span>
                    <span className="text-xs text-muted">owed</span>
                  </span>
                ) : c.creditAllowed ? (
                  <span className="text-[13px] text-muted">
                    {c.creditLimit > 0
                      ? <>limit <span className="num">{formatTaka(c.creditLimit)}</span></>
                      : "credit, no limit"}
                  </span>
                ) : null}
                <span className="flex gap-1.5">
                  {isManager && (
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => setOpenId(openId === c.id ? null : c.id)}
                    >
                      {openId === c.id ? "Hide" : "Open"}
                    </Button>
                  )}
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => { setEditing(c); setAdding(false); }}
                  >
                    <Pencil className="size-4" aria-hidden /> Change
                  </Button>
                </span>
              </div>
              {openId === c.id && (
                <Statement customerId={c.id} busy={busy} run={run} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CustomerForm({
  customer, groups, priceLists, canSetCredit, busy, onSave, onCancel,
}: {
  customer: CustomerRow | null;
  groups: CustomerGroup[];
  priceLists: PriceList[];
  canSetCredit: boolean;
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [f, setF] = React.useState({
    phone: customer?.phone ?? "",
    name: customer?.name ?? "",
    company: customer?.company ?? "",
    address: customer?.address ?? "",
    bin_vat: customer?.binVat ?? "",
    nid: customer?.nid ?? "",
    note: customer?.note ?? "",
    group_id: customer?.groupId ?? "",
    price_list_id: customer?.priceListId ?? "",
    discount_pct: String(customer?.discountPct ?? 0),
    credit_allowed: customer?.creditAllowed ?? false,
    credit_limit: String(customer?.creditLimit ?? 0),
    payment_days: String(customer?.paymentDays ?? 0),
    active: customer?.active ?? true,
  });

  const group = groups.find((g) => g.id === f.group_id);

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const values: Record<string, unknown> = {
          phone: f.phone.trim(),
          name: f.name.trim() || null,
          company: f.company || null,
          address: f.address || null,
          bin_vat: f.bin_vat || null,
          nid: f.nid || null,
          note: f.note || null,
        };
        // The credit and pricing fields are only sent when this person may set them;
        // sending them anyway would have the database refuse the whole save.
        if (canSetCredit) {
          Object.assign(values, {
            group_id: f.group_id || null,
            price_list_id: f.price_list_id || null,
            discount_pct: Number(f.discount_pct) || 0,
            credit_allowed: f.credit_allowed,
            credit_limit: Number(f.credit_limit) || 0,
            payment_days: Number(f.payment_days) || 0,
            active: f.active,
          });
        }
        onSave(values);
      }}
    >
      <h2 className="font-semibold">{customer ? customer.name : "New customer"}</h2>

      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_180px]">
          <Field label="Mobile" required hint="11 digits, starting 01. This is how the shop finds them again.">
            <Input
              value={f.phone}
              onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, "").slice(0, 11) })}
              className="num" required
            />
          </Field>
        </div>
        <div className="flex-[2_1_220px]">
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex-[2_1_220px]">
          <Field label="Company" hint="For a corporate buyer.">
            <Input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          </Field>
        </div>
        <div className="flex-[2_1_220px]">
          <Field label="Address">
            <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_180px]">
          <Field label="BIN" hint="VAT registration, for a corporate invoice.">
            <Input value={f.bin_vat} onChange={(e) => setF({ ...f, bin_vat: e.target.value })} className="code" />
          </Field>
        </div>
        <div className="flex-[1_1_180px]">
          <Field label="NID">
            <Input value={f.nid} onChange={(e) => setF({ ...f, nid: e.target.value })} className="num" />
          </Field>
        </div>
      </div>

      {canSetCredit && (
        <>
          <div className="flex flex-wrap gap-3">
            <div className="flex-[1_1_180px]">
              <Field label="Group" hint="A group can carry the price list and the terms.">
                <select
                  value={f.group_id}
                  onChange={(e) => setF({ ...f, group_id: e.target.value })}
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                >
                  <option value="">None</option>
                  {groups.filter((g) => g.active).map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex-[1_1_180px]">
              <Field
                label="Price list"
                hint={group?.priceListId
                  ? `Leave empty to use the group's (${priceLists.find((l) => l.id === group.priceListId)?.name ?? "its list"}).`
                  : "Leave empty for the shop's normal prices."}
              >
                <select
                  value={f.price_list_id}
                  onChange={(e) => setF({ ...f, price_list_id: e.target.value })}
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                >
                  <option value="">From the group</option>
                  {priceLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="flex-[1_1_140px]">
              <Field label="Standing discount %" hint="Applies with no approval: the owner granted it.">
                <Input
                  inputMode="decimal" value={f.discount_pct}
                  onChange={(e) => setF({ ...f, discount_pct: e.target.value.replace(/[^0-9.]/g, "") })}
                  className="num"
                />
              </Field>
            </div>
          </div>

          <Check
            label="Can buy on due"
            hint="Without this, nothing of theirs can be left unpaid at the till."
            checked={f.credit_allowed}
            onChange={(v) => setF({ ...f, credit_allowed: v })}
          />
          {f.credit_allowed && (
            <div className="flex flex-wrap gap-3">
              <div className="flex-[1_1_160px]">
                <Field label="Credit limit" hint="0 means no ceiling — a decision worth making on purpose.">
                  <Input
                    inputMode="numeric" value={f.credit_limit}
                    onChange={(e) => setF({ ...f, credit_limit: e.target.value.replace(/\D/g, "") })}
                    className="num"
                  />
                </Field>
              </div>
              <div className="flex-[1_1_160px]">
                <Field label="Days to pay" hint="Used to tell overdue from merely outstanding.">
                  <Input
                    inputMode="numeric" value={f.payment_days}
                    onChange={(e) => setF({ ...f, payment_days: e.target.value.replace(/\D/g, "") })}
                    className="num"
                  />
                </Field>
              </div>
            </div>
          )}
        </>
      )}

      <Field label="Note">
        <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </Field>

      {canSetCredit && customer && (
        <Check label="In use" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || f.phone.length !== 11}>
          {busy ? "Saving…" : customer ? "Save" : "Add customer"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        {f.phone.length > 0 && f.phone.length !== 11 && (
          <span className="self-center text-[13px] text-warn-ink">
            A mobile number is 11 digits.
          </span>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// One customer, in full
// ---------------------------------------------------------------------------

function Statement({
  customerId, busy, run,
}: {
  customerId: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch } = useStaff();
  const [st, setSt] = React.useState<CustomerStatement | null>(null);
  const [error, setError] = React.useState("");
  const [collecting, setCollecting] = React.useState(false);
  const [receipt, setReceipt] = React.useState<PaymentReceipt | null>(null);
  const [printing, setPrinting] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    backend.customerStatement(customerId)
      .then((d) => { if (!cancelled) { setSt(d); setError(""); } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't open that customer.");
      });
    return () => { cancelled = true; };
  }, [backend, customerId, nonce]);

  if (error) return <p role="alert" className="border-t border-subtle px-3 py-3 text-bad-ink">{error}</p>;
  if (!st) return <p className="border-t border-subtle px-3 py-3 text-muted">Loading…</p>;

  if (printing) return <StatementPrint st={st} onBack={() => setPrinting(false)} />;

  return (
    <div className="flex flex-col gap-3 border-t border-subtle px-3 py-3">
      {receipt && (
        <div className="flex flex-col gap-1 rounded-lg bg-ok-bg p-3 text-ok-ink">
          <p className="flex items-center gap-2 font-semibold">
            <CheckIcon className="size-5" aria-hidden /> Receipt {receipt.receiptNo}
          </p>
          <p className="text-[15px]">
            <span className="num">{formatTaka(receipt.amount)}</span> taken from{" "}
            {receipt.customer}. They owed <span className="num">{formatTaka(receipt.wasOwed)}</span>;
            now <span className="num">{formatTaka(receipt.owed)}</span>.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Bucket label="Owed now" value={st.owed} warn={st.owed > 0} />
        <Bucket label="0–30 days" value={st.aging.days0to30} />
        <Bucket label="31–60 days" value={st.aging.days31to60} />
        <Bucket label="60+ days" value={st.aging.days60plus} warn />
        {st.aging.overdue > 0 && (
          <Bucket label={`past ${st.paymentDays} days`} value={st.aging.overdue} warn />
        )}
        {st.aging.inCredit > 0 && <Bucket label="paid in advance" value={st.aging.inCredit} />}
      </div>

      <p className="text-[13px] text-muted">
        {st.saleCount} {st.saleCount === 1 ? "sale" : "sales"} ·{" "}
        <span className="num">{formatTaka(st.totalSpent)}</span> spent in total
        {st.creditAllowed && (
          <>
            {" · "}credit{" "}
            {st.creditLimit > 0 ? <>up to <span className="num">{formatTaka(st.creditLimit)}</span></> : "with no limit"}
            {st.paymentDays > 0 && `, ${st.paymentDays} days to pay`}
          </>
        )}
      </p>
      {st.note && <p className="text-[13px] text-muted">{st.note}</p>}

      {st.entries.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[15px]">
          {st.entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex flex-wrap justify-between gap-2">
              <span>
                <span className="text-[13px] text-muted">
                  {formatDay(e.at)}
                </span>{" "}
                {e.kind === "opening" ? "Already owed"
                  : e.kind === "sale" ? "Bought on due"
                  : e.kind === "payment" ? "Paid" : "Returned"}
                {" · "}<span className="code">{e.document}</span>
                {e.note && <span className="text-[13px] text-muted"> · {e.note}</span>}
              </span>
              <span className={cn("num", e.change < 0 && "text-ok-ink")}>
                {e.change < 0 ? "−" : ""}{formatTaka(Math.abs(e.change))}
              </span>
            </li>
          ))}
        </ul>
      )}

      {st.owns.length > 0 && (
        <div>
          <p className="text-[13px] font-semibold">What they own</p>
          <ul className="flex flex-col gap-0.5 text-[15px]">
            {st.owns.map((o) => (
              <li key={o.serial} className="flex flex-wrap justify-between gap-2">
                <span>
                  {o.product} <span className="code text-[13px] text-muted">{o.serial}</span>
                  <span className="text-[13px] text-muted"> · bought {o.bought}</span>
                </span>
                <span className={cn("text-[13px]", o.inWarranty ? "text-ok-ink" : "text-muted")}>
                  {o.warrantyUntil
                    ? o.inWarranty ? `in warranty to ${o.warrantyUntil}` : `warranty ended ${o.warrantyUntil}`
                    : "no warranty"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {collecting ? (
        <CollectForm
          owed={st.owed}
          busy={busy}
          onCancel={() => setCollecting(false)}
          onCollect={(amount, method, reference) => run(async () => {
            const r = await backend.collectPayment({
              branchId: branch.id, customerId, amount, method, reference,
            });
            setReceipt(r);
            setCollecting(false);
            setNonce((n) => n + 1);
          })}
        />
      ) : (
        <div className="flex flex-wrap gap-2 border-t border-subtle pt-3">
          {st.owed > 0 && (
            <Button size="sm" onClick={() => setCollecting(true)}>
              <HandCoins className="size-4" aria-hidden /> Take a payment
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setPrinting(true)}>
            <Printer className="size-4" aria-hidden /> Statement
          </Button>
          {st.owed > 0 && <RemindButton st={st} />}
        </div>
      )}
    </div>
  );
}

/** SMS comes in P15. Until then the message is ready to paste into whatever they use. */
function RemindButton({ st }: { st: CustomerStatement }) {
  const [copied, setCopied] = React.useState(false);
  const message =
    `Dear ${st.name}, our records show ${formatTaka(st.owed)} outstanding`
    + (st.aging.overdue > 0 ? `, of which ${formatTaka(st.aging.overdue)} is past due` : "")
    + `. Please contact us to settle. Thank you.`;

  return (
    <Button
      variant="ghost" size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(message);
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        } catch {
          setCopied(false);
        }
      }}
    >
      <Copy className="size-4" aria-hidden />
      {copied ? "Copied — paste it into SMS" : "Copy a reminder"}
    </Button>
  );
}

function CollectForm({
  owed, busy, onCollect, onCancel,
}: {
  owed: number;
  busy: boolean;
  onCollect: (amount: number, method: string, reference: string | null) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = React.useState(String(Math.round(owed)));
  const [method, setMethod] = React.useState("cash");
  const [reference, setReference] = React.useState("");
  const taking = Number(amount) || 0;

  return (
    <form
      className="flex flex-wrap items-end gap-3 border-t border-subtle pt-3"
      onSubmit={(e) => { e.preventDefault(); onCollect(taking, method, reference || null); }}
    >
      <div className="w-40">
        <Field label="How much">
          <Input
            autoFocus inputMode="numeric" value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            className="num h-12 text-lg"
          />
        </Field>
      </div>
      <Button
        type="button" variant="ghost" size="sm" className="mb-1"
        onClick={() => setAmount(String(Math.round(owed)))}
      >
        All of it: {formatTaka(owed)}
      </Button>
      <div className="w-36">
        <Field label="How">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
          >
            {COLLECT_METHODS.map((m) => (
              <option key={m} value={m}>{METHOD_WORDS[m] ?? m}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="w-44">
        <Field label="Reference" hint="Cheque or transaction number.">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} className="num" />
        </Field>
      </div>
      <Button type="submit" disabled={busy || taking <= 0}>Take the payment</Button>
      <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      {taking > owed && (
        <p className="w-full text-[13px] text-muted">
          That is more than they owe. The extra stays on their account as credit.
        </p>
      )}
      <p className="w-full text-[13px] text-muted">
        It comes off the oldest invoice first, which is what the customer assumes.
      </p>
    </form>
  );
}

function StatementPrint({ st, onBack }: { st: CustomerStatement; onBack: () => void }) {
  let running = 0;
  return (
    <div className="flex flex-col gap-3 border-t border-subtle px-3 py-3">
      <div className="no-print flex flex-wrap gap-2">
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden /> Print
        </Button>
        <Button variant="ghost" onClick={onBack}>Back</Button>
      </div>

      <PrintSheet
        title="Customer Statement"
        subtitle={`As on ${formatDay(new Date())}`}
        aside={<>
          <p className="font-semibold">{st.name}</p>
          <p className="num">{st.phone}</p>
          {st.company && <p>{st.company}</p>}
          {st.binVat && <p className="code">BIN {st.binVat}</p>}
        </>}
        className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6 print:border-0 print:p-0"
      >
        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-line text-left text-[13px] text-muted">
              <th className="py-1.5 font-medium">Date</th>
              <th className="py-1.5 font-medium">What</th>
              <th className="py-1.5 text-right font-medium">Owed</th>
              <th className="py-1.5 text-right font-medium">Paid</th>
              <th className="py-1.5 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {st.entries.map((e, i) => {
              running += e.change;
              return (
                <tr key={`${e.at}-${i}`} className="border-b border-subtle">
                  <td className="py-1.5 text-[13px]">
                    {formatDay(e.at)}
                  </td>
                  <td className="py-1.5">
                    <span className="code text-[13px]">{e.document}</span>
                    {e.note && <span className="text-[13px] text-muted"> · {e.note}</span>}
                  </td>
                  <td className="num py-1.5 text-right">
                    {e.change > 0 ? formatTaka(e.change) : ""}
                  </td>
                  <td className="num py-1.5 text-right">
                    {e.change < 0 ? formatTaka(-e.change) : ""}
                  </td>
                  <td className="num py-1.5 text-right">{formatTaka(running)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="ml-auto flex w-full max-w-[280px] flex-col gap-1 text-[15px]">
          <div className="flex justify-between border-t border-line pt-1 text-lg font-bold">
            <span>Outstanding</span><span className="num">{formatTaka(st.owed)}</span>
          </div>
          {st.aging.overdue > 0 && (
            <div className="flex justify-between text-[13px] text-bad-ink">
              <span>Past {st.paymentDays} days</span>
              <span className="num">{formatTaka(st.aging.overdue)}</span>
            </div>
          )}
        </div>
      </PrintSheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who owes what
// ---------------------------------------------------------------------------

function Dues({
  busy, run,
}: {
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<DueRow[] | null>(null);
  const [error, setError] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    backend.dueList(null)
      .then((r) => { if (!cancelled) { setRows(r); setError(""); } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the dues.");
      });
    return () => { cancelled = true; };
  }, [backend]);

  if (error) return <p role="alert" className="text-bad-ink">{error}</p>;
  if (!rows) return <p className="text-muted">Loading…</p>;
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
        <CheckIcon className="mx-auto mb-2 size-8 text-ok-ink" aria-hidden />
        Nobody owes the shop anything.
      </p>
    );
  }

  const total = rows.reduce((n, r) => n + r.owed, 0);
  const overdue = rows.reduce((n, r) => n + r.overdue, 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">
        Owed to the shop: <span className="num font-semibold">{formatTaka(total)}</span>
        {overdue > 0 && (
          <> · <span className="num font-semibold text-bad-ink">{formatTaka(overdue)}</span> of it past due</>
        )}
      </p>

      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.customerId} className="rounded-lg border border-line bg-surface">
            <button
              type="button"
              onClick={() => setOpenId(openId === r.customerId ? null : r.customerId)}
              aria-expanded={openId === r.customerId}
              className="flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left hover:bg-subtle"
            >
              <span className="flex min-w-[170px] flex-1 flex-col">
                <span className="font-semibold">{r.name}</span>
                <span className="text-[13px] text-muted">
                  <span className="num">{r.phone}</span>
                  {r.company && ` · ${r.company}`}
                  {r.group && ` · ${r.group}`}
                  {r.oldestDue && ` · oldest ${r.oldestDue}`}
                  {r.lastPaid && ` · last paid ${formatDay(r.lastPaid)}`}
                </span>
              </span>
              <span className="flex flex-col text-right">
                <span className="num font-semibold">{formatTaka(r.owed)}</span>
                <span className="text-xs text-muted">owed</span>
              </span>
              <span className="flex min-w-[120px] flex-col text-right">
                {r.overdue > 0 ? (
                  <>
                    <span className="num font-semibold text-bad-ink">{formatTaka(r.overdue)}</span>
                    <span className="text-xs text-muted">
                      past {r.paymentDays} {r.paymentDays === 1 ? "day" : "days"}
                    </span>
                  </>
                ) : (
                  <span className="text-[13px] text-muted">within terms</span>
                )}
              </span>
            </button>
            {openId === r.customerId && (
              <Statement customerId={r.customerId} busy={busy} run={run} />
            )}
          </li>
        ))}
      </ul>

      {overdue > 0 && (
        <p className="flex items-start gap-2 text-[13px] text-muted">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-ink" aria-hidden />
          &ldquo;Past due&rdquo; is measured against the days each customer was actually
          given, not a fixed 60 — a corporate buyer on 45-day terms is not late at 40.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function Groups({
  groups, priceLists, busy, run,
}: {
  groups: CustomerGroup[];
  priceLists: PriceList[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend } = useStaff();
  const [editing, setEditing] = React.useState<CustomerGroup | null>(null);
  const [adding, setAdding] = React.useState(false);

  const form = (g: CustomerGroup | null) => (
    <GroupForm
      group={g} priceLists={priceLists} busy={busy}
      onCancel={() => { setEditing(null); setAdding(false); }}
      onSave={async (values) => {
        await run(() => backend.saveCustomerGroup(g?.id ?? null, values));
        setEditing(null);
        setAdding(false);
      }}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        A group carries the price list and the credit terms its members get, so a new
        dealer is set up by picking &ldquo;Dealer&rdquo; rather than by remembering three
        fields.
      </p>

      {!adding && (
        <Button className="self-start" onClick={() => { setAdding(true); setEditing(null); }}>
          <Plus className="size-4" aria-hidden /> Add a group
        </Button>
      )}
      {adding && form(null)}

      <ul className="flex flex-col gap-1.5">
        {groups.map((g) => (
          <li key={g.id}>
            {editing?.id === g.id ? form(g) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5">
                <span className="flex min-w-[160px] flex-1 flex-col">
                  <span className="font-semibold">
                    {g.name}
                    {!g.active && <span className="ml-2 text-[13px] font-normal text-warn-ink">turned off</span>}
                  </span>
                  <span className="text-[13px] text-muted">
                    {priceLists.find((l) => l.id === g.priceListId)?.name ?? "shop prices"}
                    {g.discountPct > 0 && ` · ${g.discountPct}% off`}
                    {g.creditAllowed
                      ? ` · credit${g.creditLimit > 0 ? ` up to ${formatTaka(g.creditLimit)}` : ", no limit"}${g.paymentDays > 0 ? `, ${g.paymentDays} days` : ""}`
                      : " · no credit"}
                  </span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => { setEditing(g); setAdding(false); }}>
                  <Pencil className="size-4" aria-hidden /> Change
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GroupForm({
  group, priceLists, busy, onSave, onCancel,
}: {
  group: CustomerGroup | null;
  priceLists: PriceList[];
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [f, setF] = React.useState({
    name: group?.name ?? "",
    price_list_id: group?.priceListId ?? "",
    discount_pct: String(group?.discountPct ?? 0),
    credit_allowed: group?.creditAllowed ?? false,
    credit_limit: String(group?.creditLimit ?? 0),
    payment_days: String(group?.paymentDays ?? 0),
    active: group?.active ?? true,
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          name: f.name.trim(),
          price_list_id: f.price_list_id || null,
          discount_pct: Number(f.discount_pct) || 0,
          credit_allowed: f.credit_allowed,
          credit_limit: Number(f.credit_limit) || 0,
          payment_days: Number(f.payment_days) || 0,
          active: f.active,
        });
      }}
    >
      <div className="flex flex-wrap gap-3">
        <div className="flex-[2_1_200px]">
          <Field label="Name" required>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </Field>
        </div>
        <div className="flex-[1_1_180px]">
          <Field label="Price list">
            <select
              value={f.price_list_id}
              onChange={(e) => setF({ ...f, price_list_id: e.target.value })}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">Shop prices</option>
              {priceLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="flex-[1_1_120px]">
          <Field label="Discount %">
            <Input
              inputMode="decimal" value={f.discount_pct}
              onChange={(e) => setF({ ...f, discount_pct: e.target.value.replace(/[^0-9.]/g, "") })}
              className="num"
            />
          </Field>
        </div>
      </div>

      <Check
        label="Members can buy on due"
        checked={f.credit_allowed}
        onChange={(v) => setF({ ...f, credit_allowed: v })}
      />
      {f.credit_allowed && (
        <div className="flex flex-wrap gap-3">
          <div className="flex-[1_1_160px]">
            <Field label="Credit limit" hint="0 means no ceiling.">
              <Input
                inputMode="numeric" value={f.credit_limit}
                onChange={(e) => setF({ ...f, credit_limit: e.target.value.replace(/\D/g, "") })}
                className="num"
              />
            </Field>
          </div>
          <div className="flex-[1_1_160px]">
            <Field label="Days to pay">
              <Input
                inputMode="numeric" value={f.payment_days}
                onChange={(e) => setF({ ...f, payment_days: e.target.value.replace(/\D/g, "") })}
                className="num"
              />
            </Field>
          </div>
        </div>
      )}
      {group && <Check label="In use" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !f.name.trim()}>
          {busy ? "Saving…" : group ? "Save" : "Add group"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

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

function Check({
  label, hint, checked, onChange,
}: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 max-w-[420px] items-start gap-2.5 text-[15px]">
      <input
        type="checkbox" checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-brand)]"
      />
      <span className="flex flex-col">
        {label}
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
    </label>
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
