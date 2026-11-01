"use client";

import * as React from "react";
import { Check, TriangleAlert, Wallet } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { formatDay, formatTaka } from "@/lib/sale";
import type { CashMovementRow, ShiftRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const REASON_WORDS: Record<CashMovementRow["reason"], string> = {
  expense: "Spent", owner_took: "Owner took cash", owner_put_in: "Owner put cash in",
  bought_change: "Bought change", bank_deposit: "Put in the bank", other: "Other",
};

const METHOD_WORDS: Record<string, string> = {
  cash: "Cash", bkash: "bKash", nagad: "Nagad", card: "Card", rocket: "Rocket",
  bank: "Bank transfer", cheque: "Cheque", due: "On due",
};

/**
 * The drawer check, per branch. This is the screen that answers the question BMS cannot:
 * was there as much cash in the drawer as the day's sales say there should have been?
 */
export function CashScreen() {
  const { backend, branch, staff } = useStaff();
  const [rows, setRows] = React.useState<ShiftRow[] | null>(null);
  const [error, setError] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setRows(null);
    backend.listShifts(branch.id, 30)
      .then((r) => { if (!cancelled) { setRows(r); setError(""); } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the drawer.");
      });
    return () => { cancelled = true; };
  }, [backend, branch.id]);

  if (staff.role === "cashier") {
    return (
      <Main>
        <h1 className="text-xl font-semibold">Cash drawer</h1>
        <p className="text-ink-soft">
          Open and close your own till on the Counter screen. What the drawer should have
          held is for the owner to check.
        </p>
      </Main>
    );
  }

  if (error) return <Main><p role="alert" className="text-bad-ink">{error}</p></Main>;
  if (!rows) return <Main><p className="text-muted">Loading…</p></Main>;

  const short = rows.filter((r) => r.overLimit && (r.difference ?? 0) < 0);
  const openNow = rows.filter((r) => !r.closedAt);

  return (
    <Main>
      <div>
        <h1 className="text-xl font-semibold">Cash drawer</h1>
        <p className="text-[13px] text-muted">
          {branch.name} · the last {rows.length} {rows.length === 1 ? "till" : "tills"}
        </p>
      </div>

      {short.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-bad-ink/30 bg-bad-bg p-3 text-[15px] text-bad-ink">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <span>
            {short.length === 1 ? "One till came up" : `${short.length} tills came up`} short
            by more than the shop allows:{" "}
            {short.map((r) => `${r.staff} ${formatTaka(-(r.difference ?? 0))}`).join(", ")}.
          </span>
        </p>
      )}

      {rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
          <Wallet className="mx-auto mb-2 size-8 text-line-strong" aria-hidden />
          No till has been opened at {branch.name} yet. Staff open theirs on the Counter
          screen, with what is in the drawer at the time.
        </p>
      )}

      {openNow.length > 0 && (
        <p className="text-[13px] text-muted">
          {openNow.length === 1 ? "One till is" : `${openNow.length} tills are`} still open.
          For those, &ldquo;should hold&rdquo; is where the drawer stands right now.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const openRow = openId === r.id;
          return (
            <li key={r.id} className="rounded-lg border border-line bg-surface">
              <button
                type="button"
                onClick={() => setOpenId(openRow ? null : r.id)}
                aria-expanded={openRow}
                className="flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left hover:bg-subtle"
              >
                <span className="flex min-w-[150px] flex-1 flex-col">
                  <span className="font-semibold">{r.staff}</span>
                  <span className="text-[13px] text-muted">
                    {formatDay(r.openedAt)}{" "}
                    {new Date(r.openedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    {r.closedAt
                      ? ` – ${new Date(r.closedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
                      : " · still open"}
                    {" · "}{r.salesCount} {r.salesCount === 1 ? "sale" : "sales"}
                  </span>
                </span>
                <span className="flex min-w-[110px] flex-col text-right">
                  <span className="num text-[13px] text-muted">{formatTaka(r.expectedCash)}</span>
                  <span className="text-xs text-muted">should hold</span>
                </span>
                <span className="flex min-w-[110px] flex-col text-right">
                  <span className="num text-[13px] text-muted">
                    {r.countedCash == null ? "—" : formatTaka(r.countedCash)}
                  </span>
                  <span className="text-xs text-muted">counted</span>
                </span>
                <span className="flex min-w-[120px] flex-col text-right">
                  {r.difference == null ? (
                    <span className="text-[13px] text-muted">not closed yet</span>
                  ) : r.difference === 0 ? (
                    <span className="flex items-center justify-end gap-1 text-[13px] font-semibold text-ok-ink">
                      <Check className="size-4" aria-hidden /> exact
                    </span>
                  ) : (
                    <>
                      <span className={cn("num font-semibold", r.overLimit ? "text-bad-ink" : "text-warn-ink")}>
                        {formatTaka(Math.abs(r.difference))}
                      </span>
                      <span className="text-xs text-muted">
                        {r.difference < 0 ? "short" : "over"}
                      </span>
                    </>
                  )}
                </span>
              </button>

              {openRow && (
                <div className="flex flex-col gap-3 border-t border-subtle px-3 py-3">
                  <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[15px]">
                    <Pair label="Opened with" value={formatTaka(r.openingCash)} />
                    {Object.entries(r.byMethod).map(([m, amount]) => (
                      <Pair key={m} label={METHOD_WORDS[m] ?? m} value={formatTaka(amount)} />
                    ))}
                    {r.cashIn > 0 && <Pair label="Cash put in" value={formatTaka(r.cashIn)} />}
                    {r.cashOut > 0 && <Pair label="Cash taken out" value={formatTaka(r.cashOut)} />}
                  </dl>

                  {Object.keys(r.byMethod).filter((m) => m !== "cash").length > 0 && (
                    <p className="text-[13px] text-muted">
                      The figures above for bKash, Nagad and card are what the till
                      recorded. Match them against the statements from those providers —
                      the drawer check only covers cash.
                    </p>
                  )}

                  {r.movements.length > 0 && (
                    <ul className="flex flex-col gap-0.5 text-[15px]">
                      {r.movements.map((m, i) => (
                        <li key={`${m.at}-${i}`} className="flex flex-wrap justify-between gap-2">
                          <span>
                            <span className="text-[13px] text-muted">
                              {new Date(m.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                            </span>{" "}
                            {REASON_WORDS[m.reason]}
                            {m.category && ` · ${m.category}`}
                            {m.note && <span className="text-[13px] text-muted"> · {m.note}</span>}
                            {m.who && <span className="text-[13px] text-muted"> · {m.who}</span>}
                          </span>
                          <span className={cn("num", m.direction === "in" ? "text-ok-ink" : "text-warn-ink")}>
                            {m.direction === "in" ? "+" : "−"}{formatTaka(m.amount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {r.noteCounts && Object.keys(r.noteCounts).length > 0 && (
                    <div>
                      <p className="text-[13px] text-muted">Counted note by note:</p>
                      <ul className="flex flex-wrap gap-2 pt-1">
                        {Object.entries(r.noteCounts)
                          .sort((a, b) => Number(b[0]) - Number(a[0]))
                          .map(([note, count]) => (
                            <li key={note} className="rounded-lg bg-subtle px-2 py-1 text-[13px]">
                              <span className="num">৳{note}</span> × <span className="num">{count}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}

                  {r.note && <p className="text-[13px] text-muted">{r.note}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Main>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num font-semibold">{value}</dd>
    </div>
  );
}

function Main({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {children}
    </main>
  );
}
