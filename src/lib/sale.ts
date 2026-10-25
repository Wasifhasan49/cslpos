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
    // A seller may have moved this line's price inside the band the owner allowed.
    subtotal += (line.unitPrice ?? p.price) * line.qty;
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
    // The band is the owner's standing permission. Below it the sale needs a manager,
    // so say so here rather than letting the database refuse it after payment is typed.
    if (line.unitPrice != null && line.unitPrice !== p.price && !s.pinApproved) {
      const min = p.minPrice ?? p.price;
      if (line.unitPrice < min) {
        return `${p.name} can't go below ${formatTaka(min)} without a manager`;
      }
      if (p.maxPrice != null && line.unitPrice > p.maxPrice) {
        return `${p.name} can't go above ${formatTaka(p.maxPrice)} without a manager`;
      }
    }
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
  "BRANCH_REQUIRED", "BRANCH_NOT_ALLOWED", "BRANCH_NOT_FOUND", "BRANCH_NAME_REQUIRED",
  "BAD_BRANCH_CODE", "LAST_BRANCH", "NO_STOCK_LOCATION", "LOCATION_NAME_REQUIRED",
  "LOCATION_NOT_FOUND", "NOT_ALLOWED", "BAD_PERMISSION", "BAD_SETTING_TABLE",
  "BAD_SETTING_FIELD", "NOTHING_TO_SAVE", "SETTING_NOT_FOUND", "BAD_DOCUMENT_NUMBER",
  "NUMBER_GOES_BACKWARDS", "BAD_DISCOUNT_TYPE", "BAD_CATEGORY", "BAD_CHARGE",
  "BAD_PRICE", "BAD_PRICE_BAND", "BAD_PRICE_MODE", "PRODUCT_NAME_REQUIRED",
  "PRODUCT_CODE_REQUIRED", "PRICE_LIST_NOT_FOUND", "PRICE_LIST_NAME_REQUIRED",
  "LAST_PRICE_LIST", "NO_PRODUCTS_PICKED", "CATEGORY_NOT_FOUND", "SAME_CATEGORY",
  "SERIAL_CHANGE_HAS_STOCK", "NOTHING_TO_IMPORT",
  "NOTHING_RECEIVED", "NOTHING_RETURNED", "NOTHING_TO_CORRECT", "NOT_A_STOCK_ITEM",
  "SUPPLIER_NOT_FOUND", "CREDIT_NEEDS_SUPPLIER", "CASH_SUPPLIER_NO_CREDIT",
  "PAYMENT_NEEDS_SUPPLIER", "PAYMENT_METHOD_REQUIRED", "BAD_COST", "GRN_LINE_NOT_FOUND",
  "DUPLICATE_SERIAL_IN_LINE", "SERIAL_ALREADY_KNOWN", "SERIAL_WRONG_LENGTH",
  "SERIAL_WRONG_SHAPE", "SERIAL_COUNT_MISMATCH", "BAD_STOCK_REASON",
  "REASON_NOTE_REQUIRED", "WOULD_GO_NEGATIVE",
  "FEATURE_OFF", "NOTHING_REQUESTED", "REQUISITION_NOT_FOUND", "REQUISITION_LOCKED",
  "REQUISITION_NOT_SUBMITTED", "NO_SELF_APPROVAL", "NOTHING_ORDERED", "PO_NOT_FOUND",
  "PO_LOCKED", "PO_NOT_AWAITING", "PO_NOT_DRAFT", "PO_ALREADY_FINISHED",
  "PO_PARTLY_RECEIVED", "CANCEL_REASON_REQUIRED", "BAD_PO_ACTION", "PO_NOT_RECEIVABLE",
  "PO_LINE_NOT_FOUND", "MORE_THAN_ORDERED", "BAD_PARTY_KIND", "BAD_PAYMENT_AMOUNT",
  "OPENING_DATE_IN_FUTURE", "CUSTOMER_NOT_FOUND", "ACCOUNT_NOT_FOUND",
  "SAME_BRANCH", "TRANSFER_NOT_ALLOWED", "REQUEST_NOT_FOUND", "REQUEST_ALREADY_DECIDED",
  "NOTHING_TO_SEND", "TRANSFER_NOT_FOUND", "TRANSFER_NOT_IN_TRANSIT",
  "TRANSFER_LINE_NOT_FOUND", "MORE_THAN_SENT", "SERIAL_NOT_ON_THIS_TRANSFER",
  "BAD_RESOLUTION", "RESOLUTION_NOTE_REQUIRED", "TRANSFER_NOT_DISPUTED", "SAME_LOCATION",
  "BAD_CASH_AMOUNT", "SHIFT_ALREADY_OPEN", "BAD_CASH_DIRECTION", "BAD_CASH_REASON",
  "EXPENSE_CATEGORY_REQUIRED", "SHIFT_NOT_FOUND", "SHIFT_ALREADY_CLOSED", "NO_OPEN_SHIFT",
] as const;

/** Plain English for each permission, so "you can't do that" says which thing. */
const PERMISSION_WORDS: Record<string, string> = {
  sell: "sell at the counter",
  give_discount: "give a discount",
  change_price: "change a price",
  see_cost: "see cost prices",
  void_sale: "void a sale",
  return_sale: "take a return",
  reprint: "print a receipt again",
  approve: "approve this",
  receive_stock: "receive stock",
  adjust_stock: "adjust stock",
  transfer_stock: "transfer stock",
  view_reports: "see reports",
  export_reports: "print or export reports",
  view_accounts: "see the accounts",
  print_cheques: "print cheques",
  edit_settings: "change settings",
  manage_staff: "manage staff",
};

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
    case "BRANCH_REQUIRED": return "Pick which branch this is for.";
    case "BRANCH_NOT_ALLOWED": return "You aren't set up to work in that branch. Ask the owner.";
    case "BRANCH_NOT_FOUND": return "That branch isn't in this shop.";
    case "BRANCH_NAME_REQUIRED": return "Give the branch a name.";
    case "BAD_BRANCH_CODE": return "A branch code is 1 to 6 capital letters or digits, like MB.";
    case "LAST_BRANCH": return "This is the shop's last branch. Add another one before turning this off.";
    case "NO_STOCK_LOCATION": return `${detail ?? "That branch"} has no stock location yet. Add one in Settings → Branches.`;
    case "LOCATION_NAME_REQUIRED": return "Give the stock location a name.";
    case "LOCATION_NOT_FOUND": return "That stock location isn't in this branch.";
    case "NOT_ALLOWED":
      return `You aren't allowed to ${PERMISSION_WORDS[detail ?? ""] ?? "do that"}. Ask the owner.`;
    case "BAD_PERMISSION": return `"${detail ?? ""}" isn't a permission.`;
    case "BAD_SETTING_TABLE": return "That isn't a setting that can be changed here.";
    case "BAD_SETTING_FIELD": return `"${detail ?? ""}" isn't a field on that setting.`;
    case "NOTHING_TO_SAVE": return "Nothing was changed.";
    case "SETTING_NOT_FOUND": return "That setting no longer exists. Reload and try again.";
    case "BAD_DOCUMENT_NUMBER": return "A document number must be a whole number of 1 or more.";
    case "NUMBER_GOES_BACKWARDS":
      return `Document numbers only go forward. This one is already at ${detail ?? "a higher number"}.`;
    case "BAD_DISCOUNT_TYPE": return "Pick a discount reason from the list.";
    case "BAD_CATEGORY": return "Pick a category from the list.";
    case "BAD_CHARGE": return "That extra charge isn't set up in this shop.";
    case "BAD_PRICE": return "A price can't be less than nothing.";
    case "BAD_PRICE_BAND": return "The lowest price can't be more than the highest.";
    case "BAD_PRICE_MODE": return "Choose whether to set the price, or change it by a percentage or an amount.";
    case "PRODUCT_NAME_REQUIRED": return "Give the product a name.";
    case "PRODUCT_CODE_REQUIRED": return "Give the product a code. It's what a barcode scan looks for.";
    case "PRICE_LIST_NOT_FOUND": return "That price list isn't in this shop.";
    case "PRICE_LIST_NAME_REQUIRED": return "Give the price list a name.";
    case "LAST_PRICE_LIST": return "This is the shop's only price list, so it can't be turned off. Make another one the default first.";
    case "NO_PRODUCTS_PICKED": return "Pick some products first.";
    case "CATEGORY_NOT_FOUND": return "That category isn't in this shop.";
    case "SAME_CATEGORY": return "Pick two different categories to merge.";
    case "NOTHING_TO_IMPORT": return "There are no rows to import.";
    case "NOTHING_RECEIVED": return "Add what came in first.";
    case "NOTHING_RETURNED": return "Pick what is going back first.";
    case "NOTHING_TO_CORRECT": return "A correction has to be up or down by something.";
    case "NOT_A_STOCK_ITEM":
      return `${detail ?? "That"} is a service, so there is no stock to receive or correct.`;
    case "SUPPLIER_NOT_FOUND": return "That supplier isn't in this shop.";
    case "CREDIT_NEEDS_SUPPLIER": return "A credit purchase has to be owed to a supplier. Pick one, or mark it paid in cash.";
    case "CASH_SUPPLIER_NO_CREDIT": return "This supplier is cash only, so they can't be owed anything. Pay now, or give them an account first.";
    case "PAYMENT_NEEDS_SUPPLIER": return "Pick who is being paid.";
    case "PAYMENT_METHOD_REQUIRED": return "Say how they were paid.";
    case "BAD_COST": return "A cost can't be less than nothing.";
    case "GRN_LINE_NOT_FOUND": return "That delivery line no longer exists. Reload and try again.";
    case "DUPLICATE_SERIAL_IN_LINE":
      return `The same serial was scanned twice for ${detail ?? "this item"}. Check the list.`;
    case "SERIAL_ALREADY_KNOWN": return `Serial ${detail ?? ""} is already in the shop.`;
    case "SERIAL_WRONG_LENGTH": return `Serial ${detail ?? ""} is the wrong length for this product. Scan it again.`;
    case "SERIAL_WRONG_SHAPE": return `Serial ${detail ?? ""} doesn't look like this product's serials. Scan it again.`;
    case "SERIAL_COUNT_MISMATCH":
      return `${detail ?? "This product"} is serial tracked, so pick exactly which units to correct.`;
    case "BAD_STOCK_REASON": return "Pick a reason from the list.";
    case "REASON_NOTE_REQUIRED": return 'Say what happened, since the reason is "Other".';
    case "WOULD_GO_NEGATIVE":
      return `That would leave less than nothing of ${detail ?? "this product"}. Check the figure.`;
    case "FEATURE_OFF":
      return "That part of the app is switched off. The owner can turn it on in Settings.";
    case "NOTHING_REQUESTED": return "Add what the branch needs first.";
    case "REQUISITION_NOT_FOUND": return "That request no longer exists. Reload and try again.";
    case "REQUISITION_LOCKED":
      return `This request has already been ${detail ?? "decided"}, so it can't be changed. Start a new one.`;
    case "REQUISITION_NOT_SUBMITTED":
      return `Only a submitted request can be approved or rejected. This one is ${detail ?? "not submitted"}.`;
    case "NO_SELF_APPROVAL": return "Someone else has to approve your own request.";
    case "NOTHING_ORDERED": return "Add what you are ordering first.";
    case "PO_NOT_FOUND": return "That order no longer exists. Reload and try again.";
    case "PO_LOCKED":
      return `This order is ${detail ?? "finished"}, so it can't be changed. Start a new one.`;
    case "PO_NOT_AWAITING":
      return `This order isn't waiting for approval. It is ${detail ?? "already decided"}.`;
    case "PO_NOT_DRAFT":
      return `Only a draft order can be sent. This one is ${detail ?? "already sent"}.`;
    case "PO_ALREADY_FINISHED":
      return `This order is already ${detail ?? "finished"}.`;
    case "PO_PARTLY_RECEIVED":
      return "Some of this order has already arrived, so it can't be cancelled. Close it instead.";
    case "CANCEL_REASON_REQUIRED": return "Say why the order is being cancelled.";
    case "BAD_PO_ACTION": return "That isn't something you can do to an order.";
    case "PO_NOT_RECEIVABLE":
      return `Goods can only be received against a sent order. This one is ${detail ?? "not sent"}.`;
    case "PO_LINE_NOT_FOUND": return "That order line no longer exists. Reload and try again.";
    case "MORE_THAN_ORDERED":
      return `More ${detail ?? "of this"} turned up than was ordered. Change the order first, or receive it as a separate delivery.`;
    case "BAD_PARTY_KIND": return "An opening balance belongs to a customer or a supplier.";
    case "BAD_PAYMENT_AMOUNT": return "Enter how much is being paid.";
    case "OPENING_DATE_IN_FUTURE": return "An opening balance can't be dated in the future.";
    case "CUSTOMER_NOT_FOUND": return "That customer isn't in this shop.";
    case "ACCOUNT_NOT_FOUND": return "Pick which account the money came from.";
    case "SAME_BRANCH": return "Pick a different branch to send to.";
    case "TRANSFER_NOT_ALLOWED":
      return "These two branches aren't allowed to send to each other. The owner sets that up in Settings.";
    case "REQUEST_NOT_FOUND": return "That request no longer exists. Reload and try again.";
    case "REQUEST_ALREADY_DECIDED":
      return `This request has already been ${detail ?? "decided"}.`;
    case "NOTHING_TO_SEND": return "Add what is being sent first.";
    case "TRANSFER_NOT_FOUND": return "That transfer no longer exists. Reload and try again.";
    case "TRANSFER_NOT_IN_TRANSIT":
      return `This transfer is ${detail ?? "finished"}, so there is nothing to receive.`;
    case "TRANSFER_LINE_NOT_FOUND": return "That transfer line no longer exists. Reload and try again.";
    case "MORE_THAN_SENT":
      return `More ${detail ?? "of this"} arrived than was sent. Check the slip against the boxes.`;
    case "SERIAL_NOT_ON_THIS_TRANSFER":
      return `One of the serials scanned for ${detail ?? "this item"} wasn't on this transfer. Check it.`;
    case "BAD_RESOLUTION": return "Say whether the missing goods went back or are written off.";
    case "RESOLUTION_NOTE_REQUIRED": return "Say what happened to the missing goods.";
    case "TRANSFER_NOT_DISPUTED":
      return `There is nothing to settle: this transfer is ${detail ?? "already closed"}.`;
    case "SAME_LOCATION": return "Pick two different places to move between.";
    case "BAD_CASH_AMOUNT": return "Enter how much cash, as a number.";
    case "SHIFT_ALREADY_OPEN": return "Your drawer is already open at this branch.";
    case "BAD_CASH_DIRECTION": return "Say whether the cash went in or out.";
    case "BAD_CASH_REASON": return "Pick why the cash moved.";
    case "EXPENSE_CATEGORY_REQUIRED":
      return "Pick what the money was spent on, so it can be added up later.";
    case "SHIFT_NOT_FOUND": return "That drawer no longer exists. Reload and try again.";
    case "SHIFT_ALREADY_CLOSED": return "This drawer has already been closed.";
    case "NO_OPEN_SHIFT":
      return "Open the drawer before selling. Counter → Open the till, with what is in it now.";
    case "SERIAL_CHANGE_HAS_STOCK":
      return `${detail ?? "This product"} already has stock, so it can't switch between serial-tracked and not. Sell or write off the stock first.`;
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
