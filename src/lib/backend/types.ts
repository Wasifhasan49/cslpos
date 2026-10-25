import type {
  ApprovalResult, Approver, BranchAdmin, BulkPriceChange, CatalogueRow, Category,
  CustomerLookup, FeatureKey, PriceList, Product, Receipt, Role, SaleInput, SettingRow,
  SettingTable, SettingsBundle, StaffLookup, StaffMember,
} from "../types";

/** Everything the screens need from "the server". Demo mode and Supabase both implement this. */
export interface Backend {
  mode: "demo" | "supabase";
  /** Three outcomes, so "not linked to a shop" can be told apart from "signed out".
   *  Throws if the lookup itself fails — a network problem is not a sign-out. */
  currentStaff(): Promise<StaffLookup>;
  listCategories(): Promise<Category[]>;
  /** The catalogue with stock, serials and prices for ONE branch, on one price list.
   *  The database refuses a branch this login may not work in. */
  listProducts(branchId: string, priceListId?: string | null): Promise<Product[]>;
  /** A customer's price list and standing discount, by phone. Null if not a customer. */
  findCustomer(phone: string): Promise<CustomerLookup | null>;
  /** Throws an Error whose message is already in plain words. */
  completeSale(input: SaleInput): Promise<Receipt>;
  /** Owners and managers with a PIN, so the counter can name who is approving. */
  listApprovers(): Promise<Approver[]>;
  /** Checks one named approver's PIN, records the attempt, and returns an approval the
   *  sale consumes. A wrong PIN comes back as `ok: false`, not an exception. */
  verifyManagerPin(approverId: string, pin: string): Promise<ApprovalResult>;
  /** Sets the signed-in owner's or manager's own approval PIN. */
  setPin(pin: string): Promise<void>;
  signOut(): Promise<void>;

  // --- Settings → Branches (owner only; the database checks, not the menu) ---
  listBranches(): Promise<BranchAdmin[]>;
  saveBranch(input: {
    id?: string; name?: string; code?: string;
    address?: string | null; phone?: string | null; active?: boolean;
  }): Promise<void>;
  saveStockLocation(input: {
    branchId: string; name: string; locationId?: string; isDefault?: boolean;
  }): Promise<void>;
  listStaff(): Promise<StaffMember[]>;
  setStaffBranches(staffId: string, branchIds: string[]): Promise<void>;
  setStaffAccess(input: {
    staffId: string; role?: Role; discountLimitPct?: number; active?: boolean;
  }): Promise<void>;

  // --- Settings (P2). Which features are on decides what the menu shows. ---
  /** The whole Settings area in one load, so switching section is instant. */
  loadSettings(): Promise<SettingsBundle>;
  /** Which features this shop has turned on. Loaded with the staff, because the menu
   *  needs it before any Settings screen is opened. */
  listFeatures(): Promise<Record<string, boolean>>;
  setFeature(feature: FeatureKey, enabled: boolean): Promise<void>;
  saveShopDetails(values: Record<string, string | number | null>): Promise<void>;
  /** Add (no id) or change (id) a row in one of the setup lists. */
  saveSettingRow(table: SettingTable, id: string | null, values: Record<string, string | number | boolean | null>): Promise<SettingRow>;
  setRolePermission(role: Role, perm: string, allowed: boolean, limit?: number | null): Promise<void>;
  /** `allowed: null` clears the override and puts the person back on their role. */
  setStaffPermission(staffId: string, perm: string, allowed: boolean | null, limit?: number | null): Promise<void>;
  setDocumentNextNumber(branchId: string, docType: string, next: number, prefix?: string): Promise<void>;

  // --- Products and prices (P3) ---
  listPriceLists(): Promise<PriceList[]>;
  /** The owner's product list, for one branch and one price list. Cost and margin are
   *  absent unless this login may see them. */
  loadCatalogue(branchId: string, priceListId?: string | null): Promise<CatalogueRow[]>;
  upsertProduct(id: string | null, values: Record<string, unknown>): Promise<void>;
  setPrices(input: {
    productId: string; priceListId: string; price: number;
    mrp?: number | null; minPrice?: number | null; maxPrice?: number | null;
    branchId?: string | null;
  }): Promise<void>;
  /** `dryRun` returns what WOULD change without changing it, for the preview. */
  bulkUpdatePrices(input: {
    productIds: string[]; priceListId: string;
    mode: "set" | "percent" | "amount"; value: number;
    branchId?: string | null; dryRun: boolean;
  }): Promise<BulkPriceChange[]>;
  mergeCategories(fromId: string, intoId: string): Promise<{ productsMoved: number }>;
  savePriceList(id: string | null, name: string, isDefault?: boolean, active?: boolean): Promise<void>;
}
