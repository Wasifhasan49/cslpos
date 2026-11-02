import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyError } from "../sale";
import { supabaseBrowser } from "../supabase/client";
import type {
  ApprovalResult, Approver, BranchAdmin, BulkPriceChange, CatalogueRow, Category,
  CountDifference, CustomerLookup, FeatureKey, GoodsReceivedRow, PaymentMethod, PriceList,
  Product, Receipt, ReceiveResult, Role, SaleInput, SettingRow, SettingTable,
  SettingsBundle, StaffLookup, StaffMember, StockMovementRow, Supplier, SupplierGroup,
  LedgerEntry, PoReceiveResult, PurchaseOrderRow, PurchaseOrderStatus, ReorderSuggestion,
  RequisitionRow, RequisitionStatus, SupplierAging, SupplierPaymentResult,
  InTransitRow, TransferReceived, TransferRequestRow, TransferRequestStatus, TransferRoute,
  TransferRow, TransferSent, TransferStatus,
  CashReason, ShiftClosed, ShiftRow, ShiftState,
  ApprovalStatus, RefundMethod, ReturnResult, SaleDetail, SaleRow, SaleStatus,
  CustomerAging, CustomerGroup, CustomerRow, CustomerStatement, DueRow, PaymentReceipt,
  StatementEntry, EmiPlan, PriceHelp, SaleField,
  ClaimEvent, ClaimRow, ClaimStatus, ProblemType, SupplierRmaRow, Technician, WarrantyHit,
  Dashboard, DashboardDetailRow,
  AccountLedger, AccountNature, AccountRole, BackfillResult, ChartAccount, ChequeBookRow,
  ChequeDirection, ChequeLayout, ChequePrint, ChequeRow, ChequeStatus, EntryStatus,
  MoneyBalance, TrialBalance, VoucherRow,
  JournalExport, LayerRebuildResult, PeriodLock, ReportColumnOut, ReportFilters,
  ReportListItem, ReportResult, ReportRow, ReportSection, ReportRegisterKey,
  AdvanceRow, BilledResult, ChallanRow, OrderRow, QuotationRow, SalesDocLine,
  SalesDocument,
  AttendanceDay, AttendanceRow, AttendanceStatus, AttendanceTodayBranch, CheckInResult,
  Employee, LeaveRow, SalarySheet, SalarySheetRow,
  CustomerKind, CustomerSearchRow, DeliveryPoint, RepMonth, RepRow,
} from "../types";
import type { ImportKind } from "../import/schema";
import { classifyStaffLookup, type CurrentStaffRow } from "./staff-lookup";
import type { Backend } from "./types";

const num = (v: unknown) => (v == null ? 0 : Number(v));

/** The dashboard arrives snake_cased in one object. */
function readDashboard(v: unknown): Dashboard {
  const d = (v ?? {}) as Record<string, unknown>;
  const t = (d.today ?? {}) as Record<string, unknown>;
  const b = (d.before ?? {}) as Record<string, unknown>;
  const w = (d.week_before ?? {}) as Record<string, unknown>;
  const sm = (d.summary ?? {}) as Record<string, unknown>;
  const owed = (d.owed ?? {}) as Record<string, unknown>;
  const rows = (k: string) => ((d[k] as Record<string, unknown>[] | null) ?? []);
  return {
    from: String(d.from), to: String(d.to), days: num(d.days),
    branchId: (d.branch_id as string | null) ?? null,
    branch: (d.branch as string | null) ?? null,
    today: {
      sales: num(t.sales), profit: num(t.profit), saleCount: num(t.sale_count),
      averageSale: num(t.average_sale), linesWithoutCost: num(t.lines_without_cost),
    },
    before: {
      sales: num(b.sales), profit: num(b.profit), saleCount: num(b.sale_count),
      from: String(b.from), to: String(b.to),
    },
    weekBefore: {
      sales: num(w.sales), profit: num(w.profit),
      from: String(w.from), to: String(w.to),
    },
    branches: rows("branches").map((x) => ({
      branchId: String(x.branch_id), branch: String(x.branch),
      sales: num(x.sales), profit: num(x.profit), saleCount: num(x.sale_count),
    })),
    byMethod: (d.by_method as Record<string, number> | null) ?? {},
    summary: {
      cashSales: num(sm.cash_sales), creditSales: num(sm.credit_sales),
      salesReturns: num(sm.sales_returns), cashPurchases: num(sm.cash_purchases),
      creditPurchases: num(sm.credit_purchases), purchaseReturns: num(sm.purchase_returns),
      claimsTaken: num(sm.claims_taken), moneyIn: num(sm.money_in),
      moneyOut: num(sm.money_out),
    },
    busyHours: rows("busy_hours").map((x) => ({
      hour: num(x.hour), sales: num(x.sales), count: num(x.count),
    })),
    bestByProfit: rows("best_by_profit").map((x) => ({
      productId: String(x.product_id), product: String(x.product),
      qty: num(x.qty), sales: num(x.sales), profit: numOrNull(x.profit),
    })),
    bestByQty: rows("best_by_qty").map((x) => ({
      productId: String(x.product_id), product: String(x.product),
      qty: num(x.qty), sales: num(x.sales),
    })),
    staff: rows("staff").map((x) => ({
      staffId: String(x.staff_id), staff: String(x.staff), sales: num(x.sales),
      saleCount: num(x.sale_count), discountGiven: num(x.discount_given),
      profit: num(x.profit),
    })),
    lowStock: rows("low_stock").map((x) => ({
      productId: String(x.product_id), product: String(x.product), code: String(x.code),
      branch: String(x.branch), branchId: String(x.branch_id),
      stock: num(x.stock), reorderLevel: num(x.reorder_level), sold30: num(x.sold_30),
      elsewhere: ((x.elsewhere as Record<string, unknown>[] | null) ?? []).map((e) => ({
        branch: String(e.branch), qty: num(e.qty),
      })),
    })),
    dustyStock: rows("dusty_stock").map((x) => ({
      productId: String(x.product_id), product: String(x.product), code: String(x.code),
      stock: num(x.stock), cost: numOrNull(x.cost), tiedUp: num(x.tied_up),
      lastSold: (x.last_sold as string | null) ?? null,
    })),
    owed: { byCustomers: num(owed.by_customers), toSuppliers: num(owed.to_suppliers) },
    watch: rows("watch").map((x) => ({
      at: String(x.at), action: String(x.action), entity: String(x.entity),
      entityId: (x.entity_id as string | null) ?? null,
      branch: (x.branch as string | null) ?? null,
      who: (x.who as string | null) ?? null,
      details: (x.details as Record<string, unknown> | null) ?? null,
    })),
  };
}

/** Claims come back from two functions in the same shape. */
function readClaim(c: Record<string, unknown>): ClaimRow {
  return {
    id: String(c.id), claimNo: String(c.claim_no), status: c.status as ClaimStatus,
    approvalStatus: c.approval_status as ApprovalStatus,
    branch: String(c.branch), branchId: String(c.branch_id),
    product: (c.product as string | null) ?? null,
    serial: (c.serial as string | null) ?? null,
    serialId: (c.serial_id as string | null) ?? null,
    problem: String(c.problem),
    problemType: (c.problem_type as string | null) ?? null,
    accessories: (c.accessories as string[] | null) ?? [],
    inWarranty: Boolean(c.in_warranty),
    warrantyUntil: (c.warranty_until as string | null) ?? null,
    customerPhone: (c.customer_phone as string | null) ?? null,
    customerName: (c.customer_name as string | null) ?? null,
    technician: (c.technician as string | null) ?? null,
    technicianId: (c.technician_id as string | null) ?? null,
    supplier: (c.supplier as string | null) ?? null,
    supplierId: (c.supplier_id as string | null) ?? null,
    sentAt: (c.sent_at as string | null) ?? null,
    backAt: (c.back_at as string | null) ?? null,
    createdAt: String(c.created_at),
    deliveredAt: (c.delivered_at as string | null) ?? null,
    takenInBy: String(c.taken_in_by),
    resolution: (c.resolution as string | null) ?? null,
    replacementSerial: (c.replacement_serial as string | null) ?? null,
    daysWaiting: num(c.days_waiting),
    daysWithSupplier: numOrNull(c.days_with_supplier),
    open: Boolean(c.open),
    events: ((c.events as Record<string, unknown>[] | null) ?? []).map((e) => ({
      at: String(e.at), to: e.to as ClaimStatus,
      note: (e.note as string | null) ?? null,
      who: (e.who as string | null) ?? null,
    })) as ClaimEvent[],
    parts: ((c.parts as Record<string, unknown>[] | null) ?? []).map((x) => ({
      product: String(x.product), qty: num(x.qty),
    })),
  };
}

/** Both customer functions return the same aging shape, snake_cased. */
function readCustomerAging(v: unknown): CustomerAging {
  const a = (v ?? {}) as Record<string, unknown>;
  return {
    days0to30: num(a.days_0_30), days31to60: num(a.days_31_60),
    days60plus: num(a.days_60_plus), total: num(a.total),
    paymentDays: num(a.payment_days), overdue: num(a.overdue),
    inCredit: num(a.in_credit),
  };
}

function readCustomer(r: Record<string, unknown>): CustomerRow {
  return {
    id: String(r.id), phone: String(r.phone), name: String(r.name),
    company: (r.company as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    groupId: (r.group_id as string | null) ?? null,
    group: (r.group as string | null) ?? null,
    priceListId: (r.price_list_id as string | null) ?? null,
    priceList: (r.price_list as string | null) ?? null,
    discountPct: num(r.discount_pct),
    binVat: (r.bin_vat as string | null) ?? null,
    nid: (r.nid as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    active: r.active !== false,
    districtId: numOrNull(r.district_id), upazilaId: numOrNull(r.upazila_id),
    creditAllowed: Boolean(r.credit_allowed), creditLimit: num(r.credit_limit),
    paymentDays: num(r.payment_days), owed: num(r.owed), totalSpent: num(r.total_spent),
  };
}

/** The aging buckets come back snake_cased from two different functions. */
function readAging(v: unknown): SupplierAging {
  const a = (v ?? {}) as Record<string, unknown>;
  return {
    days0to30: num(a.days_0_30), days31to60: num(a.days_31_60),
    days60plus: num(a.days_60_plus), total: num(a.total), unapplied: num(a.unapplied),
  };
}
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

/** During setup, almost every failure is a misconfiguration rather than a flat
 *  internet connection — so say which one, and name the fix. */
function loadError(what: string, error: { code?: string; message?: string; status?: number }): Error {
  const code = error.code ?? "";
  if (error.status === 401 || error.status === 403 || code === "PGRST301" || /JWT|api key/i.test(error.message ?? "")) {
    return new Error("The Supabase keys in .env.local were rejected. Check Project Settings → API, then restart the dev server.");
  }
  if (code === "42P01" || code === "42883" || code.startsWith("PGRST2")) {
    return new Error("The database tables aren't set up yet. Run the files in supabase/migrations/ in the Supabase SQL editor.");
  }
  if (code === "42501") {
    return new Error("This login isn't allowed to read that. Ask the owner to check your role.");
  }
  return new Error(`Couldn't load ${what}. Check the internet and try again.`);
}

/** `client` is injectable so the three sign-in outcomes can be tested. */
export function createSupabaseBackend(client?: SupabaseClient): Backend {
  const sb: SupabaseClient = client ?? supabaseBrowser();

  return {
    mode: "supabase",

    async currentStaff(): Promise<StaffLookup> {
      const { data: auth, error: authError } = await sb.auth.getUser();
      if (authError && !isNoSession(authError)) throw loadError("your account", authError);
      if (!auth?.user) return { kind: "signed-out" };

      // One round trip, and it dodges the column-grant trap: `select *` on staff is
      // denied outright so that pin_hash can never be read.
      const { data, error } = await sb.rpc("current_staff");
      // A failed query is NOT "no staff row". Collapsing the two is what used to bounce
      // a signed-in cashier to /login over a blip.
      if (error) throw loadError("your account", error);

      return classifyStaffLookup({ user: auth.user, row: (data as CurrentStaffRow | null) ?? null });
    },

    async listCategories(): Promise<Category[]> {
      const { data, error } = await sb.from("categories").select("id, name").order("sort").order("name");
      if (error) throw loadError("categories", error);
      return data ?? [];
    },

    async listProducts(branchId: string, priceListId?: string | null): Promise<Product[]> {
      // One call: the database joins this branch's stock, its in-stock serials and the
      // price from the right list, so the browser is never trusted with any of it.
      const { data, error } = await sb.rpc("branch_products", {
        p_branch_id: branchId,
        p_price_list_id: priceListId ?? null,
      });
      if (error) throw loadError("products", error);
      type Row = {
        id: string; code: string; barcode: string | null; name: string; brand: string | null;
        category_id: string | null; price: number | string; warranty_months: number;
        is_serial: boolean; is_inventory: boolean; reorder_level: number; stock: number | string;
        reserved: number | string | null;
        mrp: number | string | null; min_price: number | string | null; max_price: number | string | null;
        serials: { id: string; serial: string }[];
        delivered_serials: { id: string; serial: string }[] | null;
      };
      return ((data as Row[] | null) ?? []).map((r) => ({
        id: r.id, code: r.code, barcode: r.barcode, name: r.name, brand: r.brand,
        categoryId: r.category_id, price: num(r.price), warrantyMonths: r.warranty_months,
        isSerial: r.is_serial, isInventory: r.is_inventory,
        reorderLevel: r.reorder_level, stock: num(r.stock), reserved: num(r.reserved),
        mrp: numOrNull(r.mrp), minPrice: numOrNull(r.min_price), maxPrice: numOrNull(r.max_price),
        serials: r.serials ?? [],
        deliveredSerials: r.delivered_serials ?? [],
      }));
    },

    async findCustomer(phone: string): Promise<CustomerLookup | null> {
      const { data, error } = await sb.rpc("customer_by_phone", { p_phone: phone });
      // A lookup failing must not stop a sale: the customer is a nicety, the sale is not.
      if (error || !data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id), phone: String(r.phone), name: (r.name as string | null) ?? null,
        priceListId: (r.price_list_id as string | null) ?? null,
        priceListName: (r.price_list_name as string | null) ?? null,
        discountPct: num(r.discount_pct),
        group: (r.group as string | null) ?? null,
        creditAllowed: Boolean(r.credit_allowed),
        creditLimit: num(r.credit_limit),
        paymentDays: num(r.payment_days),
        owed: num(r.owed),
        creditLeft: numOrNull(r.credit_left),
      };
    },

    async listApprovers(): Promise<Approver[]> {
      const { data, error } = await sb.rpc("list_approvers");
      if (error) throw loadError("the managers who can approve", error);
      return (data as Approver[] | null) ?? [];
    },

    async verifyManagerPin(approverId: string, pin: string): Promise<ApprovalResult> {
      const { data, error } = await sb.rpc("verify_manager_pin", {
        p_approver_id: approverId,
        p_pin: pin,
      });
      // A wrong PIN comes back as data, not an error — that is what lets the database
      // record the attempt instead of rolling it back.
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      if (r.ok) {
        return {
          ok: true,
          approvalId: String(r.approval_id),
          approverId: String(r.approver_id),
          approverName: String(r.approver_name),
        };
      }
      return { ok: false, locked: Boolean(r.locked), triesLeft: num(r.tries_left) };
    },

    async setPin(pin: string): Promise<void> {
      const { error } = await sb.rpc("set_pin", { p_pin: pin });
      if (error) throw new Error(error.message);
    },

    async completeSale(input: SaleInput): Promise<Receipt> {
      const { data, error } = await sb.rpc("complete_sale", {
        p_branch_id: input.branchId,
        p_items: input.lines.map((l) => ({
          product_id: l.productId, qty: l.qty, serial_ids: l.serialIds,
          // Left out entirely when the seller did not change it, so the database uses
          // the owner's price rather than echoing one back from the browser.
          ...(l.unitPrice == null ? {} : { unit_price: l.unitPrice }),
        })),
        p_payment_method: input.paymentMethod,
        p_discount_pct: input.discountPct,
        p_approval_id: input.approvalId,
        p_customer_phone: input.customerPhone,
        p_cash_received: input.cashReceived,
        p_payment_ref: input.paymentRef,
        p_price_list_id: input.priceListId ?? null,
        p_charges: input.chargeIds?.length ? input.chargeIds.map((id) => ({ charge_id: id })) : null,
        p_discount_type_id: input.discountTypeId ?? null,
        p_category_id: input.categoryId ?? null,
        p_due_amount: input.dueAmount ?? 0,
        // Everything the advanced counter adds (P10a), snake_cased for the function.
        p_extras: input.extras ? {
          attention: input.extras.attention ?? null,
          customer_address: input.extras.customerAddress ?? null,
          customer_bin: input.extras.customerBin ?? null,
          customer_nid: input.extras.customerNid ?? null,
          narration: input.extras.narration ?? null,
          sold_by: input.extras.soldBy ?? null,
          extra_fields: input.extras.extraFields ?? null,
          ...(input.extras.card ? {
            card: {
              type_id: input.extras.card.typeId ?? null,
              bank: input.extras.card.bank ?? null,
              pos_account_id: input.extras.card.posAccountId ?? null,
              last4: input.extras.card.last4 ?? null,
            },
          } : {}),
          ...(input.extras.emi ? {
            emi: { months: input.extras.emi.months, bank: input.extras.emi.bank ?? null },
          } : {}),
          ...(input.extras.exchange ? {
            exchange: {
              description: input.extras.exchange.description,
              serial: input.extras.exchange.serial ?? null,
              value: input.extras.exchange.value,
              product_id: input.extras.exchange.productId ?? null,
              add_to_stock: input.extras.exchange.addToStock ?? false,
            },
          } : {}),
          ...(input.extras.payments?.length ? {
            payments: input.extras.payments.map((x) => ({
              method: x.method, amount: x.amount,
              reference: x.reference ?? null, account_id: x.accountId ?? null,
            })),
          } : {}),
        } : null,
      });
      if (error) throw new Error(friendlyError(error.message));
      if (!data) throw new Error("The sale did not come back. Check the sales list before trying again.");
      return readReceipt(data as Record<string, unknown>);
    },

    async signOut() {
      await sb.auth.signOut();
    },

    // --- Settings → Branches. Every one of these is owner-only IN THE DATABASE; the
    // menu hiding them is a convenience, not the guard. ---

    async listBranches(): Promise<BranchAdmin[]> {
      const [{ data: rows, error }, { data: locs, error: lErr }] = await Promise.all([
        sb.from("branches").select("id, name, code, address, phone, active, next_invoice").order("name"),
        sb.from("stock_locations").select("id, branch_id, name, is_default").eq("active", true).order("name"),
      ]);
      if (error) throw loadError("branches", error);
      if (lErr) throw loadError("stock locations", lErr);
      const byBranch = new Map<string, { id: string; name: string; isDefault: boolean }[]>();
      for (const l of locs ?? []) {
        const list = byBranch.get(l.branch_id) ?? [];
        list.push({ id: l.id, name: l.name, isDefault: l.is_default });
        byBranch.set(l.branch_id, list);
      }
      return (rows ?? []).map((b) => ({
        id: b.id, name: b.name, code: b.code,
        address: b.address, phone: b.phone, active: b.active,
        nextInvoice: b.next_invoice,
        locations: byBranch.get(b.id) ?? [],
      }));
    },

    async saveBranch(input): Promise<void> {
      const { error } = await sb.rpc("save_branch", {
        p_branch_id: input.id ?? null,
        p_name: input.name ?? null,
        p_code: input.code ?? null,
        p_address: input.address ?? null,
        p_phone: input.phone ?? null,
        p_active: input.active ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async saveStockLocation(input): Promise<void> {
      const { error } = await sb.rpc("save_stock_location", {
        p_branch_id: input.branchId,
        p_name: input.name,
        p_location_id: input.locationId ?? null,
        p_is_default: input.isDefault ?? false,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async listStaff(): Promise<StaffMember[]> {
      const [{ data: rows, error }, { data: links, error: lErr }] = await Promise.all([
        sb.from("staff").select("id, name, role, discount_limit_pct, active").order("name"),
        sb.from("staff_branches").select("staff_id, branch_id"),
      ]);
      if (error) throw loadError("the staff list", error);
      if (lErr) throw loadError("branch assignments", lErr);
      const byStaff = new Map<string, string[]>();
      for (const l of links ?? []) {
        byStaff.set(l.staff_id, [...(byStaff.get(l.staff_id) ?? []), l.branch_id]);
      }
      return (rows ?? []).map((r) => ({
        id: r.id, name: r.name, role: r.role as Role,
        discountLimitPct: num(r.discount_limit_pct), active: r.active,
        // pin_hash is never readable, so "has a PIN" is not shown in this list; the
        // person sees it on their own /pin screen.
        hasPin: false,
        branchIds: byStaff.get(r.id) ?? [],
      }));
    },

    async setStaffBranches(staffId: string, branchIds: string[]): Promise<void> {
      const { error } = await sb.rpc("set_staff_branches", {
        p_staff_id: staffId,
        p_branch_ids: branchIds,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async setStaffAccess({ staffId, role, discountLimitPct, active }): Promise<void> {
      const { error } = await sb.rpc("set_staff_access", {
        p_staff_id: staffId,
        p_role: role ?? null,
        p_discount_limit_pct: discountLimitPct ?? null,
        p_active: active ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    // --- Settings ---

    async listFeatures(): Promise<Record<string, boolean>> {
      const { data, error } = await sb.from("shop_features").select("feature, enabled");
      // Never block the app on this: with no answer, nothing extra is switched on,
      // which is the same as a brand-new shop.
      if (error) return {};
      return Object.fromEntries((data ?? []).map((r) => [r.feature, r.enabled]));
    },

    async loadSettings(): Promise<SettingsBundle> {
      const TABLES: SettingTable[] = [
        "units", "vat_rates", "hs_codes", "extra_charges", "discount_types",
        "payment_methods", "card_types", "bank_accounts", "warranty_terms",
        "transaction_categories", "sale_fields",
      ];
      const [shopRes, featRes, keysRes, roleRes, staffPermRes, docRes, ...listRes] = await Promise.all([
        sb.from("shops").select("name, address, phone, email, logo_url, bin_vat, receipt_footer, invoice_prefix, currency, ait_pct, po_approval_limit, so_approval_limit, cash_short_limit, return_days, sale_approval_limit, approve_all_sales, card_charge_mode, claim_approval, voucher_approval").limit(1).maybeSingle(),
        sb.from("shop_features").select("feature, enabled"),
        sb.from("permission_keys").select("key, label, area, has_limit").order("sort"),
        sb.from("role_permissions").select("role, perm, allowed, num_limit"),
        sb.from("staff_permissions").select("staff_id, perm, allowed, num_limit"),
        sb.from("document_sequences").select("branch_id, doc_type, prefix, next_number"),
        ...TABLES.map((t) => sb.from(t).select("*")),
      ]);
      if (shopRes.error) throw loadError("the shop settings", shopRes.error);
      const shop = shopRes.data;
      if (!shop) throw new Error("This shop no longer exists.");

      const lists = Object.fromEntries(
        TABLES.map((t, i) => [t, ((listRes[i].data ?? []) as SettingRow[])]),
      ) as Record<SettingTable, SettingRow[]>;

      return {
        shop: {
          name: shop.name, address: shop.address, phone: shop.phone, email: shop.email,
          logoUrl: shop.logo_url, binVat: shop.bin_vat, receiptFooter: shop.receipt_footer,
          invoicePrefix: shop.invoice_prefix, currency: shop.currency, aitPct: num(shop.ait_pct),
          poApprovalLimit: num(shop.po_approval_limit),
          soApprovalLimit: num(shop.so_approval_limit),
          cashShortLimit: num(shop.cash_short_limit),
          returnDays: num(shop.return_days),
          saleApprovalLimit: num(shop.sale_approval_limit),
          approveAllSales: Boolean(shop.approve_all_sales),
          cardChargeMode: (shop.card_charge_mode ?? "absorb") as "absorb" | "add",
          claimApproval: Boolean(shop.claim_approval),
          voucherApproval: Boolean(shop.voucher_approval),
        },
        features: Object.fromEntries((featRes.data ?? []).map((r) => [r.feature, r.enabled])),
        lists,
        permissionKeys: (keysRes.data ?? []).map((k) => ({
          key: k.key, label: k.label, area: k.area, hasLimit: k.has_limit,
        })),
        rolePermissions: (roleRes.data ?? []).map((r) => ({
          role: r.role as Role, perm: r.perm, allowed: r.allowed, numLimit: numOrNull(r.num_limit),
        })),
        staffPermissions: (staffPermRes.data ?? []).map((r) => ({
          staffId: r.staff_id, perm: r.perm, allowed: r.allowed, numLimit: numOrNull(r.num_limit),
        })),
        documentSequences: (docRes.data ?? []).map((d) => ({
          branchId: d.branch_id, docType: d.doc_type, prefix: d.prefix, nextNumber: d.next_number,
        })),
      };
    },

    async setFeature(feature: FeatureKey, enabled: boolean): Promise<void> {
      const { error } = await sb.rpc("set_feature", { p_feature: feature, p_enabled: enabled });
      if (error) throw new Error(friendlyError(error.message));
    },

    async saveShopDetails(values): Promise<void> {
      const { error } = await sb.rpc("save_shop_details", { p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    async saveSettingRow(table, id, values): Promise<SettingRow> {
      const { data, error } = await sb.rpc("save_setting_row", {
        p_table: table, p_id: id, p_values: values,
      });
      if (error) throw new Error(friendlyError(error.message));
      return data as SettingRow;
    },

    async setRolePermission(role, perm, allowed, limit): Promise<void> {
      const { error } = await sb.rpc("set_role_permission", {
        p_role: role, p_perm: perm, p_allowed: allowed, p_limit: limit ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async setStaffPermission(staffId, perm, allowed, limit): Promise<void> {
      const { error } = await sb.rpc("set_staff_permission", {
        p_staff_id: staffId, p_perm: perm, p_allowed: allowed, p_limit: limit ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async setDocumentNextNumber(branchId, docType, next, prefix): Promise<void> {
      const { error } = await sb.rpc("set_document_next_number", {
        p_branch_id: branchId, p_doc_type: docType, p_next: next, p_prefix: prefix ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    // --- Products and prices ---

    async listPriceLists(): Promise<PriceList[]> {
      const { data, error } = await sb
        .from("price_lists").select("id, name, is_default, active").order("sort").order("name");
      if (error) throw loadError("price lists", error);
      return (data ?? []).map((r) => ({
        id: r.id, name: r.name, isDefault: r.is_default, active: r.active,
      }));
    },

    async loadCatalogue(branchId: string, priceListId?: string | null): Promise<CatalogueRow[]> {
      const { data, error } = await sb.rpc("catalogue", {
        p_branch_id: branchId, p_price_list_id: priceListId ?? null,
      });
      if (error) throw loadError("the product list", error);
      type Row = Record<string, unknown>;
      return ((data as Row[] | null) ?? []).map((r) => ({
        id: String(r.id), code: String(r.code), barcode: (r.barcode as string | null) ?? null,
        name: String(r.name), brand: (r.brand as string | null) ?? null,
        model: (r.model as string | null) ?? null,
        categoryId: (r.category_id as string | null) ?? null,
        category: (r.category as string | null) ?? null,
        unit: (r.unit as string | null) ?? null,
        specification: (r.specification as string | null) ?? null,
        warrantyMonths: num(r.warranty_months),
        warrantyTerm: (r.warranty_term as string | null) ?? null,
        isSerial: Boolean(r.is_serial), isInventory: r.is_inventory !== false,
        active: r.active !== false,
        reorderLevel: num(r.reorder_level),
        price: num(r.price), mrp: numOrNull(r.mrp),
        minPrice: numOrNull(r.min_price), maxPrice: numOrNull(r.max_price),
        stock: num(r.stock), totalStock: num(r.total_stock),
        // Only spread these in when the database actually sent them: a cashier gets no
        // `cost` key at all, and copying `undefined` in would be a lie about that.
        ...("cost" in r ? { cost: num(r.cost) } : {}),
        ...("margin_pct" in r ? { marginPct: num(r.margin_pct) } : {}),
      }));
    },

    async upsertProduct(id, values): Promise<void> {
      const { error } = await sb.rpc("upsert_product", { p_id: id, p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    async setPrices({ productId, priceListId, price, mrp, minPrice, maxPrice, branchId }): Promise<void> {
      const { error } = await sb.rpc("set_prices", {
        p_product_id: productId, p_price_list_id: priceListId, p_price: price,
        p_mrp: mrp ?? null, p_min_price: minPrice ?? null, p_max_price: maxPrice ?? null,
        p_branch_id: branchId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async bulkUpdatePrices({ productIds, priceListId, mode, value, branchId, dryRun }): Promise<BulkPriceChange[]> {
      const { data, error } = await sb.rpc("bulk_update_prices", {
        p_product_ids: productIds, p_price_list_id: priceListId,
        p_mode: mode, p_value: value, p_branch_id: branchId ?? null, p_dry_run: dryRun,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as { changes?: {
        product_id: string; name: string; from: number | string; to: number | string;
        note: string | null;
      }[] };
      return (r.changes ?? []).map((c) => ({
        productId: c.product_id, name: c.name, from: num(c.from), to: num(c.to),
        note: c.note ?? null,
      }));
    },

    async mergeCategories(fromId, intoId): Promise<{ productsMoved: number }> {
      const { data, error } = await sb.rpc("merge_categories", { p_from: fromId, p_into: intoId });
      if (error) throw new Error(friendlyError(error.message));
      return { productsMoved: num((data as Record<string, unknown>).products_moved) };
    },

    async savePriceList(id, name, isDefault, active): Promise<void> {
      const { error } = await sb.rpc("save_price_list", {
        p_id: id, p_name: name, p_is_default: isDefault ?? null, p_active: active ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    // --- Import ---

    async existingKeys(kind: ImportKind): Promise<Set<string>> {
      if (kind === "customers") {
        const { data } = await sb.from("customers").select("phone");
        return new Set((data ?? []).map((r) => r.phone));
      }
      if (kind === "suppliers") {
        const { data } = await sb.from("suppliers").select("name");
        return new Set((data ?? []).map((r) => r.name));
      }
      if (kind === "serials") {
        const { data } = await sb.from("serials").select("serial");
        return new Set((data ?? []).map((r) => r.serial));
      }
      const { data } = await sb.from("products").select("code");
      return new Set((data ?? []).map((r) => r.code));
    },

    async loadImportMapping(kind: ImportKind) {
      const { data } = await sb
        .from("import_mappings").select("mapping").eq("kind", kind).maybeSingle();
      return (data?.mapping as Record<string, string> | undefined) ?? null;
    },

    async saveImportMapping(kind: ImportKind, mapping: Record<string, string>): Promise<void> {
      const { error } = await sb.rpc("save_import_mapping", { p_kind: kind, p_mapping: mapping });
      if (error) throw new Error(friendlyError(error.message));
    },

    async runImport({ kind, rows, dryRun, fileName, branchId, priceListId }): Promise<Record<string, number>> {
      // Batched, because a catalogue of several thousand rows in one call risks a
      // statement timeout and leaves the owner with no idea how far it got.
      const BATCH = 200;
      const totals: Record<string, number> = {};
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const fn =
          kind === "products" ? "import_products"
          : kind === "stock" ? "import_opening_stock"
          : kind === "serials" ? "import_serials"
          : kind === "customers" ? "import_customers"
          : kind === "suppliers" ? "import_suppliers"
          : "import_prices";

        const args: Record<string, unknown> = { p_rows: batch, p_dry_run: dryRun, p_file: fileName };
        if (kind === "stock" || kind === "serials") args.p_branch_id = branchId;
        if (kind === "prices") args.p_price_list_id = priceListId;

        const { data, error } = await sb.rpc(fn, args);
        if (error) throw new Error(friendlyError(error.message));
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
        }
      }
      return totals;
    },

    // --- Suppliers and stock ---

    async listSuppliers(): Promise<Supplier[]> {
      const { data, error } = await sb
        .from("suppliers")
        .select("id, name, phone, address, group_id, is_cash_only, note, active, supplier_groups(name)")
        .order("name");
      if (error) throw loadError("suppliers", error);
      const rows = (data ?? []) as unknown as {
        id: string; name: string; phone: string | null; address: string | null;
        group_id: string | null; is_cash_only: boolean; note: string | null; active: boolean;
        supplier_groups: { name: string } | null;
      }[];
      // One balance call per supplier: a shop has tens of these, not thousands, and the
      // figure has to come from the documents rather than a stored total that can drift.
      const balances = await Promise.all(
        rows.map((r) => sb.rpc("supplier_balance", { p_supplier_id: r.id })),
      );
      return rows.map((r, i) => ({
        id: r.id, name: r.name, phone: r.phone, address: r.address,
        groupId: r.group_id, groupName: r.supplier_groups?.name ?? null,
        isCashOnly: r.is_cash_only, note: r.note, active: r.active,
        balance: num(balances[i].data),
      }));
    },

    async listSupplierGroups(): Promise<SupplierGroup[]> {
      const { data, error } = await sb.from("supplier_groups").select("id, name").order("name");
      if (error) throw loadError("supplier groups", error);
      return data ?? [];
    },

    async saveSupplier(input): Promise<void> {
      const row = {
        name: input.name.trim(),
        phone: input.phone ?? null,
        address: input.address ?? null,
        group_id: input.groupId ?? null,
        is_cash_only: input.isCashOnly ?? false,
        note: input.note ?? null,
        active: input.active ?? true,
      };
      const { error } = input.id
        ? await sb.from("suppliers").update(row).eq("id", input.id)
        : await sb.from("suppliers").insert(row);
      if (error) throw loadError("the supplier", error);
    },

    async receiveGoods(input): Promise<ReceiveResult> {
      const { data, error } = await sb.rpc("receive_goods", {
        p_branch_id: input.branchId,
        p_lines: input.lines.map((l) => ({
          product_id: l.productId,
          qty: l.qty,
          unit_cost: l.unitCost,
          line_discount: l.lineDiscount ?? 0,
          serials: l.serials ?? [],
        })),
        p_supplier_id: input.supplierId ?? null,
        p_supplier_invoice_no: input.supplierInvoiceNo ?? null,
        p_invoice_date: input.invoiceDate ?? null,
        p_is_credit: input.isCredit ?? false,
        p_discount: input.discount ?? 0,
        p_extra_costs: input.extraCosts ?? 0,
        p_vat: input.vat ?? 0,
        p_ait: input.ait ?? 0,
        p_note: input.note ?? null,
        p_attachment_url: null,
        p_location_id: input.locationId ?? null,
        p_pay_amount: input.payAmount ?? null,
        p_pay_method: input.payMethod ?? null,
        p_pay_reference: input.payReference ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        grnNo: String(r.grn_no), subtotal: num(r.subtotal), total: num(r.total),
        costMissing: Boolean(r.cost_missing), supplierDue: numOrNull(r.supplier_due),
        lines: ((r.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          name: String(l.name), qty: num(l.qty),
          unitCost: numOrNull(l.unit_cost), landedCost: numOrNull(l.landed_cost),
          averageCost: numOrNull(l.average_cost),
        })),
      };
    },

    async amendGrnCost(grnItemId: string, unitCost: number): Promise<void> {
      const { error } = await sb.rpc("amend_grn_cost", {
        p_grn_item_id: grnItemId, p_unit_cost: unitCost,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async listGoodsReceived(branchId: string, limit = 50): Promise<GoodsReceivedRow[]> {
      const { data, error } = await sb
        .from("grns")
        .select(`id, grn_no, supplier_invoice_no, is_credit, total, cost_missing, created_at,
                 suppliers(name),
                 grn_items(id, qty, unit_cost, landed_cost, products(name))`)
        .eq("branch_id", branchId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw loadError("the deliveries", error);
      type Row = {
        id: string; grn_no: string; supplier_invoice_no: string | null; is_credit: boolean;
        total: number | string; cost_missing: boolean; created_at: string;
        suppliers: { name: string } | null;
        grn_items: { id: string; qty: number; unit_cost: number | string | null;
                     landed_cost: number | string | null; products: { name: string } | null }[];
      };
      return ((data ?? []) as unknown as Row[]).map((g) => ({
        id: g.id, grnNo: g.grn_no, supplierName: g.suppliers?.name ?? null,
        supplierInvoiceNo: g.supplier_invoice_no, isCredit: g.is_credit,
        total: num(g.total), costMissing: g.cost_missing, createdAt: g.created_at,
        lines: (g.grn_items ?? []).map((i) => ({
          id: i.id, product: i.products?.name ?? "", qty: i.qty,
          unitCost: numOrNull(i.unit_cost), landedCost: numOrNull(i.landed_cost),
        })),
      }));
    },

    async returnToSupplier(input) {
      const { data, error } = await sb.rpc("return_to_supplier", {
        p_branch_id: input.branchId,
        p_lines: input.lines.map((l) => ({
          product_id: l.productId, qty: l.qty, serials: l.serialIds ?? [],
        })),
        p_supplier_id: input.supplierId ?? null,
        p_reason: input.reason ?? null,
        p_location_id: null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return { returnNo: String(r.return_no), total: num(r.total), supplierDue: numOrNull(r.supplier_due) };
    },

    async correctStock(input): Promise<void> {
      const { error } = await sb.rpc("correct_stock", {
        p_branch_id: input.branchId,
        p_product_id: input.productId,
        p_change: input.change,
        p_reason: input.reason,
        p_note: input.note ?? null,
        p_serials: input.serials ?? null,
        p_location_id: null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async applyStockCount(input) {
      const { data, error } = await sb.rpc("apply_stock_count", {
        p_branch_id: input.branchId,
        p_counted: input.counted.map((c) => ({ product_id: c.productId, counted: c.counted })),
        p_category_id: input.categoryId ?? null,
        p_note: input.note ?? null,
        p_location_id: null,
        p_dry_run: input.dryRun,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        corrected: num(r.corrected), alreadyRight: num(r.already_right),
        differences: ((r.differences as Record<string, unknown>[] | null) ?? []).map((d) => ({
          productId: String(d.product_id), name: String(d.name),
          expected: num(d.expected), counted: num(d.counted), change: num(d.change),
        })) as CountDifference[],
      };
    },

    // --- Purchase paperwork and supplier dues (P6) ---

    async listRequisitions(branchId: string, limit = 50): Promise<RequisitionRow[]> {
      const { data, error } = await sb
        .from("requisitions")
        .select(`id, req_no, status, needed_by, note, decision_note, created_at,
                 asked:staff!requisitions_staff_id_fkey(name),
                 decided:staff!requisitions_decided_by_fkey(name),
                 requisition_items(id, qty, note, product_id, products(name))`)
        .eq("branch_id", branchId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw loadError("the requests", error);
      type Row = {
        id: string; req_no: string; status: RequisitionStatus; needed_by: string | null;
        note: string | null; decision_note: string | null; created_at: string;
        asked: { name: string } | null; decided: { name: string } | null;
        requisition_items: { id: string; qty: number; note: string | null;
                             product_id: string; products: { name: string } | null }[];
      };
      return ((data ?? []) as unknown as Row[]).map((r) => ({
        id: r.id, reqNo: r.req_no, status: r.status, neededBy: r.needed_by, note: r.note,
        askedBy: r.asked?.name ?? null, decidedBy: r.decided?.name ?? null,
        decisionNote: r.decision_note, createdAt: r.created_at,
        lines: (r.requisition_items ?? []).map((i) => ({
          id: i.id, productId: i.product_id, product: i.products?.name ?? "",
          qty: i.qty, note: i.note,
        })),
      }));
    },

    async saveRequisition(input) {
      const { data, error } = await sb.rpc("save_requisition", {
        p_branch_id: input.branchId,
        p_lines: input.lines.map((l) => ({
          product_id: l.productId, qty: l.qty, note: l.note ?? null,
        })),
        p_needed_by: input.neededBy ?? null,
        p_note: input.note ?? null,
        p_req_id: input.id ?? null,
        p_submit: input.submit ?? false,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return { id: String(r.id), reqNo: String(r.req_no), status: r.status as RequisitionStatus };
    },

    async decideRequisition(reqId, approve, note) {
      const { data, error } = await sb.rpc("decide_requisition", {
        p_req_id: reqId, p_approve: approve, p_note: note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return { reqNo: String(r.req_no), status: r.status as RequisitionStatus };
    },

    async listPurchaseOrders(branchId: string, limit = 50): Promise<PurchaseOrderRow[]> {
      const { data, error } = await sb
        .from("purchase_orders")
        .select(`id, po_no, status, branch_id, supplier_id, payment_terms_days, discount, charges, vat,
                 subtotal, total, note, cancel_reason, created_at,
                 suppliers(name),
                 purchase_order_items(id, qty, unit_price, line_discount, received_qty,
                                      product_id, products(name, code))`)
        .eq("branch_id", branchId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw loadError("the orders", error);
      type Row = {
        id: string; po_no: string; status: PurchaseOrderStatus; branch_id: string;
        supplier_id: string;
        payment_terms_days: number; discount: number | string; charges: number | string;
        vat: number | string; subtotal: number | string; total: number | string;
        note: string | null; cancel_reason: string | null; created_at: string;
        suppliers: { name: string } | null;
        purchase_order_items: {
          id: string; qty: number; unit_price: number | string; line_discount: number | string;
          received_qty: number; product_id: string;
          products: { name: string; code: string } | null;
        }[];
      };
      return ((data ?? []) as unknown as Row[]).map((o) => ({
        id: o.id, poNo: o.po_no, status: o.status, branchId: o.branch_id,
        supplierId: o.supplier_id,
        supplierName: o.suppliers?.name ?? null, paymentTermsDays: o.payment_terms_days,
        discount: num(o.discount), charges: num(o.charges), vat: num(o.vat),
        subtotal: num(o.subtotal), total: num(o.total), note: o.note,
        cancelReason: o.cancel_reason, createdAt: o.created_at,
        lines: (o.purchase_order_items ?? []).map((i) => ({
          id: i.id, productId: i.product_id, product: i.products?.name ?? "",
          code: i.products?.code ?? "", qty: i.qty, unitPrice: num(i.unit_price),
          lineDiscount: num(i.line_discount), receivedQty: i.received_qty,
        })),
      }));
    },

    async savePurchaseOrder(input) {
      const { data, error } = await sb.rpc("save_purchase_order", {
        p_branch_id: input.branchId,
        p_supplier_id: input.supplierId,
        p_lines: input.lines.map((l) => ({
          product_id: l.productId, qty: l.qty, unit_price: l.unitPrice,
          line_discount: l.lineDiscount ?? 0, req_item_id: l.reqItemId ?? null,
        })),
        p_terms_days: input.termsDays ?? 0,
        p_discount: input.discount ?? 0,
        p_charges: input.charges ?? 0,
        p_vat: input.vat ?? 0,
        p_note: input.note ?? null,
        p_po_id: input.id ?? null,
        p_req_ids: input.reqIds ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id), poNo: String(r.po_no), subtotal: num(r.subtotal),
        total: num(r.total), status: r.status as PurchaseOrderStatus,
        needsApproval: Boolean(r.needs_approval),
      };
    },

    async setPoStatus(poId, action, reason) {
      const { data, error } = await sb.rpc("set_po_status", {
        p_po_id: poId, p_action: action, p_reason: reason ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return { poNo: String(r.po_no), status: r.status as PurchaseOrderStatus };
    },

    async receiveAgainstPo(input): Promise<PoReceiveResult> {
      const { data, error } = await sb.rpc("receive_against_po", {
        p_po_id: input.poId,
        p_lines: input.lines.map((l) => ({
          po_item_id: l.poItemId, qty: l.qty,
          serials: l.serials ?? [], unit_cost: l.unitCost ?? null,
        })),
        p_supplier_invoice_no: input.supplierInvoiceNo ?? null,
        p_invoice_date: input.invoiceDate ?? null,
        p_is_credit: input.isCredit ?? true,
        p_note: input.note ?? null,
        p_pay_amount: input.payAmount ?? null,
        p_pay_method: input.payMethod ?? null,
        p_pay_reference: input.payReference ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        grnNo: String(r.grn_no), subtotal: num(r.subtotal), total: num(r.total),
        costMissing: Boolean(r.cost_missing), supplierDue: numOrNull(r.supplier_due),
        lines: ((r.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          name: String(l.name), qty: num(l.qty),
          unitCost: numOrNull(l.unit_cost), landedCost: numOrNull(l.landed_cost),
          averageCost: numOrNull(l.average_cost),
        })),
        poNo: String(r.po_no), poStatus: r.po_status as PurchaseOrderStatus,
        pending: ((r.pending as Record<string, unknown>[] | null) ?? []).map((p) => ({
          product: String(p.product), ordered: num(p.ordered),
          received: num(p.received), pending: num(p.pending),
        })),
      };
    },

    async reorderSuggestions(branchId: string, days = 30): Promise<ReorderSuggestion[]> {
      const { data, error } = await sb.rpc("reorder_suggestions", {
        p_branch_id: branchId, p_days: days,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        productId: String(r.product_id), name: String(r.name), code: String(r.code),
        stock: num(r.stock), reorderLevel: num(r.reorder_level),
        soldInPeriod: num(r.sold_in_period), perDay: num(r.per_day),
        daysLeft: numOrNull(r.days_left), suggestQty: num(r.suggest_qty),
        lastCost: numOrNull(r.last_cost),
      }));
    },

    async supplierLedger(supplierId: string): Promise<LedgerEntry[]> {
      const { data, error } = await sb.rpc("supplier_ledger", { p_supplier_id: supplierId });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((e) => ({
        at: String(e.at), kind: e.kind as LedgerEntry["kind"],
        document: String(e.document), change: num(e.change),
        note: (e.note as string | null) ?? null,
      }));
    },

    async supplierAging(supplierId: string): Promise<SupplierAging> {
      const { data, error } = await sb.rpc("supplier_aging", { p_supplier_id: supplierId });
      if (error) throw new Error(friendlyError(error.message));
      return readAging(data);
    },

    async paySupplier(input): Promise<SupplierPaymentResult> {
      const { data, error } = await sb.rpc("pay_supplier", {
        p_branch_id: input.branchId,
        p_supplier_id: input.supplierId,
        p_amount: input.amount,
        p_method: input.method,
        p_reference: input.reference ?? null,
        p_note: input.note ?? null,
        p_account_id: input.accountId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        supplier: String(r.supplier), amount: num(r.amount), balance: num(r.balance),
        aging: readAging(r.aging),
      };
    },

    // --- The owner dashboard (P12) ---

    async dashboard(branchId, from, to): Promise<Dashboard> {
      const { data, error } = await sb.rpc("dashboard", {
        p_branch_id: branchId ?? null, p_from: from ?? null, p_to: to ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return readDashboard(data);
    },

    async dashboardDetail(kind, branchId, from, to): Promise<DashboardDetailRow[]> {
      const { data, error } = await sb.rpc("dashboard_detail", {
        p_kind: kind, p_branch_id: branchId ?? null,
        p_from: from ?? null, p_to: to ?? null, p_limit: 100,
      });
      if (error) throw new Error(friendlyError(error.message));
      // Each kind lists different things, so the rows stay as they came; the screen
      // knows which columns a kind has.
      return (data as DashboardDetailRow[] | null) ?? [];
    },

    // --- Warranty lookup and claims (P11) ---

    async warrantyLookup(query: string): Promise<WarrantyHit[]> {
      const { data, error } = await sb.rpc("warranty_lookup", { p_query: query });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((h) => ({
        kind: h.kind as WarrantyHit["kind"],
        serialId: (h.serial_id as string | null) ?? null,
        serial: (h.serial as string | null) ?? null,
        serialStatus: (h.serial_status as string | null) ?? null,
        productId: (h.product_id as string | null) ?? null,
        product: (h.product as string | null) ?? null,
        saleId: (h.sale_id as string | null) ?? null,
        saleItemId: (h.sale_item_id as string | null) ?? null,
        invoiceNo: (h.invoice_no as string | null) ?? null,
        soldOn: (h.sold_on as string | null) ?? null,
        branch: (h.branch as string | null) ?? null,
        soldBy: (h.sold_by as string | null) ?? null,
        customerId: (h.customer_id as string | null) ?? null,
        customerPhone: (h.customer_phone as string | null) ?? null,
        customerName: (h.customer_name as string | null) ?? null,
        warrantyMonths: numOrNull(h.warranty_months),
        warrantyUntil: (h.warranty_until as string | null) ?? null,
        warrantyText: (h.warranty_text as string | null) ?? null,
        inWarranty: Boolean(h.in_warranty),
        daysLeft: numOrNull(h.days_left),
        saleStatus: (h.sale_status as string | null) ?? null,
        openClaim: (h.open_claim as string | null) ?? null,
      }));
    },

    async saveManualWarranty(values): Promise<void> {
      const { error } = await sb.rpc("save_manual_warranty", { p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    async openClaim(input) {
      const { data, error } = await sb.rpc("open_claim", {
        p_branch_id: input.branchId,
        p_problem: input.problem,
        p_serial_id: input.serialId ?? null,
        p_product_id: input.productId ?? null,
        p_item_text: input.itemText ?? null,
        p_problem_type_id: input.problemTypeId ?? null,
        p_accessories: input.accessories ?? null,
        p_photo_urls: input.photoUrls ?? null,
        p_customer_phone: input.customerPhone ?? null,
        p_customer_name: input.customerName ?? null,
        p_technician_id: input.technicianId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id), claimNo: String(r.claim_no),
        inWarranty: Boolean(r.in_warranty), needsApproval: Boolean(r.needs_approval),
      };
    },

    async setClaimStatus(input) {
      const { data, error } = await sb.rpc("set_claim_status", {
        p_claim_id: input.claimId,
        p_status: input.status,
        p_note: input.note ?? null,
        p_supplier_id: input.supplierId ?? null,
        p_replacement_serial_id: input.replacementSerialId ?? null,
        p_technician_id: input.technicianId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        claimNo: String(r.claim_no), status: r.status as ClaimStatus,
        replacementSerial: (r.replacement_serial as string | null) ?? null,
      };
    },

    async approveClaim(claimId, approve, reason): Promise<void> {
      const { error } = await sb.rpc("approve_claim", {
        p_claim_id: claimId, p_approve: approve, p_reason: reason ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async useClaimPart(claimId, productId, qty = 1, serialId): Promise<void> {
      const { error } = await sb.rpc("use_claim_part", {
        p_claim_id: claimId, p_product_id: productId, p_qty: qty,
        p_serial_id: serialId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async listClaims(input = {}): Promise<ClaimRow[]> {
      const { data, error } = await sb.rpc("claim_list", {
        p_branch_id: input.branchId ?? null,
        p_status: input.status ?? null,
        p_technician_id: input.technicianId ?? null,
        p_waiting_over: input.waitingOver ?? null,
        p_query: input.query ?? null,
        p_limit: 100,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map(readClaim);
    },

    async supplierRmaList(): Promise<SupplierRmaRow[]> {
      const { data, error } = await sb.rpc("supplier_rma_list");
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        supplier: String(r.supplier), supplierId: String(r.supplier_id),
        claimNo: String(r.claim_no), claimId: String(r.claim_id),
        product: (r.product as string | null) ?? null,
        serial: (r.serial as string | null) ?? null,
        sentAt: String(r.sent_at), daysOut: num(r.days_out),
        problem: String(r.problem), branch: String(r.branch),
      }));
    },

    async listProblemTypes(): Promise<ProblemType[]> {
      const { data, error } = await sb
        .from("problem_types").select("id, name, active").order("sort").order("name");
      if (error) throw loadError("the problem list", error);
      return ((data ?? []) as ProblemType[]).filter((p) => p.active);
    },

    async saveProblemType(id, name, active = true): Promise<void> {
      const { error } = await sb.rpc("save_problem_type", {
        p_id: id, p_name: name, p_active: active,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async listTechnicians(): Promise<Technician[]> {
      const { data, error } = await sb
        .from("technicians").select("id, name, phone, staff_id, active").order("name");
      if (error) throw loadError("the technicians", error);
      type Row = {
        id: string; name: string; phone: string | null; staff_id: string | null;
        active: boolean;
      };
      return ((data ?? []) as Row[]).map((t) => ({
        id: t.id, name: t.name, phone: t.phone, staffId: t.staff_id, active: t.active,
      }));
    },

    async saveTechnician(id, values): Promise<void> {
      const { error } = await sb.rpc("save_technician", { p_id: id, p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    // --- The full counter (P10a) ---

    async priceHelp(productId, branchId, customerId): Promise<PriceHelp> {
      const { data, error } = await sb.rpc("price_help", {
        p_product_id: productId, p_branch_id: branchId, p_customer_id: customerId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      return {
        productId: String(d.product_id),
        lastPriceToCustomer: numOrNull(d.last_price_to_customer),
        lastPriceToCustomerOn: (d.last_price_to_customer_on as string | null) ?? null,
        lastPrice: numOrNull(d.last_price),
        here: num(d.here),
        elsewhere: ((d.elsewhere as Record<string, unknown>[] | null) ?? []).map((e) => ({
          branch: String(e.branch), qty: num(e.qty),
        })),
        emiAllowed: Boolean(d.emi_allowed),
        emiPlans: ((d.emi_plans as Record<string, unknown>[] | null) ?? []).map((e) => ({
          id: String(e.id), bank: String(e.bank), months: num(e.months),
          chargePct: num(e.charge_pct), minAmount: num(e.min_amount), active: true,
        })),
      };
    },

    async listEmiPlans(): Promise<EmiPlan[]> {
      const { data, error } = await sb
        .from("emi_plans")
        .select("id, bank, months, charge_pct, min_amount, active")
        .order("bank").order("months");
      if (error) throw loadError("the EMI plans", error);
      type Row = {
        id: string; bank: string; months: number; charge_pct: number | string;
        min_amount: number | string; active: boolean;
      };
      return ((data ?? []) as Row[]).map((e) => ({
        id: e.id, bank: e.bank, months: e.months, chargePct: num(e.charge_pct),
        minAmount: num(e.min_amount), active: e.active,
      }));
    },

    async saveEmiPlan(id, values): Promise<void> {
      const { error } = await sb.rpc("save_emi_plan", { p_id: id, p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    async listSaleFields(): Promise<SaleField[]> {
      const { data, error } = await sb
        .from("sale_fields")
        .select("id, name, show_on_invoice, active")
        .order("sort").order("name");
      if (error) throw loadError("the extra fields", error);
      type Row = { id: string; name: string; show_on_invoice: boolean; active: boolean };
      return ((data ?? []) as Row[])
        .filter((f) => f.active)
        .map((f) => ({
          id: f.id, name: f.name, showOnInvoice: f.show_on_invoice, active: f.active,
        }));
    },

    // --- Credit sales and customers (P10) ---

    async listCustomers(query, limit = 100): Promise<CustomerRow[]> {
      const { data, error } = await sb.rpc("customer_list", {
        p_query: query ?? null, p_limit: limit,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map(readCustomer);
    },

    async saveCustomer(id, values): Promise<CustomerRow> {
      const { data, error } = await sb.rpc("save_customer", { p_id: id, p_values: values });
      if (error) throw new Error(friendlyError(error.message));
      // The saver returns the row itself, not the list shape, so the figures that are
      // worked out (what they owe, what they have spent) come back as zero here.
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id), phone: String(r.phone),
        name: (r.name_text as string | null) ?? String(r.phone),
        company: (r.company as string | null) ?? null,
        address: (r.address as string | null) ?? null,
        groupId: (r.group_id as string | null) ?? null, group: null,
        priceListId: (r.price_list_id as string | null) ?? null, priceList: null,
        discountPct: num(r.discount_pct),
        binVat: (r.bin_vat as string | null) ?? null,
        nid: (r.nid as string | null) ?? null,
        note: (r.note as string | null) ?? null,
        active: r.active !== false,
        districtId: numOrNull(r.district_id), upazilaId: numOrNull(r.upazila_id),
        creditAllowed: Boolean(r.credit_allowed), creditLimit: num(r.credit_limit),
        paymentDays: num(r.payment_days), owed: 0, totalSpent: 0,
      };
    },

    async listCustomerGroups(): Promise<CustomerGroup[]> {
      const { data, error } = await sb
        .from("customer_groups")
        .select("id, name, price_list_id, discount_pct, credit_allowed, credit_limit, payment_days, active")
        .order("name");
      if (error) throw loadError("the customer groups", error);
      type Row = {
        id: string; name: string; price_list_id: string | null;
        discount_pct: number | string; credit_allowed: boolean;
        credit_limit: number | string; payment_days: number; active: boolean;
      };
      return ((data ?? []) as Row[]).map((g) => ({
        id: g.id, name: g.name, priceListId: g.price_list_id,
        discountPct: num(g.discount_pct), creditAllowed: g.credit_allowed,
        creditLimit: num(g.credit_limit), paymentDays: g.payment_days, active: g.active,
      }));
    },

    async saveCustomerGroup(id, values): Promise<void> {
      const { error } = await sb.rpc("save_customer_group", { p_id: id, p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    async dueList(branchId): Promise<DueRow[]> {
      const { data, error } = await sb.rpc("due_list", { p_branch_id: branchId ?? null });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        customerId: String(r.customer_id), name: String(r.name), phone: String(r.phone),
        company: (r.company as string | null) ?? null,
        group: (r.group as string | null) ?? null,
        creditLimit: num(r.credit_limit), paymentDays: num(r.payment_days),
        owed: num(r.owed), aging: readCustomerAging(r.aging), overdue: num(r.overdue),
        lastPaid: (r.last_paid as string | null) ?? null,
        oldestDue: (r.oldest_due as string | null) ?? null,
      }));
    },

    async customerStatement(customerId): Promise<CustomerStatement> {
      const { data, error } = await sb.rpc("customer_statement", { p_customer_id: customerId });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      return {
        customerId: String(d.customer_id), name: String(d.name), phone: String(d.phone),
        company: (d.company as string | null) ?? null,
        address: (d.address as string | null) ?? null,
        binVat: (d.bin_vat as string | null) ?? null,
        nid: (d.nid as string | null) ?? null,
        note: (d.note as string | null) ?? null,
        group: (d.group as string | null) ?? null,
        priceList: (d.price_list as string | null) ?? null,
        discountPct: num(d.discount_pct), creditAllowed: Boolean(d.credit_allowed),
        creditLimit: num(d.credit_limit), paymentDays: num(d.payment_days),
        owed: num(d.owed), aging: readCustomerAging(d.aging),
        totalSpent: num(d.total_spent), saleCount: num(d.sale_count),
        entries: ((d.entries as Record<string, unknown>[] | null) ?? []).map((e) => ({
          at: String(e.at), kind: e.kind as StatementEntry["kind"],
          document: String(e.document), change: num(e.change),
          note: (e.note as string | null) ?? null,
        })),
        purchases: ((d.purchases as Record<string, unknown>[] | null) ?? []).map((s) => ({
          id: String(s.id), invoiceNo: String(s.invoice_no), at: String(s.at),
          branch: String(s.branch), total: num(s.total), due: num(s.due),
          status: String(s.status), items: (s.items as string | null) ?? null,
        })),
        owns: ((d.owns as Record<string, unknown>[] | null) ?? []).map((o) => ({
          serial: String(o.serial), product: String(o.product), bought: String(o.bought),
          invoiceNo: String(o.invoice_no),
          warrantyUntil: (o.warranty_until as string | null) ?? null,
          inWarranty: Boolean(o.in_warranty), status: String(o.status),
        })),
      };
    },

    async collectPayment(input): Promise<PaymentReceipt> {
      const { data, error } = await sb.rpc("collect_payment", {
        p_branch_id: input.branchId,
        p_customer_id: input.customerId,
        p_amount: input.amount,
        p_method: input.method,
        p_reference: input.reference ?? null,
        p_note: input.note ?? null,
        p_account_id: input.accountId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        receiptNo: String(r.receipt_no), paymentId: String(r.payment_id),
        customer: String(r.customer), amount: num(r.amount),
        wasOwed: num(r.was_owed), owed: num(r.owed),
        shopName: String(r.shop_name), branch: String(r.branch),
        takenBy: String(r.taken_by),
      };
    },

    // --- Sales history, void and returns (P9) ---

    async saleHistory(input): Promise<SaleRow[]> {
      const { data, error } = await sb.rpc("sale_history", {
        p_branch_id: input.branchId ?? null,
        p_query: input.query ?? null,
        p_from: input.from ?? null,
        p_to: input.to ?? null,
        p_staff_id: input.staffId ?? null,
        p_method: input.method ?? null,
        p_status: input.status ?? null,
        p_limit: input.limit ?? 50,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        id: String(r.id), invoiceNo: String(r.invoice_no), createdAt: String(r.created_at),
        branch: String(r.branch), branchId: String(r.branch_id), staff: String(r.staff),
        total: num(r.total), discountAmount: num(r.discount_amount),
        paymentMethod: String(r.payment_method), status: r.status as SaleStatus,
        approvalStatus: r.approval_status as ApprovalStatus,
        customerPhone: (r.customer_phone as string | null) ?? null,
        customerName: (r.customer_name as string | null) ?? null,
        itemCount: num(r.item_count), summary: (r.summary as string | null) ?? null,
        returned: num(r.returned),
      }));
    },

    async saleDetail(saleId: string): Promise<SaleDetail> {
      const { data, error } = await sb.rpc("sale_detail", { p_sale_id: saleId });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      return {
        id: String(d.id), invoiceNo: String(d.invoice_no), createdAt: String(d.created_at),
        branch: String(d.branch), branchId: String(d.branch_id),
        branchAddress: (d.branch_address as string | null) ?? null,
        branchPhone: (d.branch_phone as string | null) ?? null,
        shopName: String(d.shop_name),
        receiptFooter: (d.receipt_footer as string | null) ?? null,
        binVat: (d.bin_vat as string | null) ?? null,
        staff: String(d.staff),
        subtotal: num(d.subtotal), discountPct: num(d.discount_pct),
        discountAmount: num(d.discount_amount), vatAmount: num(d.vat_amount),
        chargesAmount: num(d.charges_amount), total: num(d.total),
        paymentMethod: String(d.payment_method),
        cashReceived: numOrNull(d.cash_received), changeGiven: numOrNull(d.change_given),
        paymentRef: (d.payment_ref as string | null) ?? null,
        status: d.status as SaleStatus,
        approvalStatus: d.approval_status as ApprovalStatus,
        voidReason: (d.void_reason as string | null) ?? null,
        refundMethod: (d.refund_method as string | null) ?? null,
        customerId: (d.customer_id as string | null) ?? null,
        paidAmount: num(d.paid_amount), dueAmount: num(d.due_amount),
        customerPhone: (d.customer_phone as string | null) ?? null,
        customerName: (d.customer_name as string | null) ?? null,
        sameDay: Boolean(d.same_day), daysOld: num(d.days_old),
        returnDays: num(d.return_days),
        items: ((d.items as Record<string, unknown>[] | null) ?? []).map((i) => ({
          id: String(i.id), productId: String(i.product_id), name: String(i.name),
          qty: num(i.qty), unitPrice: num(i.unit_price), lineTotal: num(i.line_total),
          vatPct: num(i.vat_pct), vatAmount: num(i.vat_amount),
          vatInclusive: Boolean(i.vat_inclusive), isGift: Boolean(i.is_gift),
          warrantyUntil: (i.warranty_until as string | null) ?? null,
          returnedQty: num(i.returned_qty), refundEach: num(i.refund_each),
          isSerial: Boolean(i.is_serial),
          serials: ((i.serials as Record<string, unknown>[] | null) ?? []).map((x) => ({
            id: String(x.id), serial: String(x.serial), status: String(x.status),
          })),
        })),
        returns: ((d.returns as Record<string, unknown>[] | null) ?? []).map((r) => ({
          id: String(r.id), returnNo: String(r.return_no), createdAt: String(r.created_at),
          branch: String(r.branch), total: num(r.total),
          reason: (r.reason as string | null) ?? null,
          refundMethod: String(r.refund_method),
          approvalStatus: r.approval_status as ApprovalStatus,
        })),
      };
    },

    async voidSale(input) {
      const { data, error } = await sb.rpc("void_sale", {
        p_sale_id: input.saleId,
        p_reason: input.reason,
        p_approval_id: input.approvalId ?? null,
        p_refund_method: input.refundMethod ?? null,
        p_refund_ref: input.refundRef ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        invoiceNo: String(r.invoice_no), status: String(r.status), refunded: num(r.refunded),
      };
    },

    async returnSale(input): Promise<ReturnResult> {
      const { data, error } = await sb.rpc("return_sale", {
        p_sale_id: input.saleId,
        p_branch_id: input.branchId,
        p_lines: input.lines.map((l) => ({
          sale_item_id: l.saleItemId,
          qty: l.qty ?? 0,
          serial_ids: l.serialIds ?? [],
          is_faulty: l.isFaulty ?? false,
        })),
        p_refund_method: input.refundMethod,
        p_reason: input.reason ?? null,
        p_refund_ref: input.refundRef ?? null,
        p_approval_id: input.approvalId ?? null,
        p_courier_name: input.courierName ?? null,
        p_courier_tracking: input.courierTracking ?? null,
        p_photo_urls: input.photoUrls ?? null,
        p_location_id: null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        returnNo: String(r.return_no), total: num(r.total), subtotal: num(r.subtotal),
        vatAmount: num(r.vat_amount), chargesBack: num(r.charges_back),
        refundMethod: r.refund_method as RefundMethod,
        lines: ((r.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          name: String(l.name), qty: num(l.qty), refund: num(l.refund),
          faulty: Boolean(l.faulty),
        })),
        wholeSaleReturned: Boolean(r.whole_sale_returned),
      };
    },

    async setSaleApproval(kind, id, action, reason) {
      const { data, error } = await sb.rpc("set_sale_approval", {
        p_kind: kind, p_id: id, p_action: action, p_reason: reason ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return { number: String(r.number), approvalStatus: r.approval_status as ApprovalStatus };
    },

    // --- Shifts and the cash check (P8) ---

    async currentShift(branchId: string): Promise<ShiftState> {
      const { data, error } = await sb.rpc("current_shift", { p_branch_id: branchId });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        open: Boolean(r.open),
        shiftId: (r.shift_id as string | null) ?? null,
        openedAt: (r.opened_at as string | null) ?? null,
        openingCash: numOrNull(r.opening_cash),
        lastClose: numOrNull(r.last_close),
        maySellWithoutShift: Boolean(r.may_sell_without_shift),
      };
    },

    async openShift(branchId: string, openingCash: number) {
      const { data, error } = await sb.rpc("open_shift", {
        p_branch_id: branchId, p_opening_cash: openingCash,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return { shiftId: String(r.shift_id), openingCash: num(r.opening_cash) };
    },

    async cashMovement(input): Promise<void> {
      const { error } = await sb.rpc("cash_movement", {
        p_branch_id: input.branchId,
        p_direction: input.direction,
        p_amount: input.amount,
        p_reason: input.reason,
        p_category_id: input.categoryId ?? null,
        p_note: input.note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async closeShift(input): Promise<ShiftClosed> {
      const { data, error } = await sb.rpc("close_shift", {
        p_shift_id: input.shiftId,
        p_counted_cash: input.countedCash,
        p_note: input.note ?? null,
        p_note_counts: input.noteCounts ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      // A cashier gets only `closed`. Anything absent stays absent rather than
      // becoming 0, or the till would be showing a figure the database withheld.
      return {
        closed: Boolean(r.closed),
        ...(r.expected != null ? { expected: num(r.expected) } : {}),
        ...(r.counted != null ? { counted: num(r.counted) } : {}),
        ...(r.difference != null ? { difference: num(r.difference) } : {}),
        ...(r.over_limit != null ? { overLimit: Boolean(r.over_limit) } : {}),
      };
    },

    async listShifts(branchId: string, limit = 30): Promise<ShiftRow[]> {
      const { data, error } = await sb.rpc("shift_list", {
        p_branch_id: branchId, p_limit: limit,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((s) => ({
        id: String(s.id), staff: String(s.staff), openedAt: String(s.opened_at),
        closedAt: (s.closed_at as string | null) ?? null,
        openingCash: num(s.opening_cash), expectedCash: num(s.expected_cash),
        countedCash: numOrNull(s.counted_cash), difference: numOrNull(s.difference),
        overLimit: Boolean(s.over_limit), note: (s.note as string | null) ?? null,
        noteCounts: (s.note_counts as Record<string, number> | null) ?? null,
        salesCount: num(s.sales_count),
        byMethod: (s.by_method as Record<string, number> | null) ?? {},
        cashIn: num(s.cash_in), cashOut: num(s.cash_out),
        movements: ((s.movements as Record<string, unknown>[] | null) ?? []).map((m) => ({
          at: String(m.at), direction: m.direction as "in" | "out", amount: num(m.amount),
          reason: m.reason as CashReason, category: (m.category as string | null) ?? null,
          note: (m.note as string | null) ?? null, who: (m.who as string | null) ?? null,
        })),
      }));
    },

    async listExpenseCategories() {
      const { data, error } = await sb
        .from("transaction_categories")
        .select("id, name, applies_to, active")
        .order("name");
      if (error) throw loadError("the expense categories", error);
      type Row = { id: string; name: string; applies_to: string[]; active: boolean };
      return ((data ?? []) as Row[])
        .filter((c) => c.active && (c.applies_to ?? []).includes("expense"))
        .map((c) => ({ id: c.id, name: c.name }));
    },

    // --- Branch transfers (P7) ---

    async listTransfers(branchId: string, limit = 50): Promise<TransferRow[]> {
      const { data, error } = await sb
        .from("transfers")
        .select(`id, transfer_no, status, from_branch_id, to_branch_id, note, sent_at,
                 received_at, resolution, total_cost,
                 fromB:branches!transfers_from_branch_id_fkey(name),
                 toB:branches!transfers_to_branch_id_fkey(name),
                 transfer_items(id, qty, received_qty, damaged_qty, unit_cost, note, product_id,
                                products(name, code, is_serial),
                                transfer_item_serials(arrived_ok, serials(id, serial)))`)
        .or(`from_branch_id.eq.${branchId},to_branch_id.eq.${branchId}`)
        .order("sent_at", { ascending: false })
        .limit(limit);
      if (error) throw loadError("the transfers", error);
      type Row = {
        id: string; transfer_no: string; status: TransferStatus;
        from_branch_id: string; to_branch_id: string; note: string | null;
        sent_at: string; received_at: string | null;
        resolution: "returned" | "written_off" | null; total_cost: number | string;
        fromB: { name: string } | null; toB: { name: string } | null;
        transfer_items: {
          id: string; qty: number; received_qty: number; damaged_qty: number;
          unit_cost: number | string | null; note: string | null; product_id: string;
          products: { name: string; code: string; is_serial: boolean } | null;
          transfer_item_serials: {
            arrived_ok: boolean | null; serials: { id: string; serial: string } | null;
          }[];
        }[];
      };
      return ((data ?? []) as unknown as Row[]).map((t) => ({
        id: t.id, transferNo: t.transfer_no, status: t.status,
        fromBranchId: t.from_branch_id, fromBranchName: t.fromB?.name ?? "",
        toBranchId: t.to_branch_id, toBranchName: t.toB?.name ?? "",
        note: t.note, sentAt: t.sent_at, receivedAt: t.received_at,
        resolution: t.resolution, totalCost: num(t.total_cost),
        lines: (t.transfer_items ?? []).map((i) => ({
          id: i.id, productId: i.product_id, product: i.products?.name ?? "",
          code: i.products?.code ?? "", isSerial: Boolean(i.products?.is_serial),
          qty: i.qty, receivedQty: i.received_qty, damagedQty: i.damaged_qty,
          unitCost: numOrNull(i.unit_cost), note: i.note,
          serials: (i.transfer_item_serials ?? [])
            .filter((x) => x.serials)
            .map((x) => ({
              id: x.serials!.id, serial: x.serials!.serial, arrivedOk: x.arrived_ok,
            })),
        })),
      }));
    },

    async listTransferRequests(branchId: string, limit = 50): Promise<TransferRequestRow[]> {
      const { data, error } = await sb
        .from("transfer_requests")
        .select(`id, req_no, status, from_branch_id, to_branch_id, note, decision_note, created_at,
                 fromB:branches!transfer_requests_from_branch_id_fkey(name),
                 toB:branches!transfer_requests_to_branch_id_fkey(name),
                 staff(name),
                 transfer_request_items(id, qty, product_id, products(name))`)
        .or(`from_branch_id.eq.${branchId},to_branch_id.eq.${branchId}`)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw loadError("the transfer requests", error);
      type Row = {
        id: string; req_no: string; status: TransferRequestStatus;
        from_branch_id: string; to_branch_id: string; note: string | null;
        decision_note: string | null; created_at: string;
        fromB: { name: string } | null; toB: { name: string } | null;
        staff: { name: string } | null;
        transfer_request_items: {
          id: string; qty: number; product_id: string; products: { name: string } | null;
        }[];
      };
      return ((data ?? []) as unknown as Row[]).map((r) => ({
        id: r.id, reqNo: r.req_no, status: r.status,
        fromBranchId: r.from_branch_id, fromBranchName: r.fromB?.name ?? "",
        toBranchId: r.to_branch_id, toBranchName: r.toB?.name ?? "",
        note: r.note, decisionNote: r.decision_note, askedBy: r.staff?.name ?? null,
        createdAt: r.created_at,
        lines: (r.transfer_request_items ?? []).map((i) => ({
          id: i.id, productId: i.product_id, product: i.products?.name ?? "", qty: i.qty,
        })),
      }));
    },

    async saveTransferRequest(input) {
      const { data, error } = await sb.rpc("save_transfer_request", {
        p_from_branch: input.fromBranchId,
        p_to_branch: input.toBranchId,
        p_lines: input.lines.map((l) => ({ product_id: l.productId, qty: l.qty })),
        p_note: input.note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id), reqNo: String(r.req_no), status: r.status as TransferRequestStatus,
      };
    },

    async decideTransferRequest(requestId, approve, note) {
      const { data, error } = await sb.rpc("decide_transfer_request", {
        p_request_id: requestId, p_approve: approve, p_note: note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return { reqNo: String(r.req_no), status: r.status as TransferRequestStatus };
    },

    async inTransit(branchId?: string | null): Promise<InTransitRow[]> {
      const { data, error } = await sb.rpc("in_transit", { p_branch_id: branchId ?? null });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((t) => ({
        id: String(t.id), transferNo: String(t.transfer_no),
        status: t.status as TransferStatus,
        fromBranch: String(t.from_branch), toBranch: String(t.to_branch),
        sentAt: String(t.sent_at), daysOut: num(t.days_out), totalCost: num(t.total_cost),
        items: ((t.items as Record<string, unknown>[] | null) ?? []).map((i) => ({
          product: String(i.product), qty: num(i.qty), received: num(i.received),
        })),
      }));
    },

    async sendTransfer(input): Promise<TransferSent> {
      const { data, error } = await sb.rpc("send_transfer", {
        p_from_branch: input.fromBranchId,
        p_to_branch: input.toBranchId,
        p_lines: input.lines.map((l) => ({
          product_id: l.productId, qty: l.qty, serials: l.serialIds ?? [],
        })),
        p_note: input.note ?? null,
        p_to_location: input.toLocationId ?? null,
        p_from_location: input.fromLocationId ?? null,
        p_request_id: input.requestId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id), transferNo: String(r.transfer_no), totalCost: num(r.total_cost),
        lines: ((r.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          product: String(l.product), qty: num(l.qty), unitCost: numOrNull(l.unit_cost),
        })),
      };
    },

    async receiveTransfer(input): Promise<TransferReceived> {
      const { data, error } = await sb.rpc("receive_transfer", {
        p_transfer_id: input.transferId,
        p_lines: input.lines.map((l) => ({
          item_id: l.itemId,
          ok_qty: l.okQty ?? 0,
          damaged_qty: l.damagedQty ?? 0,
          serials_ok: l.serialsOk ?? [],
          serials_damaged: l.serialsDamaged ?? [],
          note: l.note ?? null,
        })),
        p_note: input.note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        transferNo: String(r.transfer_no), status: r.status as TransferStatus,
        lines: ((r.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          product: String(l.product), sent: num(l.sent), ok: num(l.ok),
          damaged: num(l.damaged), short: num(l.short),
        })),
      };
    },

    async resolveTransfer(transferId, action, note) {
      const { data, error } = await sb.rpc("resolve_transfer", {
        p_transfer_id: transferId, p_action: action, p_note: note,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        transferNo: String(r.transfer_no), resolution: String(r.resolution),
        costOfShortage: num(r.cost_of_shortage),
      };
    },

    async cancelTransfer(transferId: string, reason: string): Promise<void> {
      const { error } = await sb.rpc("cancel_transfer", {
        p_transfer_id: transferId, p_reason: reason,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async moveWithinBranch(input) {
      const { data, error } = await sb.rpc("move_within_branch", {
        p_branch_id: input.branchId,
        p_from_location: input.fromLocationId,
        p_to_location: input.toLocationId,
        p_lines: input.lines.map((l) => ({
          product_id: l.productId, qty: l.qty, serials: l.serialIds ?? [],
        })),
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return {
        lines: ((r.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          product: String(l.product), qty: num(l.qty),
        })),
      };
    },

    async listTransferRoutes(): Promise<TransferRoute[]> {
      const { data, error } = await sb
        .from("transfer_routes").select("from_branch_id, to_branch_id");
      if (error) throw loadError("the transfer routes", error);
      return (data ?? []).map((r) => ({
        fromBranchId: r.from_branch_id, toBranchId: r.to_branch_id,
      }));
    },

    async saveTransferRoute(fromBranchId, toBranchId, allowed) {
      const { error } = await sb.rpc("save_transfer_route", {
        p_from: fromBranchId, p_to: toBranchId, p_allowed: allowed,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async setOpeningBalance(input) {
      const { data, error } = await sb.rpc("set_opening_balance", {
        p_party_kind: input.partyKind,
        p_party_id: input.partyId,
        p_amount: input.amount,
        p_as_of: input.asOf ?? null,
        p_note: input.note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      return { name: String(r.name), amount: num(r.amount), asOf: String(r.as_of) };
    },

    // --- Accounts (P13) ---

    async chartOfAccounts(): Promise<ChartAccount[]> {
      const { data, error } = await sb.rpc("chart_of_accounts");
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map(readAccount);
    },

    async trialBalance(branchId, from, to): Promise<TrialBalance> {
      const { data, error } = await sb.rpc("trial_balance", {
        p_branch_id: branchId ?? null, p_from: from ?? null, p_to: to ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      return {
        from: (d.from as string | null) ?? null,
        to: (d.to as string | null) ?? null,
        branch: (d.branch as string | null) ?? null,
        totalDebit: num(d.total_debit),
        totalCredit: num(d.total_credit),
        balanced: Boolean(d.balanced),
        accounts: ((d.accounts as Record<string, unknown>[] | null) ?? []).map((a) => ({
          accountId: String(a.account_id), code: String(a.code), name: String(a.name),
          group: String(a.group), nature: a.nature as AccountNature,
          branch: (a.branch as string | null) ?? null,
          debit: num(a.debit), credit: num(a.credit), balance: num(a.balance),
        })),
      };
    },

    async accountLedger(accountId, from, to, branchId): Promise<AccountLedger> {
      const { data, error } = await sb.rpc("account_ledger", {
        p_account_id: accountId, p_from: from ?? null, p_to: to ?? null,
        p_branch_id: branchId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      const a = (d.account ?? {}) as Record<string, unknown>;
      return {
        account: {
          id: String(a.id), code: String(a.code), name: String(a.name),
          nature: a.nature as AccountNature, branch: (a.branch as string | null) ?? null,
        },
        opening: num(d.opening),
        lines: ((d.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          entryId: String(l.entry_id), entryNo: String(l.entry_no), date: String(l.date),
          narration: (l.narration as string | null) ?? null,
          sourceKind: (l.source_kind as string | null) ?? null,
          sourceId: (l.source_id as string | null) ?? null,
          branch: (l.branch as string | null) ?? null,
          debit: num(l.debit), credit: num(l.credit),
          note: (l.note as string | null) ?? null,
          party: (l.party as string | null) ?? null,
          who: (l.who as string | null) ?? null,
        })),
      };
    },

    async voucherList(input = {}): Promise<VoucherRow[]> {
      const { data, error } = await sb.rpc("voucher_list", {
        p_from: input.from ?? null, p_to: input.to ?? null,
        p_branch_id: input.branchId ?? null, p_status: input.status ?? null,
        p_source: input.source ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((e) => ({
        id: String(e.id), entryNo: String(e.entry_no), date: String(e.date),
        narration: (e.narration as string | null) ?? null,
        sourceKind: (e.source_kind as string | null) ?? null,
        sourceId: (e.source_id as string | null) ?? null,
        status: e.status as EntryStatus,
        branch: (e.branch as string | null) ?? null,
        branchId: (e.branch_id as string | null) ?? null,
        otherBranch: (e.other_branch as string | null) ?? null,
        acceptedAt: (e.accepted_at as string | null) ?? null,
        reversesId: (e.reverses_id as string | null) ?? null,
        who: (e.who as string | null) ?? null,
        amount: num(e.amount),
        lines: ((e.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          account: String(l.account), code: String(l.code),
          debit: num(l.debit), credit: num(l.credit),
          note: (l.note as string | null) ?? null,
          party: (l.party as string | null) ?? null,
        })),
      }));
    },

    async moneyBalances(branchId): Promise<MoneyBalance[]> {
      const { data, error } = await sb.rpc("money_balances", { p_branch_id: branchId ?? null });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((a) => ({
        accountId: String(a.account_id), code: String(a.code), name: String(a.name),
        role: (a.role as AccountRole | null) ?? null,
        branch: (a.branch as string | null) ?? null,
        bankAccountId: (a.bank_account_id as string | null) ?? null,
        balance: num(a.balance),
        unclearedOut: num(a.uncleared_out), unclearedIn: num(a.uncleared_in),
      }));
    },

    async saveVoucher(input): Promise<{ id: string; entryNo: string; status: string }> {
      const { data, error } = await sb.rpc("save_voucher", {
        p_kind: input.kind, p_branch_id: input.branchId, p_date: input.date ?? null,
        p_narration: input.narration ?? null, p_amount: input.amount ?? null,
        p_from_account: input.fromAccount ?? null, p_to_account: input.toAccount ?? null,
        p_customer_id: input.customerId ?? null, p_supplier_id: input.supplierId ?? null,
        p_lines: input.lines
          ? input.lines.map((l) => ({
              account_id: l.accountId, debit: l.debit ?? 0, credit: l.credit ?? 0,
              note: l.note ?? null, customer_id: l.customerId ?? null,
              supplier_id: l.supplierId ?? null,
            }))
          : null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { id: String(r.id), entryNo: String(r.entry_no), status: String(r.status) };
    },

    async approveVoucher(entryId, approve, reason): Promise<void> {
      const { error } = await sb.rpc("approve_voucher", {
        p_entry_id: entryId, p_approve: approve, p_reason: reason ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async reverseEntry(entryId, reason): Promise<{ entryNo: string }> {
      const { data, error } = await sb.rpc("reverse_entry", {
        p_entry_id: entryId, p_reason: reason,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { entryNo: String(r.entry_no ?? "") };
    },

    async interBranchEntry(input): Promise<{ id: string; entryNo: string; waitingOn: string | null }> {
      const { data, error } = await sb.rpc("inter_branch_entry", {
        p_from_branch: input.fromBranchId, p_to_branch: input.toBranchId,
        p_amount: input.amount, p_narration: input.narration ?? null,
        p_kind: input.kind ?? "fund",
        p_from_account: input.fromAccount ?? null, p_to_account: input.toAccount ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id), entryNo: String(r.entry_no),
        waitingOn: (r.waiting_on as string | null) ?? null,
      };
    },

    async acceptInterBranch(entryId): Promise<{ accepted: string; amount: number }> {
      const { data, error } = await sb.rpc("accept_inter_branch", { p_entry_id: entryId });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { accepted: String(r.accepted ?? ""), amount: num(r.amount) };
    },

    async listCheques(input = {}): Promise<ChequeRow[]> {
      const { data, error } = await sb.rpc("cheque_list", {
        p_direction: input.direction ?? null, p_status: input.status ?? null,
        p_from: input.from ?? null, p_to: input.to ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((c) => ({
        id: String(c.id), direction: c.direction as ChequeDirection,
        chequeNo: String(c.cheque_no), amount: num(c.amount),
        chequeDate: String(c.cheque_date), status: c.status as ChequeStatus,
        payee: (c.payee as string | null) ?? null,
        drawnOn: (c.drawn_on as string | null) ?? null,
        bank: (c.bank as string | null) ?? null,
        branch: (c.branch as string | null) ?? null,
        customerId: (c.customer_id as string | null) ?? null,
        supplierId: (c.supplier_id as string | null) ?? null,
        bouncedReason: (c.bounced_reason as string | null) ?? null,
        clearedAt: (c.cleared_at as string | null) ?? null,
        note: (c.note as string | null) ?? null,
        who: (c.who as string | null) ?? null,
        overdue: Boolean(c.overdue),
      }));
    },

    async listChequeBooks(): Promise<ChequeBookRow[]> {
      const { data, error } = await sb.rpc("cheque_book_list");
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((b) => ({
        id: String(b.id), bankAccountId: String(b.bank_account_id), bank: String(b.bank),
        prefix: (b.prefix as string | null) ?? null,
        firstNumber: num(b.first_number), lastNumber: num(b.last_number),
        nextNumber: num(b.next_number), active: Boolean(b.active), left: num(b.left),
      }));
    },

    async saveChequeBook(bankAccountId, first, last, prefix): Promise<void> {
      const { error } = await sb.rpc("save_cheque_book", {
        p_bank_account_id: bankAccountId, p_first: first, p_last: last,
        p_prefix: prefix ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async saveCheque(input): Promise<{ id: string; chequeNo: string; amount: number }> {
      const { data, error } = await sb.rpc("save_cheque", {
        p_branch_id: input.branchId, p_direction: input.direction, p_amount: input.amount,
        p_cheque_date: input.chequeDate, p_cheque_no: input.chequeNo ?? null,
        p_book_id: input.bookId ?? null, p_bank_account_id: input.bankAccountId ?? null,
        p_payee: input.payee ?? null, p_customer_id: input.customerId ?? null,
        p_supplier_id: input.supplierId ?? null, p_drawn_on: input.drawnOn ?? null,
        p_note: input.note ?? null,
        p_supplier_payment_id: input.supplierPaymentId ?? null,
        p_customer_payment_id: input.customerPaymentId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { id: String(r.id), chequeNo: String(r.cheque_no), amount: num(r.amount) };
    },

    async setChequeStatus(chequeId, status, reason): Promise<{ chequeNo: string; status: ChequeStatus; reversed: boolean }> {
      const { data, error } = await sb.rpc("set_cheque_status", {
        p_cheque_id: chequeId, p_status: status, p_reason: reason ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        chequeNo: String(r.cheque_no), status: r.status as ChequeStatus,
        reversed: Boolean(r.reversed),
      };
    },

    async chequePrint(chequeId): Promise<ChequePrint> {
      const { data, error } = await sb.rpc("cheque_print", { p_cheque_id: chequeId });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      const l = (d.layout ?? {}) as Record<string, unknown>;
      return {
        chequeNo: String(d.cheque_no), date: String(d.date),
        payee: (d.payee as string | null) ?? null,
        amount: num(d.amount), amountWords: String(d.amount_words),
        bank: (d.bank as string | null) ?? null,
        measured: Boolean(d.measured),
        layout: readLayout(l),
      };
    },

    async saveChequeLayout(bankAccountId, values): Promise<void> {
      const { error } = await sb.rpc("save_cheque_layout", {
        p_bank_account_id: bankAccountId, p_values: values,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async recordExpense(input): Promise<void> {
      const { error } = await sb.rpc("record_expense", {
        p_branch_id: input.branchId, p_category_id: input.categoryId,
        p_amount: input.amount, p_method: input.method ?? "cash",
        p_note: input.note ?? null, p_supplier_id: input.supplierId ?? null,
        p_date: input.date ?? null, p_bank_account_id: input.bankAccountId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async saveAccount(id, values): Promise<void> {
      const { error } = await sb.rpc("save_account", { p_id: id, p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    async backfillAccounts(from): Promise<BackfillResult> {
      const { data, error } = await sb.rpc("backfill_accounts", { p_from: from ?? null });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      // Catching up is two halves, and the second one is the point of the first: the
      // sales and deliveries get posted, and THEN the stock already on the shelves is
      // brought onto the books at its counted value. Without this second call the
      // stock account stays short by the whole opening shelf and the trial balance
      // never agrees with a stock valuation.
      const { data: stockData, error: stockError } =
        await sb.rpc("backfill_stock_entries");
      if (stockError) throw new Error(friendlyError(stockError.message));
      const st = (stockData ?? {}) as Record<string, unknown>;
      return {
        from: String(r.from), sales: num(r.sales), grns: num(r.grns),
        supplierReturns: num(r.supplier_returns), saleReturns: num(r.sale_returns),
        customerPayments: num(r.customer_payments),
        supplierPayments: num(r.supplier_payments),
        cashMovements: num(r.cash_movements),
        stockBroughtIn: num(st.stock_brought_in),
      };
    },

    async listReports(): Promise<ReportListItem[]> {
      const { data, error } = await sb.rpc("report_list");
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        key: String(r.key), register: r.register as ReportRegisterKey,
        sl: num(r.sl), title: String(r.title),
        note: (r.note as string | null) ?? null,
        dateMode: (r.date_mode as ReportListItem["dateMode"]) ?? "range",
        landscape: Boolean(r.landscape),
        needs: (r.needs as string | null) ?? null,
        needsCost: Boolean(r.needs_cost),
        allowed: Boolean(r.allowed),
        renamed: Boolean(r.renamed),
      }));
    },

    async runReport(key, filters): Promise<ReportResult> {
      const { data, error } = await sb.rpc("report_run", {
        p_key: key, p_filters: toFilters(filters),
      });
      if (error) throw new Error(friendlyError(error.message));
      return readReport(key, (data ?? {}) as Record<string, unknown>, filters ?? {});
    },

    async saveReportSetting(key, values): Promise<void> {
      const { error } = await sb.rpc("save_report_setting", { p_key: key, p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    async lockPeriod(month, locked, note): Promise<void> {
      const { error } = await sb.rpc("lock_period", {
        p_month: month, p_locked: locked, p_note: note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async listPeriodLocks(): Promise<PeriodLock[]> {
      const { data, error } = await sb.rpc("period_lock_list");
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((l) => ({
        month: String(l.month), note: (l.note as string | null) ?? null,
        at: String(l.at), who: String(l.who),
      }));
    },

    async journalExport(from, to, branchId): Promise<JournalExport> {
      const { data, error } = await sb.rpc("journal_export", {
        p_from: from ?? null, p_to: to ?? null, p_branch_id: branchId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      return {
        shop: String(d.shop ?? ""),
        from: (d.from as string | null) ?? null, to: (d.to as string | null) ?? null,
        lines: ((d.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          date: String(l.date), entryNo: String(l.entry_no), kind: String(l.kind),
          narration: String(l.narration ?? ""), account: String(l.account),
          accountCode: String(l.account_code), party: String(l.party ?? ""),
          debit: num(l.debit), credit: num(l.credit), note: String(l.note ?? ""),
          branch: String(l.branch),
        })),
      };
    },

    async rebuildStockLayers(): Promise<LayerRebuildResult> {
      const { data, error } = await sb.rpc("backfill_stock_layers");
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        movements: num(r.movements), layers: num(r.layers), openLayers: num(r.open_layers),
      };
    },

    // --- Quotations, sales orders and challans (P14a) ---

    async listQuotations(input): Promise<QuotationRow[]> {
      const { data, error } = await sb.rpc("quotation_list", {
        p_branch_id: input?.branchId ?? null, p_status: input?.status ?? null,
        p_from: input?.from ?? null, p_to: input?.to ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((q) => ({
        id: String(q.id), quoteNo: String(q.quote_no), date: String(q.date),
        branch: String(q.branch), branchId: String(q.branch_id),
        customer: String(q.customer), customerId: (q.customer_id as string | null) ?? null,
        total: num(q.total), status: q.status as QuotationRow["status"],
        validUntil: (q.valid_until as string | null) ?? null,
        outOfDate: Boolean(q.out_of_date), lines: num(q.lines), who: String(q.who),
      }));
    },

    async saveQuotation(id, values, lines) {
      const { data, error } = await sb.rpc("save_quotation", {
        p_id: id, p_values: values, p_lines: lines,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { id: String(r.id), quoteNo: String(r.quote_no), total: num(r.total),
               status: String(r.status) };
    },

    async setQuotationStatus(id, status, note): Promise<void> {
      const { error } = await sb.rpc("set_quotation_status", {
        p_id: id, p_status: status, p_note: note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async listOrders(input): Promise<OrderRow[]> {
      const { data, error } = await sb.rpc("order_list", {
        p_branch_id: input?.branchId ?? null, p_status: input?.status ?? null,
        p_from: input?.from ?? null, p_to: input?.to ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((o) => ({
        id: String(o.id), soNo: String(o.so_no), date: String(o.date),
        branch: String(o.branch), branchId: String(o.branch_id),
        customer: String(o.customer), customerId: String(o.customer_id),
        deliveryDate: (o.delivery_date as string | null) ?? null,
        status: o.status as OrderRow["status"],
        total: num(o.total), advance: num(o.advance),
        ordered: num(o.ordered), delivered: num(o.delivered), pending: num(o.pending),
        late: Boolean(o.late), daysLate: numOrNull(o.days_late),
        quoteNo: (o.quote_no as string | null) ?? null,
        who: String(o.who), soldBy: (o.sold_by as string | null) ?? null,
      }));
    },

    async saveSalesOrder(id, values, lines, approvalId) {
      const { data, error } = await sb.rpc("save_sales_order", {
        p_id: id, p_values: values, p_lines: lines, p_approval_id: approvalId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { id: String(r.id), soNo: String(r.so_no), total: num(r.total),
               status: String(r.status), waitingForApproval: Boolean(r.waiting_for_approval) };
    },

    async adjustSalesOrder(orderId, lines, note): Promise<void> {
      const { error } = await sb.rpc("adjust_sales_order", {
        p_order_id: orderId,
        p_lines: lines.map((l) => ({ id: l.id, qty: l.qty ?? null, cancel: l.cancel ?? false })),
        p_note: note,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async setOrderStatus(orderId, action, reason): Promise<void> {
      const { error } = await sb.rpc("set_order_status", {
        p_order_id: orderId, p_action: action, p_reason: reason ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async recordAdvance(input) {
      const { data, error } = await sb.rpc("record_advance", {
        p_order_id: input.orderId, p_amount: input.amount,
        p_method: input.method ?? "cash", p_reference: input.reference ?? null,
        p_note: input.note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { amount: num(r.amount), advanceTotal: num(r.advance_total) };
    },

    async listAdvances(branchId): Promise<AdvanceRow[]> {
      const { data, error } = await sb.rpc("advance_list", { p_branch_id: branchId ?? null });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((a) => ({
        id: String(a.id), date: String(a.date), customer: String(a.customer),
        customerId: String(a.customer_id),
        orderNo: (a.order_no as string | null) ?? null,
        orderId: (a.order_id as string | null) ?? null,
        amount: num(a.amount), method: String(a.method),
        reference: (a.reference as string | null) ?? null,
        branch: String(a.branch), daysHeld: num(a.days_held), who: String(a.who),
      }));
    },

    async listChallans(input): Promise<ChallanRow[]> {
      const { data, error } = await sb.rpc("challan_list", {
        p_branch_id: input?.branchId ?? null, p_status: input?.status ?? null,
        p_from: input?.from ?? null, p_to: input?.to ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((c) => ({
        id: String(c.id), challanNo: String(c.challan_no), date: String(c.date),
        branch: String(c.branch), branchId: String(c.branch_id),
        customer: String(c.customer), customerId: String(c.customer_id),
        orderNo: (c.order_no as string | null) ?? null,
        orderId: (c.order_id as string | null) ?? null,
        status: c.status as ChallanRow["status"],
        atCost: num(c.at_cost),
        carrier: (c.carrier as string | null) ?? null,
        vehicleNo: (c.vehicle_no as string | null) ?? null,
        qty: num(c.qty), toBill: num(c.to_bill),
        daysUnbilled: numOrNull(c.days_unbilled),
        invoiceNo: (c.invoice_no as string | null) ?? null,
        who: String(c.who),
      }));
    },

    async saveChallan(branchId, values, lines) {
      const { data, error } = await sb.rpc("save_challan", {
        p_branch_id: branchId, p_values: values, p_lines: lines,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { id: String(r.id), challanNo: String(r.challan_no), atCost: num(r.at_cost),
               orderStatus: (r.order_status as string | null) ?? null };
    },

    async returnChallan(challanId, lines, reason) {
      const { data, error } = await sb.rpc("return_challan", {
        p_challan_id: challanId,
        p_lines: lines.map((l) => ({ id: l.id, qty: l.qty ?? null,
                                     serial_ids: l.serialIds ?? [] })),
        p_reason: reason,
      });
      if (error) throw new Error(friendlyError(error.message));
      return { returned: num(((data ?? {}) as Record<string, unknown>).returned) };
    },

    async billChallan(input): Promise<BilledResult> {
      const { data, error } = await sb.rpc("bill_challan", {
        p_challan_id: input.challanId, p_payment_method: input.paymentMethod ?? "cash",
        p_cash_received: input.cashReceived ?? null, p_payment_ref: input.paymentRef ?? null,
        p_due_amount: input.dueAmount ?? null, p_approval_id: input.approvalId ?? null,
        p_extras: input.extras ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { ...readReceipt(r), challanNo: (r.challan_no as string | null) ?? null,
               advanceUsed: num(r.advance_used), stillOwed: num(r.still_owed) };
    },

    async billOrder(input): Promise<BilledResult> {
      const { data, error } = await sb.rpc("bill_order", {
        p_order_id: input.orderId, p_payment_method: input.paymentMethod ?? "cash",
        p_cash_received: input.cashReceived ?? null, p_payment_ref: input.paymentRef ?? null,
        p_due_amount: input.dueAmount ?? null, p_approval_id: input.approvalId ?? null,
        p_extras: input.extras ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { ...readReceipt(r), challanNo: (r.challan_no as string | null) ?? null,
               advanceUsed: num(r.advance_used), stillOwed: num(r.still_owed) };
    },

    async salesDocument(kind, id): Promise<SalesDocument> {
      const { data, error } = await sb.rpc("sales_document", { p_kind: kind, p_id: id });
      if (error) throw new Error(friendlyError(error.message));
      return readSalesDocument((data ?? {}) as Record<string, unknown>);
    },

    // --- HR: employees, attendance and salary (P14b) ---

    async listEmployees(input): Promise<Employee[]> {
      const { data, error } = await sb.rpc("employee_list", {
        p_branch_id: input?.branchId ?? null,
        p_active: input?.active === undefined ? true : input.active,
        p_query: input?.query ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map(readEmployee);
    },

    async saveEmployee(id, values): Promise<void> {
      const { error } = await sb.rpc("save_employee", { p_id: id, p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    async saveSalaryTerms(employeeId, values): Promise<void> {
      const { error } = await sb.rpc("save_salary_terms", {
        p_employee_id: employeeId, p_values: values,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async saveAttendanceSettings(branchId, values) {
      const { data, error } = await sb.rpc("save_attendance_settings", {
        p_branch_id: branchId, p_values: values,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { opensAt: String(r.opens_at ?? ""), graceMinutes: num(r.grace_minutes),
               takesCheckIns: Boolean(r.takes_check_ins) };
    },

    async checkIn(branchId, pin, employeeId): Promise<CheckInResult> {
      const { data, error } = await sb.rpc("check_in", {
        p_branch_id: branchId, p_pin: pin, p_employee_id: employeeId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        employee: String(r.employee), branch: String(r.branch), date: String(r.date),
        status: r.status as AttendanceStatus, minutesLate: num(r.minutes_late),
        opensAt: String(r.opens_at), graceMinutes: num(r.grace_minutes),
      };
    },

    async checkOut(branchId, employeeId): Promise<void> {
      const { error } = await sb.rpc("check_out", {
        p_branch_id: branchId, p_employee_id: employeeId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async markAttendance(employeeId, date, status, note): Promise<void> {
      const { error } = await sb.rpc("mark_attendance", {
        p_employee_id: employeeId, p_date: date, p_status: status, p_note: note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async attendanceDay(date, branchId): Promise<AttendanceDay> {
      const { data, error } = await sb.rpc("attendance_day", {
        p_date: date ?? null, p_branch_id: branchId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      const c = (d.counts ?? {}) as Record<string, unknown>;
      return {
        date: String(d.date), holiday: (d.holiday as string | null) ?? null,
        people: ((d.people as Record<string, unknown>[] | null) ?? []).map((p) => ({
          employeeId: String(p.employee_id), name: String(p.name),
          branch: (p.branch as string | null) ?? null,
          branchId: (p.branch_id as string | null) ?? null,
          designation: (p.designation as string | null) ?? null,
          status: p.status as AttendanceRow["status"],
          inAt: (p.in_at as string | null) ?? null,
          outAt: (p.out_at as string | null) ?? null,
          minutesLate: num(p.minutes_late),
          source: (p.source as "self" | "manager" | null) ?? null,
          note: (p.note as string | null) ?? null,
          markedBy: (p.marked_by as string | null) ?? null,
        })),
        counts: {
          present: num(c.present), late: num(c.late), absent: num(c.absent),
          leave: num(c.leave), notRecorded: num(c.not_recorded), people: num(c.people),
        },
      };
    },

    async attendanceToday(branchId): Promise<AttendanceTodayBranch[]> {
      const { data, error } = await sb.rpc("attendance_today", {
        p_branch_id: branchId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      if (!d.on) return [];
      return ((d.branches as Record<string, unknown>[] | null) ?? []).map((b) => ({
        branch: String(b.branch), branchId: String(b.branch_id),
        people: num(b.people), present: num(b.present), late: num(b.late),
        absent: num(b.absent), onLeave: num(b.on_leave), notRecorded: num(b.not_recorded),
      }));
    },

    async listLeave(status, employeeId): Promise<LeaveRow[]> {
      const { data, error } = await sb.rpc("leave_list", {
        p_status: status ?? null, p_employee_id: employeeId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        id: String(r.id), employee: String(r.employee), employeeId: String(r.employee_id),
        kind: String(r.kind), isPaid: Boolean(r.is_paid),
        fromDate: String(r.from_date), toDate: String(r.to_date), days: num(r.days),
        reason: (r.reason as string | null) ?? null,
        status: r.status as LeaveRow["status"],
        note: (r.note as string | null) ?? null,
        decidedBy: (r.decided_by as string | null) ?? null,
        takenThisYear: num(r.taken_this_year), daysAYear: num(r.days_a_year),
      }));
    },

    async askForLeave(input) {
      const { data, error } = await sb.rpc("save_leave_request", {
        p_employee_id: input.employeeId, p_leave_type_id: input.leaveTypeId,
        p_from: input.from, p_to: input.to, p_reason: input.reason ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return { days: num(((data ?? {}) as Record<string, unknown>).days) };
    },

    async decideLeave(id, approve, note): Promise<void> {
      const { error } = await sb.rpc("decide_leave", {
        p_id: id, p_approve: approve, p_note: note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async recordSalaryAdvance(employeeId, amount, method, note): Promise<void> {
      const { error } = await sb.rpc("record_salary_advance", {
        p_employee_id: employeeId, p_amount: amount,
        p_method: method ?? "cash", p_note: note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async buildSalarySheet(month, branchId) {
      const { data, error } = await sb.rpc("build_salary_sheet", {
        p_month: month, p_branch_id: branchId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { id: String(r.id), employees: num(r.employees), total: num(r.total) };
    },

    async paySalarySheet(sheetId, method, note) {
      const { data, error } = await sb.rpc("pay_salary_sheet", {
        p_sheet_id: sheetId, p_method: method ?? "cash", p_note: note ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return { total: num(((data ?? {}) as Record<string, unknown>).total) };
    },

    async listSalarySheets(branchId): Promise<SalarySheetRow[]> {
      const { data, error } = await sb.rpc("salary_sheet_list", {
        p_branch_id: branchId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        id: String(r.id), month: String(r.month), status: r.status as "draft" | "paid",
        total: num(r.total), branch: (r.branch as string | null) ?? null,
        branchId: (r.branch_id as string | null) ?? null,
        paidOn: (r.paid_on as string | null) ?? null, people: num(r.people),
      }));
    },

    async salarySheet(id): Promise<SalarySheet> {
      const { data, error } = await sb.rpc("salary_sheet", { p_id: id });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      return {
        id: String(d.id), month: String(d.month), status: d.status as "draft" | "paid",
        total: num(d.total), branch: (d.branch as string | null) ?? null,
        branchId: (d.branch_id as string | null) ?? null,
        paidOn: (d.paid_on as string | null) ?? null,
        method: (d.method as string | null) ?? null,
        note: (d.note as string | null) ?? null, who: String(d.who ?? ""),
        lines: ((d.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
          id: String(l.id), employeeId: String(l.employee_id),
          employee: String(l.employee),
          designation: (l.designation as string | null) ?? null,
          basic: num(l.basic), allowances: num(l.allowances),
          absentDays: num(l.absent_days), absenceCut: num(l.absence_cut),
          advanceCut: num(l.advance_cut), otherCut: num(l.other_cut),
          daysWorked: num(l.days_worked), daysInMonth: num(l.days_in_month),
          net: num(l.net),
        })),
      };
    },

    // --- Sales reps, dealers and delivery points (P14c) ---

    async listReps(): Promise<RepRow[]> {
      const { data, error } = await sb.rpc("rep_list");
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
        employeeId: String(r.employee_id), name: String(r.name),
        phone: (r.phone as string | null) ?? null,
        branch: (r.branch as string | null) ?? null,
        branchId: (r.branch_id as string | null) ?? null,
        commissionPct: num(r.commission_pct),
        commissionOn: r.commission_on as RepRow["commissionOn"],
        customers: num(r.customers),
        areas: ((r.areas as Record<string, unknown>[] | null) ?? []).map((a) => ({
          districtId: numOrNull(a.district_id),
          district: (a.district as string | null) ?? null,
          upazilaId: numOrNull(a.upazila_id),
          upazila: (a.upazila as string | null) ?? null,
        })),
      }));
    },

    async saveRep(employeeId, values): Promise<void> {
      const { error } = await sb.rpc("save_rep", {
        p_employee_id: employeeId, p_values: values,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async saveRepTarget(employeeId, month, values): Promise<void> {
      const { error } = await sb.rpc("save_rep_target", {
        p_employee_id: employeeId, p_month: month, p_values: values,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async repAchievement(month, employeeId): Promise<RepMonth> {
      const { data, error } = await sb.rpc("rep_achievement", {
        p_month: month ?? null, p_employee_id: employeeId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const d = (data ?? {}) as Record<string, unknown>;
      return {
        month: String(d.month), daysInMonth: num(d.days_in_month),
        daysLeft: num(d.days_left),
        reps: ((d.reps as Record<string, unknown>[] | null) ?? []).map((r) => ({
          employeeId: String(r.employee_id), name: String(r.name),
          commissionPct: num(r.commission_pct),
          commissionOn: r.commission_on as RepRow["commissionOn"],
          target: num(r.target), targetQty: num(r.target_qty),
          sold: num(r.sold), qty: num(r.qty),
          profit: numOrNull(r.profit), donePct: numOrNull(r.done_pct),
          shortBy: numOrNull(r.short_by), aDayNeeded: numOrNull(r.a_day_needed),
          commission: numOrNull(r.commission), customers: num(r.customers),
        })),
      };
    },

    async listDeliveryPoints(customerId): Promise<DeliveryPoint[]> {
      const { data, error } = await sb.rpc("delivery_point_list", {
        p_customer_id: customerId,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((d) => ({
        id: String(d.id), name: String(d.name),
        address: (d.address as string | null) ?? null,
        contactName: (d.contact_name as string | null) ?? null,
        contactPhone: (d.contact_phone as string | null) ?? null,
        isDefault: Boolean(d.is_default), active: Boolean(d.active),
        note: (d.note as string | null) ?? null,
      }));
    },

    async saveDeliveryPoint(id, customerId, values): Promise<void> {
      const { error } = await sb.rpc("save_delivery_point", {
        p_id: id, p_customer_id: customerId, p_values: values,
      });
      if (error) throw new Error(friendlyError(error.message));
    },

    async recordDeposit(input) {
      const { data, error } = await sb.rpc("record_deposit", {
        p_customer_id: input.customerId, p_amount: input.amount,
        p_method: input.method ?? "cash", p_reference: input.reference ?? null,
        p_note: input.note ?? null, p_branch_id: input.branchId ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = (data ?? {}) as Record<string, unknown>;
      return { amount: num(r.amount), held: num(r.held) };
    },

    async convertCustomer(id, values): Promise<void> {
      const { error } = await sb.rpc("convert_customer", { p_id: id, p_values: values });
      if (error) throw new Error(friendlyError(error.message));
    },

    async moveCustomerBranch(id, branchId, reason) {
      const { data, error } = await sb.rpc("move_customer_branch", {
        p_id: id, p_branch_id: branchId, p_reason: reason ?? null,
      });
      if (error) throw new Error(friendlyError(error.message));
      return { owed: num(((data ?? {}) as Record<string, unknown>).owed) };
    },

    async searchCustomers(input): Promise<CustomerSearchRow[]> {
      const { data, error } = await sb.rpc("customer_search", {
        p_query: input?.query ?? null, p_kind: input?.kind ?? null,
        p_rep_id: input?.repId ?? null, p_district_id: input?.districtId ?? null,
        p_flag: input?.flag ?? null, p_limit: input?.limit ?? 100,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((c) => ({
        id: String(c.id), phone: String(c.phone), name: String(c.name),
        company: (c.company as string | null) ?? null,
        address: (c.address as string | null) ?? null,
        kind: c.kind as CustomerKind,
        group: (c.group as string | null) ?? null,
        groupId: (c.group_id as string | null) ?? null,
        rep: (c.rep as string | null) ?? null,
        repId: (c.rep_id as string | null) ?? null,
        parent: (c.parent as string | null) ?? null,
        parentId: (c.parent_id as string | null) ?? null,
        homeBranch: (c.home_branch as string | null) ?? null,
        homeBranchId: (c.home_branch_id as string | null) ?? null,
        districtId: numOrNull(c.district_id),
        district: (c.district as string | null) ?? null,
        blocked: Boolean(c.blocked),
        blockReason: (c.block_reason as string | null) ?? null,
        cashOnly: Boolean(c.cash_only), isVip: Boolean(c.is_vip),
        creditAllowed: Boolean(c.credit_allowed), creditLimit: num(c.credit_limit),
        paymentDays: num(c.payment_days), owed: num(c.owed), deposit: num(c.deposit),
        deliveryPoints: num(c.delivery_points), active: Boolean(c.active),
      }));
    },

    async stockHistory(branchId: string, productId?: string | null, limit = 100): Promise<StockMovementRow[]> {
      const { data, error } = await sb.rpc("stock_history", {
        p_branch_id: branchId, p_product_id: productId ?? null, p_limit: limit,
      });
      if (error) throw new Error(friendlyError(error.message));
      return ((data as Record<string, unknown>[] | null) ?? []).map((m) => ({
        at: String(m.at), product: String(m.product), code: String(m.code),
        change: num(m.change), reason: String(m.reason),
        why: (m.why as StockMovementRow["why"]) ?? null,
        note: (m.note as string | null) ?? null,
        who: (m.who as string | null) ?? null,
        location: (m.location as string | null) ?? null,
      }));
    },
  };
}

/** The chart arrives snake_cased, like everything else from a function. */
function readAccount(a: Record<string, unknown>): ChartAccount {
  return {
    id: String(a.id), code: String(a.code), name: String(a.name),
    role: (a.role as AccountRole | null) ?? null,
    group: String(a.group), nature: a.nature as AccountNature,
    active: Boolean(a.active),
    branchId: (a.branch_id as string | null) ?? null,
    branch: (a.branch as string | null) ?? null,
  };
}

/** Millimetres off the cheque leaf. */
function readLayout(l: Record<string, unknown>): ChequeLayout {
  return {
    leafWidthMm: num(l.leaf_width_mm), leafHeightMm: num(l.leaf_height_mm),
    dateX: num(l.date_x), dateY: num(l.date_y),
    payeeX: num(l.payee_x), payeeY: num(l.payee_y),
    words1X: num(l.words1_x), words1Y: num(l.words1_y),
    words2X: num(l.words2_x), words2Y: num(l.words2_y),
    figuresX: num(l.figures_x), figuresY: num(l.figures_y),
    fontPt: num(l.font_pt) || 11,
  };
}

/** "There is no session" is the normal signed-out case, not a failure. */
function isNoSession(error: { name?: string; message?: string }): boolean {
  return error.name === "AuthSessionMissingError" || /session|not authenticated/i.test(error.message ?? "");
}

/** The filters go down snake_cased, like every other argument to a function. */
function toFilters(f?: ReportFilters): Record<string, unknown> {
  if (!f) return {};
  const out: Record<string, unknown> = {};
  if (f.branchId) out.branch_id = f.branchId;
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  if (f.asOn) out.as_on = f.asOn;
  if (f.productId) out.product_id = f.productId;
  if (f.customerId) out.customer_id = f.customerId;
  if (f.supplierId) out.supplier_id = f.supplierId;
  if (f.accountId) out.account_id = f.accountId;
  if (f.category) out.category = f.category;
  if (f.top) out.top = f.top;
  return out;
}

function readColumns(v: unknown): ReportColumnOut[] {
  return ((v as Record<string, unknown>[] | null) ?? []).map((c) => ({
    f: String(c.f), l: String(c.l), t: c.t as ReportColumnOut["t"],
    calc: (c.calc as string | null) ?? null, cost: Boolean(c.cost),
  }));
}

function readRows(v: unknown): ReportRow[] {
  return ((v as Record<string, unknown>[] | null) ?? []).map((r) => r as unknown as ReportRow);
}

/**
 * The report envelope. The ROWS are not mapped: their fields are the report's own
 * columns, and renaming them here would mean this file had to know about every report.
 */
function readReport(
  key: string, d: Record<string, unknown>, filters: ReportFilters,
): ReportResult {
  const sections = (d.sections as Record<string, unknown>[] | null) ?? null;
  return {
    key: String(d.key ?? key),
    register: (d.register as ReportRegisterKey) ?? "other",
    title: String(d.title ?? key),
    note: (d.note as string | null) ?? null,
    noteExtra: (d.note_extra as string | null) ?? null,
    dateMode: (d.date_mode as ReportResult["dateMode"]) ?? "range",
    landscape: Boolean(d.landscape),
    columns: readColumns(d.columns),
    rows: readRows(d.rows),
    totals: (d.totals as ReportRow | null) ?? null,
    sections: sections
      ? sections.map((s): ReportSection => ({
          title: String(s.title),
          columns: readColumns(s.columns),
          rows: readRows(s.rows),
          totals: (s.totals as ReportRow | null) ?? null,
          opening: s.opening === undefined || s.opening === null ? null : num(s.opening),
          extra: (s.extra as Record<string, unknown> | null) ?? null,
        }))
      : null,
    pivot: Boolean(d.pivot),
    balanced: d.balanced === undefined || d.balanced === null ? null : Boolean(d.balanced),
    drill: (d.drill as string | null) ?? null,
    opening: d.opening === undefined || d.opening === null ? null : num(d.opening),
    account: (d.account as string | null) ?? null,
    onOrder: d.on_order === undefined || d.on_order === null ? null : num(d.on_order),
    stockValue: d.stock_value === undefined || d.stock_value === null ? null : num(d.stock_value),
    stockOnShelves: d.stock_on_shelves === undefined || d.stock_on_shelves === null
      ? null : num(d.stock_on_shelves),
    stockNoCost: d.stock_no_cost === undefined || d.stock_no_cost === null
      ? null : num(d.stock_no_cost),
    stockAccount: d.stock_account === undefined || d.stock_account === null
      ? null : num(d.stock_account),
    shop: (d.shop as string | null) ?? null,
    branch: (d.branch as string | null) ?? null,
    runAt: String(d.run_at ?? new Date().toISOString()),
    runBy: String(d.run_by ?? ""),
    filters,
  };
}

/**
 * A completed sale, as the receipt the screen prints.
 *
 * One mapper, because two paths produce a sale: the till (`complete_sale`) and billing a
 * delivery note (`bill_challan`, P14a). A second copy is the one that falls behind.
 */
function readReceipt(r: Record<string, unknown>): Receipt {
    const items = (r.items as Record<string, unknown>[]).map((i) => ({
      name: String(i.name), qty: num(i.qty), unitPrice: num(i.unit_price), lineTotal: num(i.line_total),
      warrantyUntil: (i.warranty_until as string | null) ?? null, serials: (i.serials as string[]) ?? [],
      vatPct: num(i.vat_pct), vatAmount: num(i.vat_amount), vatInclusive: i.vat_inclusive !== false,
      listPrice: numOrNull(i.list_price), priceOverridden: Boolean(i.price_overridden),
      isGift: Boolean(i.is_gift),
    }));
    return {
      id: String(r.id), invoiceNo: String(r.invoice_no), createdAt: String(r.created_at),
      staffName: String(r.staff_name), shopName: String(r.shop_name), shopAddress: (r.shop_address as string | null) ?? null,
      branchName: String(r.branch_name ?? ""),
      branchAddress: (r.branch_address as string | null) ?? null,
      branchPhone: (r.branch_phone as string | null) ?? null,
      subtotal: num(r.subtotal), discountPct: num(r.discount_pct), discountAmount: num(r.discount_amount), total: num(r.total),
      vatAmount: num(r.vat_amount),
      chargesAmount: num(r.charges_amount),
      charges: ((r.charges as { name: string; amount: number | string }[] | null) ?? []).map((c) => ({ name: c.name, amount: num(c.amount) })),
      receiptFooter: (r.receipt_footer as string | null) ?? null,
      binVat: (r.bin_vat as string | null) ?? null,
      priceListName: (r.price_list_name as string | null) ?? null,
      customerName: (r.customer_name as string | null) ?? null,
      customerDiscountPct: num(r.customer_discount_pct),
      paymentMethod: r.payment_method as PaymentMethod,
      cashReceived: numOrNull(r.cash_received), changeGiven: numOrNull(r.change_given),
      paymentRef: (r.payment_ref as string | null) ?? null, customerPhone: (r.customer_phone as string | null) ?? null,
      paidAmount: num(r.paid_amount), dueAmount: num(r.due_amount),
      customerOwes: numOrNull(r.customer_owes),
      cardCharge: num(r.card_charge), emiCharge: num(r.emi_charge),
      exchangeValue: num(r.exchange_value),
      emiMonths: numOrNull(r.emi_months),
      emiBank: (r.emi_bank as string | null) ?? null,
      cardType: (r.card_type as string | null) ?? null,
      cardLast4: (r.card_last4 as string | null) ?? null,
      attention: (r.attention as string | null) ?? null,
      customerBin: (r.customer_bin as string | null) ?? null,
      narration: (r.narration as string | null) ?? null,
      soldBy: (r.sold_by as string | null) ?? null,
      extraFields: (r.extra_fields as Record<string, string> | null) ?? null,
      exchange: (r.exchange as Receipt["exchange"]) ?? null,
      payments: ((r.payments as Record<string, unknown>[] | null) ?? []).map((x) => ({
        method: String(x.method), amount: num(x.amount),
        reference: (x.reference as string | null) ?? null,
      })),
      items,
    };
}

/** One quotation, order or challan, with its lines. */
function readSalesDocument(d: Record<string, unknown>): SalesDocument {
  return {
    kind: d.kind as SalesDocument["kind"],
    id: String(d.id), no: String(d.no), date: String(d.date), status: String(d.status),
    branch: String(d.branch), branchId: String(d.branch_id),
    customer: String(d.customer ?? "—"),
    customerId: (d.customer_id as string | null) ?? null,
    phone: (d.phone as string | null) ?? null,
    attention: (d.attention as string | null) ?? null,
    address: (d.address as string | null) ?? null,
    validUntil: (d.valid_until as string | null) ?? null,
    deliveryDate: (d.delivery_date as string | null) ?? null,
    paymentTermsDays: numOrNull(d.payment_terms_days),
    terms: (d.terms as string | null) ?? null,
    note: (d.note as string | null) ?? null,
    carrier: (d.carrier as string | null) ?? null,
    vehicleNo: (d.vehicle_no as string | null) ?? null,
    subtotal: num(d.subtotal), discountPct: num(d.discount_pct),
    discountAmount: num(d.discount_amount), vatAmount: num(d.vat_amount),
    total: num(d.total), advance: num(d.advance),
    advanceWaiting: num(d.advance_waiting),
    quoteNo: (d.quote_no as string | null) ?? null,
    orderNo: (d.order_no as string | null) ?? null,
    orderId: (d.order_id as string | null) ?? null,
    invoiceNo: (d.invoice_no as string | null) ?? null,
    who: String(d.who ?? ""), soldBy: (d.sold_by as string | null) ?? null,
    approvedBy: (d.approved_by as string | null) ?? null,
    lines: ((d.lines as Record<string, unknown>[] | null) ?? []).map((l): SalesDocLine => ({
      id: String(l.id), productId: String(l.product_id), product: String(l.product),
      code: String(l.code), qty: num(l.qty), unitPrice: num(l.unit_price),
      lineDiscount: num(l.line_discount), isFree: Boolean(l.is_free),
      lineTotal: num(l.line_total), note: (l.note as string | null) ?? null,
      isSerial: Boolean(l.is_serial),
      deliveredQty: numOrNull(l.delivered_qty) ?? undefined,
      billedQty: numOrNull(l.billed_qty) ?? undefined,
      pendingQty: numOrNull(l.pending_qty) ?? undefined,
      cancelled: l.cancelled === undefined ? undefined : Boolean(l.cancelled),
      inStock: numOrNull(l.in_stock) ?? undefined,
      returnedQty: numOrNull(l.returned_qty) ?? undefined,
      toBill: numOrNull(l.to_bill) ?? undefined,
      serials: ((l.serials as Record<string, unknown>[] | null) ?? undefined)?.map((x) => ({
        id: String(x.id), serial: String(x.serial), returned: Boolean(x.returned),
      })),
    })),
    challans: ((d.challans as Record<string, unknown>[] | null) ?? []).map((c) => ({
      id: String(c.id), challanNo: String(c.challan_no), date: String(c.date),
      status: String(c.status),
    })),
  };
}

/** An employee row. Pay figures are absent rather than zero when they are not ours. */
function readEmployee(e: Record<string, unknown>): Employee {
  return {
    id: String(e.id), code: (e.code as string | null) ?? null, name: String(e.name),
    phone: (e.phone as string | null) ?? null,
    photoUrl: (e.photo_url as string | null) ?? null,
    address: (e.address as string | null) ?? null,
    nid: (e.nid as string | null) ?? null,
    dateOfBirth: (e.date_of_birth as string | null) ?? null,
    joinedOn: String(e.joined_on),
    branch: (e.branch as string | null) ?? null,
    branchId: (e.branch_id as string | null) ?? null,
    department: (e.department as string | null) ?? null,
    departmentId: (e.department_id as string | null) ?? null,
    designation: (e.designation as string | null) ?? null,
    designationId: (e.designation_id as string | null) ?? null,
    position: (e.position as string | null) ?? null,
    positionId: (e.position_id as string | null) ?? null,
    profession: (e.profession as string | null) ?? null,
    professionId: (e.profession_id as string | null) ?? null,
    emergencyName: (e.emergency_name as string | null) ?? null,
    emergencyPhone: (e.emergency_phone as string | null) ?? null,
    religion: (e.religion as string | null) ?? null,
    nationality: (e.nationality as string | null) ?? null,
    staffId: (e.staff_id as string | null) ?? null,
    login: (e.login as string | null) ?? null,
    active: Boolean(e.active), leftOn: (e.left_on as string | null) ?? null,
    note: (e.note as string | null) ?? null,
    basic: numOrNull(e.basic),
    allowances: (e.allowances as Record<string, number> | null) ?? null,
    dailyRate: numOrNull(e.daily_rate),
    advanceOutstanding: numOrNull(e.advance_outstanding),
    today: (e.today as Employee["today"]) ?? null,
  };
}
