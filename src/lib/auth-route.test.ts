import { describe, expect, it } from "vitest";
import { routeFor, safeNext } from "./auth-route";

// These are middleware's rules, tested without booting Next.
describe("routeFor", () => {
  it("sends a signed-out visitor to the login page, remembering where they wanted to go", () => {
    expect(routeFor({ path: "/counter", signedIn: false, demo: false }))
      .toEqual({ redirect: "/login?next=%2Fcounter" });
    expect(routeFor({ path: "/pin", signedIn: false, demo: false }))
      .toEqual({ redirect: "/login?next=%2Fpin" });
  });

  it("does not redirect the login page to itself", () => {
    expect(routeFor({ path: "/login", signedIn: false, demo: false })).toBeNull();
  });

  it("protects by default, so a route added later is not exposed by omission", () => {
    expect(routeFor({ path: "/some-page-nobody-has-written-yet", signedIn: false, demo: false }))
      .toEqual({ redirect: "/login?next=%2Fsome-page-nobody-has-written-yet" });
  });

  it("lets a signed-in person through, and sends them off the login page", () => {
    expect(routeFor({ path: "/counter", signedIn: true, demo: false })).toBeNull();
    expect(routeFor({ path: "/login", signedIn: true, demo: false })).toEqual({ redirect: "/counter" });
  });

  it("honours ?next= so a deep link survives signing in", () => {
    expect(routeFor({ path: "/login", signedIn: true, demo: false, next: "/pin" }))
      .toEqual({ redirect: "/pin" });
  });

  it("never redirects in demo mode, where there are no accounts", () => {
    expect(routeFor({ path: "/counter", signedIn: false, demo: true })).toBeNull();
    expect(routeFor({ path: "/login", signedIn: false, demo: true })).toBeNull();
  });

  // The 2am-Friday case. An internet blip that reads as "signed out" throws a cashier
  // to /login — where they cannot sign in either — and the half-built sale lives only
  // in memory, so it is gone. The database re-checks auth.uid() on every table and
  // function, so letting the request through costs nothing.
  it("lets the request through when Supabase Auth could not be reached", () => {
    expect(routeFor({ path: "/counter", signedIn: "unknown", demo: false })).toBeNull();
    expect(routeFor({ path: "/login", signedIn: "unknown", demo: false })).toBeNull();
    expect(routeFor({ path: "/pin", signedIn: "unknown", demo: false })).toBeNull();
  });
});

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/pin")).toBe("/pin");
    expect(safeNext("/counter")).toBe("/counter");
  });

  it("refuses anything that could bounce someone off this site", () => {
    expect(safeNext("https://example.com")).toBeNull();
    expect(safeNext("//example.com")).toBeNull();
    expect(safeNext("javascript:alert(1)")).toBeNull();
    expect(safeNext(null)).toBeNull();
    expect(safeNext("")).toBeNull();
  });

  it("refuses /login, so signing in cannot loop back to signing in", () => {
    expect(safeNext("/login")).toBeNull();
  });
});
