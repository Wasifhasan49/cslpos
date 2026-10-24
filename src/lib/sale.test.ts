import { describe, expect, it } from "vitest";
import { createDemoBackend } from "./backend/demo";
import { demoProducts } from "./backend/demo-data";
import {
  SALE_ERROR_CODES, addMonths, computeTotals, dhakaToday, friendlyError, isSessionExpired,
  pinScreenError, quickCashAmounts, saleBlocker, searchProducts, type CheckoutState,
} from "./sale";

const products = demoProducts();
const byId = new Map(products.map((p) => [p.id, p]));
const base: CheckoutState = {
  lines: [{ productId: "a1", qty: 2, serialIds: [] }],
  products: byId, discountPct: 0, discountLimitPct: 5, pinApproved: false,
  phone: "", method: "cash", cashReceived: "1000", paymentRef: "",
};

describe("totals", () => {
  it("prices come from the product, discounts round like Postgres", () => {
    expect(computeTotals(base.lines, byId, 0).total).toBe(1000);
    // 5% of 450 = 22.5 -> 23 (same as the database test)
    expect(computeTotals([{ productId: "a4", qty: 1, serialIds: [] }], byId, 5).total).toBe(427);
  });
});

describe("what stops a sale", () => {
  it("the filmed sale goes through", () => expect(saleBlocker(base)).toBeNull());
  it("empty sale", () => expect(saleBlocker({ ...base, lines: [] })).toMatch(/Add a product/));
  it("serial item without a serial", () =>
    expect(saleBlocker({ ...base, lines: [{ productId: "a8", qty: 0, serialIds: [] }] })).toMatch(/serial number/));
  it("discount over limit needs PIN", () => {
    expect(saleBlocker({ ...base, discountPct: 10 })).toMatch(/manager PIN/);
    expect(saleBlocker({ ...base, discountPct: 10, pinApproved: true })).toBeNull();
  });
  it("bad phone", () => expect(saleBlocker({ ...base, phone: "12345" })).toMatch(/mobile number/));
  it("not enough cash", () => expect(saleBlocker({ ...base, cashReceived: "900" })).toMatch(/cash received/));
  it("bKash needs a transaction ID", () => {
    expect(saleBlocker({ ...base, method: "bkash" })).toMatch(/bKash transaction ID/);
    expect(saleBlocker({ ...base, method: "bkash", paymentRef: "9JK4L2M8" })).toBeNull();
  });
  it("can't sell more than stock", () =>
    expect(saleBlocker({ ...base, lines: [{ productId: "a1", qty: 5, serialIds: [] }] })).toMatch(/Only 4/));
});

describe("helpers", () => {
  it("quick cash buttons", () => expect(quickCashAmounts(1250)).toEqual([1250, 1500, 2000, 5000]));
  it("warranty dates follow Postgres month maths", () => {
    expect(addMonths("2026-10-17", 12)).toBe("2027-10-17");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
  it("Dhaka date is UTC+6", () => expect(dhakaToday(new Date("2026-10-16T19:30:00Z"))).toBe("2026-10-17"));
  it("search: exact code first, words in any order", () => {
    expect(searchProducts(products, "VEN-HDMI-15", null)[0].id).toBe("a2");
    expect(searchProducts(products, "audio vention", null).map((p) => p.id)).toEqual(["a1"]);
    expect(searchProducts(products, "", "c5").map((p) => p.id)).toEqual(["aa"]);
  });
  it("database errors become plain words", () => {
    expect(friendlyError("SERIAL_NOT_AVAILABLE:Samsung 980 500GB NVMe SSD")).toMatch(/already sold/);
    expect(friendlyError("MANAGER_PIN_INVALID")).toBe("Wrong manager PIN.");
    expect(friendlyError("BAD_PIN")).toBe("Use 4 to 6 digits.");
    expect(friendlyError("WEAK_PIN")).toMatch(/harder to guess/);
    expect(friendlyError("NOT_MANAGER")).toMatch(/owners and managers/);
    expect(friendlyError("APPROVAL_NOT_VALID")).toMatch(/expired or was already used/);
  });

  it("keeps an unknown code visible instead of blaming the internet", () => {
    // The old default told staff to check their connection for every unmapped code,
    // so they reloaded forever chasing a problem that was not there.
    expect(friendlyError("something odd")).toMatch(/Tell the owner/);
    expect(friendlyError("WHOLLY_NEW_CODE")).toMatch(/WHOLLY_NEW_CODE/);
  });

  it("a product name containing a colon is not truncated", () => {
    // split(":") used to drop everything after the second colon.
    expect(friendlyError("OUT_OF_STOCK:Cable: USB-C to HDMI")).toContain("Cable: USB-C to HDMI");
  });

  it("an expired session says so, instead of 'not set up as staff'", () => {
    expect(isSessionExpired("JWT expired")).toBe(true);
    expect(isSessionExpired("OUT_OF_STOCK:Mouse")).toBe(false);
    expect(friendlyError("JWT expired")).toMatch(/session ended/i);
    expect(friendlyError("JWT expired")).toMatch(/sale is still here/i);
  });

  it("the PIN screen never talks about sales", () => {
    // friendlyError's fallback mentions completing a sale, which on a settings screen
    // would tell an owner a sale had failed.
    expect(pinScreenError("BAD_PIN")).toBe("Use 4 to 6 digits.");
    expect(pinScreenError("NOT_MANAGER")).toMatch(/owners and managers/);
    expect(pinScreenError("something odd")).toMatch(/Couldn't save the PIN/);
    expect(pinScreenError("something odd")).not.toMatch(/sale/i);
  });

  it("every code the database can raise has a message", async () => {
    // Keeps src/lib/sale.ts and supabase/migrations/ in step automatically, which is
    // the convention CLAUDE.md asks for.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const raised = new Set<string>();
    for (const file of fs.readdirSync(dir)) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      for (const m of sql.matchAll(/raise exception '([A-Z_]{4,})/g)) raised.add(m[1]);
    }
    expect(raised.size).toBeGreaterThan(10);
    const missing = [...raised].filter((c) => !SALE_ERROR_CODES.includes(c as never));
    expect(missing).toEqual([]);
  });
});

describe("demo backend follows the same rules as the database", () => {
  it("sells, lowers stock, numbers invoices, sets warranty", async () => {
    const b = createDemoBackend();
    const r = await b.completeSale({
      lines: [{ productId: "a1", qty: 2, serialIds: [] }], paymentMethod: "cash",
      discountPct: 0, approvalId: null, customerPhone: null, cashReceived: 1000, paymentRef: null,
    });
    expect(r.invoiceNo).toMatch(/^DEMO\d{4}000001$/);
    expect(r.changeGiven).toBe(0);
    expect(r.items[0].warrantyUntil).toBe(addMonths(dhakaToday(), 12));
    expect((await b.listProducts()).find((p) => p.id === "a1")?.stock).toBe(2);
  });
  it("an over-limit discount without an approval is refused, and stock is untouched", async () => {
    const b = createDemoBackend();
    await expect(b.completeSale({
      lines: [{ productId: "a1", qty: 1, serialIds: [] }], paymentMethod: "cash",
      discountPct: 20, approvalId: null, customerPhone: null, cashReceived: 500, paymentRef: null,
    })).rejects.toThrow(/manager's approval/);
    expect((await b.listProducts()).find((p) => p.id === "a1")?.stock).toBe(4);
  });

  it("a made-up approval id is refused", async () => {
    const b = createDemoBackend();
    await expect(b.completeSale({
      lines: [{ productId: "a1", qty: 1, serialIds: [] }], paymentMethod: "cash",
      discountPct: 20, approvalId: crypto.randomUUID(), customerPhone: null, cashReceived: 500, paymentRef: null,
    })).rejects.toThrow(/expired or was already used/);
  });

  it("a wrong PIN is a result, not an exception, and counts down to a lockout", async () => {
    const b = createDemoBackend();
    const [approver] = await b.listApprovers();
    const first = await b.verifyManagerPin(approver.id, "0000");
    expect(first).toMatchObject({ ok: false, locked: false, triesLeft: 4 });
    for (let i = 0; i < 4; i++) await b.verifyManagerPin(approver.id, "0000");
    expect(await b.verifyManagerPin(approver.id, "0000")).toMatchObject({ ok: false, locked: true });
  });

  it("an approval works once and cannot be replayed", async () => {
    const b = createDemoBackend();
    const [approver] = await b.listApprovers();
    const res = await b.verifyManagerPin(approver.id, "1234");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const sale = {
      lines: [{ productId: "a1", qty: 1, serialIds: [] }], paymentMethod: "cash" as const,
      discountPct: 20, approvalId: res.approvalId, customerPhone: null,
      cashReceived: 500, paymentRef: null,
    };
    expect((await b.completeSale(sale)).total).toBe(400);
    await expect(b.completeSale(sale)).rejects.toThrow(/expired or was already used/);
  });

  it("the demo PIN can be changed, and guessable ones are refused", async () => {
    const b = createDemoBackend();
    const [approver] = await b.listApprovers();
    await expect(b.setPin("123")).rejects.toThrow("Use 4 to 6 digits.");
    await expect(b.setPin("0000")).rejects.toThrow(/harder to guess/);
    await expect(b.setPin("1234")).rejects.toThrow(/harder to guess/);
    await b.setPin("4821");
    expect((await b.verifyManagerPin(approver.id, "4821")).ok).toBe(true);
  });

  it("the demo person is an owner, so the PIN screen is reachable in a demo", async () => {
    const me = await createDemoBackend().currentStaff();
    expect(me.kind).toBe("ok");
    if (me.kind !== "ok") throw new Error("unreachable");
    expect(me.staff.role).toBe("owner");
  });
  it("a sold serial disappears from stock", async () => {
    const b = createDemoBackend();
    const r = await b.completeSale({
      lines: [{ productId: "a8", qty: 1, serialIds: ["a8-s0"] }], paymentMethod: "nagad",
      discountPct: 0, approvalId: null, customerPhone: "01711000000", cashReceived: null, paymentRef: "NGD12345",
    });
    expect(r.items[0].serials).toEqual(["S64DNX0T41822"]);
    const ssd = (await b.listProducts()).find((p) => p.id === "a8")!;
    expect(ssd.stock).toBe(2);
    expect(ssd.serials.map((s) => s.serial)).not.toContain("S64DNX0T41822");
  });
});
