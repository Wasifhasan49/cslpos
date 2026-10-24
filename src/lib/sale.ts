// Pure sale rules used by the counter screen. The database (complete_sale)
// enforces the same rules again, so these only exist to give instant feedback.
import type { CartLine, PaymentMethod, Product } from "./types";

export const PAYMENT_METHODS: { id: PaymentMethod; label: string }[] = [
  { id: "cash", label: "Cash" },
  { id: "bkash", label: "bKash" },
  { id: "nagad", label: "Nagad" },
  { id: "card", label: "Card" },
];

export function formatTaka(n: number): string {
  return "৳ " + Math.round(n).toLocaleString("en-IN");
}

/** Same rounding as Postgres round(): half away from zero. */
export function roundTaka(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

export function parseDiscount(raw: string): number {
  const n = parseFloat(raw);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.min(n, 100);
}

export interface Totals {
  itemCount: number;
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  total: number;
}

export function computeTotals(lines: CartLine[], products: Map<string, Product>, discountPct: number): Totals {
  let subtotal = 0;
  let itemCount = 0;
  for (const line of lines) {
    const p = products.get(line.productId);
    if (!p) continue;
    subtotal += p.price * line.qty;
    itemCount += line.qty;
  }
  const discountAmount = roundTaka((subtotal * discountPct) / 100);
  return { itemCount, subtotal, discountPct, discountAmount, total: subtotal - discountAmount };
}

export function isValidPhone(phone: string): boolean {
  return /^01\d{9}$/.test(phone);
}

export interface CheckoutState {
  lines: CartLine[];
  products: Map<string, Product>;
  discountPct: number;
  discountLimitPct: number;
  pinApproved: boolean;
  phone: string;
  method: PaymentMethod;
  cashReceived: string;
  paymentRef: string;
}

/** The first thing stopping the sale, in plain words, or null if it can go through. */
export function saleBlocker(s: CheckoutState): string | null {
  if (s.lines.length === 0) return "Add a product to start";
  for (const line of s.lines) {
    const p = s.products.get(line.productId);
    if (!p) return "A product in this sale no longer exists. Remove it.";
    if (p.isSerial && line.serialIds.length === 0) return `Pick the serial number for ${p.name}`;
    if (line.qty > p.stock) return `Only ${p.stock} of ${p.name} in stock`;
  }
  const totals = computeTotals(s.lines, s.products, s.discountPct);
  if (totals.itemCount === 0) return "Add a product to start";
  if (s.discountPct > s.discountLimitPct && !s.pinApproved)
    return `A discount over ${s.discountLimitPct}% needs the manager PIN`;
  if (s.phone !== "" && !isValidPhone(s.phone)) return "Check the mobile number: 11 digits, starting with 01";
  if (s.method === "cash") {
    const received = parseFloat(s.cashReceived);
    if (Number.isNaN(received) || received < totals.total)
      return `Enter the cash received (at least ${formatTaka(totals.total)})`;
  } else if (s.paymentRef.trim().length < 4) {
    return s.method === "card"
      ? "Enter the last 4 digits of the card"
      : `Enter the ${s.method === "bkash" ? "bKash" : "Nagad"} transaction ID`;
  }
  return null;
}

/** Handy cash buttons: exact, then the next round 500, 1,000 and 5,000. */
export function quickCashAmounts(total: number): number[] {
  if (total <= 0) return [];
  const out: number[] = [];
  for (const v of [total, Math.ceil(total / 500) * 500, Math.ceil(total / 1000) * 1000, Math.ceil(total / 5000) * 5000]) {
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Dhaka "today" as YYYY-MM-DD, independent of the device's timezone. */
export function dhakaToday(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay)); // 31 Jan + 1 month = 28/29 Feb, like Postgres
  return target.toISOString().slice(0, 10);
}

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function warrantyLabel(months: number): string {
  if (!months) return "No warranty";
  if (months % 12 === 0) return `${months / 12} ${months === 12 ? "year" : "years"} warranty`;
  return `${months} months warranty`;
}

/** Search by name, brand, code or barcode. An exact code/barcode match comes first. */
export function searchProducts(products: Product[], query: string, categoryId: string | null): Product[] {
  const q = query.trim().toLowerCase();
  const inCat = categoryId ? products.filter((p) => p.categoryId === categoryId) : products;
  if (!q) return inCat;
  const words = q.split(/\s+/);
  const exact: Product[] = [];
  const rest: Product[] = [];
  for (const p of inCat) {
    if (p.code.toLowerCase() === q || (p.barcode ?? "").toLowerCase() === q) exact.push(p);
    else {
      const hay = `${p.name} ${p.brand ?? ""} ${p.code} ${p.barcode ?? ""}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) rest.push(p);
    }
  }
  return [...exact, ...rest];
}

/**
 * Codes the database can raise. Kept in step with the migrations by a test that greps
 * every `raise exception '<CODE>'` and fails if one has no message here.
 */
export const SALE_ERROR_CODES = [
  "NOT_STAFF", "EMPTY_SALE", "MANAGER_PIN_REQUIRED", "MANAGER_PIN_INVALID",
  "APPROVAL_NOT_VALID", "APPROVER_NOT_FOUND", "APPROVER_HAS_NO_PIN",
  "SERIAL_REQUIRED", "SERIAL_NOT_AVAILABLE", "OUT_OF_STOCK", "CASH_SHORT",
  "PAYMENT_REF_REQUIRED", "BAD_PHONE", "PRODUCT_NOT_FOUND", "BAD_QTY",
  "BAD_DISCOUNT", "BAD_PAYMENT_METHOD", "BAD_PIN", "WEAK_PIN", "NOT_MANAGER",
  "NOT_OWNER", "NO_SELF_EDIT", "STAFF_NOT_FOUND", "LAST_OWNER", "BAD_ROLE", "BAD_LIMIT",
] as const;

/** Split a Postgres error message into its code and the detail after the first colon.
 *  Product names can contain colons, so only the FIRST one separates them. */
function splitCode(raw: string): { code: string; detail: string | null } {
  const m = /([A-Z_]{4,})(?::([\s\S]*))?$/.exec(raw.trim());
  if (!m) return { code: "", detail: null };
  return { code: m[1], detail: m[2] ?? null };
}

/** True when the session ended rather than anything being wrong with the sale. */
export function isSessionExpired(raw: string): boolean {
  return /jwt expired|invalid jwt|token is expired|JWSError|refresh_token_not_found|\b401\b/i.test(raw);
}

/** Turn database error codes into messages the counter staff understand. */
export function friendlyError(raw: string): string {
  // A session that quietly expired mid-sale used to surface as NOT_STAFF, whose message
  // reads "this login isn't set up as staff" — alarming, and wrong.
  if (isSessionExpired(raw)) return "Your session ended. Sign in again — the sale is still here.";

  const { code, detail } = splitCode(raw);
  switch (code) {
    case "NOT_STAFF": return "This login isn't set up as staff for a shop. Ask the owner.";
    case "EMPTY_SALE": return "Add a product to start.";
    case "MANAGER_PIN_REQUIRED": return "This discount needs a manager's approval.";
    case "MANAGER_PIN_INVALID": return "Wrong manager PIN.";
    case "APPROVAL_NOT_VALID": return "That approval has expired or was already used. Ask the manager again.";
    case "APPROVER_NOT_FOUND": return "That manager can't approve discounts. Pick someone else.";
    case "APPROVER_HAS_NO_PIN": return `${detail ?? "That manager"} hasn't set an approval PIN yet.`;
    case "SERIAL_REQUIRED": return `Pick the serial number for ${detail ?? "this item"}.`;
    case "SERIAL_NOT_AVAILABLE": return `That serial for ${detail ?? "this item"} was already sold. Pick another.`;
    case "OUT_OF_STOCK": return `${detail ?? "An item"} is out of stock.`;
    case "CASH_SHORT": return "Cash received is less than the total.";
    case "PAYMENT_REF_REQUIRED": return "Enter the transaction ID.";
    case "BAD_PHONE": return "Check the mobile number.";
    case "PRODUCT_NOT_FOUND": return "A product in this sale no longer exists.";
    case "BAD_QTY": return `Check the quantity for ${detail ?? "this item"}.`;
    case "BAD_DISCOUNT": return "The discount must be between 0 and 100%.";
    case "BAD_PAYMENT_METHOD": return "Pick a payment method.";
    case "BAD_PIN": return "Use 4 to 6 digits.";
    case "WEAK_PIN": return "Pick something harder to guess — not 1234 or 0000.";
    case "NOT_MANAGER": return "Only owners and managers can set an approval PIN.";
    case "NOT_OWNER": return "Only the owner can change what staff are allowed to do.";
    case "NO_SELF_EDIT": return "You can't change your own role or discount limit. Ask another owner.";
    case "STAFF_NOT_FOUND": return "That staff member isn't in this shop.";
    case "LAST_OWNER": return "This is the shop's last owner. Make someone else an owner first.";
    case "BAD_ROLE": return `"${detail ?? ""}" isn't a role. Use owner, manager or cashier.`;
    case "BAD_LIMIT": return "A discount limit must be between 0 and 100.";
    // Keep the raw text so a code we have not seen can still be reported and fixed,
    // instead of everything looking like a network problem.
    default: return `Something went wrong. Tell the owner this: ${raw.trim().slice(0, 120)}`;
  }
}

/** The PIN screen's own messages. friendlyError()'s fallback talks about sales, which
 *  on a settings screen would tell an owner a sale failed. */
export function pinScreenError(raw: string): string {
  if (isSessionExpired(raw)) return "Your session ended. Sign in again.";
  const { code } = splitCode(raw);
  switch (code) {
    case "BAD_PIN": return "Use 4 to 6 digits.";
    case "WEAK_PIN": return "Pick something harder to guess — not 1234 or 0000.";
    case "NOT_MANAGER": return "Only owners and managers can set an approval PIN.";
    case "NOT_STAFF": return "This login isn't linked to a shop. Ask the owner.";
    default: return "Couldn't save the PIN. Check the internet and try again.";
  }
}
