// Demo mode: runs entirely in the browser with sample data, so the counter can be
// tried before Supabase is set up. Mirrors the rules in complete_sale().
//
// The demo person is an OWNER with two branches, so everything a shop would be shown —
// the branch switcher, the whole menu, the approval PIN screen — is reachable. Demo
// mode is also the sales demo. Nothing here names a real shop.
import {
  addMonths, dhakaToday, friendlyError, isValidPhone, refundFor, roundTaka,
} from "../sale";
import type {
  ApprovalResult, Approver, BranchAdmin, BulkPriceChange, CatalogueRow, CustomerLookup,
  CountDifference, FeatureKey, GoodsReceivedRow, PriceList, Product, Receipt, ReceiptLine,
  ReceiveResult, Role, SaleInput, SerialUnit, SettingRow, SettingTable, SettingsBundle,
  Staff, StaffLookup, StaffMember, StockMovementRow, Supplier, SupplierGroup,
  LedgerEntry, PoReceiveResult, PurchaseOrderRow, PurchaseOrderStatus, RequisitionRow,
  SupplierAging, TransferLine, TransferReceived, TransferRequestRow, TransferRoute,
  TransferRow, TransferSent,
  CashMovementRow, ShiftRow,
  ReturnResult, SaleDetail, SaleDetailLine, SaleRow,
} from "../types";
import type { ImportKind } from "../import/schema";
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
  /** On the road between branches: not on either shelf, not sellable anywhere. */
  inTransit?: boolean;
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
    invoicePrefix: "DEMO", currency: "BDT", aitPct: 0, poApprovalLimit: 0,
    cashShortLimit: 50, returnDays: 7, saleApprovalLimit: 0, approveAllSales: false,
  };
  // `active` defaults to true in every setup table, so the demo rows have to say so
  // too or the whole list reads as switched off.
  const row = (o: Record<string, string | number | boolean | null>): SettingRow =>
    ({ id: crypto.randomUUID(), active: true, ...o }) as SettingRow;
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
      row({ name: "Walk-in", applies_to: "sale" }), row({ name: "Corporate", applies_to: "sale" }),
      row({ name: "Online", applies_to: "sale" }), row({ name: "Service", applies_to: "sale" }),
      // Expense categories, so a cash-out has something to be filed under (P8).
      row({ name: "Tea and snacks", applies_to: "expense" }),
      row({ name: "Transport", applies_to: "expense" }),
      row({ name: "Electricity", applies_to: "expense" }),
      row({ name: "Shop rent", applies_to: "expense" }),
      row({ name: "Staff advance", applies_to: "expense" }),
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
  // change_price means "within the band the owner set" — below it still needs a PIN.
  const CASHIER_CAN = new Set(["sell","give_discount","change_price","reprint"]);
  const rolePermissions = (["owner","manager","cashier"] as Role[]).flatMap((role) =>
    PERMISSION_KEYS.map((k) => ({
      role, perm: k.key,
      allowed: role === "owner" ? true : role === "manager" ? MANAGER_CAN.has(k.key) : CASHIER_CAN.has(k.key),
      numLimit: k.key === "give_discount" ? (role === "owner" ? 100 : role === "manager" ? 10 : 5) : null,
    })),
  );
  const staffPermissions: { staffId: string; perm: string; allowed: boolean; numLimit: number | null }[] = [];

  // Two price lists, so the dealer rule has something to show, and a band on the
  // keyboard so "down to the minimum, no further" is demonstrable.
  const priceLists: PriceList[] = [
    { id: "pl-retail", name: "Retail", isDefault: true, active: true },
    { id: "pl-dealer", name: "Dealer", isDefault: false, active: true },
  ];
  interface DemoPrice { price: number; mrp: number | null; min: number | null; max: number | null }
  const prices: Record<string, Record<string, DemoPrice>> = { "pl-retail": {}, "pl-dealer": {} };
  for (const p of catalogue) {
    prices["pl-retail"][p.id] = { price: p.price, mrp: null, min: null, max: null };
  }
  prices["pl-retail"]["a5"] = { price: 850, mrp: 950, min: 800, max: null };
  prices["pl-dealer"]["a5"] = { price: 750, mrp: 950, min: 700, max: null };
  prices["pl-dealer"]["a1"] = { price: 420, mrp: null, min: 400, max: null };
  prices["pl-dealer"]["a4"] = { price: 400, mrp: null, min: 380, max: null };

  const customers: CustomerLookup[] = [
    { id: "c-dealer", phone: "01811000000", name: "Karim Traders", priceListId: "pl-dealer", priceListName: "Dealer", discountPct: 0 },
    { id: "c-regular", phone: "01911000000", name: "Regular Rahim", priceListId: "pl-retail", priceListName: "Retail", discountPct: 8 },
  ];

  /** Mirrors resolve_price(): the list price, with the list price as the floor when the
   *  owner set no minimum. */
  const priceFor = (productId: string, listId: string): DemoPrice => {
    const onList = prices[listId]?.[productId] ?? prices["pl-retail"][productId];
    const base = onList ?? { price: catalogue.find((p) => p.id === productId)?.price ?? 0, mrp: null, min: null, max: null };
    return { ...base, min: base.min ?? base.price };
  };

  let importMapping: Record<string, string> | null = null;

  // Suppliers, deliveries and movements, so the stock screens have something real to
  // show without a database.
  const supplierGroups: SupplierGroup[] = [{ id: "sg1", name: "Local distributor" }];
  const suppliers: Supplier[] = [
    { id: "sup1", name: "Smart Technologies BD", phone: "01811999001", address: "Motijheel, Dhaka", groupId: "sg1", groupName: "Local distributor", isCashOnly: false, note: null, active: true, balance: 45000 },
    { id: "sup2", name: "Ryans Computers", phone: "01811999003", address: "Elephant Road, Dhaka", groupId: null, groupName: null, isCashOnly: false, note: null, active: true, balance: 8750 },
    { id: "sup3", name: "One-off seller", phone: "01700111222", address: null, groupId: null, groupName: null, isCashOnly: true, note: "Cash only, no account", active: true, balance: 0 },
  ];
  const movements: StockMovementRow[] = [];
  const deliveries: GoodsReceivedRow[] = [];
  let grnCounter = 1;
  // Purchase paperwork (P6). Empty to start: a new shop has asked for nothing yet.
  const requisitions: RequisitionRow[] = [];
  const purchaseOrders: PurchaseOrderRow[] = [];
  const ledgers: Record<string, LedgerEntry[]> = {
    sup1: [{ at: daysAgo(80), kind: "opening", document: "Opening balance", change: 45000, note: "Moved across from BMS" }],
    sup2: [{ at: daysAgo(12), kind: "purchase", document: "GRN-MAIN-2026000001", change: 8750, note: "RC-2291" }],
    sup3: [],
  };
  let reqCounter = 1;
  let poCounter = 1;
  // Branch transfers (P7). Nothing on the road to start with.
  const transfers: TransferRow[] = [];
  const transferRequests: TransferRequestRow[] = [];
  const routes: TransferRoute[] = [];
  let trCounter = 1;
  let trqCounter = 1;
  // The cash drawer (P8). Nothing open to start: the demo opens its own till.
  const shifts: (ShiftRow & { branchId: string; staffId: string })[] = [];
  // Past sales (P9). The demo keeps them so they can be found, reprinted and returned,
  // with the serial ids on each line: a return has to name the actual unit.
  type DemoSale = SaleDetail & {
    staffId: string; shiftId: string | null;
    lineSerialIds: Record<string, string[]>;
  };
  const sales: DemoSale[] = [];
  let returnCounter = 1;
  const costs: Record<string, number> = { a1: 250 };

  const noteMovement = (m: StockMovementRow) => movements.unshift(m);

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

  /** No routes set means anywhere; the first route the owner adds becomes the rule. */
  const canTransfer = (from: string, to: string): boolean => {
    if (from === to) return false;
    if (routes.length === 0) return true;
    return routes.some((r) => r.fromBranchId === from && r.toBranchId === to);
  };

  const fail = (code: string): never => {
    throw new Error(friendlyError(code));
  };

  const branchOr404 = (branchId: string): BranchAdmin => {
    const b = branches.find((x) => x.id === branchId && x.active);
    if (!b) return fail("BRANCH_NOT_ALLOWED");
    return b;
  };

  /** The catalogue as one branch sees it, priced from one list. */
  const productsAt = (branchId: string, listId = "pl-retail"): Product[] =>
    catalogue.map((p) => {
      const pr = priceFor(p.id, listId);
      const mine: SerialUnit[] = serials
        .filter((s) => s.productId === p.id && s.branchId === branchId && !s.sold && !s.inTransit)
        .map(({ id, serial }) => ({ id, serial }));
      return {
        id: p.id, code: p.code, barcode: p.barcode, name: p.name, brand: p.brand,
        categoryId: p.categoryId, price: pr.price, warrantyMonths: p.warrantyMonths,
        isSerial: p.isSerial, reorderLevel: p.reorderLevel,
        mrp: pr.mrp, minPrice: pr.min, maxPrice: pr.max, isInventory: true,
        stock: p.isSerial ? mine.length : (stock[branchId]?.[p.id] ?? 0),
        serials: mine,
      };
    });

  const api: Backend = {
    mode: "demo",
    async currentStaff(): Promise<StaffLookup> { return { kind: "ok", staff }; },
    async listCategories() { return DEMO_CATEGORIES; },
    async listProducts(branchId: string, priceListId?: string | null) {
      branchOr404(branchId);
      return productsAt(branchId, priceListId ?? "pl-retail");
    },
    async findCustomer(phone: string) { return customers.find((c) => c.phone === phone) ?? null; },
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
      // No drawer, no selling — unless you are the owner, who gets a warning on screen
      // instead. Same rule as the sales_require_open_shift trigger.
      const openShift = shifts.find(
        (sh) => sh.branchId === input.branchId && sh.staffId === staff.id && !sh.closedAt);
      if (!openShift && staff.role !== "owner") fail("NO_OPEN_SHIFT");
      const today = dhakaToday();
      const items: ReceiptLine[] = [];

      // The customer's list decides the prices, exactly as complete_sale() does it.
      const customer = input.customerPhone
        ? customers.find((c) => c.phone === input.customerPhone) ?? null
        : null;
      const listId = input.priceListId ?? customer?.priceListId ?? "pl-retail";
      const atBranch = new Map(productsAt(input.branchId, listId).map((p) => [p.id, p]));

      // A price outside the band needs the same approval a big discount does, and it is
      // decided BEFORE anything moves.
      let needsApproval = input.discountPct > staff.discountLimitPct;
      for (const line of input.lines) {
        const p = atBranch.get(line.productId);
        if (!p) return fail("PRODUCT_NOT_FOUND");
        if (line.unitPrice != null && line.unitPrice !== p.price) {
          const min = p.minPrice ?? p.price;
          if (line.unitPrice < min || (p.maxPrice != null && line.unitPrice > p.maxPrice)) {
            needsApproval = true;
          }
        }
      }

      // Claim the approval first, so a sale is never built on one about to be rejected.
      if (needsApproval) {
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

        const unit = line.unitPrice ?? p.price;
        items.push({
          name: p.name, qty, unitPrice: unit, lineTotal: unit * qty,
          listPrice: p.price, priceOverridden: unit !== p.price, isGift: false,
          warrantyUntil: p.warrantyMonths > 0 ? addMonths(today, p.warrantyMonths) : null,
          serials: serials.filter((s) => line.serialIds.includes(s.id)).map((s) => s.serial),
          // Demo mode does not charge VAT: the switch is off, like a new shop.
          vatPct: 0, vatAmount: 0, vatInclusive: true,
        });
      }

      // The bigger of the manual and the customer's standing discount, never both.
      const effectivePct = Math.max(input.discountPct, customer?.discountPct ?? 0);
      const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
      const discountAmount = roundTaka((subtotal * effectivePct) / 100);
      const totals = {
        itemCount: items.reduce((n, i) => n + i.qty, 0),
        subtotal,
        discountPct: effectivePct,
        discountAmount,
        total: subtotal - discountAmount,
      };

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

      // The drawer this was rung up on gains what the customer handed over, less the
      // change: for a cash sale that is the total, which is what the till can be
      // checked against at closing time.
      if (openShift) {
        openShift.salesCount += 1;
        openShift.byMethod[input.paymentMethod] =
          (openShift.byMethod[input.paymentMethod] ?? 0) + totals.total;
      }

      // Numbering is per branch, with the branch's code in it.
      const invoiceNo = `DEMO-${branch.code}-${today.slice(0, 4)}${String(nextInvoice[branch.id]++).padStart(6, "0")}`;
      const saleId = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      // Keep it, so it can be found by invoice, phone, serial or product name, reprinted
      // and taken back. Each line gets its own id and remembers which units went out.
      const detailLines: SaleDetailLine[] = items.map((i) => {
        const p = catalogue.find((x) => x.name === i.name);
        return {
          id: crypto.randomUUID(), productId: p?.id ?? "", name: i.name, qty: i.qty,
          unitPrice: i.unitPrice, lineTotal: i.lineTotal, vatPct: 0, vatAmount: 0,
          vatInclusive: true, isGift: Boolean(i.isGift), warrantyUntil: i.warrantyUntil,
          returnedQty: 0,
          refundEach: refundFor(
            { qty: i.qty, lineTotal: i.lineTotal, vatAmount: 0, vatInclusive: true },
            1, totals.discountPct),
          isSerial: Boolean(p?.isSerial),
          serials: serials
            .filter((x) => i.serials.includes(x.serial))
            .map((x) => ({ id: x.id, serial: x.serial, status: "sold" as string })),
        };
      });
      const overLimit = shopDetails.approveAllSales
        || (shopDetails.saleApprovalLimit > 0 && totals.total > shopDetails.saleApprovalLimit);
      sales.unshift({
        id: saleId, invoiceNo, createdAt,
        branch: branch.name, branchId: branch.id, branchAddress: branch.address,
        branchPhone: branch.phone, shopName: staff.shopName,
        receiptFooter: shopDetails.receiptFooter, binVat: shopDetails.binVat,
        staff: staff.name, staffId: staff.id, shiftId: openShift?.id ?? null,
        subtotal: totals.subtotal, discountPct: totals.discountPct,
        discountAmount: totals.discountAmount, vatAmount: 0, chargesAmount: 0,
        total: totals.total, paymentMethod: input.paymentMethod,
        cashReceived: input.paymentMethod === "cash" ? input.cashReceived ?? null : null,
        changeGiven: change, paymentRef: input.paymentRef ?? null,
        status: "completed",
        approvalStatus: overLimit ? "awaiting_approval" : "approved",
        voidReason: null, refundMethod: null,
        customerPhone: input.customerPhone ?? null, customerName: customer?.name ?? null,
        sameDay: true, daysOld: 0, returnDays: shopDetails.returnDays,
        items: detailLines, returns: [],
        lineSerialIds: Object.fromEntries(
          detailLines.map((l) => [l.id, l.serials.map((x) => x.id)])),
      });

      return {
        id: saleId, invoiceNo, createdAt,
        staffName: staff.name, shopName: staff.shopName, shopAddress: branch.address,
        branchName: branch.name, branchAddress: branch.address, branchPhone: branch.phone,
        subtotal: totals.subtotal, discountPct: totals.discountPct, discountAmount: totals.discountAmount, total: totals.total,
        paymentMethod: input.paymentMethod,
        cashReceived: input.paymentMethod === "cash" ? input.cashReceived : null,
        changeGiven: change, paymentRef: input.paymentRef, customerPhone: input.customerPhone,
        vatAmount: 0, chargesAmount: 0, charges: [],
        receiptFooter: shopDetails.receiptFooter, binVat: shopDetails.binVat,
        priceListName: priceLists.find((l) => l.id === listId)?.name ?? null,
        customerName: customer?.name ?? null,
        customerDiscountPct: customer?.discountPct ?? 0,
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
        aitPct: values.ait_pct !== undefined ? Number(values.ait_pct) || 0 : shopDetails.aitPct,
        poApprovalLimit: values.po_approval_limit !== undefined
          ? Number(values.po_approval_limit) || 0 : shopDetails.poApprovalLimit,
        cashShortLimit: values.cash_short_limit !== undefined
          ? Number(values.cash_short_limit) || 0 : shopDetails.cashShortLimit,
        returnDays: values.return_days !== undefined
          ? Number(values.return_days) || 0 : shopDetails.returnDays,
        saleApprovalLimit: values.sale_approval_limit !== undefined
          ? Number(values.sale_approval_limit) || 0 : shopDetails.saleApprovalLimit,
        approveAllSales: values.approve_all_sales !== undefined
          ? Boolean(values.approve_all_sales) : shopDetails.approveAllSales,
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

    // --- Products and prices ---

    async listPriceLists() { return structuredClone(priceLists); },

    async loadCatalogue(branchId: string, priceListId?: string | null): Promise<CatalogueRow[]> {
      branchOr404(branchId);
      const listId = priceListId ?? "pl-retail";
      // The demo person is an owner, so costs are included. A cashier in a real shop
      // gets rows with no cost key at all.
      const DEMO_COSTS: Record<string, number> = { a1: 250 };
      return catalogue.map((p) => {
        const pr = priceFor(p.id, listId);
        const cost = DEMO_COSTS[p.id];
        return {
          id: p.id, code: p.code, barcode: p.barcode, name: p.name, brand: p.brand,
          model: null, categoryId: p.categoryId,
          category: DEMO_CATEGORIES.find((c) => c.id === p.categoryId)?.name ?? null,
          unit: "pcs", specification: null,
          warrantyMonths: p.warrantyMonths, warrantyTerm: null,
          isSerial: p.isSerial, isInventory: true, active: true,
          reorderLevel: p.reorderLevel,
          price: pr.price, mrp: pr.mrp, minPrice: pr.min, maxPrice: pr.max,
          stock: p.isSerial
            ? serials.filter((s) => s.productId === p.id && s.branchId === branchId && !s.sold).length
            : (stock[branchId]?.[p.id] ?? 0),
          totalStock: p.isSerial
            ? serials.filter((s) => s.productId === p.id && !s.sold).length
            : Object.values(stock).reduce((n, byProduct) => n + (byProduct[p.id] ?? 0), 0),
          ...(staff.role === "cashier" ? {} : cost != null ? { cost, marginPct: Math.round(((pr.price - cost) / cost) * 1000) / 10 } : {}),
        };
      });
    },

    async upsertProduct(id, values) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:edit_settings");
      const v = values as Record<string, string | number | boolean | null>;
      if (id) {
        const p = catalogue.find((x) => x.id === id);
        if (!p) fail("PRODUCT_NOT_FOUND");
        Object.assign(p!, {
          name: (v.name as string)?.trim() || p!.name,
          code: (v.code as string)?.trim() || p!.code,
          brand: v.brand !== undefined ? (v.brand as string) : p!.brand,
          categoryId: v.category_id !== undefined ? (v.category_id as string) : p!.categoryId,
          warrantyMonths: v.warranty_months != null ? Number(v.warranty_months) : p!.warrantyMonths,
          reorderLevel: v.reorder_level != null ? Number(v.reorder_level) : p!.reorderLevel,
        });
        return;
      }
      if (!(v.name as string)?.trim()) fail("PRODUCT_NAME_REQUIRED");
      if (!(v.code as string)?.trim()) fail("PRODUCT_CODE_REQUIRED");
      const newId = crypto.randomUUID();
      catalogue.push({
        id: newId, categoryId: (v.category_id as string) ?? null,
        code: String(v.code).trim(), barcode: null, name: String(v.name).trim(),
        brand: (v.brand as string) ?? null, price: Number(v.price) || 0,
        warrantyMonths: Number(v.warranty_months) || 0, isSerial: false,
        reorderLevel: Number(v.reorder_level) || 0, serialNumbers: [],
      });
      for (const list of priceLists) prices[list.id][newId] = { price: Number(v.price) || 0, mrp: null, min: null, max: null };
      for (const b of branches) stock[b.id][newId] = 0;
    },

    async setPrices({ productId, priceListId, price, mrp, minPrice, maxPrice }) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:edit_settings");
      if (price < 0) fail("BAD_PRICE");
      if (minPrice != null && maxPrice != null && minPrice > maxPrice) fail("BAD_PRICE_BAND");
      if (!prices[priceListId]) fail("PRICE_LIST_NOT_FOUND");
      prices[priceListId][productId] = {
        price, mrp: mrp ?? null, min: minPrice ?? null, max: maxPrice ?? null,
      };
      if (priceLists.find((l) => l.id === priceListId)?.isDefault) {
        const p = catalogue.find((x) => x.id === productId);
        if (p) p.price = price;
      }
    },

    async bulkUpdatePrices({ productIds, priceListId, mode, value, dryRun }): Promise<BulkPriceChange[]> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:edit_settings");
      if (!["set", "percent", "amount"].includes(mode)) fail(`BAD_PRICE_MODE:${mode}`);
      if (productIds.length === 0) fail("NO_PRODUCTS_PICKED");
      const out: BulkPriceChange[] = [];
      for (const id of productIds) {
        const cur = priceFor(id, priceListId);
        const next = Math.max(
          mode === "set" ? value
            : mode === "percent" ? Math.round(cur.price * (100 + value)) / 100
            : cur.price + value,
          0,
        );
        out.push({ productId: id, name: catalogue.find((p) => p.id === id)?.name ?? "", from: cur.price, to: next });
        if (!dryRun) {
          prices[priceListId][id] = { ...cur, price: next };
          if (priceLists.find((l) => l.id === priceListId)?.isDefault) {
            const p = catalogue.find((x) => x.id === id);
            if (p) p.price = next;
          }
        }
      }
      return out;
    },

    async mergeCategories(fromId, intoId) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:edit_settings");
      if (fromId === intoId) fail("SAME_CATEGORY");
      let moved = 0;
      for (const p of catalogue) {
        if (p.categoryId === fromId) { p.categoryId = intoId; moved += 1; }
      }
      const i = DEMO_CATEGORIES.findIndex((c) => c.id === fromId);
      if (i >= 0) DEMO_CATEGORIES.splice(i, 1);
      return { productsMoved: moved };
    },

    async savePriceList(id, name, isDefault, active) {
      if (staff.role !== "owner") fail("NOT_OWNER");
      if (id) {
        const l = priceLists.find((x) => x.id === id);
        if (!l) fail("PRICE_LIST_NOT_FOUND");
        if (l!.isDefault && (isDefault === false || active === false)) fail("LAST_PRICE_LIST");
        l!.name = name.trim() || l!.name;
        if (isDefault) { for (const o of priceLists) o.isDefault = false; l!.isDefault = true; }
        if (active != null) l!.active = active;
        return;
      }
      if (!name.trim()) fail("PRICE_LIST_NAME_REQUIRED");
      const newId = crypto.randomUUID();
      if (isDefault) for (const o of priceLists) o.isDefault = false;
      priceLists.push({ id: newId, name: name.trim(), isDefault: Boolean(isDefault), active: true });
      prices[newId] = {};
      for (const p of catalogue) prices[newId][p.id] = { price: p.price, mrp: null, min: null, max: null };
    },

    // --- Import. Demo mode has no database, so an import reports what it would do
    // and changes nothing: a prospective buyer can walk the whole wizard safely. ---

    async existingKeys(kind: ImportKind) {
      if (kind === "customers") return new Set(customers.map((c) => c.phone));
      if (kind === "serials") return new Set(serials.map((s) => s.serial));
      if (kind === "suppliers") return new Set<string>();
      return new Set(catalogue.map((p) => p.code));
    },

    async loadImportMapping() { return importMapping; },
    async saveImportMapping(_kind: ImportKind, mapping: Record<string, string>) {
      importMapping = mapping;
    },

    async runImport({ kind, rows, dryRun }) {
      const keys = kind === "customers" ? new Set(customers.map((c) => c.phone))
        : kind === "serials" ? new Set(serials.map((s) => s.serial))
        : new Set(catalogue.map((p) => p.code));
      const keyOf = kind === "customers" ? "phone" : kind === "serials" ? "serial" : "code";
      let added = 0;
      let updated = 0;
      for (const r of rows) {
        if (keys.has(String(r[keyOf] ?? ""))) updated += 1; else added += 1;
      }
      // Always reported as if it were a dry run, because nothing is stored.
      void dryRun;
      return { added, updated, skipped: 0 };
    },

    // --- Suppliers and stock ---

    async listSuppliers() { return structuredClone(suppliers); },
    async listSupplierGroups() { return structuredClone(supplierGroups); },

    async saveSupplier(input) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:receive_stock");
      if (!input.name.trim()) fail("SUPPLIER_NAME_REQUIRED");
      if (input.id) {
        const sup = suppliers.find((x) => x.id === input.id);
        if (!sup) fail("SUPPLIER_NOT_FOUND");
        Object.assign(sup!, {
          name: input.name.trim(),
          phone: input.phone ?? sup!.phone,
          address: input.address ?? sup!.address,
          groupId: input.groupId ?? null,
          groupName: supplierGroups.find((g) => g.id === input.groupId)?.name ?? null,
          isCashOnly: input.isCashOnly ?? sup!.isCashOnly,
          note: input.note ?? sup!.note,
          active: input.active ?? sup!.active,
        });
        return;
      }
      suppliers.push({
        id: crypto.randomUUID(), name: input.name.trim(),
        phone: input.phone ?? null, address: input.address ?? null,
        groupId: input.groupId ?? null,
        groupName: supplierGroups.find((g) => g.id === input.groupId)?.name ?? null,
        isCashOnly: input.isCashOnly ?? false, note: input.note ?? null,
        active: true, balance: 0,
      });
    },

    async receiveGoods(input): Promise<ReceiveResult> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:receive_stock");
      const branch = branchOr404(input.branchId);
      if (input.lines.length === 0) fail("NOTHING_RECEIVED");
      const supplier = suppliers.find((x) => x.id === input.supplierId);
      if (input.isCredit && !supplier) fail("CREDIT_NEEDS_SUPPLIER");
      if (input.isCredit && supplier?.isCashOnly) fail("CASH_SUPPLIER_NO_CREDIT");

      let subtotal = 0;
      let costMissing = false;
      const out: ReceiveResult["lines"] = [];

      for (const l of input.lines) {
        const p = catalogue.find((x) => x.id === l.productId);
        if (!p) fail("PRODUCT_NOT_FOUND");
        const serialTexts = (l.serials ?? []).map((x) => x.trim()).filter((x) => x !== "");
        const qty = p!.isSerial ? serialTexts.length : l.qty;
        if (p!.isSerial && qty === 0) fail(`SERIAL_REQUIRED:${p!.name}`);
        if (qty <= 0) fail(`BAD_QTY:${p!.name}`);
        if (new Set(serialTexts).size !== serialTexts.length) fail(`DUPLICATE_SERIAL_IN_LINE:${p!.name}`);
        for (const t of serialTexts) {
          if (serials.some((x) => x.serial === t)) fail(`SERIAL_ALREADY_KNOWN:${t}`);
        }
        if (l.unitCost == null) costMissing = true;
        const lineTotal = Math.max((l.unitCost ?? 0) * qty - (l.lineDiscount ?? 0), 0);
        subtotal += lineTotal;

        if (p!.isSerial) {
          for (const t of serialTexts) {
            serials.push({ id: crypto.randomUUID(), serial: t, productId: p!.id, branchId: input.branchId, sold: false });
          }
        } else {
          stock[input.branchId][p!.id] = (stock[input.branchId][p!.id] ?? 0) + qty;
        }
        out.push({ name: p!.name, qty, unitCost: l.unitCost, landedCost: null, averageCost: null });
        noteMovement({
          at: new Date().toISOString(), product: p!.name, code: p!.code, change: qty,
          reason: "purchase", why: null, note: `Received on GRN-${branch.code}`, who: staff.name,
          location: branch.locations[0]?.name ?? null,
        });
      }

      // Spread the extra costs by value and move each average cost, the same way
      // receive_goods() does it.
      const spread = (input.extraCosts ?? 0) - (input.discount ?? 0);
      for (const [i, l] of input.lines.entries()) {
        const p = catalogue.find((x) => x.id === l.productId)!;
        const qty = p.isSerial ? (l.serials ?? []).filter((x) => x.trim() !== "").length : l.qty;
        const lineTotal = Math.max((l.unitCost ?? 0) * qty - (l.lineDiscount ?? 0), 0);
        if (l.unitCost == null) continue;
        const share = subtotal > 0 ? Math.round(((lineTotal / subtotal) * spread) * 100) / 100 : 0;
        const landed = Math.round(((lineTotal + share) / qty) * 100) / 100;
        out[i].landedCost = landed;

        const onHand = Object.values(stock).reduce((n, byP) => n + (byP[p.id] ?? 0), 0)
          + serials.filter((x) => x.productId === p.id && !x.sold).length - qty;
        const old = costs[p.id];
        const next = old == null || onHand <= 0
          ? landed
          : Math.round(((onHand * old + qty * landed) / (onHand + qty)) * 100) / 100;
        costs[p.id] = next;
        out[i].averageCost = next;
      }

      const total = Math.max(subtotal - (input.discount ?? 0), 0)
        + (input.extraCosts ?? 0) + (input.vat ?? 0) + (input.ait ?? 0);
      if (input.isCredit && supplier) supplier.balance += total;
      if (input.payAmount && supplier) supplier.balance -= input.payAmount;

      const grnNo = `GRN-${branch.code}-${new Date().getFullYear()}${String(grnCounter++).padStart(6, "0")}`;
      deliveries.unshift({
        id: crypto.randomUUID(), grnNo, supplierName: supplier?.name ?? null,
        supplierInvoiceNo: input.supplierInvoiceNo ?? null, isCredit: input.isCredit ?? false,
        total, costMissing, createdAt: new Date().toISOString(),
        lines: out.map((l) => ({
          id: crypto.randomUUID(), product: l.name, qty: l.qty,
          unitCost: l.unitCost, landedCost: l.landedCost,
        })),
      });

      return { grnNo, subtotal, total, costMissing, supplierDue: supplier?.balance ?? null, lines: out };
    },

    async amendGrnCost(grnItemId: string, unitCost: number) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:receive_stock");
      if (unitCost < 0) fail("BAD_COST");
      for (const d of deliveries) {
        const line = d.lines.find((l) => l.id === grnItemId);
        if (line) {
          line.unitCost = unitCost;
          line.landedCost = unitCost;
          d.costMissing = d.lines.some((l) => l.unitCost == null);
          return;
        }
      }
      fail("GRN_LINE_NOT_FOUND");
    },

    async listGoodsReceived() { return structuredClone(deliveries); },

    async returnToSupplier(input) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:adjust_stock");
      const branch = branchOr404(input.branchId);
      if (input.lines.length === 0) fail("NOTHING_RETURNED");
      const supplier = suppliers.find((x) => x.id === input.supplierId);
      let total = 0;
      for (const l of input.lines) {
        const p = catalogue.find((x) => x.id === l.productId);
        if (!p) fail("PRODUCT_NOT_FOUND");
        const ids = l.serialIds ?? [];
        const qty = p!.isSerial ? ids.length : l.qty;
        if (p!.isSerial && qty === 0) fail(`SERIAL_REQUIRED:${p!.name}`);
        if (p!.isSerial) {
          const picked = serials.filter((x) => ids.includes(x.id) && !x.sold && x.branchId === input.branchId);
          if (picked.length !== ids.length) fail(`SERIAL_NOT_AVAILABLE:${p!.name}`);
          for (const x of picked) x.sold = true;
        } else {
          if ((stock[input.branchId][p!.id] ?? 0) < qty) fail(`OUT_OF_STOCK:${p!.name}`);
          stock[input.branchId][p!.id] -= qty;
        }
        total += (costs[p!.id] ?? 0) * qty;
        noteMovement({
          at: new Date().toISOString(), product: p!.name, code: p!.code, change: -qty,
          reason: "return_to_supplier", why: null, note: input.reason ?? null,
          who: staff.name, location: branch.locations[0]?.name ?? null,
        });
      }
      if (supplier) supplier.balance -= total;
      return {
        returnNo: `RET-${branch.code}-${new Date().getFullYear()}000001`,
        total, supplierDue: supplier?.balance ?? null,
      };
    },

    async correctStock(input) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:adjust_stock");
      const branch = branchOr404(input.branchId);
      if (!["damaged", "lost", "found_in_count", "internal_use", "expired", "other"].includes(input.reason)) {
        fail(`BAD_STOCK_REASON:${input.reason}`);
      }
      if (input.reason === "other" && !input.note?.trim()) fail("REASON_NOTE_REQUIRED");
      if (input.change === 0) fail("NOTHING_TO_CORRECT");
      const p = catalogue.find((x) => x.id === input.productId);
      if (!p) fail("PRODUCT_NOT_FOUND");
      if (p!.isSerial && (input.serials ?? []).length !== Math.abs(input.change)) {
        fail(`SERIAL_COUNT_MISMATCH:${p!.name}`);
      }
      const now = stock[input.branchId][p!.id] ?? 0;
      if (!p!.isSerial) {
        if (now + input.change < 0) fail(`WOULD_GO_NEGATIVE:${p!.name}`);
        stock[input.branchId][p!.id] = now + input.change;
      } else if (input.change < 0) {
        for (const id of input.serials ?? []) {
          const sx = serials.find((x) => x.id === id && !x.sold);
          if (!sx) fail(`SERIAL_NOT_AVAILABLE:${p!.name}`);
          sx!.sold = true;
        }
      } else {
        for (const t of input.serials ?? []) {
          if (serials.some((x) => x.serial === t)) fail(`SERIAL_ALREADY_KNOWN:${t}`);
          serials.push({ id: crypto.randomUUID(), serial: t, productId: p!.id, branchId: input.branchId, sold: false });
        }
      }
      noteMovement({
        at: new Date().toISOString(), product: p!.name, code: p!.code, change: input.change,
        reason: input.change > 0 ? "adjust_in" : "adjust_out", why: input.reason,
        note: input.note ?? null, who: staff.name, location: branch.locations[0]?.name ?? null,
      });
    },

    async applyStockCount(input) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:adjust_stock");
      const branch = branchOr404(input.branchId);
      const differences: CountDifference[] = [];
      let alreadyRight = 0;
      for (const c of input.counted) {
        const p = catalogue.find((x) => x.id === c.productId);
        if (!p || p.isSerial) continue;
        const expected = stock[input.branchId][p.id] ?? 0;
        if (expected === c.counted) { alreadyRight += 1; continue; }
        differences.push({ productId: p.id, name: p.name, expected, counted: c.counted, change: c.counted - expected });
        if (!input.dryRun) {
          stock[input.branchId][p.id] = c.counted;
          noteMovement({
            at: new Date().toISOString(), product: p.name, code: p.code,
            change: c.counted - expected, reason: "count",
            why: c.counted > expected ? "found_in_count" : "lost",
            note: input.note ?? "Stock count", who: staff.name,
            location: branch.locations[0]?.name ?? null,
          });
        }
      }
      return { corrected: differences.length, alreadyRight, differences };
    },

    async stockHistory(_branchId: string, productId?: string | null, limit = 100) {
      const name = productId ? catalogue.find((p) => p.id === productId)?.name : null;
      return structuredClone(
        movements.filter((m) => !name || m.product === name).slice(0, limit),
      );
    },

    async setDocumentNextNumber(branchId, docType, next) {
      const b = branches.find((x) => x.id === branchId);
      if (!b) fail("BRANCH_NOT_FOUND");
      if (docType === "invoice") {
        if (next < b!.nextInvoice) fail(`NUMBER_GOES_BACKWARDS:${b!.nextInvoice}`);
        b!.nextInvoice = next;
      }
    },

    // --- Purchase paperwork and supplier dues (P6) ---

    async listRequisitions(_branchId, limit = 50) {
      return structuredClone(requisitions.slice(0, limit));
    },

    async saveRequisition(input) {
      if (!features.purchase_orders) fail("FEATURE_OFF:purchase_orders");
      const branch = branchOr404(input.branchId);
      if (input.lines.length === 0) fail("NOTHING_REQUESTED");

      const lines = input.lines.map((l) => {
        const p = catalogue.find((x) => x.id === l.productId);
        if (!p) fail("PRODUCT_NOT_FOUND");
        return { id: crypto.randomUUID(), productId: p!.id, product: p!.name, qty: l.qty, note: l.note ?? null };
      });

      if (input.id) {
        const r = requisitions.find((x) => x.id === input.id);
        if (!r) fail("REQUISITION_NOT_FOUND");
        if (!["draft", "submitted"].includes(r!.status)) fail(`REQUISITION_LOCKED:${r!.status}`);
        r!.lines = lines;
        r!.neededBy = input.neededBy ?? r!.neededBy;
        r!.note = input.note ?? r!.note;
        if (input.submit) r!.status = "submitted";
        return { id: r!.id, reqNo: r!.reqNo, status: r!.status };
      }

      const reqNo = `REQ-${branch.code}-${new Date().getFullYear()}${String(reqCounter++).padStart(6, "0")}`;
      const row: RequisitionRow = {
        id: crypto.randomUUID(), reqNo, status: input.submit ? "submitted" : "draft",
        neededBy: input.neededBy ?? null, note: input.note ?? null,
        askedBy: staff.name, decidedBy: null, decisionNote: null,
        createdAt: new Date().toISOString(), lines,
      };
      requisitions.unshift(row);
      return { id: row.id, reqNo, status: row.status };
    },

    async decideRequisition(reqId, approve, note) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:approve");
      const r = requisitions.find((x) => x.id === reqId);
      if (!r) fail("REQUISITION_NOT_FOUND");
      if (r!.status !== "submitted") fail(`REQUISITION_NOT_SUBMITTED:${r!.status}`);
      // In the demo the one signed-in owner asks and decides, so self-approval can't be
      // blocked the way the database blocks it. The database is the rule that counts.
      r!.status = approve ? "approved" : "rejected";
      r!.decidedBy = staff.name;
      r!.decisionNote = note ?? null;
      return { reqNo: r!.reqNo, status: r!.status };
    },

    async listPurchaseOrders(_branchId, limit = 50) {
      return structuredClone(purchaseOrders.slice(0, limit));
    },

    async savePurchaseOrder(input) {
      if (!features.purchase_orders) fail("FEATURE_OFF:purchase_orders");
      if (staff.role === "cashier") fail("NOT_ALLOWED:receive_stock");
      const branch = branchOr404(input.branchId);
      if (input.lines.length === 0) fail("NOTHING_ORDERED");
      const supplier = suppliers.find((x) => x.id === input.supplierId);
      if (!supplier) fail("SUPPLIER_NOT_FOUND");

      let subtotal = 0;
      const lines = input.lines.map((l) => {
        const p = catalogue.find((x) => x.id === l.productId);
        if (!p) fail("PRODUCT_NOT_FOUND");
        if (l.qty <= 0) fail(`BAD_QTY:${p!.name}`);
        subtotal += Math.max(l.unitPrice * l.qty - (l.lineDiscount ?? 0), 0);
        return {
          id: crypto.randomUUID(), productId: p!.id, product: p!.name, code: p!.code,
          qty: l.qty, unitPrice: l.unitPrice, lineDiscount: l.lineDiscount ?? 0, receivedQty: 0,
        };
      });
      const total = Math.max(subtotal - (input.discount ?? 0), 0)
        + (input.charges ?? 0) + (input.vat ?? 0);

      const existing = input.id ? purchaseOrders.find((x) => x.id === input.id) : null;
      if (input.id && !existing) fail("PO_NOT_FOUND");
      if (existing && ["sent", "partly_received", "received", "closed", "cancelled"].includes(existing.status)) {
        fail(`PO_LOCKED:${existing.status}`);
      }
      const limit = shopDetails.poApprovalLimit;
      const status: PurchaseOrderStatus =
        limit > 0 && total > limit && staff.role !== "owner" ? "awaiting_approval" : "draft";

      if (existing) {
        Object.assign(existing, {
          branchId: branch.id, supplierId: supplier!.id, supplierName: supplier!.name, lines,
          paymentTermsDays: input.termsDays ?? 0, discount: input.discount ?? 0,
          charges: input.charges ?? 0, vat: input.vat ?? 0, subtotal, total,
          note: input.note ?? null, status,
        });
        return { id: existing.id, poNo: existing.poNo, subtotal, total, status, needsApproval: status === "awaiting_approval" };
      }

      const poNo = `PO-${branch.code}-${new Date().getFullYear()}${String(poCounter++).padStart(6, "0")}`;
      const row: PurchaseOrderRow = {
        id: crypto.randomUUID(), poNo, status, branchId: branch.id, supplierId: supplier!.id,
        supplierName: supplier!.name, paymentTermsDays: input.termsDays ?? 0,
        discount: input.discount ?? 0, charges: input.charges ?? 0, vat: input.vat ?? 0,
        subtotal, total, note: input.note ?? null, cancelReason: null,
        createdAt: new Date().toISOString(), lines,
      };
      purchaseOrders.unshift(row);
      for (const id of input.reqIds ?? []) {
        const r = requisitions.find((x) => x.id === id);
        if (r && r.status === "approved") r.status = "ordered";
      }
      return { id: row.id, poNo, subtotal, total, status, needsApproval: status === "awaiting_approval" };
    },

    async setPoStatus(poId, action, reason) {
      const po = purchaseOrders.find((x) => x.id === poId);
      if (!po) fail("PO_NOT_FOUND");
      if (action === "approve") {
        if (staff.role !== "owner") fail("NOT_OWNER");
        if (po!.status !== "awaiting_approval") fail(`PO_NOT_AWAITING:${po!.status}`);
        po!.status = "sent";
      } else if (action === "send") {
        if (staff.role === "cashier") fail("NOT_ALLOWED:receive_stock");
        if (po!.status !== "draft") fail(`PO_NOT_DRAFT:${po!.status}`);
        po!.status = "sent";
      } else if (action === "cancel") {
        if (staff.role === "cashier") fail("NOT_ALLOWED:receive_stock");
        if (["received", "closed", "cancelled"].includes(po!.status)) fail(`PO_ALREADY_FINISHED:${po!.status}`);
        if (po!.lines.some((l) => l.receivedQty > 0)) fail("PO_PARTLY_RECEIVED");
        if (!reason?.trim()) fail("CANCEL_REASON_REQUIRED");
        po!.status = "cancelled";
        po!.cancelReason = reason ?? null;
      } else if (action === "close") {
        if (staff.role === "cashier") fail("NOT_ALLOWED:receive_stock");
        po!.status = "closed";
      } else {
        fail(`BAD_PO_ACTION:${action}`);
      }
      return { poNo: po!.poNo, status: po!.status };
    },

    async receiveAgainstPo(input): Promise<PoReceiveResult> {
      const po = purchaseOrders.find((x) => x.id === input.poId);
      if (!po) fail("PO_NOT_FOUND");
      if (!["sent", "partly_received"].includes(po!.status)) fail(`PO_NOT_RECEIVABLE:${po!.status}`);
      if (input.lines.length === 0) fail("NOTHING_RECEIVED");

      const picked = input.lines.map((l) => {
        const line = po!.lines.find((x) => x.id === l.poItemId);
        if (!line) fail("PO_LINE_NOT_FOUND");
        const qty = (l.serials ?? []).length > 0 ? l.serials!.length : l.qty;
        if (line!.receivedQty + qty > line!.qty) fail(`MORE_THAN_ORDERED:${line!.product}`);
        return { line: line!, qty, serials: l.serials ?? [], unitCost: l.unitCost ?? line!.unitPrice };
      });

      // The goods go in through the one receiving path, as receive_against_po() does.
      const res = await api.receiveGoods({
        branchId: po!.branchId,
        lines: picked.map((x) => ({
          productId: x.line.productId, qty: x.qty, unitCost: x.unitCost, serials: x.serials,
        })),
        supplierId: po!.supplierId,
        supplierInvoiceNo: input.supplierInvoiceNo ?? null,
        invoiceDate: input.invoiceDate ?? null,
        isCredit: input.isCredit ?? true,
        note: input.note ?? null,
        payAmount: input.payAmount ?? null,
        payMethod: input.payMethod ?? null,
        payReference: input.payReference ?? null,
      });

      for (const x of picked) x.line.receivedQty += x.qty;
      const anyLeft = po!.lines.some((l) => l.receivedQty < l.qty);
      po!.status = anyLeft ? "partly_received" : "received";
      (ledgers[po!.supplierId] ??= []).push({
        at: new Date().toISOString(), kind: "purchase", document: res.grnNo,
        change: res.total, note: input.supplierInvoiceNo ?? null,
      });

      return {
        ...res, poNo: po!.poNo, poStatus: po!.status,
        pending: po!.lines.map((l) => ({
          product: l.product, ordered: l.qty, received: l.receivedQty,
          pending: l.qty - l.receivedQty,
        })),
      };
    },

    async reorderSuggestions(branchId, days = 30) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      branchOr404(branchId);
      return productsAt(branchId)
        .filter((p) => p.stock <= p.reorderLevel)
        .map((p) => {
          // The demo has no sales history to measure, so the rate is zero and
          // "days left" is blank rather than a made-up figure.
          const sold = movements
            .filter((m) => m.product === p.name && m.reason === "sale")
            .reduce((n, m) => n - m.change, 0);
          return {
            productId: p.id, name: p.name, code: p.code, stock: p.stock,
            reorderLevel: p.reorderLevel, soldInPeriod: sold,
            perDay: Math.round((sold / Math.max(days, 1)) * 100) / 100,
            daysLeft: sold > 0 ? Math.round((p.stock / (sold / Math.max(days, 1))) * 10) / 10 : null,
            suggestQty: Math.max(p.reorderLevel * 2 - p.stock, 1),
            lastCost: costs[p.id] ?? null,
          };
        });
    },

    async supplierLedger(supplierId) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      if (!suppliers.some((x) => x.id === supplierId)) fail("SUPPLIER_NOT_FOUND");
      return structuredClone((ledgers[supplierId] ?? []).slice().sort((a, b) => a.at.localeCompare(b.at)));
    },

    async supplierAging(supplierId) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      const sup = suppliers.find((x) => x.id === supplierId);
      if (!sup) fail("SUPPLIER_NOT_FOUND");
      return agingFrom(ledgers[supplierId] ?? [], sup!.balance);
    },

    async paySupplier(input) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:receive_stock");
      branchOr404(input.branchId);
      const sup = suppliers.find((x) => x.id === input.supplierId);
      if (!sup) fail("SUPPLIER_NOT_FOUND");
      if (sup!.isCashOnly) fail("CASH_SUPPLIER_NO_CREDIT");
      if (!input.amount || input.amount <= 0) fail("BAD_PAYMENT_AMOUNT");
      if (!input.method) fail("PAYMENT_METHOD_REQUIRED");
      sup!.balance -= input.amount;
      (ledgers[sup!.id] ??= []).push({
        at: new Date().toISOString(), kind: "payment", document: input.method,
        change: -input.amount, note: input.reference ?? null,
      });
      return {
        supplier: sup!.name, amount: input.amount, balance: sup!.balance,
        aging: agingFrom(ledgers[sup!.id], sup!.balance),
      };
    },

    async setOpeningBalance(input) {
      if (staff.role !== "owner") fail("NOT_OWNER");
      const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
      if (asOf > new Date().toISOString().slice(0, 10)) fail("OPENING_DATE_IN_FUTURE");
      if (input.partyKind === "supplier") {
        const sup = suppliers.find((x) => x.id === input.partyId);
        if (!sup) fail("SUPPLIER_NOT_FOUND");
        const entries = (ledgers[sup!.id] ??= []);
        const already = entries.find((e) => e.kind === "opening");
        if (already) { already.change = input.amount; already.at = asOf; already.note = input.note ?? null; }
        else entries.push({ at: asOf, kind: "opening", document: "Opening balance", change: input.amount, note: input.note ?? null });
        return { name: sup!.name, amount: input.amount, asOf };
      }
      fail("CUSTOMER_NOT_FOUND");
      return { name: "", amount: 0, asOf };
    },

    // --- Sales history, void and returns (P9) ---

    async saleHistory(input): Promise<SaleRow[]> {
      // A cashier gets their own sales, today, at their own branch. Narrowed here, not
      // asked for by the screen — the database narrows it the same way.
      const mine = staff.role === "cashier";
      const today = dhakaToday();
      const q = (input.query ?? "").trim().toLowerCase();
      return sales
        .filter((s) => (mine ? s.staffId === staff.id : true))
        .filter((s) => (mine ? s.createdAt.slice(0, 10) === today : true))
        .filter((s) => (input.branchId ? s.branchId === input.branchId : true))
        .filter((s) => (input.staffId && !mine ? s.staffId === input.staffId : true))
        .filter((s) => (input.method ? s.paymentMethod === input.method : true))
        .filter((s) => (input.status ? s.status === input.status : true))
        .filter((s) => (input.from ? s.createdAt.slice(0, 10) >= input.from : true))
        .filter((s) => (input.to ? s.createdAt.slice(0, 10) <= input.to : true))
        .filter((s) => !q
          || s.invoiceNo.toLowerCase().includes(q)
          || (s.customerPhone ?? "").includes(q)
          || s.items.some((i) => i.name.toLowerCase().includes(q))
          || s.items.some((i) => i.serials.some((x) => x.serial.toLowerCase().includes(q))))
        .slice(0, input.limit ?? 50)
        .map((s) => ({
          id: s.id, invoiceNo: s.invoiceNo, createdAt: s.createdAt, branch: s.branch,
          branchId: s.branchId, staff: s.staff, total: s.total,
          discountAmount: s.discountAmount, paymentMethod: s.paymentMethod,
          status: s.status, approvalStatus: s.approvalStatus,
          customerPhone: s.customerPhone, customerName: s.customerName,
          itemCount: s.items.reduce((n, i) => n + i.qty, 0),
          summary: s.items.map((i) => i.name).join(", "),
          returned: s.items.reduce((n, i) => n + i.returnedQty, 0),
        }));
    },

    async saleDetail(saleId) {
      const sale = sales.find((s) => s.id === saleId);
      if (!sale) fail("SALE_NOT_FOUND");
      if (staff.role === "cashier" && sale!.staffId !== staff.id) fail("NOT_YOUR_SALE");
      const today = dhakaToday();
      const daysOld = Math.max(
        0,
        Math.floor((new Date(today).getTime() - new Date(sale!.createdAt.slice(0, 10)).getTime())
          / 86_400_000));
      // The demo's own bookkeeping (who rang it up, which drawer, which serial ids are
      // on which line) is not part of SaleDetail, so it is rebuilt rather than spread.
      return structuredClone({
        id: sale!.id, invoiceNo: sale!.invoiceNo, createdAt: sale!.createdAt,
        branch: sale!.branch, branchId: sale!.branchId,
        branchAddress: sale!.branchAddress, branchPhone: sale!.branchPhone,
        shopName: sale!.shopName, receiptFooter: sale!.receiptFooter,
        binVat: sale!.binVat, staff: sale!.staff,
        subtotal: sale!.subtotal, discountPct: sale!.discountPct,
        discountAmount: sale!.discountAmount, vatAmount: sale!.vatAmount,
        chargesAmount: sale!.chargesAmount, total: sale!.total,
        paymentMethod: sale!.paymentMethod, cashReceived: sale!.cashReceived,
        changeGiven: sale!.changeGiven, paymentRef: sale!.paymentRef,
        status: sale!.status, approvalStatus: sale!.approvalStatus,
        voidReason: sale!.voidReason, refundMethod: sale!.refundMethod,
        customerPhone: sale!.customerPhone, customerName: sale!.customerName,
        items: sale!.items, returns: sale!.returns,
        sameDay: sale!.createdAt.slice(0, 10) === today,
        daysOld,
        returnDays: shopDetails.returnDays,
      });
    },

    async voidSale(input) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:void_sale");
      if (!input.reason.trim()) fail("VOID_REASON_REQUIRED");
      const sale = sales.find((s) => s.id === input.saleId);
      if (!sale) fail("SALE_NOT_FOUND");
      if (sale!.status === "void") fail("SALE_ALREADY_VOID");
      if (sale!.createdAt.slice(0, 10) !== dhakaToday()) fail("VOID_TOO_LATE");
      if (sale!.items.some((i) => i.returnedQty > 0)) fail("SALE_PARTLY_RETURNED");

      for (const line of sale!.items) {
        if (line.isSerial) {
          for (const id of sale!.lineSerialIds[line.id] ?? []) {
            const sx = serials.find((x) => x.id === id);
            if (sx) { sx.sold = false; sx.branchId = sale!.branchId; }
          }
        } else {
          stock[sale!.branchId][line.productId] =
            (stock[sale!.branchId][line.productId] ?? 0) + line.qty;
        }
        noteMovement({
          at: new Date().toISOString(), product: line.name,
          code: catalogue.find((p) => p.id === line.productId)?.code ?? "",
          change: line.qty, reason: "return", why: null,
          note: `${sale!.invoiceNo}: sale voided`, who: staff.name, location: null,
        });
      }

      sale!.status = "void";
      sale!.voidReason = input.reason;
      sale!.refundMethod = input.refundMethod ?? null;
      return { invoiceNo: sale!.invoiceNo, status: "void", refunded: sale!.total };
    },

    async returnSale(input): Promise<ReturnResult> {
      // Same check the database makes: a per-person override can let one cashier take
      // returns without making them a manager.
      const mayReturn = staffPermissions.find(
        (x) => x.staffId === staff.id && x.perm === "return_sale")?.allowed
        ?? rolePermissions.find((r) => r.role === staff.role && r.perm === "return_sale")?.allowed
        ?? false;
      if (!mayReturn) fail("NOT_ALLOWED:return_sale");
      const branch = branchOr404(input.branchId);
      if (input.lines.length === 0) fail("NOTHING_RETURNED");
      const methods = ["cash", "bkash", "nagad", "card", "store_credit", "reduce_due"];
      if (!methods.includes(input.refundMethod)) fail(`BAD_REFUND_METHOD:${input.refundMethod}`);
      const sale = sales.find((s) => s.id === input.saleId);
      if (!sale) fail("SALE_NOT_FOUND");
      if (sale!.status === "void") fail("SALE_IS_VOID");

      let subtotal = 0;
      const out: ReturnResult["lines"] = [];
      for (const l of input.lines) {
        const line = sale!.items.find((x) => x.id === l.saleItemId);
        if (!line) fail("SALE_LINE_NOT_FOUND");
        const ids = l.serialIds ?? [];
        const qty = line!.isSerial ? ids.length : (l.qty ?? 0);
        if (line!.isSerial && qty === 0) fail(`SERIAL_REQUIRED:${line!.name}`);
        if (qty <= 0) fail(`BAD_QTY:${line!.name}`);
        if (line!.returnedQty + qty > line!.qty) fail(`MORE_THAN_SOLD:${line!.name}`);

        const onThis = new Set(sale!.lineSerialIds[line!.id] ?? []);
        for (const id of ids) {
          if (!onThis.has(id)) fail(`SERIAL_NOT_ON_THIS_SALE:${line!.name}`);
        }

        const refund = refundFor(
          { qty: line!.qty, lineTotal: line!.lineTotal,
            vatAmount: line!.vatAmount, vatInclusive: line!.vatInclusive },
          qty, sale!.discountPct);
        subtotal += refund;

        // A faulty unit comes back but never reaches a shelf: it is in RMA, waiting to
        // go to the supplier.
        for (const id of ids) {
          const sx = serials.find((x) => x.id === id);
          if (!sx) continue;
          if (l.isFaulty) { sx.sold = true; }
          else { sx.sold = false; sx.branchId = branch.id; }
        }
        if (!l.isFaulty && !line!.isSerial) {
          stock[branch.id][line!.productId] = (stock[branch.id][line!.productId] ?? 0) + qty;
        }
        line!.returnedQty += qty;
        for (const id of ids) {
          const st = line!.serials.find((x) => x.id === id);
          if (st) st.status = l.isFaulty ? "rma" : "in_stock";
        }

        noteMovement({
          at: new Date().toISOString(), product: line!.name,
          code: catalogue.find((p) => p.id === line!.productId)?.code ?? "",
          change: l.isFaulty ? 0 : qty, reason: "return",
          why: l.isFaulty ? "damaged" : null,
          note: `Against ${sale!.invoiceNo}${l.isFaulty ? " (faulty, sent to RMA)" : ""}`,
          who: staff.name, location: branch.locations[0]?.name ?? null,
        });
        out.push({ name: line!.name, qty, refund, faulty: Boolean(l.isFaulty) });
      }

      // Extra charges come back only when the whole sale does.
      const allBack = sale!.items.every((i) => i.returnedQty >= i.qty);
      const chargesBack = allBack ? sale!.chargesAmount : 0;
      const total = subtotal + chargesBack;

      if (input.refundMethod === "store_credit" && !sale!.customerPhone) {
        fail("CREDIT_NEEDS_CUSTOMER");
      }

      const returnNo = `RET-${branch.code}-${new Date().getFullYear()}${String(returnCounter++).padStart(6, "0")}`;
      sale!.returns.push({
        id: crypto.randomUUID(), returnNo, createdAt: new Date().toISOString(),
        branch: branch.name, total, reason: input.reason ?? null,
        refundMethod: input.refundMethod, approvalStatus: "approved",
      });

      // A cash refund comes out of the drawer it was paid from.
      if (input.refundMethod === "cash") {
        const open = shifts.find(
          (sh) => sh.branchId === branch.id && sh.staffId === staff.id && !sh.closedAt);
        if (open) open.cashOut += total;
      }

      return {
        returnNo, total, subtotal, vatAmount: 0, chargesBack,
        refundMethod: input.refundMethod, lines: out, wholeSaleReturned: allBack,
      };
    },

    async setSaleApproval(kind, id, action, reason) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:approve");
      if (!["approve", "cancel"].includes(action)) fail(`BAD_APPROVAL_ACTION:${action}`);
      if (action === "cancel" && !reason?.trim()) fail("CANCEL_REASON_REQUIRED");
      if (kind === "sale") {
        const sale = sales.find((s) => s.id === id);
        if (!sale) fail("SALE_NOT_FOUND");
        if (sale!.approvalStatus !== "awaiting_approval") {
          fail(`NOT_AWAITING_APPROVAL:${sale!.approvalStatus}`);
        }
        sale!.approvalStatus = action === "approve" ? "approved" : "cancelled";
        return { number: sale!.invoiceNo, approvalStatus: sale!.approvalStatus };
      }
      const owner = sales.find((s) => s.returns.some((r) => r.id === id));
      const ret = owner?.returns.find((r) => r.id === id);
      if (!ret) fail("SALE_NOT_FOUND");
      if (ret!.approvalStatus !== "awaiting_approval") {
        fail(`NOT_AWAITING_APPROVAL:${ret!.approvalStatus}`);
      }
      ret!.approvalStatus = action === "approve" ? "approved" : "cancelled";
      return { number: ret!.returnNo, approvalStatus: ret!.approvalStatus };
    },

    // --- Shifts and the cash check (P8) ---

    async currentShift(branchId) {
      branchOr404(branchId);
      const mine = shifts.find(
        (s) => s.branchId === branchId && s.staffId === staff.id && !s.closedAt);
      const lastClosed = shifts
        .filter((s) => s.branchId === branchId && s.closedAt)
        .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))[0];
      return {
        open: Boolean(mine),
        shiftId: mine?.id ?? null,
        openedAt: mine?.openedAt ?? null,
        openingCash: mine?.openingCash ?? null,
        lastClose: lastClosed?.countedCash ?? null,
        maySellWithoutShift: staff.role === "owner",
      };
    },

    async openShift(branchId, openingCash) {
      branchOr404(branchId);
      if (openingCash < 0) fail("BAD_CASH_AMOUNT");
      if (shifts.some((s) => s.branchId === branchId && s.staffId === staff.id && !s.closedAt)) {
        fail("SHIFT_ALREADY_OPEN");
      }
      const row = {
        id: crypto.randomUUID(), branchId, staffId: staff.id, staff: staff.name,
        openedAt: new Date().toISOString(), closedAt: null,
        openingCash, expectedCash: openingCash, countedCash: null, difference: null,
        overLimit: false, note: null, noteCounts: null, salesCount: 0,
        byMethod: {} as Record<string, number>, cashIn: 0, cashOut: 0,
        movements: [] as CashMovementRow[],
      };
      shifts.unshift(row);
      return { shiftId: row.id, openingCash };
    },

    async cashMovement(input) {
      branchOr404(input.branchId);
      if (!["in", "out"].includes(input.direction)) fail(`BAD_CASH_DIRECTION:${input.direction}`);
      if (!(input.amount > 0)) fail("BAD_CASH_AMOUNT");
      const reasons = ["expense", "owner_took", "owner_put_in", "bought_change", "bank_deposit", "other"];
      if (!reasons.includes(input.reason)) fail(`BAD_CASH_REASON:${input.reason}`);
      if (input.reason === "expense" && !input.categoryId) fail("EXPENSE_CATEGORY_REQUIRED");
      if (input.reason === "other" && !input.note?.trim()) fail("REASON_NOTE_REQUIRED");
      const category = input.categoryId
        ? (lists.transaction_categories.find((c) => c.id === input.categoryId)?.name as string | undefined) ?? null
        : null;
      if (input.categoryId && !category) fail("CATEGORY_NOT_FOUND");

      const open = shifts.find(
        (s) => s.branchId === input.branchId && s.staffId === staff.id && !s.closedAt);
      // A movement with no drawer open still happened; it just belongs to no shift,
      // the same way the database records it.
      if (!open) return;
      open.movements.push({
        at: new Date().toISOString(), direction: input.direction, amount: input.amount,
        reason: input.reason, category, note: input.note ?? null, who: staff.name,
      });
      if (input.direction === "in") open.cashIn += input.amount;
      else open.cashOut += input.amount;
    },

    async closeShift(input) {
      const sh = shifts.find((s) => s.id === input.shiftId);
      if (!sh) fail("SHIFT_NOT_FOUND");
      if (sh!.closedAt) fail("SHIFT_ALREADY_CLOSED");
      if (input.countedCash < 0) fail("BAD_CASH_AMOUNT");

      const expected = sh!.openingCash + (sh!.byMethod.cash ?? 0) + sh!.cashIn - sh!.cashOut;
      const difference = input.countedCash - expected;
      sh!.closedAt = new Date().toISOString();
      sh!.expectedCash = expected;
      sh!.countedCash = input.countedCash;
      sh!.difference = difference;
      sh!.overLimit = Math.abs(difference) > shopDetails.cashShortLimit;
      sh!.noteCounts = input.noteCounts ?? null;
      sh!.note = [sh!.note, input.note].filter(Boolean).join(" · ") || null;

      // A cashier is told it is closed and no more: see the note at the top of the P8
      // migration for why the expected figure is withheld.
      if (staff.role === "cashier") return { closed: true };
      return {
        closed: true, expected, counted: input.countedCash, difference,
        overLimit: sh!.overLimit,
      };
    },

    async listShifts(branchId, limit = 30) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      branchOr404(branchId);
      // branchId and staffId are the demo's own bookkeeping; ShiftRow does not carry
      // them, and the real backend's shift_list() does not return them either.
      return shifts
        .filter((s) => s.branchId === branchId)
        .slice(0, limit)
        .map((s) => structuredClone({
          id: s.id, staff: s.staff, openedAt: s.openedAt, closedAt: s.closedAt,
          openingCash: s.openingCash, expectedCash: s.expectedCash,
          countedCash: s.countedCash, difference: s.difference, overLimit: s.overLimit,
          note: s.note, noteCounts: s.noteCounts, salesCount: s.salesCount,
          byMethod: s.byMethod, cashIn: s.cashIn, cashOut: s.cashOut,
          movements: s.movements,
        }));
    },

    async listExpenseCategories() {
      // The real column is text[]; a SettingRow holds scalars, so the demo keeps the
      // same list as comma-separated text and splits it here.
      return lists.transaction_categories
        .filter((c) => c.active !== false
          && String(c.applies_to ?? "").split(",").map((x) => x.trim()).includes("expense"))
        .map((c) => ({ id: c.id, name: String(c.name) }));
    },

    // --- Branch transfers (P7) ---

    async listTransfers(branchId, limit = 50) {
      return structuredClone(
        transfers.filter((t) => t.fromBranchId === branchId || t.toBranchId === branchId)
          .slice(0, limit));
    },

    async listTransferRequests(branchId, limit = 50) {
      return structuredClone(
        transferRequests.filter((r) => r.fromBranchId === branchId || r.toBranchId === branchId)
          .slice(0, limit));
    },

    async saveTransferRequest(input) {
      if (!features.transfers) fail("FEATURE_OFF:transfers");
      // You ask FOR your own branch, so that is the one you must be allowed to work in.
      const asking = branchOr404(input.toBranchId);
      const asked = branches.find((b) => b.id === input.fromBranchId && b.active);
      if (!asked) fail("BRANCH_NOT_FOUND");
      if (!canTransfer(asked!.id, asking.id)) fail("TRANSFER_NOT_ALLOWED");
      if (input.lines.length === 0) fail("NOTHING_REQUESTED");

      const lines = input.lines.map((l) => {
        const p = catalogue.find((x) => x.id === l.productId);
        if (!p) fail("PRODUCT_NOT_FOUND");
        return { id: crypto.randomUUID(), productId: p!.id, product: p!.name, qty: l.qty };
      });
      const reqNo = `TRQ-${asking.code}-${new Date().getFullYear()}${String(trqCounter++).padStart(6, "0")}`;
      const row: TransferRequestRow = {
        id: crypto.randomUUID(), reqNo, status: "submitted",
        fromBranchId: asked!.id, fromBranchName: asked!.name,
        toBranchId: asking.id, toBranchName: asking.name,
        note: input.note ?? null, decisionNote: null, askedBy: staff.name,
        createdAt: new Date().toISOString(), lines,
      };
      transferRequests.unshift(row);
      return { id: row.id, reqNo, status: row.status };
    },

    async decideTransferRequest(requestId, approve, note) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:transfer_stock");
      const r = transferRequests.find((x) => x.id === requestId);
      if (!r) fail("REQUEST_NOT_FOUND");
      if (r!.status !== "submitted") fail(`REQUEST_ALREADY_DECIDED:${r!.status}`);
      // The branch that has to hand the goods over is the one that decides.
      branchOr404(r!.fromBranchId);
      r!.status = approve ? "approved" : "rejected";
      r!.decisionNote = note ?? null;
      return { reqNo: r!.reqNo, status: r!.status };
    },

    async inTransit(branchId) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      return transfers
        .filter((t) => ["in_transit", "disputed"].includes(t.status))
        .filter((t) => !branchId || t.fromBranchId === branchId || t.toBranchId === branchId)
        .map((t) => ({
          id: t.id, transferNo: t.transferNo, status: t.status,
          fromBranch: t.fromBranchName, toBranch: t.toBranchName,
          sentAt: t.sentAt,
          daysOut: Math.floor((Date.now() - new Date(t.sentAt).getTime()) / 86_400_000),
          totalCost: t.totalCost,
          items: t.lines.map((l) => ({
            product: l.product, qty: l.qty, received: l.receivedQty,
          })),
        }));
    },

    async sendTransfer(input): Promise<TransferSent> {
      if (!features.transfers) fail("FEATURE_OFF:transfers");
      if (staff.role === "cashier") fail("NOT_ALLOWED:transfer_stock");
      const from = branchOr404(input.fromBranchId);
      const to = branchOr404(input.toBranchId);
      if (from.id === to.id) fail("SAME_BRANCH");
      if (!canTransfer(from.id, to.id)) fail("TRANSFER_NOT_ALLOWED");
      if (input.lines.length === 0) fail("NOTHING_TO_SEND");

      let totalCost = 0;
      const lines: TransferLine[] = [];
      const out: TransferSent["lines"] = [];

      for (const l of input.lines) {
        const p = catalogue.find((x) => x.id === l.productId);
        if (!p) fail("PRODUCT_NOT_FOUND");
        const ids = l.serialIds ?? [];
        const qty = p!.isSerial ? ids.length : l.qty;
        if (p!.isSerial && qty === 0) fail(`SERIAL_REQUIRED:${p!.name}`);
        if (qty <= 0) fail(`BAD_QTY:${p!.name}`);

        const picked = p!.isSerial
          ? serials.filter((x) => ids.includes(x.id) && !x.sold
              && x.branchId === from.id && !x.inTransit)
          : [];
        if (p!.isSerial && picked.length !== ids.length) fail(`SERIAL_NOT_AVAILABLE:${p!.name}`);
        if (!p!.isSerial && (stock[from.id]?.[p!.id] ?? 0) < qty) fail(`OUT_OF_STOCK:${p!.name}`);

        // Off the sender's shelf straight away, and nowhere else until it arrives.
        // A serial product's stock IS its serial count here, so marking the serials is
        // the whole move; touching the quantity as well would take it off twice.
        if (p!.isSerial) for (const x of picked) x.inTransit = true;
        else stock[from.id][p!.id] -= qty;

        const cost = costs[p!.id] ?? null;
        totalCost += (cost ?? 0) * qty;
        lines.push({
          id: crypto.randomUUID(), productId: p!.id, product: p!.name, code: p!.code,
          isSerial: p!.isSerial, qty, receivedQty: 0, damagedQty: 0, unitCost: cost,
          note: null,
          serials: picked.map((x) => ({ id: x.id, serial: x.serial, arrivedOk: null })),
        });
        out.push({ product: p!.name, qty, unitCost: cost });
        noteMovement({
          at: new Date().toISOString(), product: p!.name, code: p!.code, change: -qty,
          reason: "transfer_out", why: null, note: `To ${to.name}`, who: staff.name,
          location: from.locations[0]?.name ?? null,
        });
      }

      const transferNo = `TRA-${from.code}-${new Date().getFullYear()}${String(trCounter++).padStart(6, "0")}`;
      transfers.unshift({
        id: crypto.randomUUID(), transferNo, status: "in_transit",
        fromBranchId: from.id, fromBranchName: from.name,
        toBranchId: to.id, toBranchName: to.name,
        note: input.note ?? null, sentAt: new Date().toISOString(),
        receivedAt: null, resolution: null, totalCost, lines,
      });
      if (input.requestId) {
        const r = transferRequests.find((x) => x.id === input.requestId);
        if (r && r.status === "approved") r.status = "sent";
      }
      return { id: transfers[0].id, transferNo, totalCost, lines: out };
    },

    async receiveTransfer(input): Promise<TransferReceived> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:transfer_stock");
      const t = transfers.find((x) => x.id === input.transferId);
      if (!t) fail("TRANSFER_NOT_FOUND");
      if (t!.status !== "in_transit") fail(`TRANSFER_NOT_IN_TRANSIT:${t!.status}`);
      if (input.lines.length === 0) fail("NOTHING_RECEIVED");

      const to = branchOr404(t!.toBranchId);
      let anyShort = false;
      const out: TransferReceived["lines"] = [];

      for (const l of input.lines) {
        const line = t!.lines.find((x) => x.id === l.itemId);
        if (!line) fail("TRANSFER_LINE_NOT_FOUND");
        const okIds = l.serialsOk ?? [];
        const badIds = l.serialsDamaged ?? [];
        const ok = line!.isSerial ? okIds.length : (l.okQty ?? 0);
        const damaged = line!.isSerial ? badIds.length : (l.damagedQty ?? 0);
        if (ok < 0 || damaged < 0) fail(`BAD_QTY:${line!.product}`);
        if (ok + damaged > line!.qty) fail(`MORE_THAN_SENT:${line!.product}`);
        const short = line!.qty - ok - damaged;
        if (short > 0) anyShort = true;

        const onThis = new Set(line!.serials.map((x) => x.id));
        for (const id of [...okIds, ...badIds]) {
          if (!onThis.has(id)) fail(`SERIAL_NOT_ON_THIS_TRANSFER:${line!.product}`);
        }
        for (const id of okIds) {
          const sx = serials.find((x) => x.id === id);
          if (sx) { sx.inTransit = false; sx.branchId = to.id; }
          const row = line!.serials.find((x) => x.id === id);
          if (row) row.arrivedOk = true;
        }
        // A damaged unit arrived, and is recorded as arrived, but it never reaches a
        // shelf: it is marked sold-out-of-stock here the way a write-off is.
        for (const id of badIds) {
          const sx = serials.find((x) => x.id === id);
          if (sx) { sx.inTransit = false; sx.sold = true; }
          const row = line!.serials.find((x) => x.id === id);
          if (row) row.arrivedOk = false;
        }

        if (ok > 0) {
          if (!line!.isSerial) {
            stock[to.id][line!.productId] = (stock[to.id][line!.productId] ?? 0) + ok;
          }
          noteMovement({
            at: new Date().toISOString(), product: line!.product, code: line!.code,
            change: ok, reason: "transfer_in", why: null,
            note: `From ${t!.fromBranchName}`, who: staff.name,
            location: to.locations[0]?.name ?? null,
          });
        }
        if (damaged > 0) {
          noteMovement({
            at: new Date().toISOString(), product: line!.product, code: line!.code,
            change: 0, reason: "adjust_out", why: "damaged",
            note: `${t!.transferNo}: arrived damaged`, who: staff.name,
            location: to.locations[0]?.name ?? null,
          });
        }

        line!.receivedQty = ok + damaged;
        line!.damagedQty = damaged;
        line!.note = l.note ?? line!.note;
        out.push({ product: line!.product, sent: line!.qty, ok, damaged, short });
      }

      t!.status = anyShort ? "disputed" : "received";
      t!.receivedAt = new Date().toISOString();
      if (input.note) t!.note = [t!.note, input.note].filter(Boolean).join(" · ");
      return { transferNo: t!.transferNo, status: t!.status, lines: out };
    },

    async resolveTransfer(transferId, action, note) {
      if (staff.role === "cashier") fail("NOT_MANAGER");
      if (!["returned", "written_off"].includes(action)) fail(`BAD_RESOLUTION:${action}`);
      if (!note.trim()) fail("RESOLUTION_NOTE_REQUIRED");
      const t = transfers.find((x) => x.id === transferId);
      if (!t) fail("TRANSFER_NOT_FOUND");
      if (t!.status !== "disputed") fail(`TRANSFER_NOT_DISPUTED:${t!.status}`);

      let costOfShortage = 0;
      for (const line of t!.lines) {
        const short = line.qty - line.receivedQty;
        if (short <= 0) continue;
        costOfShortage += (line.unitCost ?? 0) * short;
        if (action === "returned") {
          if (!line.isSerial) {
            stock[t!.fromBranchId][line.productId] =
              (stock[t!.fromBranchId][line.productId] ?? 0) + short;
          }
          for (const sr of line.serials.filter((x) => x.arrivedOk == null)) {
            const sx = serials.find((x) => x.id === sr.id);
            if (sx) { sx.inTransit = false; sx.branchId = t!.fromBranchId; }
          }
          noteMovement({
            at: new Date().toISOString(), product: line.product, code: line.code,
            change: short, reason: "transfer_in", why: null,
            note: `${t!.transferNo}: came back`, who: staff.name, location: null,
          });
        } else {
          // The stock already left the shelf when it was sent, so this records the
          // loss without taking it off a second time.
          for (const sr of line.serials.filter((x) => x.arrivedOk == null)) {
            const sx = serials.find((x) => x.id === sr.id);
            if (sx) { sx.inTransit = false; sx.sold = true; }
          }
          noteMovement({
            at: new Date().toISOString(), product: line.product, code: line.code,
            change: 0, reason: "adjust_out", why: "lost",
            note: `${t!.transferNo}: lost in transit`, who: staff.name, location: null,
          });
        }
      }
      t!.status = "received";
      t!.resolution = action;
      t!.note = [t!.note, note].filter(Boolean).join(" · ");
      return { transferNo: t!.transferNo, resolution: action, costOfShortage };
    },

    async cancelTransfer(transferId, reason) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:transfer_stock");
      if (!reason.trim()) fail("CANCEL_REASON_REQUIRED");
      const t = transfers.find((x) => x.id === transferId);
      if (!t) fail("TRANSFER_NOT_FOUND");
      if (t!.status !== "in_transit") fail(`TRANSFER_NOT_IN_TRANSIT:${t!.status}`);
      for (const line of t!.lines) {
        if (!line.isSerial) {
          stock[t!.fromBranchId][line.productId] =
            (stock[t!.fromBranchId][line.productId] ?? 0) + line.qty;
        }
        for (const sr of line.serials) {
          const sx = serials.find((x) => x.id === sr.id);
          if (sx) { sx.inTransit = false; sx.branchId = t!.fromBranchId; }
        }
      }
      t!.status = "cancelled";
      t!.note = [t!.note, reason].filter(Boolean).join(" · ");
    },

    async moveWithinBranch(input) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:transfer_stock");
      const branch = branchOr404(input.branchId);
      if (input.fromLocationId === input.toLocationId) fail("SAME_LOCATION");
      const names = new Map(branch.locations.map((l) => [l.id, l.name]));
      if (!names.has(input.fromLocationId) || !names.has(input.toLocationId)) {
        fail("LOCATION_NOT_FOUND");
      }
      if (input.lines.length === 0) fail("NOTHING_TO_SEND");
      const moved: { product: string; qty: number }[] = [];
      for (const l of input.lines) {
        const p = catalogue.find((x) => x.id === l.productId);
        if (!p) fail("PRODUCT_NOT_FOUND");
        const qty = p!.isSerial ? (l.serialIds ?? []).length : l.qty;
        if (p!.isSerial && qty === 0) fail(`SERIAL_REQUIRED:${p!.name}`);
        if (qty <= 0) fail(`BAD_QTY:${p!.name}`);
        if (!p!.isSerial && (stock[branch.id]?.[p!.id] ?? 0) < qty) fail(`OUT_OF_STOCK:${p!.name}`);
        // The demo keeps one figure per branch, not per location, so the branch total
        // is unchanged — which is the whole point of moving inside one building.
        moved.push({ product: p!.name, qty });
        noteMovement({
          at: new Date().toISOString(), product: p!.name, code: p!.code, change: 0,
          reason: "transfer_in", why: null,
          note: `Moved from ${names.get(input.fromLocationId)} to ${names.get(input.toLocationId)}`,
          who: staff.name, location: names.get(input.toLocationId) ?? null,
        });
      }
      return { lines: moved };
    },

    async listTransferRoutes() { return structuredClone(routes); },

    async saveTransferRoute(fromBranchId, toBranchId, allowed) {
      if (staff.role !== "owner") fail("NOT_OWNER");
      if (fromBranchId === toBranchId) fail("SAME_BRANCH");
      const at = routes.findIndex(
        (r) => r.fromBranchId === fromBranchId && r.toBranchId === toBranchId);
      if (allowed && at === -1) routes.push({ fromBranchId, toBranchId });
      if (!allowed && at !== -1) routes.splice(at, 1);
    },
  };

  return api;
}

/** An ISO timestamp n days back, for the demo's pre-existing supplier history. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/**
 * The aging buckets, worked out the way supplier_aging() does it: what was bought on
 * credit goes into a bucket by age, and payments and returns come off the OLDEST first.
 */
function agingFrom(entries: LedgerEntry[], balance: number): SupplierAging {
  let paid = 0;
  const buckets = [0, 0, 0];
  for (const e of entries) {
    if (e.change < 0) { paid += -e.change; continue; }
    const age = Math.floor((Date.now() - new Date(e.at).getTime()) / 86_400_000);
    buckets[age <= 30 ? 0 : age <= 60 ? 1 : 2] += e.change;
  }
  for (let i = 2; i >= 0; i -= 1) {
    const take = Math.min(paid, buckets[i]);
    paid -= take;
    buckets[i] -= take;
  }
  return {
    days0to30: Math.max(buckets[0], 0), days31to60: Math.max(buckets[1], 0),
    days60plus: Math.max(buckets[2], 0), total: balance, unapplied: Math.max(paid, 0),
  };
}
