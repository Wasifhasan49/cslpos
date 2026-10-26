import { describe, expect, it } from "vitest";
import { canSee, navFor, overflowFor, tabsFor } from "./nav";

describe("who sees which section", () => {
  it("a cashier gets only the counter, sales and warranty", () => {
    expect(navFor("cashier").map((n) => n.href)).toEqual(["/counter", "/sales", "/warranty"]);
  });

  it("a cashier is kept out of every manager and owner section", () => {
    for (const path of ["/stock", "/purchases", "/transfers", "/products", "/customers",
                        "/suppliers", "/cash", "/dashboard", "/accounts", "/settings"]) {
      expect(canSee(path, "cashier")).toBe(false);
    }
  });

  it("a manager gets the shop floor but not the books", () => {
    expect(canSee("/stock", "manager")).toBe(true);
    expect(canSee("/products", "manager")).toBe(true);
    // A cashier opens and closes their own till; what it should have held is not theirs.
    expect(canSee("/cash", "manager")).toBe(true);
    expect(canSee("/dashboard", "manager")).toBe(false);
    expect(canSee("/accounts", "manager")).toBe(false);
    expect(canSee("/settings", "manager")).toBe(false);
  });

  it("an owner sees everything", () => {
    expect(navFor("owner")).toHaveLength(14);
  });

  it("the owner can share owner-only sections with managers, one at a time", () => {
    expect(canSee("/dashboard", "manager", { managersSeeDashboard: true })).toBe(true);
    // Turning one on must not turn the others on.
    expect(canSee("/accounts", "manager", { managersSeeDashboard: true })).toBe(false);
    expect(canSee("/settings", "manager", { managersSeeDashboard: true })).toBe(false);
  });

  it("a flag never promotes a cashier", () => {
    expect(canSee("/dashboard", "cashier", { managersSeeDashboard: true })).toBe(false);
    expect(canSee("/settings", "cashier", { managersSeeSettings: true })).toBe(false);
  });

  it("sub-paths follow their section", () => {
    expect(canSee("/settings/branches", "cashier")).toBe(false);
    expect(canSee("/settings/branches", "owner")).toBe(true);
    expect(canSee("/stock/receive", "manager")).toBe(true);
  });

  it("pages that are not sections are left to their own guards", () => {
    // /pin has its own rule (owners and managers, enforced by set_pin itself).
    expect(canSee("/pin", "cashier")).toBe(true);
  });
});

describe("the phone tab bar", () => {
  it("gives a cashier at most 3, so the bar stays thumb-sized", () => {
    const tabs = tabsFor("cashier");
    expect(tabs).toHaveLength(3);
    expect(overflowFor("cashier")).toHaveLength(0);
  });

  it("gives managers and owners 4, with the rest in More", () => {
    for (const role of ["manager", "owner"] as const) {
      expect(tabsFor(role)).toHaveLength(4);
      expect(overflowFor(role).length).toBeGreaterThan(0);
    }
  });

  it("every section is reachable: tabs plus More covers the whole menu", () => {
    for (const role of ["owner", "manager", "cashier"] as const) {
      const reachable = [...tabsFor(role), ...overflowFor(role)].map((n) => n.href).sort();
      expect(reachable).toEqual(navFor(role).map((n) => n.href).sort());
    }
  });

  it("never offers a tab the role cannot open", () => {
    for (const role of ["owner", "manager", "cashier"] as const) {
      for (const item of [...tabsFor(role), ...overflowFor(role)]) {
        expect(canSee(item.href, role)).toBe(true);
      }
    }
  });
});

describe("feature switches hide sections", () => {
  // "Off features disappear from menus": a one-branch cable shop should not be looking
  // at a trial balance or a transfer screen.
  const allOff = {
    purchase_orders: false, transfers: false, accounts: false,
  };

  it("hides Purchases, Transfers and Accounts until the shop turns them on", () => {
    expect(navFor("owner", {}, allOff).map((n) => n.href))
      .not.toContain("/purchases");
    expect(navFor("owner", {}, allOff).map((n) => n.href)).not.toContain("/transfers");
    expect(navFor("owner", {}, allOff).map((n) => n.href)).not.toContain("/accounts");
  });

  it("hides them from the OWNER too, because the switch is where that decision lives", () => {
    expect(canSee("/accounts", "owner", {}, allOff)).toBe(false);
  });

  it("shows them once the feature is on", () => {
    const on = { ...allOff, transfers: true };
    expect(canSee("/transfers", "owner", {}, on)).toBe(true);
    expect(canSee("/transfers", "manager", {}, on)).toBe(true);
    expect(canSee("/accounts", "owner", {}, on)).toBe(false);
  });

  it("a feature being on never promotes a role that could not see it anyway", () => {
    const on = { purchase_orders: true, transfers: true, accounts: true };
    expect(canSee("/accounts", "cashier", {}, on)).toBe(false);
    expect(canSee("/purchases", "cashier", {}, on)).toBe(false);
    expect(canSee("/accounts", "manager", {}, on)).toBe(false);
  });

  it("with no feature map at all, nothing is hidden (so the menu never goes blank)", () => {
    expect(navFor("owner")).toHaveLength(14);
  });
});
