"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Pencil, Plus, X } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  DOC_TYPE_LABELS, FEATURE_SWITCHES, MANAGER_SHARES, PERMISSION_AREA_LABELS,
  SETTING_LISTS, type FieldSpec, type ListSpec,
} from "@/lib/settings-schema";
import type { Role, SettingRow, SettingsBundle, StaffMember } from "@/lib/types";
import { cn } from "@/lib/utils";

type SectionKey = "shop" | "features" | "lists" | "permissions" | "documents";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "shop", label: "Shop" },
  { key: "lists", label: "Lists" },
  { key: "features", label: "Features" },
  { key: "permissions", label: "Who can do what" },
  { key: "documents", label: "Document numbers" },
];

export function SettingsScreen() {
  const { backend, staff, reload } = useStaff();
  const [bundle, setBundle] = React.useState<SettingsBundle | null>(null);
  const [team, setTeam] = React.useState<StaffMember[]>([]);
  const [section, setSection] = React.useState<SectionKey>("shop");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [b, t] = await Promise.all([backend.loadSettings(), backend.listStaff()]);
      setBundle(b);
      setTeam(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the settings.");
    }
  }, [backend]);

  React.useEffect(() => { void load(); }, [load]);

  /** One place for errors and reloading, so no screen below has to think about it. */
  const run = React.useCallback(async (fn: () => Promise<void>, refreshShell = false) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      // A feature switch or the shop's name changes the menu and the header, which come
      // from the staff lookup.
      if (refreshShell) reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
  }, [load, reload]);

  if (error && !bundle) {
    return (
      <Shell>
        <p role="alert" className="text-bad-ink">{error}</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </Shell>
    );
  }
  if (!bundle) return <Shell><p className="text-muted">Loading…</p></Shell>;

  const readOnly = staff.role !== "owner";

  return (
    <Shell>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Settings</h1>
        <span className="flex flex-wrap gap-4">
          <Link href="/settings/branches" className="text-sm text-ink-soft underline">
            Branches and staff →
          </Link>
          <Link href="/settings/import" className="text-sm text-ink-soft underline">
            Import from BMS →
          </Link>
        </span>
      </div>

      {readOnly && (
        <p className="rounded-lg bg-subtle p-3 text-sm text-ink-soft">
          You can look at these but not change them. Ask the owner if something needs changing.
        </p>
      )}

      <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto border-b border-line">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSection(s.key)}
            aria-current={section === s.key ? "page" : undefined}
            className={cn(
              "min-h-11 whitespace-nowrap border-b-2 px-3 text-sm font-medium",
              section === s.key ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {section === "shop" && <ShopSection bundle={bundle} busy={busy} readOnly={readOnly} run={run} />}
      {section === "lists" && <ListsSection bundle={bundle} busy={busy} readOnly={readOnly} run={run} />}
      {section === "features" && <FeaturesSection bundle={bundle} busy={busy} readOnly={readOnly} run={run} />}
      {section === "permissions" && (
        <PermissionsSection bundle={bundle} team={team} busy={busy} readOnly={readOnly} run={run} />
      )}
      {section === "documents" && <DocumentsSection bundle={bundle} busy={busy} readOnly={readOnly} run={run} />}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {children}
    </main>
  );
}

type Run = (fn: () => Promise<void>, refreshShell?: boolean) => Promise<void>;

interface SectionProps {
  bundle: SettingsBundle;
  busy: boolean;
  readOnly: boolean;
  run: Run;
}

// ---------------------------------------------------------------------------

function ShopSection({ bundle, busy, readOnly, run }: SectionProps) {
  const { backend } = useStaff();
  const s = bundle.shop;
  const [form, setForm] = React.useState({
    name: s.name, address: s.address ?? "", phone: s.phone ?? "", email: s.email ?? "",
    bin_vat: s.binVat ?? "", receipt_footer: s.receiptFooter ?? "",
    invoice_prefix: s.invoicePrefix, ait_pct: String(s.aitPct),
    po_approval_limit: String(s.poApprovalLimit),
    cash_short_limit: String(s.cashShortLimit),
    return_days: String(s.returnDays),
    sale_approval_limit: String(s.saleApprovalLimit),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => backend.saveShopDetails({
          ...form,
          ait_pct: Number(form.ait_pct) || 0,
          po_approval_limit: Number(form.po_approval_limit) || 0,
          cash_short_limit: Number(form.cash_short_limit) || 0,
          return_days: Number(form.return_days) || 0,
          sale_approval_limit: Number(form.sale_approval_limit) || 0,
        }), true);
      }}
    >
      <Field label="Shop name" required>
        <Input value={form.name} onChange={set("name")} disabled={readOnly} required />
      </Field>
      <Field label="Address" hint="Printed on receipts.">
        <Input value={form.address} onChange={set("address")} disabled={readOnly} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_200px]">
          <Field label="Phone"><Input value={form.phone} onChange={set("phone")} disabled={readOnly} className="num" /></Field>
        </div>
        <div className="flex-[1_1_200px]">
          <Field label="Email"><Input type="email" value={form.email} onChange={set("email")} disabled={readOnly} /></Field>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_200px]">
          <Field label="VAT registration (BIN)" hint="Leave empty if the shop is not registered.">
            <Input value={form.bin_vat} onChange={set("bin_vat")} disabled={readOnly} className="code" />
          </Field>
        </div>
        <div className="flex-[1_1_140px]">
          <Field label="Invoice prefix" hint="Goes in every invoice number.">
            <Input
              value={form.invoice_prefix}
              onChange={(e) => setForm({ ...form, invoice_prefix: e.target.value.toUpperCase() })}
              disabled={readOnly} className="code"
            />
          </Field>
        </div>
        <div className="flex-[1_1_120px]">
          <Field label="AIT" hint="Advance Income Tax on purchases.">
            <Input inputMode="decimal" value={form.ait_pct} onChange={set("ait_pct")} disabled={readOnly} className="num" />
          </Field>
        </div>
      </div>
      <Field
        label="Purchase orders over this need your approval"
        hint="0 means never. A manager's order above this figure waits for the owner instead of going to the supplier."
      >
        <Input
          inputMode="numeric" value={form.po_approval_limit}
          onChange={set("po_approval_limit")} disabled={readOnly} className="num"
        />
      </Field>
      <Field
        label="Flag a till that is out by more than"
        hint="A 5-taka coin is not theft. Anything further out than this is marked in red on the Cash drawer screen."
      >
        <Input
          inputMode="numeric" value={form.cash_short_limit}
          onChange={set("cash_short_limit")} disabled={readOnly} className="num"
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_180px]">
          <Field
            label="Returns are routine for (days)"
            hint="Past this a manager has to approve the return. 0 means every return needs one."
          >
            <Input
              inputMode="numeric" value={form.return_days}
              onChange={set("return_days")} disabled={readOnly} className="num"
            />
          </Field>
        </div>
        <div className="flex-[1_1_180px]">
          <Field
            label="Sales over this wait for approval"
            hint="0 means never. The goods still go out; what waits is the posting to the books."
          >
            <Input
              inputMode="numeric" value={form.sale_approval_limit}
              onChange={set("sale_approval_limit")} disabled={readOnly} className="num"
            />
          </Field>
        </div>
      </div>
      <Field label="Receipt footer" hint="The last line on every receipt.">
        <Input value={form.receipt_footer} onChange={set("receipt_footer")} disabled={readOnly} />
      </Field>
      <p className="text-[13px] text-muted">Currency is {s.currency}.</p>
      {!readOnly && (
        <Button type="submit" size="lg" className="self-start" disabled={busy}>
          {busy ? "Saving…" : "Save shop details"}
        </Button>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------

function ListsSection({ bundle, busy, readOnly, run }: SectionProps) {
  // A list whose feature is off is hidden, so the screen only shows what this shop uses.
  const shown = SETTING_LISTS.filter((l) => !l.feature || bundle.features[l.feature]);
  const hidden = SETTING_LISTS.filter((l) => l.feature && !bundle.features[l.feature]);

  return (
    <div className="flex flex-col gap-5">
      {shown.map((spec) => (
        <SettingList
          key={spec.table}
          spec={spec}
          rows={bundle.lists[spec.table] ?? []}
          busy={busy}
          readOnly={readOnly}
          run={run}
        />
      ))}
      {hidden.length > 0 && (
        <p className="text-[13px] text-muted">
          Also available once you turn the feature on in Features:{" "}
          {hidden.map((l) => l.title).join(", ")}.
        </p>
      )}
    </div>
  );
}

function SettingList({
  spec, rows, busy, readOnly, run,
}: {
  spec: ListSpec;
  rows: SettingRow[];
  busy: boolean;
  readOnly: boolean;
  run: Run;
}) {
  const { backend } = useStaff();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{spec.title}</h2>
        {!readOnly && !spec.fixedRows && (
          <Button variant="outline" size="sm" onClick={() => { setAdding(true); setEditing(null); }}>
            <Plus className="size-4" aria-hidden /> Add
          </Button>
        )}
      </div>
      <p className="text-[13px] text-muted">{spec.what}</p>

      {adding && (
        <RowForm
          spec={spec}
          row={null}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={async (values) => {
            await run(() => backend.saveSettingRow(spec.table, null, values).then(() => undefined));
            setAdding(false);
          }}
        />
      )}

      <ul className="flex flex-col gap-1.5">
        {rows.length === 0 && !adding && (
          <li className="rounded-lg border border-dashed border-line-strong bg-subtle p-3 text-[13px] text-muted">
            Nothing here yet.
          </li>
        )}
        {rows.map((r) => (
          <li key={r.id}>
            {editing === r.id ? (
              <RowForm
                spec={spec}
                row={r}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={async (values) => {
                  await run(() => backend.saveSettingRow(spec.table, r.id, values).then(() => undefined));
                  setEditing(null);
                }}
              />
            ) : (
              <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2">
                <span className="font-semibold">{String(r[spec.nameField] ?? "—")}</span>
                {spec.fields
                  .filter((f) => f.key !== spec.nameField)
                  .map((f) => ({ f, text: describe(f, r[f.key]) }))
                  .filter(({ text }) => text !== "")
                  .map(({ f, text }) => (
                    <span key={f.key} className="text-[13px] text-muted">{text}</span>
                  ))}
                {!readOnly && (
                  <Button
                    variant="ghost" size="sm" className="ml-auto"
                    onClick={() => { setEditing(r.id); setAdding(false); }}
                  >
                    <Pencil className="size-4" aria-hidden /> Change
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * How one field reads in the row summary.
 *
 * A switch that is ON is worth saying; one that is OFF usually is not, because
 * "not allow decimals" on every row is noise and bad English. The exceptions are the
 * ones where off is the point: a unit that is not in use, or a payment method the shop
 * does not take.
 */
const OFF_WORDS: Record<string, string> = {
  active: "Not in use",
  enabled: "Not taken",
};

function describe(f: FieldSpec, value: unknown): string {
  if (f.type === "bool") return value ? f.label : (OFF_WORDS[f.key] ?? "");
  if (value === null || value === undefined || value === "") return "";
  if (f.type === "select") {
    return f.options?.find((o) => o.value === String(value))?.label ?? String(value);
  }
  // "2%" not "2 %", but "6 months" keeps its space.
  const suffix = f.suffix ? (f.suffix === "%" ? "%" : ` ${f.suffix}`) : "";
  return `${f.label}: ${value}${suffix}`;
}

function RowForm({
  spec, row, busy, onCancel, onSave,
}: {
  spec: ListSpec;
  row: SettingRow | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (values: Record<string, string | number | boolean | null>) => Promise<void>;
}) {
  const editable = spec.fields.filter((f) => !f.readOnly);
  const [values, setValues] = React.useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      editable.map((f) => [
        f.key,
        f.type === "bool"
          ? Boolean(row ? row[f.key] : f.key === "active" || f.key === "enabled")
          : String(row?.[f.key] ?? ""),
      ]),
    ),
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const out: Record<string, string | number | boolean | null> = {};
    for (const f of editable) {
      const v = values[f.key];
      if (f.type === "bool") out[f.key] = Boolean(v);
      else if (f.type === "number") out[f.key] = Number(v) || 0;
      else out[f.key] = String(v).trim() === "" ? null : String(v).trim();
    }
    void onSave(out);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-brand bg-surface p-3">
      {spec.fields.filter((f) => f.readOnly).map((f) => (
        <p key={f.key} className="text-[13px] text-muted">
          {f.label}: <span className="code">{String(row?.[f.key] ?? "")}</span>
        </p>
      ))}
      <div className="flex flex-wrap gap-3">
        {editable.map((f) => (
          <div key={f.key} className={f.type === "bool" ? "flex-[1_1_100%]" : "flex-[1_1_180px]"}>
            {f.type === "bool" ? (
              <label className="flex min-h-11 items-center gap-2.5 text-[15px]">
                <input
                  type="checkbox"
                  checked={Boolean(values[f.key])}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })}
                  className="size-5 accent-[var(--color-brand)]"
                />
                <span className="flex flex-col">
                  {f.label}
                  {f.hint && <span className="text-xs text-muted">{f.hint}</span>}
                </span>
              </label>
            ) : (
              <Field label={f.label} hint={f.hint} required={f.required} suffix={f.suffix}>
                {f.type === "select" ? (
                  <select
                    value={String(values[f.key] ?? "")}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    required={f.required}
                    className="h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-focus"
                  >
                    <option value="">Choose…</option>
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <Input
                    value={String(values[f.key] ?? "")}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    required={f.required}
                    inputMode={f.type === "number" ? "decimal" : undefined}
                    className={f.type === "number" ? "num" : undefined}
                  />
                )}
              </Field>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : row ? "Save" : "Add"}</Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function FeaturesSection({ bundle, busy, readOnly, run }: SectionProps) {
  const { backend } = useStaff();

  const toggle = (key: string, on: boolean) =>
    // Refreshes the shell: turning a feature on or off adds or removes a menu section.
    run(() => backend.setFeature(key as never, on), true);

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Features</h2>
        <p className="text-[13px] text-muted">
          Everything here is off for a new shop. Turn on only what this shop needs, and the
          rest stays out of the menus.
        </p>
        {FEATURE_SWITCHES.map((f) => (
          <Switch
            key={f.key}
            label={f.label}
            what={f.what}
            on={Boolean(bundle.features[f.key])}
            disabled={busy || readOnly}
            onChange={(on) => void toggle(f.key, on)}
          />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Share with managers</h2>
        <p className="text-[13px] text-muted">
          These sections are the owner&rsquo;s by default. Turn one on to let managers in too.
        </p>
        {MANAGER_SHARES.map((f) => (
          <Switch
            key={f.key}
            label={f.label}
            what={f.what}
            on={Boolean(bundle.features[f.key])}
            disabled={busy || readOnly}
            onChange={(on) => void toggle(f.key, on)}
          />
        ))}
      </section>
    </div>
  );
}

function Switch({
  label, what, on, disabled, onChange,
}: {
  label: string; what: string; on: boolean; disabled: boolean; onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex min-h-14 items-start gap-3 rounded-lg border border-line bg-surface p-3">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-brand)]"
      />
      <span className="flex flex-col">
        <span className="font-semibold">{label}</span>
        <span className="text-[13px] text-muted">{what}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------

function PermissionsSection({
  bundle, team, busy, readOnly, run,
}: SectionProps & { team: StaffMember[] }) {
  const { backend } = useStaff();
  const [who, setWho] = React.useState<"role" | string>("role");
  const roles: Role[] = ["manager", "cashier"];

  const areas = [...new Set(bundle.permissionKeys.map((k) => k.area))];
  const member = team.find((m) => m.id === who);

  const roleAllows = (role: Role, perm: string) =>
    bundle.rolePermissions.find((r) => r.role === role && r.perm === perm)?.allowed ?? false;
  const override = (staffId: string, perm: string) =>
    bundle.staffPermissions.find((p) => p.staffId === staffId && p.perm === perm);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted">
        Roles decide the shape of the app; these decide what a person may actually do. The
        database checks them, so a hidden button is not the only thing stopping someone.
        Owners can always do everything.
      </p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="perm-who">Set up</Label>
        <select
          id="perm-who"
          value={who}
          onChange={(e) => setWho(e.target.value)}
          className="h-11 max-w-[320px] rounded-lg border border-line-strong bg-surface px-3 text-base"
        >
          <option value="role">Defaults for each role</option>
          {team.filter((m) => m.role !== "owner").map((m) => (
            <option key={m.id} value={m.id}>Just {m.name} ({m.role})</option>
          ))}
        </select>
      </div>

      {areas.map((area) => (
        <section key={area} className="flex flex-col gap-1.5">
          <h3 className="font-semibold">{PERMISSION_AREA_LABELS[area] ?? area}</h3>
          {bundle.permissionKeys.filter((k) => k.area === area).map((k) => (
            <div key={k.key} className="flex min-h-11 flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
              <span className="flex-1 text-[15px]">{k.label}</span>

              {who === "role" ? (
                roles.map((role) => (
                  <label key={role} className="flex items-center gap-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      checked={roleAllows(role, k.key)}
                      disabled={busy || readOnly}
                      onChange={(e) => void run(() => backend.setRolePermission(role, k.key, e.target.checked))}
                      className="size-5 accent-[var(--color-brand)]"
                    />
                    <span className="capitalize">{role}</span>
                  </label>
                ))
              ) : (
                <PersonToggle
                  roleDefault={member ? roleAllows(member.role, k.key) : false}
                  current={override(who, k.key)?.allowed}
                  disabled={busy || readOnly}
                  onSet={(allowed) => void run(() => backend.setStaffPermission(who, k.key, allowed))}
                />
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * Three states, not two: following the role, allowed anyway, or blocked anyway. A plain
 * checkbox would turn "follows the role" into a silent override the first time anyone
 * touched it.
 */
function PersonToggle({
  roleDefault, current, disabled, onSet,
}: {
  roleDefault: boolean;
  current: boolean | undefined;
  disabled: boolean;
  onSet: (allowed: boolean | null) => void;
}) {
  const options: { value: boolean | null; label: string }[] = [
    { value: null, label: `Follow role (${roleDefault ? "can" : "can't"})` },
    { value: true, label: "Can" },
    { value: false, label: "Can't" },
  ];
  const value = current === undefined ? null : current;

  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          disabled={disabled}
          aria-pressed={value === o.value}
          onClick={() => onSet(o.value)}
          className={cn(
            "min-h-11 rounded-lg px-2.5 text-[13px]",
            value === o.value
              ? "border-2 border-brand bg-ok-bg font-semibold text-ok-ink"
              : "border border-line text-ink hover:bg-subtle",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DocumentsSection({ bundle, busy, readOnly, run }: SectionProps) {
  const { backend, branches } = useStaff();
  const [branchId, setBranchId] = React.useState(branches[0]?.id ?? "");
  const mine = bundle.documentSequences.filter((d) => d.branchId === branchId);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        Each branch numbers its own documents. You can skip ahead to match a paper book,
        but never back — a number that has been used is never reused, and every change is
        logged.
      </p>

      {branches.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="doc-branch">Branch</Label>
          <select
            id="doc-branch"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="h-11 max-w-[320px] rounded-lg border border-line-strong bg-surface px-3 text-base"
          >
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      )}

      {mine.length === 0 && <p className="text-[13px] text-muted">No document numbers set up for this branch yet.</p>}

      <ul className="flex flex-col gap-1.5">
        {mine.map((d) => (
          <DocRow
            key={d.docType}
            docType={d.docType}
            next={d.nextNumber}
            busy={busy}
            readOnly={readOnly}
            onSave={(n) => run(() => backend.setDocumentNextNumber(branchId, d.docType, n))}
          />
        ))}
      </ul>
    </div>
  );
}

function DocRow({
  docType, next, busy, readOnly, onSave,
}: {
  docType: string; next: number; busy: boolean; readOnly: boolean;
  onSave: (next: number) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(String(next));

  return (
    <li className="flex min-h-11 flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
      <span className="flex-1 text-[15px]">{DOC_TYPE_LABELS[docType] ?? docType}</span>
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await onSave(Number(value) || 1);
            setEditing(false);
          }}
        >
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            className="num h-11 w-28"
            aria-label={`Next number for ${DOC_TYPE_LABELS[docType] ?? docType}`}
          />
          <Button type="submit" size="sm" disabled={busy}><Check className="size-4" aria-hidden /></Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(false); setValue(String(next)); }}>
            <X className="size-4" aria-hidden />
          </Button>
        </form>
      ) : (
        <>
          <span className="num text-[15px] font-semibold">next {next}</span>
          {!readOnly && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden /> Change
            </Button>
          )}
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------

function Field({
  label, hint, required, suffix, children,
}: {
  label: string; hint?: string; required?: boolean; suffix?: string; children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label} {required && <span className="font-normal text-muted">(needed)</span>}
      </Label>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          {React.isValidElement(children)
            ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
            : children}
        </div>
        {suffix && <span className="text-sm text-muted">{suffix}</span>}
      </div>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}
