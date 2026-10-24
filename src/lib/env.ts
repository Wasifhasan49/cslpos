// The one place that decides whether we are talking to Supabase or running on sample
// data. It deliberately has NO imports: middleware runs on the edge, and importing
// lib/backend would drag the demo catalogue and the whole Supabase client into that
// bundle. Keep it a leaf.
//
// Demo mode is OPT-IN. It used to turn on whenever the Supabase keys were missing,
// which meant a production build with one forgotten environment variable served an
// open, sign-in-free counter backed by fake products — and looked like it worked.
// Failing loudly is better than looking fine and saving nothing.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || "";
const demoFlag = process.env.NEXT_PUBLIC_DEMO_MODE?.trim();

export const supabaseUrl = url;
export const supabaseAnonKey = anonKey;

/** Both keys present, so we can talk to a real database. */
export const hasSupabaseKeys = url !== "" && anonKey !== "";

/** Exactly one of the two filled in: almost always a half-finished .env.local. */
export const hasPartialSupabaseKeys = !hasSupabaseKeys && (url !== "" || anonKey !== "");

/**
 * Why the app can't start, or "" if it can. Checked by the config screen and by
 * `pnpm doctor`, so a setup mistake says what to fix instead of silently falling back
 * to sample data.
 */
export function configError(): string {
  if (demoFlag === "1") return "";
  if (hasPartialSupabaseKeys) {
    return url === ""
      ? "NEXT_PUBLIC_SUPABASE_URL is empty but the anon key is set. Fill in both, or clear both and set NEXT_PUBLIC_DEMO_MODE=1 for sample data."
      : "NEXT_PUBLIC_SUPABASE_ANON_KEY is empty but the URL is set. Fill in both, or clear both and set NEXT_PUBLIC_DEMO_MODE=1 for sample data.";
  }
  if (!hasSupabaseKeys && demoFlag !== "0" && process.env.NODE_ENV === "production") {
    return "No Supabase keys are set. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, or set NEXT_PUBLIC_DEMO_MODE=1 if you really want sample data.";
  }
  return "";
}

/**
 * Sample data in the browser, no sign-in, nothing saved.
 *
 * On: NEXT_PUBLIC_DEMO_MODE=1, or no keys in development (so `pnpm dev` works with no
 * setup). Off: NEXT_PUBLIC_DEMO_MODE=0 forces the real backend so you can see the
 * actual connection error instead of being quietly handed fake products.
 */
export const isDemoMode =
  demoFlag === "1" ||
  // A half-filled .env.local must NOT land here. Someone who has pasted the URL and
  // not the key is setting up a real database; quietly handing them sample data makes
  // it look like it worked and costs them an afternoon. configError() covers it.
  (demoFlag !== "0" &&
    !hasSupabaseKeys &&
    !hasPartialSupabaseKeys &&
    process.env.NODE_ENV !== "production");
