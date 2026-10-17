import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyError } from "../sale";
import type { Category, PaymentMethod, Product, Receipt, Role, SaleInput, Staff } from "../types";
import type { Backend } from "./types";

let client: SupabaseClient | null = null;
export function supabaseBrowser(): SupabaseClient {
  if (!client) {
    client = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return client;
}

const num = (v: unknown) => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

export function createSupabaseBackend(): Backend {
  const sb = supabaseBrowser();

  return {
    mode: "supabase",

    async currentStaff(): Promise<Staff | null> {
      const { data: auth } = await sb.auth.getUser();
      if (!auth.user) return null;
      const { data, error } = await sb
        .from("staff")
        .select("id, name, role, discount_limit_pct, shop_id")
        .eq("user_id", auth.user.id)
        .eq("active", true)
        .maybeSingle();
      if (error || !data) return null;
      const { data: shop } = await sb.from("shops").select("name").eq("id", data.shop_id).maybeSingle();
      return {
        id: data.id, name: data.name, role: data.role as Role,
        discountLimitPct: num(data.discount_limit_pct), shopName: shop?.name ?? "",
      };
    },

    async listCategories(): Promise<Category[]> {
      const { data, error } = await sb.from("categories").select("id, name").order("sort").order("name");
      if (error) throw new Error("Couldn't load categories. Check the internet.");
      return data ?? [];
    },

    async listProducts(): Promise<Product[]> {
      const [{ data: rows, error }, { data: serials, error: sErr }] = await Promise.all([
        sb.from("products")
          .select("id, code, barcode, name, brand, category_id, price, warranty_months, is_serial, stock")
          .eq("active", true)
          .order("name"),
        sb.from("serials").select("id, serial, product_id").eq("status", "in_stock").order("serial"),
      ]);
      if (error || sErr) throw new Error("Couldn't load products. Check the internet.");
      const byProduct = new Map<string, { id: string; serial: string }[]>();
      for (const s of serials ?? []) {
        const list = byProduct.get(s.product_id) ?? [];
        list.push({ id: s.id, serial: s.serial });
        byProduct.set(s.product_id, list);
      }
      return (rows ?? []).map((r) => ({
        id: r.id, code: r.code, barcode: r.barcode, name: r.name, brand: r.brand, categoryId: r.category_id,
        price: num(r.price), warrantyMonths: r.warranty_months, isSerial: r.is_serial, stock: r.stock,
        serials: byProduct.get(r.id) ?? [],
      }));
    },

    async checkManagerPin() {
      return null; // checked by the database when the sale is saved
    },

    async completeSale(input: SaleInput): Promise<Receipt> {
      const { data, error } = await sb.rpc("complete_sale", {
        p_items: input.lines.map((l) => ({ product_id: l.productId, qty: l.qty, serial_ids: l.serialIds })),
        p_payment_method: input.paymentMethod,
        p_discount_pct: input.discountPct,
        p_manager_pin: input.managerPin,
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
  };
}
