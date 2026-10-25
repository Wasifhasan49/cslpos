"use client";

import * as React from "react";
import { NoShopCard } from "@/components/no-shop-card";
import { Button } from "@/components/ui/button";
import { getBackend, type Backend } from "@/lib/backend";
import type { Branch, Staff } from "@/lib/types";

const BRANCH_KEY = "csl.branch";

interface StaffContextValue {
  backend: Backend;
  staff: Staff;
  /** Which features this shop has turned on. The menu reads it, so an off feature has
   *  no section at all. */
  features: Record<string, boolean>;
  /** The branch being worked in. Never null once the app has loaded: a staff member
   *  with no branch cannot sell anywhere, so that is treated as a setup problem. */
  branch: Branch;
  branches: Branch[];
  setBranch: (id: string) => void;
  /** Re-read the catalogue and staff, e.g. after switching branch. */
  reload: () => void;
}

const StaffContext = React.createContext<StaffContextValue | null>(null);

/** Everything a screen needs to know about who is signed in and where they are. */
export function useStaff(): StaffContextValue {
  const ctx = React.useContext(StaffContext);
  if (!ctx) throw new Error("useStaff() needs a <StaffProvider> above it");
  return ctx;
}

/**
 * Loads the signed-in staff member once, for every screen under the app shell, so a
 * nav click does not re-ask who you are. It also owns the current branch, remembering
 * the last one used.
 */
export function StaffProvider({ children }: { children: React.ReactNode }) {
  const backend = React.useMemo(() => getBackend(), []);
  const [staff, setStaff] = React.useState<Staff | null>(null);
  const [features, setFeatures] = React.useState<Record<string, boolean>>({});
  const [branchId, setBranchId] = React.useState<string | null>(null);
  const [noShopEmail, setNoShopEmail] = React.useState<string | null>(null);
  const [state, setState] = React.useState<"loading" | "no-staff" | "no-branch" | "ready">("loading");
  const [error, setError] = React.useState("");
  const [nonce, setNonce] = React.useState(0);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await backend.currentStaff();
        if (cancelled) return;
        if (me.kind === "signed-out") {
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        if (me.kind === "no-staff") { setNoShopEmail(me.email); setState("no-staff"); return; }

        setStaff(me.staff);
        // Loaded here rather than per screen: the menu needs it on first paint.
        setFeatures(await backend.listFeatures());
        if (cancelled) return;
        if (me.staff.branches.length === 0) { setState("no-branch"); return; }

        // Remember the last branch, but only if it is still one this person may use:
        // the owner may have taken it away since.
        let remembered: string | null = null;
        try { remembered = window.localStorage.getItem(BRANCH_KEY); } catch { /* private mode */ }
        const valid = me.staff.branches.some((b) => b.id === remembered);
        setBranchId(valid ? remembered : me.staff.branches[0].id);
        setState("ready");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load your account.");
      }
    })();
    return () => { cancelled = true; };
  }, [backend, nonce]);

  const setBranch = React.useCallback((id: string) => {
    setBranchId(id);
    try { window.localStorage.setItem(BRANCH_KEY, id); } catch { /* private mode */ }
  }, []);

  if (error) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-bad-ink">{error}</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </main>
    );
  }
  if (state === "loading") {
    return <main className="flex min-h-screen items-center justify-center text-muted">Loading the shop…</main>;
  }
  if (state === "no-staff") return <NoShopCard email={noShopEmail} />;
  if (state === "no-branch" || !staff) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-line bg-surface p-6 text-center">
          <h1 className="text-xl font-semibold">No branch yet</h1>
          <p className="text-ink-soft">
            {staff ? `${staff.name}, you` : "You"} aren&rsquo;t set up to work in any branch, so there is
            nowhere to sell from. Ask the owner to add you to one in Settings → Branches.
          </p>
          <Button size="lg" onClick={() => window.location.reload()}>Try again</Button>
        </div>
      </main>
    );
  }

  const branch = staff.branches.find((b) => b.id === branchId) ?? staff.branches[0];

  return (
    <StaffContext.Provider
      value={{ backend, staff, features, branch, branches: staff.branches, setBranch, reload }}
    >
      {children}
    </StaffContext.Provider>
  );
}
