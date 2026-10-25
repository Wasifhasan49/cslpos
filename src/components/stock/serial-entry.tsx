"use client";

import * as React from "react";
import { ScanBarcode, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { checkSerials, expandSerialRange, generateSerials, parseSerialList } from "@/lib/serials";
import type { Product } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Scanning serials, in one place: goods in, receiving against an order, and anything
 * later that takes serials. Four ways in, because a shop gets serials four ways — one
 * at a time off the box, pasted from the supplier's email, as a run, or not at all.
 */
export function SerialEntry({
  product, serials, otherSerials, onChange,
}: {
  product: Product;
  serials: string[];
  otherSerials: string[];
  onChange: (serials: string[]) => void;
}) {
  const [one, setOne] = React.useState("");
  const [paste, setPaste] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [mode, setMode] = React.useState<"scan" | "paste" | "range" | "make">("scan");
  const [problems, setProblems] = React.useState<{ serial: string; why: string }[]>([]);

  const accept = (incoming: string[]) => {
    const r = checkSerials(incoming, {
      alreadyHere: [...serials, ...otherSerials],
      expectedLength: null,
    });
    setProblems(r.problems);
    if (r.serials.length > 0) onChange([...serials, ...r.serials]);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-subtle pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label>Serial numbers</Label>
        <span className="num text-[13px] text-muted">{serials.length} scanned</span>
        <span className="flex gap-1">
          {([["scan", "Scan"], ["paste", "Paste"], ["range", "Range"], ["make", "Make up"]] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "min-h-11 rounded-lg px-2.5 text-[13px]",
                mode === m ? "border-2 border-brand bg-ok-bg font-semibold text-ok-ink"
                  : "border border-line hover:bg-subtle",
              )}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      {mode === "scan" && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); accept([one]); setOne(""); }}
        >
          <ScanBarcode className="size-5 text-muted" aria-hidden />
          <Input
            autoFocus
            value={one}
            onChange={(e) => setOne(e.target.value)}
            placeholder="Scan or type, then Enter"
            aria-label={`Scan a serial for ${product.name}`}
            className="code h-11 max-w-[280px] flex-1"
          />
          <Button type="submit" variant="outline" className="h-11" disabled={one.trim() === ""}>Add</Button>
        </form>
      )}

      {mode === "paste" && (
        <div className="flex flex-col gap-2">
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={3}
            aria-label={`Paste serials for ${product.name}`}
            placeholder="One a line, or separated by commas"
            className="code w-full rounded-lg border border-line-strong bg-surface p-3 text-base"
          />
          <Button
            variant="outline" className="h-11 self-start"
            onClick={() => { accept(parseSerialList(paste)); setPaste(""); }}
            disabled={paste.trim() === ""}
          >
            Add these
          </Button>
        </div>
      )}

      {mode === "range" && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const r = expandSerialRange(from, to);
            if (r.problems.length > 0) { setProblems(r.problems); return; }
            accept(r.serials);
            setFrom(""); setTo("");
          }}
        >
          <Field label="First">
            <Input value={from} onChange={(e) => setFrom(e.target.value)} className="code h-11 w-40" />
          </Field>
          <Field label="Last">
            <Input value={to} onChange={(e) => setTo(e.target.value)} className="code h-11 w-40" />
          </Field>
          <Button type="submit" variant="outline" className="h-11" disabled={!from.trim() || !to.trim()}>
            Add the range
          </Button>
          <span className="w-full text-xs text-muted">
            For serials that run in order, like SN0098 to SN0102. The padding is kept.
          </span>
        </form>
      )}

      {mode === "make" && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="How many">
            <Input
              id="make-count" inputMode="numeric" defaultValue="1"
              aria-label="How many serials to make up"
              className="num h-11 w-24"
            />
          </Field>
          <Button
            variant="outline" className="h-11"
            onClick={() => {
              const el = document.getElementById("make-count") as HTMLInputElement | null;
              const n = Number(el?.value) || 0;
              accept(generateSerials(product.code, n, serials.length + 1));
            }}
          >
            Make them up
          </Button>
          <span className="w-full text-xs text-muted">
            For items that arrived with no serial of their own. They are marked as the
            shop&rsquo;s own so nobody mistakes one for the maker&rsquo;s.
          </span>
        </div>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-0.5 text-[13px] text-bad-ink">
          {problems.map((p) => <li key={p.serial}><span className="code">{p.serial}</span>: {p.why}</li>)}
        </ul>
      )}

      {serials.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {serials.map((s) => (
            <li key={s} className="flex items-center gap-1 rounded-lg bg-subtle px-2 py-1 text-[13px]">
              <span className="code">{s}</span>
              <button
                type="button"
                onClick={() => onChange(serials.filter((x) => x !== s))}
                aria-label={`Remove ${s}`}
                className="flex size-6 items-center justify-center rounded text-muted hover:bg-line"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
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
