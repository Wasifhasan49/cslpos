"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatTaka, PAYMENT_METHODS } from "@/lib/sale";
import type {
  EmiPlan, PaymentMethod, Product, SaleExtras, SaleField, SettingRow, SplitPayment,
  StaffMember,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Everything BMS's sales screen can do, folded away until it is asked for.
 *
 * The simple cash sale is four actions and must stay four actions, so none of this is on
 * screen by default: the corporate fields, the exchange, the split payment and the
 * shop's own fields live behind one "More options" button, and the card and EMI panels
 * appear only when the card is picked or the goods can actually go on EMI.
 */
export function MoreOptions({
  extras, onChange, cardTypes, posAccounts, saleFields, team, emiPlans, emiAllowed,
  total, payingNow, products, cardChargeMode,
}: {
  extras: SaleExtras;
  onChange: (next: SaleExtras) => void;
  cardTypes: SettingRow[];
  posAccounts: SettingRow[];
  saleFields: SaleField[];
  team: StaffMember[];
  emiPlans: EmiPlan[];
  /** Every line in the cart can go on EMI. */
  emiAllowed: boolean;
  total: number;
  payingNow: number;
  products: Product[];
  cardChargeMode: "absorb" | "add";
}) {
  const [open, setOpen] = React.useState(false);
  const set = (patch: Partial<SaleExtras>) => onChange({ ...extras, ...patch });

  // What is filled in already, so a collapsed panel still says it has something in it.
  const filled = [
    extras.attention, extras.customerBin, extras.customerNid, extras.customerAddress,
    extras.narration, extras.soldBy,
  ].filter(Boolean).length
    + Object.values(extras.extraFields ?? {}).filter(Boolean).length
    + (extras.exchange ? 1 : 0)
    + (extras.payments?.length ? 1 : 0);

  return (
    <div className="flex flex-col gap-2 border-t border-subtle pt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-11 items-center justify-between gap-2 text-left text-sm font-semibold"
      >
        <span>
          More options
          {filled > 0 && (
            <span className="num ml-1.5 rounded-full bg-ok-bg px-1.5 text-xs text-ok-ink">
              {filled}
            </span>
          )}
        </span>
        {open ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
      </button>

      {open && (
        <div className="flex flex-col gap-3 rounded-lg bg-subtle p-3">
          {/* Who the invoice is addressed to, and what a corporate buyer's accounts
              department will ask for. */}
          <Field label="Attention" hint="The person inside the company the invoice is for.">
            <Input
              value={extras.attention ?? ""}
              onChange={(e) => set({ attention: e.target.value || null })}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <div className="flex-[1_1_150px]">
              <Field label="BIN">
                <Input
                  value={extras.customerBin ?? ""}
                  onChange={(e) => set({ customerBin: e.target.value || null })}
                  className="code"
                />
              </Field>
            </div>
            <div className="flex-[1_1_150px]">
              <Field label="NID">
                <Input
                  value={extras.customerNid ?? ""}
                  onChange={(e) => set({ customerNid: e.target.value || null })}
                  className="num"
                />
              </Field>
            </div>
          </div>
          <Field label="Address">
            <Input
              value={extras.customerAddress ?? ""}
              onChange={(e) => set({ customerAddress: e.target.value || null })}
            />
          </Field>
          <Field label="Note on the sale">
            <Input
              value={extras.narration ?? ""}
              onChange={(e) => set({ narration: e.target.value || null })}
            />
          </Field>

          {team.length > 1 && (
            <Field label="Sold by" hint="For a shop with floor staff and one till.">
              <select
                value={extras.soldBy ?? ""}
                onChange={(e) => set({ soldBy: e.target.value || null })}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                <option value="">Whoever is logged in</option>
                {team.filter((m) => m.active).map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </Field>
          )}

          {/* The shop's own fields. Nothing here unless the owner added some. */}
          {saleFields.map((f) => (
            <Field key={f.id} label={f.name} hint={f.showOnInvoice ? "Printed on the invoice." : undefined}>
              <Input
                value={extras.extraFields?.[f.name] ?? ""}
                onChange={(e) => set({
                  extraFields: { ...(extras.extraFields ?? {}), [f.name]: e.target.value },
                })}
              />
            </Field>
          ))}

          <Exchange
            exchange={extras.exchange}
            products={products}
            total={total}
            onChange={(exchange) => set({ exchange })}
          />

          <Split
            payments={extras.payments ?? []}
            payingNow={payingNow}
            posAccounts={posAccounts}
            onChange={(payments) => set({ payments })}
          />
        </div>
      )}

      {/* Card details belong with the card, not behind a button: picking Card and then
          not being asked which card is how a shop ends up unable to match a statement. */}
      {cardTypes.length > 0 && extras.card !== undefined && (
        <CardDetails
          card={extras.card}
          cardTypes={cardTypes}
          posAccounts={posAccounts}
          total={total}
          chargeMode={cardChargeMode}
          onChange={(card) => set({ card })}
        />
      )}

      {emiAllowed && emiPlans.length > 0 && (
        <Emi
          emi={extras.emi}
          plans={emiPlans}
          total={total}
          onChange={(emi) => set({ emi })}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CardDetails({
  card, cardTypes, posAccounts, total, chargeMode, onChange,
}: {
  card: NonNullable<SaleExtras["card"]>;
  cardTypes: SettingRow[];
  posAccounts: SettingRow[];
  total: number;
  chargeMode: "absorb" | "add";
  onChange: (card: NonNullable<SaleExtras["card"]>) => void;
}) {
  const type = cardTypes.find((c) => c.id === card.typeId);
  const pct = Number(type?.charge_pct ?? 0);
  const charge = Math.round((total * pct) / 100);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <span className="text-sm font-semibold">Card details</span>
      <div className="flex flex-wrap gap-2">
        <div className="flex-[1_1_160px]">
          <Field label="Which card">
            <select
              value={card.typeId ?? ""}
              onChange={(e) => onChange({ ...card, typeId: e.target.value || null })}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">Pick one</option>
              {cardTypes.filter((c) => c.active !== false).map((c) => (
                <option key={c.id} value={c.id}>{String(c.name)}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex-[1_1_120px]">
          <Field label="Last 4 digits">
            <Input
              inputMode="numeric" value={card.last4 ?? ""}
              onChange={(e) => onChange({ ...card, last4: e.target.value.replace(/\D/g, "").slice(0, 4) })}
              className="num"
            />
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex-[1_1_150px]">
          <Field label="Issuing bank">
            <Input
              value={card.bank ?? ""}
              onChange={(e) => onChange({ ...card, bank: e.target.value || null })}
            />
          </Field>
        </div>
        {posAccounts.length > 0 && (
          <div className="flex-[1_1_180px]">
            <Field label="Which machine" hint="The POS account the money arrives in.">
              <select
                value={card.posAccountId ?? ""}
                onChange={(e) => onChange({ ...card, posAccountId: e.target.value || null })}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                <option value="">Not recorded</option>
                {posAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{String(a.name)}</option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </div>
      {pct > 0 && (
        <p className="text-[13px] text-muted">
          {chargeMode === "add"
            ? <>The {pct}% card charge (<span className="num">{formatTaka(charge)}</span>) is added to the bill.</>
            : <>The card company takes {pct}% (<span className="num">{formatTaka(charge)}</span>). The shop absorbs it, so the customer pays the shelf price.</>}
        </p>
      )}
    </div>
  );
}

function Emi({
  emi, plans, total, onChange,
}: {
  emi: SaleExtras["emi"];
  plans: EmiPlan[];
  total: number;
  onChange: (emi: SaleExtras["emi"]) => void;
}) {
  // Only tenures the bank actually runs at this amount: offering 36 months on a 350-taka
  // adapter is how a shop ends up arguing with a bank.
  const usable = plans.filter((p) => total >= p.minAmount);
  const chosen = emi ? plans.find((p) => p.months === emi.months && (!emi.bank || p.bank === emi.bank)) : null;
  const charge = chosen ? Math.round((total * chosen.chargePct) / 100) : 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <span className="text-sm font-semibold">EMI</span>
      {usable.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nothing here reaches a bank&rsquo;s minimum for EMI
          {plans.length > 0 && <> (the lowest is <span className="num">{formatTaka(Math.min(...plans.map((p) => p.minAmount)))}</span>)</>}.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={!emi}
              onClick={() => onChange(undefined)}
              className={cn(
                "min-h-11 rounded-lg px-3 text-[15px] font-semibold",
                !emi ? "border-2 border-brand bg-ok-bg text-ok-ink" : "border border-line hover:bg-subtle",
              )}
            >
              No EMI
            </button>
            {usable.map((p) => {
              const on = emi?.months === p.months && emi?.bank === p.bank;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange({ months: p.months, bank: p.bank })}
                  className={cn(
                    "min-h-11 rounded-lg px-3 text-[15px] font-semibold",
                    on ? "border-2 border-brand bg-ok-bg text-ok-ink" : "border border-line hover:bg-subtle",
                  )}
                >
                  <span className="num">{p.months}</span> months
                  <span className="block text-xs font-normal text-muted">
                    {p.bank} · {p.chargePct}%
                  </span>
                </button>
              );
            })}
          </div>
          {chosen && (
            <p className="text-[13px] text-muted">
              {chosen.bank} adds <span className="num">{formatTaka(charge)}</span> at{" "}
              {chosen.chargePct}%, so the customer pays about{" "}
              <span className="num">{formatTaka(Math.round((total + charge) / chosen.months))}</span>{" "}
              a month for {chosen.months} months.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Exchange({
  exchange, products, total, onChange,
}: {
  exchange: SaleExtras["exchange"];
  products: Product[];
  total: number;
  onChange: (exchange: SaleExtras["exchange"]) => void;
}) {
  if (!exchange) {
    return (
      <Button
        variant="outline" size="sm" className="self-start"
        onClick={() => onChange({ description: "", value: 0 })}
      >
        <Plus className="size-4" aria-hidden /> Take something in exchange
      </Button>
    );
  }

  const bookIn = products.find((p) => p.id === exchange.productId);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">Taken in exchange</span>
        <Button
          variant="ghost" size="icon" aria-label="Remove the exchange"
          onClick={() => onChange(undefined)}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      <Field label="What is it?" hint="Enough that somebody can check it later.">
        <Input
          value={exchange.description}
          onChange={(e) => onChange({ ...exchange, description: e.target.value })}
          placeholder="Old HP Pavilion, 2019, working"
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <div className="flex-[1_1_140px]">
          <Field label="Worth">
            <Input
              inputMode="numeric" value={exchange.value ? String(exchange.value) : ""}
              onChange={(e) => onChange({ ...exchange, value: Number(e.target.value.replace(/\D/g, "")) || 0 })}
              className="num"
            />
          </Field>
        </div>
        <div className="flex-[1_1_150px]">
          <Field label="Its serial">
            <Input
              value={exchange.serial ?? ""}
              onChange={(e) => onChange({ ...exchange, serial: e.target.value || null })}
              className="code"
            />
          </Field>
        </div>
      </div>

      <label className="flex min-h-11 items-start gap-2.5 text-[15px]">
        <input
          type="checkbox"
          checked={exchange.addToStock ?? false}
          onChange={(e) => onChange({ ...exchange, addToStock: e.target.checked })}
          className="mt-0.5 size-5 accent-[var(--color-brand)]"
        />
        <span className="flex flex-col">
          Put it on the shelf to resell
          <span className="text-[13px] text-muted">
            It goes in at what you gave for it, so the margin on the resale is honest.
          </span>
        </span>
      </label>

      {exchange.addToStock && (
        <Field label="As which product?" hint="A used item still has to be something the shop sells.">
          <select
            value={exchange.productId ?? ""}
            onChange={(e) => onChange({ ...exchange, productId: e.target.value || null })}
            className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
          >
            <option value="">Pick a product</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      )}
      {exchange.addToStock && bookIn?.isSerial && !exchange.serial?.trim() && (
        <p className="text-[13px] text-warn-ink">
          {bookIn.name} is serial tracked, so the old unit needs a serial of its own.
        </p>
      )}
      {exchange.value > total && (
        <p className="text-[13px] text-warn-ink">
          An exchange can&rsquo;t be worth more than the sale ({formatTaka(total)}). Paying
          the difference out is a purchase, not a sale.
        </p>
      )}
    </div>
  );
}

function Split({
  payments, payingNow, posAccounts, onChange,
}: {
  payments: SplitPayment[];
  payingNow: number;
  posAccounts: SettingRow[];
  onChange: (payments: SplitPayment[]) => void;
}) {
  const sum = payments.reduce((n, p) => n + p.amount, 0);
  const left = payingNow - sum;

  if (payments.length === 0) {
    return (
      <Button
        variant="outline" size="sm" className="self-start"
        onClick={() => onChange([{ method: "cash", amount: payingNow }])}
      >
        <Plus className="size-4" aria-hidden /> Split across payment methods
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">Split the payment</span>
        <Button
          variant="ghost" size="icon" aria-label="Remove the split"
          onClick={() => onChange([])}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <ul className="flex flex-col gap-2">
        {payments.map((p, i) => (
          <li key={i} className="flex flex-wrap items-end gap-2">
            <div className="w-32">
              <Field label="How">
                <select
                  value={p.method}
                  onChange={(e) => onChange(payments.map((x, j) =>
                    j === i ? { ...x, method: e.target.value as PaymentMethod } : x))}
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                >
                  {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </Field>
            </div>
            <div className="w-28">
              <Field label="How much">
                <Input
                  inputMode="numeric" value={p.amount ? String(p.amount) : ""}
                  onChange={(e) => onChange(payments.map((x, j) =>
                    j === i ? { ...x, amount: Number(e.target.value.replace(/\D/g, "")) || 0 } : x))}
                  className="num"
                />
              </Field>
            </div>
            <div className="w-36">
              <Field label="Reference">
                <Input
                  value={p.reference ?? ""}
                  onChange={(e) => onChange(payments.map((x, j) =>
                    j === i ? { ...x, reference: e.target.value || null } : x))}
                  className="num"
                />
              </Field>
            </div>
            {posAccounts.length > 0 && p.method === "card" && (
              <div className="w-40">
                <Field label="Into">
                  <select
                    value={p.accountId ?? ""}
                    onChange={(e) => onChange(payments.map((x, j) =>
                      j === i ? { ...x, accountId: e.target.value || null } : x))}
                    className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
                  >
                    <option value="">Not recorded</option>
                    {posAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{String(a.name)}</option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <Button
              variant="ghost" size="icon" aria-label="Remove this part"
              onClick={() => onChange(payments.filter((_, j) => j !== i))}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline" size="sm"
          onClick={() => onChange([...payments, { method: "bkash", amount: Math.max(left, 0) }])}
        >
          <Plus className="size-4" aria-hidden /> Another part
        </Button>
        <span className={cn("text-[13px]", left === 0 ? "text-ok-ink" : "text-warn-ink")}>
          {left === 0
            ? "Adds up exactly."
            : left > 0
              ? <><span className="num">{formatTaka(left)}</span> still to account for</>
              : <><span className="num">{formatTaka(-left)}</span> too much</>}
        </span>
      </div>
    </div>
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
