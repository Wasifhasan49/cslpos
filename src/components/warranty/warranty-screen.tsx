"use client";

import * as React from "react";
import {
  Check, ClipboardList, Package, Plus, Printer, Search, ShieldCheck, TriangleAlert,
  Truck, Wrench,
} from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { formatDate } from "@/lib/sale";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type {
  ClaimRow, ClaimStatus, Product, ProblemType, Supplier, SupplierRmaRow, Technician,
  WarrantyHit,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Tab = "lookup" | "claims" | "supplier";

const TABS: { key: Tab; label: string }[] = [
  { key: "lookup", label: "Look it up" },
  { key: "claims", label: "Claims" },
  { key: "supplier", label: "With suppliers" },
];

const STATUS_WORDS: Record<ClaimStatus, string> = {
  received: "Taken in",
  diagnosed: "Looked at",
  with_supplier: "With the supplier",
  back_from_supplier: "Back from the supplier",
  repaired: "Repaired here",
  ready: "Ready for collection",
  delivered: "Given back",
  rejected: "Turned down",
};

/** What can sensibly happen next, so the screen offers steps rather than a dropdown. */
const NEXT_STEPS: Record<ClaimStatus, ClaimStatus[]> = {
  received: ["diagnosed", "with_supplier", "repaired", "rejected"],
  diagnosed: ["with_supplier", "repaired", "rejected"],
  with_supplier: ["back_from_supplier", "rejected"],
  back_from_supplier: ["ready", "repaired", "rejected"],
  repaired: ["ready", "delivered"],
  ready: ["delivered"],
  delivered: [],
  rejected: [],
};

/** A claim nobody has touched for this long is the one about to be rung about. */
const CHASE_AFTER_DAYS = 14;

const COMMON_ACCESSORIES = ["Charger", "Box", "Bag", "Cable", "Manual", "Battery"];

export function WarrantyScreen() {
  const { backend, branch } = useStaff();
  const [tab, setTab] = React.useState<Tab>("lookup");
  const [problemTypes, setProblemTypes] = React.useState<ProblemType[]>([]);
  const [technicians, setTechnicians] = React.useState<Technician[]>([]);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const [pt, t, sup, prods] = await Promise.all([
        backend.listProblemTypes().catch(() => [] as ProblemType[]),
        backend.listTechnicians().catch(() => [] as Technician[]),
        backend.listSuppliers().catch(() => [] as Supplier[]),
        backend.listProducts(branch.id).catch(() => [] as Product[]),
      ]);
      if (cancelled) return;
      setProblemTypes(pt);
      setTechnicians(t);
      setSuppliers(sup);
      setProducts(prods);
    })();
    return () => { cancelled = true; };
  }, [backend, branch.id]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); setNonce((n) => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
    finally { setBusy(false); }
  };

  return (
    <Main>
      <div>
        <h1 className="text-xl font-semibold">Warranty</h1>
        <p className="text-[13px] text-muted">
          Is it covered, what is wrong with it, and where is it now.
        </p>
      </div>

      <nav aria-label="Warranty sections" className="flex gap-1 overflow-x-auto border-b border-line">
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

      {tab === "lookup" && (
        <Lookup
          problemTypes={problemTypes}
          technicians={technicians}
          products={products}
          busy={busy}
          run={run}
          onOpened={() => setTab("claims")}
        />
      )}
      {tab === "claims" && (
        <Claims
          key={nonce}
          technicians={technicians}
          suppliers={suppliers}
          products={products}
          busy={busy}
          run={run}
        />
      )}
      {tab === "supplier" && <SupplierRma key={nonce} />}
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
// One box
// ---------------------------------------------------------------------------

function Lookup({
  problemTypes, technicians, products, busy, run, onOpened,
}: {
  problemTypes: ProblemType[];
  technicians: Technician[];
  products: Product[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onOpened: () => void;
}) {
  const { backend, staff } = useStaff();
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<WarrantyHit[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState("");
  const [claiming, setClaiming] = React.useState<WarrantyHit | null>(null);
  const [manual, setManual] = React.useState(false);
  const [done, setDone] = React.useState("");

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    try { setHits(await backend.warrantyLookup(query.trim())); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't look that up."); }
    finally { setSearching(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => { e.preventDefault(); void search(); }}
      >
        <div className="min-w-[240px] flex-[2_1_300px]">
          <Field
            label="Serial, invoice number or mobile"
            hint="Whatever the customer has in their hand. You don't have to say which it is."
          >
            <Input
              autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="S64DNX0T41822, DEMO-MB-2026000012, 01712…"
              className="code h-12"
            />
          </Field>
        </div>
        <Button type="submit" size="lg" disabled={searching || !query.trim()}>
          <Search className="size-4" aria-hidden /> {searching ? "Looking…" : "Look it up"}
        </Button>
      </form>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}
      {done && (
        <p className="flex items-center gap-2 text-[15px] font-semibold text-ok-ink">
          <Check className="size-5" aria-hidden /> {done}
        </p>
      )}

      {hits && hits.length === 0 && !manual && (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line-strong bg-subtle p-6">
          <p className="text-muted">
            Nothing matches that. It may have been sold before this shop moved across —
            {staff.role === "cashier"
              ? " a manager can record its warranty by hand."
              : " you can record its warranty by hand."}
          </p>
          {staff.role !== "cashier" && (
            <Button variant="outline" onClick={() => setManual(true)}>
              <Plus className="size-4" aria-hidden /> Record it by hand
            </Button>
          )}
        </div>
      )}

      {manual && (
        <ManualWarranty
          serial={query.trim()}
          products={products}
          busy={busy}
          onCancel={() => setManual(false)}
          onSave={(values) => run(async () => {
            await backend.saveManualWarranty(values);
            setManual(false);
            setDone("Recorded. Look it up again to see it.");
            await search();
          })}
        />
      )}

      <ul className="flex flex-col gap-2">
        {(hits ?? []).map((h, i) => (
          <li key={`${h.serial ?? h.invoiceNo}-${i}`} className="rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-[220px] flex-1 flex-col">
                <span className="font-semibold">{h.product ?? "Unknown item"}</span>
                <span className="text-[13px] text-muted">
                  {h.serial && <span className="code">{h.serial}</span>}
                  {h.soldOn && ` · sold ${formatDate(h.soldOn)}`}
                  {h.branch && ` · ${h.branch}`}
                  {h.soldBy && ` · by ${h.soldBy}`}
                  {h.invoiceNo && <> · <span className="code">{h.invoiceNo}</span></>}
                </span>
                {(h.customerName || h.customerPhone) && (
                  <span className="text-[13px] text-muted">
                    {h.customerName}
                    {h.customerPhone && <> · <span className="num">{h.customerPhone}</span></>}
                  </span>
                )}
                {h.kind === "replacement" && (
                  <span className="text-[13px] text-ok-ink">{h.warrantyText}</span>
                )}
                {h.kind === "manual" && (
                  <span className="text-[13px] text-muted">Recorded by hand</span>
                )}
              </div>

              <div className="flex flex-col items-end gap-1">
                {h.inWarranty ? (
                  <span className="flex items-center gap-1.5 rounded-full bg-ok-bg px-2.5 py-1 text-[13px] font-semibold text-ok-ink">
                    <ShieldCheck className="size-4" aria-hidden />
                    In warranty{h.daysLeft != null && ` — ${monthsLeft(h.daysLeft)}`}
                  </span>
                ) : (
                  <span className="rounded-full bg-subtle px-2.5 py-1 text-[13px] font-semibold text-muted">
                    {h.warrantyUntil
                      ? `Out of warranty since ${formatDate(h.warrantyUntil)}`
                      : "No warranty recorded"}
                  </span>
                )}
                {h.warrantyUntil && (
                  <span className="text-xs text-muted">
                    {h.inWarranty ? "Covered to" : "Ended"} {formatDate(h.warrantyUntil)}
                  </span>
                )}
              </div>
            </div>

            {h.warrantyText && h.kind === "sold" && (
              <p className="pt-2 text-[13px] text-muted">{h.warrantyText}</p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-3">
              {h.openClaim ? (
                <span className="text-[13px] text-warn-ink">
                  Already in for repair on claim <span className="code">{h.openClaim}</span>.
                </span>
              ) : claiming === h ? null : (
                <Button size="sm" onClick={() => setClaiming(h)}>
                  <Wrench className="size-4" aria-hidden /> Take it in for repair
                </Button>
              )}
              {h.saleStatus === "void" && (
                <span className="text-[13px] text-bad-ink">That sale was voided.</span>
              )}
            </div>

            {claiming === h && (
              <OpenClaim
                hit={h}
                problemTypes={problemTypes}
                technicians={technicians}
                busy={busy}
                onCancel={() => setClaiming(null)}
                onOpen={(input) => run(async () => {
                  const res = await backend.openClaim(input);
                  setClaiming(null);
                  setDone(res.needsApproval
                    ? `Taken in as ${res.claimNo}. It waits for a manager before it can move.`
                    : `Taken in as ${res.claimNo}. Print the slip for the customer.`);
                  onOpened();
                })}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "8 months left" is what the customer asks; the shop has a date. */
function monthsLeft(days: number): string {
  if (days < 31) return `${days} ${days === 1 ? "day" : "days"} left`;
  const months = Math.floor(days / 30);
  return `${months} ${months === 1 ? "month" : "months"} left`;
}

function OpenClaim({
  hit, problemTypes, technicians, busy, onOpen, onCancel,
}: {
  hit: WarrantyHit;
  problemTypes: ProblemType[];
  technicians: Technician[];
  busy: boolean;
  onOpen: (input: {
    branchId: string; problem: string; serialId?: string | null;
    productId?: string | null; itemText?: string | null; problemTypeId?: string | null;
    accessories?: string[]; customerPhone?: string | null; customerName?: string | null;
    technicianId?: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const { branch } = useStaff();
  const [problem, setProblem] = React.useState("");
  const [problemTypeId, setProblemTypeId] = React.useState("");
  const [accessories, setAccessories] = React.useState<string[]>([]);
  const [technicianId, setTechnicianId] = React.useState("");

  return (
    <form
      className="flex flex-col gap-3 border-t border-subtle pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onOpen({
          branchId: branch.id,
          problem: problem.trim(),
          serialId: hit.serialId,
          productId: hit.productId,
          itemText: hit.serialId ? null : hit.product,
          problemTypeId: problemTypeId || null,
          accessories,
          customerPhone: hit.customerPhone,
          customerName: hit.customerName,
          technicianId: technicianId || null,
        });
      }}
    >
      {!hit.inWarranty && (
        <p className="flex items-start gap-2 text-[13px] text-warn-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          This is out of warranty. You can still take it in — the repair will be a normal
          chargeable job.
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_200px]">
          <Field label="What sort of fault?">
            <select
              value={problemTypeId}
              onChange={(e) => setProblemTypeId(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">Pick one</option>
              {problemTypes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
        {technicians.length > 0 && (
          <div className="flex-[1_1_200px]">
            <Field label="Who is looking at it?">
              <select
                value={technicianId}
                onChange={(e) => setTechnicianId(e.target.value)}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                <option value="">Nobody yet</option>
                {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          </div>
        )}
      </div>

      <Field
        label="What is wrong with it?"
        hint="In the customer's words. This is what gets argued about later."
      >
        <Input
          autoFocus value={problem} onChange={(e) => setProblem(e.target.value)}
          placeholder="Not detected by the laptop at all"
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <Label>What came in with it?</Label>
        <div className="flex flex-wrap gap-1.5">
          {COMMON_ACCESSORIES.map((a) => {
            const on = accessories.includes(a);
            return (
              <button
                key={a}
                type="button"
                aria-pressed={on}
                onClick={() => setAccessories(on
                  ? accessories.filter((x) => x !== a)
                  : [...accessories, a])}
                className={cn(
                  "min-h-11 rounded-lg px-3 text-[15px]",
                  on ? "border-2 border-brand bg-ok-bg font-semibold text-ok-ink"
                    : "border border-line hover:bg-subtle",
                )}
              >
                {a}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-muted">
          So an argument about a missing charger has an answer.
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !problem.trim()}>Take it in</Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

function ManualWarranty({
  serial, products, busy, onSave, onCancel,
}: {
  serial: string;
  products: Product[];
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [f, setF] = React.useState({
    serial,
    product_id: "",
    item_text: "",
    customer_phone: "",
    customer_name: "",
    sold_on: "",
    warranty_until: "",
    note: "",
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          serial: f.serial.trim(),
          product_id: f.product_id || null,
          item_text: f.item_text || null,
          customer_phone: f.customer_phone || null,
          customer_name: f.customer_name || null,
          sold_on: f.sold_on || null,
          warranty_until: f.warranty_until || null,
          note: f.note || null,
        });
      }}
    >
      <h2 className="font-semibold">Record a warranty by hand</h2>
      <p className="text-[13px] text-muted">
        For something this shop sold before it moved across. It is a promise the shop is
        making, so it is logged with your name on it.
      </p>

      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_200px]">
          <Field label="Serial" required>
            <Input
              value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })}
              className="code" required
            />
          </Field>
        </div>
        <div className="flex-[1_1_200px]">
          <Field label="Which product" hint="Or just describe it below.">
            <select
              value={f.product_id}
              onChange={(e) => setF({ ...f, product_id: e.target.value })}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">Not in the catalogue</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
      </div>

      {!f.product_id && (
        <Field label="What is it?" required>
          <Input
            value={f.item_text}
            onChange={(e) => setF({ ...f, item_text: e.target.value })}
            placeholder="Dell laptop sold under the old system"
          />
        </Field>
      )}

      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_160px]">
          <Field label="Sold on">
            <Input type="date" value={f.sold_on} onChange={(e) => setF({ ...f, sold_on: e.target.value })} />
          </Field>
        </div>
        <div className="flex-[1_1_160px]">
          <Field label="Covered until" hint="The date the shop will honour to.">
            <Input
              type="date" value={f.warranty_until}
              onChange={(e) => setF({ ...f, warranty_until: e.target.value })}
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_160px]">
          <Field label="Customer mobile">
            <Input
              value={f.customer_phone}
              onChange={(e) => setF({ ...f, customer_phone: e.target.value.replace(/\D/g, "").slice(0, 11) })}
              className="num"
            />
          </Field>
        </div>
        <div className="flex-[1_1_200px]">
          <Field label="Customer name">
            <Input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} />
          </Field>
        </div>
      </div>

      <Field label="Note" hint="What the warranty actually covers.">
        <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={busy || !f.serial.trim() || (!f.product_id && !f.item_text.trim())}
        >
          Record it
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The claims list
// ---------------------------------------------------------------------------

function Claims({
  technicians, suppliers, products, busy, run,
}: {
  /** Passed through to the detail panel, where a claim is assigned to somebody. */
  technicians: Technician[];
  suppliers: Supplier[];
  products: Product[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch, staff } = useStaff();
  const [rows, setRows] = React.useState<ClaimRow[] | null>(null);
  const [status, setStatus] = React.useState<string>("open");
  const [query, setQuery] = React.useState("");
  const [waiting, setWaiting] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [printing, setPrinting] = React.useState<ClaimRow | null>(null);

  const load = React.useCallback(async () => {
    try {
      setRows(await backend.listClaims({
        branchId: null,
        status: (status || null) as ClaimStatus | "open" | null,
        query: query.trim() || null,
        waitingOver: waiting ? CHASE_AFTER_DAYS : null,
      }));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the claims.");
    }
  }, [backend, status, query, waiting]);

  React.useEffect(() => { void load(); }, [load]);

  if (printing) return <ClaimSlip claim={printing} onBack={() => setPrinting(null)} />;
  if (error) return <p role="alert" className="text-bad-ink">{error}</p>;
  if (!rows) return <p className="text-muted">Loading…</p>;

  const overdue = rows.filter((r) => r.open && r.daysWaiting >= CHASE_AFTER_DAYS);

  return (
    <div className="flex flex-col gap-3">
      {overdue.length > 0 && !waiting && (
        <p className="flex items-start gap-2 rounded-xl border border-warn-ink/30 bg-warn-bg p-3 text-[15px] text-warn-ink">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <span>
            {overdue.length === 1 ? "One claim has" : `${overdue.length} claims have`} been
            here {CHASE_AFTER_DAYS} days or more. Those are the ones the customer is about
            to ring about.
          </span>
        </p>
      )}

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => { e.preventDefault(); void load(); }}
      >
        <div className="min-w-[200px] flex-[2_1_240px]">
          <Field label="Find a claim" hint="A claim number, a serial, a phone or the item.">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} className="h-12" />
          </Field>
        </div>
        <div className="w-44">
          <Field label="Showing">
            <select
              value={status} onChange={(e) => setStatus(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="open">Still open</option>
              <option value="">All of them</option>
              {(Object.keys(STATUS_WORDS) as ClaimStatus[]).map((k) => (
                <option key={k} value={k}>{STATUS_WORDS[k]}</option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-[15px]">
          <input
            type="checkbox" checked={waiting}
            onChange={(e) => setWaiting(e.target.checked)}
            className="size-5 accent-[var(--color-brand)]"
          />
          Here over {CHASE_AFTER_DAYS} days
        </label>
        <Button type="submit"><Search className="size-4" aria-hidden /> Search</Button>
      </form>

      {rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
          <ClipboardList className="mx-auto mb-2 size-8 text-line-strong" aria-hidden />
          Nothing here. Claims start on the &ldquo;Look it up&rdquo; tab.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {rows.map((c) => (
          <li key={c.id} className="rounded-lg border border-line bg-surface">
            <button
              type="button"
              onClick={() => setOpenId(openId === c.id ? null : c.id)}
              aria-expanded={openId === c.id}
              className="flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left hover:bg-subtle"
            >
              <span className="flex min-w-[200px] flex-1 flex-col">
                <span className="code font-semibold">{c.claimNo}</span>
                <span className="truncate text-[13px] text-muted">
                  {c.product}
                  {c.serial && <> · <span className="code">{c.serial}</span></>}
                  {" · "}{c.problem}
                </span>
                <span className="text-[13px] text-muted">
                  {c.branch}
                  {c.customerPhone && <> · <span className="num">{c.customerPhone}</span></>}
                  {c.technician && ` · ${c.technician}`}
                </span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <Pill status={c.status} approval={c.approvalStatus} />
                <span className={cn("text-xs",
                  c.open && c.daysWaiting >= CHASE_AFTER_DAYS ? "font-semibold text-warn-ink" : "text-muted")}>
                  {c.open
                    ? `${c.daysWaiting} ${c.daysWaiting === 1 ? "day" : "days"} here`
                    : `took ${c.daysWaiting} ${c.daysWaiting === 1 ? "day" : "days"}`}
                </span>
                {c.inWarranty && <span className="text-xs text-ok-ink">in warranty</span>}
              </span>
            </button>

            {openId === c.id && (
              <ClaimDetail
                claim={c}
                technicians={technicians}
                suppliers={suppliers}
                products={products}
                busy={busy}
                canApprove={staff.role !== "cashier"}
                branchId={branch.id}
                onPrint={() => setPrinting(c)}
                onChanged={() => { void load(); }}
                run={run}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClaimDetail({
  claim, technicians, suppliers, products, busy, canApprove, branchId, onPrint, onChanged, run,
}: {
  claim: ClaimRow;
  technicians: Technician[];
  suppliers: Supplier[];
  products: Product[];
  busy: boolean;
  canApprove: boolean;
  branchId: string;
  onPrint: () => void;
  onChanged: () => void;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend } = useStaff();
  const [step, setStep] = React.useState<ClaimStatus | null>(null);
  const [note, setNote] = React.useState("");
  const [supplierId, setSupplierId] = React.useState(claim.supplierId ?? "");
  const [replacement, setReplacement] = React.useState("");
  const [partId, setPartId] = React.useState("");
  const [addingPart, setAddingPart] = React.useState(false);
  const [technicianId, setTechnicianId] = React.useState(claim.technicianId ?? "");

  // A swap can only be made from units actually on this branch's shelf.
  const sameProduct = products.find((p) => p.name === claim.product);
  const swappable = sameProduct?.serials ?? [];

  return (
    <div className="flex flex-col gap-3 border-t border-subtle px-3 py-3">
      {claim.approvalStatus === "awaiting_approval" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-bg p-2.5 text-[15px] text-warn-ink">
          <TriangleAlert className="size-5 shrink-0" aria-hidden />
          <span className="flex-1">This claim waits for a manager before it can move.</span>
          {canApprove && (
            <Button
              size="sm" disabled={busy}
              onClick={() => run(async () => {
                await backend.approveClaim(claim.id, true);
                onChanged();
              })}
            >
              Approve it
            </Button>
          )}
        </div>
      )}

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[15px]">
        <Pair label="Taken in by" value={claim.takenInBy} />
        <Pair label="On" value={formatDate(claim.createdAt)} />
        {claim.problemType && <Pair label="Fault" value={claim.problemType} />}
        {claim.warrantyUntil && (
          <Pair
            label={claim.inWarranty ? "Covered to" : "Cover ended"}
            value={formatDate(claim.warrantyUntil)}
          />
        )}
        {claim.supplier && <Pair label="With" value={claim.supplier} />}
        {claim.daysWithSupplier != null && (
          <Pair label="Days with them" value={String(claim.daysWithSupplier)} />
        )}
        {claim.replacementSerial && (
          <Pair label="Replaced with" value={claim.replacementSerial} />
        )}
      </dl>

      {claim.accessories.length > 0 && (
        <p className="text-[13px] text-muted">
          Came in with: {claim.accessories.join(", ")}
        </p>
      )}
      {claim.resolution && <p className="text-[13px] text-muted">{claim.resolution}</p>}

      {claim.parts.length > 0 && (
        <p className="text-[13px] text-muted">
          Parts used: {claim.parts.map((p) => `${p.product} ×${p.qty}`).join(", ")}
        </p>
      )}

      <ul className="flex flex-col gap-0.5 text-[13px] text-muted">
        {claim.events.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            {new Date(e.at).toLocaleString("en-GB", {
              day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
            })}
            {" · "}{STATUS_WORDS[e.to] ?? e.to}
            {e.who && ` · ${e.who}`}
            {e.note && ` · ${e.note}`}
          </li>
        ))}
      </ul>

      {step ? (
        <form
          className="flex flex-col gap-3 border-t border-subtle pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await backend.setClaimStatus({
                claimId: claim.id,
                status: step,
                note: note || null,
                supplierId: step === "with_supplier" ? supplierId || null : null,
                replacementSerialId: step === "delivered" ? replacement || null : null,
                technicianId: technicianId || null,
              });
              setStep(null);
              setNote("");
              setReplacement("");
              onChanged();
            });
          }}
        >
          <p className="text-[15px] font-semibold">{STATUS_WORDS[step]}</p>

          {step === "with_supplier" && (
            <Field label="Which supplier" required>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                required
              >
                <option value="">Pick one</option>
                {suppliers.filter((s) => s.active).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
          )}

          {/* Whoever is actually working on it, which is often decided at this step
              rather than when it came over the counter. */}
          {technicians.length > 0 && step !== "delivered" && step !== "rejected" && (
            <Field label="Who is working on it?">
              <select
                value={technicianId}
                onChange={(e) => setTechnicianId(e.target.value)}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                <option value="">Nobody yet</option>
                {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}

          {step === "delivered" && (
            <Field
              label="Giving a different unit?"
              hint="A replacement carries what is LEFT of the original warranty, not a fresh term."
            >
              <select
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                <option value="">No — the same unit back</option>
                {swappable.map((s) => (
                  <option key={s.id} value={s.id}>{s.serial}</option>
                ))}
              </select>
            </Field>
          )}

          <Field
            label={step === "rejected" ? "Why is it being turned down?" : "Note"}
            hint={step === "rejected" ? "Needed. The customer will ask." : undefined}
          >
            <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={busy
                || (step === "rejected" && !note.trim())
                || (step === "with_supplier" && !supplierId)}
            >
              {STATUS_WORDS[step]}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStep(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : addingPart ? (
        <form
          className="flex flex-wrap items-end gap-3 border-t border-subtle pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await backend.useClaimPart(claim.id, partId, 1);
              setAddingPart(false);
              setPartId("");
              onChanged();
            });
          }}
        >
          <div className="min-w-[200px] flex-1">
            <Field label="Which part" hint="It comes out of this branch's stock.">
              <select
                value={partId}
                onChange={(e) => setPartId(e.target.value)}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                required
              >
                <option value="">Pick a product</option>
                {products.filter((p) => !p.isSerial && p.stock > 0).map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.stock} here)</option>
                ))}
              </select>
            </Field>
          </div>
          <Button type="submit" disabled={busy || !partId}>Use it</Button>
          <Button type="button" variant="ghost" onClick={() => setAddingPart(false)}>Cancel</Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2 border-t border-subtle pt-3">
          {claim.approvalStatus === "approved" && NEXT_STEPS[claim.status].map((next) => (
            <Button
              key={next}
              size="sm"
              variant={next === "rejected" ? "ghost" : next === "delivered" ? "default" : "outline"}
              onClick={() => { setStep(next); setNote(""); }}
            >
              {next === "with_supplier" && <Truck className="size-4" aria-hidden />}
              {next === "delivered" && <Check className="size-4" aria-hidden />}
              {STATUS_WORDS[next]}
            </Button>
          ))}
          {claim.open && claim.approvalStatus === "approved" && (
            <Button variant="ghost" size="sm" onClick={() => setAddingPart(true)}>
              <Package className="size-4" aria-hidden /> Use a part
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onPrint}>
            <Printer className="size-4" aria-hidden /> Claim slip
          </Button>
          {branchId !== claim.branchId && (
            <span className="self-center text-[13px] text-muted">
              Taken in at {claim.branch}.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** What the customer walks out with: proof the shop has their thing. */
function ClaimSlip({ claim, onBack }: { claim: ClaimRow; onBack: () => void }) {
  const { staff } = useStaff();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden /> Print
        </Button>
        <Button variant="ghost" onClick={onBack}>Back to the claims</Button>
      </div>

      <article className="mx-auto flex w-full max-w-[420px] flex-col gap-3 rounded-xl border border-line bg-surface p-5">
        <header className="flex flex-col items-center gap-0.5 border-b border-line pb-3 text-center">
          <h2 className="text-lg font-bold">{staff.shopName}</h2>
          <p className="text-[13px] text-muted">Service claim</p>
          <p className="code font-bold">{claim.claimNo}</p>
        </header>

        <dl className="flex flex-col gap-1 text-[15px]">
          <SlipRow label="Item" value={claim.product ?? "—"} />
          {claim.serial && <SlipRow label="Serial" value={claim.serial} mono />}
          <SlipRow label="Taken in" value={new Date(claim.createdAt).toLocaleString("en-GB", {
            day: "2-digit", month: "2-digit", year: "numeric",
            hour: "2-digit", minute: "2-digit",
          })} />
          <SlipRow label="At" value={claim.branch} />
          <SlipRow label="By" value={claim.takenInBy} />
          {claim.customerName && <SlipRow label="Customer" value={claim.customerName} />}
          {claim.customerPhone && <SlipRow label="Mobile" value={claim.customerPhone} mono />}
          <SlipRow
            label="Warranty"
            value={claim.inWarranty && claim.warrantyUntil
              ? `In warranty to ${formatDate(claim.warrantyUntil)}`
              : claim.warrantyUntil
                ? `Ended ${formatDate(claim.warrantyUntil)} — chargeable`
                : "None recorded — chargeable"}
          />
        </dl>

        <div className="border-y border-subtle py-2">
          <p className="text-[13px] text-muted">Reported fault</p>
          <p className="text-[15px]">{claim.problem}</p>
        </div>

        <div>
          <p className="text-[13px] text-muted">Came in with</p>
          <p className="text-[15px]">
            {claim.accessories.length > 0 ? claim.accessories.join(", ") : "Unit only"}
          </p>
        </div>

        <p className="text-[13px] text-muted">
          Please bring this slip when collecting. Keep it safe — it is the shop&rsquo;s
          record of what was handed over.
        </p>
        <p className="text-[13px] text-muted">
          Collected by ______________________ on ____ / ____ / ________
        </p>
      </article>
    </div>
  );
}

function SlipRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={cn("text-right font-semibold", mono && "code")}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// With suppliers
// ---------------------------------------------------------------------------

function SupplierRma() {
  const { backend, staff } = useStaff();
  const [rows, setRows] = React.useState<SupplierRmaRow[] | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    backend.supplierRmaList()
      .then((r) => { if (!cancelled) { setRows(r); setError(""); } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load that.");
      });
    return () => { cancelled = true; };
  }, [backend]);

  if (staff.role === "cashier") {
    return (
      <p className="text-ink-soft">
        What is out with suppliers is for managers and owners. You can still see every
        claim at this branch on the Claims tab.
      </p>
    );
  }
  if (error) return <p role="alert" className="text-bad-ink">{error}</p>;
  if (!rows) return <p className="text-muted">Loading…</p>;
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
        <Truck className="mx-auto mb-2 size-8 text-line-strong" aria-hidden />
        Nothing is out with a supplier.
      </p>
    );
  }

  const bySupplier = new Map<string, SupplierRmaRow[]>();
  for (const r of rows) {
    bySupplier.set(r.supplier, [...(bySupplier.get(r.supplier) ?? []), r]);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        What each supplier has of ours, and for how long. The figure to chase on is the
        days out, not the date it went.
      </p>
      {[...bySupplier.entries()].map(([supplier, items]) => (
        <section key={supplier} className="flex flex-col gap-1.5">
          <h2 className="font-semibold">
            {supplier} <span className="num text-[13px] font-normal text-muted">
              {items.length} {items.length === 1 ? "item" : "items"}
            </span>
          </h2>
          <ul className="flex flex-col gap-1.5">
            {items.map((r) => (
              <li
                key={r.claimId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5"
              >
                <span className="flex min-w-[200px] flex-1 flex-col">
                  <span className="font-semibold">{r.product}</span>
                  <span className="text-[13px] text-muted">
                    <span className="code">{r.claimNo}</span>
                    {r.serial && <> · <span className="code">{r.serial}</span></>}
                    {" · "}{r.problem} · {r.branch}
                  </span>
                </span>
                <span className="flex flex-col text-right">
                  <span className={cn("num font-semibold",
                    r.daysOut >= CHASE_AFTER_DAYS && "text-warn-ink")}>
                    {r.daysOut}
                  </span>
                  <span className="text-xs text-muted">
                    {r.daysOut === 1 ? "day out" : "days out"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Pill({ status, approval }: { status: ClaimStatus; approval: string }) {
  if (approval === "awaiting_approval") {
    return (
      <span className="rounded-full bg-warn-bg px-2.5 py-1 text-[13px] font-semibold text-warn-ink">
        Waiting for a manager
      </span>
    );
  }
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-[13px] font-semibold",
        status === "rejected" ? "bg-bad-bg text-bad-ink"
          : status === "delivered" ? "bg-ok-bg text-ok-ink"
          : status === "ready" ? "bg-ok-bg text-ok-ink"
          : status === "with_supplier" ? "bg-warn-bg text-warn-ink"
          : "bg-subtle text-ink-soft",
      )}
    >
      {STATUS_WORDS[status]}
    </span>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
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
