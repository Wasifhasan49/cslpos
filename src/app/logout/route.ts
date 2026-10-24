import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Signing out on the server, so the session cookies are cleared in the same response
 * that redirects. Doing it in the browser and then calling router.replace() leaves a
 * client navigation that can be served from the RSC cache, which flickers or loops once
 * middleware is in play.
 */
export async function GET(request: Request) {
  const to = new URL("/login", request.url);
  if (isDemoMode) return NextResponse.redirect(to);

  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  return NextResponse.redirect(to);
}
