export type Role = "owner" | "manager" | "cashier";
export type PaymentMethod = "cash" | "bkash" | "nagad" | "card";

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
}

/** Which setup list a row belongs to. Matches the tables save_setting_row() allows. */
export type SettingTable =
  | "units" | "vat_rates" | "hs_codes" | "extra_charges" | "discount_types"
  | "payment_methods" | "card_types" | "bank_accounts" | "warranty_terms"
  | "transaction_categories";

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
