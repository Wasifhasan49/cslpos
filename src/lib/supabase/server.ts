import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAnonKey, supabaseUrl } from "../env";

/**
 * A Supabase client for server components and route handlers.
 *
 * A NEW one per request, never cached in a module. @supabase/ssr hands `setAll` its
 * no-store headers only on the first cookie write per client, so a shared client would
 * silently stop setting them on later responses.
 */
export async function supabaseServer(): Promise<SupabaseClient> {
  const store = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            store.set(name, value, options);
          }
        } catch {
          // Next 15 throws when a Server Component render tries to write cookies.
          // That's fine: middleware is what actually persists a refreshed session, so
          // this call is only ever a duplicate of work already done.
        }
      },
    },
  });
}
