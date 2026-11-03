import type { ImportKind } from "./schema";

/**
 * Which sheet to open on.
 *
 * The sheet whose name says what it holds, failing that one whose columns carry every
 * field this import needs, failing that the first — which is what it always used to do.
 */
export function sheetFor(kind: ImportKind | null, names: string[]): string {
  if (names.length === 0) return "";
  if (!kind) return names[0];
  const want = SHEET_WORDS[kind];
  const named = names.find((n) => want.test(n));
  return named ?? names[0];
}

const SHEET_WORDS: Record<ImportKind, RegExp> = {
  products: /^products?\b/i,
  prices: /price/i,
  stock: /stock|quantit/i,
  serials: /serial/i,
  customers: /customer/i,
  suppliers: /supplier/i,
};
