"use client";

import * as React from "react";
import { useStaff } from "@/components/staff-provider";

/**
 * A section that a later prompt fills in. It exists now so the menu is real and the
 * role and branch rules can be tested end to end — an empty route would 404 and look
 * like a bug instead of a plan.
 */
export function SectionPlaceholder({
  title, what, comingIn,
}: {
  title: string;
  /** One line, in plain English, on what this will do. */
  what: string;
  /** Which build step adds it, so it reads as planned rather than missing. */
  comingIn: string;
}) {
  const { branch, branches } = useStaff();

  return (
    <main className="mx-auto flex w-full max-w-[1480px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {branches.length > 1 && (
          <p className="text-[13px] text-muted">Showing {branch.name}</p>
        )}
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-line-strong bg-subtle p-6">
        <p className="text-ink-soft">{what}</p>
        <p className="text-sm text-muted">Being built in {comingIn}.</p>
      </div>
    </main>
  );
}
