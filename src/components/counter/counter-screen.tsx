"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { PackageOpen } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { computeTotals, isSessionExpired, parseDiscount, saleBlocker, searchProducts } from "@/lib/sale";
import { useSale } from "@/lib/store/sale-store";
import type { Approver, Category, Product, Receipt } from "@/lib/types";
import { ProductPicker } from "./product-picker";
import { ReceiptDialog } from "./receipt-dialog";
import { SalePanel } from "./sale-panel";

export function CounterScreen() {
  // Who and where comes from the shell, so switching branch re-renders the counter
  // with that branch's stock rather than reloading the whole app.
  const { backend, staff, branch, branches } = useStaff();
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
  const [receipt, setReceipt] = React.useState<Receipt | null>(null);

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
  const results = React.useMemo(() => searchProducts(products, query, categoryId), [products, query, categoryId]);
  const discountPct = parseDiscount(sale.discount);
  const totals = computeTotals(sale.lines, byId, discountPct);
  const blocker = staff
    ? saleBlocker({
        lines: sale.lines, products: byId, discountPct, discountLimitPct: staff.discountLimitPct,
        pinApproved: sale.approvalId !== null, phone: sale.phone, method: sale.method,
        cashReceived: sale.cashReceived, paymentRef: sale.paymentRef,
      })
    : "Loading";

  // Any change to the sale clears the last error.
  React.useEffect(() => { setSaleError(""); }, [sale.lines, sale.discount, sale.phone, sale.method, sale.cashReceived, sale.paymentRef]);
  React.useEffect(() => { setPinMessage(""); }, [sale.pin, sale.approverId]);

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
      const r = await backend.completeSale({
        lines: sale.lines,
        branchId: branch.id,
        paymentMethod: sale.method,
        discountPct,
        approvalId: discountPct > (staff?.discountLimitPct ?? 0) ? sale.approvalId : null,
        customerPhone: sale.phone || null,
        cashReceived: sale.method === "cash" ? Number(sale.cashReceived) : null,
        paymentRef: sale.method === "cash" ? null : sale.paymentRef,
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
            There is nothing to sell until this shop has a catalogue. Load the sample
            products with <span className="code">supabase/seed.sql</span>, or run{" "}
            <span className="code">pnpm doctor</span> to see what else is missing.
          </p>
          <Button onClick={() => window.location.reload()}>Check again</Button>
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
          approvers={approvers}
          checkingPin={checkingPin}
          pinMessage={pinMessage}
          approvedBy={approvedBy}
          onCheckPin={onCheckPin}
          onComplete={onComplete}
        />
      </main>
      )}

      {receipt && <ReceiptDialog receipt={receipt} onNewSale={onNewSale} />}
    </>
  );
}
