import {
  cleanCode, cleanPhone, isSoldStatus, parseBool, parseMoney, parseQty, parseWarrantyMonths,
} from "./clean";
import type { Mapping } from "./parse";
import { kindSpec, type ImportKind } from "./schema";

export type RowVerdict = "add" | "update" | "skip" | "problem";

/** What to call the thing that was repeated, so the message reads naturally. */
const DUP_WORD: Record<ImportKind, string> = {
  products: "code",
  prices: "code",
  stock: "code",
  serials: "serial number",
  customers: "mobile number",
  suppliers: "name",
};

export interface ReviewedRow {
  /** 1-based row number in the file, so a message can point at it. */
  line: number;
  verdict: RowVerdict;
  /** Plain words. Shown as-is. */
  reason: string;
  /** The cleaned values, ready for the import function. */
  values: Record<string, string | number | boolean | null>;
}

export interface ReviewResult {
  rows: ReviewedRow[];
  counts: Record<RowVerdict, number>;
  /** Codes (or phones) that appear more than once in the file. */
  duplicates: string[];
}

export interface ReviewInput {
  kind: ImportKind;
  rows: Record<string, string>[];
  mapping: Mapping;
  /** Codes (or phone numbers) the shop already has, so a row can be called an update
   *  rather than an add. */
  existingKeys?: Set<string>;
  /** Accepted category/brand corrections: from → to. */
  renames?: Record<string, string>;
  /** For stock and serials: product codes that exist, so a row for something the
   *  catalogue has never heard of is flagged instead of silently dropped. */
  knownProductCodes?: Set<string>;
  /**
   * Warranty in months, per product group, for files that carry no warranty column.
   *
   * No BMS report has one — the shop keeps it in its head ("adapters, six months") —
   * and setting it 1,600 times by hand afterwards is not something anybody would do.
   * It only fills a gap: a row that states its own warranty keeps it.
   */
  warrantyByGroup?: Record<string, number>;
}

/**
 * The field every row of this kind is identified by — what makes two rows "the same row".
 *
 * For serials this is the SERIAL, not the product code: a product has many serials, and
 * keying on the code would throw away every serial after the first.
 */
export function keyField(kind: ImportKind): string {
  // A customer is known by their number when they have one. Most of the traders that
  // came over from BMS do not, so theirs is their name.
  if (kind === "customers") return "phone";
  if (kind === "suppliers") return "name";
  if (kind === "serials") return "serial";
  return "code";
}

/**
 * Decide what will happen to every row, before anything is written.
 *
 * The verdicts are deliberately four, not two: "skip" is for rows that are fine but
 * have nothing to do (an already-sold serial), and "problem" is for rows that cannot be
 * imported. Collapsing them would either hide real errors or make a clean file look
 * broken.
 */
export function reviewRows(input: ReviewInput): ReviewResult {
  const spec = kindSpec(input.kind);
  const key = keyField(input.kind);
  const renames = input.renames ?? {};
  const seen = new Map<string, number>();
  const rows: ReviewedRow[] = [];

  for (let i = 0; i < input.rows.length; i++) {
    const raw = input.rows[i];
    const line = i + 1;
    const values: Record<string, string | number | boolean | null> = {};
    const problems: string[] = [];

    for (const field of spec.fields) {
      const header = input.mapping[field.key];
      const cell = header ? (raw[header] ?? "") : "";

      if (cell === "") {
        if (field.required) problems.push(`${field.label.toLowerCase()} is empty`);
        values[field.key] = null;
        continue;
      }

      switch (field.type) {
        case "money": {
          const n = parseMoney(cell);
          if (n === null) problems.push(`"${cell}" isn't a ${field.label.toLowerCase()}`);
          else if (n < 0 && !field.allowNegative) problems.push(`${field.label.toLowerCase()} can't be negative`);
          values[field.key] = n;
          break;
        }
        case "number": {
          const n = parseQty(cell);
          if (n === null) problems.push(`"${cell}" isn't a number`);
          else if (n < 0) problems.push(`${field.label.toLowerCase()} can't be negative`);
          values[field.key] = n;
          break;
        }
        case "warranty":
          values[field.key] = parseWarrantyMonths(cell);
          break;
        case "phone": {
          const p = cleanPhone(cell);
          // BMS stores "2026-01-01" as the mobile for every walk-in, so a bad number is
          // normal rather than exceptional: say so plainly.
          if (!p && field.required) problems.push(`"${cell}" isn't a mobile number`);
          values[field.key] = p;
          break;
        }
        case "bool":
          values[field.key] = parseBool(cell);
          break;
        default: {
          const t = field.key === "code" ? cleanCode(cell) : cell.trim();
          values[field.key] = renames[t] ?? t;
        }
      }
    }

    // The group's warranty, where the file had none of its own.
    const group = String(values.category ?? "");
    if (input.warrantyByGroup && values.warranty == null && group !== ""
        && input.warrantyByGroup[group] != null) {
      values.warranty = input.warrantyByGroup[group];
    }

    // A customer with no number is known by name, so that is what makes two rows the
    // same row — and a row with neither is nobody.
    const id = input.kind === "customers" && !values.phone
      ? String(values.name ?? "").trim().toLowerCase()
      : String(values[key] ?? "");
    if (input.kind === "customers" && id === "") {
      rows.push({ line, verdict: "problem", values,
        reason: "No mobile number and no name, so there would be nothing to call them by" });
      continue;
    }

    if (problems.length > 0) {
      rows.push({ line, verdict: "problem", reason: capitalise(problems.join("; ")), values });
      continue;
    }

    // Already-sold serials are not a problem, they are just not stock.
    if (input.kind === "serials" && isSoldStatus(String(raw[input.mapping.status] ?? ""))) {
      rows.push({ line, verdict: "skip", reason: "Already sold in the old system, so not brought in as stock", values });
      continue;
    }

    if (seen.has(id)) {
      rows.push({
        line, verdict: "skip",
        reason: `The same ${DUP_WORD[input.kind]} is on line ${seen.get(id)} too, so this one is ignored`,
        values,
      });
      continue;
    }
    seen.set(id, line);

    if ((input.kind === "stock" || input.kind === "serials") && input.knownProductCodes
        && !input.knownProductCodes.has(String(values.code ?? ""))) {
      rows.push({
        line, verdict: "problem",
        reason: `There is no product with the code ${values.code}. Import the products first.`,
        values,
      });
      continue;
    }

    const exists = input.existingKeys?.has(id) ?? false;
    rows.push({
      line,
      verdict: exists ? "update" : "add",
      reason: exists ? "Already in the shop, so it will be updated" : "New, so it will be added",
      values,
    });
  }

  const counts: Record<RowVerdict, number> = { add: 0, update: 0, skip: 0, problem: 0 };
  for (const r of rows) counts[r.verdict] += 1;

  const duplicates = [...seen.keys()].filter(
    (k) => rows.filter((r) => String(r.values[key] ?? "") === k).length > 1,
  );

  return { rows, counts, duplicates };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The rows that will actually be sent. Problems and skips are left behind. */
export function importableRows(result: ReviewResult): Record<string, string | number | boolean | null>[] {
  return result.rows.filter((r) => r.verdict === "add" || r.verdict === "update").map((r) => r.values);
}
