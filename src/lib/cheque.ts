// Writing a cheque, on the screen's side.
//
// `takaInWords` is the same arithmetic as `taka_in_words()` in the database, tested with
// the same numbers in both places, because the words on a cheque are what a bank honours
// when the figures have been tampered with — the two must never differ.
import type { ChequeLayout } from "./types";

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
];

function under100(n: number): string {
  if (n <= 0) return "";
  if (n < 20) return ONES[n];
  return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(" ");
}

function under1000(n: number): string {
  if (n <= 0) return "";
  if (n < 100) return under100(n);
  return [`${ONES[Math.floor(n / 100)]} Hundred`, under100(n % 100)].filter(Boolean).join(" ");
}

/** An amount in words, the way a Bangladeshi cheque is written: crore, lakh, thousand. */
export function takaInWords(amount: number): string {
  const abs = Math.abs(amount || 0);
  let whole = Math.floor(abs);
  const paisa = Math.round((abs - whole) * 100);
  if (whole === 0 && paisa === 0) return "Zero Taka Only";

  const parts: string[] = [];
  // The South Asian grouping, not millions.
  if (whole >= 10_000_000) {
    parts.push(`${under1000(Math.floor(whole / 10_000_000))} Crore`);
    whole %= 10_000_000;
  }
  if (whole >= 100_000) {
    parts.push(`${under100(Math.floor(whole / 100_000))} Lakh`);
    whole %= 100_000;
  }
  if (whole >= 1000) {
    parts.push(`${under100(Math.floor(whole / 1000))} Thousand`);
    whole %= 1000;
  }
  if (whole > 0) parts.push(under1000(whole));

  let out = `${parts.join(" ")} Taka`;
  if (paisa > 0) out += ` and ${under100(paisa)} Paisa`;
  return `${out} Only`;
}

/**
 * Where things go on a leaf nobody has measured yet.
 *
 * Printing on the defaults and letting the shop nudge them beats refusing to print until
 * somebody has measured, because a shop that cannot print will write the cheque by hand.
 */
export const DEFAULT_CHEQUE_LAYOUT: ChequeLayout = {
  leafWidthMm: 203,
  leafHeightMm: 92,
  dateX: 150, dateY: 14,
  payeeX: 25, payeeY: 30,
  words1X: 25, words1Y: 42,
  words2X: 18, words2Y: 50,
  figuresX: 155, figuresY: 50,
  fontPt: 11,
};
