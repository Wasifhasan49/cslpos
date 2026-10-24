import { redirect } from "next/navigation";
import { canSee, noAccessMessage } from "./nav";
import type { Role } from "./types";
import { isDemoMode } from "./env";
import { supabaseServer } from "./supabase/server";

/**
 * Server-side section guard.
 *
 * The menu already hides sections a role may not open, and row-level security is what
 * actually protects the data. This is the middle layer: it stops a typed-in URL from
 * rendering a page the person is not meant to see, and it says why instead of showing
 * a blank screen.
 *
 * Demo mode has one owner and no accounts, so there is nothing to check.
 */
export async function guardSection(path: string): Promise<void> {
  if (isDemoMode) return;

  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("current_staff");

  // No staff row, or the lookup failed: let the page render. The client provider shows
  // the "not linked to a shop" card or the real error, and RLS means nothing leaks
  // either way. Guessing "signed out" here would bounce someone mid-task.
  if (error || !data) return;

  const role = (data as { role?: string }).role as Role | undefined;
  if (!role) return;

  if (!canSee(path, role)) {
    redirect(`/counter?denied=${encodeURIComponent(noAccessMessage(path, role))}`);
  }
}
