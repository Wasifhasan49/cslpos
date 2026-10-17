import { describe, expect, it } from "vitest";
import { createDemoBackend } from "./backend/demo";
import { demoProducts } from "./backend/demo-data";
import {
  addMonths, computeTotals, dhakaToday, friendlyError, quickCashAmounts, saleBlocker, searchProducts, type CheckoutState,
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
    expect(friendlyError("something odd")).toMatch(/Check the internet/);
  });
});

describe("demo backend follows the same rules as the database", () => {
  it("sells, lowers stock, numbers invoices, sets warranty", async () => {
    const b = createDemoBackend();
    const r = await b.completeSale({
      lines: [{ productId: "a1", qty: 2, serialIds: [] }], paymentMethod: "cash",
      discountPct: 0, managerPin: null, customerPhone: null, cashReceived: 1000, paymentRef: null,
    });
    expect(r.invoiceNo).toMatch(/^CSLINV\d{4}001790$/);
    expect(r.changeGiven).toBe(0);
    expect(r.items[0].warrantyUntil).toBe(addMonths(dhakaToday(), 12));
    expect((await b.listProducts()).find((p) => p.id === "a1")?.stock).toBe(2);
  });
  it("rejects a wrong PIN and leaves stock alone", async () => {
    const b = createDemoBackend();
    await expect(b.completeSale({
      lines: [{ productId: "a1", qty: 1, serialIds: [] }], paymentMethod: "cash",
      discountPct: 20, managerPin: "0000", customerPhone: null, cashReceived: 500, paymentRef: null,
    })).rejects.toThrow("Wrong manager PIN.");
    expect((await b.listProducts()).find((p) => p.id === "a1")?.stock).toBe(4);
  });
  it("a sold serial disappears from stock", async () => {
    const b = createDemoBackend();
    const r = await b.completeSale({
      lines: [{ productId: "a8", qty: 1, serialIds: ["a8-s0"] }], paymentMethod: "nagad",
      discountPct: 0, managerPin: null, customerPhone: "01711000000", cashReceived: null, paymentRef: "NGD12345",
    });
    expect(r.items[0].serials).toEqual(["S64DNX0T41822"]);
    const ssd = (await b.listProducts()).find((p) => p.id === "a8")!;
    expect(ssd.stock).toBe(2);
    expect(ssd.serials.map((s) => s.serial)).not.toContain("S64DNX0T41822");
  });
});
