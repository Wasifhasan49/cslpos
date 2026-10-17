"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getBackend } from "@/lib/backend";
import { computeTotals, parseDiscount, saleBlocker, searchProducts } from "@/lib/sale";
import { useSale } from "@/lib/store/sale-store";
import type { Category, Product, Receipt, Staff } from "@/lib/types";
import { ProductPicker } from "./product-picker";
import { ReceiptDialog } from "./receipt-dialog";
import { SalePanel } from "./sale-panel";

export function CounterScreen() {
  const backend = React.useMemo(() => getBackend(), []);
  const router = useRouter();
  const sale = useSale();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const flashTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const [staff, setStaff] = React.useState<Staff | null>(null);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [loadError, setLoadError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [flash, setFlash] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [saleError, setSaleError] = React.useState("");
  const [pinError, setPinError] = React.useState(false);
  const [receipt, setReceipt] = React.useState<Receipt | null>(null);

  const say = React.useCallback((msg: string) => {
    clearTimeout(flashTimer.current);
    setFlash(msg);
    flashTimer.current = setTimeout(() => setFlash(""), 2500);
  }, []);
  React.useEffect(() => () => clearTimeout(flashTimer.current), []);

  const loadProducts = React.useCallback(async () => {
    setProducts(await backend.listProducts());
  }, [backend]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await backend.currentStaff();
        if (cancelled) return;
        if (!me) { router.replace("/login"); return; }
        setStaff(me);
        const [cats, prods] = await Promise.all([backend.listCategories(), backend.listProducts()]);
        if (cancelled) return;
        setCategories(cats);
        setProducts(prods);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load the shop.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [backend, router]);

  const byId = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const results = React.useMemo(() => searchProducts(products, query, categoryId), [products, query, categoryId]);
  const discountPct = parseDiscount(sale.discount);
  const totals = computeTotals(sale.lines, byId, discountPct);
  const blocker = staff
    ? saleBlocker({
        lines: sale.lines, products: byId, discountPct, discountLimitPct: staff.discountLimitPct,
        pinApproved: sale.pinApproved, phone: sale.phone, method: sale.method,
        cashReceived: sale.cashReceived, paymentRef: sale.paymentRef,
      })
    : "Loading";

  // Any change to the sale clears the last error.
  React.useEffect(() => { setSaleError(""); }, [sale.lines, sale.discount, sale.phone, sale.method, sale.cashReceived, sale.paymentRef]);

  const add = (p: Product) => { setSaleError(""); say(sale.addProduct(p)); };

  const onEnter = () => {
    const pick = results.find((p) => p.stock > 0);
    if (pick) { add(pick); setQuery(""); }
    else if (query.trim()) say(`No product in stock for “${query.trim()}”`);
  };

  const onCheckPin = async () => {
    const ok = await backend.checkManagerPin(sale.pin);
    if (ok === false) { setPinError(true); return; }
    setPinError(false);
    sale.setPinApproved(true); // null = the database checks it when saving
  };

  const onComplete = async () => {
    if (blocker || submitting) return;
    setSubmitting(true);
    setSaleError("");
    try {
      const r = await backend.completeSale({
        lines: sale.lines,
        paymentMethod: sale.method,
        discountPct,
        managerPin: discountPct > (staff?.discountLimitPct ?? 0) ? sale.pin : null,
        customerPhone: sale.phone || null,
        cashReceived: sale.method === "cash" ? Number(sale.cashReceived) : null,
        paymentRef: sale.method === "cash" ? null : sale.paymentRef,
      });
      setReceipt(r);
      loadProducts().catch(() => say("Sale saved, but stock didn't refresh. Reload the page."));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't complete the sale.";
      if (/PIN/i.test(msg)) { sale.setPinApproved(false); setPinError(true); }
      setSaleError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const onNewSale = React.useCallback(() => {
    setReceipt(null);
    useSale.getState().reset();
    setPinError(false);
    setQuery("");
    setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted">Loading the shop…</div>;
  }
  if (loadError || !staff) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-bad-ink">{loadError || "Not signed in."}</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </div>
    );
  }

  const today = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", weekday: "short", day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 bg-ink px-6 py-3 text-white">
        <div className="flex items-center gap-3.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-brand text-sm font-bold">CSL</div>
          <div className="flex flex-col">
            <span className="text-[17px] font-semibold">Counter</span>
            <span className="text-[13px] text-[#c9d2cc]">{staff.shopName}</span>
          </div>
          {backend.mode === "demo" && (
            <span className="rounded-full bg-focus px-2.5 py-0.5 text-xs font-semibold text-ink">Demo mode · sample data</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="text-[#c9d2cc]">{today}</span>
          <span className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-full bg-[#2c3a34] text-xs font-semibold">
              {staff.name.slice(0, 2).toUpperCase()}
            </span>
            {staff.name} · <span className="capitalize">{staff.role}</span>
          </span>
          {backend.mode === "supabase" && (
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10"
              onClick={async () => { await backend.signOut(); router.replace("/login"); }}
            >
              <LogOut className="size-4" aria-hidden /> Sign out
            </Button>
          )}
        </div>
      </header>

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
          pinMode={backend.mode === "demo" ? "local" : "server"}
          onCheckPin={onCheckPin}
          pinError={pinError}
          onComplete={onComplete}
        />
      </main>

      {receipt && <ReceiptDialog receipt={receipt} onNewSale={onNewSale} />}
    </div>
  );
}
