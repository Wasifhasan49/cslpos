import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAnonKey, supabaseUrl } from "../env";

let client: SupabaseClient | null = null;

/** The browser's Supabase client. Sessions live in cookies, which is what lets
 *  middleware read and refresh them. Safe to cache: one per browser tab. */
export function supabaseBrowser(): SupabaseClient {
  if (!client) client = createBrowserClient(supabaseUrl, supabaseAnonKey);
  return client;
}
