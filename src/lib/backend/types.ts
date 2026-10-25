import type {
  ApprovalResult, Approver, BranchAdmin, BulkPriceChange, CatalogueRow, Category,
  CountDifference, CustomerLookup, FeatureKey, GoodsReceivedRow, PriceList, Product,
  Receipt, ReceiveLine, ReceiveResult, Role, SaleInput, SettingRow, SettingTable,
  SettingsBundle, StaffLookup, StaffMember, StockMovementRow, StockReason, Supplier,
  SupplierGroup,
  LedgerEntry, PoAction, PoReceiveResult, PurchaseOrderInput, PurchaseOrderRow,
  PurchaseOrderSaved, PurchaseOrderStatus, ReorderSuggestion, RequisitionRow,
  RequisitionStatus, SupplierAging, SupplierPaymentResult,
  InTransitRow, TransferRequestRow, TransferRequestStatus, TransferReceived, TransferRoute,
  TransferRow, TransferSent,
  CashReason, ShiftClosed, ShiftRow, ShiftState,
  ApprovalStatus, RefundMethod, ReturnResult, SaleDetail, SaleRow, SaleStatus,
  CustomerGroup, CustomerRow, CustomerStatement, DueRow, PaymentReceipt,
  EmiPlan, PriceHelp, SaleField,
  ClaimRow, ClaimStatus, ProblemType, SupplierRmaRow, Technician, WarrantyHit,
} from "../types";
import type { ImportKind } from "../import/schema";

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

  // --- Import from BMS (P4) ---
  /** Codes/phones/names the shop already has, so the review step can say "update"
   *  rather than "add". */
  existingKeys(kind: ImportKind): Promise<Set<string>>;
  /** The column mapping this shop used last time, so a repeat import is one click. */
  loadImportMapping(kind: ImportKind): Promise<Record<string, string> | null>;
  saveImportMapping(kind: ImportKind, mapping: Record<string, string>): Promise<void>;
  /** Sends the rows in batches. `dryRun` reports what would happen and writes nothing. */
  runImport(input: {
    kind: ImportKind;
    rows: Record<string, string | number | boolean | null>[];
    dryRun: boolean;
    fileName: string;
    branchId?: string;
    priceListId?: string;
  }): Promise<Record<string, number>>;

  // --- Suppliers and stock (P5) ---
  listSuppliers(): Promise<Supplier[]>;
  listSupplierGroups(): Promise<SupplierGroup[]>;
  saveSupplier(input: {
    id?: string; name: string; phone?: string | null; address?: string | null;
    groupId?: string | null; isCashOnly?: boolean; note?: string | null; active?: boolean;
  }): Promise<void>;
  /** One transaction: the document, the stock, the serials, the costs and the payment. */
  receiveGoods(input: {
    branchId: string;
    lines: ReceiveLine[];
    supplierId?: string | null;
    supplierInvoiceNo?: string | null;
    invoiceDate?: string | null;
    isCredit?: boolean;
    discount?: number;
    extraCosts?: number;
    vat?: number;
    ait?: number;
    note?: string | null;
    locationId?: string | null;
    payAmount?: number | null;
    payMethod?: string | null;
    payReference?: string | null;
  }): Promise<ReceiveResult>;
  /** Fill in or correct a delivery line's cost after the fact. */
  amendGrnCost(grnItemId: string, unitCost: number): Promise<void>;
  listGoodsReceived(branchId: string, limit?: number): Promise<GoodsReceivedRow[]>;
  returnToSupplier(input: {
    branchId: string;
    lines: { productId: string; qty: number; serialIds?: string[] }[];
    supplierId?: string | null;
    reason?: string | null;
  }): Promise<{ returnNo: string; total: number; supplierDue: number | null }>;
  correctStock(input: {
    branchId: string; productId: string; change: number; reason: StockReason;
    note?: string | null; serials?: string[];
  }): Promise<void>;
  /** `dryRun` returns the differences without moving anything. */
  applyStockCount(input: {
    branchId: string;
    counted: { productId: string; counted: number }[];
    categoryId?: string | null;
    note?: string | null;
    dryRun: boolean;
  }): Promise<{ corrected: number; alreadyRight: number; differences: CountDifference[] }>;
  stockHistory(branchId: string, productId?: string | null, limit?: number): Promise<StockMovementRow[]>;

  // --- Purchase paperwork and supplier dues (P6) ---
  listRequisitions(branchId: string, limit?: number): Promise<RequisitionRow[]>;
  /** `submit` sends it for a decision; without it the ask stays a draft. */
  saveRequisition(input: {
    id?: string;
    branchId: string;
    lines: { productId: string; qty: number; note?: string | null }[];
    neededBy?: string | null;
    note?: string | null;
    submit?: boolean;
  }): Promise<{ id: string; reqNo: string; status: RequisitionStatus }>;
  decideRequisition(
    reqId: string, approve: boolean, note?: string | null,
  ): Promise<{ reqNo: string; status: RequisitionStatus }>;
  listPurchaseOrders(branchId: string, limit?: number): Promise<PurchaseOrderRow[]>;
  savePurchaseOrder(input: PurchaseOrderInput): Promise<PurchaseOrderSaved>;
  /** Approve, send, cancel or close. A cancellation needs a reason. */
  setPoStatus(
    poId: string, action: PoAction, reason?: string | null,
  ): Promise<{ poNo: string; status: PurchaseOrderStatus }>;
  /** Receiving against an order: prices come from the order, partial is normal. */
  receiveAgainstPo(input: {
    poId: string;
    lines: { poItemId: string; qty: number; serials?: string[]; unitCost?: number | null }[];
    supplierInvoiceNo?: string | null;
    invoiceDate?: string | null;
    isCredit?: boolean;
    note?: string | null;
    payAmount?: number | null;
    payMethod?: string | null;
    payReference?: string | null;
  }): Promise<PoReceiveResult>;
  reorderSuggestions(branchId: string, days?: number): Promise<ReorderSuggestion[]>;
  supplierLedger(supplierId: string): Promise<LedgerEntry[]>;
  supplierAging(supplierId: string): Promise<SupplierAging>;
  paySupplier(input: {
    branchId: string; supplierId: string; amount: number; method: string;
    reference?: string | null; note?: string | null; accountId?: string | null;
  }): Promise<SupplierPaymentResult>;
  /** What the shop already owed on the day it moved across. Owner only, logged. */
  setOpeningBalance(input: {
    partyKind: "customer" | "supplier"; partyId: string; amount: number;
    asOf?: string | null; note?: string | null;
  }): Promise<{ name: string; amount: number; asOf: string }>;

  // --- Branch transfers (P7) ---
  /** Everything this branch sent or was sent, newest first. */
  listTransfers(branchId: string, limit?: number): Promise<TransferRow[]>;
  listTransferRequests(branchId: string, limit?: number): Promise<TransferRequestRow[]>;
  /** One branch asks another for stock. `toBranchId` is the branch that needs it. */
  saveTransferRequest(input: {
    fromBranchId: string;
    toBranchId: string;
    lines: { productId: string; qty: number }[];
    note?: string | null;
  }): Promise<{ id: string; reqNo: string; status: TransferRequestStatus }>;
  /** The branch being asked says yes or no. Sending still has to happen afterwards. */
  decideTransferRequest(
    requestId: string, approve: boolean, note?: string | null,
  ): Promise<{ reqNo: string; status: TransferRequestStatus }>;
  /** On the road right now, oldest first — over 3 days is worth a look. */
  inTransit(branchId?: string | null): Promise<InTransitRow[]>;
  /** Takes the stock off the sending branch's shelf. Serial items go by serial. */
  sendTransfer(input: {
    fromBranchId: string;
    toBranchId: string;
    lines: { productId: string; qty: number; serialIds?: string[] }[];
    note?: string | null;
    toLocationId?: string | null;
    fromLocationId?: string | null;
    requestId?: string | null;
  }): Promise<TransferSent>;
  /** Anything not accounted for leaves the transfer disputed. */
  receiveTransfer(input: {
    transferId: string;
    lines: {
      itemId: string; okQty?: number; damagedQty?: number;
      serialsOk?: string[]; serialsDamaged?: string[]; note?: string | null;
    }[];
    note?: string | null;
  }): Promise<TransferReceived>;
  /** A manager says where the missing goods went. Both need a reason. */
  resolveTransfer(
    transferId: string, action: "returned" | "written_off", note: string,
  ): Promise<{ transferNo: string; resolution: string; costOfShortage: number }>;
  cancelTransfer(transferId: string, reason: string): Promise<void>;
  /** Shop floor ↔ warehouse, in one step. Nothing goes in transit. */
  moveWithinBranch(input: {
    branchId: string; fromLocationId: string; toLocationId: string;
    lines: { productId: string; qty: number; serialIds?: string[] }[];
  }): Promise<{ lines: { product: string; qty: number }[] }>;
  listTransferRoutes(): Promise<TransferRoute[]>;
  /** Owner only. The first route a shop adds turns the list into the rule. */
  saveTransferRoute(fromBranchId: string, toBranchId: string, allowed: boolean): Promise<void>;

  // --- Shifts and the cash check (P8) ---
  /** Is a drawer open here, what was it opened with, and what did the last close count. */
  currentShift(branchId: string): Promise<ShiftState>;
  openShift(branchId: string, openingCash: number): Promise<{ shiftId: string; openingCash: number }>;
  /** Cash leaving or entering the drawer for something other than a sale. */
  cashMovement(input: {
    branchId: string; direction: "in" | "out"; amount: number;
    reason: CashReason; categoryId?: string | null; note?: string | null;
  }): Promise<void>;
  /** `noteCounts` is the note-by-note helper, kept with the shift. */
  closeShift(input: {
    shiftId: string; countedCash: number; note?: string | null;
    noteCounts?: Record<string, number> | null;
  }): Promise<ShiftClosed>;
  /** Manager and owner only: the drawer check per shift, per branch. */
  listShifts(branchId: string, limit?: number): Promise<ShiftRow[]>;
  /** The shop's expense categories, for a cash-out. */
  listExpenseCategories(): Promise<{ id: string; name: string }[]>;

  // --- Sales history, void and returns (P9) ---
  /** One search box: invoice, phone, serial or product name all go in `query`.
   *  A cashier is narrowed to their own sales, today, at their own branch. */
  saleHistory(input: {
    branchId?: string | null;
    query?: string | null;
    from?: string | null;
    to?: string | null;
    staffId?: string | null;
    method?: string | null;
    status?: SaleStatus | null;
    limit?: number;
  }): Promise<SaleRow[]>;
  /** The whole sale, for the detail view and the reprint. */
  saleDetail(saleId: string): Promise<SaleDetail>;
  /** Same day only, with a reason. Puts the stock and serials back. */
  voidSale(input: {
    saleId: string; reason: string; approvalId?: string | null;
    refundMethod?: string | null; refundRef?: string | null;
  }): Promise<{ invoiceNo: string; status: string; refunded: number }>;
  /** Taken back at any branch; the stock goes back where it was handed in. */
  returnSale(input: {
    saleId: string;
    branchId: string;
    lines: {
      saleItemId: string; qty?: number; serialIds?: string[]; isFaulty?: boolean;
    }[];
    refundMethod: RefundMethod;
    reason?: string | null;
    refundRef?: string | null;
    approvalId?: string | null;
    courierName?: string | null;
    courierTracking?: string | null;
    photoUrls?: string[] | null;
  }): Promise<ReturnResult>;
  /** Approve or cancel a held sale or return, on the document itself. */
  setSaleApproval(
    kind: "sale" | "return", id: string, action: "approve" | "cancel", reason?: string | null,
  ): Promise<{ number: string; approvalStatus: ApprovalStatus }>;

  // --- Credit sales and customers (P10) ---
  listCustomers(query?: string | null, limit?: number): Promise<CustomerRow[]>;
  /** Anyone who can sell may add a name and a phone; the credit fields need a manager. */
  saveCustomer(id: string | null, values: Record<string, unknown>): Promise<CustomerRow>;
  listCustomerGroups(): Promise<CustomerGroup[]>;
  saveCustomerGroup(id: string | null, values: Record<string, unknown>): Promise<void>;
  /** Everyone with money outstanding, worst first. Manager and owner only. */
  dueList(branchId?: string | null): Promise<DueRow[]>;
  /** One customer in full: ledger, purchases, and the serials they own. */
  customerStatement(customerId: string): Promise<CustomerStatement>;
  /** Take money off a due. Applied oldest first; cash goes through the drawer. */
  collectPayment(input: {
    branchId: string; customerId: string; amount: number; method: string;
    reference?: string | null; note?: string | null; accountId?: string | null;
  }): Promise<PaymentReceipt>;

  // --- The full counter (P10a) ---
  /** What this customer paid last time, what anyone paid last time, and where the
   *  stock is. Deliberately not cost or margin. */
  priceHelp(
    productId: string, branchId: string, customerId?: string | null,
  ): Promise<PriceHelp>;
  /** The bank EMI plans the shop has set up. */
  listEmiPlans(): Promise<EmiPlan[]>;
  saveEmiPlan(id: string | null, values: Record<string, unknown>): Promise<void>;
  /** The shop's own extra fields on a sale (BMS "Additional Info"). */
  listSaleFields(): Promise<SaleField[]>;

  // --- Warranty lookup and claims (P11) ---
  /** One box: a serial, an invoice number or a phone. */
  warrantyLookup(query: string): Promise<WarrantyHit[]>;
  /** For something sold before the shop switched over. Manager and owner only. */
  saveManualWarranty(values: Record<string, unknown>): Promise<void>;
  /** Take the item in. Whether it was in warranty is recorded at this moment. */
  openClaim(input: {
    branchId: string;
    problem: string;
    serialId?: string | null;
    productId?: string | null;
    itemText?: string | null;
    problemTypeId?: string | null;
    accessories?: string[];
    photoUrls?: string[];
    customerPhone?: string | null;
    customerName?: string | null;
    technicianId?: string | null;
  }): Promise<{ id: string; claimNo: string; inWarranty: boolean; needsApproval: boolean }>;
  /** Move the claim along. Every step is timed and attributed. */
  setClaimStatus(input: {
    claimId: string;
    status: ClaimStatus;
    note?: string | null;
    supplierId?: string | null;
    /** A swap: the new unit carries what was left of the old one's cover. */
    replacementSerialId?: string | null;
    technicianId?: string | null;
  }): Promise<{ claimNo: string; status: ClaimStatus; replacementSerial: string | null }>;
  approveClaim(claimId: string, approve: boolean, reason?: string | null): Promise<void>;
  /** A part used in an in-house repair. It comes out of stock, because it left it. */
  useClaimPart(
    claimId: string, productId: string, qty?: number, serialId?: string | null,
  ): Promise<void>;
  listClaims(input?: {
    branchId?: string | null;
    status?: ClaimStatus | "open" | null;
    technicianId?: string | null;
    waitingOver?: number | null;
    query?: string | null;
  }): Promise<ClaimRow[]>;
  /** What is out with which supplier, and since when. Manager and owner only. */
  supplierRmaList(): Promise<SupplierRmaRow[]>;
  listProblemTypes(): Promise<ProblemType[]>;
  saveProblemType(id: string | null, name: string, active?: boolean): Promise<void>;
  listTechnicians(): Promise<Technician[]>;
  saveTechnician(id: string | null, values: Record<string, unknown>): Promise<void>;
}
