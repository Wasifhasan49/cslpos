/**
 * THE REPORT CATALOGUE — one entry per report.
 *
 * docs/BMS_REPORTS.md is the checklist this file answers: every report BMS prints,
 * with the columns, the grouping and the totals it showed, minus BMS's own bugs
 * (section 3 of that file). The IDs are BMS's: P = purchase register, S = sales,
 * ST = stock, A = accounts, T = transfer, R = the registers BMS keeps elsewhere.
 *
 * WHY A CATALOGUE AND NOT 110 QUERIES
 * Nearly every report here is the same shape: take a list of lines, group it two or
 * three deep, and total the money and quantity columns at each level. So the database
 * has ONE engine (`report_run()`) that does exactly that, and a report is a row of
 * configuration: which dataset, which grouping, which columns. Adding a report is
 * adding an entry here. The handful that are genuinely a different shape — the trial
 * balance, the balance sheet, the day book, a product's ledger — name a `special`
 * builder instead.
 *
 * WHY THE CATALOGUE LIVES IN TYPESCRIPT
 * Two things need it: the screen (titles, columns, which filters to offer) and the
 * database engine. Rather than keep two copies that can drift, this file is the
 * source and `scripts/gen-reports.mts` writes the database seed from it — the same
 * arrangement as the Bangladesh area list. Re-run the generator; never hand-edit the
 * generated migration.
 *
 * THE FIELD NAMES are the columns of the datasets (views) in the reports migration.
 * The engine refuses a field a dataset does not have, so a typo here fails loudly
 * with the name rather than producing a silently empty report.
 */

export type ReportRegister =
  | "sales" | "purchase" | "stock" | "accounts" | "transfer" | "other";

/** How a report is filtered by time. */
export type ReportDateMode =
  /** Date from / date to, e.g. a sales register. */
  | "range"
  /** One "as on" date, e.g. stock or a due list: a range makes no sense. */
  | "as_on"
  /** Not time-based at all, e.g. the chart of accounts. */
  | "none";

export type ReportColumnKind =
  | "text" | "date" | "qty" | "money" | "pct" | "num";

export interface ReportColumn {
  /** The dataset's column name. */
  f: string;
  /** What the heading says. An owner can rename it (report settings). */
  l: string;
  t: ReportColumnKind;
  /**
   * Worked out AFTER the totals, not summed. A percentage or an average has to be
   * recomputed at every subtotal level: BMS sums the percentage column and prints
   * numbers like 480%.
   */
  calc?: "profit_pct" | "margin_pct" | "avg_price" | "avg_cost" | "average";
  /** A cost or profit figure: the whole report needs the see_cost permission. */
  cost?: boolean;
}

export interface ReportDef {
  /** BMS's ID, and our key: "S-1", "ST-12", "A-8". */
  key: string;
  register: ReportRegister;
  /** Where it sits in its register's list. BMS calls it "Report SL"; the owner can
   *  change it, which is BMS's "Report Sort". */
  sl: number;
  title: string;
  /** One line under the title, in plain English, saying what the report answers. */
  note?: string;
  /** Which dataset the rows come from (a view or a function in the migration). */
  dataset?: string;
  /** Grouping, outermost first. The LAST entry is the detail row, so a flat list is
   *  one group. Every level gets a subtotal, for free, from GROUP BY ROLLUP. */
  groupBy?: string[];
  columns?: ReportColumn[];
  /** Rows × one column per thing, instead of a list: BMS's cross-tabs. */
  pivot?: { row: string; col: string; value: string };
  /** A hand-written builder in the database, for the reports that are not a grouped
   *  list: the trial balance, the balance sheet, a ledger, the day book. */
  special?: string;
  dateMode?: ReportDateMode;
  /** Needs the see_cost permission, because it shows cost or profit. BMS's answer to
   *  this was a second copy of the report "without price"; ours is the permission,
   *  plus a without-price twin where BMS had one (P-18, P-19). */
  needsCost?: boolean;
  /** Arrives with a later prompt, and says so on screen rather than being missing. */
  needs?: "P14a" | "P14c" | "later";
  /** Wide reports print sideways. */
  landscape?: boolean;
  /** Rows this report always limits itself to, as column = value. The engine quotes
   *  the value as a literal; it never takes SQL. */
  filter?: Record<string, string>;
  /** Sort the detail rows by this field, biggest first (e.g. top sellers). */
  sortDesc?: string;
  /** Only the first N detail rows (top sellers). */
  topDefault?: number;
}

// Column shorthands, so a report really is three lines of configuration.
const T = (f: string, l: string): ReportColumn => ({ f, l, t: "text" });
const DT = (f: string, l: string): ReportColumn => ({ f, l, t: "date" });
const Q = (f: string, l: string): ReportColumn => ({ f, l, t: "qty" });
const M = (f: string, l: string): ReportColumn => ({ f, l, t: "money" });
const C = (f: string, l: string): ReportColumn => ({ f, l, t: "money", cost: true });
/** A number that must be AVERAGED at every subtotal, never added: a day count. Add
 *  three ages of 10, 20 and 30 days and you get "60 days old", which is nonsense. */
const N = (f: string, l: string): ReportColumn => ({ f, l, t: "num", calc: "average" });
const PCT = (f: string, l: string, calc: ReportColumn["calc"]): ReportColumn =>
  ({ f, l, t: "pct", calc, cost: true });
const AVG = (f: string, l: string, calc: ReportColumn["calc"]): ReportColumn =>
  ({ f, l, t: "money", calc, cost: calc === "avg_cost" });

/** The product columns almost every product report starts with. */
const PRODUCT = [T("category", "Product Group"), T("brand", "Brand"), T("product", "Product Description")];

/**
 * PURCHASE REGISTER (docs/BMS_REPORTS.md section 5).
 *
 * "MRR" in BMS means Material Receiving Report, which is our GRN. BMS prints two of
 * these without any money columns at all (P-18, P-19) so that staff who may not see
 * cost can still check a delivery; we keep both, and everything with a cost column
 * needs the see_cost permission on top.
 */
const PURCHASE: ReportDef[] = [
  { key: "P-1", register: "purchase", sl: 1, title: "Purchases by date",
    dataset: "purchase_lines", groupBy: ["d", "invoice_no"], dateMode: "range", needsCost: true,
    columns: [DT("d", "Date"), T("invoice_no", "Purchase No"), T("supplier", "Supplier Name"),
              T("ref_no", "Ref. No."), Q("qty", "Qty"), C("amount", "Amount")] },
  { key: "P-2", register: "purchase", sl: 2, title: "Purchases by supplier",
    dataset: "purchase_lines", groupBy: ["supplier", "d", "invoice_no"], dateMode: "range", needsCost: true,
    columns: [T("supplier", "Supplier Name"), DT("d", "Date"), T("invoice_no", "Purchase No"),
              T("product", "Product Description"), Q("qty", "Qty"), AVG("unit_cost", "Unit Cost", "avg_cost"),
              C("amount", "Amount")] },
  { key: "P-3", register: "purchase", sl: 3, title: "Returns to supplier, by supplier",
    dataset: "supplier_return_lines", groupBy: ["supplier", "d", "invoice_no"], dateMode: "range", needsCost: true,
    columns: [T("supplier", "Supplier Name"), DT("d", "Date"), T("invoice_no", "Return No"),
              T("product", "Product Description"), Q("qty", "Qty"), C("amount", "Amount")] },
  { key: "P-4", register: "purchase", sl: 4, title: "Returns to supplier, by date",
    dataset: "supplier_return_lines", groupBy: ["d", "invoice_no"], dateMode: "range", needsCost: true,
    columns: [DT("d", "Date"), T("invoice_no", "Return No"), T("supplier", "Supplier Name"),
              Q("qty", "Qty"), C("amount", "Amount")] },
  { key: "P-5", register: "purchase", sl: 5, title: "Purchases by product",
    dataset: "purchase_lines", groupBy: ["category", "brand", "product", "d"], dateMode: "range", needsCost: true,
    columns: [...PRODUCT, DT("d", "Date"), T("invoice_no", "Purchase No"), T("supplier", "Supplier Name"),
              Q("qty", "Qty"), AVG("unit_cost", "Unit Cost", "avg_cost"), C("amount", "Amount")] },
  { key: "P-6", register: "purchase", sl: 6, title: "Returns to supplier, by product",
    dataset: "supplier_return_lines", groupBy: ["category", "brand", "product"], dateMode: "range", needsCost: true,
    columns: [...PRODUCT, Q("qty", "Qty"), C("amount", "Amount")] },
  { key: "P-7", register: "purchase", sl: 7, title: "Requests not yet on an order",
    note: "What a branch asked for that nobody has ordered yet.",
    dataset: "requisition_lines", groupBy: ["d", "req_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("req_no", "Requisition No"), T("category", "Product Group"),
              T("product", "Product Description"), Q("pending_po_qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-8", register: "purchase", sl: 8, title: "Requests not yet received",
    dataset: "requisition_lines", groupBy: ["d", "req_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("req_no", "Requisition No"), T("category", "Product Group"),
              T("product", "Product Description"), Q("pending_qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-9", register: "purchase", sl: 9, title: "Orders still waiting for goods",
    note: "Pending is ordered minus received, so a part delivery leaves only the rest.",
    dataset: "po_lines", groupBy: ["d", "order_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("order_no", "Purchase Order No."), T("supplier", "Supplier Name"),
              T("product", "Product Description"), Q("pending_qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-10", register: "purchase", sl: 10, title: "Requests by date",
    dataset: "requisition_lines", groupBy: ["d", "req_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("req_no", "Requisition No"), T("category", "Product Group"),
              T("product", "Product Description"), Q("qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-11", register: "purchase", sl: 11, title: "Orders by date",
    dataset: "po_lines", groupBy: ["d", "order_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("order_no", "Order No"), T("req_no", "Requisition No"),
              T("category", "Product Group"), T("product", "Product Description"),
              Q("qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-12", register: "purchase", sl: 12, title: "Requests not yet on an order, by product",
    dataset: "requisition_lines", groupBy: ["category", "product"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"),
              T("req_no", "Requisition No"), DT("d", "Requisition Date"), T("code", "Product Code"),
              Q("pending_po_qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-13", register: "purchase", sl: 13, title: "Requests not yet received, by product",
    dataset: "requisition_lines", groupBy: ["category", "product"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"),
              T("req_no", "Requisition No"), DT("d", "Requisition Date"), T("code", "Product Code"),
              Q("pending_qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-14", register: "purchase", sl: 14, title: "Orders still waiting for goods, by product",
    dataset: "po_lines", groupBy: ["category", "product"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"),
              T("order_no", "Order No"), DT("d", "Order Date"), T("req_no", "Requisition No"),
              T("supplier", "Supplier Name"), Q("pending_qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-15", register: "purchase", sl: 15, title: "Requests by product",
    dataset: "requisition_lines", groupBy: ["category", "product"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"),
              T("req_no", "Requisition No"), DT("d", "Requisition Date"), T("code", "Product Code"),
              Q("qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-16", register: "purchase", sl: 16, title: "Orders by product",
    dataset: "po_lines", groupBy: ["category", "product"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"),
              T("order_no", "Order No"), DT("d", "Order Date"), T("req_no", "Requisition No"),
              T("supplier", "Supplier Name"), Q("qty", "Quantity"), T("uom", "Unit")] },
  { key: "P-17", register: "purchase", sl: 17, title: "Biggest buys of the period",
    note: "Products by what the shop spent on them, most first.",
    dataset: "purchase_lines", groupBy: ["product"], dateMode: "range", needsCost: true,
    sortDesc: "amount",
    columns: [T("product", "Product Description"), T("code", "Product Code"),
              Q("qty", "Qty"), C("amount", "Purchase Amount")] },
  { key: "P-18", register: "purchase", sl: 18, title: "Deliveries by supplier (no prices)",
    note: "For checking what arrived. No money columns at all, so anyone may read it.",
    dataset: "purchase_lines", groupBy: ["supplier", "d", "invoice_no"], dateMode: "range",
    columns: [T("supplier", "Supplier Name"), DT("d", "Date"), T("invoice_no", "Invoice No"),
              T("ref_no", "Ref. No."), T("product", "Product Description"),
              Q("qty", "Qty"), T("uom", "UoM")] },
  { key: "P-19", register: "purchase", sl: 19, title: "Deliveries by product (no prices)",
    dataset: "purchase_lines", groupBy: ["category", "product"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"),
              DT("d", "Date"), T("invoice_no", "Invoice No"), T("supplier", "Supplier Name"),
              Q("qty", "Qty"), T("uom", "UoM")] },
  { key: "P-20", register: "purchase", sl: 20, title: "Net purchases by place",
    dataset: "net_purchase", groupBy: ["location", "category", "product"], dateMode: "range",
    needsCost: true, landscape: true,
    columns: [T("location", "Store"), T("category", "Product Group"), T("product", "Product Description"),
              Q("purchase_qty", "Purchase Qty"), C("purchase_amount", "Purchase Amount"),
              Q("return_qty", "Return Qty"), C("return_amount", "Return Amount"),
              Q("net_qty", "Net Qty"), C("net_amount", "Net Purchase Amount")] },
  { key: "P-21", register: "purchase", sl: 21, title: "Net purchases by product",
    note: "Bought, returned, and what that leaves. The figure a buyer argues from.",
    dataset: "net_purchase", groupBy: ["category", "brand", "product"], dateMode: "range",
    needsCost: true, landscape: true,
    columns: [...PRODUCT, Q("purchase_qty", "Purchase Qty"), AVG("unit_cost", "Unit Cost", "avg_cost"),
              C("purchase_amount", "Purchase Amount"), Q("return_qty", "Return Qty"),
              C("return_amount", "Return Amount"), Q("net_qty", "Net Qty"),
              C("net_amount", "Net Purchase Amount")] },
  { key: "P-22", register: "purchase", sl: 22, title: "Supplier statement", special: "supplier_statement",
    note: "Opening, bought, returned, paid, closing — one row per supplier. A cash purchase shows the same figure as bought and as paid.",
    dateMode: "range", needsCost: true, landscape: true },
  { key: "P-23", register: "purchase", sl: 23, title: "Purchases by supplier and product",
    dataset: "purchase_lines", groupBy: ["invoice_no", "product"], dateMode: "range",
    needsCost: true, landscape: true,
    columns: [DT("d", "Date"), T("invoice_no", "Purchase No."), T("supplier", "Supplier Name"),
              T("category", "Product Group"), T("brand", "Product Brand"),
              T("product", "Product Description"), Q("qty", "Qty"),
              AVG("unit_cost", "Unit Price", "avg_cost"), C("amount", "Total Amount")] },
  { key: "P-24", register: "purchase", sl: 24, title: "What happened to each delivery",
    special: "purchase_movement", dateMode: "range", needsCost: true, landscape: true,
    note: "One block per delivery line: how many came in, how many of THOSE have sold, what is left, and the profit on them." },
  { key: "P-25", register: "purchase", sl: 25, title: "Cost corrections and rebates",
    note: "Every delivery cost changed after the goods arrived, with who changed it.",
    dataset: "amendments", groupBy: ["d", "invoice_no"], dateMode: "range", needsCost: true,
    columns: [DT("d", "Date"), T("invoice_no", "Invoice No"), T("supplier", "Supplier Name"),
              T("product", "Product Description"), Q("qty", "Quantity"),
              C("rebate", "Rebate"), C("amount", "Amount"), T("who", "Changed by")] },
];

/**
 * SALES REGISTER (docs/BMS_REPORTS.md section 6).
 *
 * Three BMS faults are fixed here rather than copied. Its SR reports silently drop
 * every sale with no sales rep against it — about a third of the sample day — so ours
 * use `sold_by`, which is always set. Its "Top Sales" prints in alphabetical order,
 * which makes it not a top-sellers report at all; ours sorts by amount. And its "not
 * sold" list includes 1,636 products the shop does not even stock; ours lists what is
 * ON THE SHELF and not selling, which is the only version an owner can act on.
 */
const SALES: ReportDef[] = [
  { key: "S-1", register: "sales", sl: 1, title: "Sales by date",
    note: "Every invoice, grouped by day and by how it was paid for.",
    dataset: "sale_docs", groupBy: ["d", "bill_type", "invoice_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("bill_type", "Bill Type"), T("invoice_no", "Invoice No"),
              T("ref_no", "Ref No"), T("trader", "Trader Name"), T("entered_by", "Entered by"),
              M("total_amt", "Total Amt"), M("discount", "Discount"), M("charges", "Ex. Char."),
              M("vat", "VAT"), M("amount", "Amount")] },
  { key: "S-2", register: "sales", sl: 2, title: "Sales by product",
    note: "Including which delivery each unit came from, so a faulty batch can be traced back to its supplier.",
    dataset: "sale_lines", groupBy: ["category", "product", "d"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"), DT("d", "Date"),
              T("invoice_no", "Invoice No"), T("trader", "Customer Name"),
              T("purchase_invoice", "Purchase Invoice"), T("ref_no", "Ref. No."),
              Q("qty", "Qty"), AVG("unit_price", "Unit Price", "avg_price"), M("amount", "Amount")] },
  { key: "S-3", register: "sales", sl: 3, title: "Sales by customer",
    dataset: "sale_lines", groupBy: ["trader", "d", "invoice_no"], dateMode: "range",
    columns: [T("trader", "Customer Name"), DT("d", "Date"), T("invoice_no", "Invoice No"),
              T("product", "Product Description"), Q("qty", "Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("discount", "Discount"),
              AVG("net_unit_price", "Net Unit Price", "avg_price"), M("amount", "Amount")] },
  { key: "S-4", register: "sales", sl: 4, title: "Net sales by product",
    note: "Sold, returned, and what that leaves. Returns belong next to the sales they undo.",
    dataset: "net_sales", groupBy: ["category", "brand", "product"], dateMode: "range", landscape: true,
    columns: [...PRODUCT, Q("sale_qty", "Sale Qty"), AVG("unit_price", "Unit Price", "avg_price"),
              M("sale_amount", "Sales Amount"), Q("return_qty", "Return Qty"),
              M("return_amount", "Return Amount"), Q("net_qty", "Net Qty"), M("net_amount", "Net Amount")] },
  { key: "S-5", register: "sales", sl: 5, title: "Net sales by customer and product",
    dataset: "net_sales", groupBy: ["trader", "product"], dateMode: "range", landscape: true,
    columns: [T("trader", "Customer Name"), T("product", "Product Description"),
              Q("sale_qty", "Sales Qty"), AVG("unit_price", "Unit Price", "avg_price"),
              M("sale_amount", "Sales Amount"), Q("return_qty", "Return Qty"),
              M("return_amount", "Return Amount"), Q("net_qty", "Net Qty"), M("net_amount", "Net Amount")] },
  { key: "S-6", register: "sales", sl: 6, title: "Gross profit by date",
    note: "Cost is the weighted average captured when the sale happened, not today's — otherwise a later, dearer delivery rewrites last month's profit.",
    dataset: "sale_docs", groupBy: ["d", "invoice_no"], dateMode: "range", needsCost: true, landscape: true,
    columns: [DT("d", "Date"), T("invoice_no", "Invoice No"), T("trader", "Trader Name"),
              M("total_amt", "Total Amount"), M("discount", "Discount"), M("charges", "Extra Charges"),
              M("ait", "AIT"), M("vat", "VAT"), M("amount", "Net Payable Amount"),
              C("cost", "Total Cost"), C("profit", "Gross Profit"),
              PCT("profit_pct", "Profit %", "profit_pct")] },
  { key: "S-7", register: "sales", sl: 7, title: "Gross profit by product",
    dataset: "sale_lines", groupBy: ["category", "product"], dateMode: "range", needsCost: true,
    columns: [T("category", "Product Group"), T("product", "Product Description"), Q("qty", "Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("amount", "Total Price"),
              AVG("unit_cost", "Unit Cost", "avg_cost"), C("cost", "Total Cost"),
              C("profit", "Gross Profit"), PCT("profit_pct", "Profit %", "profit_pct")] },
  { key: "S-8", register: "sales", sl: 8, title: "Returns by date",
    dataset: "return_lines", groupBy: ["d", "return_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("return_no", "Return No"), T("invoice_no", "Invoice No"),
              T("trader", "Customer Name"), T("reason", "Reason"), Q("qty", "Qty"), M("amount", "Total Price")] },
  { key: "S-9", register: "sales", sl: 9, title: "Returns by product",
    dataset: "return_lines", groupBy: ["category", "product"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"),
              T("invoice_no", "Invoice No"), T("trader", "Customer Name"), Q("qty", "Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("amount", "Total Price")] },
  { key: "S-10", register: "sales", sl: 10, title: "Returns by customer",
    dataset: "return_lines", groupBy: ["trader", "return_no"], dateMode: "range",
    columns: [T("trader", "Customer Name"), T("return_no", "Return No"),
              T("product", "Product Description"), Q("qty", "Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("amount", "Total Price")] },
  { key: "S-11", register: "sales", sl: 11, title: "Sales by sales rep",
    note: "Every sale counts towards somebody: one with no rep against it belongs to whoever made it, so these totals add up to the day's takings. BMS drops those invoices.",
    dataset: "sale_docs", groupBy: ["rep", "d", "invoice_no"], dateMode: "range",
    columns: [T("rep", "SR Name"), DT("d", "Date"), T("invoice_no", "Invoice No"),
              T("trader", "Customer Name"), M("total_amt", "Total Amount"), M("discount", "Discount"),
              M("charges", "Extra Charges"), M("ait", "AIT"), M("vat", "VAT"), M("amount", "Net Amount")] },
  { key: "S-12", register: "sales", sl: 12, title: "Net sales by sales rep",
    dataset: "net_sales", groupBy: ["rep"], dateMode: "range",
    columns: [T("rep", "SR Name"), Q("sale_qty", "Sales Qty"), Q("return_qty", "Return Qty"),
              M("sale_amount", "Sales Amount"), M("return_amount", "Sales Return Amount"),
              M("net_amount", "Net Sales Amount")] },
  { key: "S-13", register: "sales", sl: 13, title: "Net sales by rep, customer and product",
    dataset: "net_sales", groupBy: ["rep", "trader", "category", "product"], dateMode: "range", landscape: true,
    columns: [T("rep", "SR Name"), T("trader", "Customer Name"), T("category", "Product Group"),
              T("product", "Product Description"), Q("sale_qty", "Sale Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("sale_amount", "Sales Amount"),
              Q("return_qty", "Return Qty"), M("return_amount", "Return Amount"),
              Q("net_qty", "Net Qty"), M("net_amount", "Net Amount")] },
  { key: "S-14", register: "sales", sl: 14, title: "Gross profit by sales rep",
    dataset: "sale_docs", groupBy: ["rep", "d", "invoice_no"], dateMode: "range", needsCost: true, landscape: true,
    columns: [T("rep", "SR Name"), DT("d", "Date"), T("invoice_no", "Invoice No"),
              T("trader", "Customer Name"), M("total_amt", "Total Amount"), M("discount", "Discount"),
              M("charges", "Extra Charges"), M("vat", "VAT"), M("amount", "Amount"),
              C("cost", "Total Cost"), C("profit", "Gross Profit")] },
  { key: "S-15", register: "sales", sl: 15, title: "Sales by product, line by line",
    note: "The same as sales by product, but never summarised: one row per sale line.",
    dataset: "sale_lines", groupBy: ["category", "product", "invoice_no"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"),
              T("invoice_no", "Invoice No"), DT("d", "Date"), T("trader", "Customer Name"),
              T("purchase_invoice", "Purchase Invoice"), T("serials", "Serial"),
              Q("qty", "Qty"), AVG("unit_price", "Unit Price", "avg_price"), M("amount", "Amount")] },
  { key: "S-16", register: "sales", sl: 16, title: "Customer statement", special: "trader_statement",
    note: "One row per trader: opening, sales, returns, payments, closing. A trader who both buys from and sells to the shop appears once, with both sides.",
    dateMode: "range", landscape: true },
  { key: "S-17", register: "sales", sl: 17, title: "Sales by branch",
    dataset: "sale_docs", groupBy: ["branch", "d", "invoice_no"], dateMode: "range",
    columns: [T("branch", "Branch"), DT("d", "Date"), T("invoice_no", "Invoice No"),
              T("trader", "Customer Name"), M("total_amt", "Total Amount"), M("discount", "Discount"),
              M("charges", "Extra Charges"), M("vat", "VAT"), M("amount", "Amount")] },
  { key: "S-18", register: "sales", sl: 18, title: "Net sales by rep and product",
    dataset: "net_sales", groupBy: ["rep", "category", "product"], dateMode: "range", landscape: true,
    columns: [T("rep", "SR Name"), T("category", "Product Group"), T("product", "Product Description"),
              Q("sale_qty", "Sale Qty"), AVG("unit_price", "Unit Price", "avg_price"),
              M("sale_amount", "Sales Amount"), Q("return_qty", "Return Qty"),
              M("return_amount", "Return Amount"), Q("net_qty", "Net Qty"), M("net_amount", "Net Amount")] },
  { key: "S-19", register: "sales", sl: 19, title: "Rebates by date",
    note: "Money given back after a sale. Until the store says otherwise this is the supplier-rebate side of P-25; a customer rebate is a discount or a return.",
    dataset: "amendments", groupBy: ["d", "invoice_no"], dateMode: "range", needsCost: true,
    columns: [DT("d", "Date"), T("invoice_no", "Invoice No"), T("supplier", "Trader Name"),
              T("product", "Product Description"), C("rebate", "Rebate")] },
  { key: "S-20", register: "sales", sl: 20, title: "Sales by product and branch",
    dataset: "sale_lines", groupBy: ["branch", "category", "product", "invoice_no"],
    dateMode: "range", needsCost: true, landscape: true,
    columns: [T("branch", "Branch"), T("category", "Product Group"), T("product", "Product Description"),
              T("invoice_no", "Invoice No"), T("trader", "Customer Name"), Q("qty", "Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("discount", "Discount"),
              AVG("net_unit_price", "Net Unit Price", "avg_price"), M("amount", "Amount"),
              C("profit", "Profit")] },
  { key: "S-27", register: "sales", sl: 27, title: "On the shelf and not selling",
    note: "Products in stock with no sale in the period, oldest first, valued at cost. BMS lists every product it has ever heard of, including ones the shop does not stock, which is 39 pages nobody reads.",
    dataset: "dusty", groupBy: ["category", "product"], dateMode: "range", needsCost: true,
    columns: [T("category", "Product Group"), T("model", "Model No"), T("product", "Product Description"),
              Q("qty", "Qty"), C("stock_value", "Stock Value"), N("days_since_sale", "Days since last sale")] },
  { key: "S-28", register: "sales", sl: 28, title: "Top sellers",
    note: "By amount, biggest first. BMS prints this alphabetically, which is not a top-sellers report.",
    dataset: "sale_lines", groupBy: ["product"], dateMode: "range", sortDesc: "amount", topDefault: 50,
    columns: [T("model", "Model No"), T("product", "Product Description"), Q("qty", "Qty"), M("amount", "Amount")] },
  { key: "S-30", register: "sales", sl: 30, title: "Net sales by product group",
    dataset: "net_sales", groupBy: ["brand", "category"], dateMode: "range", landscape: true,
    columns: [T("brand", "Product Brand"), T("category", "Product Group"), Q("sale_qty", "Sale Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("sale_amount", "Sales Amount"),
              Q("return_qty", "Return Qty"), M("return_amount", "Return Amount"),
              Q("net_qty", "Net Qty"), M("net_amount", "Net Amount")] },
  { key: "S-31", register: "sales", sl: 31, title: "Sales summary by product",
    dataset: "sale_lines", groupBy: ["d", "invoice_no", "product"], dateMode: "range",
    columns: [DT("d", "Date"), T("invoice_no", "Invoice No"), T("trader", "Customer"),
              T("model", "Product Model"), Q("qty", "Qty"), AVG("unit_price", "Unit Price", "avg_price"),
              M("discount", "Discount"), AVG("net_unit_price", "Net Unit Price", "avg_price"),
              M("amount", "Amount")] },
  { key: "S-32", register: "sales", sl: 32, title: "Every bill of the period", special: "bill_book",
    note: "Each invoice printed as a small bill, in date order — what BMS's day-end print-out is for.",
    dateMode: "range" },
  { key: "S-34", register: "sales", sl: 34, title: "Quantity sold, branch by branch",
    dataset: "sale_lines", pivot: { row: "product", col: "branch", value: "qty" }, dateMode: "range", landscape: true },
  { key: "S-38", register: "sales", sl: 38, title: "Quantity sold by product group, customer by customer",
    dataset: "sale_lines", pivot: { row: "category", col: "trader", value: "qty" }, dateMode: "range", landscape: true },
  { key: "S-39", register: "sales", sl: 39, title: "Product groups, month by month",
    dataset: "sale_lines", pivot: { row: "category", col: "month", value: "amount" }, dateMode: "range", landscape: true },
  { key: "S-40", register: "sales", sl: 40, title: "Branches, month by month",
    dataset: "sale_lines", pivot: { row: "branch", col: "month", value: "amount" }, dateMode: "range", landscape: true },
  { key: "S-44", register: "sales", sl: 44, title: "Amount sold, branch by branch",
    dataset: "sale_lines", pivot: { row: "product", col: "branch", value: "amount" }, dateMode: "range", landscape: true },
  // Sales orders and deliveries (P14a). Sales reps still wait for P14c.
  { key: "S-21", register: "sales", sl: 21, title: "Orders waiting to be delivered, by date",
    note: "Pending is ordered minus delivered, so a part delivery leaves only the rest.",
    dataset: "order_lines", groupBy: ["d", "order_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("order_no", "Order No"), T("trader", "Customer Name"),
              T("product", "Product Description"), Q("pending_qty", "Pending Qty"),
              T("uom", "Unit")] },
  { key: "S-22", register: "sales", sl: 22, title: "Sales orders by date",
    dataset: "order_docs", groupBy: ["d", "order_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("order_no", "Order No"), T("trader_group", "Customer Group"),
              T("trader", "Customer Name"), M("total_amt", "Total Amount"),
              M("discount", "Discount"), M("charges", "Extra Charges"), M("ait", "AIT"),
              M("vat", "VAT"), M("amount", "Amount"), M("advance_amount", "Advance")] },
  { key: "S-23", register: "sales", sl: 23, title: "Orders waiting to be delivered, by product",
    dataset: "order_lines", groupBy: ["category", "product"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Name"),
              Q("pending_qty", "Quantity"), T("uom", "Unit")] },
  { key: "S-24", register: "sales", sl: 24, title: "Sales orders by product",
    dataset: "order_lines", groupBy: ["category", "product", "order_no"], dateMode: "range",
    columns: [T("category", "Product Group"), T("product", "Product Description"),
              T("order_no", "Order No"), T("trader", "Customer Name"), Q("qty", "Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("discount", "Discount"),
              AVG("net_unit_price", "Net Unit Price", "avg_price"), M("amount", "Amount")] },
  { key: "S-25", register: "sales", sl: 25, title: "Orders waiting to be delivered, by customer",
    dataset: "order_lines", groupBy: ["trader", "category", "product"], dateMode: "range",
    columns: [T("trader", "Customer Name"), T("category", "Product Group"),
              T("product", "Product Name"), Q("pending_qty", "Quantity")] },
  { key: "S-26", register: "sales", sl: 26, title: "Sales orders by customer",
    dataset: "order_lines", groupBy: ["trader", "order_no", "product"], dateMode: "range",
    columns: [T("trader", "Customer Name"), T("order_no", "Order No"),
              T("product", "Product Description"), Q("qty", "Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("discount", "Discount"),
              AVG("net_unit_price", "Net Unit Price", "avg_price"), M("amount", "Amount")] },
  { key: "S-29", register: "sales", sl: 29, title: "Sales rep statement",
    note: "One row per customer under each rep: what they were owed, what they bought, what came in, what is still out.",
    dataset: "rep_statement", groupBy: ["rep", "trader"], dateMode: "none", landscape: true,
    columns: [T("rep", "SR Name"), T("trader", "Trader Name"), T("address", "Address"),
              M("opening", "Opening"), M("sales", "Sales"), M("returned", "Returns"),
              M("discount", "Discount"), M("received", "Received"),
              M("deposit", "Security held"), M("due", "Due")] },
  { key: "S-33", register: "sales", sl: 33, title: "Net sales by product group, for one rep",
    dataset: "net_sales", groupBy: ["rep", "category"], dateMode: "range", landscape: true,
    columns: [T("rep", "SR Name"), T("category", "Product Group"),
              Q("sale_qty", "Sale Qty"), AVG("unit_price", "Unit Price", "avg_price"),
              M("sale_amount", "Sales Amount"), Q("return_qty", "Return Qty"),
              M("return_amount", "Return Amount"), Q("net_qty", "Net Qty"),
              M("net_amount", "Net Amount")] },
  { key: "S-35", register: "sales", sl: 35, title: "Every order of the period",
    note: "Each order with its lines and its totals, in date order.",
    dataset: "order_lines", groupBy: ["d", "order_no", "product"], dateMode: "range",
    columns: [DT("d", "Order Date"), T("order_no", "Order No."), T("trader", "Customer"),
              T("product", "Product"), Q("qty", "Qty"),
              AVG("unit_price", "Unit Price", "avg_price"), M("discount", "Discount"),
              M("amount", "Amount")] },
  { key: "S-36", register: "sales", sl: 36, title: "Orders waiting, by place",
    dataset: "order_lines", groupBy: ["location", "trader", "category", "product"],
    dateMode: "range",
    columns: [T("location", "Store"), T("trader", "Customer Name"),
              T("category", "Product Group"), T("product", "Product Name"),
              Q("pending_qty", "Qty")] },
  { key: "S-37", register: "sales", sl: 37, title: "Net sales orders by date",
    dataset: "order_lines", groupBy: ["category", "brand", "product"], dateMode: "range",
    landscape: true,
    columns: [...PRODUCT, Q("qty", "Ordered"), AVG("unit_price", "Unit Price", "avg_price"),
              M("amount", "Order Amount"), Q("delivered_qty", "Delivered"),
              Q("pending_qty", "Still to go")] },
  { key: "S-41", register: "sales", sl: 41, title: "Rep and customer statement",
    dataset: "rep_statement", groupBy: ["rep", "trader_group", "trader"], dateMode: "none",
    landscape: true,
    columns: [T("rep", "SR Name"), T("trader_group", "Group"), T("trader", "Trader Name"),
              T("kind", "Kind"), M("opening", "Opening"), M("sales", "Sales"),
              M("returned", "Sales Return"), M("discount", "Discount"),
              M("received", "Received"), M("due", "Due")] },
  { key: "S-42", register: "sales", sl: 42, title: "Deliveries by customer",
    note: "What went out of the door, on a delivery note or over the counter. BMS leaves counter sales out, which answers the wrong question.",
    dataset: "deliveries", groupBy: ["trader", "d", "delivery_no"], dateMode: "range",
    landscape: true,
    columns: [T("trader", "Customer Name"), DT("d", "Date"),
              T("delivery_no", "Delivery No"), T("order_no", "Order No"),
              T("invoice_no", "Invoice No"), T("product", "Product Description"),
              Q("qty", "Qty"), T("uom", "Unit")] },
  { key: "S-43", register: "sales", sl: 43, title: "Delivery summary by customer",
    dataset: "deliveries", groupBy: ["trader", "product"], dateMode: "range",
    columns: [T("trader", "Customer Name"), T("product", "Product"), Q("qty", "Qty"),
              T("uom", "Unit")] },
];

/**
 * STOCK REGISTER (docs/BMS_REPORTS.md section 7).
 *
 * BMS's stock reports disagree with each other: "Current Stock" and "Stock as on
 * today" differ by four units, and its trial balance and balance sheet each use a
 * different one of them. Here "as on today" IS current stock — the same function with
 * today's date — and R-4 proves it against the inventory account. Unit cost is always
 * total ÷ qty, never the latest purchase price printed next to an average total.
 */
const STOCK: ReportDef[] = [
  { key: "ST-1", register: "stock", sl: 1, title: "What is on the shelf, with cost",
    dataset: "stock_as_on", groupBy: ["category", "brand", "product"], dateMode: "as_on", needsCost: true,
    columns: [...PRODUCT, T("model", "Product Model"), Q("qty", "Qty"), T("uom", "UoM"),
              AVG("unit_cost", "Unit Cost", "avg_cost"), C("total_cost", "Total Cost")] },
  { key: "ST-2", register: "stock", sl: 2, title: "What is on the shelf",
    dataset: "stock_as_on", groupBy: ["category", "brand", "product"], dateMode: "as_on",
    columns: [...PRODUCT, T("model", "Product Model"), T("uom", "Unit of Measurement"), Q("qty", "Qty")] },
  { key: "ST-3", register: "stock", sl: 3, title: "What is on the shelf, by place",
    dataset: "stock_as_on", groupBy: ["location", "category", "product"], dateMode: "as_on",
    columns: [T("location", "Store"), T("category", "Product Group"), T("product", "Product Description"),
              T("uom", "UoM"), Q("qty", "Qty")] },
  { key: "ST-4", register: "stock", sl: 4, title: "What is on the shelf, by place, with cost",
    dataset: "stock_as_on", groupBy: ["location", "category", "product"], dateMode: "as_on", needsCost: true,
    columns: [T("location", "Store"), T("category", "Product Group"), T("product", "Product Description"),
              Q("qty", "Qty"), AVG("unit_cost", "Unit Cost", "avg_cost"), C("total_cost", "Total Cost")] },
  { key: "ST-5", register: "stock", sl: 5, title: "Serials on the shelf",
    dataset: "serial_stock", groupBy: ["product", "invoice_no"], dateMode: "none",
    columns: [T("product", "Product Description"), T("invoice_no", "Invoice No"),
              T("serial", "Serial"), DT("d", "Received"), N("one", "Qty")] },
  { key: "ST-6", register: "stock", sl: 6, title: "Stock across every branch",
    dataset: "stock_as_on", groupBy: ["category", "product"], dateMode: "as_on", needsCost: true,
    columns: [T("category", "Product Group"), T("code", "Product ID"), T("product", "Product Description"),
              Q("qty", "Qty"), AVG("unit_cost", "Unit Cost", "avg_cost"), C("total_cost", "Total Cost")] },
  { key: "ST-7", register: "stock", sl: 7, title: "One product's stock ledger", special: "product_ledger",
    note: "Every movement of one product with a running balance — the stock equivalent of an account ledger, and how any stock figure in any other report is checked.",
    dateMode: "range" },
  { key: "ST-8", register: "stock", sl: 8, title: "Stock branch by branch",
    dataset: "stock_as_on", pivot: { row: "product", col: "branch", value: "qty" },
    dateMode: "as_on", landscape: true },
  { key: "ST-9", register: "stock", sl: 9, title: "How long stock has been sitting",
    note: "One row per delivery that still has units left, with buckets at the end — the buckets are what an owner acts on.",
    dataset: "layers", groupBy: ["age_bucket", "category", "product", "invoice_no"],
    dateMode: "as_on", needsCost: true, landscape: true,
    columns: [T("age_bucket", "Age"), T("category", "Product Group"), T("invoice_no", "InvoiceNo"),
              T("model", "ModelNo"), T("product", "Product Description"), Q("qty", "Qty"),
              DT("d", "Purchase Date"), N("age_days", "Age (Day)"), C("amount", "Value")] },
  { key: "ST-10", register: "stock", sl: 10, title: "How long each serial has been sitting",
    dataset: "serial_stock", groupBy: ["category", "product"], dateMode: "none",
    columns: [T("category", "Product Group"), T("invoice_no", "InvoiceNo"), T("model", "ModelNo"),
              T("serial", "Serial"), DT("d", "Purchase Date"), N("age_days", "Age (Day)")] },
  { key: "ST-11", register: "stock", sl: 11, title: "Stock as it stood, with cost",
    dataset: "stock_as_on", groupBy: ["category", "product"], dateMode: "as_on", needsCost: true,
    columns: [T("category", "Product Group"), T("code", "Product ID"), T("model", "Model No"),
              T("product", "Product Description"), Q("qty", "Qty"),
              AVG("unit_cost", "Unit Cost", "avg_cost"), C("total_cost", "Total Cost")] },
  { key: "ST-12", register: "stock", sl: 12, title: "What moved, and what is left", special: "product_status",
    note: "Opening, bought, returned, sold, corrected, transferred, closing — per product, with the arithmetic shown. It must reconcile with the stock report at both ends of the period, and there is a test that it does.",
    dateMode: "range", needsCost: true, landscape: true },
  { key: "ST-13", register: "stock", sl: 13, title: "Serials on the shelf, with cost",
    dataset: "serial_stock", groupBy: ["product", "invoice_no"], dateMode: "none", needsCost: true,
    columns: [T("product", "Product Description"), T("invoice_no", "Invoice No"), DT("d", "Date"),
              T("supplier", "Supplier Name"), T("status", "Status"), T("serial", "Serial"),
              C("unit_cost", "Unit Cost")] },
  { key: "ST-14", register: "stock", sl: 14, title: "One product's stock ledger, with what is on order",
    special: "product_ledger", dateMode: "range" },
  { key: "ST-15", register: "stock", sl: 15, title: "Stock as it stood",
    dataset: "stock_as_on", groupBy: ["category", "brand", "product"], dateMode: "as_on",
    columns: [...PRODUCT, T("model", "ModelNo"), Q("qty", "Qty")] },
  { key: "ST-16", register: "stock", sl: 16, title: "Stock as it stood, by place, with cost",
    dataset: "stock_as_on", groupBy: ["location", "category", "product"], dateMode: "as_on", needsCost: true,
    columns: [T("location", "Store"), T("category", "Product Group"), T("product", "Product Description"),
              Q("qty", "Qty"), AVG("unit_cost", "Unit Cost", "avg_cost"), C("total_cost", "Total Cost")] },
  { key: "ST-17", register: "stock", sl: 17, title: "Stock place by place",
    dataset: "stock_as_on", pivot: { row: "product", col: "location", value: "qty" },
    dateMode: "as_on", landscape: true },
  { key: "ST-18", register: "stock", sl: 18, title: "Free to promise",
    note: "On the shelf, minus what is promised to open orders — what a salesperson may safely promise today. BMS prints quantities larger than the shop physically has, and nobody at the store could say what they meant.",
    dataset: "free_to_promise", groupBy: ["category", "brand", "product"], dateMode: "as_on",
    columns: [...PRODUCT, T("model", "Model No"), Q("qty", "On the shelf"),
              Q("reserved", "Promised"), Q("free", "Free to promise")] },
  { key: "ST-19", register: "stock", sl: 19, title: "One product's stock ledger, by place",
    special: "product_ledger", dateMode: "range" },
];

/**
 * ACCOUNTS REGISTER (docs/BMS_REPORTS.md section 8).
 *
 * BMS's own trial balance does not balance and its balance sheet is out by the same
 * amount. Ours is forced to balance by the deferred constraint in P13, and the
 * done-when of this prompt is that the balance sheet's stock figure equals the stock
 * valuation report to the taka.
 */
const ACCOUNTS: ReportDef[] = [
  { key: "A-1", register: "accounts", sl: 1, title: "Who owes what, branch by branch",
    special: "branch_dues", dateMode: "as_on", landscape: true,
    note: "Receivable and payable in their own columns. BMS mixes the signs, so a supplier credit and a customer debt add up to nonsense." },
  { key: "A-2", register: "accounts", sl: 2, title: "Bank summary",
    special: "bank_summary", dateMode: "range",
    note: "Opening, in, out and closing for every bank account and wallet." },
  { key: "A-3", register: "accounts", sl: 3, title: "Account ledger", special: "ledger",
    dateMode: "range", note: "Any account, or any one customer, supplier or bank account inside it." },
  { key: "A-4", register: "accounts", sl: 4, title: "Money received",
    dataset: "vouchers", groupBy: ["d", "account", "entry_no"], filter: { voucher_type: "receipt" }, dateMode: "range", landscape: true,
    columns: [DT("d", "Date"), T("account", "Particulars"), T("entry_no", "Voucher ID"),
              T("narration", "Narration"), T("ref_no", "Ref No."), T("entered_by", "Entered By"),
              T("bank", "Bank Name & A/C No."), T("cheque_no", "Cheque No"),
              DT("cheque_date", "Chq. Date"), M("credit", "Amount")] },
  { key: "A-5", register: "accounts", sl: 5, title: "Money paid out",
    dataset: "vouchers", groupBy: ["d", "account", "entry_no"], filter: { voucher_type: "payment" }, dateMode: "range", landscape: true,
    columns: [DT("d", "Date"), T("account", "Particulars"), T("entry_no", "Voucher ID"),
              T("narration", "Narration"), T("ref_no", "Ref No."), T("entered_by", "Prepared By"),
              T("cheque_no", "Cheque No"), DT("cheque_date", "Chq. Date"), M("debit", "Amount")] },
  { key: "A-6", register: "accounts", sl: 6, title: "Journal vouchers",
    dataset: "vouchers", groupBy: ["entry_no", "account"], filter: { voucher_type: "journal" }, dateMode: "range", landscape: true,
    columns: [T("account", "Particulars"), T("narration", "Narration"), T("entry_no", "Voucher ID"),
              T("ref_no", "Ref No."), DT("d", "Date"), T("entered_by", "Prepared By"),
              T("cheque_no", "Cheque No"), DT("cheque_date", "Cheq.Date"),
              M("debit", "Debit"), M("credit", "Credit")] },
  { key: "A-7", register: "accounts", sl: 7, title: "Who owes what", special: "due_list",
    dateMode: "as_on",
    note: "Receivable, then payable. A supplier who owes US is under receivable, and a customer in credit is under payable, because that is where the money actually is." },
  { key: "A-8", register: "accounts", sl: 8, title: "Trial balance", special: "trial_balance",
    dateMode: "range", note: "The two columns that must match. If they ever differ, something is wrong and this is where it shows." },
  { key: "A-9", register: "accounts", sl: 9, title: "Profit and loss", special: "profit_loss",
    dateMode: "range", needsCost: true,
    note: "Sales less cost of goods sold gives gross profit; then the running costs come off." },
  { key: "A-10", register: "accounts", sl: 10, title: "Day book", special: "day_book",
    dateMode: "range", note: "Everything that happened on a day, by kind, then the cash and bank summary underneath." },
  { key: "A-11", register: "accounts", sl: 11, title: "Balances by level", special: "layer_summary",
    dateMode: "range", note: "The trial balance rolled up to account group, for a one-page view." },
  { key: "A-12", register: "accounts", sl: 12, title: "Who owes what, counting uncleared cheques",
    special: "due_list", dateMode: "as_on",
    note: "The same list, but a cheque that has not cleared still counts as owed — which is the honest view until the bank says otherwise." },
  { key: "A-14", register: "accounts", sl: 14, title: "Sales and what came in",
    special: "sales_received", dateMode: "range",
    note: "Opening due, sold, discount, received, closing. BMS shows cash sales as nothing received, because it never records the payment; ours shows the cash." },
  { key: "A-15", register: "accounts", sl: 15, title: "Sales and what came in, per customer",
    special: "sales_received", dateMode: "range", note: "The same, one row per trader. Zero rows are hidden." },
  { key: "A-16", register: "accounts", sl: 16, title: "Balance sheet", special: "balance_sheet",
    dateMode: "as_on", needsCost: true,
    note: "What the shop owns against what it owes and what the owner put in. A loss goes on the correct side, not wherever it makes the page add up." },
  { key: "A-17", register: "accounts", sl: 17, title: "Chart of accounts", special: "chart", dateMode: "none" },
  { key: "A-18", register: "accounts", sl: 18, title: "Supplier list",
    dataset: "traders", groupBy: ["trader_group", "name"], dateMode: "none",
    filter: { kind: "supplier" },
    columns: [T("trader_group", "Group"), T("code", "Code"), T("name", "Name"), T("address", "Address"),
              T("mobile", "Mobile"), T("company", "Company"), M("opening", "Opening Balance")] },
  { key: "A-19", register: "accounts", sl: 19, title: "Customer list",
    dataset: "traders", groupBy: ["trader_group", "name"], dateMode: "none",
    filter: { kind: "customer" },
    columns: [T("trader_group", "Group"), T("code", "Code"), T("name", "Name"), T("address", "Address"),
              T("mobile", "Mobile"), T("company", "Company"), M("opening", "Opening Balance")] },
  { key: "A-20", register: "accounts", sl: 20, title: "Other income",
    dataset: "income_lines", groupBy: ["account"], dateMode: "range",
    columns: [T("account", "A/C Ledger Name"), M("amount", "Amount")] },
  { key: "A-21", register: "accounts", sl: 21, title: "Running costs",
    dataset: "expense_lines", groupBy: ["account"], dateMode: "range",
    columns: [T("account", "A/C Ledger Name"), M("amount", "Amount")] },
  { key: "A-22", register: "accounts", sl: 22, title: "Profit and loss, every branch together",
    special: "profit_loss", dateMode: "range", needsCost: true },
  { key: "A-23", register: "accounts", sl: 23, title: "Balance sheet, every branch together",
    special: "balance_sheet", dateMode: "as_on", needsCost: true },
  { key: "A-24", register: "accounts", sl: 24, title: "Cash moved to or from the bank",
    dataset: "vouchers", groupBy: ["entry_no", "account"], filter: { voucher_type: "contra" }, dateMode: "range", landscape: true,
    columns: [T("account", "Particulars"), T("narration", "Narration"), T("entry_no", "Voucher ID"),
              T("ref_no", "Ref No."), DT("d", "Date"), T("cheque_no", "Cheque No"),
              DT("cheque_date", "Chq. Date"), M("debit", "Debit"), M("credit", "Credit")] },
  { key: "A-13", register: "accounts", sl: 13, title: "Bank interest calculator",
    needs: "later", dateMode: "range",
    note: "Nobody at the store was seen using this. Left out until somebody asks for it; see the open questions in docs/BMS_REPORTS.md." },
];

/** TRANSFER REGISTER (docs/BMS_REPORTS.md section 9). "In transit" is ours: BMS has
 *  no report for goods that left one branch and have not arrived at the other, which
 *  is the one thing about a transfer anybody chases. */
const TRANSFER: ReportDef[] = [
  { key: "T-1", register: "transfer", sl: 1, title: "Sent out, by date",
    dataset: "transfers_out", groupBy: ["to_branch", "d", "transfer_no"], dateMode: "range",
    needsCost: true, landscape: true,
    columns: [T("to_branch", "Branch To"), DT("d", "Date"), T("transfer_no", "Transfer ID"),
              T("product", "Product Description"), T("location", "Store"), Q("qty", "Qty"),
              AVG("unit_cost", "Unit Cost", "avg_cost"), C("amount", "Amount"),
              DT("received_on", "Rec. Date")] },
  { key: "T-2", register: "transfer", sl: 2, title: "Sent out, by product",
    dataset: "transfers_out", groupBy: ["product", "transfer_no"], dateMode: "range", needsCost: true,
    columns: [T("product", "Product Description"), T("transfer_no", "Invoice No"),
              T("to_branch", "Branch Name"), Q("qty", "Qty"),
              AVG("unit_cost", "Unit Cost", "avg_cost"), C("amount", "Amount")] },
  { key: "T-3", register: "transfer", sl: 3, title: "Sent out, by branch",
    dataset: "transfers_out", groupBy: ["branch", "transfer_no", "product"], dateMode: "range", needsCost: true,
    columns: [T("branch", "From Branch"), T("transfer_no", "Invoice No"),
              T("product", "Product Description"), Q("qty", "Qty"),
              AVG("unit_cost", "Unit Cost", "avg_cost"), C("amount", "Amount")] },
  { key: "T-4", register: "transfer", sl: 4, title: "Received from another branch, by date",
    dataset: "transfers_in", groupBy: ["d", "transfer_no"], dateMode: "range", landscape: true,
    columns: [DT("d", "Date"), T("transfer_no", "Transfer ID"), T("from_branch", "Receive From"),
              T("product", "Product Description"), Q("qty", "Qty"), DT("sent_on", "Tr. Date")] },
  { key: "T-5", register: "transfer", sl: 5, title: "Received from another branch, by product",
    dataset: "transfers_in", groupBy: ["product", "transfer_no"], dateMode: "range", needsCost: true,
    columns: [T("product", "Product Description"), T("transfer_no", "Transfer ID"),
              T("from_branch", "Branch Name"), Q("qty", "Qty"),
              AVG("unit_cost", "Unit Cost", "avg_cost"), C("amount", "Total Price")] },
  { key: "T-6", register: "transfer", sl: 6, title: "Received, by branch",
    dataset: "transfers_in", groupBy: ["branch", "transfer_no", "product"], dateMode: "range", needsCost: true,
    columns: [T("branch", "Branch"), T("transfer_no", "Invoice No"),
              T("product", "Product Description"), Q("qty", "Qty"), C("amount", "Total Price")] },
  { key: "T-7", register: "transfer", sl: 7, title: "Moved inside a branch, by date",
    dataset: "inhouse", groupBy: ["d", "doc_no"], dateMode: "range",
    columns: [DT("d", "Date"), T("doc_no", "Transfer ID"), T("from_location", "Transfer From"),
              T("to_location", "Transfer To"), T("model", "Product Model"), Q("qty", "Qty")] },
  { key: "T-8", register: "transfer", sl: 8, title: "Moved inside a branch, by product",
    dataset: "inhouse", groupBy: ["product", "doc_no"], dateMode: "range",
    columns: [T("product", "Product Description"), T("doc_no", "Invoice No."),
              T("from_location", "Store From"), T("to_location", "Store To"), Q("qty", "Qty")] },
  { key: "T-9", register: "transfer", sl: 9, title: "Moved inside a branch, by place",
    dataset: "inhouse", groupBy: ["from_location", "to_location", "product"], dateMode: "range",
    columns: [T("from_location", "Store From"), T("to_location", "Store To"),
              T("product", "Product Description"), Q("qty", "Qty")] },
  { key: "T-10", register: "transfer", sl: 10, title: "Still in the van",
    note: "Sent and not yet received, with how many days it has been out, and anything disputed. BMS has no such report, which is why nobody chases a transfer until a branch notices the stock missing.",
    dataset: "in_transit", groupBy: ["branch", "to_branch", "transfer_no"], dateMode: "none", needsCost: true,
    columns: [T("branch", "From"), T("to_branch", "To"), T("transfer_no", "Transfer ID"),
              DT("d", "Sent"), N("days_out", "Days out"), T("status", "Status"),
              T("product", "Product Description"), Q("qty", "Qty"), C("amount", "At cost")] },
];

/**
 * THE REST — the registers BMS keeps on other menus, and the reports this prompt asks
 * for by name that BMS has no equivalent of (a VAT return, stock valuation proved
 * against the inventory account, profit by month).
 */
const OTHER: ReportDef[] = [
  { key: "R-1", register: "other", sl: 1, title: "Cash book", special: "cash_book",
    dateMode: "range",
    note: "Opening, every taka in and out, closing — for one drawer or all of them. This is the report the shift's counted cash is checked against." },
  { key: "R-2", register: "other", sl: 2, title: "Bank book", special: "cash_book",
    dateMode: "range", note: "The same, for a bank account or a wallet." },
  { key: "R-3", register: "other", sl: 3, title: "VAT return", special: "vat_report",
    dateMode: "range",
    note: "VAT charged on sales against VAT paid on purchases, and the difference — what the shop owes. Only for shops that charge VAT." },
  { key: "R-4", register: "other", sl: 4, title: "Stock valuation", special: "stock_valuation",
    dateMode: "as_on", needsCost: true,
    note: "Quantity times average cost, per branch, set against the stock account in the books. The difference should be nothing, and it is shown either way — BMS has two stock figures and no way to tell which is right." },
  { key: "R-5", register: "other", sl: 5, title: "Profit by month", special: "profit_by_month",
    dateMode: "range", needsCost: true,
    note: "Sales, cost, gross profit, running costs and net profit, one column per month, with the branches side by side underneath." },
  { key: "R-6", register: "other", sl: 6, title: "Everything anyone changed",
    note: "The audit log as a report: discounts approved, prices changed, sales voided, limits overridden, stock written off. BMS calls it the Modification Register.",
    dataset: "audit", groupBy: ["d", "action"], dateMode: "range",
    columns: [DT("d", "Date"), T("at", "Time"), T("action", "What"), T("who", "Who"),
              T("branch", "Branch"), T("entity", "On"), T("details", "Details")] },
  { key: "R-7", register: "other", sl: 7, title: "Warranty claims",
    note: "Every claim with how long it has been open. BMS calls it the RMA Service Register.",
    dataset: "claims", groupBy: ["status", "claim_no"], dateMode: "range",
    columns: [T("status", "Status"), T("claim_no", "Claim No"), DT("d", "Taken in"),
              T("trader", "Customer"), T("product", "Product"), T("serial", "Serial"),
              T("fault", "Fault"), T("technician", "With"), N("days_open", "Days")] },
  { key: "R-8", register: "other", sl: 8, title: "Items held under warranty",
    note: "What the shop is holding for customers and what is out with suppliers, and since when. BMS calls it the RMA Stock Register.",
    dataset: "rma_stock", groupBy: ["where", "product"], dateMode: "none", needsCost: true,
    columns: [T("where", "Where it is"), T("product", "Product"), T("serial", "Serial"),
              T("claim_no", "Claim No"), T("supplier", "With"), DT("d", "Since"),
              N("days_out", "Days"), C("unit_cost", "At cost")] },
  { key: "R-9", register: "other", sl: 9, title: "Cheques",
    dataset: "cheques", groupBy: ["direction", "status", "cheque_no"], dateMode: "range",
    columns: [T("direction", "In or out"), T("status", "Status"), T("cheque_no", "Cheque No"),
              DT("d", "Cheque Date"), T("party", "Party"), T("bank", "Bank"),
              M("amount", "Amount"), DT("settled_on", "Settled")] },
  { key: "R-11", register: "other", sl: 11, title: "Attendance",
    note: "Day by day, per person. How it was recorded is a column: somebody checking in at the branch and a manager's word are not the same kind of evidence.",
    dataset: "attendance", groupBy: ["employee", "d"], dateMode: "range", landscape: true,
    columns: [T("employee", "Employee"), T("designation", "Designation"),
              DT("d", "Date"), T("status", "Status"), T("in_at", "In"), T("out_at", "Out"),
              N("minutes_late", "Minutes late"), T("recorded", "How"),
              Q("days_worked", "Days worked"), Q("days_absent", "Absent"),
              Q("days_leave", "On leave")] },
  { key: "R-12", register: "other", sl: 12, title: "Salary sheet",
    note: "What each person was paid and what came off it. Every deduction is shown, because a deduction nobody can explain is an argument every month.",
    dataset: "salary", groupBy: ["month", "employee"], dateMode: "range",
    needsCost: true, landscape: true,
    columns: [T("month", "Month"), T("employee", "Employee"),
              T("designation", "Designation"), M("basic", "Basic"),
              M("allowances", "Allowances"), Q("days_worked", "Days worked"),
              Q("absent_days", "Days absent"), M("absence_cut", "Less absence"),
              M("advance_cut", "Less advance"), M("net", "Net paid"),
              T("sheet_status", "Status")] },
  { key: "R-10", register: "other", sl: 10, title: "Challans",
    note: "Delivered now, billed later. The ones still unbilled are the ones to chase: goods gone, money not asked for.",
    dataset: "deliveries", groupBy: ["status", "d", "delivery_no"], dateMode: "range",
    columns: [T("status", "Status"), DT("d", "Date"), T("delivery_no", "Delivery No"),
              T("order_no", "Order No"), T("invoice_no", "Invoice No"),
              T("trader", "Customer"), Q("qty", "Qty"), M("amount", "Amount")] },
];

/** Every report, in one list. */
export const REPORTS: readonly ReportDef[] = [
  ...PURCHASE, ...SALES, ...STOCK, ...ACCOUNTS, ...TRANSFER, ...OTHER,
];

export const REGISTERS: { key: ReportRegister; label: string; note: string }[] = [
  { key: "sales", label: "Sales", note: "What went out of the door, and what it earned." },
  { key: "purchase", label: "Purchases", note: "What came in, from whom, and what is still owed." },
  { key: "stock", label: "Stock", note: "What is on the shelf, what it is worth, and how long it has been there." },
  { key: "accounts", label: "Accounts", note: "The books: ledgers, trial balance, profit, balance sheet." },
  { key: "transfer", label: "Transfers", note: "Stock moved between branches and between places inside one." },
  { key: "other", label: "Everything else", note: "VAT, cheques, warranty, and the log of what people changed." },
];

export function reportByKey(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key);
}

/** The reports in one register, in the order they should be listed. */
export function reportsIn(register: ReportRegister): ReportDef[] {
  return REPORTS.filter((r) => r.register === register).sort((a, b) => a.sl - b.sl);
}

/** Plain English for why a report is not available yet. */
export function notYetBecause(needs: NonNullable<ReportDef["needs"]>): string {
  if (needs === "P14a") return "Comes with quotations, sales orders and challans.";
  if (needs === "P14c") return "Comes with sales reps and delivery points.";
  return "Nobody at the store was seen using this one. Ask and it will be built.";
}
