import { createDemoBackend } from "./demo";
import { createSupabaseBackend } from "./supabase";
import type { Backend } from "./types";

/** Demo mode whenever Supabase keys aren't set (or NEXT_PUBLIC_DEMO_MODE=1). */
export const isDemoMode =
  process.env.NEXT_PUBLIC_DEMO_MODE === "1" ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL ||
  !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let backend: Backend | null = null;
export function getBackend(): Backend {
  if (!backend) backend = isDemoMode ? createDemoBackend() : createSupabaseBackend();
  return backend;
}

export type { Backend } from "./types";
