// Every redirect rule in the app, as one pure function, so middleware's behaviour can
// be unit-tested without booting Next.

/** What the middleware managed to work out about the visitor. */
export type SignedIn =
  | true
  | false
  /**
   * Supabase Auth could not be reached, so we genuinely do not know. This is NOT
   * "signed out". Treating it as signed out would throw a working cashier to /login
   * during an internet blip — where they also cannot sign in — and the sale they were
   * ringing up lives only in memory, so it would be gone. The database re-checks
   * auth.uid() on every table and every function, so letting the request through costs
   * nothing: a signed-out visitor still sees no data, just a clearer error.
   */
  | "unknown";

/** Pages anyone may open. Everything else needs a session (deny by default), so a new
 *  route added later is guarded by omission rather than exposed by it. */
export const PUBLIC_PATHS = ["/login"] as const;

export const LOGIN_PATH = "/login";
export const HOME_PATH = "/counter";

export function isPublicPath(path: string): boolean {
  return (PUBLIC_PATHS as readonly string[]).includes(path);
}

/** Only same-site paths may come back through ?next=, so the parameter can't be used
 *  to bounce someone to another site after they sign in. */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return null;
  if (isPublicPath(next)) return null;
  return next;
}

export interface RouteInput {
  /** Path only, no query string. */
  path: string;
  signedIn: SignedIn;
  demo: boolean;
  /** The ?next= value on /login, if any. */
  next?: string | null;
}

/** Where to send this request, or null to let it through. */
export function routeFor({ path, signedIn, demo, next }: RouteInput): { redirect: string } | null {
  // Demo mode has no accounts at all, so there is nothing to redirect to.
  if (demo) return null;

  // Couldn't reach Auth: let it through and let the page say so.
  if (signedIn === "unknown") return null;

  if (signedIn) {
    // Already signed in, so the login page has nothing to offer. Honour ?next= so a
    // manager who deep-linked to /pin lands on /pin, not on the counter.
    if (path === LOGIN_PATH) return { redirect: safeNext(next) ?? HOME_PATH };
    return null;
  }

  // Signed out. Don't redirect /login to itself.
  if (isPublicPath(path)) return null;
  return { redirect: `${LOGIN_PATH}?next=${encodeURIComponent(path)}` };
}
