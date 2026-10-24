import type {
  ApprovalResult, Approver, BranchAdmin, Category, Product, Receipt, Role, SaleInput,
  StaffLookup, StaffMember,
} from "../types";

/** Everything the screens need from "the server". Demo mode and Supabase both implement this. */
export interface Backend {
  mode: "demo" | "supabase";
  /** Three outcomes, so "not linked to a shop" can be told apart from "signed out".
   *  Throws if the lookup itself fails — a network problem is not a sign-out. */
  currentStaff(): Promise<StaffLookup>;
  listCategories(): Promise<Category[]>;
  /** The catalogue with stock and serials for ONE branch. The database refuses a
   *  branch this login may not work in. */
  listProducts(branchId: string): Promise<Product[]>;
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
}
