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
  CustomerAging, CustomerGroup, CustomerRow, CustomerStatement, DueRow, PaymentReceipt,
  StatementEntry, EmiPlan, PriceHelp, SaleField,
  ClaimRow, ClaimStatus, ProblemType, SupplierRmaRow, Technician, WarrantyHit,
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
    cardChargeMode: "absorb" as "absorb" | "add", claimApproval: false,
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
    // The shop's own extra fields on a sale (P10a).
    sale_fields: [row({ name: "PO number", show_on_invoice: true })],
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

  const customerGroups: CustomerGroup[] = [
    { id: "cg-retail", name: "Retail", priceListId: "pl-retail", discountPct: 0,
      creditAllowed: false, creditLimit: 0, paymentDays: 0, active: true },
    { id: "cg-dealer", name: "Dealer", priceListId: "pl-dealer", discountPct: 0,
      creditAllowed: true, creditLimit: 25000, paymentDays: 15, active: true },
    { id: "cg-corporate", name: "Corporate", priceListId: "pl-retail", discountPct: 0,
      creditAllowed: true, creditLimit: 50000, paymentDays: 30, active: true },
  ];
  // The customer list, with the credit terms a shop actually sets (P10).
  const customers: (CustomerRow & { openingBalance: number; openingAt: string | null })[] = [
    { id: "c-dealer", phone: "01811000000", name: "Karim Traders",
      company: "Karim Traders", address: "Elephant Road, Dhaka",
      groupId: "cg-dealer", group: "Dealer",
      priceListId: "pl-dealer", priceList: "Dealer", discountPct: 0,
      binVat: null, nid: null, note: null, active: true,
      districtId: null, upazilaId: null,
      creditAllowed: true, creditLimit: 25000, paymentDays: 15,
      owed: 0, totalSpent: 0, openingBalance: 0, openingAt: null },
    { id: "c-regular", phone: "01911000000", name: "Regular Rahim",
      company: null, address: null, groupId: "cg-retail", group: "Retail",
      priceListId: "pl-retail", priceList: "Retail", discountPct: 8,
      binVat: null, nid: null, note: null, active: true,
      districtId: null, upazilaId: null,
      creditAllowed: false, creditLimit: 0, paymentDays: 0,
      owed: 0, totalSpent: 0, openingBalance: 0, openingAt: null },
    { id: "c-corp", phone: "01611000000", name: "Shopno Enterprise",
      company: "Shopno Enterprise Ltd", address: "Motijheel, Dhaka",
      groupId: "cg-corporate", group: "Corporate",
      priceListId: "pl-retail", priceList: "Retail", discountPct: 0,
      binVat: "004123456-0101", nid: null,
      note: "Pays by cheque at month end.", active: true,
      districtId: null, upazilaId: null,
      creditAllowed: true, creditLimit: 50000, paymentDays: 30,
      owed: 0, totalSpent: 0, openingBalance: 0, openingAt: null },
  ];
  const customerPayments: {
    id: string; customerId: string; receiptNo: string; amount: number; method: string;
    reference: string | null; branchId: string; shiftId: string | null; at: string;
  }[] = [];
  let receiptCounter = 1;
  // The full counter (P10a): the bank's EMI plans and the shop's own extra fields.
  const emiPlans: EmiPlan[] = [
    { id: "emi-12", bank: "City Bank", months: 12, chargePct: 4, minAmount: 10000, active: true },
    { id: "emi-24", bank: "City Bank", months: 24, chargePct: 8, minAmount: 25000, active: true },
  ];
  // Which categories the shop allows EMI on. Laptops only, as a shop would set it.
  const emiCategories = new Set<string>(["c5"]);
  // Warranty claims (P11). The faults a computer shop actually sees.
  const problemTypes: ProblemType[] = [
    "Not switching on", "Screen fault", "Keyboard fault", "Battery not holding",
    "Overheating", "No sound", "Port or socket damaged", "Not detected",
    "Physical damage", "Other",
  ].map((name) => ({ id: `pt-${name.toLowerCase().replace(/\W+/g, "-")}`, name, active: true }));
  const technicians: Technician[] = [
    { id: "tech-1", name: "Shakil (in-house)", phone: "01700-000009", staffId: null, active: true },
  ];
  const claims: (ClaimRow & { shopSerialId: string | null })[] = [];
  const manualWarranties: {
    serial: string; item: string; phone: string | null; name: string | null;
    soldOn: string | null; until: string | null; note: string | null;
  }[] = [];
  let claimCounter = 1;

  /**
   * Mirrors customer_aging(): what is owed, by age, with collections applied OLDEST
   * FIRST. `overdue` is measured against the days THIS customer was given, which is a
   * different question from "older than 60 days".
   */
  const agingForCustomer = (customerId: string): CustomerAging => {
    const c = customers.find((x) => x.id === customerId);
    const days = c?.paymentDays ?? 0;
    const today = Date.now();
    const rows: { amount: number; age: number }[] = [];
    if (c && c.openingBalance > 0) {
      rows.push({
        amount: c.openingBalance,
        age: c.openingAt
          ? Math.floor((today - new Date(c.openingAt).getTime()) / 86_400_000) : 0,
      });
    }
    for (const s of sales) {
      if (s.customerId !== customerId || s.status !== "completed" || s.dueAmount <= 0) continue;
      rows.push({
        amount: s.dueAmount,
        age: Math.floor((today - new Date(s.createdAt).getTime()) / 86_400_000),
      });
    }
    let paid = customerPayments
      .filter((p) => p.customerId === customerId)
      .reduce((n, p) => n + p.amount, 0)
      + sales.flatMap((s) => s.customerId === customerId ? s.returns : [])
        .filter((r) => ["reduce_due", "store_credit"].includes(r.refundMethod))
        .reduce((n, r) => n + r.total, 0);

    const buckets = [0, 0, 0];
    for (const r of rows) buckets[r.age <= 30 ? 0 : r.age <= 60 ? 1 : 2] += r.amount;
    for (let i = 2; i >= 0; i -= 1) {
      const take = Math.min(paid, buckets[i]);
      paid -= take;
      buckets[i] -= take;
    }
    const owed = dueFor(customerId);
    const overdue = rows.filter((r) => r.age > days).reduce((n, r) => n + r.amount, 0);
    return {
      days0to30: Math.max(buckets[0], 0), days31to60: Math.max(buckets[1], 0),
      days60plus: Math.max(buckets[2], 0), total: owed, paymentDays: days,
      overdue: Math.max(Math.min(overdue, Math.max(owed, 0)), 0),
      inCredit: Math.max(paid, 0),
    };
  };

  /** Mirrors customer_due(): worked out from the documents, never stored. */
  const dueFor = (customerId: string): number => {
    const c = customers.find((x) => x.id === customerId);
    if (!c) return 0;
    const onSales = sales
      .filter((s) => s.customerId === customerId && s.status === "completed")
      .reduce((n, s) => n + s.dueAmount, 0);
    const paid = customerPayments
      .filter((p) => p.customerId === customerId)
      .reduce((n, p) => n + p.amount, 0);
    const offDue = sales
      .flatMap((s) => s.returns.map((r) => ({ r, s })))
      .filter(({ r, s }) => s.customerId === customerId
        && ["reduce_due", "store_credit"].includes(r.refundMethod)
        && r.approvalStatus !== "cancelled")
      .reduce((n, { r }) => n + r.total, 0);
    return c.openingBalance + onSales - paid - offDue;
  };

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
    staffId: string; shiftId: string | null; customerId: string | null;
    paidAmount: number; dueAmount: number;
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
    async findCustomer(phone: string): Promise<CustomerLookup | null> {
      const c = customers.find((x) => x.phone === phone);
      if (!c) return null;
      const group = customerGroups.find((g) => g.id === c.groupId);
      // The customer's own list wins; failing that the group's, as in customer_by_phone().
      const listId = c.priceListId ?? group?.priceListId ?? null;
      const owed = dueFor(c.id);
      return {
        id: c.id, phone: c.phone, name: c.name,
        priceListId: listId,
        priceListName: priceLists.find((l) => l.id === listId)?.name ?? null,
        discountPct: Math.max(c.discountPct, group?.discountPct ?? 0),
        group: group?.name ?? null,
        creditAllowed: c.creditAllowed,
        creditLimit: c.creditLimit,
        paymentDays: c.paymentDays,
        owed,
        creditLeft: c.creditLimit > 0 ? Math.max(c.creditLimit - owed, 0) : null,
      };
    },
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
      // Everything the advanced counter adds (P10a), with the same rules the database
      // applies: EMI only where the owner allows it and the bank runs it, the card
      // charge only when the shop passes it on, and an exchange never worth more than
      // the sale.
      const x = input.extras ?? {};
      let cardCharge = 0;
      let emiCharge = 0;
      let exchangeValue = 0;
      const cardType = x.card?.typeId
        ? lists.card_types.find((c) => c.id === x.card!.typeId) ?? null
        : null;
      if (x.card?.typeId && !cardType) fail("CARD_TYPE_NOT_FOUND");
      for (const name of Object.keys(x.extraFields ?? {})) {
        if (!lists.sale_fields.some((f) => f.name === name && f.active !== false)) {
          fail(`UNKNOWN_SALE_FIELD:${name}`);
        }
      }
      if (cardType && shopDetails.cardChargeMode === "add") {
        cardCharge = roundTaka((totals.total * Number(cardType.charge_pct ?? 0)) / 100);
      }
      if (x.emi?.months) {
        const plan = emiPlans.find(
          (e) => e.active && e.months === x.emi!.months
            && (!x.emi!.bank || e.bank === x.emi!.bank));
        if (!plan) fail(`NO_EMI_PLAN:${x.emi.months}`);
        for (const line of input.lines) {
          const prod = catalogue.find((c) => c.id === line.productId);
          if (!emiCategories.has(prod?.categoryId ?? "")) {
            fail(`EMI_NOT_ALLOWED:${prod?.name ?? "this item"}`);
          }
        }
        if (totals.total < plan!.minAmount) fail(`EMI_BELOW_MINIMUM:${plan!.minAmount}`);
        emiCharge = roundTaka((totals.total * plan!.chargePct) / 100);
      }
      if (x.exchange && x.exchange.value != null) {
        if (!x.exchange.description?.trim()) fail("EXCHANGE_NEEDS_DESCRIPTION");
        exchangeValue = Math.max(x.exchange.value, 0);
      }
      const grandTotal = totals.total + cardCharge + emiCharge;
      if (exchangeValue > grandTotal) fail(`EXCHANGE_OVER_TOTAL:${grandTotal}`);
      const payable = grandTotal - exchangeValue;

      // Paying now, paying later, or some of each (P10). 'due' is the whole total on the
      // slate; dueAmount splits it. Same rules as complete_sale().
      let onDue = Math.max(input.dueAmount ?? 0, 0);
      if (input.paymentMethod === "due") onDue = payable;
      if (onDue > payable) fail("DUE_MORE_THAN_TOTAL");
      const paidNow = roundTaka(payable - onDue);

      if (onDue > 0) {
        if (!features.credit_sales) fail("FEATURE_OFF:credit_sales");
        if (!customer) fail("DUE_NEEDS_CUSTOMER");
        const buyer = customer!;
        if (!buyer.creditAllowed) fail(`CUSTOMER_HAS_NO_CREDIT:${buyer.name ?? buyer.phone}`);
        // The limit is on what they will owe AFTER this sale, not on this sale alone.
        const owed = dueFor(buyer.id);
        const limit = buyer.creditLimit ?? 0;
        if (limit > 0 && owed + onDue > limit && !input.approvalId) {
          fail(`OVER_CREDIT_LIMIT:${Math.max(limit - owed, 0)}`);
        }
      }

      // A split has to add up to what is being paid now, to the taka: off by one and
      // the drawer is wrong at closing time and nobody knows why.
      const splits = x.payments ?? [];
      if (splits.length > 0) {
        const sum = splits.reduce((n, sp) => n + sp.amount, 0);
        if (roundTaka(sum) !== roundTaka(paidNow)) fail(`SPLIT_DOES_NOT_ADD_UP:${paidNow}`);
      }

      // What is handed over now is checked against the PAID part, not the total. With a
      // split, the cash part is whatever the breakdown says.
      const cashPart = splits.length > 0
        ? splits.filter((sp) => sp.method === "cash").reduce((n, sp) => n + sp.amount, 0)
        : paidNow;
      if (splits.length > 0) {
        if (input.cashReceived != null && input.cashReceived > 0) {
          if (input.cashReceived < cashPart) fail("CASH_SHORT");
          change = roundTaka(input.cashReceived - cashPart);
        }
      } else if (input.paymentMethod === "cash") {
        if (input.cashReceived == null || input.cashReceived < paidNow) fail("CASH_SHORT");
        change = roundTaka((input.cashReceived ?? 0) - paidNow);
      } else if (paidNow > 0 && (!input.paymentRef || input.paymentRef.trim().length < 4)) {
        fail("PAYMENT_REF_REQUIRED");
      }
      if (input.customerPhone && !isValidPhone(input.customerPhone)) fail("BAD_PHONE");

      // Nothing can fail from here, so commit the changes.
      for (const s of serials) if (soldSerialIds.includes(s.id)) s.sold = true;
      for (const [productId, qty] of Object.entries(stockTaken)) {
        stock[input.branchId][productId] = (stock[input.branchId][productId] ?? 0) - qty;
      }

      // The old item, when the shop wants to resell it. Same rule as the database: it
      // needs a product to be booked in as, and a serial if that product is tracked.
      if (x.exchange?.addToStock) {
        if (!x.exchange.productId) fail("EXCHANGE_NEEDS_PRODUCT");
        const used = catalogue.find((c) => c.id === x.exchange!.productId);
        if (!used) fail("PRODUCT_NOT_FOUND");
        if (used!.isSerial) {
          const sn = (x.exchange.serial ?? "").trim();
          if (!sn) fail(`SERIAL_REQUIRED:${used!.name}`);
          if (serials.some((y) => y.serial === sn)) fail(`SERIAL_ALREADY_KNOWN:${sn}`);
          serials.push({
            id: crypto.randomUUID(), serial: sn, productId: used!.id,
            branchId: input.branchId, sold: false,
          });
        } else {
          stock[input.branchId][used!.id] = (stock[input.branchId][used!.id] ?? 0) + 1;
        }
        costs[used!.id] = exchangeValue;
        noteMovement({
          at: new Date().toISOString(), product: used!.name, code: used!.code, change: 1,
          reason: "purchase", why: null, note: "Taken in exchange", who: staff.name,
          location: branch.locations[0]?.name ?? null,
        });
      }

      // The drawer this was rung up on gains what the customer handed over, less the
      // change: for a cash sale that is the total, which is what the till can be
      // checked against at closing time.
      if (openShift) {
        openShift.salesCount += 1;
        // With a split, each method gets its own share; otherwise the whole paid part
        // went in by the one method chosen.
        if (splits.length > 0) {
          for (const sp of splits) {
            openShift.byMethod[sp.method] = (openShift.byMethod[sp.method] ?? 0) + sp.amount;
          }
        } else if (paidNow > 0) {
          openShift.byMethod[input.paymentMethod] =
            (openShift.byMethod[input.paymentMethod] ?? 0) + paidNow;
        }
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
        total: payable, paymentMethod: input.paymentMethod,
        cashReceived: input.paymentMethod === "cash" ? input.cashReceived ?? null : null,
        changeGiven: change, paymentRef: input.paymentRef ?? null,
        status: "completed",
        approvalStatus: overLimit ? "awaiting_approval" : "approved",
        voidReason: null, refundMethod: null,
        customerPhone: input.customerPhone ?? null, customerName: customer?.name ?? null,
        customerId: customer?.id ?? null,
        paidAmount: paidNow, dueAmount: onDue,
        sameDay: true, daysOld: 0, returnDays: shopDetails.returnDays,
        items: detailLines, returns: [],
        lineSerialIds: Object.fromEntries(
          detailLines.map((l) => [l.id, l.serials.map((x) => x.id)])),
      });

      return {
        id: saleId, invoiceNo, createdAt,
        staffName: staff.name, shopName: staff.shopName, shopAddress: branch.address,
        branchName: branch.name, branchAddress: branch.address, branchPhone: branch.phone,
        subtotal: totals.subtotal, discountPct: totals.discountPct,
        discountAmount: totals.discountAmount, total: payable,
        paymentMethod: input.paymentMethod,
        cashReceived: input.paymentMethod === "cash" ? input.cashReceived : null,
        changeGiven: change, paymentRef: input.paymentRef, customerPhone: input.customerPhone,
        paidAmount: paidNow, dueAmount: onDue,
        customerOwes: customer ? dueFor(customer.id) : null,
        cardCharge, emiCharge, exchangeValue,
        emiMonths: x.emi?.months ?? null,
        emiBank: x.emi?.bank ?? null,
        cardType: (cardType?.name as string | undefined) ?? null,
        cardLast4: x.card?.last4 ?? null,
        attention: x.attention ?? null,
        customerBin: x.customerBin ?? null,
        narration: x.narration ?? null,
        soldBy: x.soldBy
          ? team.find((m) => m.id === x.soldBy)?.name ?? staff.name
          : staff.name,
        extraFields: x.extraFields ?? null,
        exchange: exchangeValue > 0 || x.exchange?.description
          ? { description: x.exchange!.description, serial: x.exchange!.serial ?? null,
              value: exchangeValue }
          : null,
        payments: splits.map((sp) => ({
          method: sp.method, amount: sp.amount, reference: sp.reference ?? null,
        })),
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
        cardChargeMode: values.card_charge_mode !== undefined
          ? (values.card_charge_mode as "absorb" | "add") : shopDetails.cardChargeMode,
        claimApproval: values.claim_approval !== undefined
          ? Boolean(values.claim_approval) : shopDetails.claimApproval,
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

    // --- Warranty lookup and claims (P11) ---

    async warrantyLookup(query: string): Promise<WarrantyHit[]> {
      const q = (query ?? "").trim();
      if (!q) fail("NOTHING_TO_LOOK_UP");
      const up = q.toUpperCase();
      const out: WarrantyHit[] = [];

      for (const sale of sales) {
        for (const line of sale.items) {
          const matchBySerial = line.serials.some((x) => x.serial.toUpperCase().startsWith(up));
          const match = matchBySerial
            || sale.invoiceNo.toUpperCase() === up
            || sale.customerPhone === q;
          if (!match) continue;
          for (const sn of line.serials.length > 0 ? line.serials : [null]) {
            out.push({
              kind: "sold",
              serialId: sn?.id ?? null, serial: sn?.serial ?? null,
              serialStatus: sn?.status ?? null,
              productId: line.productId, product: line.name,
              saleId: sale.id, saleItemId: line.id, invoiceNo: sale.invoiceNo,
              soldOn: sale.createdAt.slice(0, 10),
              branch: sale.branch, soldBy: sale.staff,
              customerId: sale.customerId, customerPhone: sale.customerPhone,
              customerName: sale.customerName,
              warrantyMonths: null, warrantyUntil: line.warrantyUntil,
              warrantyText: null,
              inWarranty: line.warrantyUntil != null && line.warrantyUntil >= dhakaToday(),
              daysLeft: line.warrantyUntil
                ? Math.round((new Date(line.warrantyUntil).getTime()
                    - new Date(dhakaToday()).getTime()) / 86_400_000)
                : null,
              saleStatus: sale.status,
              openClaim: claims.find(
                (c) => c.serialId === (sn?.id ?? "") && c.open)?.claimNo ?? null,
            });
          }
        }
      }

      // A swap unit left through a claim, not a till, so it has no sale line of its own.
      for (const c of claims) {
        if (c.status !== "delivered" || !c.replacementSerial) continue;
        if (!(c.replacementSerial.toUpperCase().startsWith(up)
              || c.claimNo.toUpperCase() === up || c.customerPhone === q)) continue;
        const sn = serials.find((x) => x.serial === c.replacementSerial);
        out.push({
          kind: "replacement",
          serialId: sn?.id ?? null, serial: c.replacementSerial,
          serialStatus: sn?.sold ? "sold" : "in_stock",
          productId: sn?.productId ?? null,
          product: catalogue.find((p) => p.id === sn?.productId)?.name ?? null,
          saleId: null, saleItemId: null, invoiceNo: null,
          soldOn: c.deliveredAt?.slice(0, 10) ?? null,
          branch: c.branch, soldBy: c.takenInBy,
          customerId: null, customerPhone: c.customerPhone, customerName: c.customerName,
          warrantyMonths: null,
          // What was LEFT of the original cover, carried across by the claim.
          warrantyUntil: c.warrantyUntil,
          warrantyText: `Replaced under claim ${c.claimNo}, carrying the remaining warranty of ${c.serial ?? "the original"}`,
          inWarranty: c.warrantyUntil != null && c.warrantyUntil >= dhakaToday(),
          daysLeft: c.warrantyUntil
            ? Math.round((new Date(c.warrantyUntil).getTime()
                - new Date(dhakaToday()).getTime()) / 86_400_000)
            : null,
          saleStatus: "completed", openClaim: null,
        });
      }

      for (const m of manualWarranties) {
        if (!(m.serial.toUpperCase().startsWith(up) || m.phone === q)) continue;
        out.push({
          kind: "manual",
          serialId: null, serial: m.serial, serialStatus: null,
          productId: null, product: m.item,
          saleId: null, saleItemId: null, invoiceNo: null,
          soldOn: m.soldOn, branch: null, soldBy: null,
          customerId: null, customerPhone: m.phone, customerName: m.name,
          warrantyMonths: null, warrantyUntil: m.until, warrantyText: m.note,
          inWarranty: m.until != null && m.until >= dhakaToday(),
          daysLeft: m.until
            ? Math.round((new Date(m.until).getTime() - new Date(dhakaToday()).getTime()) / 86_400_000)
            : null,
          saleStatus: null, openClaim: null,
        });
      }

      return out;
    },

    async saveManualWarranty(values) {
      // A promise the shop is making, so a manager makes it.
      if (staff.role === "cashier") fail("NOT_MANAGER");
      const serial = String(values.serial ?? "").trim();
      if (!serial) fail("SERIAL_REQUIRED:this item");
      const item = String(values.item_text ?? "").trim()
        || catalogue.find((p) => p.id === values.product_id)?.name
        || "";
      if (!item) fail("ITEM_REQUIRED");
      const row = {
        serial, item,
        phone: (values.customer_phone as string | null) ?? null,
        name: (values.customer_name as string | null) ?? null,
        soldOn: (values.sold_on as string | null) ?? null,
        until: (values.warranty_until as string | null) ?? null,
        note: (values.note as string | null) ?? null,
      };
      const at = manualWarranties.findIndex((m) => m.serial === serial);
      if (at === -1) manualWarranties.push(row); else manualWarranties[at] = row;
    },

    async openClaim(input) {
      const branch = branchOr404(input.branchId);
      if (!input.problem?.trim()) fail("PROBLEM_REQUIRED");
      if (!input.serialId && !input.productId && !input.itemText?.trim()) fail("ITEM_REQUIRED");

      let warrantyUntil: string | null = null;
      let customerPhone = input.customerPhone ?? null;
      let customerName = input.customerName ?? null;
      const sn = input.serialId ? serials.find((x) => x.id === input.serialId) : null;

      if (input.serialId) {
        if (claims.some((c) => c.serialId === input.serialId && c.open)) fail("CLAIM_ALREADY_OPEN");
        // The cover and the customer come from the sale, not from whatever is typed.
        for (const sale of sales) {
          const line = sale.items.find((i) => i.serials.some((x) => x.id === input.serialId));
          if (!line) continue;
          warrantyUntil = line.warrantyUntil;
          customerPhone = customerPhone ?? sale.customerPhone;
          customerName = customerName ?? sale.customerName;
          break;
        }
        if (!warrantyUntil && sn) {
          warrantyUntil = manualWarranties.find((m) => m.serial === sn.serial)?.until ?? null;
        }
      }

      const inWarranty = warrantyUntil != null && warrantyUntil >= dhakaToday();
      const claimNo = `CLA-${branch.code}-${new Date().getFullYear()}${String(claimCounter++).padStart(6, "0")}`;
      const product = catalogue.find((p) => p.id === (input.productId ?? sn?.productId));
      const row = {
        id: crypto.randomUUID(), claimNo, status: "received" as ClaimStatus,
        approvalStatus: (shopDetails.claimApproval ? "awaiting_approval" : "approved") as
          ClaimRow["approvalStatus"],
        branch: branch.name, branchId: branch.id,
        product: product?.name ?? input.itemText ?? null,
        serial: sn?.serial ?? null, serialId: input.serialId ?? null,
        shopSerialId: input.serialId ?? null,
        problem: input.problem.trim(),
        problemType: problemTypes.find((p) => p.id === input.problemTypeId)?.name ?? null,
        accessories: input.accessories ?? [],
        inWarranty, warrantyUntil,
        customerPhone, customerName,
        technician: technicians.find((t) => t.id === input.technicianId)?.name ?? null,
        technicianId: input.technicianId ?? null,
        supplier: null, supplierId: null, sentAt: null, backAt: null,
        createdAt: new Date().toISOString(), deliveredAt: null,
        takenInBy: staff.name, resolution: null, replacementSerial: null,
        daysWaiting: 0, daysWithSupplier: null, open: true,
        events: [{
          at: new Date().toISOString(), to: "received" as ClaimStatus,
          note: input.problem.trim(), who: staff.name,
        }],
        parts: [] as { product: string; qty: number }[],
      };
      claims.unshift(row);
      // In the shop's hands and belonging to someone else: not stock, not sold.
      if (sn) sn.sold = true;
      return {
        id: row.id, claimNo, inWarranty, needsApproval: shopDetails.claimApproval,
      };
    },

    async setClaimStatus(input) {
      const c = claims.find((x) => x.id === input.claimId);
      if (!c) fail("CLAIM_NOT_FOUND");
      if (c!.approvalStatus === "awaiting_approval") fail("CLAIM_NOT_APPROVED");
      if (!c!.open) fail(`CLAIM_ALREADY_CLOSED:${c!.status}`);
      const allowed = ["diagnosed", "with_supplier", "back_from_supplier", "repaired",
                       "ready", "delivered", "rejected"];
      if (!allowed.includes(input.status)) fail(`BAD_CLAIM_STATUS:${input.status}`);
      if (input.status === "with_supplier" && !(input.supplierId ?? c!.supplierId)) {
        fail("CLAIM_NEEDS_SUPPLIER");
      }
      if (input.status === "rejected" && !input.note?.trim()) fail("REJECT_REASON_REQUIRED");

      const from = c!.status;
      c!.status = input.status;
      if (input.supplierId) {
        c!.supplierId = input.supplierId;
        c!.supplier = suppliers.find((s) => s.id === input.supplierId)?.name ?? null;
      }
      if (input.technicianId) {
        c!.technicianId = input.technicianId;
        c!.technician = technicians.find((t) => t.id === input.technicianId)?.name ?? null;
      }
      if (input.status === "with_supplier") c!.sentAt = new Date().toISOString();
      if (input.status === "back_from_supplier") c!.backAt = new Date().toISOString();
      if (["delivered", "rejected", "repaired"].includes(input.status) && input.note) {
        c!.resolution = input.note;
      }

      if (input.status === "delivered") {
        c!.deliveredAt = new Date().toISOString();
        c!.open = false;
        if (input.replacementSerialId) {
          // A SWAP: the new unit goes to the customer carrying what was left of the
          // original cover; the dead one stays the shop's problem.
          const rep = serials.find((x) => x.id === input.replacementSerialId);
          if (rep) { rep.sold = true; c!.replacementSerial = rep.serial; }
          const prod = catalogue.find((p) => p.id === rep?.productId);
          if (prod && !prod.isSerial) {
            stock[c!.branchId][prod.id] = Math.max((stock[c!.branchId][prod.id] ?? 0) - 1, 0);
          }
          noteMovement({
            at: new Date().toISOString(), product: prod?.name ?? "", code: prod?.code ?? "",
            change: -1, reason: "adjust_out", why: "other",
            note: `${c!.claimNo}: given as a warranty replacement`,
            who: staff.name, location: null,
          });
        } else if (c!.shopSerialId) {
          // The same unit, repaired and handed back. The customer's again.
          const own = serials.find((x) => x.id === c!.shopSerialId);
          if (own) own.sold = true;
        }
      }
      if (input.status === "rejected") { c!.open = false; c!.deliveredAt = new Date().toISOString(); }

      c!.events.push({
        at: new Date().toISOString(), to: input.status,
        note: input.note ?? null, who: staff.name,
      });
      c!.daysWaiting = Math.floor(
        (new Date(c!.deliveredAt ?? new Date().toISOString()).getTime()
          - new Date(c!.createdAt).getTime()) / 86_400_000);
      void from;
      return {
        claimNo: c!.claimNo, status: input.status,
        replacementSerial: c!.replacementSerial,
      };
    },

    async approveClaim(claimId, approve, reason) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:approve");
      const c = claims.find((x) => x.id === claimId);
      if (!c) fail("CLAIM_NOT_FOUND");
      if (c!.approvalStatus !== "awaiting_approval") {
        fail(`NOT_AWAITING_APPROVAL:${c!.approvalStatus}`);
      }
      if (!approve && !reason?.trim()) fail("CANCEL_REASON_REQUIRED");
      c!.approvalStatus = approve ? "approved" : "cancelled";
    },

    async useClaimPart(claimId, productId, qty = 1, serialId) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:adjust_stock");
      const c = claims.find((x) => x.id === claimId);
      if (!c) fail("CLAIM_NOT_FOUND");
      if (qty <= 0) fail("BAD_QTY:the part");
      const p = catalogue.find((x) => x.id === productId);
      if (!p) fail("PRODUCT_NOT_FOUND");
      if (p!.isSerial) {
        if (!serialId) fail(`SERIAL_REQUIRED:${p!.name}`);
        const sn = serials.find((x) => x.id === serialId && !x.sold);
        if (!sn) fail(`SERIAL_NOT_AVAILABLE:${p!.name}`);
        sn!.sold = true;
      } else {
        if ((stock[c!.branchId][p!.id] ?? 0) < qty) fail(`OUT_OF_STOCK:${p!.name}`);
        stock[c!.branchId][p!.id] -= qty;
      }
      c!.parts.push({ product: p!.name, qty });
      noteMovement({
        at: new Date().toISOString(), product: p!.name, code: p!.code, change: -qty,
        reason: "adjust_out", why: "internal_use",
        note: `${c!.claimNo}: part used in repair`, who: staff.name, location: null,
      });
    },

    async listClaims(input = {}): Promise<ClaimRow[]> {
      const q = (input.query ?? "").trim().toUpperCase();
      return claims
        .filter((c) => !input.branchId || c.branchId === input.branchId)
        .filter((c) => !input.status
          || (input.status === "open" ? c.open : c.status === input.status))
        .filter((c) => !input.technicianId || c.technicianId === input.technicianId)
        .filter((c) => input.waitingOver == null
          || Math.floor((new Date(c.deliveredAt ?? new Date().toISOString()).getTime()
              - new Date(c.createdAt).getTime()) / 86_400_000) >= input.waitingOver)
        .filter((c) => !q
          || c.claimNo.toUpperCase().startsWith(q)
          || (c.serial ?? "").toUpperCase().startsWith(q)
          || (c.customerPhone ?? "").includes(input.query ?? "")
          || (c.product ?? "").toUpperCase().includes(q))
        .map((c) => {
          // shopSerialId is the demo's own bookkeeping; ClaimRow does not carry it.
          const row: ClaimRow = {
            id: c.id, claimNo: c.claimNo, status: c.status,
            approvalStatus: c.approvalStatus, branch: c.branch, branchId: c.branchId,
            product: c.product, serial: c.serial, serialId: c.serialId,
            problem: c.problem, problemType: c.problemType, accessories: c.accessories,
            inWarranty: c.inWarranty, warrantyUntil: c.warrantyUntil,
            customerPhone: c.customerPhone, customerName: c.customerName,
            technician: c.technician, technicianId: c.technicianId,
            supplier: c.supplier, supplierId: c.supplierId,
            sentAt: c.sentAt, backAt: c.backAt, createdAt: c.createdAt,
            deliveredAt: c.deliveredAt, takenInBy: c.takenInBy,
            resolution: c.resolution, replacementSerial: c.replacementSerial,
            daysWaiting: c.daysWaiting, daysWithSupplier: c.daysWithSupplier,
            open: c.open, events: c.events, parts: c.parts,
          };
          return structuredClone({
            ...row,
            daysWaiting: Math.floor(
              (new Date(c.deliveredAt ?? new Date().toISOString()).getTime()
                - new Date(c.createdAt).getTime()) / 86_400_000),
            daysWithSupplier: c.sentAt
              ? Math.floor((new Date(c.backAt ?? new Date().toISOString()).getTime()
                  - new Date(c.sentAt).getTime()) / 86_400_000)
              : null,
          });
        })
        .sort((a, b) => b.daysWaiting - a.daysWaiting);
    },

    async supplierRmaList(): Promise<SupplierRmaRow[]> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      return claims
        .filter((c) => c.status === "with_supplier" && c.supplierId)
        .map((c) => ({
          supplier: c.supplier ?? "", supplierId: c.supplierId ?? "",
          claimNo: c.claimNo, claimId: c.id, product: c.product, serial: c.serial,
          sentAt: c.sentAt ?? c.createdAt,
          daysOut: Math.floor(
            (Date.now() - new Date(c.sentAt ?? c.createdAt).getTime()) / 86_400_000),
          problem: c.problem, branch: c.branch,
        }));
    },

    async listProblemTypes() { return structuredClone(problemTypes.filter((p) => p.active)); },

    async saveProblemType(id, name, active = true) {
      if (staff.role === "cashier") fail("NOT_MANAGER");
      if (!name.trim()) fail("NAME_REQUIRED");
      if (id) {
        const p = problemTypes.find((x) => x.id === id);
        if (!p) fail("SETTING_NOT_FOUND");
        p!.name = name.trim();
        p!.active = active;
        return;
      }
      problemTypes.push({ id: crypto.randomUUID(), name: name.trim(), active: true });
    },

    async listTechnicians() { return structuredClone(technicians.filter((t) => t.active)); },

    async saveTechnician(id, values) {
      if (staff.role === "cashier") fail("NOT_MANAGER");
      if (!id && !String(values.name ?? "").trim()) fail("NAME_REQUIRED");
      if (id) {
        const t = technicians.find((x) => x.id === id);
        if (!t) fail("SETTING_NOT_FOUND");
        Object.assign(t!, {
          name: String(values.name ?? "").trim() || t!.name,
          phone: "phone" in values ? (values.phone as string | null) : t!.phone,
          staffId: "staff_id" in values ? (values.staff_id as string | null) : t!.staffId,
          active: "active" in values ? Boolean(values.active) : t!.active,
        });
        return;
      }
      technicians.push({
        id: crypto.randomUUID(), name: String(values.name).trim(),
        phone: (values.phone as string | null) ?? null,
        staffId: (values.staff_id as string | null) ?? null,
        active: true,
      });
    },

    // --- The full counter (P10a) ---

    async priceHelp(productId, branchId, customerId): Promise<PriceHelp> {
      branchOr404(branchId);
      const p = catalogue.find((x) => x.id === productId);
      if (!p) fail("PRODUCT_NOT_FOUND");
      const allowed = emiCategories.has(p!.categoryId ?? "");
      const lineFor = (s: DemoSale) => s.items.find((i) => i.productId === productId);
      const mine = sales
        .filter((s) => s.status === "completed" && lineFor(s))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const theirs = customerId
        ? mine.filter((s) => s.customerId === customerId) : [];
      return {
        productId,
        lastPriceToCustomer: theirs[0] ? lineFor(theirs[0])!.unitPrice : null,
        lastPriceToCustomerOn: theirs[0] ? theirs[0].createdAt.slice(0, 10) : null,
        lastPrice: mine[0] ? lineFor(mine[0])!.unitPrice : null,
        here: productsAt(branchId).find((x) => x.id === productId)?.stock ?? 0,
        // Where else it is, so "we haven't got one" can become "the other branch has two".
        elsewhere: branches
          .filter((b) => b.id !== branchId && b.active)
          .map((b) => ({
            branch: b.name,
            qty: productsAt(b.id).find((x) => x.id === productId)?.stock ?? 0,
          }))
          .filter((x) => x.qty > 0),
        emiAllowed: allowed,
        emiPlans: allowed ? structuredClone(emiPlans.filter((e) => e.active)) : [],
      };
    },

    async listEmiPlans() { return structuredClone(emiPlans); },

    async saveEmiPlan(id, values) {
      if (staff.role === "cashier") fail("NOT_ALLOWED:edit_settings");
      if (!id && !String(values.bank ?? "").trim()) fail("EMI_BANK_REQUIRED");
      if (id) {
        const e = emiPlans.find((x) => x.id === id);
        if (!e) fail("EMI_PLAN_NOT_FOUND");
        Object.assign(e!, {
          bank: String(values.bank ?? "").trim() || e!.bank,
          months: Number(values.months) || e!.months,
          chargePct: values.charge_pct !== undefined ? Number(values.charge_pct) || 0 : e!.chargePct,
          minAmount: values.min_amount !== undefined ? Number(values.min_amount) || 0 : e!.minAmount,
          active: "active" in values ? Boolean(values.active) : e!.active,
        });
        return;
      }
      emiPlans.push({
        id: crypto.randomUUID(), bank: String(values.bank).trim(),
        months: Number(values.months) || 12,
        chargePct: Number(values.charge_pct) || 0,
        minAmount: Number(values.min_amount) || 0,
        active: true,
      });
    },

    async listSaleFields(): Promise<SaleField[]> {
      // One source: the setup list the owner edits in Settings, not a second copy.
      return lists.sale_fields
        .filter((f) => f.active !== false)
        .map((f) => ({
          id: f.id, name: String(f.name),
          showOnInvoice: Boolean(f.show_on_invoice), active: true,
        }));
    },

    // --- Credit sales and customers (P10) ---

    async listCustomers(query, limit = 100): Promise<CustomerRow[]> {
      const q = (query ?? "").trim().toLowerCase();
      return customers
        .filter((c) => !q
          || c.phone.includes(q)
          || c.name.toLowerCase().includes(q)
          || (c.company ?? "").toLowerCase().includes(q))
        .slice(0, limit)
        .map((c) => ({
          ...structuredClone({
            id: c.id, phone: c.phone, name: c.name, company: c.company,
            address: c.address, groupId: c.groupId, group: c.group,
            priceListId: c.priceListId, priceList: c.priceList,
            discountPct: c.discountPct, binVat: c.binVat, nid: c.nid, note: c.note,
            active: c.active, districtId: c.districtId, upazilaId: c.upazilaId,
            creditAllowed: c.creditAllowed, creditLimit: c.creditLimit,
            paymentDays: c.paymentDays,
          }),
          owed: dueFor(c.id),
          totalSpent: sales
            .filter((x) => x.customerId === c.id && x.status === "completed")
            .reduce((n, x) => n + x.total, 0),
        }));
    },

    async saveCustomer(id, values): Promise<CustomerRow> {
      // Credit, prices and discounts are the owner's levers, not the counter's.
      const creditKeys = ["credit_allowed", "credit_limit", "payment_days",
                          "price_list_id", "discount_pct", "group_id"];
      if (creditKeys.some((k) => k in values) && staff.role === "cashier") fail("NOT_MANAGER");

      const group = values.group_id
        ? customerGroups.find((g) => g.id === values.group_id) ?? null
        : null;
      const listId = (values.price_list_id as string | undefined) ?? null;

      if (id) {
        const c = customers.find((x) => x.id === id);
        if (!c) fail("CUSTOMER_NOT_FOUND");
        Object.assign(c!, {
          phone: (values.phone as string)?.trim() || c!.phone,
          name: "name" in values ? String(values.name ?? "").trim() || c!.phone : c!.name,
          company: "company" in values ? (values.company as string | null) : c!.company,
          address: "address" in values ? (values.address as string | null) : c!.address,
          binVat: "bin_vat" in values ? (values.bin_vat as string | null) : c!.binVat,
          nid: "nid" in values ? (values.nid as string | null) : c!.nid,
          note: "note" in values ? (values.note as string | null) : c!.note,
          groupId: "group_id" in values ? (values.group_id as string | null) : c!.groupId,
          group: "group_id" in values ? group?.name ?? null : c!.group,
          priceListId: "price_list_id" in values ? listId : c!.priceListId,
          priceList: "price_list_id" in values
            ? priceLists.find((l) => l.id === listId)?.name ?? null : c!.priceList,
          discountPct: "discount_pct" in values ? Number(values.discount_pct) || 0 : c!.discountPct,
          creditAllowed: "credit_allowed" in values ? Boolean(values.credit_allowed) : c!.creditAllowed,
          creditLimit: "credit_limit" in values ? Number(values.credit_limit) || 0 : c!.creditLimit,
          paymentDays: "payment_days" in values ? Number(values.payment_days) || 0 : c!.paymentDays,
          active: "active" in values ? Boolean(values.active) : c!.active,
        });
        return { ...c!, owed: dueFor(c!.id) };
      }

      const phone = String(values.phone ?? "").trim();
      if (!phone) fail("BAD_PHONE");
      const already = customers.find((x) => x.phone === phone);
      if (already) {
        if (values.name) already.name = String(values.name).trim();
        return { ...already, owed: dueFor(already.id) };
      }
      const row = {
        id: crypto.randomUUID(), phone,
        name: String(values.name ?? "").trim() || phone,
        company: (values.company as string | null) ?? null,
        address: (values.address as string | null) ?? null,
        groupId: (values.group_id as string | null) ?? null,
        group: group?.name ?? null,
        priceListId: listId,
        priceList: priceLists.find((l) => l.id === listId)?.name ?? null,
        discountPct: Number(values.discount_pct) || 0,
        binVat: (values.bin_vat as string | null) ?? null,
        nid: (values.nid as string | null) ?? null,
        note: (values.note as string | null) ?? null,
        active: true, districtId: null, upazilaId: null,
        creditAllowed: Boolean(values.credit_allowed),
        creditLimit: Number(values.credit_limit) || 0,
        paymentDays: Number(values.payment_days) || 0,
        owed: 0, totalSpent: 0, openingBalance: 0, openingAt: null,
      };
      customers.push(row);
      return { ...row };
    },

    async listCustomerGroups() { return structuredClone(customerGroups); },

    async saveCustomerGroup(id, values) {
      if (staff.role === "cashier") fail("NOT_MANAGER");
      if (!id && !String(values.name ?? "").trim()) fail("GROUP_NAME_REQUIRED");
      if (id) {
        const g = customerGroups.find((x) => x.id === id);
        if (!g) fail("GROUP_NOT_FOUND");
        Object.assign(g!, {
          name: String(values.name ?? "").trim() || g!.name,
          priceListId: "price_list_id" in values ? (values.price_list_id as string | null) : g!.priceListId,
          discountPct: Number(values.discount_pct) || g!.discountPct,
          creditAllowed: "credit_allowed" in values ? Boolean(values.credit_allowed) : g!.creditAllowed,
          creditLimit: Number(values.credit_limit) || g!.creditLimit,
          paymentDays: Number(values.payment_days) || g!.paymentDays,
          active: "active" in values ? Boolean(values.active) : g!.active,
        });
        return;
      }
      customerGroups.push({
        id: crypto.randomUUID(), name: String(values.name).trim(),
        priceListId: (values.price_list_id as string | null) ?? null,
        discountPct: Number(values.discount_pct) || 0,
        creditAllowed: Boolean(values.credit_allowed),
        creditLimit: Number(values.credit_limit) || 0,
        paymentDays: Number(values.payment_days) || 0,
        active: true,
      });
    },

    async dueList(branchId): Promise<DueRow[]> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      return customers
        .filter((c) => dueFor(c.id) > 0)
        .filter((c) => !branchId
          || sales.some((s) => s.customerId === c.id && s.branchId === branchId && s.dueAmount > 0))
        .map((c) => {
          const aging = agingForCustomer(c.id);
          return {
            customerId: c.id, name: c.name, phone: c.phone, company: c.company,
            group: c.group, creditLimit: c.creditLimit, paymentDays: c.paymentDays,
            owed: dueFor(c.id), aging, overdue: aging.overdue,
            lastPaid: customerPayments
              .filter((p) => p.customerId === c.id)
              .map((p) => p.at).sort().pop() ?? null,
            oldestDue: sales
              .filter((s) => s.customerId === c.id && s.dueAmount > 0)
              .map((s) => s.createdAt.slice(0, 10)).sort()[0] ?? null,
          };
        })
        .sort((a, b) => b.overdue - a.overdue || b.owed - a.owed);
    },

    async customerStatement(customerId): Promise<CustomerStatement> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      const c = customers.find((x) => x.id === customerId);
      if (!c) fail("CUSTOMER_NOT_FOUND");
      const mine = sales.filter((s) => s.customerId === customerId);
      const entries: StatementEntry[] = [
        ...(c!.openingBalance > 0
          ? [{ at: c!.openingAt ?? dhakaToday(), kind: "opening" as const,
               document: "Opening balance", change: c!.openingBalance, note: null }]
          : []),
        ...mine.filter((s) => s.dueAmount > 0).map((s) => ({
          at: s.createdAt, kind: "sale" as const, document: s.invoiceNo,
          change: s.dueAmount,
          note: `Total ${s.total}, paid ${s.paidAmount}`,
        })),
        ...customerPayments.filter((p) => p.customerId === customerId).map((p) => ({
          at: p.at, kind: "payment" as const, document: p.receiptNo,
          change: -p.amount, note: p.method,
        })),
        ...mine.flatMap((s) => s.returns
          .filter((r) => ["reduce_due", "store_credit"].includes(r.refundMethod))
          .map((r) => ({
            at: r.createdAt, kind: "return" as const, document: r.returnNo,
            change: -r.total, note: r.refundMethod,
          }))),
      ].sort((a, b) => a.at.localeCompare(b.at));

      return {
        customerId: c!.id, name: c!.name, phone: c!.phone, company: c!.company,
        address: c!.address, binVat: c!.binVat, nid: c!.nid, note: c!.note,
        group: c!.group, priceList: c!.priceList, discountPct: c!.discountPct,
        creditAllowed: c!.creditAllowed, creditLimit: c!.creditLimit,
        paymentDays: c!.paymentDays,
        owed: dueFor(c!.id), aging: agingForCustomer(c!.id),
        totalSpent: mine.filter((s) => s.status === "completed")
          .reduce((n, s) => n + s.total, 0),
        saleCount: mine.filter((s) => s.status === "completed").length,
        entries,
        purchases: mine.map((s) => ({
          id: s.id, invoiceNo: s.invoiceNo, at: s.createdAt, branch: s.branch,
          total: s.total, due: s.dueAmount, status: s.status,
          items: s.items.map((i) => i.name).join(", "),
        })).reverse(),
        owns: mine
          .filter((s) => s.status === "completed")
          .flatMap((s) => s.items.flatMap((i) => i.serials.map((x) => ({
            serial: x.serial, product: i.name, bought: s.createdAt.slice(0, 10),
            invoiceNo: s.invoiceNo, warrantyUntil: i.warrantyUntil,
            inWarranty: i.warrantyUntil != null && i.warrantyUntil >= dhakaToday(),
            status: x.status,
          })))),
      };
    },

    async collectPayment(input): Promise<PaymentReceipt> {
      const branch = branchOr404(input.branchId);
      if (!(input.amount > 0)) fail("BAD_PAYMENT_AMOUNT");
      const methods = ["cash", "bkash", "nagad", "card", "rocket", "bank", "cheque"];
      if (!methods.includes(input.method)) fail("BAD_PAYMENT_METHOD");
      const c = customers.find((x) => x.id === input.customerId);
      if (!c) fail("CUSTOMER_NOT_FOUND");

      const wasOwed = dueFor(c!.id);
      const open = shifts.find(
        (sh) => sh.branchId === branch.id && sh.staffId === staff.id && !sh.closedAt);
      const receiptNo = `REC-${branch.code}-${new Date().getFullYear()}${String(receiptCounter++).padStart(6, "0")}`;
      customerPayments.push({
        id: crypto.randomUUID(), customerId: c!.id, receiptNo, amount: input.amount,
        method: input.method, reference: input.reference ?? null,
        branchId: branch.id, shiftId: open?.id ?? null, at: new Date().toISOString(),
      });
      // Cash collected during a shift is cash in the drawer at closing time.
      if (input.method === "cash" && open) open.cashIn += input.amount;

      return {
        receiptNo, paymentId: customerPayments[customerPayments.length - 1].id,
        customer: c!.name, amount: input.amount, wasOwed, owed: dueFor(c!.id),
        shopName: staff.shopName, branch: branch.name, takenBy: staff.name,
      };
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
