// Demo mode: runs entirely in the browser with sample data, so the counter can be
// tried before Supabase is set up. Mirrors the rules in complete_sale().
//
// The demo person is an OWNER with two branches, so everything a shop would be shown —
// the branch switcher, the whole menu, the approval PIN screen — is reachable. Demo
// mode is also the sales demo. Nothing here names a real shop.
import {
  addMonths, dhakaDate, dhakaToday, friendlyError, isValidPhone, refundFor, roundTaka,
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
  Dashboard, DashboardDetailRow,
  AccountLedger, AccountNature, AccountRole, BackfillResult, ChartAccount, ChequeBookRow,
  ChequeLayout, ChequePrint, ChequeRow, ChequeStatus, EntryStatus, LedgerLine,
  MoneyBalance, TrialBalance, TrialBalanceRow, VoucherRow,
  JournalExport, LayerRebuildResult, PeriodLock, ReportListItem, ReportResult,
  AdvanceRow, BilledResult, ChallanRow, ChallanStatus, OrderRow, OrderStatus,
  QuotationRow, QuotationStatus, SalesDocument,
  AttendanceDay, AttendanceStatus, AttendanceTodayBranch, CheckInResult, Employee,
  LeaveRow, SalarySheet, SalarySheetRow,
  CustomerKind, CustomerSearchRow, DeliveryPoint, RepMonth, RepRow,
} from "../types";
import { DEFAULT_CHEQUE_LAYOUT, takaInWords } from "../cheque";
import type { ImportKind } from "../import/schema";
import type { Backend } from "./types";
import {
  demoReportList, runDemoReport,
  type DemoReportData, type DemoReportSale,
} from "./demo-reports";
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
  /** Out at a customer's on a delivery note, not yet billed: still the shop's, but
   *  not on a shelf and not sellable to anybody else (P14a). */
  delivered?: boolean;
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
    sales_documents: false, hr: false, hr_extra_fields: false, distribution: false,
  };
  // The sample data is deliberately forgotten on reload, but the feature switches are
  // not data — somebody trying the app turns Accounts on to look at it, reloads, and
  // would otherwise find the menu back to its smallest shape.
  const FEATURE_STORE = "csl-demo-features";
  try {
    const saved = globalThis.localStorage?.getItem(FEATURE_STORE);
    if (saved) {
      for (const [k, v] of Object.entries(JSON.parse(saved) as Record<string, boolean>)) {
        if (k in features) features[k] = Boolean(v);
      }
    }
  } catch { /* a private window, or storage turned off: the defaults are fine */ }
  const rememberFeatures = () => {
    try {
      globalThis.localStorage?.setItem(FEATURE_STORE, JSON.stringify(features));
    } catch { /* nothing to do about it, and nothing depends on it */ }
  };
  const shopDetails = {
    name: DEMO_SHOP_NAME, address: "123 Example Road, Dhaka", phone: "01700-000000",
    email: null as string | null, logoUrl: null as string | null, binVat: null as string | null,
    receiptFooter: "Thank you. Keep this receipt for warranty claims.",
    invoicePrefix: "DEMO", currency: "BDT", aitPct: 0, poApprovalLimit: 0,
    soApprovalLimit: 0,
    cashShortLimit: 50, returnDays: 7, saleApprovalLimit: 0, approveAllSales: false,
    cardChargeMode: "absorb" as "absorb" | "add", claimApproval: false,
    voucherApproval: false,
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
    bank_accounts: [
      row({ name: "Counter cash drawer", kind: "cash_drawer" }),
      // A real shop adds its own; the demo needs one so cheques can be tried.
      row({ name: "City Bank — current", kind: "bank" }),
    ],
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
    // The HR lists (P14b). Empty until a shop turns HR on and fills them in.
    departments: [row({ name: "Shop floor" }), row({ name: "Office" })],
    designations: [row({ name: "Salesman" }), row({ name: "Technician" })],
    positions: [],
    professions: [],
    leave_types: [
      row({ name: "Casual", days_a_year: 10, is_paid: true }),
      row({ name: "Sick", days_a_year: 14, is_paid: true }),
      row({ name: "Unpaid", days_a_year: 0, is_paid: false }),
    ],
  };
  const PERMISSION_KEYS = [
    { key: "sell", label: "Sell at the counter", area: "counter", hasLimit: false },
    { key: "give_discount", label: "Give a discount", area: "counter", hasLimit: true },
    { key: "change_price", label: "Change a price within the band", area: "counter", hasLimit: false },
    { key: "see_cost", label: "See cost prices", area: "counter", hasLimit: false },
    { key: "manage_hr", label: "See and change staff records", area: "admin", hasLimit: false },
    { key: "see_salary", label: "See and set what people earn", area: "admin", hasLimit: false },
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
    /** What each line's goods cost when it was sold (P12), by sale-line id. */
    lineCosts: Record<string, number | null>;
  };
  const sales: DemoSale[] = [];
  let returnCounter = 1;
  // What each one cost. Every product, not just one: stock with no cost recorded is
  // stock of unknown value, and the profit figure quietly treats it as free. The SSD is
  // deliberately left out, so "received for the first time" has something to prove.
  const costs: Record<string, number> = {
    a1: 250, a2: 300, a3: 220, a4: 320, a5: 640, a6: 950, a7: 2450,
    a9: 2800, aa: 66000, ab: 820,
  };

  // --- Accounts (P13) --------------------------------------------------------
  // The same double entry the database does: every taka written twice, and nothing
  // reaches the journal except through `post()`, which refuses an entry that does not
  // balance. The demo would otherwise be able to show figures the real shop cannot.
  interface DemoAccount {
    id: string; code: string; name: string; role: AccountRole | null;
    group: string; nature: AccountNature; active: boolean;
    branchId: string | null; bankAccountId: string | null;
  }
  interface DemoLine {
    accountId: string; branchId: string; debit: number; credit: number;
    note: string | null; customerId: string | null; supplierId: string | null;
  }
  interface DemoEntry {
    id: string; entryNo: string; date: string; narration: string;
    sourceKind: string; sourceId: string | null; status: EntryStatus;
    branchId: string; otherBranchId: string | null; acceptedAt: string | null;
    reversesId: string | null; interKind: "fund" | "cost" | null;
    interAccountId: string | null; who: string; lines: DemoLine[];
  }
  const CHART: [string, string, string, AccountNature, AccountRole | null][] = [
    ["1100", "Cash in hand", "Current assets", "asset", "cash_in_hand"],
    ["1200", "Bank accounts", "Current assets", "asset", "bank"],
    ["1300", "bKash / Nagad", "Current assets", "asset", "wallet"],
    ["1400", "Money owed by customers", "Current assets", "asset", "receivable"],
    ["1500", "Stock", "Current assets", "asset", "inventory"],
    ["2100", "Money owed to suppliers", "Current liabilities", "liability", "payable"],
    ["2200", "VAT payable", "Current liabilities", "liability", "vat_payable"],
    ["2300", "Between branches", "Current liabilities", "liability", "inter_branch"],
    ["3100", "Owner's capital", "Equity", "equity", "opening_equity"],
    ["4100", "Sales", "Income", "income", "sales"],
    ["4200", "Sales returns", "Income", "income", "sales_return"],
    ["5100", "Cost of goods sold", "Direct costs", "expense", "cogs"],
    ["5200", "Discounts given", "Direct costs", "expense", "discount_given"],
    ["6100", "Tea and snacks", "Running costs", "expense", null],
    ["6200", "Transport", "Running costs", "expense", null],
    ["6300", "Electricity", "Running costs", "expense", null],
    ["6400", "Shop rent", "Running costs", "expense", null],
    ["6500", "Card charges", "Running costs", "expense", "card_charge"],
    ["6900", "Other expenses", "Running costs", "expense", null],
    // P14a and P14c: money the shop is HOLDING, and goods that have gone but are not
    // yet billed. Both are somebody else's until the paperwork says otherwise.
    ["2150", "Money held for customers", "Current liabilities", "liability", "customer_advance"],
    ["2160", "Dealer security deposits", "Current liabilities", "liability", "customer_deposit"],
    ["1360", "Goods delivered, not invoiced", "Current assets", "asset", "goods_delivered"],
  ];
  const accounts: DemoAccount[] = CHART.flatMap(([code, name, group, nature, role]): DemoAccount[] =>
    role === "cash_in_hand"
      // One drawer per place: the done-when is that this balance matches what was counted.
      ? branches.map((b) => ({
          id: `ac-${code}-${b.id}`, code: `${code}-${b.code}`,
          name: `${name} — ${b.name}`, role, group, nature, active: true,
          branchId: b.id, bankAccountId: null,
        }))
      : [{ id: `ac-${code}`, code, name, role, group, nature, active: true,
           branchId: null, bankAccountId: null }]);
  const journal: DemoEntry[] = [];
  let entryCounter = 1;
  const chequeBooks: (ChequeBookRow & { shopPrefix: string | null })[] = [];
  const cheques: (ChequeRow & {
    branchId: string; bankAccountId: string | null; bookId: string | null;
    entryId: string | null;
  })[] = [];
  const chequeLayouts: Record<string, ChequeLayout> = {};

  const accountFor = (role: AccountRole, branchId?: string | null): DemoAccount | undefined =>
    accounts.find((a) => a.role === role && a.active
      && (a.branchId === null || a.branchId === branchId))
    ?? accounts.find((a) => a.role === role && a.active);

  const accountForMethod = (method: string, branchId: string): DemoAccount | undefined =>
    accountFor(method === "cash" ? "cash_in_hand"
               : ["bkash", "nagad", "rocket"].includes(method) ? "wallet" : "bank", branchId);

  /** The one way an entry is written here, exactly as post_entry() is there. */
  const post = (input: {
    branchId: string; date?: string | null; narration: string;
    sourceKind: string; sourceId?: string | null; status?: EntryStatus;
    otherBranchId?: string | null;
    lines: { accountId?: string | null; role?: AccountRole; branchId?: string | null;
             debit?: number; credit?: number; note?: string | null;
             customerId?: string | null; supplierId?: string | null }[];
  }): DemoEntry => {
    const lines: DemoLine[] = [];
    for (const l of input.lines) {
      const debit = roundTaka(l.debit ?? 0);
      const credit = roundTaka(l.credit ?? 0);
      // A zero line is not an error, it is just nothing: a sale with no VAT has one.
      if (debit === 0 && credit === 0) continue;
      const acc = l.accountId
        ? accounts.find((a) => a.id === l.accountId)
        : accountFor(l.role as AccountRole, l.branchId ?? input.branchId);
      if (!acc) fail(`NO_ACCOUNT_FOR:${l.role ?? "that line"}`);
      lines.push({
        accountId: acc!.id, branchId: l.branchId ?? input.branchId, debit, credit,
        note: l.note ?? null, customerId: l.customerId ?? null,
        supplierId: l.supplierId ?? null,
      });
    }
    if (lines.length === 0) fail("NOTHING_TO_POST");
    const debits = roundTaka(lines.reduce((t, l) => t + l.debit, 0));
    const credits = roundTaka(lines.reduce((t, l) => t + l.credit, 0));
    if (debits !== credits) fail("ENTRY_DOES_NOT_BALANCE");
    const entry: DemoEntry = {
      id: `je-${entryCounter}`,
      entryNo: `VOU-${branches.find((b) => b.id === input.branchId)?.code ?? "XX"}-${
        String(new Date().getFullYear())}${String(entryCounter).padStart(6, "0")}`,
      date: input.date ?? dhakaToday(),
      narration: input.narration, sourceKind: input.sourceKind,
      sourceId: input.sourceId ?? null, status: input.status ?? "posted",
      branchId: input.branchId, otherBranchId: input.otherBranchId ?? null,
      acceptedAt: null, reversesId: null, interKind: null, interAccountId: null,
      who: staff.name, lines,
    };
    entryCounter += 1;
    journal.push(entry);
    return entry;
  };

  const accountsOn = () => {
    if (!features.accounts) fail("FEATURE_OFF:accounts");
  };

  const toVoucherRow = (e: DemoEntry): VoucherRow => ({
    id: e.id, entryNo: e.entryNo, date: e.date, narration: e.narration,
    sourceKind: e.sourceKind, sourceId: e.sourceId, status: e.status,
    branch: branches.find((b) => b.id === e.branchId)?.name ?? null,
    branchId: e.branchId,
    otherBranch: branches.find((b) => b.id === e.otherBranchId)?.name ?? null,
    acceptedAt: e.acceptedAt, reversesId: e.reversesId, who: e.who,
    amount: roundTaka(e.lines.reduce((t, l) => t + l.debit, 0)),
    lines: e.lines.map((l) => {
      const acc = accounts.find((a) => a.id === l.accountId)!;
      return {
        account: acc.name, code: acc.code, debit: l.debit, credit: l.credit,
        note: l.note,
        party: customers.find((c) => c.id === l.customerId)?.name
          ?? suppliers.find((x) => x.id === l.supplierId)?.name ?? null,
      };
    }),
  });

  /** What a sale, a return or an expense does to the books. */
  const postSale = (sale: DemoSale) => {
    if (!features.accounts) return;
    const goods = roundTaka(sale.total - sale.vatAmount - (sale.chargesAmount ?? 0));
    post({
      branchId: sale.branchId, date: dhakaDate(sale.createdAt),
      narration: `Sale ${sale.invoiceNo}`, sourceKind: "sale", sourceId: sale.id,
      lines: [
        { accountId: accountForMethod(sale.paymentMethod, sale.branchId)?.id,
          debit: sale.paidAmount, note: `Paid on ${sale.invoiceNo}` },
        { role: "receivable", debit: sale.dueAmount, customerId: sale.customerId,
          note: `On due from ${sale.invoiceNo}` },
        { role: "discount_given", debit: sale.discountAmount,
          note: `Discount on ${sale.invoiceNo}` },
        { role: "sales", credit: roundTaka(goods + sale.discountAmount), note: sale.invoiceNo },
        { role: "vat_payable", credit: sale.vatAmount, note: `VAT on ${sale.invoiceNo}` },
        { role: "sales", credit: sale.chargesAmount ?? 0,
          note: `Charges on ${sale.invoiceNo}` },
      ],
    });
    // The goods leaving the shelf is its own event, at the cost captured on the line.
    const cogs = roundTaka(sale.items.reduce(
      (t: number, l: SaleDetailLine) => t + (sale.lineCosts[l.id] ?? 0) * l.qty, 0));
    if (cogs > 0) {
      post({
        branchId: sale.branchId, date: dhakaDate(sale.createdAt),
        narration: `Cost of goods on ${sale.invoiceNo}`,
        sourceKind: "sale", sourceId: sale.id,
        lines: [{ role: "cogs", debit: cogs }, { role: "inventory", credit: cogs }],
      });
    }
  };

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
    letterhead: {
      shopName: DEMO_SHOP_NAME, logoUrl: null, address: null, phone: null,
      email: null, binVat: null,
    },
    hasPin: true,
    branches: branches.map(({ id, name, code, locations, address, phone }) =>
      ({ id, name, code, locations, address, phone })),
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
        .filter((s) => s.productId === p.id && s.branchId === branchId
                       && !s.sold && !s.inTransit && !s.delivered)
        .map(({ id, serial }) => ({ id, serial }));
      // Out at a customer's on a delivery note: not sellable, but billable (P14a).
      const out: SerialUnit[] = serials
        .filter((s) => s.productId === p.id && s.branchId === branchId && s.delivered && !s.sold)
        .map(({ id, serial }) => ({ id, serial }));
      return {
        id: p.id, code: p.code, barcode: p.barcode, name: p.name, brand: p.brand,
        categoryId: p.categoryId, price: pr.price, warrantyMonths: p.warrantyMonths,
        isSerial: p.isSerial, reorderLevel: p.reorderLevel,
        mrp: pr.mrp, minPrice: pr.min, maxPrice: pr.max, isInventory: true,
        stock: p.isSerial ? mine.length : (stock[branchId]?.[p.id] ?? 0),
        reserved: reservedQty(p.id, branchId),
        serials: mine,
        deliveredSerials: out,
      };
    });

  // Months the owner has closed, and the names they have given the reports (P14).
  const locks: PeriodLock[] = [];
  /** Refuse to touch a closed month — the same rule the database enforces with a
   *  trigger on every table that records something dated. */
  const periodOpen = (when: string): void => {
    const month = `${dhakaDate(when).slice(0, 7)}-01`;
    if (locks.some((l) => l.month === month)) {
      fail(`PERIOD_LOCKED:${monthWords(month)}`);
    }
  };
  const reportSettings: Record<
    string, { title?: string; sl?: number; captions?: Record<string, string> }> = {};

  /** Everything the reports read, gathered fresh so they see the latest sale. */
  const reportData = (): DemoReportData => ({
    shop: DEMO_SHOP_NAME,
    me: { name: staff.name, role: staff.role },
    branches: branches.map((b) => ({ id: b.id, name: b.name })),
    products: catalogue.map((p) => ({
      id: p.id, code: p.code, name: p.name, brand: p.brand,
      categoryId: p.categoryId, reorderLevel: p.reorderLevel,
    })),
    categories: DEMO_CATEGORIES.map((c) => ({ id: c.id, name: c.name })),
    customers: customers.map((c) => ({
      id: c.id, name: c.name ?? c.phone, phone: c.phone, company: c.company,
      address: c.address, group: c.group, openingBalance: c.openingBalance,
    })),
    suppliers: suppliers.map((s) => ({
      id: s.id, name: s.name, phone: s.phone, address: s.address ?? null,
    })),
    sales: sales.map((s): DemoReportSale => ({
      id: s.id, invoiceNo: s.invoiceNo, createdAt: s.createdAt,
      branchId: s.branchId, branch: s.branch, staff: s.staff,
      customerId: s.customerId,
      customerName: s.customerId
        ? (customers.find((c) => c.id === s.customerId)?.name ?? null) : null,
      customerGroup: s.customerId
        ? (customers.find((c) => c.id === s.customerId)?.group ?? null) : null,
      paymentMethod: s.paymentMethod, paymentRef: s.paymentRef,
      subtotal: s.subtotal, discountPct: s.discountPct, discountAmount: s.discountAmount,
      vatAmount: s.vatAmount, chargesAmount: s.chargesAmount, total: s.total,
      dueAmount: s.dueAmount, paidAmount: s.paidAmount, status: s.status,
      lines: s.items.map((l) => ({
        id: l.id, productId: l.productId, name: l.name, qty: l.qty,
        unitPrice: l.unitPrice, lineTotal: l.lineTotal, vatAmount: l.vatAmount,
        cost: s.lineCosts[l.id] ?? null,
        serials: l.serials.map((x) => x.serial),
        returnedQty: l.returnedQty, refundEach: l.refundEach,
      })),
    })),
    deliveries: deliveries.map((g) => ({ ...g, branchId: branches[0].id })),
    stock,
    costs,
    serials: serials.map((x) => ({
      serial: x.serial, productId: x.productId, branchId: x.branchId,
      sold: x.sold, inTransit: x.inTransit,
    })),
    journal: journal.map((e) => ({
      id: e.id, entryNo: e.entryNo, date: e.date, narration: e.narration,
      sourceKind: e.sourceKind, status: e.status, branchId: e.branchId, who: e.who,
      lines: e.lines.map((l) => ({
        accountId: l.accountId, debit: l.debit, credit: l.credit, note: l.note,
        customerId: l.customerId, supplierId: l.supplierId,
      })),
    })),
    accounts: accounts.map((a) => ({
      id: a.id, code: a.code, name: a.name, group: a.group, nature: a.nature,
      role: a.role, branchId: a.branchId,
    })),
    cheques: cheques.map((c) => ({
      chequeNo: c.chequeNo, direction: c.direction, status: c.status, amount: c.amount,
      chequeDate: c.chequeDate,
      party: c.payee
        ?? (c.customerId ? (customers.find((x) => x.id === c.customerId)?.name ?? null)
            : c.supplierId ? (suppliers.find((x) => x.id === c.supplierId)?.name ?? null)
            : null),
      bank: c.bank ?? c.drawnOn,
      branchId: branches[0].id,
      settledOn: c.clearedAt ? dhakaDate(c.clearedAt) : null,
    })),
    claims,
    transfers,
    locks,
    settings: reportSettings,
    features,
  });

  // --- Quotations, sales orders and challans (P14a) ---------------------------
  // The same rules the database keeps: a quotation moves nothing, an order RESERVES
  // (worked out from the open lines, never stored), a challan takes the stock off the
  // shelf, and the bill does not move it again.
  interface DemoDocLine {
    id: string; productId: string; qty: number; unitPrice: number; lineDiscount: number;
    isFree: boolean; lineTotal: number; note: string | null;
    deliveredQty?: number; billedQty?: number; returnedQty?: number; cancelled?: boolean;
    orderItemId?: string | null; serialIds?: string[];
  }
  interface DemoQuotation {
    id: string; quoteNo: string; createdAt: string; branchId: string;
    customerId: string | null; customerName: string | null; attention: string | null;
    address: string | null; validUntil: string | null; terms: string | null;
    note: string | null; discountPct: number; subtotal: number; discountAmount: number;
    vatAmount: number; total: number; status: QuotationStatus; statusNote: string | null;
    who: string; lines: DemoDocLine[];
  }
  interface DemoOrder {
    id: string; soNo: string; createdAt: string; branchId: string; quoteId: string | null;
    customerId: string; attention: string | null; address: string | null;
    deliveryDate: string | null; paymentTermsDays: number; discountPct: number;
    subtotal: number; discountAmount: number; vatAmount: number; total: number;
    advanceAmount: number; status: OrderStatus; cancelReason: string | null;
    note: string | null; terms: string | null; who: string; soldBy: string | null;
    approvedBy: string | null; lines: DemoDocLine[];
  }
  interface DemoChallan {
    id: string; challanNo: string; deliveredOn: string; branchId: string;
    orderId: string | null; customerId: string; attention: string | null;
    address: string | null; carrier: string | null; vehicleNo: string | null;
    note: string | null; status: ChallanStatus; totalCost: number; who: string;
    invoiceNo: string | null; lines: DemoDocLine[];
  }
  interface DemoAdvance {
    id: string; createdAt: string; branchId: string; orderId: string | null;
    customerId: string; amount: number; method: string; reference: string | null;
    note: string | null; usedOnSaleId: string | null; who: string;
  }
  const quotations: DemoQuotation[] = [];
  const orders: DemoOrder[] = [];
  const challans: DemoChallan[] = [];
  const advances: DemoAdvance[] = [];
  let quoteCounter = 1;
  let orderCounter = 1;
  let challanCounter = 1;

  const docsOn = (): void => {
    if (!features.sales_documents) fail("FEATURE_OFF:sales_documents");
  };

  /** Promised to an open order and not yet gone. Worked out, never stored. */
  const reservedQty = (productId: string, branchId: string, ignoreOrder?: string): number => {
    if (!features.sales_documents) return 0;
    return orders
      .filter((o) => o.branchId === branchId && o.id !== ignoreOrder
                     && ["open", "part_delivered", "awaiting_approval"].includes(o.status))
      .flatMap((o) => o.lines)
      .filter((l) => l.productId === productId && !l.cancelled)
      .reduce((n, l) => n + Math.max(l.qty - (l.deliveredQty ?? 0), 0), 0);
  };

  const availableQty = (productId: string, branchId: string, ignoreOrder?: string): number =>
    Math.max((stock[branchId]?.[productId] ?? 0)
             + serials.filter((x) => x.productId === productId && x.branchId === branchId
                                     && !x.sold && !x.inTransit && !x.delivered).length
             - reservedQty(productId, branchId, ignoreOrder), 0);

  /** Add a document up from its lines, the one place that does it. */
  const addUp = (doc: { discountPct: number; lines: DemoDocLine[] }) => {
    const sub = roundTaka(doc.lines.filter((l) => !l.cancelled)
      .reduce((n, l) => n + l.lineTotal, 0));
    const discount = roundTaka((sub * doc.discountPct) / 100);
    return { subtotal: sub, discountAmount: discount, vatAmount: 0,
             total: roundTaka(sub - discount) };
  };

  // --- HR (P14b) --------------------------------------------------------------
  // An employee is not a login: a delivery boy has no `staff` row and still has to be
  // paid and marked present. The attendance a person records themselves is kept apart
  // from a manager's word, because they are not the same kind of evidence.
  interface DemoEmployee {
    id: string; code: string | null; name: string; phone: string | null;
    address: string | null; nid: string | null; joinedOn: string;
    branchId: string | null; departmentId: string | null; designationId: string | null;
    positionId: string | null; professionId: string | null;
    emergencyName: string | null; emergencyPhone: string | null;
    religion: string | null; nationality: string | null;
    staffId: string | null; active: boolean; leftOn: string | null; note: string | null;
    // P14c: a rep is an employee with a territory and a commission.
    isRep?: boolean; commissionPct?: number; commissionOn?: string;
  }
  interface DemoAttendance {
    employeeId: string; branchId: string; onDate: string;
    inAt: string | null; outAt: string | null; status: AttendanceStatus;
    source: "self" | "manager"; minutesLate: number; note: string | null;
    markedBy: string | null;
  }
  interface DemoLeave {
    id: string; employeeId: string; leaveTypeId: string; fromDate: string; toDate: string;
    days: number; reason: string | null; status: "asked" | "approved" | "refused" | "cancelled";
    note: string | null; decidedBy: string | null;
  }
  interface DemoSalaryTerms {
    employeeId: string; basic: number; allowances: Record<string, number>;
    dailyRate: number;
  }
  interface DemoSalaryLine {
    id: string; employeeId: string; basic: number; allowances: number;
    absentDays: number; absenceCut: number; advanceCut: number; otherCut: number;
    daysWorked: number; daysInMonth: number; net: number;
  }
  interface DemoSheet {
    id: string; month: string; branchId: string | null; status: "draft" | "paid";
    total: number; paidOn: string | null; method: string | null; note: string | null;
    who: string; lines: DemoSalaryLine[];
  }
  const employees: DemoEmployee[] = [];
  const attendance: DemoAttendance[] = [];
  const leaveRequests: DemoLeave[] = [];
  const salaryTerms: DemoSalaryTerms[] = [];
  const salaryAdvances: { id: string; employeeId: string; amount: number; method: string;
                          takenOn: string; settledMonth: string | null }[] = [];
  const salarySheets: DemoSheet[] = [];
  // When each branch opens, and the code it takes check-ins with.
  const attendanceSettings: Record<string, { opensAt: string; graceMinutes: number;
                                             pin: string | null }> = {};
  for (const b of branches) attendanceSettings[b.id] = { opensAt: "10:00", graceMinutes: 15, pin: null };

  /** Is the shop shut that day? Demo mode keeps no holiday list, so never. */
  const holidaysOn = (): boolean => false;

  const hrAllowed = (): void => {
    if (!features.hr) fail("FEATURE_OFF:hr");
    if (staff.role === "cashier") fail("NOT_ALLOWED:manage_hr");
  };
  const payAllowed = (): void => {
    if (staff.role !== "owner") fail("NOT_ALLOWED:see_salary");
  };
  const nameOfList = (table: SettingTable, id: string | null): string | null =>
    id ? ((lists[table].find((r) => r.id === id)?.name as string | undefined) ?? null) : null;

  // --- Sales reps, dealers and delivery points (P14c) -------------------------
  // A rep is an employee with a territory, and a sale counts towards them if they made
  // it OR it went to one of their customers — matched on ids, never on names.
  interface DemoRepTarget {
    employeeId: string; month: string; targetAmount: number; targetQty: number;
  }
  interface DemoDeliveryPoint {
    id: string; customerId: string; name: string; address: string | null;
    contactName: string | null; contactPhone: string | null; isDefault: boolean;
    active: boolean; note: string | null;
  }
  const repAreas: { employeeId: string; districtId: number | null;
                    upazilaId: number | null }[] = [];
  const repTargets: DemoRepTarget[] = [];
  const deliveryPoints: DemoDeliveryPoint[] = [];
  const deposits: { id: string; customerId: string; amount: number; method: string;
                    at: string }[] = [];
  const depositHeld = (customerId: string): number =>
    roundTaka(deposits.filter((d) => d.customerId === customerId)
      .reduce((n, d) => n + d.amount, 0));

  const distributionOn = (): void => {
    if (!features.distribution) fail("FEATURE_OFF:distribution");
  };
  const mayManageCustomers = (): void => {
    if (staff.role === "cashier") fail("NOT_ALLOWED:manage_customers");
  };

  const api: Backend = {
    mode: "demo",
    async currentStaff(): Promise<StaffLookup> {
      // Built fresh, not once: the owner can change the shop's name or upload a logo
      // in Settings, and the next printout has to carry it.
      return { kind: "ok", staff: { ...staff, shopName: shopDetails.name, letterhead: {
        shopName: shopDetails.name, logoUrl: shopDetails.logoUrl,
        address: shopDetails.address, phone: shopDetails.phone,
        email: shopDetails.email, binVat: shopDetails.binVat,
      } } };
    },
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
        // The trader flags (P14c), enforced at the till rather than shown as a note
        // somebody has to notice.
        if (buyer.blocked) fail(`CUSTOMER_BLOCKED:${buyer.blockReason ?? "no reason given"}`);
        if (buyer.cashOnly) fail(`CUSTOMER_IS_CASH_ONLY:${buyer.name ?? buyer.phone}`);
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
      // The cost AT THIS MOMENT, captured per line (P12): working profit out from
      // today's cost would be wrong by however much costs have moved since.
      const costAtSale: Record<string, number | null> = {};
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
      for (const l of detailLines) costAtSale[l.id] = costs[l.productId] ?? null;
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
        lineCosts: costAtSale,
      });
      // The books keep themselves, the way the sales_post_to_accounts trigger does.
      postSale(sales[0]);

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

    async setFeature(feature: FeatureKey, enabled: boolean) {
      features[feature] = enabled;
      rememberFeatures();
    },

    async saveShopDetails(values) {
      Object.assign(shopDetails, {
        name: (values.name as string)?.trim() || shopDetails.name,
        address: values.address !== undefined ? (values.address as string) : shopDetails.address,
        phone: values.phone !== undefined ? (values.phone as string) : shopDetails.phone,
        email: values.email !== undefined ? (values.email as string) : shopDetails.email,
        binVat: values.bin_vat !== undefined ? (values.bin_vat as string) : shopDetails.binVat,
        logoUrl: values.logo_url !== undefined ? (values.logo_url as string | null) : shopDetails.logoUrl,
        receiptFooter: values.receipt_footer !== undefined ? (values.receipt_footer as string) : shopDetails.receiptFooter,
        invoicePrefix: (values.invoice_prefix as string)?.toUpperCase() || shopDetails.invoicePrefix,
        aitPct: values.ait_pct !== undefined ? Number(values.ait_pct) || 0 : shopDetails.aitPct,
        poApprovalLimit: values.po_approval_limit !== undefined
          ? Number(values.po_approval_limit) || 0 : shopDetails.poApprovalLimit,
        soApprovalLimit: values.so_approval_limit !== undefined
          ? Number(values.so_approval_limit) || 0 : shopDetails.soApprovalLimit,
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
        voucherApproval: values.voucher_approval !== undefined
          ? Boolean(values.voucher_approval) : shopDetails.voucherApproval,
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
      // One code, one product: it is what a barcode scan matches on.
      const wantedCode = String(v.code ?? "").trim();
      if (wantedCode) {
        const taken = catalogue.find(
          (x) => x.id !== id && x.code.toLowerCase() === wantedCode.toLowerCase());
        if (taken) fail(`PRODUCT_CODE_TAKEN:${taken.name}`);
      }
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
      const asOf = input.asOf ?? dhakaToday();
      if (asOf > dhakaToday()) fail("OPENING_DATE_IN_FUTURE");
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

    // --- The owner dashboard (P12) ---

    async dashboard(branchId, from, to): Promise<Dashboard> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      if (branchId) branchOr404(branchId);
      const fromDate = from ?? dhakaToday();
      const toDate = to ?? dhakaToday();
      if (toDate < fromDate) fail("BAD_DATE_RANGE");

      const days = Math.round(
        (new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86_400_000) + 1;
      const shift = (d: string, by: number) =>
        new Date(new Date(d).getTime() + by * 86_400_000).toISOString().slice(0, 10);

      const inScope = (s: DemoSale) =>
        s.status === "completed" && (!branchId || s.branchId === branchId);
      const between = (s: DemoSale, a: string, b: string) =>
        dhakaDate(s.createdAt) >= a && dhakaDate(s.createdAt) <= b;

      // Profit per line: what was charged after its share of the discount, less what the
      // goods cost ON THE DAY. A line with no captured cost earns nothing rather than
      // everything — the mistake that makes every report look wonderful.
      const lineProfit = (s: DemoSale, l: SaleDetailLine) => {
        const cost = s.lineCosts[l.id];
        const charged = Math.round(l.lineTotal * (100 - s.discountPct)) / 100;
        return cost == null ? null : charged - cost * l.qty;
      };
      const totalsFor = (a: string, b: string) => {
        const mine = sales.filter((s) => inScope(s) && between(s, a, b));
        const salesTotal = mine.reduce((n, s) => n + s.total, 0);
        const profit = mine.reduce(
          (n, s) => n + s.items.reduce((m, l) => m + (lineProfit(s, l) ?? 0), 0), 0);
        const noCost = mine.reduce(
          (n, s) => n + s.items.filter((l) => s.lineCosts[l.id] == null).length, 0);
        return {
          sales: roundTaka(salesTotal), profit: roundTaka(profit),
          saleCount: mine.length,
          averageSale: mine.length > 0 ? roundTaka(salesTotal / mine.length) : 0,
          linesWithoutCost: noCost,
        };
      };

      const today = totalsFor(fromDate, toDate);
      const before = totalsFor(shift(fromDate, -days), shift(fromDate, -1));
      const weekBefore = totalsFor(shift(fromDate, -7), shift(toDate, -7));
      const mine = sales.filter((s) => inScope(s) && between(s, fromDate, toDate));

      const byMethod: Record<string, number> = {};
      for (const s of mine) byMethod[s.paymentMethod] = (byMethod[s.paymentMethod] ?? 0) + s.total;

      const perProduct = new Map<string, {
        product: string; qty: number; sales: number; profit: number;
      }>();
      for (const s of mine) {
        for (const l of s.items) {
          const was = perProduct.get(l.productId)
            ?? { product: l.name, qty: 0, sales: 0, profit: 0 };
          was.qty += l.qty;
          was.sales += Math.round(l.lineTotal * (100 - s.discountPct)) / 100;
          was.profit += lineProfit(s, l) ?? 0;
          perProduct.set(l.productId, was);
        }
      }

      const perStaff = new Map<string, {
        staff: string; sales: number; saleCount: number; discountGiven: number; profit: number;
      }>();
      for (const s of mine) {
        const was = perStaff.get(s.staffId)
          ?? { staff: s.staff, sales: 0, saleCount: 0, discountGiven: 0, profit: 0 };
        was.sales += s.total;
        was.saleCount += 1;
        was.discountGiven += s.discountAmount;
        was.profit += s.items.reduce((m, l) => m + (lineProfit(s, l) ?? 0), 0);
        perStaff.set(s.staffId, was);
      }

      const hours = new Map<number, { sales: number; count: number }>();
      for (const s of sales) {
        if (!inScope(s)) continue;
        if (dhakaDate(s.createdAt) < shift(dhakaToday(), -6)) continue;
        const h = new Date(s.createdAt).getHours();
        const was = hours.get(h) ?? { sales: 0, count: 0 };
        was.sales += s.total;
        was.count += 1;
        hours.set(h, was);
      }

      const branchRows = branches.filter((b) => b.active).map((b) => {
        const theirs = sales.filter(
          (s) => s.status === "completed" && s.branchId === b.id && between(s, fromDate, toDate));
        return {
          branchId: b.id, branch: b.name,
          sales: roundTaka(theirs.reduce((n, s) => n + s.total, 0)),
          profit: roundTaka(theirs.reduce(
            (n, s) => n + s.items.reduce((m, l) => m + (lineProfit(s, l) ?? 0), 0), 0)),
          saleCount: theirs.length,
        };
      });

      const forBranches = branchId ? [branchId] : branches.filter((b) => b.active).map((b) => b.id);
      const lowStock = forBranches.flatMap((bid) =>
        productsAt(bid)
          .filter((p) => p.stock <= p.reorderLevel)
          .map((p) => ({
            productId: p.id, product: p.name, code: p.code,
            branch: branches.find((b) => b.id === bid)?.name ?? "",
            branchId: bid, stock: p.stock, reorderLevel: p.reorderLevel,
            sold30: movements
              .filter((m) => m.product === p.name && m.reason === "sale")
              .reduce((n, m) => n - m.change, 0),
            elsewhere: branches
              .filter((b) => b.id !== bid && b.active)
              .map((b) => ({
                branch: b.name,
                qty: productsAt(b.id).find((x) => x.id === p.id)?.stock ?? 0,
              }))
              .filter((x) => x.qty > 0),
          })))
        .slice(0, 25);

      // Money sitting on a shelf: nothing sold in 60 days, valued at what it cost.
      const soldLately = new Set(
        sales
          .filter((s) => dhakaDate(s.createdAt) >= shift(dhakaToday(), -60))
          .flatMap((s) => s.items.map((l) => l.productId)));
      const dustyStock = catalogue
        .map((p) => {
          const stockHere = forBranches.reduce(
            (n, bid) => n + (productsAt(bid).find((x) => x.id === p.id)?.stock ?? 0), 0);
          const cost = costs[p.id] ?? null;
          return {
            productId: p.id, product: p.name, code: p.code, stock: stockHere,
            cost, tiedUp: roundTaka(stockHere * (cost ?? 0)), lastSold: null as string | null,
          };
        })
        .filter((x) => x.stock > 0 && !soldLately.has(x.productId))
        .sort((a, b) => b.tiedUp - a.tiedUp)
        .slice(0, 25);

      return {
        from: fromDate, to: toDate, days,
        branchId: branchId ?? null,
        branch: branchId ? branches.find((b) => b.id === branchId)?.name ?? null : null,
        today,
        before: {
          sales: before.sales, profit: before.profit, saleCount: before.saleCount,
          from: shift(fromDate, -days), to: shift(fromDate, -1),
        },
        weekBefore: {
          sales: weekBefore.sales, profit: weekBefore.profit,
          from: shift(fromDate, -7), to: shift(toDate, -7),
        },
        branches: branchRows.sort((a, b) => b.sales - a.sales),
        byMethod,
        summary: {
          cashSales: roundTaka(mine.filter((s) => s.paymentMethod !== "due")
            .reduce((n, s) => n + (s.total - s.dueAmount), 0)),
          creditSales: roundTaka(mine.reduce((n, s) => n + s.dueAmount, 0)),
          salesReturns: roundTaka(mine.reduce(
            (n, s) => n + s.returns.reduce((m, r) => m + r.total, 0), 0)),
          cashPurchases: roundTaka(deliveries.filter((d) => !d.isCredit)
            .reduce((n, d) => n + d.total, 0)),
          creditPurchases: roundTaka(deliveries.filter((d) => d.isCredit)
            .reduce((n, d) => n + d.total, 0)),
          purchaseReturns: 0,
          claimsTaken: claims.filter(
            (c) => dhakaDate(c.createdAt) >= fromDate && dhakaDate(c.createdAt) <= toDate).length,
          moneyIn: roundTaka(customerPayments
            .filter((p) => dhakaDate(p.at) >= fromDate && dhakaDate(p.at) <= toDate)
            .reduce((n, p) => n + p.amount, 0)),
          moneyOut: 0,
        },
        busyHours: [...hours.entries()]
          .map(([hour, v]) => ({ hour, sales: roundTaka(v.sales), count: v.count }))
          .sort((a, b) => a.hour - b.hour),
        bestByProfit: [...perProduct.entries()]
          .map(([productId, v]) => ({
            productId, product: v.product, qty: v.qty,
            sales: roundTaka(v.sales), profit: roundTaka(v.profit),
          }))
          .sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0))
          .slice(0, 10),
        bestByQty: [...perProduct.entries()]
          .map(([productId, v]) => ({
            productId, product: v.product, qty: v.qty, sales: roundTaka(v.sales),
          }))
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 10),
        staff: [...perStaff.entries()]
          .map(([staffId, v]) => ({
            staffId, staff: v.staff, sales: roundTaka(v.sales), saleCount: v.saleCount,
            discountGiven: roundTaka(v.discountGiven), profit: roundTaka(v.profit),
          }))
          .sort((a, b) => b.sales - a.sales),
        lowStock,
        dustyStock,
        owed: {
          byCustomers: roundTaka(customers.reduce((n, c) => n + Math.max(dueFor(c.id), 0), 0)),
          toSuppliers: roundTaka(suppliers.filter((s) => !s.isCashOnly)
            .reduce((n, s) => n + Math.max(s.balance, 0), 0)),
        },
        // The demo has no audit log of its own; the real one reads audit_log.
        watch: [],
      };
    },

    async dashboardDetail(kind, branchId, from, to): Promise<DashboardDetailRow[]> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      const kinds = ["sales", "profit", "returns", "dues", "supplier_dues"];
      if (!kinds.includes(kind)) fail(`BAD_DETAIL_KIND:${kind}`);
      const fromDate = from ?? dhakaToday();
      const toDate = to ?? dhakaToday();

      if (kind === "sales" || kind === "profit") {
        return sales
          .filter((s) => s.status === "completed"
            && (!branchId || s.branchId === branchId)
            && dhakaDate(s.createdAt) >= fromDate
            && dhakaDate(s.createdAt) <= toDate)
          .map((s) => ({
            id: s.id, invoice_no: s.invoiceNo, at: s.createdAt, branch: s.branch,
            staff: s.staff, customer: s.customerName ?? s.customerPhone,
            total: s.total, discount: s.discountAmount,
            payment_method: s.paymentMethod,
            profit: roundTaka(s.items.reduce((n, l) => {
              const cost = s.lineCosts[l.id];
              if (cost == null) return n;
              return n + Math.round(l.lineTotal * (100 - s.discountPct)) / 100 - cost * l.qty;
            }, 0)),
            lines_without_cost: s.items.filter((l) => s.lineCosts[l.id] == null).length,
            items: s.items.map((l) => l.name).join(", "),
          }));
      }
      if (kind === "returns") {
        return sales.flatMap((s) => s.returns.map((r) => ({
          id: r.id, return_no: r.returnNo, at: r.createdAt, branch: r.branch,
          invoice_no: s.invoiceNo, total: r.total, refund_method: r.refundMethod,
          reason: r.reason, customer: s.customerName ?? s.customerPhone,
        })));
      }
      if (kind === "dues") {
        return customers
          .filter((c) => dueFor(c.id) > 0)
          .map((c) => ({
            id: c.id, name: c.name, phone: c.phone, company: c.company,
            owed: dueFor(c.id), payment_days: c.paymentDays,
          }));
      }
      return suppliers
        .filter((s) => !s.isCashOnly && s.balance > 0)
        .map((s) => ({ id: s.id, name: s.name, phone: s.phone, owed: s.balance }));
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
              soldOn: dhakaDate(sale.createdAt),
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
          soldOn: c.deliveredAt ? dhakaDate(c.deliveredAt) : null,
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
        lastPriceToCustomerOn: theirs[0] ? dhakaDate(theirs[0].createdAt) : null,
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
              .map((s) => dhakaDate(s.createdAt)).sort()[0] ?? null,
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
            serial: x.serial, product: i.name, bought: dhakaDate(s.createdAt),
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
        .filter((s) => (mine ? dhakaDate(s.createdAt) === today : true))
        .filter((s) => (input.branchId ? s.branchId === input.branchId : true))
        .filter((s) => (input.staffId && !mine ? s.staffId === input.staffId : true))
        .filter((s) => (input.method ? s.paymentMethod === input.method : true))
        .filter((s) => (input.status ? s.status === input.status : true))
        .filter((s) => (input.from ? dhakaDate(s.createdAt) >= input.from : true))
        .filter((s) => (input.to ? dhakaDate(s.createdAt) <= input.to : true))
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
        Math.floor((new Date(today).getTime() - new Date(dhakaDate(sale!.createdAt)).getTime())
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
        sameDay: dhakaDate(sale!.createdAt) === today,
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
      periodOpen(sale!.createdAt);
      if (dhakaDate(sale!.createdAt) !== dhakaToday()) fail("VOID_TOO_LATE");
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
      periodOpen(new Date().toISOString());

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
          openingCash: s.openingCash,
          // An open drawer has no counted figure yet, so show where it stands now —
          // the same thing shift_list() does with expected_cash() in the database.
          expectedCash: s.closedAt
            ? s.expectedCash
            : s.openingCash + (s.byMethod.cash ?? 0) + s.cashIn - s.cashOut,
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

    // --- Accounts (P13) ---

    async chartOfAccounts(): Promise<ChartAccount[]> {
      accountsOn();
      return accounts.map((a) => ({
        id: a.id, code: a.code, name: a.name, role: a.role, group: a.group,
        nature: a.nature, active: a.active, branchId: a.branchId,
        branch: branches.find((b) => b.id === a.branchId)?.name ?? null,
      })).sort((x, y) => x.code.localeCompare(y.code));
    },

    async trialBalance(branchId, from, to): Promise<TrialBalance> {
      accountsOn();
      const within = (e: DemoEntry) =>
        e.status === "posted"
        && (!from || e.date >= from) && (!to || e.date <= to)
        && (!branchId || e.branchId === branchId);
      const rows: TrialBalanceRow[] = [];
      for (const a of accounts) {
        let debit = 0;
        let credit = 0;
        for (const e of journal.filter(within)) {
          for (const l of e.lines.filter((x) => x.accountId === a.id)) {
            debit += l.debit;
            credit += l.credit;
          }
        }
        if (debit === 0 && credit === 0) continue;
        rows.push({
          accountId: a.id, code: a.code, name: a.name, group: a.group, nature: a.nature,
          branch: branches.find((b) => b.id === a.branchId)?.name ?? null,
          debit: roundTaka(debit), credit: roundTaka(credit),
          // Assets and expenses are "up" on the debit side; everything else the other way.
          balance: roundTaka(["asset", "expense"].includes(a.nature)
            ? debit - credit : credit - debit),
        });
      }
      rows.sort((x, y) => x.code.localeCompare(y.code));
      const totalDebit = roundTaka(rows.reduce((t, r) => t + r.debit, 0));
      const totalCredit = roundTaka(rows.reduce((t, r) => t + r.credit, 0));
      return {
        from: from ?? null, to: to ?? null,
        branch: branches.find((b) => b.id === branchId)?.name ?? null,
        accounts: rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit,
      };
    },

    async accountLedger(accountId, from, to, branchId): Promise<AccountLedger> {
      accountsOn();
      const acc = accounts.find((a) => a.id === accountId);
      if (!acc) fail("ACCOUNT_NOT_FOUND");
      const up = ["asset", "expense"].includes(acc!.nature) ? 1 : -1;
      const mine = (e: DemoEntry) =>
        e.status === "posted" && (!branchId || e.branchId === branchId);
      let opening = 0;
      const lines: LedgerLine[] = [];
      for (const e of journal.filter(mine)) {
        for (const l of e.lines.filter((x) => x.accountId === accountId)) {
          if (from && e.date < from) { opening += up * (l.debit - l.credit); continue; }
          if (to && e.date > to) continue;
          lines.push({
            entryId: e.id, entryNo: e.entryNo, date: e.date, narration: e.narration,
            sourceKind: e.sourceKind, sourceId: e.sourceId,
            branch: branches.find((b) => b.id === l.branchId)?.name ?? null,
            debit: l.debit, credit: l.credit, note: l.note,
            party: customers.find((c) => c.id === l.customerId)?.name
              ?? suppliers.find((x) => x.id === l.supplierId)?.name ?? null,
            who: e.who,
          });
        }
      }
      lines.sort((x, y) => x.date.localeCompare(y.date));
      return {
        account: {
          id: acc!.id, code: acc!.code, name: acc!.name, nature: acc!.nature,
          branch: branches.find((b) => b.id === acc!.branchId)?.name ?? null,
        },
        opening: roundTaka(opening), lines,
      };
    },

    async voucherList(input = {}): Promise<VoucherRow[]> {
      accountsOn();
      const from = input.from ?? dhakaDate(daysAgo(30));
      const to = input.to ?? dhakaToday();
      return journal
        .filter((e) => e.date >= from && e.date <= to
          && (!input.branchId || e.branchId === input.branchId
              || e.otherBranchId === input.branchId)
          && (!input.status || e.status === input.status)
          && (!input.source || e.sourceKind === input.source))
        .sort((x, y) => y.date.localeCompare(x.date) || Number(y.id.slice(3)) - Number(x.id.slice(3)))
        .map(toVoucherRow);
    },

    async moneyBalances(branchId): Promise<MoneyBalance[]> {
      accountsOn();
      return accounts
        .filter((a) => a.active && ["cash_in_hand", "bank", "wallet"].includes(a.role ?? "")
          && (!branchId || a.branchId === null || a.branchId === branchId))
        .map((a) => {
          let balance = 0;
          for (const e of journal.filter((x) => x.status === "posted"
                                           && (!branchId || x.branchId === branchId))) {
            for (const l of e.lines.filter((x) => x.accountId === a.id)) {
              balance += l.debit - l.credit;
            }
          }
          const out = cheques.filter((c) => c.bankAccountId === a.bankAccountId
            && c.direction === "issued" && c.status === "issued");
          const inn = cheques.filter((c) => c.bankAccountId === a.bankAccountId
            && c.direction === "received" && c.status === "issued");
          return {
            accountId: a.id, code: a.code, name: a.name, role: a.role,
            branch: branches.find((b) => b.id === a.branchId)?.name ?? null,
            bankAccountId: a.bankAccountId,
            balance: roundTaka(balance),
            unclearedOut: roundTaka(out.reduce((t, c) => t + c.amount, 0)),
            unclearedIn: roundTaka(inn.reduce((t, c) => t + c.amount, 0)),
          };
        })
        .sort((x, y) => x.code.localeCompare(y.code));
    },

    async saveVoucher(input): Promise<{ id: string; entryNo: string; status: string }> {
      accountsOn();
      branchOr404(input.branchId);
      const status: EntryStatus = shopDetails.voucherApproval ? "awaiting_approval" : "posted";
      let lines: Parameters<typeof post>[0]["lines"];
      if (input.kind === "journal") {
        if (!input.lines?.length) fail("VOUCHER_NEEDS_LINES");
        lines = input.lines!.map((l) => ({
          accountId: l.accountId, debit: l.debit ?? 0, credit: l.credit ?? 0,
          note: l.note ?? null, customerId: l.customerId ?? null,
          supplierId: l.supplierId ?? null,
        }));
      } else {
        if (!(input.amount && input.amount > 0)) fail("BAD_PAYMENT_AMOUNT");
        if (!input.fromAccount || !input.toAccount) fail("VOUCHER_NEEDS_TWO_ACCOUNTS");
        // A receipt brings money in, a payment sends it out, a contra moves it between
        // the shop's own pockets. All three are two accounts and one amount.
        const debit = input.kind === "payment" ? input.toAccount : input.toAccount;
        const credit = input.fromAccount;
        lines = [
          { accountId: debit, debit: input.amount!, customerId: input.customerId ?? null,
            supplierId: input.supplierId ?? null },
          { accountId: credit, credit: input.amount! },
        ];
      }
      const entry = post({
        branchId: input.branchId, date: input.date ?? null,
        narration: input.narration ?? `${input.kind} voucher`,
        sourceKind: "voucher", status, lines,
      });
      return { id: entry.id, entryNo: entry.entryNo, status };
    },

    async approveVoucher(entryId, approve, reason): Promise<void> {
      accountsOn();
      const e = journal.find((x) => x.id === entryId);
      if (!e) fail("ENTRY_NOT_FOUND");
      if (e!.status !== "awaiting_approval") fail("VOUCHER_NOT_WAITING");
      e!.status = approve ? "posted" : "cancelled";
      e!.narration = reason ? `${e!.narration} — ${reason}` : e!.narration;
    },

    async reverseEntry(entryId, reason): Promise<{ entryNo: string }> {
      accountsOn();
      if (!reason?.trim()) fail("REVERSAL_REASON_REQUIRED");
      const e = journal.find((x) => x.id === entryId);
      if (!e) fail("ENTRY_NOT_FOUND");
      if (e!.status !== "posted") fail("ONLY_POSTED_ENTRIES_REVERSE");
      if (journal.some((x) => x.reversesId === e!.id)) fail("ALREADY_REVERSED");
      // A mirror image. The first entry is never touched: that is what an audit trail is.
      const mirror = post({
        branchId: e!.branchId, narration: `Reversal of ${e!.entryNo}: ${reason}`,
        sourceKind: "reversal", sourceId: e!.id,
        lines: e!.lines.map((l) => ({
          accountId: l.accountId, branchId: l.branchId,
          debit: l.credit, credit: l.debit, note: l.note,
          customerId: l.customerId, supplierId: l.supplierId,
        })),
      });
      mirror.reversesId = e!.id;
      return { entryNo: mirror.entryNo };
    },

    async interBranchEntry(input): Promise<{ id: string; entryNo: string; waitingOn: string | null }> {
      accountsOn();
      branchOr404(input.fromBranchId);
      if (input.fromBranchId === input.toBranchId) fail("SAME_BRANCH");
      if (!(input.amount > 0)) fail("BAD_PAYMENT_AMOUNT");
      const to = branches.find((b) => b.id === input.toBranchId && b.active);
      if (!to) fail("BRANCH_NOT_FOUND");
      const entry = post({
        branchId: input.fromBranchId,
        narration: input.narration ?? "Sent to another branch",
        sourceKind: "fund_transfer", otherBranchId: input.toBranchId,
        lines: [
          { role: "inter_branch", debit: input.amount, note: "Owed by the other branch" },
          { accountId: input.fromAccount
              ?? accountFor("cash_in_hand", input.fromBranchId)?.id,
            credit: input.amount },
        ],
      });
      entry.interKind = input.kind ?? "fund";
      entry.interAccountId = input.toAccount ?? null;
      return { id: entry.id, entryNo: entry.entryNo, waitingOn: to!.name };
    },

    async acceptInterBranch(entryId): Promise<{ accepted: string; amount: number }> {
      accountsOn();
      const e = journal.find((x) => x.id === entryId);
      if (!e) fail("ENTRY_NOT_FOUND");
      if (!e!.otherBranchId) fail("NOT_INTER_BRANCH");
      if (e!.acceptedAt) fail("ALREADY_ACCEPTED");
      const amount = roundTaka(e!.lines.reduce((t, l) => t + l.debit, 0));
      // Money sent is money received; a bill paid for them is their expense, not cash
      // they can count. The sender said which it was.
      post({
        branchId: e!.otherBranchId!,
        narration: `Received from ${branches.find((b) => b.id === e!.branchId)?.name ?? "another branch"}`,
        sourceKind: "fund_transfer", sourceId: e!.id,
        lines: [
          { accountId: e!.interAccountId
              ?? accountFor("cash_in_hand", e!.otherBranchId)?.id,
            debit: amount },
          { role: "inter_branch", credit: amount, note: `Settled with ${e!.entryNo}` },
        ],
      });
      e!.acceptedAt = new Date().toISOString();
      return { accepted: e!.entryNo, amount };
    },

    async listCheques(input = {}): Promise<ChequeRow[]> {
      accountsOn();
      const today = dhakaToday();
      return cheques
        .filter((c) => (!input.direction || c.direction === input.direction)
          && (!input.status || c.status === input.status)
          && (!input.from || c.chequeDate >= input.from)
          && (!input.to || c.chequeDate <= input.to))
        .map((c) => ({ ...c, overdue: c.status === "issued" && c.chequeDate < today }))
        .sort((x, y) => y.chequeDate.localeCompare(x.chequeDate));
    },

    async listChequeBooks(): Promise<ChequeBookRow[]> {
      accountsOn();
      return chequeBooks.map((b) => ({
        ...b, left: Math.max(b.lastNumber - b.nextNumber + 1, 0),
      }));
    },

    async saveChequeBook(bankAccountId, first, last, prefix): Promise<void> {
      accountsOn();
      if (!(first > 0) || last < first) fail("BAD_CHEQUE_RANGE");
      const bank = lists.bank_accounts.find((b) => b.id === bankAccountId);
      if (!bank) fail("ACCOUNT_NOT_FOUND");
      chequeBooks.push({
        id: `cb-${chequeBooks.length + 1}`, bankAccountId,
        bank: String(bank!.name), prefix: prefix?.trim() || null,
        firstNumber: first, lastNumber: last, nextNumber: first, active: true,
        left: last - first + 1, shopPrefix: prefix?.trim() || null,
      });
    },

    async saveCheque(input): Promise<{ id: string; chequeNo: string; amount: number }> {
      accountsOn();
      branchOr404(input.branchId);
      if (!["issued", "received"].includes(input.direction)) {
        fail(`BAD_CHEQUE_DIRECTION:${input.direction}`);
      }
      if (!(input.amount > 0)) fail("BAD_PAYMENT_AMOUNT");
      if (input.direction === "issued" && !input.supplierId && !input.payee?.trim()) {
        fail("CHEQUE_NEEDS_PAYEE");
      }
      let no = input.chequeNo?.trim() || null;
      const book = chequeBooks.find((b) => b.id === input.bookId);
      if (input.direction === "issued" && !no) {
        if (!book) fail("CHEQUE_NEEDS_NUMBER");
        if (book!.nextNumber > book!.lastNumber) fail("CHEQUE_BOOK_FINISHED");
        no = `${book!.prefix ?? ""}${book!.nextNumber}`;
        book!.nextNumber += 1;
      }
      if (!no) fail("CHEQUE_NEEDS_NUMBER");
      const bankAccountId = input.bankAccountId ?? book?.bankAccountId ?? null;

      // A cheque is a promise, not money: it posts against the party now, and the bank
      // balance only moves when it clears. A payment already on the books takes its own
      // entry rather than a second one, or paying by cheque would post twice.
      let entryId: string | null = null;
      if (!input.supplierPaymentId && !input.customerPaymentId) {
        if (input.direction === "issued" && input.supplierId) {
          entryId = post({
            branchId: input.branchId, date: input.chequeDate,
            narration: `Cheque ${no} to supplier`, sourceKind: "cheque",
            lines: [
              { role: "payable", debit: input.amount, supplierId: input.supplierId },
              { role: "bank", credit: input.amount, note: `Cheque ${no}` },
            ],
          }).id;
        } else if (input.direction === "received" && input.customerId) {
          entryId = post({
            branchId: input.branchId, date: input.chequeDate,
            narration: `Cheque ${no} from customer`, sourceKind: "cheque",
            lines: [
              { role: "bank", debit: input.amount, note: `Cheque ${no}` },
              { role: "receivable", credit: input.amount, customerId: input.customerId },
            ],
          }).id;
        }
      }

      const id = `cq-${cheques.length + 1}`;
      cheques.push({
        id, direction: input.direction, chequeNo: no!, amount: input.amount,
        chequeDate: input.chequeDate, status: "issued",
        payee: input.payee ?? suppliers.find((x) => x.id === input.supplierId)?.name ?? null,
        drawnOn: input.drawnOn ?? null,
        bank: lists.bank_accounts.find((b) => b.id === bankAccountId)?.name as string ?? null,
        branch: branches.find((b) => b.id === input.branchId)?.name ?? null,
        customerId: input.customerId ?? null, supplierId: input.supplierId ?? null,
        bouncedReason: null, clearedAt: null, note: input.note ?? null, who: staff.name,
        overdue: false, branchId: input.branchId, bankAccountId,
        bookId: input.bookId ?? null, entryId,
      });
      return { id, chequeNo: no!, amount: input.amount };
    },

    async setChequeStatus(chequeId, status, reason): Promise<{ chequeNo: string; status: ChequeStatus; reversed: boolean }> {
      accountsOn();
      const c = cheques.find((x) => x.id === chequeId);
      if (!c) fail("CHEQUE_NOT_FOUND");
      if (c!.status !== "issued") fail(`CHEQUE_ALREADY_SETTLED:${c!.status}`);
      if (!["cleared", "bounced", "cancelled"].includes(status)) {
        fail(`BAD_CHEQUE_STATUS:${status}`);
      }
      if (status === "bounced" && !reason?.trim()) fail("BOUNCE_REASON_REQUIRED");
      c!.status = status;
      c!.clearedAt = status === "cleared" ? new Date().toISOString() : null;
      c!.bouncedReason = status === "bounced" ? reason! : null;
      // A bounce means the money never arrived, so the books must stop saying it did.
      const reversed = ["bounced", "cancelled"].includes(status) && Boolean(c!.entryId);
      if (reversed) {
        await api.reverseEntry(c!.entryId!, status === "bounced"
          ? `Cheque ${c!.chequeNo} bounced: ${reason}`
          : `Cheque ${c!.chequeNo} cancelled`);
      }
      return { chequeNo: c!.chequeNo, status, reversed };
    },

    async chequePrint(chequeId): Promise<ChequePrint> {
      accountsOn();
      const c = cheques.find((x) => x.id === chequeId);
      if (!c) fail("CHEQUE_NOT_FOUND");
      if (c!.direction !== "issued") fail("ONLY_ISSUED_CHEQUES_PRINT");
      const measured = c!.bankAccountId ? Boolean(chequeLayouts[c!.bankAccountId]) : false;
      return {
        chequeNo: c!.chequeNo, date: c!.chequeDate, payee: c!.payee,
        amount: c!.amount, amountWords: takaInWords(c!.amount), bank: c!.bank,
        measured,
        layout: (c!.bankAccountId && chequeLayouts[c!.bankAccountId]) || DEFAULT_CHEQUE_LAYOUT,
      };
    },

    async saveChequeLayout(bankAccountId, values): Promise<void> {
      accountsOn();
      chequeLayouts[bankAccountId] = {
        ...(chequeLayouts[bankAccountId] ?? DEFAULT_CHEQUE_LAYOUT),
        ...(values as Partial<ChequeLayout>),
      };
    },

    async recordExpense(input): Promise<void> {
      branchOr404(input.branchId);
      if (!(input.amount > 0)) fail("BAD_PAYMENT_AMOUNT");
      if (!input.categoryId) fail("EXPENSE_CATEGORY_REQUIRED");
      const cat = lists.transaction_categories.find((c) => c.id === input.categoryId);
      if (!cat) fail("CATEGORY_NOT_FOUND");
      const method = input.method ?? "cash";
      // Cash out of the drawer is the drawer's business, and P8 already owns that rule.
      if (method === "cash") {
        await api.cashMovement({
          branchId: input.branchId, direction: "out", amount: input.amount,
          reason: "expense", categoryId: input.categoryId,
          note: input.note ?? String(cat!.name),
        });
        if (!features.accounts) return;
        post({
          branchId: input.branchId, date: input.date ?? null,
          narration: input.note ? `${cat!.name} — ${input.note}` : String(cat!.name),
          sourceKind: "cash_movement",
          lines: [
            { accountId: expenseAccountFor(String(cat!.name)), debit: input.amount },
            { role: "cash_in_hand", credit: input.amount },
          ],
        });
        return;
      }
      accountsOn();
      post({
        branchId: input.branchId, date: input.date ?? null,
        narration: input.note ? `${cat!.name} — ${input.note}` : String(cat!.name),
        sourceKind: "expense",
        lines: [
          { accountId: expenseAccountFor(String(cat!.name)), debit: input.amount,
            supplierId: input.supplierId ?? null },
          { accountId: accountForMethod(method, input.branchId)?.id, credit: input.amount },
        ],
      });
    },

    async saveAccount(id, values): Promise<void> {
      accountsOn();
      if (staff.role !== "owner") fail("NOT_OWNER");
      const name = String(values.name ?? "").trim();
      const code = String(values.code ?? "").trim();
      if (id) {
        const a = accounts.find((x) => x.id === id);
        if (!a) fail("ACCOUNT_NOT_FOUND");
        if (name) a!.name = name;
        if (code) a!.code = code;
        if (values.active != null) a!.active = Boolean(values.active);
        return;
      }
      if (!name) fail("NAME_REQUIRED");
      if (!code) fail("ACCOUNT_CODE_REQUIRED");
      const group = String(values.group ?? "Running costs");
      accounts.push({
        id: `ac-${code}`, code, name, role: null, group,
        nature: (values.nature as AccountNature) ?? "expense", active: true,
        branchId: (values.branchId as string | null) ?? null, bankAccountId: null,
      });
    },

    async backfillAccounts(from): Promise<BackfillResult> {
      accountsOn();
      if (staff.role !== "owner") fail("NOT_OWNER");
      // The demo posts as it goes, so there is nothing behind to catch up on. It still
      // posts anything that happened before the switch was turned on.
      let posted = 0;
      for (const sale of sales) {
        if (sale.status !== "completed") continue;
        if (journal.some((e) => e.sourceKind === "sale" && e.sourceId === sale.id)) continue;
        postSale(sale);
        posted += 1;
      }
      // And bring the stock in at what it is worth. A shop that was trading before it
      // switched the books on has stock on its shelves that the books have never heard
      // of, so the stock account would stay negative as sales took goods off it. What
      // IS known is what is on the shelves and what it cost, so the account is brought
      // to that, against the owner's capital — which is what an accountant does when
      // opening books mid-life. The real one does exactly this (backfill_stock_entries).
      const shelf = roundTaka(branches.reduce((total, b) => total
        + catalogue.reduce((n, p) => {
            const loose = stock[b.id]?.[p.id] ?? 0;
            const serialled = serials.filter(
              (x) => x.productId === p.id && x.branchId === b.id && !x.sold && !x.inTransit).length;
            return n + (loose + serialled) * (costs[p.id] ?? 0);
          }, 0), 0));
      const inventory = accounts.find((a) => a.role === "inventory")!;
      const onBooks = roundTaka(journal
        .filter((e) => e.status === "posted")
        .flatMap((e) => e.lines)
        .filter((l) => l.accountId === inventory.id)
        .reduce((n, l) => n + l.debit - l.credit, 0));
      const gap = roundTaka(shelf - onBooks);
      if (gap !== 0) {
        post({
          branchId: branches[0].id,
          narration: "Stock brought in at its counted value",
          sourceKind: "opening_balance",
          lines: gap > 0
            ? [{ accountId: inventory.id, debit: gap },
               { accountId: accounts.find((a) => a.role === "opening_equity")!.id, credit: gap }]
            : [{ accountId: accounts.find((a) => a.role === "opening_equity")!.id, debit: -gap },
               { accountId: inventory.id, credit: -gap }],
        });
      }

      return {
        from: from ?? "2000-01-01", sales: posted, grns: 0, supplierReturns: 0,
        saleReturns: 0, customerPayments: 0, supplierPayments: 0, cashMovements: 0,
        stockBroughtIn: Math.abs(gap),
      };
    },

    // --- Reports, the period lock and export (P14) ---

    async listReports(): Promise<ReportListItem[]> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      return demoReportList(reportData());
    },

    async runReport(key, filters): Promise<ReportResult> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      return runDemoReport(key, filters ?? {}, reportData());
    },

    async saveReportSetting(key, values): Promise<void> {
      if (staff.role !== "owner") fail("NOT_OWNER");
      if (values.reset === true || values.reset === "true") {
        delete reportSettings[key];
        return;
      }
      const got = reportSettings[key] ?? {};
      const title = typeof values.title === "string" ? values.title.trim() : "";
      if (title) got.title = title;
      if (values.sl !== undefined && values.sl !== null) got.sl = Number(values.sl);
      if (values.captions) got.captions = values.captions as Record<string, string>;
      reportSettings[key] = got;
    },

    async lockPeriod(month, locked, note): Promise<void> {
      if (staff.role !== "owner") fail("NOT_OWNER");
      const first = `${month.slice(0, 7)}-01`;
      if (first > dhakaDate(new Date().toISOString())) fail("MONTH_NOT_FINISHED");
      if (locked) {
        const at = new Date().toISOString();
        const got = locks.find((l) => l.month === first);
        if (got) { got.note = note ?? null; got.at = at; } else {
          locks.push({ month: first, note: note ?? null, at, who: staff.name });
        }
      } else {
        // Opening a month again has to be explained, and the reason is kept.
        if (!note || note.trim().length < 3) fail("REASON_REQUIRED");
        const i = locks.findIndex((l) => l.month === first);
        if (i >= 0) locks.splice(i, 1);
      }
    },

    async listPeriodLocks(): Promise<PeriodLock[]> {
      return [...locks].sort((a, b) => b.month.localeCompare(a.month));
    },

    async journalExport(from, to, branchId): Promise<JournalExport> {
      accountsOn();
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_accounts");
      const lines = journal
        .filter((e) => e.status === "posted"
                       && (!from || e.date >= from) && (!to || e.date <= to)
                       && (!branchId || e.branchId === branchId))
        .flatMap((e) => e.lines.map((l) => ({
          date: e.date, entryNo: e.entryNo,
          kind: e.sourceKind === "sale" ? "Sales"
            : e.sourceKind === "grn" ? "Purchase"
            : e.sourceKind.includes("payment") ? "Payment" : "Journal",
          narration: e.narration,
          account: accounts.find((a) => a.id === l.accountId)?.name ?? "—",
          accountCode: accounts.find((a) => a.id === l.accountId)?.code ?? "—",
          party: l.customerId
            ? (customers.find((c) => c.id === l.customerId)?.name ?? "")
            : l.supplierId ? (suppliers.find((x) => x.id === l.supplierId)?.name ?? "") : "",
          debit: l.debit, credit: l.credit, note: l.note ?? "",
          branch: branches.find((b) => b.id === e.branchId)?.name ?? "—",
        })));
      return { shop: DEMO_SHOP_NAME, from: from ?? null, to: to ?? null, lines };
    },


    // --- Quotations, sales orders and challans (P14a) ---

    async listQuotations(input): Promise<QuotationRow[]> {
      return quotations
        .filter((q) => (!input?.branchId || q.branchId === input.branchId)
                       && (!input?.status || q.status === input.status))
        .map((q) => ({
          id: q.id, quoteNo: q.quoteNo, date: dhakaDate(q.createdAt),
          branch: branchOr404(q.branchId).name, branchId: q.branchId,
          customer: q.customerId
            ? (customers.find((c) => c.id === q.customerId)?.name ?? "—")
            : (q.customerName ?? "—"),
          customerId: q.customerId, total: q.total, status: q.status,
          validUntil: q.validUntil,
          outOfDate: Boolean(q.validUntil && q.validUntil < dhakaToday()
                             && ["draft", "sent"].includes(q.status)),
          lines: q.lines.length, who: q.who,
        }))
        .sort((a, b) => b.date.localeCompare(a.date));
    },

    async saveQuotation(id, values, lines) {
      docsOn();
      if (lines.length === 0) fail("EMPTY_SALE");
      const branchId = String(values.branch_id ?? branches[0].id);
      const customerId = (values.customer_id as string | null) ?? null;
      const listId = customerId
        ? (customers.find((c) => c.id === customerId)?.priceListId ?? "pl-retail")
        : "pl-retail";
      const pct = Number(values.discount_pct ?? 0);

      let q = id ? quotations.find((x) => x.id === id) : undefined;
      if (id && !q) fail("QUOTE_NOT_FOUND");
      // Once it has gone out, it is a promise somebody is relying on.
      if (q && q.status !== "draft") fail("QUOTE_NOT_DRAFT");
      if (!q) {
        q = {
          id: crypto.randomUUID(),
          quoteNo: `QT-${branchOr404(branchId).code}-${new Date().getFullYear()}${String(quoteCounter++).padStart(6, "0")}`,
          createdAt: new Date().toISOString(), branchId,
          customerId, customerName: (values.customer_name as string | null) ?? null,
          attention: (values.attention as string | null) ?? null,
          address: (values.address as string | null) ?? null,
          validUntil: (values.valid_until as string | null) ?? null,
          terms: (values.terms as string | null) ?? null,
          note: (values.note as string | null) ?? null,
          discountPct: pct, subtotal: 0, discountAmount: 0, vatAmount: 0, total: 0,
          status: "draft", statusNote: null, who: staff.name, lines: [],
        };
        quotations.unshift(q);
      }
      q.customerId = customerId;
      q.discountPct = pct;
      q.attention = (values.attention as string | null) ?? q.attention;
      q.validUntil = (values.valid_until as string | null) ?? q.validUntil;
      q.terms = (values.terms as string | null) ?? q.terms;
      q.lines = lines.map((l) => {
        const productId = String(l.product_id);
        const product = catalogue.find((x) => x.id === productId);
        if (!product) fail("PRODUCT_NOT_FOUND");
        const qty = Number(l.qty ?? 0);
        if (qty <= 0) fail(`BAD_QTY:${product!.name}`);
        const isFree = Boolean(l.is_free);
        const unitPrice = isFree ? 0
          : Number(l.unit_price ?? priceFor(productId, listId).price);
        const lineDiscount = Number(l.line_discount ?? 0);
        return {
          id: crypto.randomUUID(), productId, qty, unitPrice, lineDiscount, isFree,
          lineTotal: roundTaka(unitPrice * qty - lineDiscount),
          note: (l.note as string | null) ?? null,
        };
      });
      Object.assign(q, addUp(q));
      return { id: q.id, quoteNo: q.quoteNo, total: q.total, status: q.status };
    },

    async setQuotationStatus(id, status, note): Promise<void> {
      const q = quotations.find((x) => x.id === id);
      if (!q) fail("QUOTE_NOT_FOUND");
      if (!["draft", "sent", "accepted", "expired", "lost"].includes(status)) {
        fail(`BAD_QUOTE_STATUS:${status}`);
      }
      // "Lost" wants a reason: to whom, and on what. Otherwise the log teaches nothing.
      if (status === "lost" && !note?.trim()) fail("REASON_REQUIRED");
      q!.status = status as QuotationStatus;
      q!.statusNote = note ?? null;
    },

    async listOrders(input): Promise<OrderRow[]> {
      return orders
        .filter((o) => (!input?.branchId || o.branchId === input.branchId)
                       && (!input?.status || o.status === input.status
                           || (input.status === "open"
                               && ["open", "part_delivered"].includes(o.status))))
        .map((o) => {
          const live = o.lines.filter((l) => !l.cancelled);
          const pending = live.reduce((n, l) => n + Math.max(l.qty - (l.deliveredQty ?? 0), 0), 0);
          const late = Boolean(o.deliveryDate && o.deliveryDate < dhakaToday()
                               && ["open", "part_delivered"].includes(o.status));
          return {
            id: o.id, soNo: o.soNo, date: dhakaDate(o.createdAt),
            branch: branchOr404(o.branchId).name, branchId: o.branchId,
            customer: customers.find((c) => c.id === o.customerId)?.name ?? "—",
            customerId: o.customerId, deliveryDate: o.deliveryDate, status: o.status,
            total: o.total, advance: o.advanceAmount,
            ordered: live.reduce((n, l) => n + l.qty, 0),
            delivered: live.reduce((n, l) => n + (l.deliveredQty ?? 0), 0),
            pending, late,
            daysLate: late && o.deliveryDate
              ? Math.round((Date.parse(dhakaToday()) - Date.parse(o.deliveryDate)) / 86400000)
              : null,
            quoteNo: quotations.find((q) => q.id === o.quoteId)?.quoteNo ?? null,
            who: o.who, soldBy: o.soldBy,
          };
        });
    },

    async saveSalesOrder(id, values, lines, approvalId) {
      docsOn();
      if (lines.length === 0) fail("EMPTY_SALE");
      // A promise and a debt belonging to nobody is the thing BMS gets wrong.
      const customerId = (values.customer_id as string | null) ?? null;
      if (!customerId) fail("CREDIT_NEEDS_CUSTOMER");
      const branchId = String(values.branch_id ?? branches[0].id);
      const listId = customers.find((c) => c.id === customerId)?.priceListId ?? "pl-retail";
      const pct = Number(values.discount_pct ?? 0);

      const existing = id ? orders.find((x) => x.id === id) : undefined;
      if (id && !existing) fail("ORDER_NOT_FOUND");
      if (existing && !["draft", "awaiting_approval", "open"].includes(existing.status)) {
        fail("ORDER_ALREADY_MOVING");
      }

      const built: DemoDocLine[] = lines.map((l) => {
        const productId = String(l.product_id);
        const product = catalogue.find((x) => x.id === productId);
        if (!product) fail("PRODUCT_NOT_FOUND");
        const qty = Number(l.qty ?? 0);
        if (qty <= 0) fail(`BAD_QTY:${product!.name}`);
        const isFree = Boolean(l.is_free);
        const unitPrice = isFree ? 0 : Number(l.unit_price ?? priceFor(productId, listId).price);
        const lineDiscount = Number(l.line_discount ?? 0);
        return {
          id: crypto.randomUUID(), productId, qty, unitPrice, lineDiscount, isFree,
          lineTotal: roundTaka(unitPrice * qty - lineDiscount),
          note: (l.note as string | null) ?? null, deliveredQty: 0, billedQty: 0,
          cancelled: false,
        };
      });

      // Over the seller's discount limit, or over the shop's order ceiling, it waits
      // for a manager rather than going out.
      const totals = addUp({ discountPct: pct, lines: built });
      // Over the seller's own discount limit, a manager has to sign it.
      let needsOk = pct > staff.discountLimitPct;
      if (shopDetails.soApprovalLimit > 0 && totals.total > shopDetails.soApprovalLimit) {
        needsOk = true;
      }
      if (needsOk && approvalId) {
        if (!approvals.has(approvalId)) fail("APPROVAL_NOT_VALID");
        approvals.delete(approvalId);
        needsOk = false;
      }
      const wantsSending = String(values.send ?? "false") === "true";

      let o: DemoOrder;
      if (!existing) {
        o = {
          id: crypto.randomUUID(),
          soNo: `SO-${branchOr404(branchId).code}-${new Date().getFullYear()}${String(orderCounter++).padStart(6, "0")}`,
          createdAt: new Date().toISOString(), branchId,
          quoteId: (values.quote_id as string | null) ?? null,
          customerId: customerId!, attention: (values.attention as string | null) ?? null,
          address: (values.address as string | null) ?? null,
          deliveryDate: (values.delivery_date as string | null) ?? null,
          paymentTermsDays: Number(values.payment_terms_days
            ?? customers.find((c) => c.id === customerId)?.paymentDays ?? 0),
          discountPct: pct, subtotal: 0, discountAmount: 0, vatAmount: 0, total: 0,
          advanceAmount: 0, status: "draft", cancelReason: null,
          note: (values.note as string | null) ?? null,
          terms: (values.terms as string | null) ?? null,
          who: staff.name, soldBy: staff.name, approvedBy: null, lines: [],
        };
        orders.unshift(o);
      } else {
        o = existing;
      }
      o.customerId = customerId!;
      o.discountPct = pct;
      o.deliveryDate = (values.delivery_date as string | null) ?? o.deliveryDate;
      o.lines = built;
      Object.assign(o, addUp(o));
      o.status = !wantsSending ? "draft" : needsOk ? "awaiting_approval" : "open";
      return { id: o.id, soNo: o.soNo, total: o.total, status: o.status,
               waitingForApproval: o.status === "awaiting_approval" };
    },

    async adjustSalesOrder(orderId, lines, note): Promise<void> {
      if (staff.role === "cashier") fail("NOT_MANAGER");
      const o = orders.find((x) => x.id === orderId);
      if (!o) fail("ORDER_NOT_FOUND");
      if (["billed", "cancelled"].includes(o!.status)) fail("ORDER_CLOSED");
      if (!note?.trim()) fail("REASON_REQUIRED");
      for (const change of lines) {
        const line = o!.lines.find((l) => l.id === change.id);
        if (!line) fail("SALE_LINE_NOT_FOUND");
        if (change.cancel) {
          if ((line!.deliveredQty ?? 0) > 0) fail(`ALREADY_DELIVERED:${line!.id}`);
          line!.cancelled = true;
        } else {
          const qty = change.qty ?? line!.qty;
          // Never below what has already gone out of the door.
          if (qty < (line!.deliveredQty ?? 0)) fail(`LESS_THAN_DELIVERED:${line!.deliveredQty}`);
          if (qty <= 0) fail("BAD_QTY");
          line!.qty = qty;
          line!.lineTotal = roundTaka(line!.unitPrice * qty - line!.lineDiscount);
        }
      }
      Object.assign(o!, addUp(o!));
      o!.note = `${o!.note ? `${o!.note} · ` : ""}${note}`;
    },

    async setOrderStatus(orderId, action, reason): Promise<void> {
      const o = orders.find((x) => x.id === orderId);
      if (!o) fail("ORDER_NOT_FOUND");
      if (action === "send") {
        if (o!.status !== "draft") fail("ORDER_NOT_DRAFT");
        o!.status = "open";
      } else if (action === "approve") {
        if (o!.status !== "awaiting_approval") fail("ORDER_NOT_WAITING");
        if (staff.role === "cashier") fail("NOT_MANAGER");
        o!.status = "open";
        o!.approvedBy = staff.name;
      } else {
        if (["billed", "cancelled"].includes(o!.status)) fail("ORDER_CLOSED");
        if (o!.lines.some((l) => (l.deliveredQty ?? 0) > 0)) {
          fail(`ALREADY_DELIVERED:${o!.soNo}`);
        }
        if (!reason?.trim()) fail("REASON_REQUIRED");
        if (staff.role === "cashier") fail("NOT_MANAGER");
        o!.status = "cancelled";
        o!.cancelReason = reason ?? null;
      }
    },

    async recordAdvance(input) {
      const o = orders.find((x) => x.id === input.orderId);
      if (!o) fail("ORDER_NOT_FOUND");
      if (o!.status === "cancelled") fail("ORDER_CLOSED");
      if (input.amount <= 0) fail("BAD_PAYMENT_AMOUNT");
      // More than the order is worth is a decimal point in the wrong place.
      if (o!.total > 0 && o!.advanceAmount + input.amount > o!.total) fail("ADVANCE_OVER_ORDER");
      advances.push({
        id: crypto.randomUUID(), createdAt: new Date().toISOString(),
        branchId: o!.branchId, orderId: o!.id, customerId: o!.customerId,
        amount: input.amount, method: input.method ?? "cash",
        reference: input.reference ?? null, note: input.note ?? null,
        usedOnSaleId: null, who: staff.name,
      });
      o!.advanceAmount = roundTaka(o!.advanceAmount + input.amount);
      if (features.accounts) {
        // Money HELD, not money earned: a liability until there is a bill.
        post({
          branchId: o!.branchId, narration: `Advance received on ${o!.soNo}`,
          sourceKind: "customer_payment",
          lines: [
            { accountId: accountForMethod(input.method ?? "cash", o!.branchId)?.id,
              debit: input.amount },
            { role: "customer_advance", credit: input.amount, customerId: o!.customerId },
          ],
        });
      }
      return { amount: input.amount, advanceTotal: o!.advanceAmount };
    },

    async listAdvances(branchId): Promise<AdvanceRow[]> {
      if (staff.role === "cashier") fail("NOT_ALLOWED:view_reports");
      return advances
        .filter((a) => !a.usedOnSaleId && (!branchId || a.branchId === branchId))
        .map((a) => ({
          id: a.id, date: dhakaDate(a.createdAt),
          customer: customers.find((c) => c.id === a.customerId)?.name ?? "—",
          customerId: a.customerId,
          orderNo: orders.find((o) => o.id === a.orderId)?.soNo ?? null,
          orderId: a.orderId, amount: a.amount, method: a.method,
          reference: a.reference, branch: branchOr404(a.branchId).name,
          daysHeld: Math.round((Date.now() - Date.parse(a.createdAt)) / 86400000),
          who: a.who,
        }));
    },

    async listChallans(input): Promise<ChallanRow[]> {
      return challans
        .filter((ch) => (!input?.branchId || ch.branchId === input.branchId)
                        && (!input?.status || ch.status === input.status
                            || (input.status === "unbilled"
                                && ["delivered", "part_billed"].includes(ch.status))))
        .map((ch) => ({
          id: ch.id, challanNo: ch.challanNo, date: ch.deliveredOn,
          branch: branchOr404(ch.branchId).name, branchId: ch.branchId,
          customer: customers.find((c) => c.id === ch.customerId)?.name ?? "—",
          customerId: ch.customerId,
          orderNo: orders.find((o) => o.id === ch.orderId)?.soNo ?? null,
          orderId: ch.orderId, status: ch.status, atCost: ch.totalCost,
          carrier: ch.carrier, vehicleNo: ch.vehicleNo,
          qty: ch.lines.reduce((n, l) => n + l.qty - (l.returnedQty ?? 0), 0),
          toBill: ch.lines.reduce(
            (n, l) => n + l.qty - (l.returnedQty ?? 0) - (l.billedQty ?? 0), 0),
          daysUnbilled: ["delivered", "part_billed"].includes(ch.status)
            ? Math.round((Date.parse(dhakaToday()) - Date.parse(ch.deliveredOn)) / 86400000)
            : null,
          invoiceNo: ch.invoiceNo, who: ch.who,
        }));
    },

    async saveChallan(branchId, values, lines) {
      docsOn();
      const branch = branchOr404(branchId);
      if (lines.length === 0) fail("NOTHING_DELIVERED");
      const order = values.order_id
        ? orders.find((o) => o.id === values.order_id) : undefined;
      if (values.order_id && !order) fail("ORDER_NOT_FOUND");
      if (order && !["open", "part_delivered"].includes(order.status)) fail("ORDER_NOT_OPEN");
      const customerId = order?.customerId ?? (values.customer_id as string | null);
      if (!customerId) fail("CREDIT_NEEDS_CUSTOMER");

      const built: DemoDocLine[] = [];
      let atCost = 0;
      for (const l of lines) {
        const productId = String(l.product_id);
        const product = catalogue.find((x) => x.id === productId);
        if (!product) fail("PRODUCT_NOT_FOUND");
        const orderLine = l.order_item_id
          ? order?.lines.find((x) => x.id === l.order_item_id) : undefined;
        if (l.order_item_id && !orderLine) fail("SALE_LINE_NOT_FOUND");
        const serialIds = (l.serial_ids as string[] | undefined) ?? [];
        const qty = product!.isSerial ? serialIds.length : Number(l.qty ?? 0);
        if (product!.isSerial && qty === 0) fail(`SERIAL_REQUIRED:${product!.name}`);
        if (qty <= 0) fail(`BAD_QTY:${product!.name}`);
        if (orderLine && qty > orderLine.qty - (orderLine.deliveredQty ?? 0)) {
          fail(`MORE_THAN_ORDERED:${product!.name}`);
        }
        // The goods physically go, so they come off the shelf now.
        if (product!.isSerial) {
          for (const sid of serialIds) {
            const unit = serials.find((x) => x.id === sid && !x.sold && !x.delivered
                                            && !x.inTransit && x.branchId === branchId);
            if (!unit) fail(`SERIAL_NOT_AVAILABLE:${product!.name}`);
            unit!.delivered = true;
          }
        } else {
          const have = stock[branchId]?.[productId] ?? 0;
          if (have < qty) fail(`OUT_OF_STOCK:${product!.name}`);
          stock[branchId][productId] = have - qty;
        }
        const unitCost = costs[productId] ?? 0;
        atCost = roundTaka(atCost + unitCost * qty);
        built.push({
          id: crypto.randomUUID(), productId, qty,
          unitPrice: orderLine?.unitPrice
            ?? Number(l.unit_price ?? priceFor(productId,
                 customers.find((c) => c.id === customerId)?.priceListId ?? "pl-retail").price),
          lineDiscount: orderLine?.lineDiscount ?? 0,
          isFree: orderLine?.isFree ?? Boolean(l.is_free),
          lineTotal: 0, note: (l.note as string | null) ?? null,
          returnedQty: 0, billedQty: 0, orderItemId: orderLine?.id ?? null,
          serialIds,
        });
        if (orderLine) orderLine.deliveredQty = (orderLine.deliveredQty ?? 0) + qty;
      }

      const ch: DemoChallan = {
        id: crypto.randomUUID(),
        challanNo: `CH-${branch.code}-${new Date().getFullYear()}${String(challanCounter++).padStart(6, "0")}`,
        deliveredOn: String(values.delivered_on ?? dhakaToday()), branchId,
        orderId: order?.id ?? null, customerId: customerId!,
        attention: (values.attention as string | null) ?? order?.attention ?? null,
        address: (values.address as string | null) ?? order?.address ?? null,
        carrier: (values.carrier as string | null) ?? null,
        vehicleNo: (values.vehicle_no as string | null) ?? null,
        note: (values.note as string | null) ?? null,
        status: "delivered", totalCost: atCost, who: staff.name, invoiceNo: null,
        lines: built,
      };
      challans.unshift(ch);

      if (order) {
        order.status = order.lines.filter((l) => !l.cancelled)
          .every((l) => (l.deliveredQty ?? 0) >= l.qty) ? "delivered" : "part_delivered";
      }
      if (features.accounts && atCost > 0) {
        // Off the shelf, but still the shop's until a bill says who bought it.
        post({
          branchId, narration: `Delivered on ${ch.challanNo}`, sourceKind: "stock_adjust",
          lines: [{ role: "goods_delivered", debit: atCost },
                  { role: "inventory", credit: atCost }],
        });
      }
      return { id: ch.id, challanNo: ch.challanNo, atCost,
               orderStatus: order?.status ?? null };
    },

    async returnChallan(challanId, lines, reason) {
      const ch = challans.find((x) => x.id === challanId);
      if (!ch) fail("CHALLAN_NOT_FOUND");
      if (!reason?.trim()) fail("REASON_REQUIRED");
      let back = 0;
      let value = 0;
      for (const change of lines) {
        const line = ch!.lines.find((l) => l.id === change.id);
        if (!line) fail("SALE_LINE_NOT_FOUND");
        const product = catalogue.find((p) => p.id === line!.productId);
        const serialIds = change.serialIds ?? [];
        const qty = product?.isSerial ? serialIds.length : (change.qty ?? 0);
        if (qty <= 0) continue;
        // Billed goods are a sales return, which refunds money. This does not.
        if (qty > line!.qty - (line!.returnedQty ?? 0) - (line!.billedQty ?? 0)) {
          fail(`MORE_THAN_DELIVERED:${product?.name ?? ""}`);
        }
        if (product?.isSerial) {
          for (const sid of serialIds) {
            const unit = serials.find((x) => x.id === sid);
            if (unit) { unit.delivered = false; unit.branchId = ch!.branchId; }
          }
        } else {
          stock[ch!.branchId][line!.productId] =
            (stock[ch!.branchId]?.[line!.productId] ?? 0) + qty;
        }
        line!.returnedQty = (line!.returnedQty ?? 0) + qty;
        const orderLine = orders.find((o) => o.id === ch!.orderId)?.lines
          .find((l) => l.id === line!.orderItemId);
        if (orderLine) {
          orderLine.deliveredQty = Math.max((orderLine.deliveredQty ?? 0) - qty, 0);
        }
        value = roundTaka(value + (costs[line!.productId] ?? 0) * qty);
        back += qty;
      }
      if (back === 0) fail("NOTHING_RETURNED");
      if (ch!.lines.every((l) => l.qty <= (l.returnedQty ?? 0))) ch!.status = "returned";
      ch!.note = `${ch!.note ? `${ch!.note} · ` : ""}${reason}`;
      const order = orders.find((o) => o.id === ch!.orderId);
      if (order && order.status === "delivered"
          && order.lines.some((l) => !l.cancelled && (l.deliveredQty ?? 0) < l.qty)) {
        order.status = "part_delivered";
      }
      if (features.accounts && value > 0) {
        post({
          branchId: ch!.branchId, narration: `${ch!.challanNo}: came back`,
          sourceKind: "stock_adjust",
          lines: [{ role: "inventory", debit: value },
                  { role: "goods_delivered", credit: value }],
        });
      }
      return { returned: back };
    },

    async billChallan(input): Promise<BilledResult> {
      const ch = challans.find((x) => x.id === input.challanId);
      if (!ch) fail("CHALLAN_NOT_FOUND");
      if (["billed", "cancelled"].includes(ch!.status)) fail("CHALLAN_ALREADY_BILLED");
      const toBill = ch!.lines.filter(
        (l) => l.qty - (l.returnedQty ?? 0) - (l.billedQty ?? 0) > 0);
      if (toBill.length === 0) fail("NOTHING_TO_BILL");
      const order = orders.find((o) => o.id === ch!.orderId);
      const waiting = advances.filter((a) => a.orderId === ch!.orderId && !a.usedOnSaleId);
      const held = roundTaka(waiting.reduce((n, a) => n + a.amount, 0));

      const receipt = await api.completeSale({
        branchId: ch!.branchId,
        lines: toBill.map((l) => ({
          productId: l.productId,
          qty: l.qty - (l.returnedQty ?? 0) - (l.billedQty ?? 0),
          serialIds: (l.serialIds ?? []).filter(
            (sid) => serials.find((x) => x.id === sid)?.delivered),
          unitPrice: l.unitPrice,
        })),
        paymentMethod: (input.paymentMethod ?? "cash") as Receipt["paymentMethod"],
        discountPct: order?.discountPct ?? 0,
        approvalId: input.approvalId ?? null,
        customerPhone: customers.find((c) => c.id === ch!.customerId)?.phone ?? null,
        cashReceived: input.cashReceived ?? null,
        paymentRef: input.paymentRef ?? null,
        dueAmount: input.dueAmount ?? 0,
        // The stock already went out on the delivery note, so the bill must not move it
        // again — the same flag the database takes.
        extras: { ...(input.extras ?? {}), challanId: ch!.id, orderId: ch!.orderId },
      });

      const used = Math.min(held, receipt.total);
      let stillOwed = receipt.dueAmount;
      if (used > 0) {
        const sale = sales.find((s) => s.id === receipt.id);
        for (const a of waiting) a.usedOnSaleId = receipt.id;
        if (sale) {
          sale.paidAmount = Math.min(roundTaka(sale.paidAmount + used), sale.total);
          sale.dueAmount = Math.max(roundTaka(sale.total - sale.paidAmount), 0);
          stillOwed = sale.dueAmount;
        }
        if (features.accounts) {
          // The money the shop was holding now settles what the bill says they owe.
          post({
            branchId: ch!.branchId,
            narration: `Advance applied to ${receipt.invoiceNo}`,
            sourceKind: "customer_payment",
            lines: [{ role: "customer_advance", debit: used, customerId: ch!.customerId },
                    { role: "receivable", credit: used, customerId: ch!.customerId }],
          });
        }
      }

      for (const l of ch!.lines) l.billedQty = l.qty - (l.returnedQty ?? 0);
      ch!.status = "billed";
      ch!.invoiceNo = receipt.invoiceNo;
      if (order) {
        for (const l of order.lines) l.billedQty = Math.min(l.deliveredQty ?? 0, l.qty);
        if (order.lines.filter((l) => !l.cancelled)
            .every((l) => (l.billedQty ?? 0) >= l.qty)) {
          order.status = "billed";
        }
      }
      return { ...receipt, challanNo: ch!.challanNo, advanceUsed: used,
               stillOwed: stillOwed ?? 0 };
    },

    async billOrder(input): Promise<BilledResult> {
      const order = orders.find((o) => o.id === input.orderId);
      if (!order) fail("ORDER_NOT_FOUND");
      if (!["open", "part_delivered"].includes(order!.status)) fail("ORDER_NOT_OPEN");
      const lines = order!.lines
        .filter((l) => !l.cancelled && l.qty > (l.deliveredQty ?? 0))
        .map((l) => ({
          product_id: l.productId, order_item_id: l.id,
          qty: l.qty - (l.deliveredQty ?? 0),
          serial_ids: ((input.extras?.serials as Record<string, string[]> | undefined)
            ?? {})[l.productId] ?? [],
        }));
      if (lines.length === 0) fail("NOTHING_TO_BILL");
      // Always a delivery note behind a bill: one path for the goods leaving.
      const ch = await api.saveChallan(order!.branchId, { order_id: order!.id }, lines);
      return api.billChallan({ ...input, challanId: ch.id });
    },

    async salesDocument(kind, id): Promise<SalesDocument> {
      const nameOf = (productId: string): { product: string; code: string; isSerial: boolean } => {
        const p = catalogue.find((x) => x.id === productId);
        return { product: p?.name ?? "—", code: p?.code ?? "—", isSerial: Boolean(p?.isSerial) };
      };
      const base = {
        validUntil: null as string | null, deliveryDate: null as string | null,
        paymentTermsDays: null as number | null, carrier: null as string | null,
        vehicleNo: null as string | null, advance: 0, advanceWaiting: 0,
        quoteNo: null as string | null, orderNo: null as string | null,
        orderId: null as string | null, invoiceNo: null as string | null,
        soldBy: null as string | null, approvedBy: null as string | null,
        challans: [] as SalesDocument["challans"],
      };

      if (kind === "quotation") {
        const q = quotations.find((x) => x.id === id);
        if (!q) fail("DOCUMENT_NOT_FOUND");
        const c = customers.find((x) => x.id === q!.customerId);
        return {
          ...base, kind, id: q!.id, no: q!.quoteNo, date: dhakaDate(q!.createdAt),
          status: q!.status, branch: branchOr404(q!.branchId).name, branchId: q!.branchId,
          customer: c?.name ?? q!.customerName ?? "—", customerId: q!.customerId,
          phone: c?.phone ?? null, attention: q!.attention,
          address: q!.address ?? c?.address ?? null,
          validUntil: q!.validUntil, terms: q!.terms, note: q!.note,
          subtotal: q!.subtotal, discountPct: q!.discountPct,
          discountAmount: q!.discountAmount, vatAmount: q!.vatAmount, total: q!.total,
          who: q!.who,
          lines: q!.lines.map((l) => ({
            ...nameOf(l.productId), id: l.id, productId: l.productId, qty: l.qty,
            unitPrice: l.unitPrice, lineDiscount: l.lineDiscount, isFree: l.isFree,
            lineTotal: l.lineTotal, note: l.note,
          })),
        };
      }

      if (kind === "order") {
        const o = orders.find((x) => x.id === id);
        if (!o) fail("DOCUMENT_NOT_FOUND");
        const c = customers.find((x) => x.id === o!.customerId);
        return {
          ...base, kind, id: o!.id, no: o!.soNo, date: dhakaDate(o!.createdAt),
          status: o!.status, branch: branchOr404(o!.branchId).name, branchId: o!.branchId,
          customer: c?.name ?? "—", customerId: o!.customerId, phone: c?.phone ?? null,
          attention: o!.attention, address: o!.address ?? c?.address ?? null,
          deliveryDate: o!.deliveryDate, paymentTermsDays: o!.paymentTermsDays,
          terms: o!.terms, note: o!.note,
          subtotal: o!.subtotal, discountPct: o!.discountPct,
          discountAmount: o!.discountAmount, vatAmount: o!.vatAmount, total: o!.total,
          advance: o!.advanceAmount,
          quoteNo: quotations.find((q) => q.id === o!.quoteId)?.quoteNo ?? null,
          who: o!.who, soldBy: o!.soldBy, approvedBy: o!.approvedBy,
          lines: o!.lines.map((l) => ({
            ...nameOf(l.productId), id: l.id, productId: l.productId, qty: l.qty,
            unitPrice: l.unitPrice, lineDiscount: l.lineDiscount, isFree: l.isFree,
            lineTotal: l.lineTotal, note: l.note,
            deliveredQty: l.deliveredQty ?? 0, billedQty: l.billedQty ?? 0,
            pendingQty: Math.max(l.qty - (l.deliveredQty ?? 0), 0),
            cancelled: Boolean(l.cancelled),
            inStock: availableQty(l.productId, o!.branchId, o!.id),
          })),
          challans: challans.filter((ch) => ch.orderId === o!.id).map((ch) => ({
            id: ch.id, challanNo: ch.challanNo, date: ch.deliveredOn, status: ch.status,
          })),
        };
      }

      const ch = challans.find((x) => x.id === id);
      if (!ch) fail("DOCUMENT_NOT_FOUND");
      const c = customers.find((x) => x.id === ch!.customerId);
      return {
        ...base, kind: "challan", id: ch!.id, no: ch!.challanNo, date: ch!.deliveredOn,
        status: ch!.status, branch: branchOr404(ch!.branchId).name, branchId: ch!.branchId,
        customer: c?.name ?? "—", customerId: ch!.customerId, phone: c?.phone ?? null,
        attention: ch!.attention, address: ch!.address ?? c?.address ?? null,
        carrier: ch!.carrier, vehicleNo: ch!.vehicleNo, terms: null, note: ch!.note,
        subtotal: 0, discountPct: 0, discountAmount: 0, vatAmount: 0, total: 0,
        orderNo: orders.find((o) => o.id === ch!.orderId)?.soNo ?? null,
        orderId: ch!.orderId, invoiceNo: ch!.invoiceNo,
        advanceWaiting: roundTaka(advances
          .filter((a) => a.orderId === ch!.orderId && !a.usedOnSaleId)
          .reduce((n, a) => n + a.amount, 0)),
        who: ch!.who,
        lines: ch!.lines.map((l) => ({
          ...nameOf(l.productId), id: l.id, productId: l.productId, qty: l.qty,
          unitPrice: l.unitPrice, lineDiscount: l.lineDiscount, isFree: l.isFree,
          lineTotal: l.lineTotal, note: l.note,
          returnedQty: l.returnedQty ?? 0, billedQty: l.billedQty ?? 0,
          toBill: l.qty - (l.returnedQty ?? 0) - (l.billedQty ?? 0),
          serials: (l.serialIds ?? []).map((sid) => {
            const unit = serials.find((x) => x.id === sid);
            return { id: sid, serial: unit?.serial ?? "—", returned: !unit?.delivered };
          }),
        })),
      };
    },

    // --- HR: employees, attendance and salary (P14b) ---

    async listEmployees(input): Promise<Employee[]> {
      hrAllowed();
      const pay = staff.role === "owner";
      return employees
        .filter((e) => (!input?.branchId || e.branchId === input.branchId)
                       && (input?.active === null || e.active === (input?.active ?? true))
                       && (!input?.query
                           || `${e.name} ${e.phone ?? ""} ${e.code ?? ""}`
                               .toLowerCase().includes(input.query.toLowerCase())))
        .map((e): Employee => {
          const t = salaryTerms.find((x) => x.employeeId === e.id);
          const owed = salaryAdvances
            .filter((a) => a.employeeId === e.id && !a.settledMonth)
            .reduce((n, a) => n + a.amount, 0);
          return {
            id: e.id, code: e.code, name: e.name, phone: e.phone, photoUrl: null,
            address: e.address, nid: e.nid, dateOfBirth: null, joinedOn: e.joinedOn,
            branch: branches.find((b) => b.id === e.branchId)?.name ?? null,
            branchId: e.branchId,
            department: nameOfList("departments", e.departmentId),
            departmentId: e.departmentId,
            designation: nameOfList("designations", e.designationId),
            designationId: e.designationId,
            position: nameOfList("positions", e.positionId), positionId: e.positionId,
            profession: nameOfList("professions", e.professionId),
            professionId: e.professionId,
            emergencyName: e.emergencyName, emergencyPhone: e.emergencyPhone,
            religion: e.religion, nationality: e.nationality,
            staffId: e.staffId,
            login: team.find((x) => x.id === e.staffId)?.name ?? null,
            active: e.active, leftOn: e.leftOn, note: e.note,
            // Absent rather than zero when it is not this login's business.
            basic: pay ? (t?.basic ?? 0) : null,
            allowances: pay ? (t?.allowances ?? {}) : null,
            dailyRate: pay ? (t?.dailyRate ?? 0) : null,
            advanceOutstanding: pay ? owed : null,
            today: attendance.find((a) => a.employeeId === e.id && a.onDate === dhakaToday())
              ?.status ?? null,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async saveEmployee(id, values): Promise<void> {
      hrAllowed();
      if (!String(values.name ?? "").trim()) fail("NAME_REQUIRED");
      const found = id ? employees.find((e) => e.id === id) : undefined;
      if (id && !found) fail("EMPLOYEE_NOT_FOUND");
      const next: DemoEmployee = {
        id: found?.id ?? crypto.randomUUID(),
        code: (values.code as string | null) ?? found?.code ?? null,
        name: String(values.name).trim(),
        phone: (values.phone as string | null) ?? found?.phone ?? null,
        address: (values.address as string | null) ?? found?.address ?? null,
        nid: (values.nid as string | null) ?? found?.nid ?? null,
        joinedOn: String(values.joined_on ?? found?.joinedOn ?? dhakaToday()),
        branchId: (values.branch_id as string | null) ?? found?.branchId ?? null,
        departmentId: (values.department_id as string | null) ?? found?.departmentId ?? null,
        designationId: (values.designation_id as string | null) ?? found?.designationId ?? null,
        positionId: (values.position_id as string | null) ?? found?.positionId ?? null,
        professionId: (values.profession_id as string | null) ?? found?.professionId ?? null,
        emergencyName: (values.emergency_name as string | null) ?? found?.emergencyName ?? null,
        emergencyPhone: (values.emergency_phone as string | null) ?? found?.emergencyPhone ?? null,
        religion: (values.religion as string | null) ?? found?.religion ?? null,
        nationality: (values.nationality as string | null) ?? found?.nationality ?? null,
        staffId: values.staff_id !== undefined
          ? ((values.staff_id as string | null) ?? null) : (found?.staffId ?? null),
        active: values.active === undefined ? (found?.active ?? true) : Boolean(values.active),
        leftOn: null,
        note: (values.note as string | null) ?? found?.note ?? null,
      };
      // Somebody who has left keeps their record: their attendance and the slips they
      // were paid are part of the shop's books.
      if (!next.active) next.leftOn = String(values.left_on ?? found?.leftOn ?? dhakaToday());
      if (found) Object.assign(found, next); else employees.push(next);
    },

    async saveSalaryTerms(employeeId, values): Promise<void> {
      payAllowed();
      if (!employees.some((e) => e.id === employeeId)) fail("EMPLOYEE_NOT_FOUND");
      const got = salaryTerms.find((t) => t.employeeId === employeeId);
      const next: DemoSalaryTerms = {
        employeeId,
        basic: Number(values.basic ?? got?.basic ?? 0),
        allowances: (values.allowances as Record<string, number> | undefined)
          ?? got?.allowances ?? {},
        dailyRate: Number(values.daily_rate ?? got?.dailyRate ?? 0),
      };
      if (got) Object.assign(got, next); else salaryTerms.push(next);
    },

    async saveAttendanceSettings(branchId, values) {
      hrAllowed();
      branchOr404(branchId);
      const pin = values.attendance_pin === undefined
        ? attendanceSettings[branchId].pin
        : (String(values.attendance_pin ?? "") || null);
      if (pin !== null && !/^[0-9]{4,8}$/.test(pin)) fail("BAD_BRANCH_PIN");
      attendanceSettings[branchId] = {
        opensAt: String(values.opens_at ?? attendanceSettings[branchId].opensAt),
        graceMinutes: Number(values.grace_minutes ?? attendanceSettings[branchId].graceMinutes),
        pin,
      };
      return {
        opensAt: attendanceSettings[branchId].opensAt,
        graceMinutes: attendanceSettings[branchId].graceMinutes,
        takesCheckIns: pin !== null,
      };
    },

    async checkIn(branchId, pin, employeeId): Promise<CheckInResult> {
      if (!features.hr) fail("FEATURE_OFF:hr");
      const branch = branchOr404(branchId);
      const settings = attendanceSettings[branchId];
      let emp: DemoEmployee | undefined;
      if (!employeeId) {
        emp = employees.find((e) => e.staffId === staff.id && e.active);
        if (!emp) fail("NOT_AN_EMPLOYEE");
        // The branch's own code is what makes this a record made AT THE BRANCH. It is
        // not proof of presence, and the row says who recorded it.
        if (!settings.pin) fail("BRANCH_TAKES_NO_CHECK_INS");
        if (pin !== settings.pin) fail("BAD_BRANCH_PIN");
      } else {
        if (staff.role === "cashier") fail("NOT_ALLOWED:manage_hr");
        emp = employees.find((e) => e.id === employeeId && e.active);
        if (!emp) fail("EMPLOYEE_NOT_FOUND");
      }

      const now = new Date();
      const localHm = now.toLocaleTimeString("en-GB", {
        timeZone: "Asia/Dhaka", hour12: false, hour: "2-digit", minute: "2-digit" });
      const mins = (t: string): number => {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      };
      const late = Math.max(mins(localHm) - mins(settings.opensAt), 0);
      let status: AttendanceStatus = late > settings.graceMinutes ? "late" : "present";
      if (holidaysOn()) status = "holiday";

      const existing = attendance.find(
        (a) => a.employeeId === emp!.id && a.onDate === dhakaToday());
      if (existing?.inAt) {
        // Checking in twice does not move the first time: the first one is the record.
        return {
          employee: emp!.name, branch: branch.name, date: existing.onDate,
          status: existing.status, minutesLate: existing.minutesLate,
          opensAt: settings.opensAt, graceMinutes: settings.graceMinutes,
        };
      }
      const row: DemoAttendance = {
        employeeId: emp!.id, branchId, onDate: dhakaToday(),
        inAt: now.toISOString(), outAt: null, status,
        source: employeeId ? "manager" : "self",
        minutesLate: status === "late" ? late : 0, note: null, markedBy: staff.id,
      };
      if (existing) Object.assign(existing, row); else attendance.push(row);
      return {
        employee: emp!.name, branch: branch.name, date: row.onDate, status: row.status,
        minutesLate: row.minutesLate, opensAt: settings.opensAt,
        graceMinutes: settings.graceMinutes,
      };
    },

    async checkOut(branchId, employeeId): Promise<void> {
      const id = employeeId
        ?? employees.find((e) => e.staffId === staff.id && e.active)?.id;
      if (!id) fail("NOT_AN_EMPLOYEE");
      if (employeeId && staff.role === "cashier") fail("NOT_ALLOWED:manage_hr");
      const row = attendance.find((a) => a.employeeId === id && a.onDate === dhakaToday());
      if (!row) fail("NO_CHECK_IN_TODAY");
      row!.outAt = new Date().toISOString();
    },

    async markAttendance(employeeId, date, status, note): Promise<void> {
      hrAllowed();
      const emp = employees.find((e) => e.id === employeeId);
      if (!emp) fail("EMPLOYEE_NOT_FOUND");
      if (date > dhakaToday()) fail("DATE_IN_FUTURE");
      const row: DemoAttendance = {
        employeeId, branchId: emp!.branchId ?? branches[0].id, onDate: date,
        inAt: null, outAt: null, status, source: "manager", minutesLate: 0,
        note: note ?? null, markedBy: staff.id,
      };
      const existing = attendance.find((a) => a.employeeId === employeeId && a.onDate === date);
      if (existing) {
        Object.assign(existing, { status, source: "manager", note: note ?? null });
      } else {
        attendance.push(row);
      }
    },

    async attendanceDay(date, branchId): Promise<AttendanceDay> {
      hrAllowed();
      const on = date ?? dhakaToday();
      const mine = employees.filter(
        (e) => e.active && (!branchId || e.branchId === branchId));
      const people = mine.map((e) => {
        const a = attendance.find((x) => x.employeeId === e.id && x.onDate === on);
        return {
          employeeId: e.id, name: e.name,
          branch: branches.find((b) => b.id === e.branchId)?.name ?? null,
          branchId: e.branchId,
          designation: nameOfList("designations", e.designationId),
          // Nobody marked is NOT absent: guessing would put a deduction on somebody's
          // salary that nobody decided.
          status: (a?.status ?? "not recorded") as AttendanceDay["people"][number]["status"],
          inAt: a?.inAt ?? null, outAt: a?.outAt ?? null,
          minutesLate: a?.minutesLate ?? 0, source: a?.source ?? null,
          note: a?.note ?? null,
          markedBy: team.find((t) => t.id === a?.markedBy)?.name ?? null,
        };
      });
      const count = (s: string): number => people.filter((p) => p.status === s).length;
      return {
        date: on, holiday: null, people,
        counts: {
          present: count("present"), late: count("late"), absent: count("absent"),
          leave: count("leave"), notRecorded: count("not recorded"), people: people.length,
        },
      };
    },

    async attendanceToday(branchId): Promise<AttendanceTodayBranch[]> {
      if (!features.hr || staff.role === "cashier") return [];
      const on = dhakaToday();
      return branches
        .filter((b) => !branchId || b.id === branchId)
        .map((b) => {
          const mine = employees.filter((e) => e.active && e.branchId === b.id);
          const of = (s: string): number => mine.filter((e) => attendance.some(
            (a) => a.employeeId === e.id && a.onDate === on && a.status === s)).length;
          return {
            branch: b.name, branchId: b.id, people: mine.length,
            present: of("present"), late: of("late"), absent: of("absent"),
            onLeave: of("leave"),
            notRecorded: mine.filter((e) => !attendance.some(
              (a) => a.employeeId === e.id && a.onDate === on)).length,
          };
        });
    },

    async listLeave(status, employeeId): Promise<LeaveRow[]> {
      hrAllowed();
      return leaveRequests
        .filter((r) => (!status || r.status === status)
                       && (!employeeId || r.employeeId === employeeId))
        .map((r) => {
          const kind = lists.leave_types.find((t) => t.id === r.leaveTypeId);
          return {
            id: r.id, employee: employees.find((e) => e.id === r.employeeId)?.name ?? "—",
            employeeId: r.employeeId,
            kind: String(kind?.name ?? "—"), isPaid: kind?.is_paid !== false,
            fromDate: r.fromDate, toDate: r.toDate, days: r.days, reason: r.reason,
            status: r.status, note: r.note,
            decidedBy: team.find((t) => t.id === r.decidedBy)?.name ?? null,
            takenThisYear: leaveRequests
              .filter((x) => x.employeeId === r.employeeId && x.leaveTypeId === r.leaveTypeId
                             && x.status === "approved"
                             && x.fromDate.slice(0, 4) === r.fromDate.slice(0, 4))
              .reduce((n, x) => n + x.days, 0),
            daysAYear: Number(kind?.days_a_year ?? 0),
          };
        });
    },

    async askForLeave(input) {
      if (!features.hr) fail("FEATURE_OFF:hr");
      const emp = employees.find((e) => e.id === input.employeeId && e.active);
      if (!emp) fail("EMPLOYEE_NOT_FOUND");
      if (emp!.staffId !== staff.id && staff.role === "cashier") fail("NOT_ALLOWED:manage_hr");
      if (input.to < input.from) fail("BAD_DATE_RANGE");
      const days = Math.round(
        (Date.parse(input.to) - Date.parse(input.from)) / 86400000) + 1;
      leaveRequests.unshift({
        id: crypto.randomUUID(), employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId, fromDate: input.from, toDate: input.to,
        days, reason: input.reason ?? null, status: "asked", note: null, decidedBy: null,
      });
      return { days };
    },

    async decideLeave(id, approve, note): Promise<void> {
      hrAllowed();
      const r = leaveRequests.find((x) => x.id === id);
      if (!r) fail("REQUEST_NOT_FOUND");
      if (r!.status !== "asked") fail("REQUEST_ALREADY_DECIDED");
      const emp = employees.find((e) => e.id === r!.employeeId);
      if (emp?.staffId === staff.id) fail("NO_SELF_APPROVAL");
      if (!approve && !note?.trim()) fail("REASON_REQUIRED");
      r!.status = approve ? "approved" : "refused";
      r!.note = note ?? null;
      r!.decidedBy = staff.id;
      if (approve) {
        // The approval has to reach the thing that counts the days, or the salary sheet
        // docks somebody for days the owner agreed to.
        for (let d = new Date(r!.fromDate); d <= new Date(r!.toDate);
             d = new Date(d.getTime() + 86400000)) {
          const on = d.toISOString().slice(0, 10);
          const existing = attendance.find(
            (a) => a.employeeId === r!.employeeId && a.onDate === on);
          if (existing) {
            existing.status = "leave";
            existing.source = "manager";
          } else {
            attendance.push({
              employeeId: r!.employeeId, branchId: emp?.branchId ?? branches[0].id,
              onDate: on, inAt: null, outAt: null, status: "leave", source: "manager",
              minutesLate: 0,
              note: String(lists.leave_types.find((t) => t.id === r!.leaveTypeId)?.name ?? ""),
              markedBy: staff.id,
            });
          }
        }
      }
    },

    async recordSalaryAdvance(employeeId, amount, method, note): Promise<void> {
      payAllowed();
      if (!employees.some((e) => e.id === employeeId && e.active)) fail("EMPLOYEE_NOT_FOUND");
      if (amount <= 0) fail("BAD_PAYMENT_AMOUNT");
      salaryAdvances.push({
        id: crypto.randomUUID(), employeeId, amount, method: method ?? "cash",
        takenOn: dhakaToday(), settledMonth: null,
      });
      void note;
    },

    async buildSalarySheet(month, branchId) {
      payAllowed();
      const first = `${month.slice(0, 7)}-01`;
      if (first > `${dhakaToday().slice(0, 7)}-01`) fail("MONTH_NOT_FINISHED");
      const daysInMonth = new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)
        .getDate();
      const last = `${first.slice(0, 7)}-${String(daysInMonth).padStart(2, "0")}`;

      let sheet = salarySheets.find(
        (s) => s.month === first && (s.branchId ?? null) === (branchId ?? null));
      if (sheet?.status === "paid") fail("SHEET_ALREADY_PAID");
      if (!sheet) {
        sheet = {
          id: crypto.randomUUID(), month: first, branchId: branchId ?? null,
          status: "draft", total: 0, paidOn: null, method: null, note: null,
          who: staff.name, lines: [],
        };
        salarySheets.unshift(sheet);
      }
      sheet.lines = [];

      for (const e of employees.filter(
        (x) => (!branchId || x.branchId === branchId) && x.joinedOn <= last
               && (x.active || (x.leftOn ?? "") >= first))) {
        const t = salaryTerms.find((x) => x.employeeId === e.id);
        if (!t) continue;
        const allow = Object.values(t.allowances).reduce((n, v) => n + Number(v), 0);
        const days = attendance.filter(
          (a) => a.employeeId === e.id && a.onDate >= first && a.onDate <= last);
        // Only a row that SAYS absent counts: a shop that forgot to mark attendance has
        // not thereby stopped paying anybody.
        const absent = days.reduce((n, a) => n + (a.status === "absent" ? 1
          : a.status === "half_day" ? 0.5 : 0), 0);
        const worked = days.reduce((n, a) => n + (["present", "late"].includes(a.status) ? 1
          : a.status === "half_day" ? 0.5 : 0), 0);

        let net: number;
        let cut = 0;
        if (t.dailyRate > 0) {
          net = roundTaka(t.dailyRate * worked);
        } else {
          // A day's pay is the month divided by THAT month's days, never a flat 30.
          cut = roundTaka(roundTaka((t.basic + allow) / daysInMonth) * absent);
          net = roundTaka(t.basic + allow - cut);
        }
        const owed = salaryAdvances
          .filter((a) => a.employeeId === e.id && !a.settledMonth && a.takenOn <= last)
          .reduce((n, a) => n + a.amount, 0);
        // Never take back more than the salary, or the shop lends money and then pays
        // nothing at all.
        const advanceCut = Math.min(owed, Math.max(net, 0));
        net = roundTaka(net - advanceCut);

        sheet.lines.push({
          id: crypto.randomUUID(), employeeId: e.id, basic: t.basic, allowances: allow,
          absentDays: absent, absenceCut: cut, advanceCut, otherCut: 0,
          daysWorked: worked, daysInMonth, net,
        });
      }
      sheet.total = roundTaka(sheet.lines.reduce((n, l) => n + l.net, 0));
      return { id: sheet.id, employees: sheet.lines.length, total: sheet.total };
    },

    async paySalarySheet(sheetId, method, note) {
      payAllowed();
      const sheet = salarySheets.find((s) => s.id === sheetId);
      if (!sheet) fail("SHEET_NOT_FOUND");
      if (sheet!.status === "paid") fail("SHEET_ALREADY_PAID");
      const total = roundTaka(sheet!.lines.reduce((n, l) => n + l.net, 0));
      if (total <= 0) fail("NOTHING_TO_PAY");
      sheet!.status = "paid";
      sheet!.paidOn = dhakaToday();
      sheet!.method = method ?? "cash";
      sheet!.note = note ?? null;
      sheet!.total = total;
      // The advances this sheet took back are settled now, so next month does not
      // deduct them all over again.
      for (const a of salaryAdvances) {
        if (!a.settledMonth && sheet!.lines.some(
          (l) => l.employeeId === a.employeeId && l.advanceCut > 0)) {
          a.settledMonth = sheet!.month;
        }
      }
      if (features.accounts) {
        const expense = accounts.find((a) => a.code === "6200")
          ?? accounts.find((a) => a.nature === "expense");
        post({
          branchId: sheet!.branchId ?? branches[0].id,
          narration: `Salary for ${sheet!.month.slice(0, 7)}`,
          sourceKind: "voucher",
          lines: [
            { accountId: expense?.id, debit: total },
            { accountId: accountForMethod(method ?? "cash",
                                          sheet!.branchId ?? branches[0].id)?.id,
              credit: total },
          ],
        });
      }
      return { total };
    },

    async listSalarySheets(branchId): Promise<SalarySheetRow[]> {
      payAllowed();
      return salarySheets
        .filter((s) => !branchId || (s.branchId ?? null) === branchId)
        .map((s) => ({
          id: s.id, month: s.month, status: s.status, total: s.total,
          branch: branches.find((b) => b.id === s.branchId)?.name ?? null,
          branchId: s.branchId, paidOn: s.paidOn, people: s.lines.length,
        }));
    },

    async salarySheet(id): Promise<SalarySheet> {
      payAllowed();
      const s = salarySheets.find((x) => x.id === id);
      if (!s) fail("SHEET_NOT_FOUND");
      return {
        id: s!.id, month: s!.month, status: s!.status, total: s!.total,
        branch: branches.find((b) => b.id === s!.branchId)?.name ?? null,
        branchId: s!.branchId, paidOn: s!.paidOn, method: s!.method, note: s!.note,
        who: s!.who,
        lines: s!.lines.map((l) => ({
          ...l,
          employee: employees.find((e) => e.id === l.employeeId)?.name ?? "—",
          designation: nameOfList("designations",
            employees.find((e) => e.id === l.employeeId)?.designationId ?? null),
        })),
      };
    },

    // --- Sales reps, dealers and delivery points (P14c) ---

    async listReps(): Promise<RepRow[]> {
      return employees.filter((e) => e.active && e.isRep).map((e) => ({
        employeeId: e.id, name: e.name, phone: e.phone,
        branch: branches.find((b) => b.id === e.branchId)?.name ?? null,
        branchId: e.branchId,
        commissionPct: e.commissionPct ?? 0,
        commissionOn: (e.commissionOn ?? "sales") as RepRow["commissionOn"],
        customers: customers.filter((c) => c.repId === e.id).length,
        areas: repAreas.filter((a) => a.employeeId === e.id).map((a) => ({
          districtId: a.districtId, district: null,
          upazilaId: a.upazilaId, upazila: null,
        })),
      }));
    },

    async saveRep(employeeId, values): Promise<void> {
      distributionOn();
      if (staff.role === "cashier") fail("NOT_ALLOWED:manage_hr");
      const e = employees.find((x) => x.id === employeeId);
      if (!e) fail("EMPLOYEE_NOT_FOUND");
      e!.isRep = values.is_rep === undefined ? true : Boolean(values.is_rep);
      e!.commissionPct = Number(values.commission_pct ?? e!.commissionPct ?? 0);
      e!.commissionOn = String(values.commission_on ?? e!.commissionOn ?? "sales");
      if (values.areas) {
        // Replaced wholesale: "these are the areas" is easier to get right than adding
        // and removing one at a time.
        for (let i = repAreas.length - 1; i >= 0; i -= 1) {
          if (repAreas[i].employeeId === employeeId) repAreas.splice(i, 1);
        }
        for (const a of values.areas as Record<string, unknown>[]) {
          repAreas.push({
            employeeId,
            districtId: a.district_id === undefined ? null : Number(a.district_id),
            upazilaId: a.upazila_id === undefined ? null : Number(a.upazila_id),
          });
        }
      }
    },

    async saveRepTarget(employeeId, month, values): Promise<void> {
      distributionOn();
      if (staff.role === "cashier") fail("NOT_MANAGER");
      if (!employees.some((e) => e.id === employeeId)) fail("EMPLOYEE_NOT_FOUND");
      const amount = Number(values.target_amount ?? 0);
      const qty = Number(values.target_qty ?? 0);
      if (amount <= 0 && qty <= 0) fail("TARGET_NEEDS_A_FIGURE");
      const first = `${month.slice(0, 7)}-01`;
      const got = repTargets.find((t) => t.employeeId === employeeId && t.month === first);
      if (got) {
        got.targetAmount = amount;
        got.targetQty = qty;
      } else {
        repTargets.push({ employeeId, month: first, targetAmount: amount, targetQty: qty });
      }
    },

    async repAchievement(month, employeeId): Promise<RepMonth> {
      distributionOn();
      const first = `${(month ?? dhakaToday()).slice(0, 7)}-01`;
      const daysInMonth = new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)
        .getDate();
      const last = `${first.slice(0, 7)}-${String(daysInMonth).padStart(2, "0")}`;
      const today = dhakaToday();
      const daysLeft = today >= first && today <= last
        ? daysInMonth - Number(today.slice(8, 10)) : 0;

      const mine = employees.find((e) => e.staffId === staff.id && e.active)?.id ?? null;
      if (employeeId && employeeId !== mine && staff.role === "cashier") {
        fail("NOT_ALLOWED:manage_hr");
      }
      if (!employeeId && staff.role === "cashier" && !mine) fail("NOT_AN_EMPLOYEE");

      const reps = employees
        .filter((e) => e.active && e.isRep
                       && (!employeeId || e.id === employeeId)
                       && (staff.role !== "cashier" || e.id === mine))
        .map((e) => {
          const target = repTargets.find(
            (t) => t.employeeId === e.id && t.month === first);
          // Made by them, or sold to one of their customers.
          const theirs = sales.filter((sa) => sa.status === "completed"
            && dhakaDate(sa.createdAt) >= first && dhakaDate(sa.createdAt) <= last
            && ((e.staffId && sa.staffId === e.staffId)
                || customers.find((c) => c.id === sa.customerId)?.repId === e.id));
          const sold = roundTaka(theirs.reduce((n, sa) => n + sa.total, 0));
          const qty = theirs.flatMap((sa) => sa.items).reduce((n, l) => n + l.qty, 0);
          const profit = roundTaka(theirs.reduce((n, sa) => n + sa.total
            - sa.items.reduce((m, l) => m + (sa.lineCosts[l.id] ?? 0) * l.qty, 0), 0));
          const pct = target?.targetAmount
            ? Math.round((sold / target.targetAmount) * 1000) / 10 : null;
          const short = target?.targetAmount
            ? Math.max(target.targetAmount - sold, 0) : null;
          return {
            employeeId: e.id, name: e.name,
            commissionPct: e.commissionPct ?? 0,
            commissionOn: (e.commissionOn ?? "sales") as RepRow["commissionOn"],
            target: target?.targetAmount ?? 0, targetQty: target?.targetQty ?? 0,
            sold, qty, profit,
            donePct: pct, shortBy: short,
            aDayNeeded: short !== null && daysLeft > 0 ? Math.round(short / daysLeft) : null,
            commission: (e.commissionPct ?? 0) > 0
              ? roundTaka(((e.commissionOn === "profit" ? profit : sold)
                           * (e.commissionPct ?? 0)) / 100)
              : null,
            customers: customers.filter((c) => c.repId === e.id).length,
          };
        });
      return { month: first, daysInMonth, daysLeft, reps };
    },

    async listDeliveryPoints(customerId): Promise<DeliveryPoint[]> {
      return deliveryPoints
        .filter((d) => d.customerId === customerId && d.active)
        .map((d) => ({
          id: d.id, name: d.name, address: d.address, contactName: d.contactName,
          contactPhone: d.contactPhone, isDefault: d.isDefault, active: d.active,
          note: d.note,
        }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault)
                        || a.name.localeCompare(b.name));
    },

    async saveDeliveryPoint(id, customerId, values): Promise<void> {
      distributionOn();
      mayManageCustomers();
      if (!String(values.name ?? "").trim()) fail("NAME_REQUIRED");
      if (!customers.some((c) => c.id === customerId)) fail("CUSTOMER_NOT_FOUND");
      // One default per customer, so "where does this go?" always has an answer.
      const wantsDefault = Boolean(values.is_default)
        || !deliveryPoints.some((d) => d.customerId === customerId);
      if (wantsDefault) {
        for (const d of deliveryPoints) {
          if (d.customerId === customerId) d.isDefault = false;
        }
      }
      const found = id ? deliveryPoints.find((d) => d.id === id) : undefined;
      if (id && !found) fail("DELIVERY_POINT_NOT_FOUND");
      const next: DemoDeliveryPoint = {
        id: found?.id ?? crypto.randomUUID(), customerId,
        name: String(values.name).trim(),
        address: (values.address as string | null) ?? found?.address ?? null,
        contactName: (values.contact_name as string | null) ?? found?.contactName ?? null,
        contactPhone: (values.contact_phone as string | null) ?? found?.contactPhone ?? null,
        isDefault: wantsDefault || (found?.isDefault ?? false),
        active: values.active === undefined ? (found?.active ?? true) : Boolean(values.active),
        note: (values.note as string | null) ?? found?.note ?? null,
      };
      if (found) Object.assign(found, next); else deliveryPoints.push(next);
    },

    async recordDeposit(input) {
      distributionOn();
      mayManageCustomers();
      const c = customers.find((x) => x.id === input.customerId);
      if (!c) fail("CUSTOMER_NOT_FOUND");
      if (!input.amount) fail("BAD_PAYMENT_AMOUNT");
      const held = depositHeld(input.customerId);
      // Never hand back more than is being held: the rest would be a loan.
      if (input.amount < 0 && held + input.amount < 0) fail(`MORE_THAN_HELD:${held}`);
      deposits.push({
        id: crypto.randomUUID(), customerId: input.customerId, amount: input.amount,
        method: input.method ?? "cash", at: new Date().toISOString(),
      });
      if (features.accounts) {
        // The dealer's money, held — never income.
        const money = accountForMethod(input.method ?? "cash", branches[0].id)?.id;
        post({
          branchId: branches[0].id,
          narration: input.amount > 0
            ? `Security deposit from ${c!.name ?? c!.phone}`
            : `Security deposit returned to ${c!.name ?? c!.phone}`,
          sourceKind: "customer_payment",
          lines: input.amount > 0
            ? [{ accountId: money, debit: input.amount },
               { role: "customer_deposit", credit: input.amount, customerId: c!.id }]
            : [{ role: "customer_deposit", debit: -input.amount, customerId: c!.id },
               { accountId: money, credit: -input.amount }],
        });
      }
      return { amount: input.amount, held: roundTaka(held + input.amount) };
    },

    async convertCustomer(id, values): Promise<void> {
      mayManageCustomers();
      const c = customers.find((x) => x.id === id);
      if (!c) fail("CUSTOMER_NOT_FOUND");
      const kind = values.kind as string | undefined;
      if (kind && !["retail", "dealer", "retailer", "corporate"].includes(kind)) {
        fail(`BAD_CUSTOMER_KIND:${kind}`);
      }
      // Blocking needs a reason: "why can this customer not buy?" is asked at the till,
      // by somebody who was not there when it was decided.
      if (values.blocked === true && !String(values.block_reason ?? "").trim()) {
        fail("REASON_REQUIRED");
      }
      if (kind) c!.kind = kind as CustomerKind;
      if (values.rep_id !== undefined) c!.repId = (values.rep_id as string | null) ?? null;
      if (values.parent_id !== undefined) {
        if (values.parent_id === id) fail("CUSTOMER_CANNOT_BE_ITS_OWN_DEALER");
        c!.parentId = (values.parent_id as string | null) ?? null;
      }
      if (values.blocked !== undefined) {
        c!.blocked = Boolean(values.blocked);
        c!.blockReason = c!.blocked ? String(values.block_reason ?? "") : null;
      }
      if (values.cash_only !== undefined) c!.cashOnly = Boolean(values.cash_only);
      if (values.is_vip !== undefined) c!.isVip = Boolean(values.is_vip);
      if (values.group_id !== undefined) c!.groupId = (values.group_id as string | null) ?? null;
      if (values.price_list_id !== undefined) {
        c!.priceListId = (values.price_list_id as string | null) ?? null;
      }
      if (values.credit_allowed !== undefined) c!.creditAllowed = Boolean(values.credit_allowed);
      if (values.credit_limit !== undefined) c!.creditLimit = Number(values.credit_limit);
      if (values.payment_days !== undefined) c!.paymentDays = Number(values.payment_days);
    },

    async moveCustomerBranch(id, branchId, reason) {
      mayManageCustomers();
      const c = customers.find((x) => x.id === id);
      if (!c) fail("CUSTOMER_NOT_FOUND");
      branchOr404(branchId);
      // The debt goes with them; the sales stay where they happened, or last month's
      // branch figures would change every time somebody moved a customer.
      const owed = dueFor(id);
      c!.homeBranchId = branchId;
      void reason;
      return { owed };
    },

    async searchCustomers(input): Promise<CustomerSearchRow[]> {
      const q = (input?.query ?? "").trim().toLowerCase();
      return customers
        .filter((c) => {
          const rep = employees.find((e) => e.id === c.repId)?.name ?? "";
          const hit = !q
            || `${c.name ?? ""} ${c.phone} ${c.company ?? ""} ${c.address ?? ""} ${rep}`
                .toLowerCase().includes(q);
          const kindOk = !input?.kind || (c.kind ?? "retail") === input.kind;
          const repOk = !input?.repId || c.repId === input.repId;
          const flagOk = !input?.flag
            || (input.flag === "blocked" && c.blocked)
            || (input.flag === "cash_only" && c.cashOnly)
            || (input.flag === "vip" && c.isVip)
            || (input.flag === "has_deposit" && depositHeld(c.id) > 0);
          return hit && kindOk && repOk && flagOk;
        })
        .map((c): CustomerSearchRow => ({
          id: c.id, phone: c.phone, name: c.name ?? c.phone, company: c.company,
          address: c.address, kind: (c.kind ?? "retail") as CustomerKind,
          group: c.group, groupId: c.groupId,
          rep: employees.find((e) => e.id === c.repId)?.name ?? null,
          repId: c.repId ?? null,
          parent: customers.find((x) => x.id === c.parentId)?.name ?? null,
          parentId: c.parentId ?? null,
          homeBranch: branches.find((b) => b.id === c.homeBranchId)?.name ?? null,
          homeBranchId: c.homeBranchId ?? null,
          districtId: null, district: null,
          blocked: Boolean(c.blocked), blockReason: c.blockReason ?? null,
          cashOnly: Boolean(c.cashOnly), isVip: Boolean(c.isVip),
          creditAllowed: c.creditAllowed, creditLimit: c.creditLimit,
          paymentDays: c.paymentDays, owed: dueFor(c.id), deposit: depositHeld(c.id),
          deliveryPoints: deliveryPoints.filter(
            (d) => d.customerId === c.id && d.active).length,
          active: c.active !== false,
        }))
        .slice(0, input?.limit ?? 100);
    },

    async rebuildStockLayers(): Promise<LayerRebuildResult> {
      if (staff.role !== "owner") fail("NOT_OWNER");
      // Demo mode has no layers to rebuild: it works out which delivery a unit came
      // from on the spot. The real one replays every movement in order.
      const layers = deliveries.reduce((n, g) => n + g.lines.length, 0);
      return { movements: movements.length, layers, openLayers: layers };
    },
  };

  /** An expense category becomes the account of the same name, or Other expenses. */
  function expenseAccountFor(categoryName: string): string {
    const match = accounts.find(
      (a) => a.active && a.name.toLowerCase() === categoryName.toLowerCase());
    return (match ?? accounts.find((a) => a.code === "6900"))!.id;
  }

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

/** "September 2026", for the period-lock message. */
function monthWords(month: string): string {
  const [y, m] = month.split("-");
  return `${new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-GB", { month: "long" })} ${y}`;
}
