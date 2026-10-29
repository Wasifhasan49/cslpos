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
  /** Of that stock, how much is promised to an open sales order (P14a) and must not be
   *  sold to a walk-in. */
  reserved?: number;
  reorderLevel: number;
  serials: SerialUnit[]; // in-stock units at this branch, for serial items
  /** Units out at a customer's on a delivery note: not sellable, but billable. */
  deliveredSerials?: SerialUnit[];
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
  | "managers_see_dashboard" | "managers_see_accounts" | "managers_see_settings"
  // P14a and P14b.
  | "sales_documents" | "hr" | "hr_extra_fields";

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
  /** An order over this waits for the owner instead of going out (P14a). */
  soApprovalLimit: number;
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
  /** Whether a new warranty claim waits for a manager before it can move. */
  claimApproval: boolean;
  /** Whether a typed voucher waits for a manager before it reaches the books (P13). */
  voucherApproval: boolean;
}

/** Which setup list a row belongs to. Matches the tables save_setting_row() allows. */
export type SettingTable =
  | "units" | "vat_rates" | "hs_codes" | "extra_charges" | "discount_types"
  | "payment_methods" | "card_types" | "bank_accounts" | "warranty_terms"
  | "transaction_categories" | "sale_fields"
  // P14b. The HR lists need the `manage_hr` permission, not just `edit_settings`.
  | "departments" | "designations" | "positions" | "professions" | "leave_types";

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
  /** This bill is for goods already delivered on a challan (P14a), so the stock must
   *  not move again and the serials come from `delivered` rather than the shelf. */
  challanId?: string | null;
  orderId?: string | null;
  /** Serial ids to deliver, per product, when billing an order straight out. */
  serials?: Record<string, string[]> | null;
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

// --- P11: warranty lookup and claims ---------------------------------------

export type ClaimStatus =
  | "received" | "diagnosed" | "with_supplier" | "back_from_supplier"
  | "repaired" | "ready" | "delivered" | "rejected";

/** One thing the warranty lookup found. */
export interface WarrantyHit {
  /** Where it came from: a sale, a warranty swap, or a record typed in by hand. */
  kind: "sold" | "replacement" | "manual";
  serialId: string | null;
  serial: string | null;
  serialStatus: string | null;
  productId: string | null;
  product: string | null;
  saleId: string | null;
  saleItemId: string | null;
  invoiceNo: string | null;
  soldOn: string | null;
  branch: string | null;
  soldBy: string | null;
  customerId: string | null;
  customerPhone: string | null;
  customerName: string | null;
  warrantyMonths: number | null;
  warrantyUntil: string | null;
  /** What the warranty actually covers, in the shop's own words. */
  warrantyText: string | null;
  inWarranty: boolean;
  daysLeft: number | null;
  saleStatus: string | null;
  /** The claim already open on this unit, if there is one. */
  openClaim: string | null;
}

export interface ClaimEvent {
  at: string;
  to: ClaimStatus;
  note: string | null;
  who: string | null;
}

export interface ClaimRow {
  id: string;
  claimNo: string;
  status: ClaimStatus;
  approvalStatus: ApprovalStatus;
  branch: string;
  branchId: string;
  product: string | null;
  serial: string | null;
  serialId: string | null;
  problem: string;
  problemType: string | null;
  /** What came in with it, so a missing charger has an answer. */
  accessories: string[];
  inWarranty: boolean;
  warrantyUntil: string | null;
  customerPhone: string | null;
  customerName: string | null;
  technician: string | null;
  technicianId: string | null;
  supplier: string | null;
  supplierId: string | null;
  sentAt: string | null;
  backAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
  takenInBy: string;
  resolution: string | null;
  replacementSerial: string | null;
  /** How long the shop has had it. The figure a customer rings about. */
  daysWaiting: number;
  daysWithSupplier: number | null;
  open: boolean;
  events: ClaimEvent[];
  parts: { product: string; qty: number }[];
}

export interface SupplierRmaRow {
  supplier: string;
  supplierId: string;
  claimNo: string;
  claimId: string;
  product: string | null;
  serial: string | null;
  sentAt: string;
  daysOut: number;
  problem: string;
  branch: string;
}

export interface ProblemType { id: string; name: string; active: boolean }
export interface Technician {
  id: string;
  name: string;
  phone: string | null;
  staffId: string | null;
  active: boolean;
}

// --- P12: the owner dashboard ----------------------------------------------

export interface DashboardTotals {
  sales: number;
  profit: number;
  saleCount: number;
  averageSale: number;
  /** Lines the shop has no cost for. Shown, not hidden: the profit is short by them. */
  linesWithoutCost: number;
}

export interface Dashboard {
  from: string;
  to: string;
  days: number;
  branchId: string | null;
  branch: string | null;
  today: DashboardTotals;
  /** The same length of time immediately before. */
  before: { sales: number; profit: number; saleCount: number; from: string; to: string };
  /** The same days a week earlier — a different question from "yesterday". */
  weekBefore: { sales: number; profit: number; from: string; to: string };
  branches: {
    branchId: string; branch: string; sales: number; profit: number; saleCount: number;
  }[];
  byMethod: Record<string, number>;
  /** The row an owner coming from BMS expects to see. */
  summary: {
    cashSales: number;
    creditSales: number;
    salesReturns: number;
    cashPurchases: number;
    creditPurchases: number;
    purchaseReturns: number;
    claimsTaken: number;
    moneyIn: number;
    moneyOut: number;
  };
  busyHours: { hour: number; sales: number; count: number }[];
  bestByProfit: {
    productId: string; product: string; qty: number; sales: number; profit: number | null;
  }[];
  bestByQty: { productId: string; product: string; qty: number; sales: number }[];
  staff: {
    staffId: string; staff: string; sales: number; saleCount: number;
    discountGiven: number; profit: number;
  }[];
  lowStock: {
    productId: string; product: string; code: string; branch: string; branchId: string;
    stock: number; reorderLevel: number; sold30: number;
    elsewhere: { branch: string; qty: number }[];
  }[];
  dustyStock: {
    productId: string; product: string; code: string; stock: number;
    cost: number | null; tiedUp: number; lastSold: string | null;
  }[];
  owed: { byCustomers: number; toSuppliers: number };
  watch: {
    at: string; action: string; entity: string; entityId: string | null;
    branch: string | null; who: string | null;
    details: Record<string, unknown> | null;
  }[];
}

export type DashboardDetailKind =
  | "sales" | "profit" | "returns" | "dues" | "supplier_dues";

/** One row behind a tapped figure. Deliberately loose: each kind lists different things. */
export type DashboardDetailRow = Record<string, unknown>;

// --- Accounts (P13) ---------------------------------------------------------

export type AccountNature = "asset" | "liability" | "equity" | "income" | "expense";

/** What an account IS, so the auto-posting can find it without matching on names. */
export type AccountRole =
  | "cash_in_hand" | "bank" | "wallet" | "receivable" | "payable" | "inventory"
  | "vat_payable" | "sales" | "sales_return" | "cogs" | "discount_given"
  | "purchase_return" | "stock_loss" | "stock_gain" | "inter_branch"
  | "card_charge" | "opening_equity" | "rounding"
  // P14: proving the books against the shelves needed these three.
  | "vat_input" | "ait_advance" | "stock_in_transit"
  // P14a: money held for a customer, and goods gone but not yet billed.
  | "customer_advance" | "goods_delivered";

export interface ChartAccount {
  id: string;
  code: string;
  name: string;
  role: AccountRole | null;
  group: string;
  nature: AccountNature;
  active: boolean;
  branchId: string | null;
  branch: string | null;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  group: string;
  nature: AccountNature;
  branch: string | null;
  debit: number;
  credit: number;
  /** Positive on the side the account normally sits: assets and expenses debit. */
  balance: number;
}

export interface TrialBalance {
  from: string | null;
  to: string | null;
  branch: string | null;
  accounts: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  /** Reported, not asserted: if the two columns ever differ the owner must SEE it. */
  balanced: boolean;
}

export interface LedgerLine {
  entryId: string;
  entryNo: string;
  date: string;
  narration: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  branch: string | null;
  debit: number;
  credit: number;
  note: string | null;
  party: string | null;
  who: string | null;
}

export interface AccountLedger {
  account: { id: string; code: string; name: string; nature: AccountNature; branch: string | null };
  opening: number;
  lines: LedgerLine[];
}

export type VoucherKind = "receipt" | "payment" | "contra" | "journal";
export type EntryStatus = "posted" | "awaiting_approval" | "cancelled";

export interface VoucherRow {
  id: string;
  entryNo: string;
  date: string;
  narration: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  status: EntryStatus;
  branch: string | null;
  branchId: string | null;
  otherBranch: string | null;
  acceptedAt: string | null;
  reversesId: string | null;
  who: string | null;
  amount: number;
  lines: {
    account: string; code: string; debit: number; credit: number;
    note: string | null; party: string | null;
  }[];
}

export interface MoneyBalance {
  accountId: string;
  code: string;
  name: string;
  role: AccountRole | null;
  branch: string | null;
  bankAccountId: string | null;
  balance: number;
  /** Cheques written that the bank has not taken yet, and ones banked but not cleared. */
  unclearedOut: number;
  unclearedIn: number;
}

export type ChequeDirection = "issued" | "received";
export type ChequeStatus = "issued" | "cleared" | "bounced" | "cancelled";

export interface ChequeRow {
  id: string;
  direction: ChequeDirection;
  chequeNo: string;
  amount: number;
  chequeDate: string;
  status: ChequeStatus;
  payee: string | null;
  drawnOn: string | null;
  bank: string | null;
  branch: string | null;
  customerId: string | null;
  supplierId: string | null;
  bouncedReason: string | null;
  clearedAt: string | null;
  note: string | null;
  who: string | null;
  /** Dated in the past and still out: somebody has to chase it. */
  overdue: boolean;
}

export interface ChequeBookRow {
  id: string;
  bankAccountId: string;
  bank: string;
  prefix: string | null;
  firstNumber: number;
  lastNumber: number;
  nextNumber: number;
  active: boolean;
  left: number;
}

/** Where each thing goes on the bank's own cheque leaf, in millimetres. */
export interface ChequeLayout {
  leafWidthMm: number;
  leafHeightMm: number;
  dateX: number; dateY: number;
  payeeX: number; payeeY: number;
  words1X: number; words1Y: number;
  words2X: number; words2Y: number;
  figuresX: number; figuresY: number;
  fontPt: number;
}

export interface ChequePrint {
  chequeNo: string;
  date: string;
  payee: string | null;
  amount: number;
  /** The words are what a bank honours when the figures have been tampered with. */
  amountWords: string;
  bank: string | null;
  /** False means nobody has measured this bank's leaf yet; the defaults are being used. */
  measured: boolean;
  layout: ChequeLayout;
}

export interface BackfillResult {
  from: string;
  sales: number;
  grns: number;
  supplierReturns: number;
  saleReturns: number;
  customerPayments: number;
  supplierPayments: number;
  cashMovements: number;
}

// --- Reports, the period lock and export (P14) ---

/** What `report_run()` gives back, whichever of the hundred-odd reports it was. */
export interface ReportColumnOut {
  f: string;
  l: string;
  t: "text" | "date" | "qty" | "money" | "pct" | "num";
  /** Worked out after the totals rather than added up. */
  calc?: string | null;
  /** A cost or profit figure. */
  cost?: boolean;
}

/**
 * One row. The fields are whatever the report's columns are, so this is deliberately
 * open; `_kind` says whether it is a line, a subtotal or the grand total and `_level`
 * how deep the grouping was, which is all the screen needs to draw it.
 */
export interface ReportRow {
  _kind: "detail" | "subtotal" | "total";
  _level: number;
  [field: string]: unknown;
}

/** Reports that print in blocks: a balance sheet's two sides, a book of bills. */
export interface ReportSection {
  title: string;
  columns: ReportColumnOut[];
  rows: ReportRow[];
  totals: ReportRow | null;
  opening?: number | null;
  extra?: Record<string, unknown> | null;
}

export interface ReportResult {
  key: string;
  register: ReportRegisterKey;
  title: string;
  note: string | null;
  /** A second line the report itself wanted to say, e.g. that the shop charges no VAT. */
  noteExtra: string | null;
  dateMode: "range" | "as_on" | "none";
  landscape: boolean;
  columns: ReportColumnOut[];
  rows: ReportRow[];
  totals: ReportRow | null;
  sections: ReportSection[] | null;
  /** Rows × columns rather than a list. */
  pivot: boolean;
  /** For the reports whose whole job is to balance: the trial balance, the balance
   *  sheet, the stock valuation. Null when the question does not apply. */
  balanced: boolean | null;
  /** Which field on a row opens the thing behind it. */
  drill: string | null;
  opening: number | null;
  /** The account or product a ledger is for. */
  account: string | null;
  onOrder: number | null;
  /** The stock valuation report's three figures. */
  stockValue: number | null;
  stockOnShelves: number | null;
  stockNoCost: number | null;
  stockAccount: number | null;
  shop: string | null;
  branch: string | null;
  runAt: string;
  runBy: string;
  filters: ReportFilters;
}

export type ReportRegisterKey =
  "sales" | "purchase" | "stock" | "accounts" | "transfer" | "other";

export interface ReportFilters {
  branchId?: string | null;
  from?: string | null;
  to?: string | null;
  asOn?: string | null;
  productId?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  accountId?: string | null;
  category?: string | null;
  top?: number | null;
}

export interface ReportListItem {
  key: string;
  register: ReportRegisterKey;
  sl: number;
  title: string;
  note: string | null;
  dateMode: "range" | "as_on" | "none";
  landscape: boolean;
  /** Which later step brings it, when it is not here yet. */
  needs: string | null;
  needsCost: boolean;
  /** False when it needs a permission this login has not got, or is not built yet. */
  allowed: boolean;
  /** The owner has given it a name of their own. */
  renamed: boolean;
}

/** A month the owner has closed. */
export interface PeriodLock {
  month: string;
  note: string | null;
  at: string;
  who: string;
}

/** One journal line, for the accountant's export. */
export interface JournalExportLine {
  date: string;
  entryNo: string;
  kind: string;
  narration: string;
  account: string;
  accountCode: string;
  party: string;
  debit: number;
  credit: number;
  note: string;
  branch: string;
}

export interface JournalExport {
  shop: string;
  from: string | null;
  to: string | null;
  lines: JournalExportLine[];
}

export interface LayerRebuildResult {
  movements: number;
  layers: number;
  openLayers: number;
}

// --- Quotations, sales orders and challans (P14a) ---

export type QuotationStatus = "draft" | "sent" | "accepted" | "expired" | "lost";
export type OrderStatus =
  "draft" | "awaiting_approval" | "open" | "part_delivered" | "delivered" | "billed" | "cancelled";
export type ChallanStatus = "delivered" | "part_billed" | "billed" | "returned" | "cancelled";

export interface QuotationRow {
  id: string;
  quoteNo: string;
  date: string;
  branch: string;
  branchId: string;
  customer: string;
  customerId: string | null;
  total: number;
  status: QuotationStatus;
  validUntil: string | null;
  /** Past its date and still open, so the prices are not promised any more. */
  outOfDate: boolean;
  lines: number;
  who: string;
}

export interface OrderRow {
  id: string;
  soNo: string;
  date: string;
  branch: string;
  branchId: string;
  customer: string;
  customerId: string;
  deliveryDate: string | null;
  status: OrderStatus;
  total: number;
  advance: number;
  ordered: number;
  delivered: number;
  pending: number;
  /** Promised for a day that has gone, with something still to deliver. */
  late: boolean;
  daysLate: number | null;
  quoteNo: string | null;
  who: string;
  soldBy: string | null;
}

export interface ChallanRow {
  id: string;
  challanNo: string;
  date: string;
  branch: string;
  branchId: string;
  customer: string;
  customerId: string;
  orderNo: string | null;
  orderId: string | null;
  status: ChallanStatus;
  atCost: number;
  carrier: string | null;
  vehicleNo: string | null;
  qty: number;
  toBill: number;
  /** Goods gone, money not asked for. The figure to chase on. */
  daysUnbilled: number | null;
  invoiceNo: string | null;
  who: string;
}

export interface AdvanceRow {
  id: string;
  date: string;
  customer: string;
  customerId: string;
  orderNo: string | null;
  orderId: string | null;
  amount: number;
  method: string;
  reference: string | null;
  branch: string;
  daysHeld: number;
  who: string;
}

export interface SalesDocLine {
  id: string;
  productId: string;
  product: string;
  code: string;
  qty: number;
  unitPrice: number;
  lineDiscount: number;
  isFree: boolean;
  lineTotal: number;
  note: string | null;
  isSerial: boolean;
  /** Orders only. */
  deliveredQty?: number;
  billedQty?: number;
  pendingQty?: number;
  cancelled?: boolean;
  inStock?: number;
  /** Challans only. */
  returnedQty?: number;
  toBill?: number;
  serials?: { id: string; serial: string; returned: boolean }[];
}

/** One quotation, order or challan with its lines — for the screen and for printing. */
export interface SalesDocument {
  kind: "quotation" | "order" | "challan";
  id: string;
  no: string;
  date: string;
  status: string;
  branch: string;
  branchId: string;
  customer: string;
  customerId: string | null;
  phone: string | null;
  attention: string | null;
  address: string | null;
  validUntil: string | null;
  deliveryDate: string | null;
  paymentTermsDays: number | null;
  terms: string | null;
  note: string | null;
  carrier: string | null;
  vehicleNo: string | null;
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  vatAmount: number;
  total: number;
  advance: number;
  /** An advance on the order behind this challan, still waiting to be used. */
  advanceWaiting: number;
  quoteNo: string | null;
  orderNo: string | null;
  orderId: string | null;
  invoiceNo: string | null;
  who: string;
  soldBy: string | null;
  approvedBy: string | null;
  lines: SalesDocLine[];
  challans: { id: string; challanNo: string; date: string; status: string }[];
}

export interface BilledResult extends Receipt {
  challanNo: string | null;
  advanceUsed: number;
  stillOwed: number;
}

// --- HR: employees, attendance and salary (P14b) ---

export type AttendanceStatus =
  "present" | "late" | "absent" | "leave" | "holiday" | "half_day";

export interface Employee {
  id: string;
  code: string | null;
  name: string;
  phone: string | null;
  photoUrl: string | null;
  address: string | null;
  nid: string | null;
  dateOfBirth: string | null;
  joinedOn: string;
  branch: string | null;
  branchId: string | null;
  department: string | null;
  departmentId: string | null;
  designation: string | null;
  designationId: string | null;
  position: string | null;
  positionId: string | null;
  profession: string | null;
  professionId: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  religion: string | null;
  nationality: string | null;
  /** The login, if this person has one. Most employees do not. */
  staffId: string | null;
  login: string | null;
  active: boolean;
  leftOn: string | null;
  note: string | null;
  /** Only sent to somebody allowed to see pay — null otherwise, not zero. */
  basic: number | null;
  allowances: Record<string, number> | null;
  dailyRate: number | null;
  advanceOutstanding: number | null;
  /** Today's attendance, if there is any. */
  today: AttendanceStatus | null;
}

export interface AttendanceRow {
  employeeId: string;
  name: string;
  branch: string | null;
  branchId: string | null;
  designation: string | null;
  /** "not recorded" when nobody marked it: a shop that forgot is not a shop where
   *  everybody was absent, and guessing would dock somebody's salary. */
  status: AttendanceStatus | "not recorded";
  inAt: string | null;
  outAt: string | null;
  minutesLate: number;
  source: "self" | "manager" | null;
  note: string | null;
  markedBy: string | null;
}

export interface AttendanceDay {
  date: string;
  holiday: string | null;
  people: AttendanceRow[];
  counts: {
    present: number; late: number; absent: number; leave: number;
    notRecorded: number; people: number;
  };
}

export interface AttendanceTodayBranch {
  branch: string;
  branchId: string;
  people: number;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  notRecorded: number;
}

export interface LeaveRow {
  id: string;
  employee: string;
  employeeId: string;
  kind: string;
  isPaid: boolean;
  fromDate: string;
  toDate: string;
  days: number;
  reason: string | null;
  status: "asked" | "approved" | "refused" | "cancelled";
  note: string | null;
  decidedBy: string | null;
  takenThisYear: number;
  daysAYear: number;
}

export interface SalaryLine {
  id: string;
  employeeId: string;
  employee: string;
  designation: string | null;
  basic: number;
  allowances: number;
  absentDays: number;
  absenceCut: number;
  advanceCut: number;
  otherCut: number;
  daysWorked: number;
  daysInMonth: number;
  net: number;
}

export interface SalarySheet {
  id: string;
  month: string;
  status: "draft" | "paid";
  total: number;
  branch: string | null;
  branchId: string | null;
  paidOn: string | null;
  method: string | null;
  note: string | null;
  who: string;
  lines: SalaryLine[];
}

export interface SalarySheetRow {
  id: string;
  month: string;
  status: "draft" | "paid";
  total: number;
  branch: string | null;
  branchId: string | null;
  paidOn: string | null;
  people: number;
}

export interface CheckInResult {
  employee: string;
  branch: string;
  date: string;
  status: AttendanceStatus;
  minutesLate: number;
  opensAt: string;
  graceMinutes: number;
}
