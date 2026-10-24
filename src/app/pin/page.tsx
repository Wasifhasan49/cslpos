"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, Eye, EyeOff } from "lucide-react";
import { NoShopCard } from "@/components/no-shop-card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { getBackend } from "@/lib/backend";
import { pinScreenError } from "@/lib/sale";
import type { Staff } from "@/lib/types";

const PIN_OK = /^[0-9]{4,6}$/;

/** Mirrors set_pin()'s rule so the owner is told before the round trip, not after.
 *  The database checks it again and is the real guard. */
function weakPin(pin: string): boolean {
  return /^(.)\1*$/.test(pin) || "01234567890".includes(pin) || "09876543210".includes(pin);
}

export default function ApprovalPinPage() {
  const backend = React.useMemo(() => getBackend(), []);
  const [staff, setStaff] = React.useState<Staff | null>(null);
  const [noShopEmail, setNoShopEmail] = React.useState<string | null>(null);
  const [state, setState] = React.useState<"loading" | "no-staff" | "form" | "saved">("loading");
  const [loadError, setLoadError] = React.useState("");

  const [pin, setPin] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [touchedConfirm, setTouchedConfirm] = React.useState(false);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await backend.currentStaff();
        if (cancelled) return;
        if (me.kind === "signed-out") { window.location.assign("/login?next=%2Fpin"); return; }
        if (me.kind === "no-staff") { setNoShopEmail(me.email); setState("no-staff"); return; }
        setStaff(me.staff);
        setState("form");
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load your account.");
      }
    })();
    return () => { cancelled = true; };
  }, [backend]);

  // Checked on blur, not per keystroke: "those don't match" flashing at the second
  // digit is punishing when you are typing a number you are trying to memorise.
  const mismatch = touchedConfirm && confirm !== "" && pin !== confirm;
  const localProblem = (): string => {
    if (!PIN_OK.test(pin)) return "Use 4 to 6 digits.";
    if (weakPin(pin)) return "Pick something harder to guess — not 1234 or 0000.";
    if (pin !== confirm) return "Those two PINs don't match.";
    return "";
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = localProblem();
    if (problem) { setError(problem); setTouchedConfirm(true); return; }
    setBusy(true);
    setError("");
    try {
      await backend.setPin(pin);
      setPin("");
      setConfirm("");
      setTouchedConfirm(false);
      setState("saved");
    } catch (err) {
      setError(pinScreenError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading" && !loadError) {
    return <main className="flex min-h-screen items-center justify-center text-muted">Loading…</main>;
  }
  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-bad-ink">{loadError}</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </main>
    );
  }
  if (state === "no-staff") return <NoShopCard email={noShopEmail} />;

  // A cashier who taps a stray link gets told why, not teleported. Two guards that
  // both "redirect with a message" is how you get a loop nobody can reproduce; the
  // database refuses set_pin() for a cashier regardless, so this is just the wording.
  if (staff && staff.role === "cashier") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Approval PIN</h1>
        <p className="text-ink-soft">
          Only owners and managers set an approval PIN. Ask the owner if you need a discount
          approved.
        </p>
        <BackToCounter />
      </Shell>
    );
  }

  if (state === "saved") {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-ok-ink">
          <Check className="size-5" aria-hidden />
          <h1 className="text-xl font-semibold">PIN saved</h1>
        </div>
        <p className="text-ink-soft">
          Type it at the counter when a cashier needs a big discount approved.
        </p>
        <p className="text-sm text-muted">Type it where staff can&rsquo;t see it.</p>
        <div className="flex flex-col gap-2 pt-1 sm:flex-row">
          <Button size="lg" onClick={() => window.location.assign("/counter")}>Back to the counter</Button>
          <Button variant="outline" size="lg" onClick={() => setState("form")}>Change it again</Button>
        </div>
      </Shell>
    );
  }

  const heading = staff?.hasPin ? "Change your approval PIN" : "Set your approval PIN";

  return (
    <Shell>
      <h1 className="text-xl font-semibold">{heading}</h1>
      <p className="text-ink-soft">
        Your PIN approves big discounts at the counter. Only owners and managers have one.
      </p>
      {staff && (
        <p className="text-sm text-muted">
          Signed in as <span className="font-semibold text-ink-soft">{staff.name}</span> ·{" "}
          <span className="capitalize">{staff.role}</span>
        </p>
      )}

      <form onSubmit={save} className="flex flex-col gap-4 pt-1">
        <PinField
          id="pin" label="PIN" value={pin} show={show} onShow={setShow} autoFocus
          onChange={(v) => { setPin(v); setError(""); }}
          hint={`4 to 6 digits${pin ? ` · ${pin.length} so far` : ""}`}
        />
        <PinField
          id="confirm" label="Type it again" value={confirm} show={show} onShow={setShow}
          onChange={(v) => { setConfirm(v); setError(""); }}
          onBlur={() => setTouchedConfirm(true)}
          hint={mismatch ? "" : "Make sure the two match"}
        />

        {/* Above the button: with a numeric keypad open on a phone, anything below it
            is behind the keyboard. */}
        {(error || mismatch) && (
          <p role="alert" className="text-sm text-bad-ink">
            {error || "Those two PINs don't match."}
          </p>
        )}

        <Button type="submit" size="lg" disabled={busy}>
          {busy ? "Saving…" : staff?.hasPin ? "Change PIN" : "Save PIN"}
        </Button>
      </form>
      <BackToCounter />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center p-4 sm:items-center">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line bg-surface p-6">
        {children}
      </div>
    </main>
  );
}

function BackToCounter() {
  return (
    <Link href="/counter" className="inline-flex items-center gap-1.5 self-start pt-1 text-sm text-ink-soft underline">
      <ArrowLeft className="size-4" aria-hidden /> Back to the counter
    </Link>
  );
}

/** One plain field, not six boxes: the PIN is 4 to 6 digits, and a segmented input
 *  can't express a variable length without lying about it. */
function PinField({
  id, label, value, onChange, hint, show, onShow, onBlur, autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint: string;
  show: boolean;
  onShow: (v: boolean) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          // Otherwise the browser offers to save this as the site password and
          // helpfully prefills it with something else next time.
          autoComplete="new-password"
          autoFocus={autoFocus}
          value={value}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
          className="num h-12 pr-12 text-lg tracking-[0.3em]"
        />
        <button
          type="button"
          onClick={() => onShow(!show)}
          aria-label={show ? "Hide the PIN" : "Show the PIN"}
          className="absolute right-1 top-1 flex size-10 items-center justify-center rounded-md text-muted hover:bg-subtle"
        >
          {show ? <EyeOff className="size-5" aria-hidden /> : <Eye className="size-5" aria-hidden />}
        </button>
      </div>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}
