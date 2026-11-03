/**
 * The five BMS reports a shop hands over on go-live day, read out of their PDFs.
 *
 * BMS cannot export a spreadsheet. What the store can produce is printouts, so these
 * are the printouts: everything the shop knows about its stock, its serial numbers, its
 * suppliers, its customers and who owes what. Each one is turned into exactly the kind
 * of rows the spreadsheet importer already understands, so the review-and-map screen
 * after it does not know or care that the file was a PDF.
 *
 * WHAT MAKES THIS AWKWARD, and what each is handled by:
 *  - The page header and footer repeat on all 151 pages: skipped by recognising them.
 *  - Group and brand headings sit above their products rather than in a column: carried
 *    down onto each row, which is what a spreadsheet would have had in the first place.
 *  - Subtotal and total rows look like data: dropped, after being read, so the import
 *    can be checked against the report's own grand total.
 *  - Long names, addresses and even invoice numbers wrap onto the next line: joined
 *    back together by which column they are under.
 *  - A product's block can break across a page: a block that opens with one heading
 *    instead of two is the same product continuing.
 *  - A phone number like "-1192" or "00000000" is a placeholder BMS made up: blanked,
 *    because a wrong number is worse than none.
 *  - Suppliers were re-entered with an "@23" suffix in 2023 and both copies are still
 *    there: flagged in the review step rather than merged, because only the shop knows
 *    which is the real one.
 *
 * Everything here works on positions, never on a fixed character layout: the x of a
 * word says which column it is in, and the type size says whether it is a heading.
 */
import { isPlaceholderPhone } from "../sale";
import { isNumber, money, type PdfLine, type PdfPage } from "./pdf-text";
import type { Grid } from "./parse";

export type BmsReport =
  | "stock" | "stock_serials" | "due_list" | "suppliers" | "customers";

export interface BmsRead {
  report: BmsReport;
  /** One grid per sheet, in the shape the spreadsheet importer reads. */
  grids: Record<string, Grid>;
  /** What the report's own totals said, so an import can be checked against them. */
  totals: Record<string, number>;
  /** Things a person has to decide, shown in the review step. */
  warnings: string[];
}

const TITLES: [RegExp, BmsReport][] = [
  // The serial one has to be tried first: its title contains the other's.
  [/current stock.*with serial/i, "stock_serials"],
  [/current stock/i, "stock"],
  [/all traders due list|traders due list/i, "due_list"],
  [/supplier information/i, "suppliers"],
  [/customer information/i, "customers"],
];

/** Which report this is, from its printed title. */
export function detectReport(pages: PdfPage[]): BmsReport | null {
  for (const page of pages.slice(0, 2)) {
    for (const line of page.lines.slice(0, 15)) {
      for (const [re, kind] of TITLES) if (re.test(line.text)) return kind;
    }
  }
  return null;
}

/** Page furniture: the shop's own letterhead, the title, and the footer. */
function isFurniture(line: PdfLine): boolean {
  const t = line.text;
  return /^page \d+ of \d+$/i.test(t)
    || /print date ?& ?time/i.test(t)
    || /^\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M\s*(page \d+ of \d+)?$/i.test(t)
    || /^(current stock|all traders due list|supplier information|customer information)/i.test(t)
    // The colon is not optional. Without it this threw away every product whose name
    // begins "Web", "Phone" or "Tel" — fifteen webcams, as it turned out.
    || /^(tel|fax|phone|e-?mal|e-?mail|web)\s*:/i.test(t)
    // Anchored: a supplier really is at "Bcs Computer City, IDB Bhaban", and an
    // unanchored match threw that row away along with the letterhead.
    || /^shop no\b/i.test(t)
    || t === "";
}

const isSubtotal = (t: string): boolean =>
  /sub ?total|grand total|category wise|group wise/i.test(t);

// ---------------------------------------------------------------------------
// Current Stock (Combined), with cost
// ---------------------------------------------------------------------------

/**
 * Group → brand → product, with quantity and cost.
 *
 * A product line is the only kind with four figures to the right of the name, and they
 * always arrive in the same order left to right, so they are read by their order rather
 * than by a measured column position: a six-figure cost shifts left and would fall out
 * of any fixed band.
 */
export function readStock(pages: PdfPage[]): BmsRead {
  const products: Grid = [["Product Code", "Model No/Caption", "Product Group", "Brand", "UoM", "Unit Cost"]];
  const stock: Grid = [["Product Code", "Qty", "Unit Cost", "Total Cost"]];
  const warnings: string[] = [];
  let group = "";
  let brand = "";
  let qtyTotal = 0;
  let costTotal = 0;
  let grandQty: number | null = null;
  let grandCost: number | null = null;

  for (const page of pages) {
    for (const line of page.lines) {
      if (isFurniture(line)) continue;
      if (/^product model/i.test(line.text)) continue;

      const right = line.words.filter((w) => w.x > 320);
      const left = line.words.filter((w) => w.x <= 320);
      const name = left.map((w) => w.text).join(" ").trim();

      if (isSubtotal(line.text)) {
        if (/grand total/i.test(line.text)) {
          const figures = right.map((w) => money(w.text)).filter((n): n is number => n !== null);
          if (figures.length >= 2) { grandQty = figures[0]; grandCost = figures[figures.length - 1]; }
        }
        continue;
      }

      // A heading: one word, no figures. The group sits at the left margin and the
      // brand is indented under it — about five points, which is the only thing
      // telling them apart.
      if (right.length === 0 && name !== "") {
        if (line.x < 44) { group = name; brand = ""; } else { brand = name === "N/A" ? "" : name; }
        continue;
      }

      if (right.length < 4 || name === "") continue;
      const [qtyW, uomW, unitW, totalW] = right;
      const qty = money(qtyW.text);
      const unit = money(unitW.text);
      const total = money(totalW.text);
      if (qty === null || total === null) continue;

      products.push([name, name, group, brand, uomW.text, unit ?? ""]);
      stock.push([name, qty, unit ?? "", total]);
      qtyTotal += qty;
      costTotal += total;
    }
  }

  if (grandQty !== null && Math.abs(grandQty - qtyTotal) > 0.01) {
    warnings.push(
      `The report adds up to ${grandQty} units and these rows add up to ${qtyTotal}. `
      + "Something on the page was not read; check it before importing.",
    );
  }

  return {
    report: "stock",
    grids: { "Products": products, "Opening stock": stock },
    totals: { qty: qtyTotal, cost: round2(costTotal), reportQty: grandQty ?? 0, reportCost: grandCost ?? 0 },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Current Stock (Combined) with Serial And Cost
// ---------------------------------------------------------------------------

interface SerialBlock { code: string; name: string }

/**
 * Per product: every delivery it came in on, and the serial of each unit that has one.
 *
 * The shape is a block per product — two centred headings, then a column header, then
 * the deliveries. A block that opens with ONE heading is the same product carrying on
 * over a page break, so the headings are counted rather than trusted.
 *
 * This is also the only report that says which products are serial-tracked: a product
 * is, if any of its units came with a serial number. BMS has no flag for it.
 */
export function readSerials(pages: PdfPage[]): BmsRead {
  const serials: Grid = [["Product Code", "Product Description", "Serial", "Status",
                          "Invoice No", "Date", "Supplier Name", "Unit Cost"]];
  const kinds: Grid = [["Product Code", "Product Description", "Serial tracked", "Serials counted"]];
  // The only place the shop's stock carries a date: what each delivery was, when it
  // came and what it cost. It is what lets an imported shelf have a stock ageing report
  // instead of 3,397 units that all arrived on go-live day.
  const opening: Grid = [["Product Code", "Qty", "Unit Cost", "Purchase Date"]];

  // Held in an object because `openBlock` below writes to it: TypeScript cannot narrow
  // a `let` that a closure assigns, and this one is read on every line after.
  const state: { block: SerialBlock | null } = { block: null };
  let headings: string[] = [];
  let qtyTotal = 0;
  const counted = new Map<string, {
    name: string; serials: number; qty: number; cost: number; firstOn: string;
  }>();
  let pending: { invoiceNo: string; date: string; supplier: string } | null = null;

  const openBlock = () => {
    if (headings.length === 0) return;
    if (headings.length === 1) {
      // One heading means the page broke mid-product: same product, carry on.
      if (!state.block) state.block = { code: headings[0], name: headings[0] };
    } else {
      state.block = { code: headings[0], name: headings[headings.length - 1] };
    }
    headings = [];
    const b = state.block;
    if (b && !counted.has(b.code)) {
      counted.set(b.code, { name: b.name, serials: 0, qty: 0, cost: 0, firstOn: "" });
    }
  };

  for (const page of pages) {
    for (const line of page.lines) {
      if (isFurniture(line)) continue;

      if (/^invoice no\b/i.test(line.text)) { openBlock(); pending = null; continue; }
      if (isSubtotal(line.text)) { pending = null; continue; }

      // A delivery: its number, date and supplier, all to the left of the figures.
      // The number is long enough to wrap, and what wraps is the tail of it.
      if (line.words.length >= 2 && line.words[0].x < 60 && !isNumber(line.words[0].text)
          && line.words.some((w) => /^\d{2}\/\d{2}\/\d{4}$/.test(w.text))) {
        const [no, ...rest] = line.words;
        const date = rest.find((w) => /^\d{2}\/\d{2}\/\d{4}$/.test(w.text))?.text ?? "";
        const supplier = rest.filter((w) => w.x > 170).map((w) => w.text).join(" ").trim();
        pending = { invoiceNo: no.text, date, supplier };
        continue;
      }
      // The rest of an invoice number, alone under where it started.
      if (pending && line.words.length === 1 && line.words[0].x < 60 && /^\d+$/.test(line.text)) {
        pending.invoiceNo += line.text;
        continue;
      }

      // A unit line: a quantity, a status, sometimes a serial, and a cost.
      const qtyW = line.words.find((w) => w.x > 300 && w.x < 345 && isNumber(w.text));
      const block = state.block;
      if (qtyW && block) {
        const qty = money(qtyW.text) ?? 0;
        qtyTotal += qty;
        const unit = money(line.words.filter((w) => w.x >= 520 && isNumber(w.text)).pop()?.text ?? "");
        const seen = counted.get(block.code);
        if (seen) {
          seen.qty += qty;
          // Weighted, because a product bought twice at two prices has one average cost
          // — which is the figure the books carry and the one BMS prints.
          if (unit !== null) seen.cost += unit * qty;
          // The oldest delivery still on the shelf is what the ageing report is about.
          const on = pending?.date ?? "";
          if (on !== "" && (seen.firstOn === "" || isoOf(on) < isoOf(seen.firstOn))) seen.firstOn = on;
        }
        const status = line.words.find((w) => w.x >= 340 && w.x < 420 && !isNumber(w.text));
        const serial = line.words.find((w) => w.x >= 390 && w.x < 530 && w !== status);
        const cost = line.words.filter((w) => w.x >= 520 && isNumber(w.text)).pop();
        if (serial && serial.text.trim() !== "") {
          serials.push([block.code, block.name, serial.text, status?.text ?? "",
                        pending?.invoiceNo ?? "", pending?.date ?? "", pending?.supplier ?? "",
                        cost ? money(cost.text) ?? "" : ""]);
          if (seen) seen.serials += 1;
        }
        continue;
      }

      // Anything else centred and wordy is one of the block's two headings.
      if (line.x > 120 && line.text !== "") headings.push(line.text);
    }
  }

  for (const [code, v] of counted) {
    kinds.push([code, v.name, v.serials > 0 ? "Yes" : "No", v.serials]);
    if (v.qty > 0) {
      opening.push([code, v.qty, round2(v.cost / v.qty), v.firstOn]);
    }
  }

  return {
    report: "stock_serials",
    grids: { "Serial numbers": serials, "Products": kinds, "Opening stock": opening },
    totals: {
      qty: qtyTotal, products: counted.size, serials: serials.length - 1,
      cost: round2([...counted.values()].reduce((n, v) => n + v.cost, 0)),
    },
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// All Traders Due List
// ---------------------------------------------------------------------------

/**
 * Who owes what, in two halves: what is owed to the shop and what the shop owes.
 *
 * BMS prints both halves as one signed column, so a supplier the shop owes money to
 * reads as a negative. Our books hold a supplier's balance the other way round — "what
 * we owe them" — so the supplier sheet comes out with the sign turned over. A customer
 * keeps the printed sign: a negative there means they are in credit, which is true.
 */
export function readDueList(pages: PdfPage[]): BmsRead {
  const head = ["Name", "Address", "Mobile", "Group", "Due Amount"];
  const customers: Grid = [head];
  const suppliers: Grid = [head];
  const warnings: string[] = [];
  let category = "";
  let group = "";
  let grand: number | null = null;
  let customerTotal = 0;
  let supplierTotal = 0;

  for (const page of pages) {
    for (const line of page.lines) {
      if (isFurniture(line) || /^sl\b/i.test(line.text) || /^receivable$|^payable$/i.test(line.text)) continue;

      if (isSubtotal(line.text)) {
        if (/grand total/i.test(line.text)) {
          const n = line.words.map((w) => money(w.text)).filter((x): x is number => x !== null).pop();
          if (n !== null && n !== undefined) grand = n;
        }
        continue;
      }

      const sl = line.words.find((w) => w.x < 45 && /^\d+$/.test(w.text));
      const amount = line.words.filter((w) => w.x > 500 && isNumber(w.text)).pop();

      if (!sl) {
        // A heading, or the rest of an address. Headings are set bigger.
        if (line.words.length === 1 && line.size > 7.6) {
          if (line.x < 54) { category = line.text; group = ""; } else { group = line.text; }
          continue;
        }
        const rows = /supplier/i.test(category) ? suppliers : customers;
        const last = rows[rows.length - 1];
        if (last && last !== head && line.x > 180) {
          last[1] = `${last[1] ?? ""} ${line.text}`.trim();
        }
        continue;
      }

      const name = line.words.filter((w) => w.x >= 45 && w.x < 185).map((w) => w.text).join(" ").trim();
      const address = line.words.filter((w) => w.x >= 185 && w.x < 410).map((w) => w.text).join(" ").trim();
      const mobile = line.words.filter((w) => w.x >= 410 && w.x < 500).map((w) => w.text).join("").trim();
      const due = amount ? money(amount.text) ?? 0 : 0;
      if (name === "") continue;

      if (/supplier/i.test(category)) {
        suppliers.push([name, address, cleanPhone(mobile), group, round2(-due)]);
        supplierTotal += due;
      } else {
        customers.push([name, address, cleanPhone(mobile), group, round2(due)]);
        customerTotal += due;
      }
    }
  }

  const total = round2(customerTotal + supplierTotal);
  if (grand !== null && Math.abs(grand - total) > 0.01) {
    warnings.push(
      `The report's grand total is ${grand} and these rows come to ${total}. `
      + "Something on the page was not read; check it before importing.",
    );
  }
  warnings.push(...duplicateWarnings([...customers.slice(1), ...suppliers.slice(1)].map((r) => String(r[0]))));
  warnings.push(...phoneWarning(customers.slice(1).map((r) => String(r[2]))));

  return {
    report: "due_list",
    grids: { "Customers": customers, "Suppliers": suppliers },
    totals: { total, reportTotal: grand ?? 0, customers: customers.length - 1, suppliers: suppliers.length - 1 },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Supplier Information / Customer Information
// ---------------------------------------------------------------------------

/** Where each column of the two "Information" reports starts, in points. */
const INFO_COLUMNS: [string, number, number][] = [
  ["Code", 45, 89],
  ["Name", 89, 180],
  ["Address", 180, 320],
  ["Mobile", 320, 392],
  ["Contact Person", 392, 470],
];

/**
 * The supplier or customer list: code, name, address, mobile, contact, opening balance.
 *
 * Names and addresses wrap, and a wrapped line carries no serial number, so a line
 * without one is appended to the row above, column by column. A group heading has no
 * serial number either, but BMS sets it two points bigger, which is what tells them
 * apart — they are otherwise at the same indent as a wrapped name.
 */
export function readInformation(pages: PdfPage[], report: "suppliers" | "customers"): BmsRead {
  const head = ["Code", "Name", "Address", "Mobile", "Contact Person", "Group", "Opening Balance"];
  const rows: Grid = [head];
  let group = "";

  for (const page of pages) {
    for (const line of page.lines) {
      if (isFurniture(line) || /^sl\b/i.test(line.text) || isSubtotal(line.text)) continue;
      if (/^(code|name|address|mobile|contact person|opening balance|by)$/i.test(line.text)) continue;

      const sl = line.words.find((w) => w.x < 45 && /^\d+$/.test(w.text));
      if (!sl) {
        if (line.words.length === 1 && line.size > 7.6) { group = line.text; continue; }
        const last = rows[rows.length - 1];
        if (!last || last === head) continue;
        for (const w of line.words) {
          const col = INFO_COLUMNS.findIndex(([, from, to]) => w.x >= from && w.x < to);
          if (col >= 0) last[col] = `${last[col] ?? ""} ${w.text}`.trim();
        }
        continue;
      }

      const cells: string[] = INFO_COLUMNS.map(([, from, to]) =>
        line.words.filter((w) => w.x >= from && w.x < to).map((x) => x.text).join(" ").trim());
      // The balance is the last figure on the line; whoever entered the row follows it.
      const tail = line.words.filter((w) => w.x >= 470);
      const balance = tail.filter((w) => isNumber(w.text)).pop();
      rows.push([cells[0], cells[1], cells[2], cleanPhone(cells[3]), cells[4], group,
                 balance ? money(balance.text) ?? 0 : 0]);
    }
  }

  return {
    report,
    grids: { [report === "suppliers" ? "Suppliers" : "Customers"]: rows },
    totals: { rows: rows.length - 1 },
    warnings: [
      ...duplicateWarnings(rows.slice(1).map((r) => String(r[1]))),
      ...(report === "customers" ? phoneWarning(rows.slice(1).map((r) => String(r[3]))) : []),
    ],
  };
}

// ---------------------------------------------------------------------------

/**
 * A mobile number, or nothing.
 *
 * BMS will not store a trader without a number, so whoever typed the IDB shops in gave
 * them "-1192", "00000000", "025". Those are not numbers anybody can ring, and keeping
 * them would be worse than keeping none: a customer lookup at the till matches on the
 * phone, so two shops sharing a made-up number would answer to each other's name.
 */
export function cleanPhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits === "") return "";
  if (/^0+$/.test(digits)) return "";
  // A Bangladeshi mobile is 11 digits starting 01, or 13 with the 88 country code —
  // and not one of the right-shaped but made-up ones like 01000000000.
  const local = /^8801\d{9}$/.test(digits) ? digits.slice(2) : digits;
  if (!/^01\d{9}$/.test(local)) return "";
  return isPlaceholderPhone(local) ? "" : local;
}

/**
 * Names that differ only by an "@23"-style suffix.
 *
 * The shop re-entered its traders in 2023 and marked the new copies, so both are in the
 * list and both carry a balance. Merging them here would be guessing; the review step
 * says which pairs it found and leaves the decision where it belongs.
 */
export function duplicateWarnings(names: string[]): string[] {
  // The marker is a two-digit year with an @ beside it, at the end: "@23", "23@",
  // " 23@". The @ is what makes it safe to strip — a product or a trader whose name
  // simply ends in two digits is left alone.
  const key = (n: string) => n.toLowerCase()
    .replace(/[\s.,]*(?:@\s*\d{2}|\d{2}\s*@)[\s.,]*$/, "")
    .replace(/[^a-z0-9]/g, "");
  const seen = new Map<string, string[]>();
  for (const n of names) {
    const k = key(n);
    if (k === "") continue;
    seen.set(k, [...(seen.get(k) ?? []), n]);
  }
  const out: string[] = [];
  for (const group of seen.values()) {
    const unique = [...new Set(group)];
    if (unique.length > 1) {
      out.push(`"${unique.join('" and "')}" look like the same trader entered twice. `
        + "Import both and merge them afterwards, or take one out of the file.");
    }
  }
  return out;
}

/**
 * How many customers came through with no number anybody can ring.
 *
 * Not a problem, but worth saying before somebody wonders where the numbers went: most
 * of the IDB shops never had one, and whoever typed them in put "-1192" to get past
 * BMS's required field. Those are dropped and the customers come in under their names,
 * which is also how the till finds them afterwards.
 */
export function phoneWarning(phones: string[]): string[] {
  const missing = phones.filter((p) => p.trim() === "").length;
  if (missing === 0) return [];
  return [
    `${missing} of these ${phones.length} have no real mobile number — BMS was given `
    + `things like "-1192" to get past its own required field, and those are not numbers `
    + "anybody can ring. They are dropped, and those customers come in under their names; "
    + "the till finds them by name too.",
  ];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** "16/09/2026" as something that sorts. */
const isoOf = (d: string): string => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d;
};

/** Read whichever of the five reports this is. */
export function readBmsPdf(pages: PdfPage[]): BmsRead {
  const report = detectReport(pages);
  switch (report) {
    case "stock": return readStock(pages);
    case "stock_serials": return readSerials(pages);
    case "due_list": return readDueList(pages);
    case "suppliers": return readInformation(pages, "suppliers");
    case "customers": return readInformation(pages, "customers");
    default:
      throw new Error(
        "That PDF isn't one of the BMS reports this can read. It takes Current Stock "
        + "(Combined) with cost, the same report with serials, All Traders Due List, "
        + "Supplier Information and Customer Information.",
      );
  }
}
