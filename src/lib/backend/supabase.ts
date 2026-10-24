import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyError } from "../sale";
import { supabaseBrowser } from "../supabase/client";
import type {
  ApprovalResult, Approver, BranchAdmin, Category, PaymentMethod, Product, Receipt, Role,
  SaleInput, StaffLookup, StaffMember,
} from "../types";
import { classifyStaffLookup, type CurrentStaffRow } from "./staff-lookup";
import type { Backend } from "./types";

const num = (v: unknown) => (v == null ? 0 : Number(v));
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

    async listProducts(branchId: string): Promise<Product[]> {
      // One call: the database joins this branch's stock and its in-stock serials, so
      // the browser never has to be trusted with which branch it is looking at.
      const { data, error } = await sb.rpc("branch_products", { p_branch_id: branchId });
      if (error) throw loadError("products", error);
      type Row = {
        id: string; code: string; barcode: string | null; name: string; brand: string | null;
        category_id: string | null; price: number | string; warranty_months: number;
        is_serial: boolean; reorder_level: number; stock: number | string;
        serials: { id: string; serial: string }[];
      };
      return ((data as Row[] | null) ?? []).map((r) => ({
        id: r.id, code: r.code, barcode: r.barcode, name: r.name, brand: r.brand,
        categoryId: r.category_id, price: num(r.price), warrantyMonths: r.warranty_months,
        isSerial: r.is_serial, reorderLevel: r.reorder_level, stock: num(r.stock),
        serials: r.serials ?? [],
      }));
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
        p_items: input.lines.map((l) => ({ product_id: l.productId, qty: l.qty, serial_ids: l.serialIds })),
        p_payment_method: input.paymentMethod,
        p_discount_pct: input.discountPct,
        p_approval_id: input.approvalId,
        p_customer_phone: input.customerPhone,
        p_cash_received: input.cashReceived,
        p_payment_ref: input.paymentRef,
      });
      if (error) throw new Error(friendlyError(error.message));
      const r = data as Record<string, unknown>;
      const items = (r.items as Record<string, unknown>[]).map((i) => ({
        name: String(i.name), qty: num(i.qty), unitPrice: num(i.unit_price), lineTotal: num(i.line_total),
        warrantyUntil: (i.warranty_until as string | null) ?? null, serials: (i.serials as string[]) ?? [],
      }));
      return {
        id: String(r.id), invoiceNo: String(r.invoice_no), createdAt: String(r.created_at),
        staffName: String(r.staff_name), shopName: String(r.shop_name), shopAddress: (r.shop_address as string | null) ?? null,
        branchName: String(r.branch_name ?? ""),
        branchAddress: (r.branch_address as string | null) ?? null,
        branchPhone: (r.branch_phone as string | null) ?? null,
        subtotal: num(r.subtotal), discountPct: num(r.discount_pct), discountAmount: num(r.discount_amount), total: num(r.total),
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
  };
}

/** "There is no session" is the normal signed-out case, not a failure. */
function isNoSession(error: { name?: string; message?: string }): boolean {
  return error.name === "AuthSessionMissingError" || /session|not authenticated/i.test(error.message ?? "");
}
