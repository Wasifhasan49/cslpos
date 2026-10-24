import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { routeFor, type SignedIn } from "@/lib/auth-route";
import { isDemoMode, supabaseAnonKey, supabaseUrl } from "@/lib/env";

export async function middleware(request: NextRequest) {
  // Demo mode has no accounts, so there is no session to refresh and nothing to guard.
  if (isDemoMode) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        // Write to the request too, so server components rendered in THIS request read
        // the refreshed session rather than the stale cookie, then rebuild the response
        // from the updated request.
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
        // These are the library's no-store headers. Without them a CDN or edge proxy
        // can cache a response that carries a Set-Cookie session token and hand one
        // person's session to the next visitor.
        for (const [key, value] of Object.entries(headers ?? {})) {
          supabaseResponse.headers.set(key, value);
        }
      },
    },
  });

  // getUser() also refreshes an expiring token, which is the real reason middleware
  // exists here: a counter shift is longer than an access token's hour.
  let signedIn: SignedIn;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error && isUnreachable(error)) {
      console.warn("[middleware] Supabase Auth unreachable, letting the request through:", error.message);
      signedIn = "unknown";
    } else {
      signedIn = Boolean(data.user);
    }
  } catch (e) {
    console.warn("[middleware] Supabase Auth threw, letting the request through:", e);
    signedIn = "unknown";
  }

  const decision = routeFor({
    path: request.nextUrl.pathname,
    signedIn,
    demo: false,
    next: request.nextUrl.searchParams.get("next"),
  });

  if (!decision) return supabaseResponse;

  const url = request.nextUrl.clone();
  const [pathname, query] = decision.redirect.split("?");
  url.pathname = pathname;
  url.search = query ? `?${query}` : "";

  const redirect = NextResponse.redirect(url);
  // Carry the refreshed cookies and headers onto the redirect. Skipping this is the
  // classic @supabase/ssr mistake: the session is refreshed and then thrown away, so
  // the next request refreshes again, forever.
  for (const cookie of supabaseResponse.cookies.getAll()) redirect.cookies.set(cookie);
  supabaseResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "content-length") redirect.headers.set(key, value);
  });
  return redirect;
}

/** A network or server problem, as opposed to "this session is not valid". */
function isUnreachable(error: { status?: number; name?: string; message?: string }): boolean {
  if (error.status === undefined || error.status === 0) return true; // fetch failed
  if (error.status >= 500) return true;
  if (error.status === 429) return true; // rate-limited, not signed out
  return error.name === "AuthRetryableFetchError";
}

export const config = {
  // Everything except Next's own assets and static files. Each matched request costs
  // one round trip to Supabase Auth, so letting images through here would make the
  // counter feel slow for no benefit.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)",
  ],
};
