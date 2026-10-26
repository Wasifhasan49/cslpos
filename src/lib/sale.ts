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

/**
 * What a returned quantity is actually worth back, mirroring `refund_for()` in the
 * database so the counter can show the figure before anything is confirmed.
 *
 * A sale's discount was spread over every line, so refunding a line at its shelf price
 * gives back more than the customer handed over — every time there was a discount. VAT
 * that was charged on top comes back too; VAT that was already inside the price does
 * not, because it is inside the figure being refunded already.
 */
export function refundFor(
  line: {
    qty: number; lineTotal: number;
    vatAmount?: number; vatInclusive?: boolean;
  },
  qty: number,
  saleDiscountPct: number,
): number {
  if (qty <= 0 || line.qty <= 0) return 0;
  const share = (line.lineTotal * qty) / line.qty;
  const charged = (share * (100 - saleDiscountPct)) / 100;
  const vatBack = line.vatInclusive === false
    ? ((line.vatAmount ?? 0) * qty) / line.qty
    : 0;
  return Math.round((charged + vatBack) * 100) / 100;
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
  /** How much is going on the customer's slate instead of being paid now (P10). */
  dueAmount?: string;
  /** What the card charge, the EMI charge and an exchange do to the total (P10a). */
  extraCharges?: number;
  exchangeValue?: number;
  /** The card's last four digits, when they were typed into the card panel rather than
   *  the payment reference box. One field, not two. */
  cardLast4?: string | null;
  /** What the counter knows about the buyer, for the credit rules. */
  customer?: {
    name: string | null; creditAllowed?: boolean; creditLimit?: number;
    owed?: number; creditLeft?: number | null;
  } | null;
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

  // What goes on the slate, and what is therefore being handed over now (P10). The
  // database checks all of this again; this is so the counter says it first.
  const payable = totals.total + (s.extraCharges ?? 0) - (s.exchangeValue ?? 0);
  const onDue = Math.min(Math.max(Number(s.dueAmount ?? 0) || 0, 0), payable);
  if (onDue > 0) {
    if (!s.customer) return "Selling on due needs the customer's mobile number";
    if (s.customer.creditAllowed === false) {
      return `${s.customer.name ?? "This customer"} isn't allowed to buy on due`;
    }
    const left = s.customer.creditLeft;
    if (left != null && onDue > left && !s.pinApproved) {
      return `Only ${formatTaka(left)} of their credit limit is left — a manager has to approve the rest`;
    }
  }
  const payingNow = payable - onDue;

  if (payingNow > 0) {
    if (s.method === "cash") {
      const received = parseFloat(s.cashReceived);
      if (Number.isNaN(received) || received < payingNow)
        return `Enter the cash received (at least ${formatTaka(payingNow)})`;
    } else if (s.method === "card") {
      const digits = (s.cardLast4 ?? s.paymentRef).trim();
      if (digits.length < 4) return "Enter the last 4 digits of the card";
    } else if (s.paymentRef.trim().length < 4) {
      return `Enter the ${s.method === "bkash" ? "bKash" : "Nagad"} transaction ID`;
    }
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
  return dhakaDate(now);
}

/**
 * The Dhaka calendar date of a moment.
 *
 * An ISO timestamp's first ten characters are its UTC date, and Dhaka is six hours
 * ahead — so between midnight and 6am local time, slicing the string gives YESTERDAY.
 * A shop open at 1am would see its night's takings land on the wrong day, which is
 * exactly the sort of thing nobody notices until the figures are argued about.
 */
export function dhakaDate(at: string | Date): string {
  const t = typeof at === "string" ? new Date(at) : at;
  return new Date(t.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
  "SALE_NOT_FOUND", "NOT_YOUR_SALE", "VOID_REASON_REQUIRED", "SALE_ALREADY_VOID",
  "VOID_TOO_LATE", "SALE_PARTLY_RETURNED", "BAD_REFUND_METHOD", "SALE_IS_VOID",
  "RETURN_TOO_LATE", "SALE_LINE_NOT_FOUND", "MORE_THAN_SOLD", "SERIAL_NOT_ON_THIS_SALE",
  "CREDIT_NEEDS_CUSTOMER", "BAD_APPROVAL_ACTION", "BAD_APPROVAL_KIND",
  "NOT_AWAITING_APPROVAL",
  "GROUP_NAME_REQUIRED", "GROUP_NOT_FOUND", "DUE_MORE_THAN_TOTAL", "DUE_NEEDS_CUSTOMER",
  "CUSTOMER_HAS_NO_CREDIT", "OVER_CREDIT_LIMIT",
  "EMI_BANK_REQUIRED", "EMI_PLAN_NOT_FOUND", "UNKNOWN_SALE_FIELD", "CARD_TYPE_NOT_FOUND",
  "NO_EMI_PLAN", "EMI_BELOW_MINIMUM", "EMI_NOT_ALLOWED", "EXCHANGE_NEEDS_DESCRIPTION",
  "EXCHANGE_OVER_TOTAL", "SPLIT_DOES_NOT_ADD_UP", "EXCHANGE_NEEDS_PRODUCT",
  "NOTHING_TO_LOOK_UP", "ITEM_REQUIRED", "PROBLEM_REQUIRED", "CLAIM_ALREADY_OPEN",
  "CLAIM_NOT_FOUND", "CLAIM_NOT_APPROVED", "CLAIM_ALREADY_CLOSED", "BAD_CLAIM_STATUS",
  "CLAIM_NEEDS_SUPPLIER", "REJECT_REASON_REQUIRED", "NAME_REQUIRED",
  "BAD_DATE_RANGE", "BAD_DETAIL_KIND",
  // Accounts (P13)
  "ENTRY_DOES_NOT_BALANCE", "NOTHING_TO_POST", "NO_ACCOUNT_FOR", "ENTRY_NOT_FOUND",
  "ENTRY_NOT_POSTED", "ALREADY_REVERSED", "BAD_VOUCHER_KIND", "VOUCHER_NEEDS_TWO_ACCOUNTS",
  "VOUCHER_SAME_ACCOUNT", "JOURNAL_NEEDS_TWO_LINES", "VOUCHER_NEEDS_LINES",
  "VOUCHER_NOT_WAITING", "REASON_REQUIRED", "REVERSAL_REASON_REQUIRED",
  "NOT_INTER_BRANCH", "ALREADY_ACCEPTED", "ACCOUNT_NOT_ALLOWED",
  "ACCOUNT_CODE_REQUIRED", "ONLY_POSTED_ENTRIES_REVERSE",
  "BAD_CHEQUE_RANGE", "BAD_CHEQUE_DIRECTION", "BAD_CHEQUE_STATUS", "CHEQUE_NEEDS_PAYEE",
  "CHEQUE_NEEDS_NUMBER", "CHEQUE_BOOK_NOT_FOUND", "CHEQUE_BOOK_FINISHED",
  "CHEQUE_NOT_FOUND", "CHEQUE_ALREADY_SETTLED", "BOUNCE_REASON_REQUIRED",
  "ONLY_ISSUED_CHEQUES_PRINT",
  // P14: reports, the period lock and export.
  "PERIOD_LOCKED", "MONTH_NOT_FINISHED", "NO_SUCH_REPORT", "NOT_YET",
  "PICK_AN_ACCOUNT", "PICK_A_PRODUCT", "NO_SUCH_PRODUCT",
  "NO_SUCH_DATASET", "NO_SUCH_FIELD", "NO_SUCH_BUILDER", "REPORT_HAS_NO_GROUPING",
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
    case "ACCOUNT_NOT_FOUND":
      return "Pick an account — the one chosen is not one of this shop's.";
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
    case "SALE_NOT_FOUND": return "That sale no longer exists. Search for it again.";
    case "NOT_YOUR_SALE":
      return "That sale was rung up by someone else. Ask a manager to open it.";
    case "VOID_REASON_REQUIRED": return "Say why the sale is being voided.";
    case "SALE_ALREADY_VOID": return "This sale has already been voided.";
    case "VOID_TOO_LATE":
      return "A sale can only be voided on the day it was made. Take it back as a return instead.";
    case "SALE_PARTLY_RETURNED":
      return "Part of this sale has already come back on its own document, so it can't be voided too. Return the rest instead.";
    case "BAD_REFUND_METHOD": return "Pick how the money is going back.";
    case "SALE_IS_VOID": return "This sale was voided, so there is nothing to take back.";
    case "RETURN_TOO_LATE":
      return `This sale is older than the shop's ${detail ?? "return"} day window, so a manager has to approve the return.`;
    case "SALE_LINE_NOT_FOUND": return "That line isn't on this sale. Reload and try again.";
    case "MORE_THAN_SOLD":
      return `More ${detail ?? "of this"} is being returned than was sold. Check what has already come back.`;
    case "SERIAL_NOT_ON_THIS_SALE":
      return `One of the serials isn't on this sale, or has already come back. Check it.`;
    case "CREDIT_NEEDS_CUSTOMER":
      return "Store credit needs a customer to give it to. Take the phone number first, or refund another way.";
    case "BAD_APPROVAL_ACTION": return "Say whether it is being approved or cancelled.";
    case "BAD_APPROVAL_KIND": return "That isn't something that can be approved.";
    case "NOT_AWAITING_APPROVAL":
      return `This isn't waiting for approval. It is ${detail ?? "already decided"}.`;
    case "GROUP_NAME_REQUIRED": return "Give the group a name.";
    case "GROUP_NOT_FOUND": return "That group no longer exists. Reload and try again.";
    case "DUE_MORE_THAN_TOTAL":
      return "More is being left on due than the sale comes to. Check the figures.";
    case "DUE_NEEDS_CUSTOMER":
      return "Selling on due needs a customer. Take their phone number first — it is how the shop will chase it.";
    case "CUSTOMER_HAS_NO_CREDIT":
      return `${detail ?? "This customer"} isn't allowed to buy on due. A manager can allow it on the Customers screen.`;
    case "OVER_CREDIT_LIMIT":
      return detail != null && detail !== ""
        ? `That would take them over their credit limit — only ${detail} of it is left. A manager can approve it.`
        : "That would take them over their credit limit. A manager can approve it.";
    case "EMI_BANK_REQUIRED": return "Say which bank runs this EMI plan.";
    case "EMI_PLAN_NOT_FOUND": return "That EMI plan no longer exists. Reload and try again.";
    case "UNKNOWN_SALE_FIELD":
      return `"${detail ?? "That field"}" isn't one of this shop's extra fields. The owner adds them in Settings.`;
    case "CARD_TYPE_NOT_FOUND": return "Pick which card was used.";
    case "NO_EMI_PLAN":
      return `No bank here runs ${detail ?? "that"}-month EMI. Pick a tenure from the list.`;
    case "EMI_BELOW_MINIMUM":
      return `The bank won't run EMI below ${detail ?? "its minimum"}. Take it as a normal card payment.`;
    case "EMI_NOT_ALLOWED":
      return `${detail ?? "This item"} can't go on EMI. The owner allows it per product or category.`;
    case "EXCHANGE_NEEDS_DESCRIPTION":
      return "Say what is being taken in exchange. A value with nothing attached can't be checked later.";
    case "EXCHANGE_OVER_TOTAL":
      return `An exchange can't be worth more than the sale (${detail ?? "the total"}). Paying the difference out is a purchase, not a sale.`;
    case "EXCHANGE_NEEDS_PRODUCT":
      return "To put the old item on the shelf, say which product it is going in as.";
    case "SPLIT_DOES_NOT_ADD_UP":
      return `The split has to add up to ${detail ?? "what is being paid now"}.`;
    case "NOTHING_TO_LOOK_UP":
      return "Type a serial number, an invoice number or the customer's mobile.";
    case "ITEM_REQUIRED": return "Say what the item is.";
    case "PROBLEM_REQUIRED": return "Say what is wrong with it.";
    case "CLAIM_ALREADY_OPEN":
      return "There is already an open claim on this unit. Open that one instead of starting a second.";
    case "CLAIM_NOT_FOUND": return "That claim no longer exists. Reload and try again.";
    case "CLAIM_NOT_APPROVED":
      return "This claim is waiting for a manager to approve it before it can move.";
    case "CLAIM_ALREADY_CLOSED":
      return `This claim is already ${detail ?? "closed"}.`;
    case "BAD_CLAIM_STATUS": return "That isn't a step a claim can move to.";
    case "CLAIM_NEEDS_SUPPLIER":
      return "Say which supplier it is going to — \"with the supplier\" means nothing without a name.";
    case "REJECT_REASON_REQUIRED":
      return "Say why the claim is being turned down. The customer will ask.";
    case "NAME_REQUIRED": return "Give it a name.";
    case "BAD_DATE_RANGE": return "The end date is before the start date.";
    case "BAD_DETAIL_KIND": return "There is nothing to show behind that figure.";
    // --- Accounts (P13) ---
    case "ENTRY_DOES_NOT_BALANCE":
      return "The two sides don't add up to the same figure. Every entry has to balance.";
    case "NOTHING_TO_POST": return "There is nothing in this entry to post.";
    case "NO_ACCOUNT_FOR":
      return `There is no account set up for ${detail ?? "that"}. Add it in Accounts first.`;
    case "ENTRY_NOT_FOUND": return "That entry no longer exists. Reload and try again.";
    case "ENTRY_NOT_POSTED":
    case "ONLY_POSTED_ENTRIES_REVERSE":
      return "Only an entry that is actually on the books can be reversed.";
    case "ALREADY_REVERSED": return "This entry has already been reversed.";
    case "PERIOD_LOCKED":
      return `${detail ?? "That month"} is closed. The owner has to open it again before `
        + "anything in it can change — Settings → Closing the books.";
    case "MONTH_NOT_FINISHED":
      return "A month can only be closed once it is over.";
    case "NO_SUCH_REPORT":
      return "There is no report by that name. Pick one from the list.";
    case "NOT_YET":
      return detail === "P14a"
        ? "This report comes with quotations, sales orders and challans."
        : detail === "P14c"
          ? "This report comes with sales reps and delivery points."
          : "This report hasn't been built yet.";
    case "PICK_AN_ACCOUNT": return "Pick which account's ledger you want.";
    case "PICK_A_PRODUCT": return "Pick which product you want the history of.";
    case "NO_SUCH_PRODUCT": return "That product isn't in this shop.";
    // The three below mean a report's own configuration is wrong, which is a fault in
    // the app rather than anything the person did. Say so, and name the part at fault.
    case "NO_SUCH_DATASET":
    case "NO_SUCH_FIELD":
    case "NO_SUCH_BUILDER":
    case "REPORT_HAS_NO_GROUPING":
      return `This report is set up wrongly (${detail ?? "unknown field"}). `
        + "It needs fixing in the app, not by you.";
    case "BAD_VOUCHER_KIND": return "That isn't a kind of voucher.";
    case "VOUCHER_NEEDS_TWO_ACCOUNTS":
      return "Pick both accounts: where the money came out of and where it went in.";
    case "VOUCHER_SAME_ACCOUNT":
      return "The money can't come out of and go into the same account.";
    case "JOURNAL_NEEDS_TWO_LINES":
    case "VOUCHER_NEEDS_LINES":
      return "A journal entry needs at least two lines — that is what double entry means.";
    case "VOUCHER_NOT_WAITING": return "This voucher isn't waiting for anybody.";
    case "REVERSAL_REASON_REQUIRED":
      return "Say why. A reversal with no reason is one nobody can explain later.";
    // Shared: reversing an entry, and opening a month that was closed. Both are
    // decisions somebody will be asked about months later.
    case "REASON_REQUIRED":
      return "Say why. Without a reason this is a change nobody can explain later.";
    case "NOT_INTER_BRANCH": return "That entry isn't between two branches.";
    case "ALREADY_ACCEPTED": return "The other branch has already accepted this.";
    case "ACCOUNT_NOT_ALLOWED": return "You haven't been given access to that account.";
    case "ACCOUNT_CODE_REQUIRED": return "Give the account a code.";
    case "BAD_CHEQUE_RANGE":
      return "Check the cheque numbers: the last one has to be after the first.";
    case "BAD_CHEQUE_DIRECTION":
      return "Say whether the cheque was written by the shop or handed to it.";
    case "BAD_CHEQUE_STATUS": return "That isn't something that can happen to a cheque.";
    case "CHEQUE_NEEDS_PAYEE": return "Say who the cheque is written out to.";
    case "CHEQUE_NEEDS_NUMBER":
      return "Type the cheque number, or pick the cheque book to take the next leaf from.";
    case "CHEQUE_BOOK_NOT_FOUND": return "That cheque book no longer exists.";
    case "CHEQUE_BOOK_FINISHED":
      return "That cheque book is finished. Add the new one in Accounts.";
    case "CHEQUE_NOT_FOUND": return "That cheque no longer exists. Reload and try again.";
    case "CHEQUE_ALREADY_SETTLED":
      return `This cheque is already ${detail ?? "settled"}.`;
    case "BOUNCE_REASON_REQUIRED":
      return "Say why it bounced. A month later this is what the argument is about.";
    case "ONLY_ISSUED_CHEQUES_PRINT":
      return "Only a cheque the shop wrote can be printed.";
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
