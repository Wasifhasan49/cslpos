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

/** Turn database error codes into messages the counter staff understand. */
export function friendlyError(raw: string): string {
  const [code, detail] = raw.replace(/^.*?([A-Z_]{4,}(?::.*)?)$/, "$1").split(":");
  switch (code) {
    case "NOT_STAFF": return "This login isn't set up as staff for a shop. Ask the owner.";
    case "EMPTY_SALE": return "Add a product to start.";
    case "MANAGER_PIN_REQUIRED": return "This discount needs the manager PIN.";
    case "MANAGER_PIN_INVALID": return "Wrong manager PIN.";
    case "SERIAL_REQUIRED": return `Pick the serial number for ${detail ?? "this item"}.`;
    case "SERIAL_NOT_AVAILABLE": return `That serial for ${detail ?? "this item"} was already sold. Pick another.`;
    case "OUT_OF_STOCK": return `${detail ?? "An item"} is out of stock.`;
    case "CASH_SHORT": return "Cash received is less than the total.";
    case "PAYMENT_REF_REQUIRED": return "Enter the transaction ID.";
    case "BAD_PHONE": return "Check the mobile number.";
    case "PRODUCT_NOT_FOUND": return "A product in this sale no longer exists.";
    default: return "Couldn't complete the sale. Check the internet and try again.";
  }
}
