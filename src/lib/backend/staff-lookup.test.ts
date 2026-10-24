import { describe, expect, it } from "vitest";
import { classifyStaffLookup, type CurrentStaffRow } from "./staff-lookup";

const row: CurrentStaffRow = {
  staff_id: "s1",
  shop_id: "shop1",
  name: "Ovi",
  role: "cashier",
  discount_limit_pct: "5.00", // Postgres numerics arrive as strings
  shop_name: "Demo Shop",
  has_pin: false,
};

// These three outcomes are the whole reason the "not linked to a shop" card exists.
// Testing them through the demo backend would prove nothing: the demo always has a
// staff member, so it can only ever produce one of the three.
describe("classifyStaffLookup", () => {
  it("no auth user means signed out", () => {
    expect(classifyStaffLookup({ user: null, row: null })).toEqual({ kind: "signed-out" });
    // Even with a row somehow present, no session is no session.
    expect(classifyStaffLookup({ user: null, row })).toEqual({ kind: "signed-out" });
  });

  it("signed in with no staff row is its own outcome, and keeps the email", () => {
    // The email is what makes "ask the owner" actionable — it is the thing the owner
    // needs to hear to find the typo.
    expect(classifyStaffLookup({ user: { email: "razu@csl.com.bd" }, row: null }))
      .toEqual({ kind: "no-staff", email: "razu@csl.com.bd" });
    expect(classifyStaffLookup({ user: {}, row: null }))
      .toEqual({ kind: "no-staff", email: null });
  });

  it("a staff row gives the staff member, with the numeric limit parsed", () => {
    const got = classifyStaffLookup({ user: { email: "ovi@example.com" }, row });
    expect(got.kind).toBe("ok");
    if (got.kind !== "ok") throw new Error("unreachable");
    expect(got.staff).toEqual({
      id: "s1", name: "Ovi", role: "cashier",
      discountLimitPct: 5, shopName: "Demo Shop", hasPin: false,
    });
  });

  it("carries has_pin through, so the PIN screen can say Set or Change", () => {
    const got = classifyStaffLookup({ user: {}, row: { ...row, role: "owner", has_pin: true } });
    if (got.kind !== "ok") throw new Error("unreachable");
    expect(got.staff.hasPin).toBe(true);
  });
});
