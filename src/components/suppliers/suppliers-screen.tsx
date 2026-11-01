"use client";

import * as React from "react";
import { Pencil, Plus, Store } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatTaka } from "@/lib/sale";
import type { Supplier, SupplierGroup } from "@/lib/types";
import { plural } from "@/lib/utils";

export function SuppliersScreen() {
  const { backend, staff } = useStaff();
  const [rows, setRows] = React.useState<Supplier[] | null>(null);
  const [groups, setGroups] = React.useState<SupplierGroup[]>([]);
  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<Supplier | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const [s, g] = await Promise.all([backend.listSuppliers(), backend.listSupplierGroups()]);
      setRows(s);
      setGroups(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the suppliers.");
    }
  }, [backend]);

  React.useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't save."); }
    finally { setBusy(false); }
  };

  if (error && !rows) {
    return <Main><p role="alert" className="text-bad-ink">{error}</p></Main>;
  }
  if (!rows) return <Main><p className="text-muted">Loading…</p></Main>;

  const canEdit = staff.role !== "cashier";
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) =>
    !q || `${r.name} ${r.phone ?? ""} ${r.address ?? ""}`.toLowerCase().includes(q));
  const owed = rows.reduce((n, r) => n + Math.max(r.balance, 0), 0);

  return (
    <Main>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Suppliers</h1>
          <p className="text-[13px] text-muted">
            {plural(rows.length, "supplier")} · <span className="num">{formatTaka(owed)}</span> owed in total
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => { setAdding(true); setEditing(null); }}>
            <Plus className="size-4" aria-hidden /> Add a supplier
          </Button>
        )}
      </div>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {adding && (
        <SupplierForm
          supplier={null} groups={groups} busy={busy}
          onCancel={() => setAdding(false)}
          onSave={async (input) => { await run(() => backend.saveSupplier(input)); setAdding(false); }}
        />
      )}

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, phone or address"
        aria-label="Search suppliers"
        className="h-11 max-w-[320px]"
      />

      <ul className="flex flex-col gap-1.5">
        {shown.length === 0 && (
          <li className="rounded-xl border border-dashed border-line-strong bg-subtle p-6 text-center text-muted">
            <Store className="mx-auto mb-2 size-8 text-line-strong" aria-hidden />
            No suppliers yet.
          </li>
        )}
        {shown.map((r) => (
          <li key={r.id}>
            {editing?.id === r.id ? (
              <SupplierForm
                supplier={r} groups={groups} busy={busy}
                onCancel={() => setEditing(null)}
                onSave={async (input) => { await run(() => backend.saveSupplier(input)); setEditing(null); }}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2.5">
                <div className="flex min-w-[200px] flex-1 flex-col">
                  <span className="font-semibold">
                    {r.name}
                    {r.isCashOnly && (
                      <span className="ml-2 text-[13px] font-normal text-muted">cash only</span>
                    )}
                    {!r.active && (
                      <span className="ml-2 text-[13px] font-normal text-warn-ink">turned off</span>
                    )}
                  </span>
                  <span className="text-[13px] text-muted">
                    {[r.phone, r.address, r.groupName].filter(Boolean).join(" · ") || "No contact details"}
                  </span>
                </div>
                <div className="flex min-w-[130px] flex-col text-right">
                  {/* A cash-only supplier never carries a balance, so saying "0 owed"
                      would imply they could. */}
                  {r.isCashOnly ? (
                    <span className="text-[13px] text-muted">no account</span>
                  ) : (
                    <>
                      <span className={`num font-semibold${r.balance > 0 ? " text-warn-ink" : ""}`}>
                        {formatTaka(r.balance)}
                      </span>
                      <span className="text-xs text-muted">
                        {r.balance > 0 ? "we owe them" : r.balance < 0 ? "they owe us" : "settled"}
                      </span>
                    </>
                  )}
                </div>
                {canEdit && (
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

function Main({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {children}
    </main>
  );
}

function SupplierForm({
  supplier, groups, busy, onSave, onCancel,
}: {
  supplier: Supplier | null;
  groups: SupplierGroup[];
  busy: boolean;
  onSave: (input: {
    id?: string; name: string; phone?: string | null; address?: string | null;
    groupId?: string | null; isCashOnly?: boolean; note?: string | null; active?: boolean;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [f, setF] = React.useState({
    name: supplier?.name ?? "", phone: supplier?.phone ?? "",
    address: supplier?.address ?? "", groupId: supplier?.groupId ?? "",
    note: supplier?.note ?? "",
    isCashOnly: supplier?.isCashOnly ?? false,
    active: supplier?.active ?? true,
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({
          id: supplier?.id,
          name: f.name,
          phone: f.phone || null,
          address: f.address || null,
          groupId: f.groupId || null,
          note: f.note || null,
          isCashOnly: f.isCashOnly,
          active: f.active,
        });
      }}
    >
      <h2 className="font-semibold">{supplier ? supplier.name : "New supplier"}</h2>
      <div className="flex flex-wrap gap-3">
        <div className="flex-[2_1_220px]">
          <Field label="Name" required>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </Field>
        </div>
        <div className="flex-[1_1_160px]">
          <Field label="Phone">
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className="num" />
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="flex-[2_1_220px]">
          <Field label="Address">
            <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </Field>
        </div>
        <div className="flex-[1_1_180px]">
          <Field label="Group" hint="For grouping suppliers in reports.">
            <select
              value={f.groupId}
              onChange={(e) => setF({ ...f, groupId: e.target.value })}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">None</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
        </div>
      </div>
      <Field label="Note">
        <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </Field>
      <div className="flex flex-wrap gap-4">
        <Check
          label="Cash only"
          hint="A one-off seller with no account. They can be paid, but never owed."
          checked={f.isCashOnly}
          onChange={(v) => setF({ ...f, isCashOnly: v })}
        />
        <Check label="In use" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !f.name.trim()}>
          {busy ? "Saving…" : supplier ? "Save" : "Add supplier"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

function Field({
  label, hint, required, children,
}: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
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
  label, hint, checked, onChange,
}: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 max-w-[300px] items-start gap-2.5 text-[15px]">
      <input
        type="checkbox" checked={checked}
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
