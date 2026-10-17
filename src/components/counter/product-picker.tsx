"use client";

import * as React from "react";
import { ScanLine, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTaka, warrantyLabel } from "@/lib/sale";
import type { Category, Product } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  searchRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  onEnter: () => void;
  categories: Category[];
  categoryId: string | null;
  onCategory: (id: string | null) => void;
  results: Product[];
  onAdd: (p: Product) => void;
  flash: string;
  demo: boolean;
  onSimulateScan: () => void;
}

export function ProductPicker(props: Props) {
  const { searchRef, query, onQuery, onEnter, categories, categoryId, onCategory, results, onAdd, flash, demo } = props;

  return (
    <section aria-label="Products" className="flex min-w-0 flex-[999_1_560px] flex-col gap-3.5">
      <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4">
        <label htmlFor="search" className="text-sm font-semibold">Find a product</label>
        <div className="flex flex-wrap gap-2.5">
          <div className="flex h-14 min-w-0 flex-[1_1_320px] items-center gap-2.5 rounded-[10px] border-2 border-ink bg-surface px-3.5 focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-focus">
            <Search className="size-5 text-muted" aria-hidden />
            <input
              id="search"
              ref={searchRef}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); onEnter(); }
                if (e.key === "Escape") onQuery("");
              }}
              placeholder="Scan a barcode, or type a name, brand or code"
              className="h-full min-w-0 flex-1 bg-transparent text-lg text-ink outline-none placeholder:text-muted/70"
            />
            {query && (
              <Button variant="ghost" size="icon" aria-label="Clear search" onClick={() => onQuery("")}>
                <X className="size-5" />
              </Button>
            )}
          </div>
          {demo && (
            <Button variant="outline" className="h-14 px-4" onClick={props.onSimulateScan}>
              <ScanLine className="size-5" aria-hidden /> Simulate a scan
            </Button>
          )}
        </div>
        <p className="text-[13px] text-muted">Press Enter to add the top result. Prices are set by the owner and fill in automatically.</p>
        <p role="status" aria-live="polite" className={cn("rounded-lg text-sm", flash && "bg-ok-bg px-3 py-2 text-ok-ink")}>{flash}</p>
      </div>

      <div role="group" aria-label="Categories" className="flex flex-wrap gap-2">
        {[{ id: null as string | null, name: "All" }, ...categories].map((c) => {
          const on = categoryId === c.id;
          return (
            <button
              key={c.id ?? "all"}
              type="button"
              aria-pressed={on}
              onClick={() => onCategory(c.id)}
              className={cn(
                "h-9 rounded-full border px-3.5 text-sm font-medium focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus",
                on ? "border-brand bg-brand text-white" : "border-line bg-surface text-ink hover:bg-subtle",
              )}
            >
              {c.name}
            </button>
          );
        })}
      </div>

      {results.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-surface p-8 text-center text-[15px] text-muted">
          {query ? <>No product matches “{query}”. Check the spelling, or try the brand name.</> : "No products in this category yet."}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
          {results.map((p) => {
            const out = p.stock <= 0;
            const low = !out && p.stock <= 3;
            return (
              <button
                key={p.id}
                type="button"
                disabled={out}
                onClick={() => onAdd(p)}
                aria-label={`Add ${p.name}, ${formatTaka(p.price)}${out ? ", out of stock" : ""}`}
                className={cn(
                  "flex min-h-[150px] flex-col gap-1.5 rounded-xl border border-line p-3.5 text-left transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-focus",
                  out ? "cursor-not-allowed bg-subtle opacity-70" : "bg-surface hover:border-brand hover:shadow-[0_2px_10px_rgba(11,107,79,0.12)]",
                )}
              >
                <span className="text-[15px] font-semibold leading-snug">{p.name}</span>
                <span className="text-[13px] text-muted">{p.brand} · <span className="code">{p.code}</span></span>
                <span className="mt-0.5 flex flex-wrap gap-1.5">
                  <Badge tone={out ? "out" : low ? "low" : "ok"}>{out ? "Out of stock" : `${p.stock} in stock`}</Badge>
                  {p.isSerial && <Badge tone="info">Serial tracked</Badge>}
                  <Badge>{warrantyLabel(p.warrantyMonths)}</Badge>
                </span>
                <span className="num mt-auto text-xl font-semibold">{formatTaka(p.price)}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
