"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { safeNext } from "@/lib/auth-route";
import { isDemoMode } from "@/lib/env";
import { supabaseBrowser } from "@/lib/supabase/client";

/**
 * One message for every failure used to mean a cashier on a dropped connection was
 * told their password was wrong — so they retried three times and phoned the owner
 * mid-queue. Each cause now says what it is and what to do.
 */
function signInError(error: { status?: number; name?: string; message?: string; code?: string }): string {
  const msg = error.message ?? "";
  if (error.status === undefined || error.status === 0 || error.name === "AuthRetryableFetchError" || /fetch|network/i.test(msg)) {
    return "Can't reach the server. Check the internet and try again.";
  }
  if (error.status === 429 || /rate limit/i.test(msg)) {
    return "Too many tries. Wait a minute, then try again.";
  }
  if (error.code === "email_not_confirmed" || /not confirmed/i.test(msg)) {
    return "This login hasn't been confirmed yet. Ask the owner to set it up again.";
  }
  if (error.status !== undefined && error.status >= 500) {
    return "The server is having trouble. Try again in a moment.";
  }
  return "Wrong email or password.";
}

export default function LoginPage() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // No client-side redirect here. Middleware already sends a signed-in person away
  // before this page renders; doing it again in an effect paints the whole form first,
  // which reads as "I just got logged out".

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: err } = await supabaseBrowser().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (err) {
      setBusy(false);
      setError(signInError(err));
      return;
    }
    // A full page load, so middleware sees the new cookies and the counter renders
    // server-side already signed in.
    const next = safeNext(new URLSearchParams(window.location.search).get("next"));
    window.location.assign(next ?? "/counter");
  };

  if (isDemoMode) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-line bg-surface p-6 text-center">
          <h1 className="text-xl font-semibold">Demo mode</h1>
          <p className="text-ink-soft">
            This is sample data in your browser, so there is no sign-in and nothing is saved.
          </p>
          <Button size="lg" onClick={() => window.location.assign("/counter")}>Open the counter</Button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-start justify-center p-4 sm:items-center">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
        <h1 className="text-xl font-semibold">Sign in to the counter</h1>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            // iOS capitalises the first letter of an email and then the form looks broken.
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-12"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              aria-label={show ? "Hide the password" : "Show the password"}
              className="absolute right-1 top-0.5 flex size-10 items-center justify-center rounded-md text-muted hover:bg-subtle"
            >
              {show ? <EyeOff className="size-5" aria-hidden /> : <Eye className="size-5" aria-hidden />}
            </button>
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-bad-ink">{error}</p>}

        <Button type="submit" size="lg" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>

        {/* Deferring the reset flow is fine; leaving a dead end is not. */}
        <p className="text-center text-sm text-muted">
          Forgot your password? Ask the owner to set a new one.
        </p>
      </form>
    </main>
  );
}
