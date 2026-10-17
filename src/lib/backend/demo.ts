// Demo mode: runs entirely in the browser with sample data, so the counter can be
// tried before Supabase is set up. Mirrors the rules in complete_sale().
import { addMonths, computeTotals, dhakaToday, friendlyError, isValidPhone, roundTaka } from "../sale";
import type { Product, Receipt, ReceiptLine, SaleInput, Staff } from "../types";
import type { Backend } from "./types";
import { DEMO_CATEGORIES, DEMO_PIN, demoProducts } from "./demo-data";

export function createDemoBackend(): Backend {
  let products = demoProducts();
  let nextInvoice = 1790;
  const staff: Staff = { id: "demo-ovi", name: "Ovi", role: "cashier", discountLimitPct: 5, shopName: "Computer Services" };

  const fail = (code: string): never => {
    throw new Error(friendlyError(code));
  };

  return {
    mode: "demo",
    async currentStaff() { return staff; },
    async listCategories() { return DEMO_CATEGORIES; },
    async listProducts() { return structuredClone(products); },
    async checkManagerPin(pin) { return pin === DEMO_PIN; },
    async signOut() {},

    async completeSale(input: SaleInput): Promise<Receipt> {
      if (input.lines.length === 0) fail("EMPTY_SALE");
      const byId = new Map(products.map((p) => [p.id, p]));
      const next: Product[] = structuredClone(products);
      const nextById = new Map(next.map((p) => [p.id, p]));
      const today = dhakaToday();
      const items: ReceiptLine[] = [];

      for (const line of input.lines) {
        const p = nextById.get(line.productId);
        if (!p) return fail("PRODUCT_NOT_FOUND");
        const qty = p.isSerial ? line.serialIds.length : line.qty;
        if (p.isSerial && qty === 0) fail(`SERIAL_REQUIRED:${p.name}`);
        if (qty <= 0) fail(`BAD_QTY:${p.name}`);
        if (p.stock < qty) fail(`OUT_OF_STOCK:${p.name}`);
        const sold = p.serials.filter((s) => line.serialIds.includes(s.id));
        if (sold.length !== line.serialIds.length) fail(`SERIAL_NOT_AVAILABLE:${p.name}`);
        p.serials = p.serials.filter((s) => !line.serialIds.includes(s.id));
        p.stock -= qty;
        items.push({
          name: p.name, qty, unitPrice: p.price, lineTotal: p.price * qty,
          warrantyUntil: p.warrantyMonths > 0 ? addMonths(today, p.warrantyMonths) : null,
          serials: sold.map((s) => s.serial),
        });
      }

      const totals = computeTotals(input.lines.map((l) => ({ ...l, qty: byId.get(l.productId)?.isSerial ? l.serialIds.length : l.qty })), byId, input.discountPct);
      if (input.discountPct > staff.discountLimitPct) {
        if (!input.managerPin) fail("MANAGER_PIN_REQUIRED");
        if (input.managerPin !== DEMO_PIN) fail("MANAGER_PIN_INVALID");
      }
      let change: number | null = null;
      if (input.paymentMethod === "cash") {
        if (input.cashReceived == null || input.cashReceived < totals.total) fail("CASH_SHORT");
        change = roundTaka((input.cashReceived ?? 0) - totals.total);
      } else if (!input.paymentRef || input.paymentRef.trim().length < 4) {
        fail("PAYMENT_REF_REQUIRED");
      }
      if (input.customerPhone && !isValidPhone(input.customerPhone)) fail("BAD_PHONE");

      products = next;
      const invoiceNo = `CSLINV${today.slice(0, 4)}${String(nextInvoice++).padStart(6, "0")}`;
      return {
        id: crypto.randomUUID(), invoiceNo, createdAt: new Date().toISOString(),
        staffName: staff.name, shopName: staff.shopName,
        shopAddress: "Shop 9 & 10, Ground Floor, BCS Computer City, IDB Bhaban, Agargaon, Dhaka-1207",
        subtotal: totals.subtotal, discountPct: totals.discountPct, discountAmount: totals.discountAmount, total: totals.total,
        paymentMethod: input.paymentMethod,
        cashReceived: input.paymentMethod === "cash" ? input.cashReceived : null,
        changeGiven: change, paymentRef: input.paymentRef, customerPhone: input.customerPhone, items,
      };
    },
  };
}
