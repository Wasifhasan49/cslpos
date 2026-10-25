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
} from "../types";
import type { ImportKind } from "../import/schema";
import { classifyStaffLookup, type CurrentStaffRow } from "./staff-lookup";
import type { Backend } from "./types";

const num = (v: unknown) => (v == null ? 0 : Number(v));

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
        mrp: number | string | null; min_price: number | string | null; max_price: number | string | null;
        serials: { id: string; serial: string }[];
      };
      return ((data as Row[] | null) ?? []).map((r) => ({
        id: r.id, code: r.code, barcode: r.barcode, name: r.name, brand: r.brand,
        categoryId: r.category_id, price: num(r.price), warrantyMonths: r.warranty_months,
        isSerial: r.is_serial, isInventory: r.is_inventory,
        reorderLevel: r.reorder_level, stock: num(r.stock),
        mrp: numOrNull(r.mrp), minPrice: numOrNull(r.min_price), maxPrice: numOrNull(r.max_price),
        serials: r.serials ?? [],
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
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
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
        items,
      };
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
        "transaction_categories",
      ];
      const [shopRes, featRes, keysRes, roleRes, staffPermRes, docRes, ...listRes] = await Promise.all([
        sb.from("shops").select("name, address, phone, email, logo_url, bin_vat, receipt_footer, invoice_prefix, currency, ait_pct, po_approval_limit, cash_short_limit").limit(1).maybeSingle(),
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
          cashShortLimit: num(shop.cash_short_limit),
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
      const r = data as { changes?: { product_id: string; name: string; from: number | string; to: number | string }[] };
      return (r.changes ?? []).map((c) => ({
        productId: c.product_id, name: c.name, from: num(c.from), to: num(c.to),
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

/** "There is no session" is the normal signed-out case, not a failure. */
function isNoSession(error: { name?: string; message?: string }): boolean {
  return error.name === "AuthSessionMissingError" || /session|not authenticated/i.test(error.message ?? "");
}
