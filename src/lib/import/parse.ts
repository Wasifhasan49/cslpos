import { kindSpec, type FieldSpec, type ImportKind } from "./schema";

/** A spreadsheet as a grid of cells, before anyone has decided what the columns mean. */
export type Grid = (string | number | null)[][];

const text = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).replace(/ /g, " ").trim();

/**
 * Find the header row.
 *
 * BMS puts the report name and the print date above the headers, and sometimes a blank
 * row after them, so the header is rarely row 1. The header is the first row that has
 * several non-empty cells AND looks like labels rather than data — the giveaway being
 * that the row below it has the same number of filled cells.
 */
export function findHeaderRow(grid: Grid): number {
  let best = -1;
  let bestFilled = 0;

  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    const filled = (grid[i] ?? []).filter((c) => text(c) !== "").length;
    if (filled < 2) continue;

    // A title row is one long cell; a header row is several short ones.
    const cells = (grid[i] ?? []).map(text).filter((c) => c !== "");
    const allShortish = cells.every((c) => c.length <= 40);
    if (!allShortish) continue;

    // Headers are labels, so they are mostly not numbers.
    const numeric = cells.filter((c) => /^[\d,.\s]+$/.test(c)).length;
    if (numeric > cells.length / 2) continue;

    if (filled > bestFilled) {
      best = i;
      bestFilled = filled;
    }
    // Two or more columns of labels followed by a row of similar width is enough.
    if (filled >= 3) {
      const next = (grid[i + 1] ?? []).filter((c) => text(c) !== "").length;
      if (next >= Math.max(2, filled - 2)) return i;
    }
  }
  return best;
}

export interface Sheet {
  /** Header names as they appear in the file, trimmed. */
  headers: string[];
  /** One object per data row, keyed by header name. Blank rows are dropped. */
  rows: Record<string, string>[];
  headerRow: number;
  /** Rows that were entirely blank, so the review step can say how many were skipped. */
  blankRows: number;
}

/** Turn a grid into named rows, having worked out where the header is. */
export function readSheet(grid: Grid): Sheet {
  const headerRow = findHeaderRow(grid);
  if (headerRow < 0) return { headers: [], rows: [], headerRow: -1, blankRows: 0 };

  const headers = (grid[headerRow] ?? []).map(text);
  const rows: Record<string, string>[] = [];
  let blankRows = 0;

  for (let i = headerRow + 1; i < grid.length; i++) {
    const raw = grid[i] ?? [];
    if (raw.every((c) => text(c) === "")) { blankRows += 1; continue; }

    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      if (h !== "") row[h] = text(raw[j]);
    });
    // A row whose every mapped cell is empty is blank in practice, whatever the grid says.
    if (Object.values(row).every((v) => v === "")) { blankRows += 1; continue; }
    rows.push(row);
  }

  return { headers, rows, headerRow, blankRows };
}

/** field key → the header it was matched to, or "" for "not mapped". */
export type Mapping = Record<string, string>;

const normalise = (h: string): string =>
  h.toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Guess which column is which, from the header names.
 *
 * Exact alias first, then a contained-word match, so "Sales Price (BDT)" still finds
 * "sales price". A header is only used once: two fields cannot claim the same column,
 * or mapping "price" and "mrp" to the same thing would silently halve a catalogue.
 */
export function guessMapping(headers: string[], kind: ImportKind): Mapping {
  const spec = kindSpec(kind);
  const taken = new Set<string>();
  const out: Mapping = {};

  const find = (field: FieldSpec, loose: boolean): string | null => {
    for (const h of headers) {
      if (h === "" || taken.has(h)) continue;
      const n = normalise(h);
      const hit = loose
        ? field.aliases.some((a) => n.includes(a) || a.includes(n))
        : field.aliases.includes(n);
      if (hit) return h;
    }
    return null;
  };

  // Exact matches for every field first, so a loose match can never steal a column an
  // exact match needed.
  for (const pass of [false, true]) {
    for (const field of spec.fields) {
      if (out[field.key]) continue;
      const hit = find(field, pass);
      if (hit) { out[field.key] = hit; taken.add(hit); }
    }
  }

  for (const field of spec.fields) if (!out[field.key]) out[field.key] = "";
  return out;
}
