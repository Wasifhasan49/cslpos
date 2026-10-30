"use client";

import * as React from "react";
import { Ban, MapPin, Plus, Star, Wallet } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatTaka } from "@/lib/sale";
import type {
  CustomerKind, CustomerSearchRow, DeliveryPoint, RepRow,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const KINDS: { key: CustomerKind; label: string }[] = [
  { key: "retail", label: "Retail" },
  { key: "dealer", label: "Dealer" },
  { key: "retailer", label: "Sub-dealer" },
  { key: "corporate", label: "Corporate" },
];

const FLAGS: { key: string; label: string }[] = [
  { key: "blocked", label: "Blocked" },
  { key: "cash_only", label: "Cash only" },
  { key: "vip", label: "VIP" },
  { key: "has_deposit", label: "Holding their money" },
];

/**
 * Dealers: what kind of customer, whose, where to deliver, and what the shop is holding.
 *
 * One search box across every field — name, phone, company, address, the rep's name —
 * because whoever is looking has one thing in their hand and should not have to know
 * which field it lives in.
 */
export function Distribution({ run, busy }: {
  run: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
}) {
  const { backend, branches } = useStaff();
  const [rows, setRows] = React.useState<CustomerSearchRow[] | null>(null);
  const [reps, setReps] = React.useState<RepRow[]>([]);
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<CustomerKind | "">("");
  const [flag, setFlag] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");

  const load = React.useCallback(() => {
    backend.searchCustomers({ query: query || null, kind: kind || null, flag: flag || null })
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't search."));
  }, [backend, query, kind, flag]);
  React.useEffect(load, [load]);

  React.useEffect(() => {
    backend.listReps().then(setReps).catch(() => setReps([]));
  }, [backend]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px] text-muted">
          Search
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="A name, a phone, a company, an address, or their rep"
          />
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as CustomerKind | "")}
                  className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-[15px]">
            <option value="">All</option>
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          Flagged
          <select value={flag} onChange={(e) => setFlag(e.target.value)}
                  className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-[15px]">
            <option value="">Anybody</option>
            {FLAGS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
      </div>

      {error && <p role="alert" className="text-bad-ink">{error}</p>}
      {!rows && <p className="text-[15px] text-muted">Loading…</p>}
      {rows?.length === 0 && (
        <p className="rounded-xl border border-dashed border-line p-6 text-[15px] text-muted">
          Nobody matches that.
        </p>
      )}

      {rows?.map((c) => (
        <section key={c.id} className="rounded-xl border border-line bg-white">
          <button
            type="button"
            className="flex w-full flex-wrap items-start justify-between gap-3 p-4 text-left hover:bg-subtle"
            onClick={() => setOpen(open === c.id ? null : c.id)}
          >
            <div>
              <p className="text-[15px] font-medium">
                {c.name}
                {c.isVip && <Star className="ml-1 inline size-4 text-brand" aria-label="VIP" />}
                {c.blocked && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-lg bg-bad-bg px-2 py-0.5 text-[12px] text-bad-ink">
                    <Ban className="size-3" aria-hidden /> Blocked
                  </span>
                )}
                {c.cashOnly && !c.blocked && (
                  <span className="ml-2 rounded-lg bg-subtle px-2 py-0.5 text-[12px] text-ink-soft">
                    Cash only
                  </span>
                )}
              </p>
              <p className="text-[13px] text-muted">
                {KINDS.find((k) => k.key === c.kind)?.label ?? c.kind}
                {" · "}{c.phone}
                {c.rep && ` · ${c.rep}`}
                {c.parent && ` · under ${c.parent}`}
                {c.homeBranch && ` · ${c.homeBranch}`}
              </p>
              {c.blocked && c.blockReason && (
                <p className="text-[13px] text-bad-ink">{c.blockReason}</p>
              )}
            </div>
            <div className="text-right text-[14px]">
              {c.owed > 0 && (
                <p>Owes <span className="num font-medium">{formatTaka(c.owed)}</span></p>
              )}
              {c.deposit > 0 && (
                <p className="text-muted">
                  Holding <span className="num">{formatTaka(c.deposit)}</span> of theirs
                </p>
              )}
              {c.deliveryPoints > 0 && (
                <p className="text-muted">{c.deliveryPoints} delivery addresses</p>
              )}
            </div>
          </button>

          {open === c.id && (
            <div className="border-t border-line p-4">
              <Convert customer={c} reps={reps} branches={branches} busy={busy}
                       run={run} onSaved={load} />
              <Deposit customer={c} busy={busy} run={run} onSaved={load} />
              <Points customerId={c.id} busy={busy} run={run} onSaved={load} />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** What kind they are, whose they are, and the flags the till enforces. */
function Convert({ customer, reps, branches, busy, run, onSaved }: {
  customer: CustomerSearchRow;
  reps: RepRow[];
  branches: { id: string; name: string }[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}) {
  const { backend } = useStaff();
  const [kind, setKind] = React.useState<CustomerKind>(customer.kind);
  const [repId, setRepId] = React.useState(customer.repId ?? "");
  const [why, setWhy] = React.useState(customer.blockReason ?? "");

  return (
    <div className="flex flex-col gap-3 border-b border-line pb-4">
      <h3 className="text-[15px] font-semibold">What they are</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as CustomerKind)}
                  className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-[15px]">
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          Their rep
          <select value={repId} onChange={(e) => setRepId(e.target.value)}
                  className="min-h-[44px] min-w-[160px] rounded-xl border border-line bg-white px-3 text-[15px]">
            <option value="">Nobody</option>
            {reps.map((r) => (
              <option key={r.employeeId} value={r.employeeId}>{r.name}</option>
            ))}
          </select>
        </label>
        <Button
          disabled={busy}
          onClick={() => run(async () => {
            await backend.convertCustomer(customer.id, { kind, rep_id: repId || null });
            onSaved();
          })}
        >
          Save
        </Button>
        {branches.length > 1 && (
          <label className="flex flex-col gap-1 text-[13px] text-muted">
            Move to
            <select
              value={customer.homeBranchId ?? ""}
              onChange={(e) => run(async () => {
                const r = await backend.moveCustomerBranch(customer.id, e.target.value);
                onSaved();
                if (r.owed > 0) {
                  // Their debt goes with them; the sales stay where they happened.
                  window.setTimeout(() => undefined, 0);
                }
              })}
              className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-[15px]"
            >
              <option value="">No home branch</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-h-[44px] items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            checked={customer.cashOnly}
            disabled={busy}
            onChange={(e) => run(async () => {
              await backend.convertCustomer(customer.id, { cash_only: e.target.checked });
              onSaved();
            })}
          />
          Cash only — no selling to them on due
        </label>
        <label className="flex min-h-[44px] items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            checked={customer.isVip}
            disabled={busy}
            onChange={(e) => run(async () => {
              await backend.convertCustomer(customer.id, { is_vip: e.target.checked });
              onSaved();
            })}
          />
          VIP
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {customer.blocked ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => run(async () => {
              await backend.convertCustomer(customer.id, { blocked: false });
              onSaved();
            })}
          >
            Unblock them
          </Button>
        ) : (
          <>
            <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[13px] text-muted">
              Why block them?
              <Input value={why} onChange={(e) => setWhy(e.target.value)}
                     placeholder="Two cheques bounced" />
              <span className="text-[12px]">
                They can still pay cash. Whoever is at the till will see this reason.
              </span>
            </label>
            <Button
              variant="outline"
              disabled={busy || !why.trim()}
              onClick={() => run(async () => {
                await backend.convertCustomer(customer.id,
                  { blocked: true, block_reason: why });
                onSaved();
              })}
            >
              <Ban className="size-4" aria-hidden /> Block them
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Money a dealer leaves with the shop. Theirs until it is handed back. */
function Deposit({ customer, busy, run, onSaved }: {
  customer: CustomerSearchRow;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}) {
  const { backend } = useStaff();
  const [amount, setAmount] = React.useState("");

  return (
    <div className="flex flex-col gap-2 border-b border-line py-4">
      <h3 className="flex items-center gap-2 text-[15px] font-semibold">
        <Wallet className="size-4" aria-hidden /> Security deposit
      </h3>
      <p className="text-[13px] text-muted">
        Holding <span className="num">{formatTaka(customer.deposit)}</span> of theirs. It
        is the dealer&rsquo;s money until it goes back, so the books carry it as owed to
        them, never as income.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex w-[140px] flex-col gap-1 text-[13px] text-muted">
          Amount
          <Input inputMode="numeric" className="num" value={amount}
                 onChange={(e) => setAmount(e.target.value)} />
        </label>
        <Button
          disabled={busy || !(Number(amount) > 0)}
          onClick={() => run(async () => {
            await backend.recordDeposit({
              customerId: customer.id, amount: Number(amount), method: "cash",
            });
            setAmount("");
            onSaved();
          })}
        >
          Take it
        </Button>
        <Button
          variant="outline"
          disabled={busy || !(Number(amount) > 0) || customer.deposit <= 0}
          onClick={() => run(async () => {
            await backend.recordDeposit({
              customerId: customer.id, amount: -Number(amount), method: "cash",
            });
            setAmount("");
            onSaved();
          })}
        >
          Give it back
        </Button>
      </div>
    </div>
  );
}

/** Where to deliver. A dealer may have a shop and a warehouse. */
function Points({ customerId, busy, run, onSaved }: {
  customerId: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onSaved: () => void;
}) {
  const { backend } = useStaff();
  const [points, setPoints] = React.useState<DeliveryPoint[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [address, setAddress] = React.useState("");
  const [contact, setContact] = React.useState("");

  const load = React.useCallback(() => {
    backend.listDeliveryPoints(customerId).then(setPoints).catch(() => setPoints([]));
  }, [backend, customerId]);
  React.useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-2 pt-4">
      <h3 className="flex items-center gap-2 text-[15px] font-semibold">
        <MapPin className="size-4" aria-hidden /> Where to deliver
      </h3>
      {points.length === 0 && (
        <p className="text-[13px] text-muted">
          No addresses yet. Deliveries go to the address on their record.
        </p>
      )}
      <ul className="flex flex-col gap-1 text-[14px]">
        {points.map((p) => (
          <li key={p.id} className="flex flex-wrap justify-between gap-2 border-b border-line/60 py-1">
            <span>
              <strong className={cn(p.isDefault && "text-ink")}>{p.name}</strong>
              {p.isDefault && <span className="text-muted"> · the usual one</span>}
              {p.address && <span className="block text-[13px] text-muted">{p.address}</span>}
            </span>
            <span className="text-[13px] text-muted">
              {p.contactName}{p.contactPhone && ` · ${p.contactPhone}`}
            </span>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex w-[160px] flex-col gap-1 text-[13px] text-muted">
            Call it
            <Input value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="Warehouse" />
          </label>
          <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[13px] text-muted">
            Address
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </label>
          <label className="flex w-[160px] flex-col gap-1 text-[13px] text-muted">
            Who to ask for
            <Input value={contact} onChange={(e) => setContact(e.target.value)} />
          </label>
          <Button
            disabled={busy || !name.trim()}
            onClick={() => run(async () => {
              await backend.saveDeliveryPoint(null, customerId, {
                name, address: address || null, contact_name: contact || null,
              });
              setAdding(false);
              setName("");
              setAddress("");
              setContact("");
              load();
              onSaved();
            })}
          >
            Save
          </Button>
          <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
        </div>
      ) : (
        <div>
          <Button variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> Add an address
          </Button>
        </div>
      )}
    </div>
  );
}
