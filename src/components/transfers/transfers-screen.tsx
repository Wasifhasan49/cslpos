"use client";

import * as React from "react";
import {
  ArrowRightLeft, Check, Printer, Trash2, Truck, TriangleAlert,
} from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatTaka, searchProducts } from "@/lib/sale";
import type {
  InTransitRow, Product, TransferRequestRow, TransferRequestStatus, TransferRow,
  TransferStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Tab = "send" | "incoming" | "requests" | "inside" | "history";

const TABS: { key: Tab; label: string }[] = [
  { key: "send", label: "Send" },
  { key: "incoming", label: "Coming in" },
  { key: "requests", label: "Requests" },
  { key: "inside", label: "Inside this branch" },
  { key: "history", label: "History" },
];

const TRANSFER_WORDS: Record<TransferStatus, string> = {
  in_transit: "On the road", received: "Arrived",
  disputed: "Something is missing", cancelled: "Called off",
};

const REQUEST_WORDS: Record<TransferRequestStatus, string> = {
  submitted: "Waiting for a decision", approved: "Agreed, not sent yet",
  rejected: "Turned down", sent: "Sent", cancelled: "Cancelled",
};

/** Goods nobody can sell, for this long, need someone to look. */
const CHASE_AFTER_DAYS = 3;

export function TransfersScreen() {
  const { backend, branch, branches, staff } = useStaff();
  const [tab, setTab] = React.useState<Tab>("send");
  const [products, setProducts] = React.useState<Product[]>([]);
  const [transfers, setTransfers] = React.useState<TransferRow[]>([]);
  const [requests, setRequests] = React.useState<TransferRequestRow[]>([]);
  const [onRoad, setOnRoad] = React.useState<InTransitRow[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, t, r, it] = await Promise.all([
          backend.listProducts(branch.id),
          backend.listTransfers(branch.id),
          backend.listTransferRequests(branch.id),
          backend.inTransit(null).catch(() => [] as InTransitRow[]),
        ]);
        if (cancelled) return;
        setProducts(p);
        setTransfers(t);
        setRequests(r);
        setOnRoad(it);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the transfers.");
      }
    })();
    return () => { cancelled = true; };
  }, [backend, branch.id, nonce]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
    finally { setBusy(false); }
  };

  if (staff.role === "cashier") {
    return (
      <Main>
        <h1 className="text-xl font-semibold">Transfers</h1>
        <p className="text-ink-soft">
          Moving stock between branches is for managers and owners. Ask the owner if you
          need to do it.
        </p>
      </Main>
    );
  }

  const incoming = transfers.filter(
    (t) => t.toBranchId === branch.id && t.status === "in_transit");
  const disputed = transfers.filter((t) => t.status === "disputed");
  const overdue = onRoad.filter((t) => t.daysOut >= CHASE_AFTER_DAYS);
  const toDecide = requests.filter(
    (r) => r.status === "submitted" && r.fromBranchId === branch.id);

  return (
    <Main>
      <div>
        <h1 className="text-xl font-semibold">Transfers</h1>
        <p className="text-[13px] text-muted">{branch.name}</p>
      </div>

      {overdue.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-warn-ink/30 bg-warn-bg p-3 text-[15px] text-warn-ink">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <span>
            {overdue.length === 1 ? "One transfer has" : `${overdue.length} transfers have`} been
            on the road {CHASE_AFTER_DAYS} days or more.{" "}
            {overdue.map((t) => t.transferNo).join(", ")} — nobody can sell those goods
            until someone receives them.
          </span>
        </p>
      )}

      {disputed.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-bad-ink/30 bg-bad-bg p-3 text-[15px] text-bad-ink">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <span>
            {disputed.map((t) => t.transferNo).join(", ")} arrived short. A manager has to
            say what happened before the books are right.
          </span>
        </p>
      )}

      <nav aria-label="Transfer sections" className="flex gap-1 overflow-x-auto border-b border-line">
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
            {t.key === "incoming" && incoming.length > 0 && (
              <span className="num ml-1.5 rounded-full bg-warn-bg px-1.5 text-xs text-warn-ink">
                {incoming.length}
              </span>
            )}
            {t.key === "requests" && toDecide.length > 0 && (
              <span className="num ml-1.5 rounded-full bg-warn-bg px-1.5 text-xs text-warn-ink">
                {toDecide.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {tab === "send" && (
        <SendStock products={products} requests={requests} busy={busy} run={run} />
      )}
      {tab === "incoming" && (
        <Incoming transfers={incoming} busy={busy} run={run} />
      )}
      {tab === "requests" && (
        <Requests requests={requests} products={products} busy={busy} run={run} />
      )}
      {tab === "inside" && <InsideBranch products={products} busy={busy} run={run} />}
      {tab === "history" && (
        <History transfers={transfers} branchCount={branches.length} busy={busy} run={run} />
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
// Sending
// ---------------------------------------------------------------------------

interface SendLine {
  productId: string;
  qty: string;
  serialIds: string[];
}

function SendStock({
  products, requests, busy, run,
}: {
  products: Product[];
  requests: TransferRequestRow[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch, branches } = useStaff();
  const [toBranchId, setToBranchId] = React.useState("");
  const [lines, setLines] = React.useState<SendLine[]>([]);
  const [query, setQuery] = React.useState("");
  const [note, setNote] = React.useState("");
  const [against, setAgainst] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<SentSlip | null>(null);

  const others = branches.filter((b) => b.id !== branch.id);
  const byId = new Map(products.map((p) => [p.id, p]));
  const results = searchProducts(products, query, null).slice(0, 8);
  const agreed = requests.filter(
    (r) => r.status === "approved" && r.fromBranchId === branch.id);

  const reset = () => {
    setLines([]); setQuery(""); setNote(""); setAgainst(null);
  };

  const pull = (r: TransferRequestRow) => {
    setToBranchId(r.toBranchId);
    setAgainst(r.id);
    setLines(r.lines
      .filter((l) => byId.has(l.productId))
      .map((l) => ({ productId: l.productId, qty: String(l.qty), serialIds: [] })));
  };

  if (others.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
        This shop has one branch, so there is nowhere to send stock. Add a second branch
        in Settings → Branches first.
      </p>
    );
  }

  if (sent) {
    return (
      <TransferSlip
        sent={sent}
        toBranch={others.find((b) => b.id === toBranchId)?.name ?? ""}
        onAgain={() => { setSent(null); reset(); }}
      />
    );
  }

  const blocker = (): string | null => {
    if (!toBranchId) return "Pick which branch it is going to.";
    if (lines.length === 0) return "Add what is being sent.";
    for (const l of lines) {
      const p = byId.get(l.productId);
      if (!p) continue;
      if (p.isSerial && l.serialIds.length === 0) {
        return `Pick which ${p.name} units are going. A serial item has to be sent by serial.`;
      }
      if (!p.isSerial && (Number(l.qty) || 0) <= 0) return `How many ${p.name}?`;
      if (!p.isSerial && (Number(l.qty) || 0) > p.stock) {
        return `There are only ${p.stock} ${p.name} here.`;
      }
    }
    return null;
  };
  const stop = blocker();

  return (
    <div className="flex flex-col gap-4">
      {agreed.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {agreed.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-line-strong bg-subtle px-3 py-2.5"
            >
              <span className="code font-semibold">{r.reqNo}</span>
              <span className="min-w-[160px] flex-1 text-[13px] text-muted">
                {r.toBranchName} asked for {r.lines.map((l) => `${l.product} ×${l.qty}`).join(", ")}
              </span>
              <Button variant="outline" size="sm" onClick={() => pull(r)}>Send these</Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-3">
        <div className="flex-[2_1_220px]">
          <Field label="Send to" required>
            <select
              value={toBranchId}
              onChange={(e) => setToBranchId(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">Pick a branch</option>
              {others.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="flex-[2_1_220px]">
          <Field label="Note" hint="Goes on the slip that travels with the goods.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tr-search">What is going?</Label>
        <Input
          id="tr-search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Scan a barcode, or type a name or code" className="h-12"
        />
        {query.trim() !== "" && (
          <ul className="flex flex-col gap-1">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!lines.some((l) => l.productId === p.id)) {
                      setLines([...lines, { productId: p.id, qty: "1", serialIds: [] }]);
                    }
                    setQuery("");
                  }}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 text-left hover:bg-subtle"
                >
                  <span>{p.name} <span className="code text-[13px] text-muted">{p.code}</span></span>
                  <span className="text-[13px] text-muted">{p.stock} here</span>
                </button>
              </li>
            ))}
            {results.length === 0 && <li className="text-[13px] text-muted">Nothing matches.</li>}
          </ul>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {lines.map((l) => {
          const p = byId.get(l.productId);
          if (!p) return null;
          return (
            <li key={l.productId} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <span className="flex min-w-[180px] flex-1 flex-col">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-[13px] text-muted">
                    <span className="code">{p.code}</span> · {p.stock} here
                  </span>
                </span>
                {!p.isSerial && (
                  <div className="w-24">
                    <Field label="How many">
                      <Input
                        inputMode="numeric" value={l.qty} className="num"
                        onChange={(e) => setLines(lines.map((x) =>
                          x.productId === l.productId
                            ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x))}
                      />
                    </Field>
                  </div>
                )}
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}
                  aria-label={`Remove ${p.name}`}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>

              {p.isSerial && (
                <PickSerials
                  product={p}
                  picked={l.serialIds}
                  onChange={(ids) => setLines(lines.map((x) =>
                    x.productId === l.productId ? { ...x, serialIds: ids } : x))}
                />
              )}
            </li>
          );
        })}
      </ul>

      {stop && lines.length > 0 && (
        <p className="flex items-start gap-2 text-[13px] text-warn-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {stop}
        </p>
      )}

      <Button
        size="lg" className="self-start"
        disabled={busy || Boolean(stop)}
        onClick={() => run(async () => {
          const res = await backend.sendTransfer({
            fromBranchId: branch.id,
            toBranchId,
            lines: lines.map((l) => ({
              productId: l.productId,
              qty: Number(l.qty) || 0,
              serialIds: l.serialIds.length > 0 ? l.serialIds : undefined,
            })),
            note: note || null,
            requestId: against,
          });
          setSent({
            no: res.transferNo, cost: res.totalCost, note,
            lines: res.lines.map((l) => ({
              product: l.product, qty: l.qty,
              code: products.find((p) => p.name === l.product)?.code ?? "",
            })),
          });
          reset();
        })}
      >
        <Truck className="size-4" aria-hidden /> Send it
      </Button>
    </div>
  );
}

interface SentSlip {
  no: string;
  cost: number;
  note: string;
  lines: { product: string; code: string; qty: number }[];
}

/**
 * The slip that travels with the goods. The other end checks the boxes against it, so
 * it lists what was sent and leaves room for what arrived — a slip that only says what
 * was sent invites a tick rather than a count.
 */
function TransferSlip({
  sent, toBranch, onAgain,
}: { sent: SentSlip; toBranch: string; onAgain: () => void }) {
  const { branch, staff } = useStaff();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <p className="flex items-center gap-2 font-semibold text-ok-ink">
          <Check className="size-5" aria-hidden /> Sent as {sent.no}
        </p>
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden /> Print the slip
        </Button>
        <Button variant="ghost" onClick={onAgain}>Send something else</Button>
      </div>
      <p className="text-[15px] print:hidden">
        The goods are off {branch.name}&rsquo;s shelf and nobody can sell them until
        {" "}{toBranch} receives them.
      </p>

      <article className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
          <div>
            <h2 className="text-lg font-bold">{staff.shopName}</h2>
            <p className="text-[13px] text-muted">Transfer slip — send this with the goods</p>
          </div>
          <div className="text-right">
            <p className="code font-bold">{sent.no}</p>
            <p className="text-[13px] text-muted">{new Date().toLocaleDateString("en-GB")}</p>
          </div>
        </header>

        <div className="flex flex-wrap justify-between gap-4">
          <div>
            <p className="text-[13px] text-muted">From</p>
            <p className="font-semibold">{branch.name}</p>
          </div>
          <div className="text-right">
            <p className="text-[13px] text-muted">To</p>
            <p className="font-semibold">{toBranch}</p>
          </div>
        </div>

        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-line text-left text-[13px] text-muted">
              <th className="py-1.5 font-medium">Item</th>
              <th className="py-1.5 text-right font-medium">Sent</th>
              <th className="py-1.5 text-right font-medium">Arrived</th>
            </tr>
          </thead>
          <tbody>
            {sent.lines.map((l) => (
              <tr key={`${l.product}-${l.code}`} className="border-b border-subtle">
                <td className="py-1.5">
                  {l.product} <span className="code text-[13px] text-muted">{l.code}</span>
                </td>
                <td className="num py-1.5 text-right">{l.qty}</td>
                <td className="py-1.5 text-right text-muted">______</td>
              </tr>
            ))}
          </tbody>
        </table>

        {sent.note && <p className="text-[13px] text-muted">{sent.note}</p>}
        <p className="text-[13px] text-muted">
          Checked by ______________________ on ____ / ____ / ________
        </p>
      </article>
    </div>
  );
}

/** Which actual units are going. A serial item cannot be sent as "two of them". */
function PickSerials({
  product, picked, onChange,
}: { product: Product; picked: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-subtle pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label>Which units</Label>
        <span className="num text-[13px] text-muted">{picked.length} picked</span>
      </div>
      {product.serials.length === 0 ? (
        <p className="text-[13px] text-muted">
          There are none of these here to send.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {product.serials.map((s) => {
            const on = picked.includes(s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(on ? picked.filter((x) => x !== s.id) : [...picked, s.id])}
                  className={cn(
                    "code min-h-11 rounded-lg px-2.5 text-[13px]",
                    on ? "border-2 border-brand bg-ok-bg font-semibold text-ok-ink"
                      : "border border-line hover:bg-subtle",
                  )}
                >
                  {s.serial}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

function Incoming({
  transfers, busy, run,
}: {
  transfers: TransferRow[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [openId, setOpenId] = React.useState<string | null>(null);

  if (transfers.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
        Nothing is on its way to this branch.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {transfers.map((t) => (
        <li key={t.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-col">
              <span className="code font-semibold">{t.transferNo}</span>
              <span className="text-[13px] text-muted">
                From {t.fromBranchName} · sent {new Date(t.sentAt).toLocaleDateString("en-GB")}
              </span>
            </span>
            <Pill status={t.status} words={TRANSFER_WORDS[t.status]} />
          </div>

          <ul className="flex flex-col gap-0.5 text-[15px]">
            {t.lines.map((l) => (
              <li key={l.id} className="flex justify-between gap-3">
                <span>{l.product}</span><span className="num text-muted">{l.qty} sent</span>
              </li>
            ))}
          </ul>

          {t.note && <p className="text-[13px] text-muted">{t.note}</p>}

          {openId === t.id ? (
            <CheckItIn transfer={t} busy={busy} run={run} onDone={() => setOpenId(null)} />
          ) : (
            <Button className="self-start" onClick={() => setOpenId(t.id)}>
              Check what arrived
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function CheckItIn({
  transfer, busy, run, onDone,
}: {
  transfer: TransferRow;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onDone: () => void;
}) {
  const { backend } = useStaff();
  // Start by assuming it all turned up, which is the usual case, so a clean delivery is
  // one tap. Anything less has to be typed in on purpose.
  const [ok, setOk] = React.useState<Record<string, string>>(
    Object.fromEntries(transfer.lines.filter((l) => !l.isSerial).map((l) => [l.id, String(l.qty)])));
  const [damaged, setDamaged] = React.useState<Record<string, string>>({});
  const [serialState, setSerialState] = React.useState<Record<string, "ok" | "damaged" | "missing">>(
    Object.fromEntries(transfer.lines.flatMap((l) =>
      l.serials.map((s) => [s.id, "ok" as const]))));
  const [note, setNote] = React.useState("");

  const perLine = transfer.lines.map((l) => {
    if (l.isSerial) {
      const okIds = l.serials.filter((s) => serialState[s.id] === "ok").map((s) => s.id);
      const badIds = l.serials.filter((s) => serialState[s.id] === "damaged").map((s) => s.id);
      return { line: l, ok: okIds.length, damaged: badIds.length, okIds, badIds };
    }
    const o = Number(ok[l.id]) || 0;
    const d = Number(damaged[l.id]) || 0;
    return { line: l, ok: o, damaged: d, okIds: [] as string[], badIds: [] as string[] };
  });

  const short = perLine.reduce((n, x) => n + (x.line.qty - x.ok - x.damaged), 0);
  const tooMany = perLine.find((x) => x.ok + x.damaged > x.line.qty);

  return (
    <div className="flex flex-col gap-3 border-t border-subtle pt-3">
      <ul className="flex flex-col gap-2">
        {transfer.lines.map((l) => (
          <li key={l.id} className="flex flex-col gap-2">
            <span className="font-semibold">{l.product}</span>
            {l.isSerial ? (
              <ul className="flex flex-col gap-1">
                {l.serials.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2">
                    <span className="code min-w-[140px] text-[13px]">{s.serial}</span>
                    {(["ok", "damaged", "missing"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={serialState[s.id] === v}
                        onClick={() => setSerialState({ ...serialState, [s.id]: v })}
                        className={cn(
                          "min-h-11 rounded-lg px-2.5 text-[13px]",
                          serialState[s.id] === v
                            ? v === "ok"
                              ? "border-2 border-brand bg-ok-bg font-semibold text-ok-ink"
                              : "border-2 border-bad-ink bg-bad-bg font-semibold text-bad-ink"
                            : "border border-line hover:bg-subtle",
                        )}
                      >
                        {v === "ok" ? "Arrived fine" : v === "damaged" ? "Damaged" : "Not in the box"}
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-wrap gap-3">
                <div className="w-28">
                  <Field label="Arrived fine">
                    <Input
                      inputMode="numeric" value={ok[l.id] ?? ""} className="num"
                      onChange={(e) => setOk({ ...ok, [l.id]: e.target.value.replace(/\D/g, "") })}
                    />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Damaged">
                    <Input
                      inputMode="numeric" value={damaged[l.id] ?? ""} className="num"
                      onChange={(e) => setDamaged({ ...damaged, [l.id]: e.target.value.replace(/\D/g, "") })}
                    />
                  </Field>
                </div>
                <span className="self-end pb-2.5 text-[13px] text-muted">of {l.qty} sent</span>
              </div>
            )}
          </li>
        ))}
      </ul>

      <Field label="Note" hint="Anything worth saying about the state it came in.">
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      {short > 0 && (
        <p className="flex items-start gap-2 text-[13px] text-warn-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {short === 1 ? "One unit is" : `${short} units are`} unaccounted for. Confirming
          leaves this transfer open until a manager says what happened to{" "}
          {short === 1 ? "it" : "them"} — which is the point: the loss stays visible.
        </p>
      )}
      {tooMany && (
        <p role="alert" className="text-[13px] text-bad-ink">
          More {tooMany.line.product} than was sent. Check the slip against the boxes.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || Boolean(tooMany)}
          onClick={() => run(async () => {
            await backend.receiveTransfer({
              transferId: transfer.id,
              note: note || null,
              lines: perLine.map((x) => ({
                itemId: x.line.id,
                okQty: x.line.isSerial ? undefined : x.ok,
                damagedQty: x.line.isSerial ? undefined : x.damaged,
                serialsOk: x.line.isSerial ? x.okIds : undefined,
                serialsDamaged: x.line.isSerial ? x.badIds : undefined,
              })),
            });
            onDone();
          })}
        >
          Confirm what arrived
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>Not now</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function Requests({
  requests, products, busy, run,
}: {
  requests: TransferRequestRow[];
  products: Product[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch, branches } = useStaff();
  const [adding, setAdding] = React.useState(false);
  const [fromBranchId, setFromBranchId] = React.useState("");
  const [lines, setLines] = React.useState<{ productId: string; qty: string }[]>([]);
  const [query, setQuery] = React.useState("");
  const [note, setNote] = React.useState("");
  const [deciding, setDeciding] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  const others = branches.filter((b) => b.id !== branch.id);
  const byId = new Map(products.map((p) => [p.id, p]));
  const results = searchProducts(products, query, null).slice(0, 8);

  const reset = () => {
    setAdding(false); setLines([]); setQuery(""); setNote(""); setFromBranchId("");
  };

  return (
    <div className="flex flex-col gap-4">
      {!adding && others.length > 0 && (
        <Button className="self-start" onClick={() => setAdding(true)}>
          <ArrowRightLeft className="size-4" aria-hidden /> Ask another branch
        </Button>
      )}

      {adding && (
        <div className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-surface p-4">
          <h2 className="font-semibold">What does {branch.name} need?</h2>
          <Field label="Ask which branch" required>
            <select
              value={fromBranchId}
              onChange={(e) => setFromBranchId(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">Pick a branch</option>
              {others.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="trq-search">Add an item</Label>
            <Input
              id="trq-search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a name or code" className="h-12"
            />
            {query.trim() !== "" && (
              <ul className="flex flex-col gap-1">
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!lines.some((l) => l.productId === p.id)) {
                          setLines([...lines, { productId: p.id, qty: "1" }]);
                        }
                        setQuery("");
                      }}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line px-3 text-left hover:bg-subtle"
                    >
                      <span>{p.name} <span className="code text-[13px] text-muted">{p.code}</span></span>
                      <span className="text-[13px] text-muted">{p.stock} here</span>
                    </button>
                  </li>
                ))}
                {results.length === 0 && <li className="text-[13px] text-muted">Nothing matches.</li>}
              </ul>
            )}
          </div>

          <ul className="flex flex-col gap-2">
            {lines.map((l) => {
              const p = byId.get(l.productId);
              if (!p) return null;
              return (
                <li key={l.productId} className="flex flex-wrap items-end gap-3 rounded-lg border border-line p-3">
                  <span className="flex min-w-[180px] flex-1 flex-col">
                    <span className="font-semibold">{p.name}</span>
                    <span className="code text-[13px] text-muted">{p.code}</span>
                  </span>
                  <div className="w-24">
                    <Field label="How many">
                      <Input
                        inputMode="numeric" value={l.qty} className="num"
                        onChange={(e) => setLines(lines.map((x) =>
                          x.productId === l.productId
                            ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x))}
                      />
                    </Field>
                  </div>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}
                    aria-label={`Remove ${p.name}`}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>

          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              disabled={busy || lines.length === 0 || !fromBranchId}
              onClick={() => run(async () => {
                await backend.saveTransferRequest({
                  fromBranchId, toBranchId: branch.id, note: note || null,
                  lines: lines.map((l) => ({ productId: l.productId, qty: Number(l.qty) || 1 })),
                });
                reset();
              })}
            >
              Send the ask
            </Button>
            <Button variant="ghost" size="lg" onClick={reset} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}

      {requests.length === 0 && (
        <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
          No branch has asked this one for anything, and this one has asked for nothing.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {requests.map((r) => {
          const oursToDecide = r.status === "submitted" && r.fromBranchId === branch.id;
          return (
            <li key={r.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-col">
                  <span className="code font-semibold">{r.reqNo}</span>
                  <span className="text-[13px] text-muted">
                    {r.toBranchName} asked {r.fromBranchName}
                    {r.askedBy && ` · ${r.askedBy}`}
                  </span>
                </span>
                <Pill status={r.status} words={REQUEST_WORDS[r.status]} />
              </div>

              <ul className="flex flex-col gap-0.5 text-[15px]">
                {r.lines.map((l) => (
                  <li key={l.id} className="flex justify-between gap-3">
                    <span>{l.product}</span><span className="num">{l.qty}</span>
                  </li>
                ))}
              </ul>

              {r.note && <p className="text-[13px] text-muted">{r.note}</p>}
              {r.decisionNote && <p className="text-[13px] text-muted">{r.decisionNote}</p>}

              {oursToDecide && (
                deciding === r.id ? (
                  <div className="flex flex-wrap items-end gap-2 border-t border-subtle pt-2">
                    <div className="flex-[1_1_200px]">
                      <Field label="Why">
                        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                      </Field>
                    </div>
                    <Button
                      disabled={busy}
                      onClick={() => run(async () => {
                        await backend.decideTransferRequest(r.id, true, reason || null);
                        setDeciding(null); setReason("");
                      })}
                    >
                      Agree to send
                    </Button>
                    <Button
                      variant="outline" disabled={busy}
                      onClick={() => run(async () => {
                        await backend.decideTransferRequest(r.id, false, reason || null);
                        setDeciding(null); setReason("");
                      })}
                    >
                      Turn it down
                    </Button>
                    <Button variant="ghost" onClick={() => { setDeciding(null); setReason(""); }}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline" size="sm" className="self-start"
                    onClick={() => { setDeciding(r.id); setReason(""); }}
                  >
                    Decide
                  </Button>
                )
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inside one branch
// ---------------------------------------------------------------------------

function InsideBranch({
  products, busy, run,
}: {
  products: Product[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch } = useStaff();
  const [from, setFrom] = React.useState(branch.locations[0]?.id ?? "");
  const [to, setTo] = React.useState(branch.locations[1]?.id ?? "");
  const [lines, setLines] = React.useState<{ productId: string; qty: string }[]>([]);
  const [query, setQuery] = React.useState("");
  const [done, setDone] = React.useState(0);

  const byId = new Map(products.map((p) => [p.id, p]));
  const results = searchProducts(products, query, null).slice(0, 8);

  if (branch.locations.length < 2) {
    return (
      <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
        {branch.name} has one place to keep stock, so there is nothing to move between.
        Add a warehouse in Settings → Branches if this branch has one.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted">
        Moving stock between places inside {branch.name}. The goods have not left the
        building, so nothing goes on the road and nobody has to receive it.
      </p>

      {done > 0 && (
        <p className="flex items-center gap-2 text-[15px] font-semibold text-ok-ink">
          <Check className="size-5" aria-hidden /> Moved {done} {done === 1 ? "line" : "lines"}.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-[1_1_180px]">
          <Field label="From">
            <select
              value={from} onChange={(e) => setFrom(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              {branch.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="flex-[1_1_180px]">
          <Field label="To">
            <select
              value={to} onChange={(e) => setTo(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              {branch.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mv-search">What is moving?</Label>
        <Input
          id="mv-search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a name or code" className="h-12"
        />
        {query.trim() !== "" && (
          <ul className="flex flex-col gap-1">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!lines.some((l) => l.productId === p.id)) {
                      setLines([...lines, { productId: p.id, qty: "1" }]);
                    }
                    setQuery("");
                  }}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 text-left hover:bg-subtle"
                >
                  <span>{p.name} <span className="code text-[13px] text-muted">{p.code}</span></span>
                  <span className="text-[13px] text-muted">{p.stock} here</span>
                </button>
              </li>
            ))}
            {results.length === 0 && <li className="text-[13px] text-muted">Nothing matches.</li>}
          </ul>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {lines.map((l) => {
          const p = byId.get(l.productId);
          if (!p) return null;
          return (
            <li key={l.productId} className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-3">
              <span className="flex min-w-[180px] flex-1 flex-col">
                <span className="font-semibold">{p.name}</span>
                <span className="code text-[13px] text-muted">{p.code}</span>
              </span>
              <div className="w-24">
                <Field label="How many">
                  <Input
                    inputMode="numeric" value={l.qty} className="num"
                    onChange={(e) => setLines(lines.map((x) =>
                      x.productId === l.productId
                        ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x))}
                  />
                </Field>
              </div>
              <Button
                variant="ghost" size="sm"
                onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}
                aria-label={`Remove ${p.name}`}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>

      <Button
        size="lg" className="self-start"
        disabled={busy || lines.length === 0 || from === to}
        onClick={() => run(async () => {
          const res = await backend.moveWithinBranch({
            branchId: branch.id, fromLocationId: from, toLocationId: to,
            lines: lines.map((l) => ({ productId: l.productId, qty: Number(l.qty) || 1 })),
          });
          setDone(res.lines.length);
          setLines([]);
        })}
      >
        Move it
      </Button>
      {from === to && (
        <p className="text-[13px] text-warn-ink">Pick two different places.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History, and settling a shortage
// ---------------------------------------------------------------------------

function History({
  transfers, branchCount, busy, run,
}: {
  transfers: TransferRow[];
  branchCount: number;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const { backend, branch, staff } = useStaff();
  const [settling, setSettling] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [cancelling, setCancelling] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  if (transfers.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
        {branchCount < 2
          ? "This shop has one branch, so nothing has moved between branches."
          : "Nothing has been transferred to or from this branch yet."}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {transfers.map((t) => {
        const short = t.lines.reduce((n, l) => n + (l.qty - l.receivedQty), 0);
        const outgoing = t.fromBranchId === branch.id;
        return (
          <li key={t.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-col">
                <span className="code font-semibold">{t.transferNo}</span>
                <span className="text-[13px] text-muted">
                  {outgoing ? `To ${t.toBranchName}` : `From ${t.fromBranchName}`} ·{" "}
                  {new Date(t.sentAt).toLocaleDateString("en-GB")}
                  {t.totalCost > 0 && <> · <span className="num">{formatTaka(t.totalCost)}</span> at cost</>}
                </span>
              </span>
              <Pill status={t.status} words={TRANSFER_WORDS[t.status]} />
            </div>

            <ul className="flex flex-col gap-0.5 text-[15px]">
              {t.lines.map((l) => (
                <li key={l.id} className="flex flex-wrap justify-between gap-3">
                  <span>{l.product}</span>
                  <span className="num text-muted">
                    {l.qty} sent
                    {t.status !== "in_transit" && `, ${l.receivedQty} arrived`}
                    {l.damagedQty > 0 && ` (${l.damagedQty} damaged)`}
                    {l.qty > l.receivedQty && t.status !== "in_transit"
                      && ` · ${l.qty - l.receivedQty} missing`}
                  </span>
                </li>
              ))}
            </ul>

            {t.note && <p className="text-[13px] text-muted">{t.note}</p>}
            {t.resolution && (
              <p className="text-[13px] text-muted">
                Settled: the missing goods were{" "}
                {t.resolution === "returned" ? "sent back" : "written off"}.
              </p>
            )}

            {t.status === "disputed" && staff.role !== "cashier" && (
              settling === t.id ? (
                <div className="flex flex-col gap-2 border-t border-subtle pt-2">
                  <p className="text-[13px] text-muted">
                    {short === 1 ? "One unit" : `${short} units`} never turned up. Say what
                    happened — the answer changes the books, so it is kept.
                  </p>
                  <Field label="What happened" hint="Needed. It goes in the log with your name.">
                    <Input value={note} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy || !note.trim()}
                      onClick={() => run(async () => {
                        await backend.resolveTransfer(t.id, "returned", note);
                        setSettling(null); setNote("");
                      })}
                    >
                      {short === 1 ? "It went" : "They went"} back to {t.fromBranchName}
                    </Button>
                    <Button
                      variant="outline" disabled={busy || !note.trim()}
                      onClick={() => run(async () => {
                        await backend.resolveTransfer(t.id, "written_off", note);
                        setSettling(null); setNote("");
                      })}
                    >
                      Write {short === 1 ? "it" : "them"} off as lost
                    </Button>
                    <Button variant="ghost" onClick={() => { setSettling(null); setNote(""); }}>
                      Not yet
                    </Button>
                  </div>
                </div>
              ) : (
                <Button className="self-start" onClick={() => setSettling(t.id)}>
                  Settle what is missing
                </Button>
              )
            )}

            {t.status === "in_transit" && outgoing && (
              cancelling === t.id ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-subtle pt-2">
                  <div className="flex-[1_1_220px]">
                    <Field label="Why is it being called off?">
                      <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                    </Field>
                  </div>
                  <Button
                    disabled={busy || !reason.trim()}
                    onClick={() => run(async () => {
                      await backend.cancelTransfer(t.id, reason);
                      setCancelling(null); setReason("");
                    })}
                  >
                    Call it off and put the stock back
                  </Button>
                  <Button variant="ghost" onClick={() => { setCancelling(null); setReason(""); }}>
                    Keep it
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost" size="sm" className="self-start"
                  onClick={() => setCancelling(t.id)}
                >
                  Call it off
                </Button>
              )
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------

function Pill({ status, words }: { status: string; words: string }) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-[13px] font-semibold",
        status === "disputed" ? "bg-bad-bg text-bad-ink"
          : status === "in_transit" || status === "submitted" ? "bg-warn-bg text-warn-ink"
          : status === "received" || status === "approved" ? "bg-ok-bg text-ok-ink"
          : "bg-subtle text-muted",
      )}
    >
      {words}
    </span>
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
