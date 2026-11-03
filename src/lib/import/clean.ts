import { isPlaceholderPhone } from "../sale";

/**
 * Turning what a spreadsheet says into what the database can store.
 *
 * Everything here is deliberately forgiving about input and strict about output: a
 * shop's export has commas in numbers, "1 Year" in a warranty column and stray spaces
 * around codes, and none of that should mean a failed import.
 */

/** "2,900" → 2900. "৳ 1,200.50" → 1200.5. Anything unreadable → null, never 0, because
 *  a price of 0 is a real price and "we could not read it" is not. */
export function parseMoney(raw: string): number | null {
  const s = raw.replace(/[৳$,\s]/g, "").replace(/[()]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Accounting exports put negatives in brackets.
  return /^\(.*\)$/.test(raw.trim()) ? -Math.abs(n) : n;
}

export function parseQty(raw: string): number | null {
  const n = parseMoney(raw);
  if (n === null) return null;
  return Math.trunc(n);
}

/**
 * "1 Year" → 12. "6 Month" → 6. "3 Years" → 36. "36" → 36. "N/A", "-", "" → 0.
 *
 * A bare number is months, because that is what the column means once it is a number
 * at all; anything with "year" in it is multiplied.
 */
export function parseWarrantyMonths(raw: string): number {
  const s = raw.toLowerCase().trim();
  if (s === "" || s === "-" || s === "n/a" || s === "na" || s === "no" || s === "nil") return 0;

  const num = Number(s.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return 0;

  if (/year|yr|bosor|বছর/.test(s)) return Math.round(num * 12);
  if (/month|mo|mas|মাস/.test(s)) return Math.round(num);
  if (/day/.test(s)) return 0; // a few days' warranty is not a warranty term
  return Math.round(num);
}

/** Codes come with stray spaces and inconsistent case. Everything matches on the code,
 *  so it has to be normalised the same way every time. */
export function cleanCode(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * 11 digits starting 01, which is every Bangladeshi mobile. Anything else is not a phone
 * number, including BMS's famous "2026-01-01" placeholder — and including the ones that
 * are the right shape but made up, like "01000000000", which `isPlaceholderPhone` knows.
 */
export function cleanPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const local = digits.startsWith("880") ? digits.slice(3) : digits;
  const padded = local.length === 10 && local.startsWith("1") ? `0${local}` : local;
  if (!/^01\d{9}$/.test(padded)) return null;
  return isPlaceholderPhone(padded) ? null : padded;
}

export function parseBool(raw: string): boolean {
  return /^(1|y|yes|true|t|serial|imei)$/i.test(raw.trim());
}

/** "Sold", "Sold Out", "Delivered" → true. Anything else is treated as available. */
export function isSoldStatus(raw: string): boolean {
  return /sold|deliver|issued|out/i.test(raw.trim());
}

// ---------------------------------------------------------------------------
// Category and brand clean-ups
// ---------------------------------------------------------------------------

/**
 * Misspellings worth correcting on sight. "Convarter" is a real one from CSL's BMS: the
 * filmed sale lost time because the product was filed under it.
 */
const KNOWN_FIXES: Record<string, string> = {
  convarter: "Converter",
  convertar: "Converter",
  accesories: "Accessories",
  accessries: "Accessories",
  acessories: "Accessories",
  logitach: "Logitech",
  logitec: "Logitech",
  kingstone: "Kingston",
  samsumg: "Samsung",
  mircosoft: "Microsoft",
  moniter: "Monitor",
  moniters: "Monitors",
  keybord: "Keyboard",
  pendrive: "Pen drive",
  harddisk: "Hard disk",
  mothorboard: "Motherboard",
  motherbord: "Motherboard",
  adeptor: "Adapter",
  adaptor: "Adapter",
  pirnter: "Printer",
  cartidge: "Cartridge",
  catridge: "Cartridge",
};

/** Levenshtein, capped: we only care whether two names are within an edit or two. */
function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
    if (Math.min(...row) > cap) return cap + 1;
  }
  return prev[b.length];
}

export interface Cleanup {
  from: string;
  to: string;
  /** How many rows in the file use the misspelling. */
  count: number;
  why: string;
}

/**
 * Suggest clean-ups for the category and brand names in a file.
 *
 * Three sources, in order of confidence:
 *   1. a known misspelling;
 *   2. a name one or two edits from one that already exists in the shop, so the import
 *      does not create "Accessories" alongside "Accesories";
 *   3. two spellings of the same thing within the file itself, where the more common
 *      one wins.
 *
 * These are only ever SUGGESTIONS: the review step shows them and the owner unticks any
 * that are wrong. Renaming a shop's categories without asking would be worse than a typo.
 */
export function suggestCleanups(values: string[], existing: string[] = []): Cleanup[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const t = v.trim();
    if (t !== "") counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  const out: Cleanup[] = [];
  const existingByLower = new Map(existing.map((e) => [e.toLowerCase(), e]));
  const inFile = new Set([...counts.keys()].map((v) => v.toLowerCase()));

  for (const [value, count] of counts) {
    const lower = value.toLowerCase();

    // Already exactly right.
    if (existingByLower.has(lower)) continue;

    // Short names are not misspellings of each other. Two letters apart means nothing
    // when the name is two or three letters long: it is how "Hp" became a suggestion to
    // merge into "GPS", "WD" into "SD" and "Mi" into "SD". Below five letters, the only
    // honest answer is to say nothing.
    if (lower.length < MIN_MERGE_LENGTH) continue;

    const known = KNOWN_FIXES[lower.replace(/\s+/g, "")];
    if (known && known !== value) {
      out.push({ from: value, to: known, count, why: "looks like a misspelling" });
      continue;
    }

    // Close to something the shop already uses.
    const near = existing.find((e) => {
      const other = e.toLowerCase();
      if (other === lower || other.length < MIN_MERGE_LENGTH) return false;
      // Both names are in this file, so both are being used on purpose. "HeadPhone"
      // and "EarPhone" are two kinds of thing, not one spelled two ways.
      if (inFile.has(other)) return false;
      return editDistance(lower, other, 2) <= 2;
    });
    if (near) {
      out.push({ from: value, to: near, count, why: `the shop already has "${near}"` });
    }
  }

  return out.sort((a, b) => b.count - a.count);
}

/**
 * The shortest name worth proposing a merge for.
 *
 * Of the 22 suggestions the first run at CSL's real catalogue produced, exactly one was
 * right. The rest were short brand and category names two edits apart by accident.
 */
const MIN_MERGE_LENGTH = 5;
