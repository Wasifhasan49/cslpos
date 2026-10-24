// Demo mode: runs entirely in the browser with sample data, so the counter can be
// tried before Supabase is set up. Mirrors the rules in complete_sale().
//
// The demo person is an OWNER, so everything a shop would be shown — including the
// approval PIN screen — is reachable. Demo mode is also the sales demo.
// Nothing here names a real shop.
import { addMonths, computeTotals, dhakaToday, friendlyError, isValidPhone, roundTaka } from "../sale";
import type {
  ApprovalResult, Approver, Product, Receipt, ReceiptLine, SaleInput, Staff, StaffLookup,
} from "../types";
import type { Backend } from "./types";
import { DEMO_CATEGORIES, DEMO_PIN, demoProducts } from "./demo-data";

const DEMO_SHOP_NAME = "Demo Shop";
const DEMO_SHOP_ADDRESS = "123 Example Road, Dhaka";
const MAX_PIN_TRIES = 5;

export function createDemoBackend(): Backend {
  let products = demoProducts();
  let nextInvoice = 1;
  let pin = DEMO_PIN;
  let failedPinTries = 0;
  const approvals = new Set<string>();

  const staff: Staff = {
    id: "demo-owner",
    name: "Ovi",
    role: "owner",
    discountLimitPct: 5,
    shopName: DEMO_SHOP_NAME,
    hasPin: true,
  };
  const approver: Approver = { id: staff.id, name: staff.name, role: staff.role };

  const fail = (code: string): never => {
    throw new Error(friendlyError(code));
  };

  return {
    mode: "demo",
    async currentStaff(): Promise<StaffLookup> { return { kind: "ok", staff }; },
    async listCategories() { return DEMO_CATEGORIES; },
    async listProducts() { return structuredClone(products); },
    async listApprovers() { return [approver]; },
    async signOut() {},

    async setPin(next: string) {
      if (!/^[0-9]{4,6}$/.test(next)) fail("BAD_PIN");
      if (/^(.)\1*$/.test(next) || "01234567890".includes(next) || "09876543210".includes(next)) {
        fail("WEAK_PIN");
      }
      pin = next;
      staff.hasPin = true;
    },

    async verifyManagerPin(approverId: string, typed: string): Promise<ApprovalResult> {
      if (approverId !== staff.id) fail("APPROVER_NOT_FOUND");
      if (failedPinTries >= MAX_PIN_TRIES) return { ok: false, locked: true, triesLeft: 0 };
      if (typed !== pin) {
        failedPinTries += 1;
        return { ok: false, locked: false, triesLeft: MAX_PIN_TRIES - failedPinTries };
      }
      failedPinTries = 0;
      const approvalId = crypto.randomUUID();
      approvals.add(approvalId);
      return { ok: true, approvalId, approverId: staff.id, approverName: staff.name };
    },

    async completeSale(input: SaleInput): Promise<Receipt> {
      if (input.lines.length === 0) fail("EMPTY_SALE");
      const byId = new Map(products.map((p) => [p.id, p]));
      const next: Product[] = structuredClone(products);
      const nextById = new Map(next.map((p) => [p.id, p]));
      const today = dhakaToday();
      const items: ReceiptLine[] = [];

      // Claim the approval first, so a sale is never built on one about to be rejected.
      let approvedBy: string | null = null;
      if (input.discountPct > staff.discountLimitPct) {
        const id = input.approvalId;
        if (!id) fail("MANAGER_PIN_REQUIRED");
        if (!approvals.delete(id as string)) fail("APPROVAL_NOT_VALID");
        approvedBy = staff.id;
      }

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
      let change: number | null = null;
      if (input.paymentMethod === "cash") {
        if (input.cashReceived == null || input.cashReceived < totals.total) fail("CASH_SHORT");
        change = roundTaka((input.cashReceived ?? 0) - totals.total);
      } else if (!input.paymentRef || input.paymentRef.trim().length < 4) {
        fail("PAYMENT_REF_REQUIRED");
      }
      if (input.customerPhone && !isValidPhone(input.customerPhone)) fail("BAD_PHONE");

      products = next;
      void approvedBy; // demo mode has one approver; the real backend records who it was
      const invoiceNo = `DEMO${today.slice(0, 4)}${String(nextInvoice++).padStart(6, "0")}`;
      return {
        id: crypto.randomUUID(), invoiceNo, createdAt: new Date().toISOString(),
        staffName: staff.name, shopName: staff.shopName, shopAddress: DEMO_SHOP_ADDRESS,
        subtotal: totals.subtotal, discountPct: totals.discountPct, discountAmount: totals.discountAmount, total: totals.total,
        paymentMethod: input.paymentMethod,
        cashReceived: input.paymentMethod === "cash" ? input.cashReceived : null,
        changeGiven: change, paymentRef: input.paymentRef, customerPhone: input.customerPhone, items,
      };
    },
  };
}
