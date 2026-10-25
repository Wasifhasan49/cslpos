export type Role = "owner" | "manager" | "cashier";
/** What the till can take. "due" puts the sale on the customer's slate (P10); the
 *  shop has to switch credit sales on before it appears. */
export type PaymentMethod =
  | "cash" | "bkash" | "nagad" | "card" | "rocket" | "bank" | "cheque" | "due";

/** A stock location inside a branch — BMS calls these "stores". */
export interface StockLocation {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface Branch {
  id: string;
  name: string;
  /** Short, and it goes in every document number. */
  code: string;
  locations: StockLocation[];
}

/** A branch as the owner administers it, with the fields the switcher doesn't need. */
export interface BranchAdmin extends Branch {
  address: string | null;
  phone: string | null;
  active: boolean;
  nextInvoice: number;
}

export interface Staff {
  id: string;
  name: string;
  role: Role;
  discountLimitPct: number;
  shopName: string;
  /** Whether this person has an approval PIN. The hash itself is never readable, so
   *  the PIN screen asks the database. */
  hasPin: boolean;
  /** Branches this person may work in. Owners get all of them. Never empty for a
   *  usable login — a staff member with no branch can't sell anywhere. */
  branches: Branch[];
}

/** One staff member as the owner sees them in Settings. */
export interface StaffMember {
  id: string;
  name: string;
  role: Role;
  discountLimitPct: number;
  active: boolean;
  hasPin: boolean;
  branchIds: string[];
}

/**
 * The result of asking "who is signed in?". Three outcomes, not two: a login with no
 * staff row is a real, recoverable situation ("ask the owner to add you") and must not
 * be confused with being signed out, which is what a plain `Staff | null` did.
 */
export type StaffLookup =
  | { kind: "ok"; staff: Staff }
  | { kind: "signed-out" }
  | { kind: "no-staff"; email: string | null };

/** An owner or manager who has a PIN and can approve a discount. */
export interface Approver {
  id: string;
  name: string;
  role: Role;
}

/** What verify_manager_pin() answers. A wrong PIN is a result, not an error, so the
 *  attempt can be recorded instead of rolled back. */
export type ApprovalResult =
  | { ok: true; approvalId: string; approverId: string; approverName: string }
  | { ok: false; locked: boolean; triesLeft: number };

export interface Category {
  id: string;
  name: string;
}

export interface SerialUnit {
  id: string;
  serial: string;
}

export interface PriceList {
  id: string;
  name: string;
  isDefault: boolean;
  active: boolean;
}

/** What the counter sees. No cost price, ever. */
export interface Product {
  id: string;
  code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  categoryId: string | null;
  price: number;
  warrantyMonths: number;
  isSerial: boolean;
  /** Stock AT THE CURRENT BRANCH, not the shop total. */
  stock: number;
  reorderLevel: number;
  serials: SerialUnit[]; // in-stock units at this branch, for serial items
  /** Maximum Retail Price, if the shop records it. */
  mrp?: number | null;
  /** The band a seller may move the price inside. Below `minPrice` needs a manager.
   *  With no band set, `minPrice` equals the list price: the owner has given nobody
   *  permission to go below it. */
  minPrice?: number | null;
  maxPrice?: number | null;
  /** A service: no stock to run out of. */
  isInventory?: boolean;
}

/** A row in the owner's product list. Cost and margin are ABSENT, not null, for a
 *  login that may not see them — the numbers never reach the browser. */
export interface CatalogueRow {
  id: string;
  code: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  model?: string | null;
  categoryId: string | null;
  category?: string | null;
  unit?: string | null;
  specification?: string | null;
  warrantyMonths: number;
  warrantyTerm?: string | null;
  isSerial: boolean;
  isInventory: boolean;
  active: boolean;
  reorderLevel: number;
  price: number;
  mrp: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** Stock at the branch being viewed, and across the whole shop. */
  stock: number;
  totalStock: number;
  cost?: number;
  marginPct?: number;
}

/** What the counter learns when it looks a customer up by phone. */
export interface CustomerLookup {
  id: string;
  phone: string;
  name: string | null;
  priceListId: string | null;
  priceListName: string | null;
  /** A standing discount the owner granted. It applies on its own, with no approval. */
  discountPct: number;
  /** The group they belong to (Retail, Dealer, Corporate…), which can carry the list. */
  group?: string | null;
  /** Whether they may buy on due at all (P10). */
  creditAllowed?: boolean;
  creditLimit?: number;
  paymentDays?: number;
  /** What they owe right now. */
  owed?: number;
  /** How much more they may put on the slate. Null when no limit is set. */
  creditLeft?: number | null;
}

export interface BulkPriceChange {
  productId: string;
  name: string;
  from: number;
  to: number;
}

export interface CartLine {
  productId: string;
  qty: number; // for serial items this always equals serialIds.length
  serialIds: string[];
  /** What the seller wants to charge, if they changed it. Left out means "the price the
   *  owner set". The database re-checks it against the band either way. */
  unitPrice?: number | null;
}

export interface SaleInput {
  /** Which branch is selling. Checked against staff_branches in the database, so the
   *  browser cannot sell out of a branch it does not work in. */
  branchId: string;
  lines: CartLine[];
  paymentMethod: PaymentMethod;
  discountPct: number;
  /** From verify_manager_pin(). Needed only when the discount is over the seller's
   *  limit. The PIN itself never travels with the sale. */
  approvalId: string | null;
  /** Extra charges the shop has configured (delivery, installation). P10a adds the
   *  counter UI; the rule lives in complete_sale() already. */
  chargeIds?: string[];
  /** Why the discount was given, for the owner's report. */
  discountTypeId?: string | null;
  /** How this sale is classified in reports (BMS "Transaction Category"). */
  categoryId?: string | null;
  /** Which price list to charge from. Left out means the customer's own list, or the
   *  shop default for a walk-in. */
  priceListId?: string | null;
  customerPhone: string | null;
  cashReceived: number | null;
  paymentRef: string | null;
  /** How much of the total is going on the customer's slate instead of being paid now
   *  (P10). A payment method of "due" puts the whole lot on it. */
  dueAmount?: number;
  /** Everything the advanced counter adds (P10a): card and EMI details, an exchange,
   *  a split payment, the corporate fields, and the shop's own extra fields. */
  extras?: SaleExtras;
}

export interface ReceiptLine {
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  warrantyUntil: string | null; // YYYY-MM-DD
  serials: string[];
  /** 0 when the shop does not charge VAT, or this product has no rate. */
  vatPct: number;
  vatAmount: number;
  /** Inclusive means the tax is already inside unitPrice. */
  vatInclusive: boolean;
  /** The price the owner set, when the seller charged something else. */
  listPrice?: number | null;
  priceOverridden?: boolean;
  /** A free item from an offer: charged at zero, but it still left the shelf. */
  isGift?: boolean;
}

export interface Receipt {
  id: string;
  invoiceNo: string;
  createdAt: string;
  staffName: string;
  shopName: string;
  shopAddress: string | null;
  branchName: string;
  /** The branch's own address and phone go on the receipt: a customer needs the shop
   *  they actually bought from, not head office. */
  branchAddress: string | null;
  branchPhone: string | null;
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  total: number;
  paymentMethod: PaymentMethod;
  cashReceived: number | null;
  changeGiven: number | null;
  paymentRef: string | null;
  customerPhone: string | null;
  /** What was handed over now, and what went on the customer's slate (P10). */
  paidAmount?: number;
  dueAmount?: number;
  /** What the customer owes in total after this sale. Null for a walk-in. */
  customerOwes?: number | null;
  /** P10a: what the card company and the bank added, and what the old item was worth. */
  cardCharge?: number;
  emiCharge?: number;
  exchangeValue?: number;
  emiMonths?: number | null;
  emiBank?: string | null;
  cardType?: string | null;
  cardLast4?: string | null;
  attention?: string | null;
  customerBin?: string | null;
  narration?: string | null;
  soldBy?: string | null;
  extraFields?: Record<string, string> | null;
  exchange?: { description: string; serial: string | null; value: number } | null;
  payments?: { method: string; amount: number; reference: string | null }[];
  /** The VAT on this sale. Inclusive VAT is already inside `total`; exclusive VAT was
   *  added to it. Either way the receipt has to say how much tax there was. */
  vatAmount: number;
  chargesAmount: number;
  charges: { name: string; amount: number }[];
  receiptFooter: string | null;
  binVat: string | null;
  /** Which price list was used, so a dealer bill says so. */
  priceListName?: string | null;
  customerName?: string | null;
  /** The customer's standing discount, if they had one. */
  customerDiscountPct?: number;
  items: ReceiptLine[];
}


// --- P2: setup lists and shop settings -------------------------------------

export type FeatureKey =
  | "vat" | "multi_location" | "price_lists" | "credit_sales" | "purchase_orders"
  | "transfers" | "accounts" | "sms" | "extra_charges" | "hs_codes"
  | "managers_see_dashboard" | "managers_see_accounts" | "managers_see_settings";

export interface ShopDetails {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
  /** VAT registration (BIN). Empty for a shop that is not registered. */
  binVat: string | null;
  receiptFooter: string | null;
  invoicePrefix: string;
  currency: string;
  aitPct: number;
  /** Purchase orders over this need the owner's sign-off. 0 means never. */
  poApprovalLimit: number;
  /** How far out the cash drawer can be before it is flagged. */
  cashShortLimit: number;
  /** How long after a sale a return is routine. Past it, a manager approves. */
  returnDays: number;
  /** Sales over this wait for approval before posting. 0 means no threshold. */
  saleApprovalLimit: number;
  /** Every sale waits for approval, whatever it is worth. */
  approveAllSales: boolean;
  /** Who pays the card company's cut: the shop absorbs it, or it goes on the bill. */
  cardChargeMode: "absorb" | "add";
}

/** Which setup list a row belongs to. Matches the tables save_setting_row() allows. */
export type SettingTable =
  | "units" | "vat_rates" | "hs_codes" | "extra_charges" | "discount_types"
  | "payment_methods" | "card_types" | "bank_accounts" | "warranty_terms"
  | "transaction_categories" | "sale_fields";

/** A row in one of the setup lists. Deliberately loose: the lists differ, and the
 *  database validates the field names, so the UI does not need ten interfaces. */
export type SettingRow = { id: string } & Record<string, string | number | boolean | null>;

export interface PermissionKey {
  key: string;
  label: string;
  area: string;
  hasLimit: boolean;
}

export interface RolePermission {
  role: Role;
  perm: string;
  allowed: boolean;
  numLimit: number | null;
}

export interface StaffPermission {
  staffId: string;
  perm: string;
  allowed: boolean;
  numLimit: number | null;
}

export interface DocumentSequence {
  branchId: string;
  docType: string;
  prefix: string;
  nextNumber: number;
}

/** Everything the Settings area needs, in one load. */
export interface SettingsBundle {
  shop: ShopDetails;
  features: Record<string, boolean>;
  lists: Record<SettingTable, SettingRow[]>;
  permissionKeys: PermissionKey[];
  rolePermissions: RolePermission[];
  staffPermissions: StaffPermission[];
  documentSequences: DocumentSequence[];
}


// --- P5: suppliers, goods in, corrections ----------------------------------

export interface SupplierGroup { id: string; name: string }

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  groupId: string | null;
  groupName: string | null;
  /** A one-off seller with no account, who can never be given credit. */
  isCashOnly: boolean;
  note: string | null;
  active: boolean;
  /** Opening balance plus credit purchases, less payments and returns. Computed, so it
   *  cannot drift away from the documents behind it. */
  balance: number;
}

export interface ReceiveLine {
  productId: string;
  qty: number;
  unitCost: number | null;
  lineDiscount?: number;
  /** Serial text for a serial-tracked product. */
  serials?: string[];
}

export interface ReceiveResult {
  grnNo: string;
  subtotal: number;
  total: number;
  costMissing: boolean;
  supplierDue: number | null;
  lines: { name: string; qty: number; unitCost: number | null; landedCost: number | null; averageCost: number | null }[];
}

export type StockReason = "damaged" | "lost" | "found_in_count" | "internal_use" | "expired" | "other";

export interface StockMovementRow {
  at: string;
  product: string;
  code: string;
  change: number;
  reason: string;
  why: StockReason | null;
  note: string | null;
  who: string | null;
  location: string | null;
}

export interface CountDifference {
  productId: string;
  name: string;
  expected: number;
  counted: number;
  change: number;
}

export interface GoodsReceivedRow {
  id: string;
  grnNo: string;
  supplierName: string | null;
  supplierInvoiceNo: string | null;
  isCredit: boolean;
  total: number;
  costMissing: boolean;
  createdAt: string;
  lines: {
    id: string;
    product: string;
    qty: number;
    unitCost: number | null;
    landedCost: number | null;
  }[];
}

// --- P6: purchase paperwork and supplier dues ------------------------------

export type RequisitionStatus =
  | "draft" | "submitted" | "approved" | "rejected" | "ordered" | "cancelled";

export interface RequisitionRow {
  id: string;
  reqNo: string;
  status: RequisitionStatus;
  neededBy: string | null;
  note: string | null;
  askedBy: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  lines: { id: string; productId: string; product: string; qty: number; note: string | null }[];
}

export type PurchaseOrderStatus =
  | "draft" | "awaiting_approval" | "sent" | "partly_received"
  | "received" | "closed" | "cancelled";

export interface PurchaseOrderRow {
  id: string;
  poNo: string;
  status: PurchaseOrderStatus;
  /** The branch the goods are to be delivered to. */
  branchId: string;
  supplierId: string;
  supplierName: string | null;
  paymentTermsDays: number;
  discount: number;
  charges: number;
  vat: number;
  subtotal: number;
  total: number;
  note: string | null;
  cancelReason: string | null;
  createdAt: string;
  lines: {
    id: string;
    productId: string;
    product: string;
    code: string;
    qty: number;
    unitPrice: number;
    lineDiscount: number;
    receivedQty: number;
  }[];
}

export interface PurchaseOrderInput {
  id?: string;
  branchId: string;
  supplierId: string;
  lines: {
    productId: string; qty: number; unitPrice: number;
    lineDiscount?: number; reqItemId?: string | null;
  }[];
  termsDays?: number;
  discount?: number;
  charges?: number;
  vat?: number;
  note?: string | null;
  reqIds?: string[] | null;
}

export interface PurchaseOrderSaved {
  id: string;
  poNo: string;
  subtotal: number;
  total: number;
  status: PurchaseOrderStatus;
  /** True when it went over the shop's limit and is waiting for the owner. */
  needsApproval: boolean;
}

export type PoAction = "approve" | "send" | "cancel" | "close";

export interface ReorderSuggestion {
  productId: string;
  name: string;
  code: string;
  stock: number;
  reorderLevel: number;
  soldInPeriod: number;
  perDay: number;
  /** Null when nothing has sold: "never runs out" is a different problem. */
  daysLeft: number | null;
  suggestQty: number;
  lastCost: number | null;
}

export interface LedgerEntry {
  at: string;
  kind: "opening" | "purchase" | "payment" | "return";
  document: string;
  change: number;
  note: string | null;
}

export interface SupplierAging {
  days0to30: number;
  days31to60: number;
  days60plus: number;
  total: number;
  /** A return or overpayment not yet used up. */
  unapplied: number;
}

export interface SupplierPaymentResult {
  supplier: string;
  amount: number;
  balance: number;
  aging: SupplierAging;
}

export interface PoReceiveResult extends ReceiveResult {
  poNo: string;
  poStatus: PurchaseOrderStatus;
  pending: { product: string; ordered: number; received: number; pending: number }[];
}

// --- P7: branch transfers --------------------------------------------------

export type TransferStatus = "in_transit" | "received" | "disputed" | "cancelled";

export interface TransferLine {
  id: string;
  productId: string;
  product: string;
  code: string;
  isSerial: boolean;
  qty: number;
  receivedQty: number;
  damagedQty: number;
  unitCost: number | null;
  note: string | null;
  serials: { id: string; serial: string; arrivedOk: boolean | null }[];
}

export interface TransferRow {
  id: string;
  transferNo: string;
  status: TransferStatus;
  fromBranchId: string;
  fromBranchName: string;
  toBranchId: string;
  toBranchName: string;
  note: string | null;
  sentAt: string;
  receivedAt: string | null;
  resolution: "returned" | "written_off" | null;
  totalCost: number;
  lines: TransferLine[];
}

export type TransferRequestStatus =
  | "submitted" | "approved" | "rejected" | "sent" | "cancelled";

export interface TransferRequestRow {
  id: string;
  reqNo: string;
  status: TransferRequestStatus;
  /** The branch being asked. */
  fromBranchId: string;
  fromBranchName: string;
  /** The branch that asked. */
  toBranchId: string;
  toBranchName: string;
  note: string | null;
  decisionNote: string | null;
  askedBy: string | null;
  createdAt: string;
  lines: { id: string; productId: string; product: string; qty: number }[];
}

export interface TransferSent {
  id: string;
  transferNo: string;
  totalCost: number;
  lines: { product: string; qty: number; unitCost: number | null }[];
}

export interface TransferReceived {
  transferNo: string;
  status: TransferStatus;
  lines: { product: string; sent: number; ok: number; damaged: number; short: number }[];
}

/** What is on the road right now, with how long it has been out. */
export interface InTransitRow {
  id: string;
  transferNo: string;
  status: TransferStatus;
  fromBranch: string;
  toBranch: string;
  sentAt: string;
  daysOut: number;
  totalCost: number;
  items: { product: string; qty: number; received: number }[];
}

/** One allowed direction. A shop with none set may send anywhere. */
export interface TransferRoute {
  fromBranchId: string;
  toBranchId: string;
}

// --- P8: shifts and the cash check -----------------------------------------

/** What the till needs to know before it can sell. */
export interface ShiftState {
  open: boolean;
  shiftId: string | null;
  openedAt: string | null;
  openingCash: number | null;
  /** What the last person to close this branch's drawer counted. */
  lastClose: number | null;
  /** Owners may sell without a drawer; the till warns them instead of blocking. */
  maySellWithoutShift: boolean;
}

export type CashReason =
  | "expense" | "owner_took" | "owner_put_in" | "bought_change" | "bank_deposit" | "other";

export interface CashMovementRow {
  at: string;
  direction: "in" | "out";
  amount: number;
  reason: CashReason;
  category: string | null;
  note: string | null;
  who: string | null;
}

/** One shift as the owner sees it. A cashier never receives this. */
export interface ShiftRow {
  id: string;
  staff: string;
  openedAt: string;
  closedAt: string | null;
  openingCash: number;
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
  /** Out by more than the shop's limit, so worth asking about. */
  overLimit: boolean;
  note: string | null;
  noteCounts: Record<string, number> | null;
  salesCount: number;
  /** Totals per payment method, for matching bKash and card against statements. */
  byMethod: Record<string, number>;
  cashIn: number;
  cashOut: number;
  movements: CashMovementRow[];
}

/** Closing tells a cashier only that it is closed; a manager also gets the figures. */
export interface ShiftClosed {
  closed: boolean;
  expected?: number;
  counted?: number;
  difference?: number;
  overLimit?: boolean;
}

// --- P9: sales history, void and returns -----------------------------------

export type SaleStatus = "completed" | "void";
export type ApprovalStatus = "approved" | "awaiting_approval" | "cancelled";
export type RefundMethod =
  | "cash" | "bkash" | "nagad" | "card" | "store_credit" | "reduce_due";

/** One row in the sales list. */
export interface SaleRow {
  id: string;
  invoiceNo: string;
  createdAt: string;
  branch: string;
  branchId: string;
  staff: string;
  total: number;
  discountAmount: number;
  paymentMethod: string;
  status: SaleStatus;
  approvalStatus: ApprovalStatus;
  customerPhone: string | null;
  customerName: string | null;
  itemCount: number;
  /** What the lines were, in one line, so the list is scannable. */
  summary: string | null;
  /** How many units have already come back, so nothing is refunded twice. */
  returned: number;
}

export interface SaleDetailLine {
  id: string;
  productId: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  vatPct: number;
  vatAmount: number;
  vatInclusive: boolean;
  isGift: boolean;
  warrantyUntil: string | null;
  returnedQty: number;
  /** What one unit is worth back, after its share of the sale's discount. */
  refundEach: number;
  isSerial: boolean;
  serials: { id: string; serial: string; status: string }[];
}

export interface SaleDetail {
  id: string;
  invoiceNo: string;
  createdAt: string;
  branch: string;
  branchId: string;
  branchAddress: string | null;
  branchPhone: string | null;
  shopName: string;
  receiptFooter: string | null;
  binVat: string | null;
  staff: string;
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  vatAmount: number;
  chargesAmount: number;
  total: number;
  paymentMethod: string;
  cashReceived: number | null;
  changeGiven: number | null;
  paymentRef: string | null;
  status: SaleStatus;
  approvalStatus: ApprovalStatus;
  voidReason: string | null;
  refundMethod: string | null;
  customerId?: string | null;
  customerPhone: string | null;
  customerName: string | null;
  /** What was paid at the time, and what went on the slate (P10). */
  paidAmount?: number;
  dueAmount?: number;
  /** Same day means it can still be voided rather than returned. */
  sameDay: boolean;
  daysOld: number;
  /** The shop's return window, in days. */
  returnDays: number;
  items: SaleDetailLine[];
  returns: {
    id: string;
    returnNo: string;
    createdAt: string;
    branch: string;
    total: number;
    reason: string | null;
    refundMethod: string;
    approvalStatus: ApprovalStatus;
  }[];
}

export interface ReturnResult {
  returnNo: string;
  total: number;
  subtotal: number;
  vatAmount: number;
  chargesBack: number;
  refundMethod: RefundMethod;
  lines: { name: string; qty: number; refund: number; faulty: boolean }[];
  /** True when the last unit came back, which is when charges are refunded too. */
  wholeSaleReturned: boolean;
}

// --- P10: credit sales and customers ---------------------------------------

export interface CustomerGroup {
  id: string;
  name: string;
  priceListId: string | null;
  discountPct: number;
  creditAllowed: boolean;
  creditLimit: number;
  paymentDays: number;
  active: boolean;
}

export interface CustomerRow {
  id: string;
  phone: string;
  name: string;
  company: string | null;
  address: string | null;
  groupId: string | null;
  group: string | null;
  priceListId: string | null;
  priceList: string | null;
  discountPct: number;
  binVat: string | null;
  nid: string | null;
  note: string | null;
  active: boolean;
  districtId: number | null;
  upazilaId: number | null;
  creditAllowed: boolean;
  creditLimit: number;
  paymentDays: number;
  /** What they owe right now, worked out from the documents. */
  owed: number;
  totalSpent: number;
}

export interface CustomerAging {
  days0to30: number;
  days31to60: number;
  days60plus: number;
  total: number;
  paymentDays: number;
  /** Older than the days THIS customer was given, which is not the same as 60+. */
  overdue: number;
  /** They have paid more than they owe. */
  inCredit: number;
}

export interface DueRow {
  customerId: string;
  name: string;
  phone: string;
  company: string | null;
  group: string | null;
  creditLimit: number;
  paymentDays: number;
  owed: number;
  aging: CustomerAging;
  overdue: number;
  lastPaid: string | null;
  oldestDue: string | null;
}

export interface StatementEntry {
  at: string;
  kind: "opening" | "sale" | "payment" | "return";
  document: string;
  change: number;
  note: string | null;
}

export interface CustomerStatement {
  customerId: string;
  name: string;
  phone: string;
  company: string | null;
  address: string | null;
  binVat: string | null;
  nid: string | null;
  note: string | null;
  group: string | null;
  priceList: string | null;
  discountPct: number;
  creditAllowed: boolean;
  creditLimit: number;
  paymentDays: number;
  owed: number;
  aging: CustomerAging;
  totalSpent: number;
  saleCount: number;
  entries: StatementEntry[];
  purchases: {
    id: string; invoiceNo: string; at: string; branch: string;
    total: number; due: number; status: string; items: string | null;
  }[];
  /** Serial-tracked items this customer owns, with the warranty end date. */
  owns: {
    serial: string; product: string; bought: string; invoiceNo: string;
    warrantyUntil: string | null; inWarranty: boolean; status: string;
  }[];
}

export interface PaymentReceipt {
  receiptNo: string;
  paymentId: string;
  customer: string;
  amount: number;
  wasOwed: number;
  owed: number;
  shopName: string;
  branch: string;
  takenBy: string;
}

// --- P10a: the full counter ------------------------------------------------

export interface EmiPlan {
  id: string;
  bank: string;
  months: number;
  chargePct: number;
  /** Banks will not run EMI below this. */
  minAmount: number;
  active: boolean;
}

/** A shop-defined extra field on a sale (BMS "Additional Info"). */
export interface SaleField {
  id: string;
  name: string;
  showOnInvoice: boolean;
  active: boolean;
}

/** What the counter is told before it argues about a price. Never cost or margin. */
export interface PriceHelp {
  productId: string;
  lastPriceToCustomer: number | null;
  lastPriceToCustomerOn: string | null;
  lastPrice: number | null;
  here: number;
  elsewhere: { branch: string; qty: number }[];
  emiAllowed: boolean;
  emiPlans: EmiPlan[];
}

/** One part of a split payment. */
export interface SplitPayment {
  method: PaymentMethod | "exchange";
  amount: number;
  reference?: string | null;
  accountId?: string | null;
}

/** Everything the advanced counter adds to a sale. One object, not twelve fields. */
export interface SaleExtras {
  attention?: string | null;
  customerAddress?: string | null;
  customerBin?: string | null;
  customerNid?: string | null;
  narration?: string | null;
  /** Defaults to whoever is logged in. */
  soldBy?: string | null;
  /** The shop's own fields, by name. Only ones it has defined are accepted. */
  extraFields?: Record<string, string>;
  card?: {
    typeId?: string | null;
    bank?: string | null;
    posAccountId?: string | null;
    last4?: string | null;
  };
  emi?: { months: number; bank?: string | null };
  exchange?: {
    description: string;
    serial?: string | null;
    value: number;
    /** Which product to book it in as, when it is going back on the shelf. */
    productId?: string | null;
    addToStock?: boolean;
  };
  payments?: SplitPayment[];
}
