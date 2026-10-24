// Demo mode: runs entirely in the browser with sample data, so the counter can be
// tried before Supabase is set up. Mirrors the rules in complete_sale().
//
// The demo person is an OWNER with two branches, so everything a shop would be shown —
// the branch switcher, the whole menu, the approval PIN screen — is reachable. Demo
// mode is also the sales demo. Nothing here names a real shop.
import { addMonths, computeTotals, dhakaToday, friendlyError, isValidPhone, roundTaka } from "../sale";
import type {
  ApprovalResult, Approver, BranchAdmin, FeatureKey, Product, Receipt, ReceiptLine, Role,
  SaleInput, SerialUnit, SettingRow, SettingTable, SettingsBundle, Staff, StaffLookup,
  StaffMember,
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

  // Demo settings: the same defaults seed_shop_defaults() gives a real new shop, so the
  // demo shows what a shop actually opens with.
  const features: Record<string, boolean> = {
    vat: false, multi_location: false, price_lists: false, credit_sales: false,
    purchase_orders: false, transfers: false, accounts: false, sms: false,
    extra_charges: false, hs_codes: false, managers_see_dashboard: false,
    managers_see_accounts: false, managers_see_settings: false,
  };
  const shopDetails = {
    name: DEMO_SHOP_NAME, address: "123 Example Road, Dhaka", phone: "01700-000000",
    email: null as string | null, logoUrl: null as string | null, binVat: null as string | null,
    receiptFooter: "Thank you. Keep this receipt for warranty claims.",
    invoicePrefix: "DEMO", currency: "BDT", aitPct: 0,
  };
  const row = (o: Record<string, string | number | boolean | null>): SettingRow =>
    ({ id: crypto.randomUUID(), ...o }) as SettingRow;
  const lists: Record<SettingTable, SettingRow[]> = {
    units: [
      row({ name: "pcs", allow_decimals: false }), row({ name: "box", allow_decimals: false }),
      row({ name: "set", allow_decimals: false }), row({ name: "pair", allow_decimals: false }),
      row({ name: "metre", allow_decimals: true }), row({ name: "kg", allow_decimals: true }),
    ],
    vat_rates: [
      row({ name: "VAT 5% (inclusive)", pct: 5, inclusive: true, is_default: true }),
      row({ name: "VAT 7.5% (inclusive)", pct: 7.5, inclusive: true, is_default: false }),
      row({ name: "VAT 15% (inclusive)", pct: 15, inclusive: true, is_default: false }),
      row({ name: "No VAT", pct: 0, inclusive: true, is_default: false }),
    ],
    hs_codes: [],
    extra_charges: [
      row({ name: "Delivery", kind: "fixed", value: 0, taxable: false }),
      row({ name: "Installation", kind: "fixed", value: 0, taxable: false }),
      row({ name: "Service charge", kind: "percent", value: 0, taxable: false }),
    ],
    discount_types: [
      row({ name: "Regular customer" }), row({ name: "Bulk purchase" }),
      row({ name: "Staff discount" }), row({ name: "Festival offer" }), row({ name: "Price match" }),
    ],
    payment_methods: [
      row({ key: "cash", label: "Cash", enabled: true, needs_ref: false }),
      row({ key: "bkash", label: "bKash", enabled: true, needs_ref: true }),
      row({ key: "nagad", label: "Nagad", enabled: true, needs_ref: true }),
      row({ key: "card", label: "Card", enabled: true, needs_ref: true }),
      row({ key: "rocket", label: "Rocket", enabled: false, needs_ref: true }),
      row({ key: "bank", label: "Bank transfer", enabled: false, needs_ref: true }),
      row({ key: "cheque", label: "Cheque", enabled: false, needs_ref: true }),
      row({ key: "due", label: "On due (baki)", enabled: false, needs_ref: false }),
    ],
    card_types: [
      row({ name: "Visa", charge_pct: 2 }), row({ name: "Mastercard", charge_pct: 2 }),
      row({ name: "American Express", charge_pct: 3 }),
    ],
    bank_accounts: [row({ name: "Counter cash drawer", kind: "cash_drawer" })],
    warranty_terms: [
      row({ name: "No warranty", months: 0, receipt_text: "No warranty on this item." }),
      row({ name: "6 months replacement", months: 6, receipt_text: "Replacement within 6 months for manufacturing faults." }),
      row({ name: "1 year replacement", months: 12, receipt_text: "Replacement within 1 year for manufacturing faults. Physical damage and burn marks are not covered." }),
      row({ name: "1 year service only", months: 12, receipt_text: "Service within 1 year. Replacement is not included." }),
      row({ name: "3 years service", months: 36, receipt_text: "Service within 3 years. Replacement is not included." }),
    ],
    transaction_categories: [
      row({ name: "Walk-in" }), row({ name: "Corporate" }), row({ name: "Online" }), row({ name: "Service" }),
    ],
  };
  const PERMISSION_KEYS = [
    { key: "sell", label: "Sell at the counter", area: "counter", hasLimit: false },
    { key: "give_discount", label: "Give a discount", area: "counter", hasLimit: true },
    { key: "change_price", label: "Change a price within the band", area: "counter", hasLimit: false },
    { key: "see_cost", label: "See cost prices", area: "counter", hasLimit: false },
    { key: "void_sale", label: "Void a sale", area: "counter", hasLimit: false },
    { key: "return_sale", label: "Take a return", area: "counter", hasLimit: false },
    { key: "reprint", label: "Print a receipt again", area: "counter", hasLimit: false },
    { key: "approve", label: "Approve what others need signed off", area: "counter", hasLimit: false },
    { key: "receive_stock", label: "Receive stock", area: "stock", hasLimit: false },
    { key: "adjust_stock", label: "Adjust or write off stock", area: "stock", hasLimit: false },
    { key: "transfer_stock", label: "Transfer stock between branches", area: "stock", hasLimit: false },
    { key: "view_reports", label: "See reports", area: "reports", hasLimit: false },
    { key: "export_reports", label: "Print or export reports", area: "reports", hasLimit: false },
    { key: "view_accounts", label: "See the accounts", area: "accounts", hasLimit: false },
    { key: "print_cheques", label: "Print cheques", area: "accounts", hasLimit: false },
    { key: "edit_settings", label: "Change settings", area: "admin", hasLimit: false },
    { key: "manage_staff", label: "Add staff and change what they can do", area: "admin", hasLimit: false },
  ];
  const MANAGER_CAN = new Set(["sell","give_discount","change_price","see_cost","void_sale",
    "return_sale","reprint","approve","receive_stock","adjust_stock","transfer_stock",
    "view_reports","export_reports"]);
  const CASHIER_CAN = new Set(["sell","give_discount","reprint"]);
  const rolePermissions = (["owner","manager","cashier"] as Role[]).flatMap((role) =>
    PERMISSION_KEYS.map((k) => ({
      role, perm: k.key,
      allowed: role === "owner" ? true : role === "manager" ? MANAGER_CAN.has(k.key) : CASHIER_CAN.has(k.key),
      numLimit: k.key === "give_discount" ? (role === "owner" ? 100 : role === "manager" ? 10 : 5) : null,
    })),
  );
  const staffPermissions: { staffId: string; perm: string; allowed: boolean; numLimit: number | null }[] = [];

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
          // Demo mode does not charge VAT: the switch is off, like a new shop.
          vatPct: 0, vatAmount: 0, vatInclusive: true,
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
        changeGiven: change, paymentRef: input.paymentRef, customerPhone: input.customerPhone,
        vatAmount: 0, chargesAmount: 0, charges: [],
        receiptFooter: shopDetails.receiptFooter, binVat: shopDetails.binVat,
        items,
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

    // --- Settings ---

    async listFeatures() { return { ...features }; },

    async loadSettings(): Promise<SettingsBundle> {
      return structuredClone({
        shop: shopDetails,
        features,
        lists,
        permissionKeys: PERMISSION_KEYS,
        rolePermissions,
        staffPermissions,
        documentSequences: branches.flatMap((b) =>
          ["invoice", "grn", "po", "transfer", "return"].map((docType) => ({
            branchId: b.id, docType, prefix: "", nextNumber: docType === "invoice" ? b.nextInvoice : 1,
          })),
        ),
      });
    },

    async setFeature(feature: FeatureKey, enabled: boolean) { features[feature] = enabled; },

    async saveShopDetails(values) {
      Object.assign(shopDetails, {
        name: (values.name as string)?.trim() || shopDetails.name,
        address: values.address !== undefined ? (values.address as string) : shopDetails.address,
        phone: values.phone !== undefined ? (values.phone as string) : shopDetails.phone,
        email: values.email !== undefined ? (values.email as string) : shopDetails.email,
        binVat: values.bin_vat !== undefined ? (values.bin_vat as string) : shopDetails.binVat,
        receiptFooter: values.receipt_footer !== undefined ? (values.receipt_footer as string) : shopDetails.receiptFooter,
        invoicePrefix: (values.invoice_prefix as string)?.toUpperCase() || shopDetails.invoicePrefix,
      });
      staff.shopName = shopDetails.name;
    },

    async saveSettingRow(table, id, values) {
      const list = lists[table];
      if (!list) fail(`BAD_SETTING_TABLE:${table}`);
      if (id) {
        const found = list.find((r) => r.id === id);
        if (!found) fail("SETTING_NOT_FOUND");
        Object.assign(found!, values);
        return structuredClone(found!);
      }
      const created = row(values);
      list.push(created);
      return structuredClone(created);
    },

    async setRolePermission(role, perm, allowed, limit) {
      const found = rolePermissions.find((r) => r.role === role && r.perm === perm);
      if (!found) fail(`BAD_PERMISSION:${perm}`);
      found!.allowed = allowed;
      found!.numLimit = limit ?? found!.numLimit;
    },

    async setStaffPermission(staffId, perm, allowed, limit) {
      const i = staffPermissions.findIndex((p) => p.staffId === staffId && p.perm === perm);
      if (allowed === null) {
        if (i >= 0) staffPermissions.splice(i, 1);
        return;
      }
      const entry = { staffId, perm, allowed, numLimit: limit ?? null };
      if (i >= 0) staffPermissions[i] = entry; else staffPermissions.push(entry);
    },

    async setDocumentNextNumber(branchId, docType, next) {
      const b = branches.find((x) => x.id === branchId);
      if (!b) fail("BRANCH_NOT_FOUND");
      if (docType === "invoice") {
        if (next < b!.nextInvoice) fail(`NUMBER_GOES_BACKWARDS:${b!.nextInvoice}`);
        b!.nextInvoice = next;
      }
    },
  };
}
