// Demo mode: runs entirely in the browser with sample data, so the counter can be
// tried before Supabase is set up. Mirrors the rules in complete_sale().
//
// The demo person is an OWNER with two branches, so everything a shop would be shown —
// the branch switcher, the whole menu, the approval PIN screen — is reachable. Demo
// mode is also the sales demo. Nothing here names a real shop.
import { addMonths, computeTotals, dhakaToday, friendlyError, isValidPhone, roundTaka } from "../sale";
import type {
  ApprovalResult, Approver, BranchAdmin, Product, Receipt, ReceiptLine, Role, SaleInput,
  SerialUnit, Staff, StaffLookup, StaffMember,
} from "../types";
import type { Backend } from "./types";
import {
  DEFAULT_SERIAL_BRANCH, DEMO_BRANCHES, DEMO_CATEGORIES, DEMO_PIN, DEMO_SERIAL_BRANCH,
  DEMO_STOCK, demoCatalogue,
} from "./demo-data";

const DEMO_SHOP_NAME = "Demo Shop";
const MAX_PIN_TRIES = 5;

interface DemoSerial extends SerialUnit {
  productId: string;
  branchId: string;
  sold: boolean;
}

export function createDemoBackend(): Backend {
  const catalogue = demoCatalogue();
  const branches: BranchAdmin[] = DEMO_BRANCHES.map((b, i) => ({
    ...b,
    address: i === 0 ? "123 Example Road, Dhaka" : "456 Other Road, Dhaka",
    phone: i === 0 ? "01700-000000" : "01700-000001",
    active: true,
    nextInvoice: 1,
  }));

  // Stock per branch, so selling at one cannot change the other.
  const stock: Record<string, Record<string, number>> = {};
  for (const b of branches) stock[b.id] = { ...(DEMO_STOCK[b.id] ?? {}) };

  const serials: DemoSerial[] = catalogue.flatMap((p) =>
    p.serialNumbers.map((serial, i) => ({
      id: `${p.id}-s${i}`,
      serial,
      productId: p.id,
      branchId: DEMO_SERIAL_BRANCH[serial] ?? DEFAULT_SERIAL_BRANCH,
      sold: false,
    })),
  );

  const nextInvoice: Record<string, number> = {};
  for (const b of branches) nextInvoice[b.id] = 1;

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
    branches: branches.map(({ id, name, code, locations }) => ({ id, name, code, locations })),
  };

  const team: StaffMember[] = [
    { id: "demo-owner", name: "Ovi", role: "owner", discountLimitPct: 5, active: true, hasPin: true, branchIds: branches.map((b) => b.id) },
    { id: "demo-rafi", name: "Rafi", role: "manager", discountLimitPct: 10, active: true, hasPin: true, branchIds: [branches[1].id] },
    { id: "demo-razu", name: "Razu", role: "cashier", discountLimitPct: 5, active: true, hasPin: false, branchIds: [branches[0].id] },
  ];

  const fail = (code: string): never => {
    throw new Error(friendlyError(code));
  };

  const branchOr404 = (branchId: string): BranchAdmin => {
    const b = branches.find((x) => x.id === branchId && x.active);
    if (!b) return fail("BRANCH_NOT_ALLOWED");
    return b;
  };

  /** The catalogue as one branch sees it. */
  const productsAt = (branchId: string): Product[] =>
    catalogue.map((p) => {
      const mine: SerialUnit[] = serials
        .filter((s) => s.productId === p.id && s.branchId === branchId && !s.sold)
        .map(({ id, serial }) => ({ id, serial }));
      return {
        id: p.id, code: p.code, barcode: p.barcode, name: p.name, brand: p.brand,
        categoryId: p.categoryId, price: p.price, warrantyMonths: p.warrantyMonths,
        isSerial: p.isSerial, reorderLevel: p.reorderLevel,
        stock: p.isSerial ? mine.length : (stock[branchId]?.[p.id] ?? 0),
        serials: mine,
      };
    });

  return {
    mode: "demo",
    async currentStaff(): Promise<StaffLookup> { return { kind: "ok", staff }; },
    async listCategories() { return DEMO_CATEGORIES; },
    async listProducts(branchId: string) { branchOr404(branchId); return productsAt(branchId); },
    async listApprovers(): Promise<Approver[]> {
      return team.filter((m) => m.hasPin && m.active && m.role !== "cashier")
        .map(({ id, name, role }) => ({ id, name, role }));
    },
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
      const approver = team.find((m) => m.id === approverId && m.hasPin && m.active);
      if (!approver) fail("APPROVER_NOT_FOUND");
      if (failedPinTries >= MAX_PIN_TRIES) return { ok: false, locked: true, triesLeft: 0 };
      if (typed !== pin) {
        failedPinTries += 1;
        return { ok: false, locked: false, triesLeft: MAX_PIN_TRIES - failedPinTries };
      }
      failedPinTries = 0;
      const approvalId = crypto.randomUUID();
      approvals.add(approvalId);
      return { ok: true, approvalId, approverId, approverName: approver!.name };
    },

    async completeSale(input: SaleInput): Promise<Receipt> {
      const branch = branchOr404(input.branchId);
      if (input.lines.length === 0) fail("EMPTY_SALE");
      const today = dhakaToday();
      const items: ReceiptLine[] = [];
      const atBranch = new Map(productsAt(input.branchId).map((p) => [p.id, p]));

      // Claim the approval first, so a sale is never built on one about to be rejected.
      if (input.discountPct > staff.discountLimitPct) {
        const id = input.approvalId;
        if (!id) fail("MANAGER_PIN_REQUIRED");
        if (!approvals.delete(id as string)) fail("APPROVAL_NOT_VALID");
      }

      // Work out every change first, apply it only once nothing can fail — the database
      // gets this from its transaction; here it has to be deliberate.
      const soldSerialIds: string[] = [];
      const stockTaken: Record<string, number> = {};

      for (const line of input.lines) {
        const p = atBranch.get(line.productId);
        if (!p) return fail("PRODUCT_NOT_FOUND");
        const qty = p.isSerial ? line.serialIds.length : line.qty;
        if (p.isSerial && qty === 0) fail(`SERIAL_REQUIRED:${p.name}`);
        if (qty <= 0) fail(`BAD_QTY:${p.name}`);

        if (p.isSerial) {
          // The serial has to be unsold AND at this branch.
          const picked = serials.filter(
            (s) => line.serialIds.includes(s.id) && !s.sold && s.branchId === input.branchId,
          );
          if (picked.length !== line.serialIds.length) fail(`SERIAL_NOT_AVAILABLE:${p.name}`);
          soldSerialIds.push(...picked.map((s) => s.id));
        } else {
          if (p.stock < qty) fail(`OUT_OF_STOCK:${p.name}`);
          stockTaken[p.id] = (stockTaken[p.id] ?? 0) + qty;
        }

        items.push({
          name: p.name, qty, unitPrice: p.price, lineTotal: p.price * qty,
          warrantyUntil: p.warrantyMonths > 0 ? addMonths(today, p.warrantyMonths) : null,
          serials: serials.filter((s) => line.serialIds.includes(s.id)).map((s) => s.serial),
        });
      }

      const totals = computeTotals(
        input.lines.map((l) => ({ ...l, qty: atBranch.get(l.productId)?.isSerial ? l.serialIds.length : l.qty })),
        atBranch,
        input.discountPct,
      );

      let change: number | null = null;
      if (input.paymentMethod === "cash") {
        if (input.cashReceived == null || input.cashReceived < totals.total) fail("CASH_SHORT");
        change = roundTaka((input.cashReceived ?? 0) - totals.total);
      } else if (!input.paymentRef || input.paymentRef.trim().length < 4) {
        fail("PAYMENT_REF_REQUIRED");
      }
      if (input.customerPhone && !isValidPhone(input.customerPhone)) fail("BAD_PHONE");

      // Nothing can fail from here, so commit the changes.
      for (const s of serials) if (soldSerialIds.includes(s.id)) s.sold = true;
      for (const [productId, qty] of Object.entries(stockTaken)) {
        stock[input.branchId][productId] = (stock[input.branchId][productId] ?? 0) - qty;
      }

      // Numbering is per branch, with the branch's code in it.
      const invoiceNo = `DEMO-${branch.code}-${today.slice(0, 4)}${String(nextInvoice[branch.id]++).padStart(6, "0")}`;
      return {
        id: crypto.randomUUID(), invoiceNo, createdAt: new Date().toISOString(),
        staffName: staff.name, shopName: staff.shopName, shopAddress: branch.address,
        branchName: branch.name, branchAddress: branch.address, branchPhone: branch.phone,
        subtotal: totals.subtotal, discountPct: totals.discountPct, discountAmount: totals.discountAmount, total: totals.total,
        paymentMethod: input.paymentMethod,
        cashReceived: input.paymentMethod === "cash" ? input.cashReceived : null,
        changeGiven: change, paymentRef: input.paymentRef, customerPhone: input.customerPhone, items,
      };
    },

    // --- Settings → Branches ---

    async listBranches() { return structuredClone(branches); },

    async saveBranch(input) {
      if (input.id) {
        const b = branches.find((x) => x.id === input.id);
        if (!b) fail("BRANCH_NOT_FOUND");
        if (input.active === false && branches.filter((x) => x.active && x.id !== input.id).length === 0) {
          fail("LAST_BRANCH");
        }
        Object.assign(b!, {
          name: input.name?.trim() || b!.name,
          code: input.code ?? b!.code,
          address: input.address ?? b!.address,
          phone: input.phone ?? b!.phone,
          active: input.active ?? b!.active,
        });
        return;
      }
      const newName = input.name?.trim();
      if (!newName) fail("BRANCH_NAME_REQUIRED");
      if (!input.code || !/^[A-Z0-9]{1,6}$/.test(input.code)) fail("BAD_BRANCH_CODE");
      const id = crypto.randomUUID();
      branches.push({
        id, name: newName as string, code: input.code as string,
        address: input.address ?? null, phone: input.phone ?? null,
        active: true, nextInvoice: 1,
        locations: [{ id: crypto.randomUUID(), name: "Main store", isDefault: true }],
      });
      stock[id] = {};
      staff.branches = branches.filter((b) => b.active)
        .map(({ id: bid, name, code, locations }) => ({ id: bid, name, code, locations }));
    },

    async saveStockLocation({ branchId, name, locationId, isDefault }) {
      const b = branches.find((x) => x.id === branchId);
      if (!b) fail("BRANCH_NOT_FOUND");
      if (!name.trim()) fail("LOCATION_NAME_REQUIRED");
      if (isDefault) for (const l of b!.locations) l.isDefault = false;
      if (locationId) {
        const l = b!.locations.find((x) => x.id === locationId);
        if (!l) fail("LOCATION_NOT_FOUND");
        l!.name = name.trim();
        l!.isDefault = isDefault ?? l!.isDefault;
      } else {
        b!.locations.push({ id: crypto.randomUUID(), name: name.trim(), isDefault: Boolean(isDefault) });
      }
      staff.branches = branches.filter((x) => x.active)
        .map(({ id, name: n, code, locations }) => ({ id, name: n, code, locations }));
    },

    async listStaff() { return structuredClone(team); },

    async setStaffBranches(staffId: string, branchIds: string[]) {
      const m = team.find((x) => x.id === staffId);
      if (!m) fail("STAFF_NOT_FOUND");
      if (branchIds.some((id) => !branches.some((b) => b.id === id))) fail("BRANCH_NOT_FOUND");
      m!.branchIds = [...branchIds];
    },

    async setStaffAccess({ staffId, role, discountLimitPct, active }) {
      const m = team.find((x) => x.id === staffId);
      if (!m) fail("STAFF_NOT_FOUND");
      // Mirrors set_staff_access(): no editing your own row, never the last owner.
      if (staffId === staff.id) fail("NO_SELF_EDIT");
      if (role && !["owner", "manager", "cashier"].includes(role)) fail(`BAD_ROLE:${role}`);
      if (discountLimitPct != null && (discountLimitPct < 0 || discountLimitPct > 100)) {
        fail(`BAD_LIMIT:${discountLimitPct}`);
      }
      if ((active === false || (role && role !== "owner")) && m!.role === "owner") {
        if (team.filter((x) => x.role === "owner" && x.active && x.id !== staffId).length === 0) {
          fail("LAST_OWNER");
        }
      }
      m!.role = (role ?? m!.role) as Role;
      m!.discountLimitPct = discountLimitPct ?? m!.discountLimitPct;
      m!.active = active ?? m!.active;
    },
  };
}
