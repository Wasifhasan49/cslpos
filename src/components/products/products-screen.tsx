"use client";

import * as React from "react";
import { AlertTriangle, Merge, Package, Pencil, Plus, Tags, X } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatTaka, warrantyLabel } from "@/lib/sale";
import type { BulkPriceChange, CatalogueRow, Category, PriceList } from "@/lib/types";
import { cn } from "@/lib/utils";

type QuickFilter = "all" | "low" | "out" | "serial" | "no_price" | "inactive";

const QUICK_FILTERS: { key: QuickFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "low", label: "Low stock" },
  { key: "out", label: "Out of stock" },
  { key: "no_price", label: "No price set" },
  { key: "serial", label: "Serial tracked" },
  { key: "inactive", label: "Turned off" },
];

export function ProductsScreen() {
  const { backend, staff, branch, features } = useStaff();
  const [rows, setRows] = React.useState<CatalogueRow[] | null>(null);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [lists, setLists] = React.useState<PriceList[]>([]);
  const [listId, setListId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [quick, setQuick] = React.useState<QuickFilter>("all");
  const [editing, setEditing] = React.useState<CatalogueRow | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [showCategories, setShowCategories] = React.useState(false);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [cat, cats, pls] = await Promise.all([
        backend.loadCatalogue(branch.id, listId),
        backend.listCategories(),
        backend.listPriceLists(),
      ]);
      setRows(cat);
      setCategories(cats);
      setLists(pls);
      if (!listId) setListId(pls.find((l) => l.isDefault)?.id ?? pls[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the products.");
    }
  }, [backend, branch.id, listId]);

  React.useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
  };

  // Cost is absent, not null, when this login may not see it — so the presence of the
  // key is the right test, and it is also what decides whether the columns exist.
  const showCost = rows?.some((r) => "cost" in r) ?? false;

  const shown = React.useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (categoryId && r.categoryId !== categoryId) return false;
      if (quick === "low" && !(r.stock > 0 && r.stock <= r.reorderLevel)) return false;
      if (quick === "out" && !(r.isInventory && r.stock <= 0)) return false;
      if (quick === "serial" && !r.isSerial) return false;
      if (quick === "no_price" && r.price > 0) return false;
      if (quick === "inactive" && r.active) return false;
      if (quick !== "inactive" && !r.active) return false;
      if (!q) return true;
      return `${r.name} ${r.brand ?? ""} ${r.code} ${r.model ?? ""} ${r.specification ?? ""}`
        .toLowerCase().includes(q);
    });
  }, [rows, query, categoryId, quick]);

  if (error && !rows) {
    return (
      <Main>
        <p role="alert" className="text-bad-ink">{error}</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </Main>
    );
  }
  if (!rows) return <Main><p className="text-muted">Loading…</p></Main>;

  const canEdit = staff.role !== "cashier";

  return (
    <Main>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Products</h1>
          <p className="text-[13px] text-muted">
            {rows.length} products · stock shown for {branch.name}
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setShowCategories((v) => !v)}>
              <Tags className="size-4" aria-hidden /> Categories
            </Button>
            <Button
              variant="outline"
              onClick={() => { setPicking((v) => !v); setPicked(new Set()); }}
            >
              {picking ? "Stop picking" : "Change prices in bulk"}
            </Button>
            <Button onClick={() => { setAdding(true); setEditing(null); }}>
              <Plus className="size-4" aria-hidden /> Add a product
            </Button>
          </div>
        )}
      </div>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {showCategories && (
        <CategoryManager
          categories={categories}
          busy={busy}
          onMerge={(from, into) => run(async () => { await backend.mergeCategories(from, into); })}
          onClose={() => setShowCategories(false)}
        />
      )}

      {adding && (
        <ProductForm
          row={null}
          categories={categories}
          busy={busy}
          vatOn={Boolean(features.vat)}
          onCancel={() => setAdding(false)}
          onSave={async (values) => {
            await run(() => backend.upsertProduct(null, values));
            setAdding(false);
          }}
        />
      )}

      {/* Filters. A toolbar rather than a settings panel, because finding one product
          among hundreds is the job this screen is actually for. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, code, brand or spec"
            className="h-11 max-w-[320px] flex-1"
            aria-label="Search products"
          />
          <select
            value={categoryId ?? ""}
            onChange={(e) => setCategoryId(e.target.value || null)}
            aria-label="Category"
            className="h-11 rounded-lg border border-line-strong bg-surface px-3 text-base"
          >
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {lists.length > 1 && (
            <select
              value={listId ?? ""}
              onChange={(e) => setListId(e.target.value || null)}
              aria-label="Price list"
              className="h-11 rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}{l.isDefault ? " (default)" : ""}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={quick === f.key}
              onClick={() => setQuick(f.key)}
              className={cn(
                "min-h-11 rounded-lg px-3 text-sm",
                quick === f.key
                  ? "border-2 border-brand bg-ok-bg font-semibold text-ok-ink"
                  : "border border-line text-ink hover:bg-subtle",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {picking && (
        <BulkPrices
          picked={[...picked]}
          lists={lists}
          listId={listId}
          busy={busy}
          onPreview={(input) => backend.bulkUpdatePrices({ ...input, dryRun: true })}
          onApply={async (input) => {
            await run(async () => { await backend.bulkUpdatePrices({ ...input, dryRun: false }); });
            setPicking(false);
            setPicked(new Set());
          }}
        />
      )}

      <p className="text-[13px] text-muted">
        Showing {shown.length} of {rows.length}
      </p>

      <ul className="flex flex-col gap-1.5">
        {shown.length === 0 && (
          <li className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
            <Package className="mx-auto mb-2 size-8 text-line-strong" aria-hidden />
            Nothing matches those filters.
          </li>
        )}
        {shown.map((r) => (
          <li key={r.id}>
            {editing?.id === r.id ? (
              <ProductForm
                row={r}
                categories={categories}
                busy={busy}
                vatOn={Boolean(features.vat)}
                lists={lists}
                listId={listId}
                onSetPrice={(input) => run(() => backend.setPrices(input))}
                onCancel={() => setEditing(null)}
                onSave={async (values) => {
                  await run(() => backend.upsertProduct(r.id, values));
                  setEditing(null);
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5">
                {picking && (
                  <input
                    type="checkbox"
                    checked={picked.has(r.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(r.id); else next.delete(r.id);
                      setPicked(next);
                    }}
                    aria-label={`Pick ${r.name}`}
                    className="size-5 accent-[var(--color-brand)]"
                  />
                )}
                <div className="flex min-w-[220px] flex-1 flex-col">
                  <span className="font-semibold leading-snug">{r.name}</span>
                  <span className="text-[13px] text-muted">
                    <span className="code">{r.code}</span>
                    {r.brand && ` · ${r.brand}`}
                    {r.category && ` · ${r.category}`}
                    {r.isSerial && " · serial tracked"}
                    {!r.isInventory && " · service, no stock"}
                  </span>
                  {r.specification && (
                    <span className="text-[13px] text-muted">{r.specification}</span>
                  )}
                </div>

                <div className="flex min-w-[110px] flex-col text-right">
                  <span className="num font-semibold">{formatTaka(r.price)}</span>
                  {r.minPrice != null && r.minPrice < r.price && (
                    <span className="num text-xs text-muted">down to {formatTaka(r.minPrice)}</span>
                  )}
                  {r.mrp != null && (
                    <span className="num text-xs text-muted">MRP {formatTaka(r.mrp)}</span>
                  )}
                </div>

                {showCost && (
                  <div className="flex min-w-[110px] flex-col text-right">
                    <span className="num text-[13px]">
                      {r.cost != null ? `cost ${formatTaka(r.cost)}` : "no cost yet"}
                    </span>
                    {r.marginPct != null && (
                      <span className={cn("num text-xs", r.marginPct < 10 ? "text-warn-ink" : "text-muted")}>
                        {r.marginPct}% margin
                      </span>
                    )}
                  </div>
                )}

                <div className="flex min-w-[96px] flex-col text-right">
                  {r.isInventory ? (
                    <>
                      <span className={cn("num text-[15px]", stockClass(r))}>
                        {r.stock} here
                      </span>
                      <span className="num text-xs text-muted">{r.totalStock} in all</span>
                    </>
                  ) : (
                    <span className="text-[13px] text-muted">no stock</span>
                  )}
                </div>

                <span className="min-w-[90px] text-right text-xs text-muted">
                  {r.warrantyTerm ?? warrantyLabel(r.warrantyMonths)}
                </span>

                {canEdit && !picking && (
                  <Button variant="ghost" size="sm" onClick={() => { setEditing(r); setAdding(false); }}>
                    <Pencil className="size-4" aria-hidden /> Change
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Main>
  );
}

function stockClass(r: CatalogueRow): string {
  if (r.stock <= 0) return "text-bad-ink font-semibold";
  if (r.stock <= r.reorderLevel) return "text-warn-ink font-semibold";
  return "";
}

function Main({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[1480px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {children}
    </main>
  );
}

// ---------------------------------------------------------------------------

function ProductForm({
  row, categories, busy, vatOn, lists, listId, onSave, onCancel, onSetPrice,
}: {
  row: CatalogueRow | null;
  categories: Category[];
  busy: boolean;
  vatOn: boolean;
  lists?: PriceList[];
  listId?: string | null;
  onSave: (values: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
  onSetPrice?: (input: {
    productId: string; priceListId: string; price: number;
    mrp?: number | null; minPrice?: number | null; maxPrice?: number | null;
  }) => Promise<void>;
}) {
  const [f, setF] = React.useState({
    name: row?.name ?? "", code: row?.code ?? "", brand: row?.brand ?? "",
    model: row?.model ?? "", barcode: row?.barcode ?? "",
    category_id: row?.categoryId ?? "", specification: row?.specification ?? "",
    warranty_months: String(row?.warrantyMonths ?? 12),
    reorder_level: String(row?.reorderLevel ?? 0),
    price: String(row?.price ?? ""),
    is_serial: row?.isSerial ?? false,
    is_inventory: row?.isInventory ?? true,
    active: row?.active ?? true,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  // Prices are a separate write from the product itself, because the band has to be
  // settable per list and a product can be on several.
  const [price, setPrice] = React.useState(String(row?.price ?? ""));
  const [mrp, setMrp] = React.useState(row?.mrp != null ? String(row.mrp) : "");
  const [minP, setMinP] = React.useState(row?.minPrice != null ? String(row.minPrice) : "");
  const [maxP, setMaxP] = React.useState(row?.maxPrice != null ? String(row.maxPrice) : "");

  return (
    <div className="flex flex-col gap-4 rounded-xl border-2 border-brand bg-surface p-4">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({
            ...f,
            category_id: f.category_id || null,
            warranty_months: Number(f.warranty_months) || 0,
            reorder_level: Number(f.reorder_level) || 0,
            price: Number(f.price) || 0,
          });
        }}
      >
        <h2 className="font-semibold">{row ? row.name : "New product"}</h2>
        <div className="flex flex-wrap gap-3">
          <div className="flex-[2_1_240px]">
            <Field label="Name" required><Input value={f.name} onChange={set("name")} required /></Field>
          </div>
          <div className="flex-[1_1_140px]">
            <Field label="Code" required hint="What a barcode scan looks for.">
              <Input value={f.code} onChange={set("code")} required className="code" />
            </Field>
          </div>
          <div className="flex-[1_1_140px]">
            <Field label="Barcode" hint="Only if different from the code.">
              <Input value={f.barcode} onChange={set("barcode")} className="code" />
            </Field>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex-[1_1_160px]">
            <Field label="Brand"><Input value={f.brand} onChange={set("brand")} /></Field>
          </div>
          <div className="flex-[1_1_160px]">
            <Field label="Model"><Input value={f.model} onChange={set("model")} /></Field>
          </div>
          <div className="flex-[1_1_180px]">
            <Field label="Category">
              <select
                value={f.category_id}
                onChange={set("category_id")}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
              >
                <option value="">None</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          </div>
        </div>
        <Field label="Specification" hint='Free text, e.g. "i5-1235U / 16GB / 512GB".'>
          <Input value={f.specification} onChange={set("specification")} />
        </Field>
        <div className="flex flex-wrap gap-3">
          <div className="flex-[1_1_120px]">
            <Field label="Warranty" hint="Months.">
              <Input inputMode="numeric" value={f.warranty_months} onChange={set("warranty_months")} className="num" />
            </Field>
          </div>
          <div className="flex-[1_1_120px]">
            <Field label="Re-order at" hint="Warn when stock drops to this.">
              <Input inputMode="numeric" value={f.reorder_level} onChange={set("reorder_level")} className="num" />
            </Field>
          </div>
          {!row && (
            <div className="flex-[1_1_120px]">
              <Field label="Price" required>
                <Input inputMode="decimal" value={f.price} onChange={set("price")} required className="num" />
              </Field>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-4">
          <Check
            label="Serial tracked"
            hint="Laptops, RAM, SSDs. The sale won't go through without a serial number."
            checked={f.is_serial}
            disabled={Boolean(row && row.stock > 0)}
            onChange={(v) => setF({ ...f, is_serial: v })}
          />
          <Check
            label="Keeps stock"
            hint="Off for a service like OS setup or repair labour."
            checked={f.is_inventory}
            onChange={(v) => setF({ ...f, is_inventory: v })}
          />
          <Check label="In use" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
        </div>
        {row && row.stock > 0 && (
          <p className="flex items-start gap-2 text-[13px] text-warn-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            This product has {row.stock} in stock, so it can&rsquo;t switch between serial
            tracked and not. Sell or write off the stock first.
          </p>
        )}
        {vatOn && (
          <p className="text-[13px] text-muted">
            VAT rate and HS code are set in Settings → Lists, then picked here in a later step.
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : row ? "Save product" : "Add product"}</Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </form>

      {row && onSetPrice && listId && (
        <form
          className="flex flex-col gap-3 border-t border-subtle pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onSetPrice({
              productId: row.id, priceListId: listId,
              price: Number(price) || 0,
              mrp: mrp === "" ? null : Number(mrp),
              minPrice: minP === "" ? null : Number(minP),
              maxPrice: maxP === "" ? null : Number(maxP),
            });
          }}
        >
          <h3 className="font-semibold">
            Price on {lists?.find((l) => l.id === listId)?.name ?? "this list"}
          </h3>
          <div className="flex flex-wrap gap-3">
            <div className="flex-[1_1_120px]">
              <Field label="Price" required>
                <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required className="num" />
              </Field>
            </div>
            <div className="flex-[1_1_120px]">
              <Field label="MRP" hint="Printed on the box.">
                <Input inputMode="decimal" value={mrp} onChange={(e) => setMrp(e.target.value)} className="num" />
              </Field>
            </div>
            <div className="flex-[1_1_120px]">
              <Field label="Lowest allowed" hint="Leave empty to allow no discount at all.">
                <Input inputMode="decimal" value={minP} onChange={(e) => setMinP(e.target.value)} className="num" />
              </Field>
            </div>
            <div className="flex-[1_1_120px]">
              <Field label="Highest allowed" hint="Usually left empty.">
                <Input inputMode="decimal" value={maxP} onChange={(e) => setMaxP(e.target.value)} className="num" />
              </Field>
            </div>
          </div>
          <p className="text-[13px] text-muted">
            Staff can sell anywhere between the lowest and highest. Below the lowest needs
            a manager&rsquo;s PIN, and every override is logged.
          </p>
          <Button type="submit" variant="outline" className="self-start" disabled={busy}>
            {busy ? "Saving…" : "Save price"}
          </Button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function BulkPrices({
  picked, lists, listId, busy, onPreview, onApply,
}: {
  picked: string[];
  lists: PriceList[];
  listId: string | null;
  busy: boolean;
  onPreview: (input: { productIds: string[]; priceListId: string; mode: "set" | "percent" | "amount"; value: number }) => Promise<BulkPriceChange[]>;
  onApply: (input: { productIds: string[]; priceListId: string; mode: "set" | "percent" | "amount"; value: number }) => Promise<void>;
}) {
  const [mode, setMode] = React.useState<"set" | "percent" | "amount">("percent");
  const [value, setValue] = React.useState("");
  const [preview, setPreview] = React.useState<BulkPriceChange[] | null>(null);
  const [error, setError] = React.useState("");

  const input = {
    productIds: picked,
    priceListId: listId ?? lists.find((l) => l.isDefault)?.id ?? "",
    mode,
    value: Number(value) || 0,
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-surface p-4">
      <h2 className="font-semibold">Change {picked.length} price{picked.length === 1 ? "" : "s"}</h2>
      {picked.length === 0 && (
        <p className="text-[13px] text-muted">Tick the products you want to change.</p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-[1_1_200px]">
          <Field label="What to do">
            <select
              value={mode}
              onChange={(e) => { setMode(e.target.value as typeof mode); setPreview(null); }}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="percent">Change by a percentage</option>
              <option value="amount">Change by an amount</option>
              <option value="set">Set them all to one price</option>
            </select>
          </Field>
        </div>
        <div className="flex-[1_1_140px]">
          <Field
            label={mode === "percent" ? "Percent" : "Taka"}
            hint={mode === "percent" ? "10 puts prices up 10%. −10 takes them down." : undefined}
          >
            <Input
              inputMode="decimal"
              value={value}
              onChange={(e) => { setValue(e.target.value.replace(/[^0-9.-]/g, "")); setPreview(null); }}
              className="num"
            />
          </Field>
        </div>
        <Button
          variant="outline"
          disabled={busy || picked.length === 0 || value === ""}
          onClick={async () => {
            setError("");
            try { setPreview(await onPreview(input)); }
            catch (e) { setError(e instanceof Error ? e.message : "Couldn't work that out."); }
          }}
        >
          Show me what changes
        </Button>
      </div>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {/* Nothing is written until this preview has been seen and confirmed: a bulk price
          change is the one action here that can quietly cost real money. */}
      {preview && (
        <div className="flex flex-col gap-2">
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {preview.map((c) => (
              <li key={c.productId} className="flex items-center justify-between gap-3 text-[15px]">
                <span className="truncate">{c.name}</span>
                <span className="num shrink-0">
                  {formatTaka(c.from)} → <span className="font-semibold">{formatTaka(c.to)}</span>
                </span>
              </li>
            ))}
          </ul>
          <Button disabled={busy} onClick={() => void onApply(input)}>
            {busy ? "Saving…" : `Apply to ${preview.length} product${preview.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CategoryManager({
  categories, busy, onMerge, onClose,
}: {
  categories: Category[];
  busy: boolean;
  onMerge: (from: string, into: string) => Promise<void>;
  onClose: () => void;
}) {
  const [from, setFrom] = React.useState("");
  const [into, setInto] = React.useState("");

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Categories</h2>
        <Button variant="ghost" size="sm" onClick={onClose}><X className="size-4" aria-hidden /></Button>
      </div>
      <p className="text-[13px] text-muted">
        Merging moves every product across and removes the old category. It&rsquo;s how you
        fix a misspelling like &ldquo;Convarter&rdquo; without re-filing each product by hand.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-[1_1_200px]">
          <Field label="Move everything from">
            <select
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">Choose…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="flex-[1_1_200px]">
          <Field label="Into">
            <select
              value={into}
              onChange={(e) => setInto(e.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">Choose…</option>
              {categories.filter((c) => c.id !== from).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <Button
          variant="outline"
          disabled={busy || !from || !into}
          onClick={() => void onMerge(from, into).then(() => { setFrom(""); setInto(""); })}
        >
          <Merge className="size-4" aria-hidden /> Merge
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Field({
  label, hint, required, children,
}: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}) {
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

function Check({
  label, hint, checked, disabled, onChange,
}: {
  label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 max-w-[260px] items-start gap-2.5 text-[15px]">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-brand)]"
      />
      <span className="flex flex-col">
        {label}
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}
