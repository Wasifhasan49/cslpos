import { isDemoMode } from "../env";
import { createDemoBackend } from "./demo";
import { createSupabaseBackend } from "./supabase";
import type { Backend } from "./types";

// Re-exported so existing callers keep working. lib/env.ts is the source of truth,
// because middleware needs this answer without importing the whole backend.
export { isDemoMode } from "../env";

let backend: Backend | null = null;
export function getBackend(): Backend {
  if (!backend) backend = isDemoMode ? createDemoBackend() : createSupabaseBackend();
  return backend;
}

export type { Backend } from "./types";
