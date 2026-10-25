"use client";

import * as React from "react";
import { ArrowDownToLine, ArrowUpFromLine, Lock, TriangleAlert, Wallet } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatTaka } from "@/lib/sale";
import type { CashReason, ShiftState } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Bangladeshi notes, biggest first, for counting the drawer out loud. */
const NOTES = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

const CASH_REASONS: { value: CashReason; label: string; direction: "in" | "out" }[] = [
  { value: "expense", label: "Spent on something", direction: "out" },
  { value: "owner_took", label: "Owner took cash", direction: "out" },
  { value: "bank_deposit", label: "Put in the bank", direction: "out" },
  { value: "bought_change", label: "Bought change", direction: "out" },
  { value: "owner_put_in", label: "Owner put cash in", direction: "in" },
  { value: "other", label: "Something else", direction: "out" },
];

/**
 * The cash drawer, at the top of the counter.
 *
 * A cashier cannot sell until it is open — that rule lives in the database, and this is
 * where they do something about it rather than read an error. An owner may sell without
 * one and is told so, because an owner locked out of their own till at 9pm stops using
 * the app.
 */
export function TillStrip({
  state, onChanged,
}: {
  state: ShiftState;
  onChanged: () => void;
}) {
  const { backend, branch, staff } = useStaff();
  const [panel, setPanel] = React.useState<"none" | "open" | "cash" | "close">("none");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [closedMessage, setClosedMessage] = React.useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
    finally { setBusy(false); }
  };

  if (closedMessage) {
    return (
      <div className="border-b border-ok-line bg-ok-bg px-4 py-3 sm:px-6">
        <p className="flex items-center gap-2 text-[15px] font-semibold text-ok-ink">
          <Lock className="size-5" aria-hidden /> {closedMessage}
        </p>
        <Button
          variant="outline" size="sm" className="mt-2"
          onClick={() => { setClosedMessage(""); setPanel("open"); }}
        >
          Open the till again
        </Button>
      </div>
    );
  }

  if (!state.open) {
    return (
      <div
        className={cn(
          "border-b px-4 py-3 sm:px-6",
          state.maySellWithoutShift ? "border-warn-line bg-warn-bg" : "border-line bg-subtle",
        )}
      >
        {panel === "open" ? (
          <OpenTill
            lastClose={state.lastClose}
            busy={busy}
            error={error}
            onCancel={() => setPanel("none")}
            onOpen={(cash) => run(async () => {
              await backend.openShift(branch.id, cash);
              setPanel("none");
            })}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {state.maySellWithoutShift ? (
              <p className="flex items-start gap-2 text-[15px] text-warn-ink">
                <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
                <span>
                  The till isn&rsquo;t open, so nothing you sell can be checked against
                  the drawer at the end of the day.
                </span>
              </p>
            ) : (
              <p className="flex items-start gap-2 text-[15px]">
                <Wallet className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
                <span>
                  Open the till before selling. Count what is in the drawer now and type
                  it in — that figure is what the day gets checked against.
                </span>
              </p>
            )}
            <Button size="sm" onClick={() => setPanel("open")}>Open the till</Button>
            {error && <p role="alert" className="w-full text-sm text-bad-ink">{error}</p>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border-b border-subtle bg-subtle px-4 py-2 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
        <span className="flex items-center gap-1.5 font-semibold">
          <Wallet className="size-4 text-muted" aria-hidden /> Till open
        </span>
        {state.openedAt && (
          <span className="text-muted">
            since {new Date(state.openedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {state.openingCash != null && (
          <span className="text-muted">
            opened with <span className="num">{formatTaka(state.openingCash)}</span>
          </span>
        )}
        <span className="flex gap-1.5">
          <Button
            variant="ghost" size="sm"
            onClick={() => setPanel(panel === "cash" ? "none" : "cash")}
          >
            Cash in or out
          </Button>
          <Button
            variant="outline" size="sm"
            onClick={() => setPanel(panel === "close" ? "none" : "close")}
          >
            Close the till
          </Button>
        </span>
      </div>

      {error && <p role="alert" className="pt-2 text-sm font-semibold text-bad-ink">{error}</p>}

      {panel === "cash" && (
        <CashInOut
          busy={busy}
          onCancel={() => setPanel("none")}
          onSave={(input) => run(async () => {
            await backend.cashMovement({ branchId: branch.id, ...input });
            setPanel("none");
          })}
        />
      )}

      {panel === "close" && (
        <CloseTill
          busy={busy}
          showsFigures={staff.role !== "cashier"}
          onCancel={() => setPanel("none")}
          onClose={(countedCash, noteCounts, note) => run(async () => {
            const res = await backend.closeShift({
              shiftId: state.shiftId!, countedCash, noteCounts, note,
            });
            setPanel("none");
            setClosedMessage(
              res.difference == null
                ? "Till closed, thank you."
                : res.difference === 0
                  ? "Till closed. The drawer matches exactly."
                  : res.difference < 0
                    ? `Till closed. The drawer is ${formatTaka(-res.difference)} short of ${formatTaka(res.expected ?? 0)}.`
                    : `Till closed. The drawer has ${formatTaka(res.difference)} more than the expected ${formatTaka(res.expected ?? 0)}.`,
            );
          })}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function OpenTill({
  lastClose, busy, error, onOpen, onCancel,
}: {
  lastClose: number | null;
  busy: boolean;
  error: string;
  onOpen: (cash: number) => void;
  onCancel: () => void;
}) {
  const [cash, setCash] = React.useState(lastClose != null ? String(lastClose) : "");

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => { e.preventDefault(); onOpen(Number(cash) || 0); }}
    >
      <div className="w-40">
        <Field label="What is in the drawer now?">
          <Input
            autoFocus inputMode="numeric" value={cash} className="num"
            onChange={(e) => setCash(e.target.value.replace(/[^0-9.]/g, ""))}
          />
        </Field>
      </div>
      {lastClose != null && (
        <Button
          type="button" variant="ghost" size="sm" className="mb-1"
          onClick={() => setCash(String(lastClose))}
        >
          Same as last close: {formatTaka(lastClose)}
        </Button>
      )}
      <Button type="submit" disabled={busy}>{busy ? "Opening…" : "Open the till"}</Button>
      <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      {error && <p role="alert" className="w-full text-sm text-bad-ink">{error}</p>}
    </form>
  );
}

function CashInOut({
  busy, onSave, onCancel,
}: {
  busy: boolean;
  onSave: (input: {
    direction: "in" | "out"; amount: number; reason: CashReason;
    categoryId?: string | null; note?: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const { backend } = useStaff();
  const [reason, setReason] = React.useState<CashReason>("expense");
  const [amount, setAmount] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [categories, setCategories] = React.useState<{ id: string; name: string }[]>([]);

  React.useEffect(() => {
    void backend.listExpenseCategories().then(setCategories).catch(() => {});
  }, [backend]);

  const chosen = CASH_REASONS.find((r) => r.value === reason)!;
  const stop = !(Number(amount) > 0)
    ? "Type how much."
    : reason === "expense" && !categoryId
      ? "Pick what it was spent on."
      : reason === "other" && !note.trim()
        ? "Say what it was for."
        : null;

  return (
    <form
      className="flex flex-wrap items-end gap-3 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          direction: chosen.direction, amount: Number(amount), reason,
          categoryId: reason === "expense" ? categoryId : null,
          note: note || null,
        });
      }}
    >
      <div className="flex-[1_1_200px]">
        <Field label="Why">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as CashReason)}
            className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
          >
            {CASH_REASONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="w-32">
        <Field label="How much">
          <Input
            inputMode="numeric" value={amount} className="num"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          />
        </Field>
      </div>
      {reason === "expense" && (
        <div className="flex-[1_1_180px]">
          <Field label="Spent on">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">Pick one</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      <div className="flex-[2_1_200px]">
        <Field label={reason === "other" ? "What was it for?" : "Note"}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" disabled={busy || Boolean(stop)}>
        {chosen.direction === "out"
          ? <><ArrowUpFromLine className="size-4" aria-hidden /> Take it out</>
          : <><ArrowDownToLine className="size-4" aria-hidden /> Put it in</>}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      {stop && <p className="w-full text-[13px] text-muted">{stop}</p>}
    </form>
  );
}

function CloseTill({
  busy, showsFigures, onClose, onCancel,
}: {
  busy: boolean;
  showsFigures: boolean;
  onClose: (counted: number, noteCounts: Record<string, number> | null, note: string | null) => void;
  onCancel: () => void;
}) {
  const [counted, setCounted] = React.useState("");
  const [note, setNote] = React.useState("");
  const [counting, setCounting] = React.useState(false);
  const [byNote, setByNote] = React.useState<Record<string, string>>({});

  // Counting note by note is the honest way to do it, so the helper's total replaces
  // whatever was typed rather than sitting next to it.
  const helperTotal = NOTES.reduce((n, v) => n + v * (Number(byNote[v]) || 0), 0);
  const noteCounts = Object.fromEntries(
    NOTES.filter((v) => Number(byNote[v]) > 0).map((v) => [String(v), Number(byNote[v])]));

  return (
    <form
      className="flex flex-col gap-3 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        const total = counting ? helperTotal : Number(counted) || 0;
        onClose(total, counting ? noteCounts : null, note || null);
      }}
    >
      <p className="text-[13px] text-muted">
        Count what is physically in the drawer and type it in.{" "}
        {showsFigures
          ? "You will see what it should have been once it is closed."
          : "The owner checks it against what the day's sales say it should be."}
      </p>

      {counting ? (
        <>
          <ul className="flex flex-wrap gap-2">
            {NOTES.map((v) => (
              <li key={v} className="w-[86px]">
                <Field label={`৳${v}`}>
                  <Input
                    inputMode="numeric" value={byNote[v] ?? ""} className="num"
                    onChange={(e) => setByNote({ ...byNote, [v]: e.target.value.replace(/\D/g, "") })}
                  />
                </Field>
              </li>
            ))}
          </ul>
          <p className="text-[15px] font-semibold">
            Counted: <span className="num">{formatTaka(helperTotal)}</span>
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Field label="Counted cash">
              <Input
                autoFocus inputMode="numeric" value={counted} className="num"
                onChange={(e) => setCounted(e.target.value.replace(/[^0-9.]/g, ""))}
              />
            </Field>
          </div>
          <Button
            type="button" variant="ghost" size="sm" className="mb-1"
            onClick={() => setCounting(true)}
          >
            Count it note by note
          </Button>
        </div>
      )}

      <div className="max-w-[420px]">
        <Field label="Note" hint="Anything the owner should know about today's drawer.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={busy || (counting ? helperTotal <= 0 && Object.keys(noteCounts).length === 0 : counted === "")}
        >
          <Lock className="size-4" aria-hidden /> Close the till
        </Button>
        {counting && (
          <Button type="button" variant="ghost" onClick={() => setCounting(false)} disabled={busy}>
            Just type the total
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}
