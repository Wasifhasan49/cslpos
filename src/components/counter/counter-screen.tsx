"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { PackageOpen } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { computeTotals, isSessionExpired, parseDiscount, saleBlocker, searchProducts } from "@/lib/sale";
import { useSale } from "@/lib/store/sale-store";
import type {
  Approver, Category, CustomerLookup, EmiPlan, Product, Receipt, SaleField, SettingRow,
  ShiftState, StaffMember,
} from "@/lib/types";
import { ProductPicker } from "./product-picker";
import { TillStrip } from "./till-strip";
import { ReceiptDialog } from "./receipt-dialog";
import { SalePanel } from "./sale-panel";

export function CounterScreen() {
  // Who and where comes from the shell, so switching branch re-renders the counter
  // with that branch's stock rather than reloading the whole app.
  const { backend, staff, branch, branches, features } = useStaff();
  const sale = useSale();
  const denied = useSearchParams().get("denied");
  const searchRef = React.useRef<HTMLInputElement>(null);
  const flashTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const [categories, setCategories] = React.useState<Category[]>([]);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [approvers, setApprovers] = React.useState<Approver[]>([]);
  const [loadError, setLoadError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [saleError, setSaleError] = React.useState("");
  const [pinMessage, setPinMessage] = React.useState("");
  const [checkingPin, setCheckingPin] = React.useState(false);
  const [approvedBy, setApprovedBy] = React.useState<string | null>(null);
  const [customer, setCustomer] = React.useState<CustomerLookup | null>(null);
  const [receipt, setReceipt] = React.useState<Receipt | null>(null);
  const [shift, setShift] = React.useState<ShiftState | null>(null);
  const [shiftNonce, setShiftNonce] = React.useState(0);
  // What the advanced counter needs to offer (P10a). All optional: a shop that has set
  // none of it up sees exactly the simple counter.
  const [cardTypes, setCardTypes] = React.useState<SettingRow[]>([]);
  const [posAccounts, setPosAccounts] = React.useState<SettingRow[]>([]);
  const [saleFields, setSaleFields] = React.useState<SaleField[]>([]);
  const [team, setTeam] = React.useState<StaffMember[]>([]);
  const [emiPlans, setEmiPlans] = React.useState<EmiPlan[]>([]);
  const [cardChargeMode, setCardChargeMode] = React.useState<"absorb" | "add">("absorb");
  // Which products can go on EMI, asked once per product rather than per keystroke.
  const [emiFor, setEmiFor] = React.useState<Map<string, boolean>>(new Map());

  const say = React.useCallback((msg: string) => {
    clearTimeout(flashTimer.current);
    setFlash(msg);
    flashTimer.current = setTimeout(() => setFlash(""), 2500);
  }, []);
  React.useEffect(() => () => clearTimeout(flashTimer.current), []);

  const loadProducts = React.useCallback(async () => {
    setProducts(await backend.listProducts(branch.id));
  }, [backend, branch.id]);

  // Reloads whenever the branch changes: stock and serials are per branch, so the
  // catalogue the counter shows has to change with it.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [cats, prods, apprs] = await Promise.all([
          backend.listCategories(), backend.listProducts(branch.id), backend.listApprovers(),
        ]);
        if (cancelled) return;
        setCategories(cats);
        setProducts(prods);
        setApprovers(apprs);
        setLoadError("");
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load the shop.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [backend, branch.id]);

  // Loaded once: the card types, the POS accounts, the shop's extra fields, the team
  // and the bank's EMI plans. A failure here must not stop anyone selling, so each one
  // falls back to empty and the matching panel simply does not appear.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const [fields, plans, people, settings] = await Promise.all([
        backend.listSaleFields().catch(() => [] as SaleField[]),
        backend.listEmiPlans().catch(() => [] as EmiPlan[]),
        backend.listStaff().catch(() => [] as StaffMember[]),
        backend.loadSettings().catch(() => null),
      ]);
      if (cancelled) return;
      setSaleFields(fields);
      setEmiPlans(plans);
      setTeam(people);
      if (settings) {
        setCardTypes(settings.lists.card_types ?? []);
        setPosAccounts((settings.lists.bank_accounts ?? [])
          .filter((a) => a.active !== false));
        setCardChargeMode(settings.shop.cardChargeMode);
      }
    })();
    return () => { cancelled = true; };
  }, [backend]);

  // Whether the things in the cart can go on EMI. Asked only for products that are
  // actually in it, and only once each.
  React.useEffect(() => {
    let cancelled = false;
    const missing = sale.lines.map((l) => l.productId).filter((id) => !emiFor.has(id));
    if (missing.length === 0) return;
    (async () => {
      const answers = await Promise.all(missing.map(async (id) => {
        try {
          const h = await backend.priceHelp(id, branch.id, customer?.id ?? null);
          return [id, h.emiAllowed] as const;
        } catch {
          return [id, false] as const;
        }
      }));
      if (cancelled) return;
      setEmiFor((was) => {
        const next = new Map(was);
        for (const [id, ok] of answers) next.set(id, ok);
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [backend, branch.id, customer?.id, sale.lines, emiFor]);

  // The drawer is per branch and per person, so it is re-read when the branch changes,
  // after a sale, and whenever the strip changes it.
  React.useEffect(() => {
    let cancelled = false;
    backend.currentShift(branch.id)
      .then((s) => { if (!cancelled) setShift(s); })
      .catch(() => { if (!cancelled) setShift(null); });
    return () => { cancelled = true; };
  }, [backend, branch.id, shiftNonce, receipt]);

  // A part-built sale belongs to the branch it was started in, so switching clears it
  // rather than quietly moving the lines to another branch's stock.
  const lastBranch = React.useRef(branch.id);
  React.useEffect(() => {
    if (lastBranch.current !== branch.id) {
      lastBranch.current = branch.id;
      useSale.getState().reset();
      setReceipt(null);
      setApprovedBy(null);
      setPinMessage("");
    }
  }, [branch.id]);

  const byId = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // What the card charge, the EMI charge and an exchange do to the total. Worked out in
  // one place so the blocker, the panel and the database all agree on what is payable.
  const extraCharges = React.useMemo(() => {
    const base = computeTotals(sale.lines, byId, parseDiscount(sale.discount)).total;
    const cardType = cardTypes.find((c) => c.id === sale.extras.card?.typeId);
    const card = cardType && cardChargeMode === "add"
      ? Math.round((base * Number(cardType.charge_pct ?? 0)) / 100)
      : 0;
    const plan = sale.extras.emi
      ? emiPlans.find((p) => p.months === sale.extras.emi!.months
          && (!sale.extras.emi!.bank || p.bank === sale.extras.emi!.bank))
      : undefined;
    const emi = plan ? Math.round((base * plan.chargePct) / 100) : 0;
    return {
      total: card + emi,
      exchange: Math.min(sale.extras.exchange?.value ?? 0, base + card + emi),
    };
  }, [sale.lines, sale.discount, sale.extras, byId, cardTypes, cardChargeMode, emiPlans]);
  const results = React.useMemo(() => searchProducts(products, query, categoryId), [products, query, categoryId]);
  const discountPct = parseDiscount(sale.discount);
  const totals = computeTotals(sale.lines, byId, discountPct);
  const blocker = staff
    ? saleBlocker({
        lines: sale.lines, products: byId, discountPct, discountLimitPct: staff.discountLimitPct,
        pinApproved: sale.approvalId !== null, phone: sale.phone, method: sale.method,
        cashReceived: sale.cashReceived, paymentRef: sale.paymentRef,
        dueAmount: sale.dueAmount, customer,
        extraCharges: extraCharges.total, exchangeValue: extraCharges.exchange,
        cardLast4: sale.extras.card?.last4 ?? null,
      })
    : "Loading";

  // Any change to the sale clears the last error.
  React.useEffect(() => { setSaleError(""); }, [sale.lines, sale.discount, sale.phone, sale.method, sale.cashReceived, sale.paymentRef, sale.dueAmount]);
  React.useEffect(() => { setPinMessage(""); }, [sale.pin, sale.approverId]);

  // A customer's price list decides the prices on screen, so the catalogue is re-read
  // once a whole phone number is typed. A dealer should see dealer prices BEFORE the
  // sale is completed, not be surprised by the total.
  React.useEffect(() => {
    const phone = sale.phone;
    const id = sale.customerId;
    if (phone.length !== 11 && !id) {
      if (customer) { setCustomer(null); void loadProducts(); }
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Dialled, or picked by name — most of the traders that came over from BMS have
        // no number to dial, so the second way has to work as well as the first.
        const found = id ? await backend.customerById(id) : await backend.findCustomer(phone);
        if (cancelled || found?.id === customer?.id) return;
        setCustomer(found);
        setProducts(await backend.listProducts(branch.id, found?.priceListId ?? null));
      } catch {
        // A customer lookup failing must never stop a sale.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale.phone, sale.customerId, backend, branch.id]);

  const add = (p: Product) => { setSaleError(""); say(sale.addProduct(p)); };

  const onEnter = () => {
    const pick = results.find((p) => p.stock > 0);
    if (pick) { add(pick); setQuery(""); }
    else if (query.trim()) say(`No product in stock for “${query.trim()}”`);
  };

  const onCheckPin = async () => {
    if (!sale.approverId || checkingPin) return;
    setCheckingPin(true);
    setPinMessage("");
    try {
      // Checked for real, now, against the named manager — and the attempt is recorded
      // whether or not it worked. The old version just carried the PIN into the sale
      // and let the cashier find out it was wrong after the customer had waited.
      const r = await backend.verifyManagerPin(sale.approverId, sale.pin);
      if (r.ok) {
        sale.setApproval(r.approvalId);
        setApprovedBy(r.approverName);
        return;
      }
      setPinMessage(
        r.locked
          ? "Too many wrong tries. This manager's PIN is locked for 10 minutes. The owner can see the attempts."
          : `Wrong PIN. ${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left before it locks.`,
      );
    } catch (e) {
      setPinMessage(e instanceof Error ? e.message : "Couldn't check the PIN.");
    } finally {
      setCheckingPin(false);
    }
  };

  const onComplete = async () => {
    if (blocker || submitting) return;
    setSubmitting(true);
    setSaleError("");
    try {
      // What goes on the slate, and therefore what is being handed over now (P10).
      const onDue = Math.min(Math.max(Number(sale.dueAmount) || 0, 0), totals.total);
      const payingNow = totals.total - onDue;
      const r = await backend.completeSale({
        lines: sale.lines,
        branchId: branch.id,
        priceListId: customer?.priceListId ?? null,
        // Nothing paid now means the whole sale is on due, and the till should say so
        // rather than recording a cash sale where no cash moved.
        paymentMethod: payingNow === 0 && onDue > 0 ? "due" : sale.method,
        discountPct,
        dueAmount: onDue,
        // One approval covers whichever of the two needed it; the database checks both.
        approvalId: sale.approvalId,
        customerPhone: sale.phone || null,
        customerId: sale.customerId,
        cashReceived: sale.method === "cash" && payingNow > 0 ? Number(sale.cashReceived) : null,
        // For a card sale the last four digits ARE the reference, wherever they were typed.
        paymentRef: sale.method === "cash" || payingNow === 0
          ? null
          : sale.method === "card"
            ? sale.extras.card?.last4 || sale.paymentRef
            : sale.paymentRef,
        // Everything the advanced counter added (P10a). Sent only when something is
        // actually in it, so a simple sale carries nothing extra.
        extras: Object.keys(sale.extras).length > 0 ? sale.extras : undefined,
      });
      setReceipt(r);
      loadProducts().catch(() => say("Sale saved, but stock didn't refresh. Reload the page."));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't complete the sale.";
      // An expired session must not look like a broken account, and the sale lines stay
      // exactly where they are so nothing has to be rung up twice.
      if (isSessionExpired(msg)) { setSaleError(msg); return; }
      if (/approval|PIN/i.test(msg)) { sale.setApproval(null); setPinMessage(msg); }
      setSaleError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const onNewSale = React.useCallback(() => {
    setReceipt(null);
    useSale.getState().reset();
    setPinMessage("");
    setApprovedBy(null);
    setCustomer(null);
    setQuery("");
    setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted">Loading the shop…</div>;
  }
  if (loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-bad-ink">{loadError}</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </div>
    );
  }

  return (
    <>
      {/* Why a nav click bounced them here. The menu hides sections a role cannot
          open, but a typed-in URL still has to say something. */}
      {denied && (
        <div role="alert" className="border-b border-warn-line bg-warn-bg px-4 py-2.5 text-sm font-semibold text-warn-ink sm:px-6">
          {denied}
        </div>
      )}

      {shift && (
        <TillStrip state={shift} onChanged={() => setShiftNonce((n) => n + 1)} />
      )}

      {/* Which branch is selling. Only worth saying when there is more than one, but
          then it matters: it decides the stock, the serials and the invoice number. */}
      {branches.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-subtle bg-subtle px-4 py-2 text-[13px] sm:px-6">
          <span className="font-semibold">Selling at {branch.name}</span>
          <span className="code text-muted">{branch.code}</span>
          <span className="text-muted">· switch branch at the top of the screen</span>
        </div>
      )}

      {/* The live database starts empty, so this is the genuine first screen after a
          fresh setup — not a hypothetical edge case. */}
      {products.length === 0 ? (
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          <PackageOpen className="size-12 text-line-strong" aria-hidden />
          <h2 className="text-lg font-semibold">No products yet</h2>
          <p className="text-ink-soft">
            There is nothing to sell until this shop has a catalogue. Bring one in from
            the old system, or a spreadsheet, in Settings &rarr; Import — products
            first, then opening stock and serial numbers.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => window.location.assign("/settings/import")}>
              Go to Import
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>Check again</Button>
          </div>
        </main>
      ) : (
      <main className="mx-auto box-border flex w-full max-w-[1480px] flex-1 flex-wrap items-start gap-5 px-6 pb-8 pt-5">
        <ProductPicker
          searchRef={searchRef}
          query={query}
          onQuery={setQuery}
          onEnter={onEnter}
          categories={categories}
          categoryId={categoryId}
          onCategory={setCategoryId}
          results={results}
          onAdd={add}
          flash={flash}
          demo={backend.mode === "demo"}
          onSimulateScan={() => {
            const p = products.find((x) => x.code === "VEN-AUD-35");
            if (p) { add(p); say(`Scanned ${p.code} · ${p.name}`); }
          }}
        />
        <SalePanel
          staff={staff}
          products={byId}
          totals={totals}
          blocker={blocker}
          nextInvoiceHint="Invoice number is added when you complete"
          submitting={submitting}
          error={saleError}
          customer={customer}
          onFindCustomer={(q) => backend.customerFind(q)}
          approvers={approvers}
          checkingPin={checkingPin}
          pinMessage={pinMessage}
          approvedBy={approvedBy}
          creditOn={Boolean(features.credit_sales)}
          cardTypes={cardTypes}
          posAccounts={posAccounts}
          saleFields={saleFields}
          team={team}
          emiPlans={emiPlans}
          // Every line has to be EMI-able: a bank will not finance a laptop and a
          // 50-taka cable on one agreement, and the database refuses it too.
          emiAllowed={sale.lines.length > 0 && sale.lines.every((l) => emiFor.get(l.productId))}
          cardChargeMode={cardChargeMode}
          allProducts={products}
          onCheckPin={onCheckPin}
          onComplete={onComplete}
        />
      </main>
      )}

      {receipt && <ReceiptDialog receipt={receipt} onNewSale={onNewSale} />}
    </>
  );
}
