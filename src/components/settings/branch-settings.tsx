"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, Plus } from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { BranchAdmin, Role, StaffMember } from "@/lib/types";

/** Settings → Branches and staff. Owner only; the database refuses anyone else. */
export function BranchSettings() {
  const { backend, staff, reload } = useStaff();
  const [branches, setBranches] = React.useState<BranchAdmin[] | null>(null);
  const [team, setTeam] = React.useState<StaffMember[] | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [adding, setAdding] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [b, t] = await Promise.all([backend.listBranches(), backend.listStaff()]);
      setBranches(b);
      setTeam(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the branches.");
    }
  }, [backend]);

  React.useEffect(() => { void load(); }, [load]);

  /** Every write goes through here so one place handles errors and reloading. */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      // The switcher in the header is built from the staff lookup, so it has to be
      // re-read or a new branch will not appear until a reload.
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
  };

  if (staff.role !== "owner") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Branches and staff</h1>
        <p className="text-ink-soft">
          Only the owner can change branches and who works where. Ask the owner if something
          needs changing.
        </p>
      </Shell>
    );
  }

  if (!branches || !team) {
    return <Shell><p className="text-muted">Loading…</p></Shell>;
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Branches and staff</h1>
        <Button onClick={() => setAdding(true)} disabled={busy}>
          <Plus className="size-4" aria-hidden /> Add a branch
        </Button>
      </div>

      {error && <p role="alert" className="text-sm font-semibold text-bad-ink">{error}</p>}

      {adding && (
        <AddBranch
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={async (input) => {
            await run(() => backend.saveBranch(input));
            setAdding(false);
          }}
        />
      )}

      <section className="flex flex-col gap-3">
        {branches.map((b) => (
          <BranchCard key={b.id} branch={b} busy={busy} onRun={run} backend={backend} />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="pt-2 text-lg font-semibold">Who works where</h2>
        <p className="text-[13px] text-muted">
          Owners can always use every branch, so they aren&rsquo;t listed with tick boxes.
        </p>
        {team.map((m) => (
          <StaffRow key={m.id} member={m} branches={branches} me={staff.id} busy={busy} onRun={run} backend={backend} />
        ))}
      </section>

      <Link href="/settings" className="inline-flex items-center gap-1.5 self-start pt-2 text-sm text-ink-soft underline">
        <ArrowLeft className="size-4" aria-hidden /> Back to settings
      </Link>
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

function AddBranch({
  busy, onCancel, onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (input: { name: string; code: string; address: string | null; phone: string | null }) => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [address, setAddress] = React.useState("");
  const [phone, setPhone] = React.useState("");

  // Suggest a code from the name, because it is easy to get wrong and it ends up in
  // every invoice number this branch ever prints.
  const suggested = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
  const useCode = (code || suggested).toUpperCase();

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void onSave({ name, code: useCode, address: address || null, phone: phone || null }); }}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="font-semibold">New branch</h2>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-[2_1_220px] flex-col gap-1.5">
          <Label htmlFor="bname">Branch name</Label>
          <Input id="bname" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Agargaon branch" />
        </div>
        <div className="flex flex-[1_1_120px] flex-col gap-1.5">
          <Label htmlFor="bcode">Short code</Label>
          <Input
            id="bcode" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
            placeholder={suggested || "MB"} className="code"
          />
          <span className="text-xs text-muted">Goes in invoice numbers. Up to 6 letters or digits.</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-[2_1_220px] flex-col gap-1.5">
          <Label htmlFor="baddr">Address <span className="font-normal text-muted">(optional)</span></Label>
          <Input id="baddr" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="flex flex-[1_1_160px] flex-col gap-1.5">
          <Label htmlFor="bphone">Phone <span className="font-normal text-muted">(optional)</span></Label>
          <Input id="bphone" value={phone} onChange={(e) => setPhone(e.target.value)} className="num" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !name.trim() || !useCode}>
          {busy ? "Saving…" : "Add branch"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

function BranchCard({
  branch, busy, onRun, backend,
}: {
  branch: BranchAdmin;
  busy: boolean;
  onRun: (fn: () => Promise<void>) => Promise<void>;
  backend: ReturnType<typeof useStaff>["backend"];
}) {
  const [newLocation, setNewLocation] = React.useState("");

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-semibold">
            {branch.name} <span className="code text-[13px] text-muted">{branch.code}</span>
            {!branch.active && <span className="ml-2 text-[13px] font-normal text-warn-ink">turned off</span>}
          </span>
          <span className="text-[13px] text-muted">
            {branch.address || "No address"} · next invoice {branch.nextInvoice}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onRun(() => backend.saveBranch({ id: branch.id, active: !branch.active }))}
        >
          {branch.active ? "Turn off" : "Turn back on"}
        </Button>
      </div>

      {/* Locations only matter once a branch has more than one, so a single default
          store is shown as a quiet line rather than a list to manage. */}
      <div className="flex flex-col gap-2 border-t border-subtle pt-3">
        <span className="text-[13px] font-semibold">Stock locations</span>
        <ul className="flex flex-wrap gap-2">
          {branch.locations.map((l) => (
            <li key={l.id} className="flex items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1 text-[13px]">
              {l.name}
              {l.isDefault && <Check className="size-3.5 text-brand" aria-label="Default" />}
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await onRun(() => backend.saveStockLocation({ branchId: branch.id, name: newLocation }));
            setNewLocation("");
          }}
        >
          <Input
            value={newLocation}
            onChange={(e) => setNewLocation(e.target.value)}
            placeholder="Add a location, e.g. Warehouse"
            className="h-11 max-w-[260px] flex-1"
          />
          <Button type="submit" variant="outline" className="h-11" disabled={busy || !newLocation.trim()}>Add</Button>
        </form>
      </div>
    </div>
  );
}

function StaffRow({
  member, branches, me, busy, onRun, backend,
}: {
  member: StaffMember;
  branches: BranchAdmin[];
  me: string;
  busy: boolean;
  onRun: (fn: () => Promise<void>) => Promise<void>;
  backend: ReturnType<typeof useStaff>["backend"];
}) {
  const isMe = member.id === me;
  const isOwner = member.role === "owner";

  const toggle = (branchId: string) => {
    const next = member.branchIds.includes(branchId)
      ? member.branchIds.filter((b) => b !== branchId)
      : [...member.branchIds, branchId];
    return onRun(() => backend.setStaffBranches(member.id, next));
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">
          {member.name}{" "}
          <span className="text-[13px] font-normal capitalize text-muted">{member.role}</span>
          {!member.active && <span className="ml-2 text-[13px] font-normal text-warn-ink">turned off</span>}
          {isMe && <span className="text-[13px] font-normal text-muted"> (you)</span>}
        </span>
        <span className="text-[13px] text-muted">{member.discountLimitPct}% discount limit</span>
      </div>

      {isOwner ? (
        <p className="text-[13px] text-muted">Owners can use every branch.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {branches.filter((b) => b.active).map((b) => {
            const on = member.branchIds.includes(b.id);
            return (
              <button
                key={b.id}
                type="button"
                aria-pressed={on}
                disabled={busy}
                onClick={() => void toggle(b.id)}
                className={
                  on
                    ? "flex min-h-11 items-center gap-1.5 rounded-lg border-2 border-brand bg-ok-bg px-3 text-sm font-semibold text-ok-ink"
                    : "flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-sm text-ink hover:bg-subtle"
                }
              >
                {on && <Check className="size-4" aria-hidden />}
                {b.name}
              </button>
            );
          })}
        </div>
      )}

      {/* Changing your own role or limit is refused by the database, so it is not
          offered here either. */}
      {!isMe && (
        <div className="flex flex-wrap gap-2 border-t border-subtle pt-2">
          {(["owner", "manager", "cashier"] as Role[]).filter((r) => r !== member.role).map((r) => (
            <Button
              key={r}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onRun(() => backend.setStaffAccess({ staffId: member.id, role: r }))}
            >
              Make {r}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onRun(() => backend.setStaffAccess({ staffId: member.id, active: !member.active }))}
          >
            {member.active ? "Turn off" : "Turn back on"}
          </Button>
        </div>
      )}
    </div>
  );
}
