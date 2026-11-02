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
  branches: [
    { id: "b1", name: "Main branch", code: "MB", locations: [{ id: "e1", name: "Main store", is_default: true }] },
  ],
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
      letterhead: {
        shopName: "Demo Shop", logoUrl: null, address: null, phone: null,
        email: null, binVat: null,
      },
      branches: [
        { id: "b1", name: "Main branch", code: "MB", address: null, phone: null,
          locations: [{ id: "e1", name: "Main store", isDefault: true }] },
      ],
    });
  });

  // A login held open across the migration that added the letterhead gets a row without
  // one. The printout still has to say whose shop it is, so the shop name stands in.
  it("falls back to the shop name when the row carries no letterhead", () => {
    const got = classifyStaffLookup({ user: {}, row });
    if (got.kind !== "ok") throw new Error("unreachable");
    expect(got.staff.letterhead.shopName).toBe("Demo Shop");
    expect(got.staff.letterhead.logoUrl).toBeNull();
  });

  it("carries the shop's own letterhead, which is what a printout prints", () => {
    const got = classifyStaffLookup({ user: {}, row: { ...row, letterhead: {
      shop_name: "Computer Services", logo_url: "data:image/png;base64,AAA",
      address: "Shop 9, BCS Computer City", phone: "01700-000000",
      email: null, bin_vat: "0001234567",
    } } });
    if (got.kind !== "ok") throw new Error("unreachable");
    expect(got.staff.letterhead).toEqual({
      shopName: "Computer Services", logoUrl: "data:image/png;base64,AAA",
      address: "Shop 9, BCS Computer City", phone: "01700-000000",
      email: null, binVat: "0001234567",
    });
  });

  it("keeps the branches this person may work in, so the switcher has something to show", () => {
    const got = classifyStaffLookup({
      user: {},
      row: { ...row, branches: [
        { id: "b1", name: "Main branch", code: "MB", locations: [{ id: "e1", name: "Main store", is_default: true }] },
        { id: "b2", name: "Second branch", code: "SB", locations: [{ id: "e2", name: "Main store", is_default: true }] },
      ] },
    });
    if (got.kind !== "ok") throw new Error("unreachable");
    expect(got.staff.branches.map((b) => b.code)).toEqual(["MB", "SB"]);
    expect(got.staff.branches[0].locations[0].isDefault).toBe(true);
  });

  it("survives a row with no branches rather than crashing the counter", () => {
    const got = classifyStaffLookup({ user: {}, row: { ...row, branches: undefined as never } });
    if (got.kind !== "ok") throw new Error("unreachable");
    expect(got.staff.branches).toEqual([]);
  });

  it("carries has_pin through, so the PIN screen can say Set or Change", () => {
    const got = classifyStaffLookup({ user: {}, row: { ...row, role: "owner", has_pin: true } });
    if (got.kind !== "ok") throw new Error("unreachable");
    expect(got.staff.hasPin).toBe(true);
  });
});
