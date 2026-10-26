"use client";

import * as React from "react";
import { X } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { formatTaka } from "@/lib/sale";
import type { AccountLedger } from "@/lib/types";

/**
 * One account, entry by entry, with a running balance.
 *
 * The running balance is worked out going down the list rather than asked for, so what
 * the screen shows is the lines it is showing — a figure that came from somewhere else
 * is a figure nobody can check.
 */
export function LedgerView({ accountId, branchId, onClose, onFail }: {
  accountId: string;
  branchId: string | null;
  onClose: () => void;
  onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [data, setData] = React.useState<AccountLedger | null>(null);

  React.useEffect(() => {
    let off = false;
    backend.accountLedger(accountId, null, null, branchId)
      .then((r) => { if (!off) setData(r); })
      .catch(onFail);
    return () => { off = true; };
  }, [backend, accountId, branchId, onFail]);

  const up = data && ["asset", "expense"].includes(data.account.nature) ? 1 : -1;
  let running = data?.opening ?? 0;

  return (
    <section className="rounded-xl border border-line bg-white">
      <div className="flex items-start justify-between gap-3 border-b border-line p-3">
        <div>
          <h2 className="font-semibold">{data ? data.account.name : "Loading…"}</h2>
          {data && (
            <p className="text-[13px] text-muted">
              <span className="code">{data.account.code}</span>
              {data.account.branch && ` · ${data.account.branch}`}
              {" · "}opening <span className="num">{formatTaka(data.opening)}</span>
            </p>
          )}
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close the ledger">
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      {data && (
        <div className="overflow-x-auto">
          <table className="w-full text-[15px]">
            <thead>
              <tr className="border-b border-line text-left text-[13px] text-muted">
                <th className="p-3 font-normal">What</th>
                <th className="p-3 text-right font-normal">Debit</th>
                <th className="p-3 text-right font-normal">Credit</th>
                <th className="p-3 text-right font-normal">Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l, i) => {
                running += up * (l.debit - l.credit);
                return (
                  <tr key={`${l.entryId}-${i}`} className="border-b border-line/60">
                    <td className="p-3">
                      {l.narration}
                      <span className="block text-[13px] text-muted">
                        {l.date} · <span className="code">{l.entryNo}</span>
                        {l.party && ` · ${l.party}`}
                        {l.note && ` · ${l.note}`}
                      </span>
                    </td>
                    <td className="num p-3 text-right">{l.debit ? formatTaka(l.debit) : ""}</td>
                    <td className="num p-3 text-right">{l.credit ? formatTaka(l.credit) : ""}</td>
                    <td className="num p-3 text-right">{formatTaka(running)}</td>
                  </tr>
                );
              })}
              {data.lines.length === 0 && (
                <tr><td colSpan={4} className="p-6 text-center text-muted">
                  Nothing has gone through this account.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
