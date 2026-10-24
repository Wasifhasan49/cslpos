"use client";

import { Button } from "@/components/ui/button";

/**
 * Shown when someone is signed in but has no staff row — a new person whose owner
 * typo'd their email, or someone who has been turned off. One component, used by every
 * page that can hit this, so the wording cannot drift.
 *
 * The email is on screen because it is the one fact that makes "ask the owner"
 * actionable, and Try again is here because the owner may well fix it in half a minute
 * while the person is standing there. Signing out would throw the session away and make
 * them type their password again to find out.
 */
export function NoShopCard({ email }: { email: string | null }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-line bg-surface p-6 text-center">
        <h1 className="text-xl font-semibold">This login isn&rsquo;t set up yet</h1>
        <p className="text-ink-soft">
          {email ? (
            <>
              You&rsquo;re signed in as <span className="font-semibold">{email}</span>, but this login
              isn&rsquo;t linked to a shop, or has been turned off.
            </>
          ) : (
            <>This login isn&rsquo;t linked to a shop, or has been turned off.</>
          )}
        </p>
        <p className="text-ink-soft">Ask the owner to add you, then try again.</p>
        <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:justify-center">
          <Button size="lg" onClick={() => window.location.reload()}>Try again</Button>
          <Button variant="outline" size="lg" onClick={() => window.location.assign("/logout")}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}
