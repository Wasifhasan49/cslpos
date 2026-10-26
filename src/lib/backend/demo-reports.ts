/**
 * The reports, for demo mode.
 *
 * The database has one engine for all hundred-odd reports (group a dataset, total it at
 * every level) and a builder for the dozen that are a different shape. This is the same
 * two things over the in-memory sample data, driven by the SAME catalogue in
 * src/lib/reports.ts — so a report added there appears in demo mode too, and a shop
 * trying the app sees real numbers rather than an empty page.
 *
 * Where the sample data does not go deep enough to answer a report honestly, the
 * report says so on its own face instead of printing a plausible nil.
 */
import {
  REPORTS, type ReportDef, type ReportColumn, reportByKey,
} from "../reports";
import { dhakaDate } from "../sale";
import type {
  ClaimRow, GoodsReceivedRow, PeriodLock, ReportColumnOut, ReportFilters,
  ReportListItem, ReportResult, ReportRow, ReportSection, TransferRow,
} from "../types";

/** Everything the reports read. Passed in fresh each time, so they see live changes. */
export interface DemoReportData {
  shop: string;
  me: { name: string; role: string };
  branches: { id: string; name: string }[];
  products: {
    id: string; code: string; name: string; brand: string | null;
    categoryId: string | null; reorderLevel: number;
  }[];
  categories: { id: string; name: string }[];
  customers: { id: string; name: string; phone: string; company: string | null;
               address: string | null; group: string | null; openingBalance: number }[];
  suppliers: { id: string; name: string; phone: string | null; address: string | null }[];
  sales: DemoReportSale[];
  deliveries: (GoodsReceivedRow & { branchId: string })[];
  stock: Record<string, Record<string, number>>;
  costs: Record<string, number>;
  serials: { serial: string; productId: string; branchId: string; sold: boolean;
             inTransit?: boolean }[];
  journal: DemoReportEntry[];
  accounts: { id: string; code: string; name: string; group: string; nature: string;
              role: string | null; branchId: string | null }[];
  cheques: { chequeNo: string; direction: string; status: string; amount: number;
             chequeDate: string; party: string | null; bank: string | null;
             branchId: string; settledOn: string | null }[];
  claims: ClaimRow[];
  transfers: TransferRow[];
  locks: PeriodLock[];
  settings: Record<string, { title?: string; sl?: number; captions?: Record<string, string> }>;
  features: Record<string, boolean>;
}

export interface DemoReportSale {
  id: string; invoiceNo: string; createdAt: string; branchId: string; branch: string;
  staff: string; customerId: string | null; customerName: string | null;
  customerGroup: string | null;
  paymentMethod: string; paymentRef: string | null;
  subtotal: number; discountPct: number; discountAmount: number;
  vatAmount: number; chargesAmount: number; total: number;
  dueAmount: number; paidAmount: number; status: string;
  lines: { id: string; productId: string; name: string; qty: number; unitPrice: number;
           lineTotal: number; vatAmount: number; cost: number | null;
           serials: string[]; returnedQty: number; refundEach: number }[];
}

export interface DemoReportEntry {
  id: string; entryNo: string; date: string; narration: string; sourceKind: string;
  status: string; branchId: string; who: string;
  lines: { accountId: string; debit: number; credit: number; note: string | null;
           customerId: string | null; supplierId: string | null }[];
}

type Row = Record<string, unknown>;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const col = (f: string, l: string, t: ReportColumnOut["t"]): ReportColumnOut => ({ f, l, t });
const MONEY = (f: string, l: string) => col(f, l, "money");
const TEXT = (f: string, l: string) => col(f, l, "text");

export function demoReportList(data: DemoReportData): ReportListItem[] {
  return REPORTS.map((r) => {
    const s = data.settings[r.key] ?? {};
    return {
      key: r.key, register: r.register, sl: s.sl ?? r.sl,
      title: s.title ?? r.title, note: r.note ?? null,
      dateMode: r.dateMode ?? "range", landscape: Boolean(r.landscape),
      needs: r.needs ?? null, needsCost: Boolean(r.needsCost),
      // In demo mode the signed-in person is the owner, who sees cost.
      allowed: !r.needs,
      renamed: s.title !== undefined,
    };
  }).sort((a, b) => a.register.localeCompare(b.register) || a.sl - b.sl);
}

// ---------------------------------------------------------------------------
// The datasets
// ---------------------------------------------------------------------------

function inRange(d: string, f: ReportFilters): boolean {
  if (f.from && d < f.from) return false;
  if (f.to && d > f.to) return false;
  return true;
}

function productBits(data: DemoReportData, productId: string): Row {
  const p = data.products.find((x) => x.id === productId);
  const cat = data.categories.find((c) => c.id === p?.categoryId);
  return {
    product_id: productId,
    code: p?.code ?? "—",
    model: p?.code ?? "—",
    product: p?.name ?? "—",
    category: cat?.name ?? "N/A",
    brand: p?.brand ?? "N/A",
    uom: "PCS",
  };
}

function billType(method: string): string {
  if (method === "due") return "Credit bill";
  if (method === "card") return "Card bill";
  if (method === "cash") return "Cash bill";
  return `${method.charAt(0).toUpperCase()}${method.slice(1)} bill`;
}

function saleLines(data: DemoReportData, f: ReportFilters): Row[] {
  const out: Row[] = [];
  for (const s of data.sales) {
    if (s.status !== "completed") continue;
    const d = dhakaDate(s.createdAt);
    if (!inRange(d, f)) continue;
    if (f.branchId && s.branchId !== f.branchId) continue;
    for (const l of s.lines) {
      const discount = round2((l.lineTotal * s.discountPct) / 100);
      const amount = round2(l.lineTotal - discount);
      const cost = round2((l.cost ?? 0) * l.qty);
      out.push({
        ...productBits(data, l.productId),
        shop_id: "demo", branch_id: s.branchId, branch: s.branch,
        d, month: d.slice(0, 7), sale_id: s.id, invoice_no: s.invoiceNo,
        ref_no: s.paymentRef ?? "—", bill_type: billType(s.paymentMethod),
        trader: s.customerName ?? "Cash customer",
        trader_group: s.customerGroup ?? "Cash customer",
        entered_by: s.staff, sold_by: s.staff, rep: s.staff,
        qty: l.qty, unit_price: l.unitPrice, discount, amount,
        net_unit_price: l.qty ? round2(amount / l.qty) : 0,
        vat: l.vatAmount, ait: 0, charges: 0,
        unit_cost: l.cost, cost, profit: round2(amount - cost),
        purchase_invoice: deliveryFor(data, l.productId) ?? "—",
        serials: l.serials.join(", ") || "—",
        status: s.status,
      });
    }
  }
  return out;
}

/** Which delivery a product most recently came in on — the demo's stand-in for layers. */
function deliveryFor(data: DemoReportData, productId: string): string | null {
  const p = data.products.find((x) => x.id === productId);
  for (const g of data.deliveries) {
    if (g.lines.some((l) => l.product === p?.name)) return g.grnNo;
  }
  return null;
}

function saleDocs(data: DemoReportData, f: ReportFilters): Row[] {
  return data.sales
    .filter((s) => s.status === "completed" && inRange(dhakaDate(s.createdAt), f)
                   && (!f.branchId || s.branchId === f.branchId))
    .map((s): Row => {
      const cost = round2(s.lines.reduce((t, l) => t + (l.cost ?? 0) * l.qty, 0));
      return {
        shop_id: "demo", branch_id: s.branchId, branch: s.branch,
        d: dhakaDate(s.createdAt), month: dhakaDate(s.createdAt).slice(0, 7),
        sale_id: s.id, invoice_no: s.invoiceNo, ref_no: s.paymentRef ?? "—",
        bill_type: billType(s.paymentMethod),
        trader: s.customerName ?? "Cash customer",
        trader_group: s.customerGroup ?? "Cash customer",
        entered_by: s.staff, sold_by: s.staff, rep: s.staff,
        qty: s.lines.reduce((t, l) => t + l.qty, 0),
        total_amt: s.subtotal, discount: s.discountAmount, charges: s.chargesAmount,
        vat: s.vatAmount, ait: 0, amount: s.total,
        due_amount: s.dueAmount, paid_amount: s.paidAmount,
        cost, profit: round2(s.total - s.vatAmount - s.chargesAmount - cost),
        status: s.status,
      };
    });
}

function returnLines(data: DemoReportData, f: ReportFilters): Row[] {
  const out: Row[] = [];
  for (const s of data.sales) {
    const d = dhakaDate(s.createdAt);
    if (!inRange(d, f)) continue;
    if (f.branchId && s.branchId !== f.branchId) continue;
    for (const l of s.lines) {
      if (!l.returnedQty) continue;
      const amount = round2(l.refundEach * l.returnedQty);
      out.push({
        ...productBits(data, l.productId),
        shop_id: "demo", branch_id: s.branchId, branch: s.branch,
        d, month: d.slice(0, 7), return_no: `RET-${s.invoiceNo}`,
        invoice_no: s.invoiceNo, reason: "—", refund_method: "cash",
        trader: s.customerName ?? "Cash customer",
        trader_group: s.customerGroup ?? "Cash customer",
        qty: l.returnedQty, amount, unit_price: l.refundEach,
        is_faulty: false, cost: round2((l.cost ?? 0) * l.returnedQty),
      });
    }
  }
  return out;
}

function netSales(data: DemoReportData, f: ReportFilters): Row[] {
  const by = new Map<string, Row>();
  const key = (r: Row): string =>
    [r.branch_id, r.d, r.trader, r.rep, r.product_id].join("|");
  for (const r of saleLines(data, f)) {
    const k = key(r);
    const got = by.get(k) ?? { ...r, sale_qty: 0, sale_amount: 0, return_qty: 0,
                               return_amount: 0, net_qty: 0, net_amount: 0 };
    got.sale_qty = (got.sale_qty as number) + (r.qty as number);
    got.sale_amount = round2((got.sale_amount as number) + (r.amount as number));
    by.set(k, got);
  }
  for (const r of returnLines(data, f)) {
    const k = key({ ...r, rep: r.trader });
    const got = by.get(k);
    if (!got) continue;
    got.return_qty = (got.return_qty as number) + (r.qty as number);
    got.return_amount = round2((got.return_amount as number) + (r.amount as number));
  }
  return [...by.values()].map((r) => ({
    ...r,
    net_qty: (r.sale_qty as number) - (r.return_qty as number),
    net_amount: round2((r.sale_amount as number) - (r.return_amount as number)),
    unit_price: (r.sale_qty as number)
      ? round2((r.sale_amount as number) / (r.sale_qty as number)) : 0,
  }));
}

function purchaseLines(data: DemoReportData, f: ReportFilters): Row[] {
  const out: Row[] = [];
  for (const g of data.deliveries) {
    const d = dhakaDate(g.createdAt);
    if (!inRange(d, f)) continue;
    if (f.branchId && g.branchId !== f.branchId) continue;
    const branch = data.branches.find((b) => b.id === g.branchId);
    for (const l of g.lines) {
      const p = data.products.find((x) => x.name === l.product);
      out.push({
        ...(p ? productBits(data, p.id) : { product: l.product, code: "—", model: "—",
                                            category: "N/A", brand: "N/A", uom: "PCS" }),
        shop_id: "demo", branch_id: g.branchId, branch: branch?.name ?? "—",
        location: "Main store", d, invoice_date: d, month: d.slice(0, 7),
        grn_id: g.id, invoice_no: g.grnNo, ref_no: g.supplierInvoiceNo ?? "—",
        bill_type: g.isCredit ? "Credit purchase" : "Cash purchase",
        supplier: g.supplierName ?? "Cash supplier", supplier_group: "N/A",
        entered_by: data.me.name,
        qty: l.qty, unit_cost: l.unitCost ?? 0,
        landed_cost: l.landedCost ?? l.unitCost ?? 0,
        amount: round2((l.landedCost ?? l.unitCost ?? 0) * l.qty),
        cost_missing: g.costMissing,
      });
    }
  }
  return out;
}

function purchaseDocs(data: DemoReportData, f: ReportFilters): Row[] {
  return data.deliveries
    .filter((g) => inRange(dhakaDate(g.createdAt), f)
                   && (!f.branchId || g.branchId === f.branchId))
    .map((g): Row => ({
      shop_id: "demo", branch_id: g.branchId,
      branch: data.branches.find((b) => b.id === g.branchId)?.name ?? "—",
      d: dhakaDate(g.createdAt), month: dhakaDate(g.createdAt).slice(0, 7),
      invoice_no: g.grnNo, ref_no: g.supplierInvoiceNo ?? "—",
      bill_type: g.isCredit ? "Credit purchase" : "Cash purchase",
      supplier: g.supplierName ?? "Cash supplier", supplier_group: "N/A",
      entered_by: data.me.name,
      qty: g.lines.reduce((t, l) => t + l.qty, 0),
      total_amt: g.total, discount: 0, charges: 0, vat: 0, ait: 0, amount: g.total,
    }));
}

function stockRows(data: DemoReportData, f: ReportFilters): Row[] {
  const out: Row[] = [];
  for (const b of data.branches) {
    if (f.branchId && b.id !== f.branchId) continue;
    for (const p of data.products) {
      const loose = data.stock[b.id]?.[p.id] ?? 0;
      const serialled = data.serials.filter(
        (s) => s.productId === p.id && s.branchId === b.id && !s.sold && !s.inTransit).length;
      const qty = loose + serialled;
      if (!qty) continue;
      const cost = data.costs[p.id] ?? 0;
      const sold = data.sales
        .filter((s) => s.status === "completed" && s.lines.some((l) => l.productId === p.id))
        .map((s) => dhakaDate(s.createdAt)).sort().pop() ?? null;
      out.push({
        ...productBits(data, p.id),
        shop_id: "demo", branch_id: b.id, branch: b.name, location: "Main store",
        qty, unit_cost: cost, total_cost: round2(cost * qty),
        reorder_level: p.reorderLevel, last_sold: sold,
        days_since_sale: sold ? daysBetween(sold, f.asOn ?? today()) : null,
      });
    }
  }
  return out;
}

function serialStock(data: DemoReportData, f: ReportFilters): Row[] {
  return data.serials
    .filter((s) => !s.sold && !s.inTransit && (!f.branchId || s.branchId === f.branchId))
    .map((s): Row => ({
      ...productBits(data, s.productId),
      shop_id: "demo", branch_id: s.branchId,
      branch: data.branches.find((b) => b.id === s.branchId)?.name ?? "—",
      serial: s.serial, status: "in_stock",
      invoice_no: deliveryFor(data, s.productId) ?? "Opening stock",
      supplier: "—", d: today(), age_days: 0,
      unit_cost: data.costs[s.productId] ?? 0, one: 1,
    }));
}

function journalRows(data: DemoReportData, f: ReportFilters): Row[] {
  const out: Row[] = [];
  for (const e of data.journal) {
    if (e.status !== "posted") continue;
    if (!inRange(e.date, f)) continue;
    if (f.branchId && e.branchId !== f.branchId) continue;
    for (const l of e.lines) {
      const a = data.accounts.find((x) => x.id === l.accountId);
      const party = l.customerId
        ? data.customers.find((c) => c.id === l.customerId)?.name
        : l.supplierId ? data.suppliers.find((s) => s.id === l.supplierId)?.name : null;
      out.push({
        shop_id: "demo", branch_id: e.branchId,
        branch: data.branches.find((b) => b.id === e.branchId)?.name ?? "—",
        d: e.date, month: e.date.slice(0, 7), entry_id: e.id, entry_no: e.entryNo,
        narration: e.narration, source_kind: e.sourceKind, source_id: null,
        status: e.status, entered_by: e.who,
        account_id: l.accountId, account_code: a?.code ?? "—", account: a?.name ?? "—",
        account_role: a?.role ?? null, account_group: a?.group ?? "—",
        nature: a?.nature ?? "asset",
        debit: l.debit, credit: l.credit, note: l.note,
        customer_id: l.customerId, supplier_id: l.supplierId, bank_account_id: null,
        party: party ?? "—", cheque_no: null, cheque_date: null, bank: "—",
        ref_no: e.entryNo, mode: a?.role === "cash_in_hand" ? "Cash" : "Transfer",
        voucher_type: e.sourceKind === "voucher" ? voucherKind(data, e) : "auto",
      });
    }
  }
  return out;
}

function voucherKind(data: DemoReportData, e: DemoReportEntry): string {
  const roles = e.lines.map((l) =>
    data.accounts.find((a) => a.id === l.accountId)?.role ?? null);
  const money = (r: string | null) => r === "cash_in_hand" || r === "bank" || r === "wallet";
  if (roles.filter(money).length === 2) return "contra";
  if (e.lines.some((l, i) => l.debit > 0 && money(roles[i]))) return "receipt";
  if (e.lines.some((l, i) => l.credit > 0 && money(roles[i]))) return "payment";
  return "journal";
}

const today = (): string => dhakaDate(new Date().toISOString());
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

function datasetRows(dataset: string, data: DemoReportData, f: ReportFilters): Row[] | null {
  switch (dataset) {
    case "sale_lines": return saleLines(data, f);
    case "sale_docs": return saleDocs(data, f);
    case "return_lines": return returnLines(data, f);
    case "net_sales": return netSales(data, f);
    case "purchase_lines": return purchaseLines(data, f);
    case "purchase_docs": return purchaseDocs(data, f);
    case "stock_as_on": return stockRows(data, f);
    case "serial_stock": return serialStock(data, f);
    case "journal": case "vouchers": return journalRows(data, f);
    case "income_lines":
      return journalRows(data, f).filter((r) => r.nature === "income")
        .map((r) => ({ ...r, amount: round2((r.credit as number) - (r.debit as number)) }));
    case "expense_lines":
      return journalRows(data, f).filter((r) => r.nature === "expense")
        .map((r) => ({ ...r, amount: round2((r.debit as number) - (r.credit as number)) }));
    case "cheques":
      return data.cheques
        .filter((c) => inRange(c.chequeDate, f) && (!f.branchId || c.branchId === f.branchId))
        .map((c): Row => ({
          shop_id: "demo", branch_id: c.branchId,
          branch: data.branches.find((b) => b.id === c.branchId)?.name ?? "—",
          d: c.chequeDate, month: c.chequeDate.slice(0, 7), cheque_no: c.chequeNo,
          direction: c.direction === "issued" ? "We wrote it" : "Somebody gave us one",
          status: c.status === "issued" ? "Not settled yet"
            : `${c.status.charAt(0).toUpperCase()}${c.status.slice(1)}`,
          party: c.party ?? "—", bank: c.bank ?? "—", amount: c.amount,
          settled_on: c.settledOn, bounced_reason: null, entered_by: data.me.name,
        }));
    case "traders":
      return [
        ...data.customers.map((c): Row => ({
          shop_id: "demo", kind: "customer", trader_group: c.group ?? "Retail",
          code: c.phone, name: c.name, address: c.address ?? "—", mobile: c.phone,
          company: c.company ?? "—", opening: c.openingBalance, active: true,
        })),
        ...data.suppliers.map((s): Row => ({
          shop_id: "demo", kind: "supplier", trader_group: "N/A",
          code: s.phone ?? "—", name: s.name, address: s.address ?? "—",
          mobile: s.phone ?? "—", company: "—", opening: 0, active: true,
        })),
      ];
    case "claims":
      return data.claims
        .filter((c) => inRange(dhakaDate(c.createdAt), f)
                       && (!f.branchId || c.branchId === f.branchId))
        .map((c): Row => ({
          shop_id: "demo", branch_id: c.branchId,
          branch: c.branch, d: dhakaDate(c.createdAt),
          month: dhakaDate(c.createdAt).slice(0, 7),
          claim_no: c.claimNo, status: c.status.replace(/_/g, " "),
          trader: c.customerName ?? "—",
          product: c.product ?? "—", serial: c.serial ?? "—",
          fault: c.problemType ?? c.problem,
          technician: c.technician ?? "—", supplier: c.supplier ?? "—",
          in_warranty: c.inWarranty, warranty_until: c.warrantyUntil,
          days_open: c.daysWaiting,
        }));
    case "in_transit":
      return data.transfers
        .filter((t) => t.status === "in_transit" || t.status === "disputed")
        .map((t): Row => ({
          shop_id: "demo", branch_id: t.fromBranchId, branch: t.fromBranchName,
          to_branch: t.toBranchName, transfer_no: t.transferNo,
          d: dhakaDate(t.sentAt),
          days_out: daysBetween(dhakaDate(t.sentAt), today()),
          status: t.status === "in_transit" ? "On the road" : "Short on arrival — needs settling",
          product: t.lines.map((l) => l.product).join(", "),
          category: "N/A", code: "—", model: "—", product_id: null,
          qty: t.lines.reduce((n, l) => n + l.qty - l.receivedQty, 0),
          amount: t.totalCost,
        }));
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// The engine: group, total at every level, work out the percentages
// ---------------------------------------------------------------------------

function measuresOf(def: ReportDef): string[] {
  const out: string[] = [];
  for (const c of def.columns ?? []) {
    if ((c.t === "qty" || c.t === "money" || c.t === "num")
        && (!c.calc || c.calc === "average") && !out.includes(c.f)) out.push(c.f);
  }
  return out;
}

/** What "the amount", "the quantity", "the cost" and "the profit" are called here. */
const FIELDS: Record<string, { amount?: string; qty?: string; cost?: string; profit?: string }> = {
  net_sales: { amount: "sale_amount", qty: "sale_qty", cost: "cost", profit: "profit" },
  net_purchase: { amount: "purchase_amount", qty: "purchase_qty", cost: "purchase_amount" },
  stock_as_on: { amount: "total_cost", qty: "qty", cost: "total_cost" },
  dusty: { amount: "stock_value", qty: "qty", cost: "stock_value" },
  purchase_lines: { amount: "amount", qty: "qty", cost: "amount" },
  purchase_docs: { amount: "amount", qty: "qty", cost: "amount" },
  serial_stock: { amount: "unit_cost", qty: "one", cost: "unit_cost" },
};
const defaultFields = { amount: "amount", qty: "qty", cost: "cost", profit: "profit" };

function applyCalcs(def: ReportDef, row: Row, dataset: string): void {
  const names = { ...defaultFields, ...(FIELDS[dataset] ?? {}) };
  for (const c of def.columns ?? []) {
    if (!c.calc) continue;
    let a: string | undefined;
    let b: string | undefined;
    if (c.calc === "average") { a = c.f; b = "_rows"; }
    else if (c.calc === "avg_price") { a = names.amount; b = names.qty; }
    else if (c.calc === "avg_cost") { a = names.cost; b = names.qty; }
    else if (c.calc === "profit_pct") { a = names.profit; b = names.amount; }
    else { a = names.profit; b = names.cost; }
    const num = a ? Number(row[a] ?? 0) : null;
    const den = b ? Number(row[b] ?? 0) : null;
    row[c.f] = num === null || !den ? null
      : c.t === "pct" ? Math.round((num / den) * 1000) / 10 : round2(num / den);
  }
}

function grouped(def: ReportDef, rows: Row[], dataset: string): {
  rows: ReportRow[]; totals: ReportRow;
} {
  const groups = def.groupBy ?? [];
  const meas = measuresOf(def);
  const textCols = (def.columns ?? [])
    .filter((c: ReportColumn) => (c.t === "text" || c.t === "date") && !groups.includes(c.f));

  // One bucket per combination, outermost group first — which is what gives the
  // subtotals: a row is the total of every bucket that starts with its own keys.
  const blank = (): Row => {
    const r: Row = { _rows: 0 };
    for (const m of meas) r[m] = 0;
    return r;
  };
  const add = (into: Row, from: Row): void => {
    into._rows = (into._rows as number) + 1;
    for (const m of meas) into[m] = round2((into[m] as number) + Number(from[m] ?? 0));
  };

  const leaves = new Map<string, { keys: string[]; agg: Row; first: Row }>();
  for (const r of rows) {
    const keys = groups.map((g) => String(r[g] ?? "—"));
    const k = keys.join("\u0000");
    const got = leaves.get(k) ?? { keys, agg: blank(), first: r };
    add(got.agg, r);
    leaves.set(k, got);
  }

  const sorted = [...leaves.values()].sort((a, b) => {
    for (let i = 0; i < groups.length - 1; i += 1) {
      const c = a.keys[i].localeCompare(b.keys[i]);
      if (c) return c;
    }
    if (def.sortDesc) {
      const d = Number(b.agg[def.sortDesc] ?? 0) - Number(a.agg[def.sortDesc] ?? 0);
      if (d) return d;
    }
    return a.keys[groups.length - 1].localeCompare(b.keys[groups.length - 1]);
  });

  const out: ReportRow[] = [];
  const total = blank();
  const open: { level: number; keys: string[]; agg: Row }[] = [];
  const close = (downTo: number): void => {
    while (open.length > downTo) {
      const o = open.pop()!;
      const row: Row = { _kind: "subtotal", _level: o.level, ...o.agg };
      groups.slice(0, o.level).forEach((g, i) => { row[g] = o.keys[i]; });
      applyCalcs(def, row, dataset);
      out.push(row as ReportRow);
    }
  };

  let shown = 0;
  for (const leaf of sorted) {
    // Close and open the subtotal levels this row changes.
    let same = 0;
    while (same < open.length && open[same].keys[same] === leaf.keys[same]) same += 1;
    close(same);
    for (let lvl = open.length; lvl < groups.length - 1; lvl += 1) {
      open.push({ level: lvl + 1, keys: leaf.keys.slice(0, lvl + 1), agg: blank() });
    }
    for (const o of open) add(o.agg, leaf.agg);
    add(total, leaf.agg);

    shown += 1;
    const top = def.topDefault;
    if (top && shown > top) continue;
    const row: Row = { _kind: "detail", _level: groups.length, ...leaf.agg };
    groups.forEach((g, i) => { row[g] = leaf.keys[i]; });
    for (const c of textCols) row[c.f] = leaf.first[c.f] ?? null;
    applyCalcs(def, row, dataset);
    out.push(row as ReportRow);
  }
  close(0);

  const totals: Row = { _kind: "total", _level: 0, ...total };
  applyCalcs(def, totals, dataset);
  return { rows: out, totals: totals as ReportRow };
}

function pivot(def: ReportDef, rows: Row[]): {
  columns: ReportColumnOut[]; rows: ReportRow[]; totals: ReportRow;
} {
  const { row: rowF, col: colF, value: valF } = def.pivot!;
  const cols = [...new Set(rows.map((r) => String(r[colF] ?? "—")))].sort();
  const byRow = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = String(r[rowF] ?? "—");
    const got = byRow.get(k) ?? {};
    const c = String(r[colF] ?? "—");
    got[c] = round2((got[c] ?? 0) + Number(r[valF] ?? 0));
    byRow.set(k, got);
  }
  const kind: ReportColumnOut["t"] = valF.includes("qty") ? "qty" : "money";
  const columns: ReportColumnOut[] = [
    TEXT("_row", rowF.replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase())),
    ...cols.map((c) => col(c, c, kind)),
    col("_total", "Total", kind),
  ];
  const out: ReportRow[] = [];
  const totals: Row = { _row: "Total", _kind: "total", _level: 0, _total: 0 };
  for (const [name, cells] of [...byRow.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sum = Object.values(cells).reduce((t, n) => t + n, 0);
    out.push({ _row: name, _kind: "detail", _level: 1, _total: round2(sum), ...cells } as ReportRow);
    for (const c of cols) totals[c] = round2(Number(totals[c] ?? 0) + (cells[c] ?? 0));
    totals._total = round2(Number(totals._total) + sum);
  }
  return { columns, rows: out, totals: totals as ReportRow };
}

// ---------------------------------------------------------------------------
// The reports that are not a grouped list
// ---------------------------------------------------------------------------

interface Balance {
  accountId: string; code: string; name: string; group: string; nature: string;
  role: string | null; branch: string | null;
  debit: number; credit: number; balance: number;
}

function balances(data: DemoReportData, f: ReportFilters, upToOnly = false): Balance[] {
  return data.accounts.map((a) => {
    let debit = 0;
    let credit = 0;
    for (const e of data.journal) {
      if (e.status !== "posted") continue;
      if (f.branchId && e.branchId !== f.branchId) continue;
      if (upToOnly) {
        if (f.asOn && e.date > f.asOn) continue;
      } else if (!inRange(e.date, f)) continue;
      for (const l of e.lines) {
        if (l.accountId !== a.id) continue;
        debit += l.debit;
        credit += l.credit;
      }
    }
    const up = a.nature === "asset" || a.nature === "expense";
    return {
      accountId: a.id, code: a.code, name: a.name, group: a.group, nature: a.nature,
      role: a.role,
      branch: data.branches.find((b) => b.id === a.branchId)?.name ?? null,
      debit: round2(debit), credit: round2(credit),
      balance: round2(up ? debit - credit : credit - debit),
    };
  });
}

/** The account's name with its branch — but never the branch twice, because a
 *  per-branch cash account is already called "Cash in hand — Main branch". */
function accountLabel(name: string, branch: string | null): string {
  if (!branch) return name;
  return name.toLowerCase().includes(branch.toLowerCase()) ? name : `${name} (${branch})`;
}

const twoCol = (label: string): ReportColumnOut[] =>
  [TEXT("particulars", label), MONEY("amount", "Amount")];
const line = (particulars: string, amount: number, kind: ReportRow["_kind"] = "detail",
              extra: Row = {}): ReportRow =>
  ({ particulars, amount: round2(amount), _kind: kind,
     _level: kind === "detail" ? 1 : 0, ...extra }) as ReportRow;

function special(
  def: ReportDef, data: DemoReportData, f: ReportFilters,
): Partial<ReportResult> {
  switch (def.special) {
    case "trial_balance": {
      const rows: ReportRow[] = [];
      let td = 0;
      let tc = 0;
      let group: string | null = null;
      let gd = 0;
      let gc = 0;
      const live = balances(data, f).filter((b) => b.debit !== 0 || b.credit !== 0)
        .sort((a, b) => a.group.localeCompare(b.group) || a.code.localeCompare(b.code));
      for (const b of live) {
        if (group !== null && b.group !== group) {
          rows.push({ particulars: `${group} total`, debit: round2(gd), credit: round2(gc),
                      _kind: "subtotal", _level: 1 } as ReportRow);
          gd = 0; gc = 0;
        }
        group = b.group;
        const net = round2(b.debit - b.credit);
        const d = net > 0 ? net : 0;
        const c = net < 0 ? -net : 0;
        gd += d; gc += c; td += d; tc += c;
        rows.push({ code: b.code, group: b.group, account_id: b.accountId,
                    particulars: accountLabel(b.name, b.branch),
                    debit: d, credit: c, _kind: "detail", _level: 2 } as ReportRow);
      }
      if (group !== null) {
        rows.push({ particulars: `${group} total`, debit: round2(gd), credit: round2(gc),
                    _kind: "subtotal", _level: 1 } as ReportRow);
      }
      return {
        columns: [TEXT("code", "Code"), TEXT("particulars", "Particulars"),
                  MONEY("debit", "Debit"), MONEY("credit", "Credit")],
        rows,
        totals: { particulars: "Total", debit: round2(td), credit: round2(tc),
                  _kind: "total", _level: 0 } as ReportRow,
        balanced: round2(td) === round2(tc),
        drill: "account_id",
      };
    }
    case "layer_summary": {
      const by = new Map<string, { d: number; c: number; nature: string }>();
      for (const b of balances(data, f)) {
        const net = round2(b.debit - b.credit);
        if (!net) continue;
        const got = by.get(b.group) ?? { d: 0, c: 0, nature: b.nature };
        if (net > 0) got.d += net; else got.c -= net;
        by.set(b.group, got);
      }
      let td = 0;
      let tc = 0;
      const rows: ReportRow[] = [...by.entries()].map(([g, v]) => {
        td += v.d; tc += v.c;
        return { particulars: g, nature: v.nature, debit: round2(v.d), credit: round2(v.c),
                 _kind: "detail", _level: 1 } as ReportRow;
      });
      return {
        columns: [TEXT("particulars", "Account group"), TEXT("nature", "Kind"),
                  MONEY("debit", "Debit"), MONEY("credit", "Credit")],
        rows,
        totals: { particulars: "Total", debit: round2(td), credit: round2(tc),
                  _kind: "total", _level: 0 } as ReportRow,
      };
    }
    case "chart":
      return {
        columns: [TEXT("nature", "Main Group"), TEXT("particulars", "Sub Group"),
                  TEXT("code", "Code"), TEXT("name", "Account Name"),
                  TEXT("branch", "Branch"), TEXT("role", "What it is for")],
        rows: data.accounts.map((a) => ({
          nature: a.nature.charAt(0).toUpperCase() + a.nature.slice(1),
          particulars: a.group, code: a.code, name: a.name, account_id: a.id,
          branch: data.branches.find((b) => b.id === a.branchId)?.name ?? null,
          role: a.role ? a.role.replace(/_/g, " ") : "—",
          _kind: "detail", _level: 1,
        }) as ReportRow),
        totals: null, drill: "account_id",
      };
    case "profit_loss": {
      const b = balances(data, f);
      const sum = (pick: (x: Balance) => boolean): number =>
        round2(b.filter(pick).reduce((t, x) => t + x.balance, 0));
      const sales = sum((x) => x.role === "sales");
      const returns = sum((x) => x.role === "sales_return");
      const disc = sum((x) => x.role === "discount_given");
      const cogs = sum((x) => x.role === "cogs");
      const net = round2(sales - returns - disc);
      const gross = round2(net - cogs);
      const over = b.filter((x) => x.nature === "expense" && x.group !== "Direct costs"
                                   && x.balance !== 0);
      const overTotal = round2(over.reduce((t, x) => t + x.balance, 0));
      const rows: ReportRow[] = [
        line("Sales", sales), line("Less: sales returns", -returns),
        line("Less: discounts given", -disc), line("Net sales", net, "subtotal"),
        line("Cost of goods sold", -cogs), line("Gross profit", gross, "subtotal"),
        ...over.map((x) => line(x.name, -x.balance, "detail", { account_id: x.accountId })),
        line("Total running costs", -overTotal, "subtotal"),
      ];
      const profit = round2(gross - overTotal);
      return {
        columns: twoCol("A/C Ledger Name"), rows,
        totals: line(profit >= 0 ? "Profit for the period" : "Loss for the period",
                     profit, "total"),
        drill: "account_id",
      };
    }
    case "balance_sheet": {
      const b = balances(data, f, true);
      const assets = b.filter((x) => x.nature === "asset" && x.balance !== 0);
      const liab = b.filter((x) => (x.nature === "liability" || x.nature === "equity")
                                   && x.balance !== 0);
      const profit = round2(
        b.filter((x) => x.nature === "income").reduce((t, x) => t + x.balance, 0)
        - b.filter((x) => x.nature === "expense").reduce((t, x) => t + x.balance, 0));
      const aTotal = round2(assets.reduce((t, x) => t + x.balance, 0));
      const lTotal = round2(liab.reduce((t, x) => t + x.balance, 0) + profit);
      return {
        columns: twoCol("Particulars"),
        rows: [],
        sections: [
          { title: "What the shop owes and the owner's money",
            columns: twoCol("Liabilities"),
            rows: [
              ...liab.map((x) => line(x.name, x.balance, "detail",
                                      { group: x.group, account_id: x.accountId })),
              line(profit >= 0 ? "Profit to date" : "Loss to date", profit, "detail",
                   { group: "Capital" }),
            ],
            totals: line("Total", lTotal, "total") },
          { title: "What the shop owns", columns: twoCol("Assets"),
            rows: assets.map((x) => line(
              accountLabel(x.name, x.branch), x.balance, "detail",
              { group: x.group, account_id: x.accountId })),
            totals: line("Total", aTotal, "total") },
        ],
        totals: line("Difference", round2(aTotal - lTotal), "total"),
        balanced: round2(aTotal) === round2(lTotal),
        drill: "account_id",
      };
    }
    case "ledger": case "cash_book": {
      const wanted = def.special === "ledger"
        ? data.accounts.filter((a) => a.id === f.accountId)
        : data.accounts.filter((a) => (def.key === "R-2"
            ? a.role === "bank" || a.role === "wallet" : a.role === "cash_in_hand")
            && (!f.accountId || a.id === f.accountId));
      if (def.special === "ledger" && !f.accountId) throw new Error("PICK_AN_ACCOUNT");
      const columns = [col("d", "Date", "date"), TEXT("entry_no", "Voucher"),
                       TEXT("particulars", "Particulars"), TEXT("narration", "Narration"),
                       MONEY("debit", "Debit"), MONEY("credit", "Credit"),
                       MONEY("balance", "Balance")];
      const sections: ReportSection[] = wanted.map((a) => {
        const up = a.nature === "asset" || a.nature === "expense";
        let run = 0;
        let td = 0;
        let tc = 0;
        const rows: ReportRow[] = [];
        for (const e of [...data.journal].sort((x, y) => x.date.localeCompare(y.date))) {
          if (e.status !== "posted" || !inRange(e.date, f)) continue;
          if (f.branchId && e.branchId !== f.branchId) continue;
          for (const l of e.lines) {
            if (l.accountId !== a.id) continue;
            run = round2(run + (up ? l.debit - l.credit : l.credit - l.debit));
            td += l.debit; tc += l.credit;
            rows.push({
              d: e.date, entry_no: e.entryNo,
              particulars: l.note ?? e.sourceKind.replace(/_/g, " "),
              narration: e.narration, debit: l.debit, credit: l.credit, balance: run,
              entry_id: e.id, _kind: "detail", _level: 1,
            } as ReportRow);
          }
        }
        return {
          title: a.name, columns, rows,
          totals: { particulars: "Total", debit: round2(td), credit: round2(tc),
                    balance: run, _kind: "total", _level: 0 } as ReportRow,
          opening: 0, extra: null,
        };
      });
      if (def.special === "ledger") {
        const s = sections[0];
        if (!s) throw new Error("ACCOUNT_NOT_FOUND");
        return { columns, rows: s.rows, totals: s.totals, opening: 0,
                 account: s.title, drill: "entry_id" };
      }
      if (sections.length === 0) {
        return { columns: twoCol("Particulars"), rows: [], totals: null,
                 noteExtra: "There is no such account on the sample books yet." };
      }
      return { columns, rows: [], sections, totals: null };
    }
    case "day_book": {
      const rows: ReportRow[] = [];
      let td = 0;
      let tc = 0;
      const seen = new Map<string, ReportRow[]>();
      for (const e of data.journal) {
        if (e.status !== "posted" || !inRange(e.date, f)) continue;
        if (f.branchId && e.branchId !== f.branchId) continue;
        const kind = e.sourceKind.replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase());
        const debit = round2(e.lines.reduce((t, l) => t + l.debit, 0));
        const credit = round2(e.lines.reduce((t, l) => t + l.credit, 0));
        td += debit; tc += credit;
        const list = seen.get(kind) ?? [];
        list.push({ kind, d: e.date, entry_no: e.entryNo,
                    particulars: e.narration, narration: e.narration,
                    debit, credit, entry_id: e.id, _kind: "detail", _level: 2 } as ReportRow);
        seen.set(kind, list);
      }
      for (const [kind, list] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        rows.push(...list);
        rows.push({ particulars: `${kind} total`,
                    debit: round2(list.reduce((t, r) => t + Number(r.debit), 0)),
                    credit: round2(list.reduce((t, r) => t + Number(r.credit), 0)),
                    _kind: "subtotal", _level: 1 } as ReportRow);
      }
      return {
        columns: [TEXT("kind", "Kind"), col("d", "Date", "date"),
                  TEXT("entry_no", "Voucher"), TEXT("particulars", "Trader"),
                  MONEY("debit", "Debit"), MONEY("credit", "Credit")],
        rows,
        totals: { particulars: "Total", debit: round2(td), credit: round2(tc),
                  _kind: "total", _level: 0 } as ReportRow,
        drill: "entry_id",
      };
    }
    case "due_list": {
      const cols: ReportColumnOut[] = [
        TEXT("kind", "Kind"), TEXT("trader_group", "Group"), TEXT("particulars", "Name"),
        TEXT("address", "Address"), TEXT("mobile", "Mobile"), MONEY("amount", "Due")];
      const recv: ReportRow[] = [];
      const pay: ReportRow[] = [];
      let tr = 0;
      let tp = 0;
      for (const c of data.customers) {
        const due = round2(
          c.openingBalance
          + data.sales.filter((s) => s.customerId === c.id && s.status === "completed")
              .reduce((t, s) => t + s.dueAmount, 0));
        if (!due) continue;
        const row = { kind: "Customer", trader_group: c.group ?? "Retail",
                      particulars: c.name, address: c.address ?? "—", mobile: c.phone,
                      amount: Math.abs(due), customer_id: c.id,
                      _kind: "detail", _level: 1 } as ReportRow;
        if (due > 0) { recv.push(row); tr += due; } else { pay.push(row); tp -= due; }
      }
      return {
        columns: cols, rows: [],
        sections: [
          { title: "Owed to the shop", columns: cols, rows: recv,
            totals: line("Total owed to the shop", tr, "total"), extra: null },
          { title: "Owed by the shop", columns: cols, rows: pay,
            totals: line("Total owed by the shop", tp, "total"), extra: null },
        ],
        totals: line("Net position", round2(tr - tp), "total"),
      };
    }
    case "stock_valuation": {
      const rows: ReportRow[] = [];
      let shelf = 0;
      for (const b of data.branches) {
        if (f.branchId && b.id !== f.branchId) continue;
        const mine = stockRows(data, { ...f, branchId: b.id });
        const value = round2(mine.reduce((t, r) => t + Number(r.total_cost), 0));
        if (!value && !mine.length) continue;
        shelf += value;
        rows.push(line(`On the shelf at ${b.name}`, value, "detail",
                       { qty: mine.reduce((t, r) => t + Number(r.qty), 0) }));
      }
      const books = round2(balances(data, { ...f, asOn: f.asOn ?? today() }, true)
        .filter((x) => x.role === "inventory").reduce((t, x) => t + x.balance, 0));
      rows.push(line("Stock at cost, counted from the shelves", shelf, "subtotal"));
      rows.push(line("Stock account in the books", books, "subtotal"));
      return {
        columns: [TEXT("particulars", "Particulars"), col("qty", "Qty", "qty"),
                  MONEY("amount", "Value at cost")],
        rows,
        totals: line("Difference", round2(books - shelf), "total"),
        // Nothing to compare the shelves with until the shop keeps books.
        balanced: data.features.accounts ? round2(books) === round2(shelf) : null,
        noteExtra: data.features.accounts ? null
          : "This shop does not keep accounts yet (Settings → Features → Accounts), "
            + "so there is nothing to set the shelves against.",
        stockValue: round2(shelf), stockOnShelves: round2(shelf),
        stockNoCost: 0, stockAccount: books,
      };
    }
    case "vat_report": {
      const sales = saleDocs(data, f);
      const out = round2(sales.reduce((t, s) => t + Number(s.vat), 0));
      const net = round2(sales.reduce((t, s) => t + Number(s.amount) - Number(s.vat), 0));
      const purch = round2(purchaseDocs(data, f).reduce((t, g) => t + Number(g.amount), 0));
      return {
        columns: twoCol("Particulars"),
        rows: [
          line("Sales in the period, before VAT", net),
          line("VAT charged to customers (output VAT)", out, "subtotal"),
          line("Purchases in the period, before VAT", purch),
          line("VAT paid to suppliers (input VAT)", 0, "subtotal"),
        ],
        totals: line(out >= 0 ? "VAT the shop owes" : "VAT the shop can reclaim", out, "total"),
        noteExtra: data.features.vat ? null
          : "This shop does not charge VAT (Settings → Features), so these figures will be nil.",
      };
    }
    case "sales_received": {
      const byWho = new Map<string, { sales: number; discount: number; received: number;
                                      due: number }>();
      for (const s of saleDocs(data, f)) {
        const who = def.key === "A-15" ? String(s.trader) : String(s.trader_group);
        const got = byWho.get(who) ?? { sales: 0, discount: 0, received: 0, due: 0 };
        got.sales = round2(got.sales + Number(s.amount));
        got.discount = round2(got.discount + Number(s.discount));
        got.received = round2(got.received + Number(s.paid_amount));
        got.due = round2(got.due + Number(s.due_amount));
        byWho.set(who, got);
      }
      const rows = [...byWho.entries()].map(([who, v]) => ({
        particulars: who, sales: v.sales, discount: v.discount, received: v.received,
        due: v.due, _kind: "detail", _level: 1,
      }) as ReportRow);
      const t = (k: keyof typeof rows[0]): number =>
        round2(rows.reduce((n, r) => n + Number(r[k as string] ?? 0), 0));
      return {
        columns: [TEXT("particulars", def.key === "A-15" ? "Customer" : "Kind of customer"),
                  MONEY("sales", "Sales"), MONEY("discount", "Discount"),
                  MONEY("received", "Received"), MONEY("due", "Left on due")],
        rows,
        totals: { particulars: "Total", sales: t("sales"), discount: t("discount"),
                  received: t("received"), due: t("due"),
                  _kind: "total", _level: 0 } as ReportRow,
      };
    }
    case "product_status": {
      const rows: ReportRow[] = [];
      for (const p of data.products) {
        const sold = data.sales
          .filter((s) => s.status === "completed" && inRange(dhakaDate(s.createdAt), f)
                         && (!f.branchId || s.branchId === f.branchId))
          .flatMap((s) => s.lines).filter((l) => l.productId === p.id)
          .reduce((t, l) => t + l.qty, 0);
        const closing = stockRows(data, f)
          .filter((r) => r.product_id === p.id)
          .reduce((t, r) => t + Number(r.qty), 0);
        if (!sold && !closing) continue;
        rows.push({
          ...productBits(data, p.id),
          opening: closing + sold, purchased: 0, to_supplier: 0, sold,
          taken_back: 0, found: 0, written_off: 0, sent: 0, received: 0,
          others_in: 0, others_out: 0, closing,
          _kind: "detail", _level: 1,
        } as unknown as ReportRow);
      }
      const t = (k: string): number => round2(rows.reduce((n, r) => n + Number(r[k] ?? 0), 0));
      return {
        columns: [TEXT("category", "Product Group"), TEXT("model", "Model No"),
                  TEXT("product", "Product"), col("opening", "Opening", "qty"),
                  col("sold", "Sold", "qty"), col("closing", "Closing", "qty")],
        rows,
        totals: { product: "Total", opening: t("opening"), sold: t("sold"),
                  closing: t("closing"), _kind: "total", _level: 0 } as ReportRow,
        drill: "product_id",
      };
    }
    case "product_ledger": {
      if (!f.productId) throw new Error("PICK_A_PRODUCT");
      const p = data.products.find((x) => x.id === f.productId);
      const rows: ReportRow[] = [];
      let run = 0;
      for (const s of [...data.sales].reverse()) {
        if (s.status !== "completed" || !inRange(dhakaDate(s.createdAt), f)) continue;
        for (const l of s.lines) {
          if (l.productId !== f.productId) continue;
          run -= l.qty;
          rows.push({ d: dhakaDate(s.createdAt), branch: s.branch,
                      particulars: "Sale", narration: s.invoiceNo, who: s.staff,
                      took_in: 0, paid_out: l.qty, balance: run,
                      _kind: "detail", _level: 1 } as ReportRow);
        }
      }
      return {
        columns: [col("d", "Date", "date"), TEXT("branch", "Branch"),
                  TEXT("particulars", "What happened"), TEXT("narration", "Document"),
                  TEXT("who", "Who"), col("took_in", "In", "qty"),
                  col("paid_out", "Out", "qty"), col("balance", "Balance", "qty")],
        rows,
        totals: { particulars: "Total", balance: run, _kind: "total", _level: 0 } as ReportRow,
        account: p?.name ?? null,
        noteExtra: "In demo mode this shows the sales only; the real one shows every movement.",
      };
    }
    default:
      return {
        columns: twoCol("Particulars"), rows: [], totals: null,
        noteExtra: "This one reads further back than the sample data goes. "
          + "Connect a Supabase project to see it with real figures.",
      };
  }
}

// ---------------------------------------------------------------------------
// The way in
// ---------------------------------------------------------------------------

export function runDemoReport(
  key: string, filters: ReportFilters, data: DemoReportData,
): ReportResult {
  const def = reportByKey(key);
  if (!def) throw new Error(`NO_SUCH_REPORT:${key}`);
  if (def.needs) throw new Error(`NOT_YET:${def.needs}`);
  const setting = data.settings[key] ?? {};
  const f: ReportFilters = { ...filters };

  let body: Partial<ReportResult>;
  if (def.special) {
    body = special(def, data, f);
  } else if (def.pivot) {
    const rows = datasetRows(def.dataset!, data, f) ?? [];
    body = { ...pivot(def, rows), pivot: true };
  } else {
    const rows = datasetRows(def.dataset!, data, f);
    if (rows === null) {
      body = {
        rows: [], totals: null,
        noteExtra: "The sample data in demo mode does not cover this one. "
          + "Connect a Supabase project to see it with real figures.",
      };
    } else {
      body = grouped(def, rows, def.dataset!);
    }
  }

  const columns: ReportColumnOut[] = body.columns ?? (def.columns ?? []).map((c) => ({
    f: c.f, l: setting.captions?.[c.f] ?? c.l, t: c.t,
    calc: c.calc ?? null, cost: Boolean(c.cost),
  }));

  return {
    key, register: def.register, title: setting.title ?? def.title,
    note: def.note ?? null, noteExtra: body.noteExtra ?? null,
    dateMode: def.dateMode ?? "range", landscape: Boolean(def.landscape),
    columns, rows: body.rows ?? [], totals: body.totals ?? null,
    sections: body.sections ?? null, pivot: Boolean(body.pivot),
    balanced: body.balanced ?? null, drill: body.drill ?? null,
    opening: body.opening ?? null, account: body.account ?? null, onOrder: null,
    stockValue: body.stockValue ?? null, stockOnShelves: body.stockOnShelves ?? null,
    stockNoCost: body.stockNoCost ?? null, stockAccount: body.stockAccount ?? null,
    shop: data.shop,
    branch: data.branches.find((b) => b.id === f.branchId)?.name ?? null,
    runAt: new Date().toISOString(), runBy: data.me.name, filters: f,
  };
}
