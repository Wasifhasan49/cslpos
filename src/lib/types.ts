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
}

export interface CartLine {
  productId: string;
  qty: number; // for serial items this always equals serialIds.length
  serialIds: string[];
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
