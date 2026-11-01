"use client";

import * as React from "react";
import {
  ArrowLeftRight, BookOpen, Check, Coins, FileText, Landmark, Printer, Receipt,
  RotateCcw, TriangleAlert, X,
} from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDay, formatTaka } from "@/lib/sale";
import type {
  Branch, ChartAccount, ChequeRow, MoneyBalance, SettingRow, Supplier, TrialBalance,
  VoucherKind, VoucherRow,
} from "@/lib/types";
import { cn, plural } from "@/lib/utils";
import { ChequePrintView } from "./cheque-print";
import { LedgerView } from "./ledger-view";

type Tab = "money" | "vouchers" | "trial" | "cheques" | "expenses";

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "money", label: "Money", icon: Landmark },
  { key: "vouchers", label: "Vouchers", icon: FileText },
  { key: "trial", label: "Trial balance", icon: BookOpen },
  { key: "cheques", label: "Cheques", icon: Receipt },
  { key: "expenses", label: "Expenses", icon: Coins },
];

const SOURCE_WORDS: Record<string, string> = {
  sale: "Sale", sale_return: "Return", grn: "Goods in", supplier_return: "Sent back",
  supplier_payment: "Paid supplier", customer_payment: "Collected",
  cash_movement: "Drawer", voucher: "Typed", cheque: "Cheque",
  fund_transfer: "Between branches", reversal: "Reversal", expense: "Expense",
};

/**
 * The books. Everything on this screen is already written: the day's sales, returns,
 * deliveries and drawer movements posted themselves as they happened, so this is for
 * looking, for the handful of entries a person types, and for cheques.
 */
export function AccountsScreen() {
  const { branch, branches, staff } = useStaff();
  const [tab, setTab] = React.useState<Tab>("money");
  const [error, setError] = React.useState("");
  const [note, setNote] = React.useState("");
  const [nonce, setNonce] = React.useState(0);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  const say = (e: unknown) => setError(e instanceof Error ? e.message : "That didn't work.");
  const done = (words: string) => { setError(""); setNote(words); reload(); };

  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-xl font-semibold">Accounts</h1>
        <p className="text-[13px] text-muted">
          {branch.name} · the day&rsquo;s sales, deliveries and drawer movements are already
          on the books
        </p>
      </div>

      <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label="Accounts sections">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => { setTab(key); setError(""); setNote(""); }}
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

      {error && <p role="alert" className="text-bad-ink">{error}</p>}
      {note && (
        <p className="flex items-center gap-2 rounded-xl border border-good-ink/30 bg-good-bg p-3 text-[15px] text-good-ink">
          <Check className="size-5 shrink-0" aria-hidden />
          {note}
        </p>
      )}

      {tab === "money" && (
        <MoneyTab key={nonce} branch={branch} branches={branches} onDone={done} onFail={say} />
      )}
      {tab === "vouchers" && (
        <VouchersTab key={nonce} branch={branch} onDone={done} onFail={say} />
      )}
      {tab === "trial" && <TrialTab key={nonce} branch={branch} onFail={say} />}
      {tab === "cheques" && (
        <ChequesTab key={nonce} branch={branch} onDone={done} onFail={say} />
      )}
      {tab === "expenses" && (
        <ExpensesTab key={nonce} branch={branch} onDone={done} onFail={say} />
      )}

      {staff.role === "owner" && tab === "trial" && (
        <BackfillRow onDone={done} onFail={say} />
      )}
      <p className="text-[13px] text-muted">
        Nothing here can be edited. A wrong entry is put right with a reversing entry, so
        the first one stays on the record — that is what makes the books worth keeping.
      </p>
    </main>
  );
}

/** What is in each drawer, bank account and wallet, and moving money between branches. */
function MoneyTab({ branch, branches, onDone, onFail }: {
  branch: Branch; branches: Branch[];
  onDone: (s: string) => void; onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<MoneyBalance[] | null>(null);
  const [pending, setPending] = React.useState<VoucherRow[]>([]);
  const [toBranch, setToBranch] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [why, setWhy] = React.useState("");
  const [kind, setKind] = React.useState<"fund" | "cost">("fund");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let off = false;
    Promise.all([backend.moneyBalances(), backend.voucherList({ source: "fund_transfer" })])
      .then(([b, v]) => {
        if (off) return;
        setRows(b);
        // Only the ones sent TO here that nobody has agreed to yet.
        setPending(v.filter((e) => e.otherBranch === branch.name && !e.acceptedAt));
      })
      .catch(onFail);
    return () => { off = true; };
  }, [backend, branch.name, onFail]);

  const send = async () => {
    setBusy(true);
    try {
      const r = await backend.interBranchEntry({
        fromBranchId: branch.id, toBranchId: toBranch, amount: Number(amount),
        narration: why || null, kind,
      });
      onDone(`${r.entryNo} sent. ${r.waitingOn ?? "The other branch"} has to accept it.`);
      setAmount(""); setWhy("");
    } catch (e) { onFail(e); } finally { setBusy(false); }
  };

  const others = branches.filter((b) => b.id !== branch.id);
  if (!rows) return <p className="text-muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-[13px] text-muted">Every branch&rsquo;s drawer, and the shop&rsquo;s banks and wallets</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((a) => (
          <li key={a.accountId} className="rounded-xl border border-line bg-white p-4">
            <p className="text-[13px] text-muted">{a.name}</p>
            <p className="num text-2xl font-semibold">{formatTaka(a.balance)}</p>
            {(a.unclearedOut > 0 || a.unclearedIn > 0) && (
              <p className="pt-1 text-[13px] text-muted">
                {a.unclearedOut > 0 && <>Cheques written, not yet taken: <span className="num">{formatTaka(a.unclearedOut)}</span>. </>}
                {a.unclearedIn > 0 && <>Banked, not yet cleared: <span className="num">{formatTaka(a.unclearedIn)}</span>.</>}
              </p>
            )}
          </li>
        ))}
        {rows.length === 0 && (
          <li className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted sm:col-span-2 lg:col-span-3">
            Nothing has gone through the books yet.
          </li>
        )}
      </ul>

      {pending.length > 0 && (
        <section className="rounded-xl border border-warn-ink/30 bg-warn-bg p-4">
          <h2 className="flex items-center gap-2 font-semibold text-warn-ink">
            <TriangleAlert className="size-5" aria-hidden />
            Waiting for {branch.name} to agree
          </h2>
          <ul className="flex flex-col gap-2 pt-2">
            {pending.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="code text-[13px]">{e.entryNo}</span>{" "}
                  {e.narration} from {e.branch} ·{" "}
                  <span className="num font-semibold">{formatTaka(e.amount)}</span>
                </span>
                <Button
                  onClick={async () => {
                    try {
                      const r = await backend.acceptInterBranch(e.id);
                      onDone(`${r.accepted} accepted. It is on ${branch.name}'s books now.`);
                    } catch (err) { onFail(err); }
                  }}
                >
                  Accept
                </Button>
              </li>
            ))}
          </ul>
          <p className="pt-2 text-[13px] text-warn-ink">
            Until it is accepted it is not on this branch&rsquo;s books. Nobody can charge
            another branch without their agreement.
          </p>
        </section>
      )}

      {others.length > 0 && (
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="flex items-center gap-2 font-semibold">
            <ArrowLeftRight className="size-5" aria-hidden />
            Send money, or pay a bill for another branch
          </h2>
          <div className="grid gap-3 pt-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              Which branch
              <select
                value={toBranch}
                onChange={(e) => setToBranch(e.target.value)}
                className="min-h-[44px] rounded-xl border border-line-strong bg-white px-3 text-[15px] text-ink"
              >
                <option value="">Pick a branch…</option>
                {others.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              What it is
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as "fund" | "cost")}
                className="min-h-[44px] rounded-xl border border-line-strong bg-white px-3 text-[15px] text-ink"
              >
                <option value="fund">Cash sent to them</option>
                <option value="cost">A bill paid for them</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              How much
              <Input
                inputMode="numeric" value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
                placeholder="0"
              />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              What for
              <Input value={why} onChange={(e) => setWhy(e.target.value)}
                     placeholder="Paid their courier bill" />
            </label>
          </div>
          <Button
            className="mt-3"
            disabled={busy || !toBranch || !(Number(amount) > 0)}
            onClick={send}
          >
            Send it
          </Button>
        </section>
      )}
    </div>
  );
}

/** The entries themselves, and the few a person types. */
function VouchersTab({ branch, onDone, onFail }: {
  branch: Branch; onDone: (s: string) => void; onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<VoucherRow[] | null>(null);
  const [chart, setChart] = React.useState<ChartAccount[]>([]);
  const [open, setOpen] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [kind, setKind] = React.useState<VoucherKind>("receipt");
  const [amount, setAmount] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [why, setWhy] = React.useState("");
  const [reversing, setReversing] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let off = false;
    Promise.all([backend.voucherList({ branchId: branch.id }), backend.chartOfAccounts()])
      .then(([v, c]) => { if (!off) { setRows(v); setChart(c); } })
      .catch(onFail);
    return () => { off = true; };
  }, [backend, branch.id, onFail]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await backend.saveVoucher({
        kind, branchId: branch.id, amount: Number(amount),
        fromAccount: from, toAccount: to, narration: why || null,
      });
      onDone(r.status === "awaiting_approval"
        ? `${r.entryNo} saved. It needs a manager before it reaches the books.`
        : `${r.entryNo} posted.`);
      setAdding(false); setAmount(""); setWhy("");
    } catch (e) { onFail(e); } finally { setBusy(false); }
  };

  if (!rows) return <p className="text-muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-3">
      {!adding && <Button onClick={() => setAdding(true)}>Type an entry</Button>}

      {adding && (
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="font-semibold">A new entry</h2>
          <div className="grid gap-3 pt-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              What kind
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as VoucherKind)}
                className="min-h-[44px] rounded-xl border border-line-strong bg-white px-3 text-[15px] text-ink"
              >
                <option value="receipt">Money came in</option>
                <option value="payment">Money went out</option>
                <option value="contra">Moved between the drawer and the bank</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              How much
              <Input
                inputMode="numeric" value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
                placeholder="0"
              />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              Out of
              <AccountPicker chart={chart} value={from} onChange={setFrom} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              Into
              <AccountPicker chart={chart} value={to} onChange={setTo} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted sm:col-span-2">
              What it was for
              <Input value={why} onChange={(e) => setWhy(e.target.value)}
                     placeholder="Banked the day's takings" />
            </label>
          </div>
          <div className="flex gap-2 pt-3">
            <Button disabled={busy || !from || !to || !(Number(amount) > 0)} onClick={save}>
              Save it
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </section>
      )}

      <ul className="flex flex-col gap-2">
        {rows.length === 0 && (
          <li className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
            No entries in the last month.
          </li>
        )}
        {rows.map((e) => (
          <li key={e.id} className="rounded-xl border border-line bg-white">
            <button
              type="button"
              onClick={() => setOpen(open === e.id ? null : e.id)}
              className="flex min-h-[44px] w-full items-center justify-between gap-3 p-3 text-left"
            >
              <span className="min-w-0">
                <span className="code text-[13px] text-muted">{e.entryNo}</span>
                <span className="block truncate">{e.narration}</span>
                <span className="text-[13px] text-muted">
                  {formatDay(e.date)} · {SOURCE_WORDS[e.sourceKind ?? ""] ?? e.sourceKind} · {e.who}
                  {e.status !== "posted" && ` · ${e.status === "awaiting_approval" ? "waiting for a manager" : "cancelled"}`}
                </span>
              </span>
              <span className="num shrink-0 font-semibold">{formatTaka(e.amount)}</span>
            </button>
            {open === e.id && (
              <div className="border-t border-line p-3">
                <table className="w-full text-[15px]">
                  <thead>
                    <tr className="text-left text-[13px] text-muted">
                      <th className="font-normal">Account</th>
                      <th className="font-normal text-right">Debit</th>
                      <th className="font-normal text-right">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.lines.map((l, i) => (
                      <tr key={`${e.id}-${i}`} className="border-t border-line/60">
                        <td className="py-1">
                          {l.account}
                          {l.party && <span className="text-[13px] text-muted"> · {l.party}</span>}
                        </td>
                        <td className="num py-1 text-right">{l.debit ? formatTaka(l.debit) : ""}</td>
                        <td className="num py-1 text-right">{l.credit ? formatTaka(l.credit) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex flex-wrap gap-2 pt-3">
                  {e.status === "awaiting_approval" && (
                    <>
                      <Button
                        onClick={async () => {
                          try {
                            await backend.approveVoucher(e.id, true);
                            onDone(`${e.entryNo} approved and posted.`);
                          } catch (err) { onFail(err); }
                        }}
                      >
                        Approve it
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await backend.approveVoucher(e.id, false, "Not approved");
                            onDone(`${e.entryNo} turned down.`);
                          } catch (err) { onFail(err); }
                        }}
                      >
                        Turn it down
                      </Button>
                    </>
                  )}
                  {e.status === "posted" && !e.reversesId && reversing !== e.id
                   && !rows.some((x) => x.reversesId === e.id) && (
                    <Button variant="ghost" onClick={() => { setReversing(e.id); setReason(""); }}>
                      <RotateCcw className="size-4" aria-hidden />
                      Reverse it
                    </Button>
                  )}
                  {rows.some((x) => x.reversesId === e.id) && (
                    <p className="text-[13px] text-muted">
                      Already reversed. An entry is only ever undone once.
                    </p>
                  )}
                </div>
                {reversing === e.id && (
                  <div className="flex flex-col gap-2 pt-3">
                    <label className="flex flex-col gap-1 text-[13px] text-muted">
                      Why is {e.entryNo} being reversed?
                      <Input
                        value={reason}
                        onChange={(ev) => setReason(ev.target.value)}
                        placeholder="Posted to the wrong account"
                        autoFocus
                      />
                    </label>
                    <div className="flex gap-2">
                      <Button
                        disabled={!reason.trim()}
                        onClick={async () => {
                          try {
                            const r = await backend.reverseEntry(e.id, reason.trim());
                            setReversing(null);
                            onDone(`${r.entryNo} undoes ${e.entryNo}. The first entry stays on the record.`);
                          } catch (err) { onFail(err); }
                        }}
                      >
                        Reverse it
                      </Button>
                      <Button variant="ghost" onClick={() => setReversing(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every account's balance, and the two columns that must match. */
function TrialTab({ branch, onFail }: { branch: Branch; onFail: (e: unknown) => void }) {
  const { backend } = useStaff();
  const [tb, setTb] = React.useState<TrialBalance | null>(null);
  const [allBranches, setAllBranches] = React.useState(true);
  const [openAccount, setOpenAccount] = React.useState<string | null>(null);

  React.useEffect(() => {
    let off = false;
    setTb(null);
    backend.trialBalance(allBranches ? null : branch.id)
      .then((r) => { if (!off) setTb(r); })
      .catch(onFail);
    return () => { off = true; };
  }, [backend, branch.id, allBranches, onFail]);

  if (!tb) return <p className="text-muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={allBranches ? "default" : "ghost"} onClick={() => setAllBranches(true)}>
          All branches
        </Button>
        <Button variant={allBranches ? "ghost" : "default"} onClick={() => setAllBranches(false)}>
          {branch.name}
        </Button>
      </div>

      {!tb.balanced && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-bad-ink/30 bg-bad-bg p-3 text-bad-ink">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          The two columns do not match. Something is wrong and it needs looking at.
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-line bg-white">
        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-line text-left text-[13px] text-muted">
              <th className="p-3 font-normal">Account</th>
              <th className="p-3 text-right font-normal">Debit</th>
              <th className="p-3 text-right font-normal">Credit</th>
            </tr>
          </thead>
          <tbody>
            {tb.accounts.map((a) => (
              <tr key={a.accountId} className="border-b border-line/60">
                <td className="p-3">
                  <button
                    type="button"
                    className="min-h-[44px] text-left underline-offset-2 hover:underline"
                    onClick={() => setOpenAccount(a.accountId)}
                  >
                    {a.name}
                    <span className="block text-[13px] text-muted">
                      <span className="code">{a.code}</span> · {a.group}
                    </span>
                  </button>
                </td>
                <td className="num p-3 text-right">{a.debit ? formatTaka(a.debit) : ""}</td>
                <td className="num p-3 text-right">{a.credit ? formatTaka(a.credit) : ""}</td>
              </tr>
            ))}
            {tb.accounts.length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-muted">
                Nothing posted yet.
              </td></tr>
            )}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="p-3">Total</td>
              <td className="num p-3 text-right">{formatTaka(tb.totalDebit)}</td>
              <td className="num p-3 text-right">{formatTaka(tb.totalCredit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[13px] text-muted">
        Tap an account to see every entry behind it.
      </p>

      {openAccount && (
        <LedgerView
          accountId={openAccount}
          branchId={allBranches ? null : branch.id}
          onClose={() => setOpenAccount(null)}
          onFail={onFail}
        />
      )}
    </div>
  );
}

/** Cheques written and received, and what happened to them. */
function ChequesTab({ branch, onDone, onFail }: {
  branch: Branch; onDone: (s: string) => void; onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<ChequeRow[] | null>(null);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [banks, setBanks] = React.useState<SettingRow[]>([]);
  const [printing, setPrinting] = React.useState<string | null>(null);
  const [bouncing, setBouncing] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [form, setForm] = React.useState({
    direction: "issued" as "issued" | "received",
    amount: "", chequeNo: "", bankAccountId: "", payee: "", supplierId: "",
    drawnOn: "", date: new Date().toISOString().slice(0, 10), note: "",
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  React.useEffect(() => {
    let off = false;
    Promise.all([backend.listCheques(), backend.listSuppliers(), backend.loadSettings()])
      .then(([c, s, bundle]) => {
        if (off) return;
        setRows(c);
        setSuppliers(s);
        setBanks(bundle.lists.bank_accounts.filter((b) => b.kind !== "cash_drawer"));
      })
      .catch(onFail);
    return () => { off = true; };
  }, [backend, onFail]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await backend.saveCheque({
        branchId: branch.id, direction: form.direction, amount: Number(form.amount),
        chequeDate: form.date, chequeNo: form.chequeNo || null,
        bankAccountId: form.bankAccountId || null,
        payee: form.payee || null, supplierId: form.supplierId || null,
        drawnOn: form.drawnOn || null, note: form.note || null,
      });
      onDone(`Cheque ${r.chequeNo} for ${formatTaka(r.amount)} recorded.`);
      setAdding(false);
    } catch (e) { onFail(e); } finally { setBusy(false); }
  };

  const settle = async (
    c: ChequeRow, status: "cleared" | "bounced" | "cancelled", reason?: string,
  ) => {
    try {
      const r = await backend.setChequeStatus(c.id, status, reason ?? null);
      setBouncing(null);
      onDone(r.reversed
        ? `Cheque ${r.chequeNo} is ${status}, and its entry has been reversed.`
        : `Cheque ${r.chequeNo} is ${status}.`);
    } catch (e) { onFail(e); }
  };

  if (!rows) return <p className="text-muted">Loading…</p>;
  const overdue = rows.filter((c) => c.overdue);

  return (
    <div className="flex flex-col gap-3">
      {!adding && <Button onClick={() => setAdding(true)}>Record a cheque</Button>}

      {adding && (
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="font-semibold">A cheque</h2>
          <div className="grid gap-3 pt-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              Which way
              <select
                value={form.direction}
                onChange={(e) => set("direction", e.target.value)}
                className="min-h-[44px] rounded-xl border border-line-strong bg-white px-3 text-[15px] text-ink"
              >
                <option value="issued">We wrote it</option>
                <option value="received">Somebody gave us one</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              Cheque number
              <Input value={form.chequeNo} onChange={(e) => set("chequeNo", e.target.value)}
                     placeholder="CB400101" />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              How much
              <Input inputMode="numeric" value={form.amount}
                     onChange={(e) => set("amount", e.target.value.replace(/\D/g, ""))}
                     placeholder="0" />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              Dated
              <Input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              {form.direction === "issued" ? "Our bank" : "Banked into"}
              <select
                value={form.bankAccountId}
                onChange={(e) => set("bankAccountId", e.target.value)}
                className="min-h-[44px] rounded-xl border border-line-strong bg-white px-3 text-[15px] text-ink"
              >
                <option value="">Pick an account…</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>{String(b.name)}</option>
                ))}
              </select>
              {banks.length === 0 && (
                <span className="text-[13px] text-warn-ink">
                  No bank account set up yet. Add the shop&rsquo;s bank under
                  Settings → Lists → Bank accounts first.
                </span>
              )}
            </label>
            {form.direction === "issued" ? (
              <>
                <label className="flex flex-col gap-1 text-[13px] text-muted">
                  To which supplier
                  <select
                    value={form.supplierId}
                    onChange={(e) => set("supplierId", e.target.value)}
                    className="min-h-[44px] rounded-xl border border-line-strong bg-white px-3 text-[15px] text-ink"
                  >
                    <option value="">Not a supplier</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[13px] text-muted">
                  Or pay to
                  <Input value={form.payee} onChange={(e) => set("payee", e.target.value)}
                         placeholder="Who it is written out to" />
                </label>
              </>
            ) : (
              <label className="flex flex-col gap-1 text-[13px] text-muted">
                Drawn on which bank
                <Input value={form.drawnOn} onChange={(e) => set("drawnOn", e.target.value)}
                       placeholder="Their bank" />
              </label>
            )}
            <label className="flex flex-col gap-1 text-[13px] text-muted sm:col-span-2">
              Note
              <Input value={form.note} onChange={(e) => set("note", e.target.value)} />
            </label>
          </div>
          <p className="pt-2 text-[13px] text-muted">
            A cheque is a promise, not money. It only moves the bank balance when it clears.
            If you have already recorded the payment itself, record the cheque against that
            payment instead, or the money is counted twice.
          </p>
          <div className="flex gap-2 pt-3">
            <Button disabled={busy || !(Number(form.amount) > 0)} onClick={save}>Save it</Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </section>
      )}

      {overdue.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-warn-ink/30 bg-warn-bg p-3 text-warn-ink">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          {overdue.length === 1
            ? "One cheque is past its date and still out."
            : `${overdue.length} cheques are past their date and still out.`}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {rows.length === 0 && (
          <li className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
            No cheques yet.
          </li>
        )}
        {rows.map((c) => (
          <li key={c.id} className="rounded-xl border border-line bg-white p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p>
                  <span className="code">{c.chequeNo}</span>{" "}
                  <span className="text-[13px] text-muted">
                    {c.direction === "issued" ? "written to" : "received from"}
                  </span>{" "}
                  {c.payee ?? "—"}
                </p>
                <p className="text-[13px] text-muted">
                  {c.chequeDate} · {c.bank ?? c.drawnOn ?? "no bank named"} · {c.branch}
                  {c.bouncedReason && ` · bounced: ${c.bouncedReason}`}
                </p>
              </div>
              <div className="text-right">
                <p className="num font-semibold">{formatTaka(c.amount)}</p>
                <p className={cn("text-[13px]",
                  c.status === "bounced" ? "text-bad-ink"
                  : c.status === "cleared" ? "text-good-ink" : "text-muted")}>
                  {c.status}
                </p>
              </div>
            </div>
            {c.status === "issued" && bouncing !== c.id && (
              <div className="flex flex-wrap gap-2 pt-2">
                <Button onClick={() => settle(c, "cleared")}>
                  <Check className="size-4" aria-hidden /> Cleared
                </Button>
                <Button variant="ghost" onClick={() => { setBouncing(c.id); setReason(""); }}>
                  Bounced
                </Button>
                <Button variant="ghost" onClick={() => settle(c, "cancelled")}>
                  <X className="size-4" aria-hidden /> Cancelled
                </Button>
                {c.direction === "issued" && (
                  <Button variant="ghost" onClick={() => setPrinting(c.id)}>
                    <Printer className="size-4" aria-hidden /> Print
                  </Button>
                )}
              </div>
            )}
            {bouncing === c.id && (
              <div className="flex flex-col gap-2 pt-2">
                <label className="flex flex-col gap-1 text-[13px] text-muted">
                  Why did cheque {c.chequeNo} bounce?
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Insufficient funds"
                    autoFocus
                  />
                </label>
                <div className="flex gap-2">
                  <Button
                    disabled={!reason.trim()}
                    onClick={() => settle(c, "bounced", reason.trim())}
                  >
                    It bounced
                  </Button>
                  <Button variant="ghost" onClick={() => setBouncing(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {printing && (
        <ChequePrintView
          chequeId={printing}
          onClose={() => setPrinting(null)}
          onFail={onFail}
        />
      )}
    </div>
  );
}

/** The daily expenses screen: a category, an amount, and how it was paid. */
function ExpensesTab({ branch, onDone, onFail }: {
  branch: Branch; onDone: (s: string) => void; onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [cats, setCats] = React.useState<SettingRow[] | null>(null);
  const [categoryId, setCategoryId] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [method, setMethod] = React.useState("cash");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let off = false;
    backend.loadSettings()
      .then((b) => {
        if (off) return;
        setCats(b.lists.transaction_categories.filter(
          (c) => String(c.applies_to ?? "").includes("expense")));
      })
      .catch(onFail);
    return () => { off = true; };
  }, [backend, onFail]);

  const save = async () => {
    setBusy(true);
    try {
      await backend.recordExpense({
        branchId: branch.id, categoryId, amount: Number(amount), method,
        note: note || null,
      });
      onDone(method === "cash"
        ? `${formatTaka(Number(amount))} taken out of the drawer.`
        : `${formatTaka(Number(amount))} recorded.`);
      setAmount(""); setNote("");
    } catch (e) { onFail(e); } finally { setBusy(false); }
  };

  if (!cats) return <p className="text-muted">Loading…</p>;

  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <h2 className="font-semibold">What did the shop spend?</h2>
      <div className="grid gap-3 pt-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          What for
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="min-h-[44px] rounded-xl border border-line-strong bg-white px-3 text-[15px] text-ink"
          >
            <option value="">Pick a category…</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{String(c.name)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          How much
          <Input inputMode="numeric" value={amount}
                 onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
                 placeholder="0" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          Paid how
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="min-h-[44px] rounded-xl border border-line-strong bg-white px-3 text-[15px] text-ink"
          >
            <option value="cash">Cash out of the drawer</option>
            <option value="bkash">bKash</option>
            <option value="nagad">Nagad</option>
            <option value="bank">Bank</option>
            <option value="card">Card</option>
            <option value="cheque">Cheque</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          Note
          <Input value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="Tea for the counter" />
        </label>
      </div>
      <p className="pt-2 text-[13px] text-muted">
        Cash goes through the open drawer, so the count at closing time expects the money
        to be gone. Anything else never touched the till and goes straight to the books.
      </p>
      <Button className="mt-3" disabled={busy || !categoryId || !(Number(amount) > 0)} onClick={save}>
        Record it
      </Button>
    </section>
  );
}

/** For a shop that has been trading before the books were switched on. */
function BackfillRow({ onDone, onFail }: {
  onDone: (s: string) => void; onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [busy, setBusy] = React.useState(false);
  return (
    <section className="rounded-xl border border-dashed border-line-strong bg-subtle p-4">
      <h2 className="font-semibold">Trading before the books were switched on?</h2>
      <p className="pt-1 text-[13px] text-muted">
        This writes the entries for sales, deliveries, payments and drawer movements that
        happened before. It is safe to press twice: anything already on the books is left
        alone.
      </p>
      <Button
        className="mt-3"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await backend.backfillAccounts();
            const total = r.sales + r.grns + r.saleReturns + r.supplierReturns
              + r.customerPayments + r.supplierPayments + r.cashMovements;
            // Stock brought onto the books counts as having caught something up, or the
            // screen says "nothing to do" having just posted the whole opening shelf.
            const stock = r.stockBroughtIn > 0
              ? ` The stock on the shelves came on at ${formatTaka(r.stockBroughtIn)}.`
              : "";
            onDone(total === 0 && stock === ""
              ? "Nothing to catch up on: everything is already on the books."
              : total === 0
                ? `Nothing to catch up on in the documents.${stock}`
                : `Caught up on ${plural(total, "document")}.${stock}`);
          } catch (e) { onFail(e); } finally { setBusy(false); }
        }}
      >
        Catch the books up
      </Button>
    </section>
  );
}

function AccountPicker({ chart, value, onChange }: {
  chart: ChartAccount[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-[44px] rounded-xl border border-line-strong bg-white px-3 text-[15px] text-ink"
    >
      <option value="">Pick an account…</option>
      {chart.filter((a) => a.active).map((a) => (
        <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
      ))}
    </select>
  );
}
