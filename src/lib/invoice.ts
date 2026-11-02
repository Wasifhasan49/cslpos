/**
 * The two things an invoice needs that nothing else in the app does: the amount written
 * out in words, and a barcode of the invoice number.
 *
 * Both are on the store's own printed bill and both earn their place. The words are
 * what makes a bill hard to alter after it is handed over — a figure can have a nought
 * added to it, "One Thousand Six Hundred" cannot. The barcode is how the counter finds
 * a sale again when a customer brings the paper back: scan it rather than typing
 * sixteen characters off a creased bill.
 */

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** 0–99. */
function underHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = ONES[n % 10];
  return ones ? `${tens} ${ones}` : tens;
}

/** 0–999. */
function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return underHundred(rest);
  const head = `${ONES[hundreds]} Hundred`;
  return rest ? `${head} ${underHundred(rest)}` : head;
}

/**
 * A number in words, counted the way Bangladesh counts: crore, lakh, thousand, hundred.
 *
 * Not the western million — a bill that says "One Million Two Hundred Thousand" to a
 * shopkeeper in Agargaon is a bill written for somebody else.
 */
export function numberInWords(n: number): string {
  const whole = Math.floor(Math.abs(n));
  if (whole === 0) return "Zero";

  const parts: string[] = [];
  const crore = Math.floor(whole / 10_000_000);
  const lakh = Math.floor((whole % 10_000_000) / 100_000);
  const thousand = Math.floor((whole % 100_000) / 1000);
  const rest = whole % 1000;

  if (crore > 0) parts.push(`${numberInWords(crore)} Crore`);
  if (lakh > 0) parts.push(`${underThousand(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${underThousand(thousand)} Thousand`);
  if (rest > 0) parts.push(underThousand(rest));

  return (n < 0 ? ["Minus", ...parts] : parts).join(" ");
}

/**
 * The amount as a bill writes it: "One Thousand Six Hundred", with the paisa said
 * separately when there are any. The word "Only" belongs to the printed line, not here.
 */
export function takaInWords(amount: number): string {
  const taka = Math.floor(Math.abs(amount));
  const paisa = Math.round((Math.abs(amount) - taka) * 100);
  const sign = amount < 0 ? "Minus " : "";
  if (paisa === 0) return `${sign}${numberInWords(taka)}`;
  return `${sign}${numberInWords(taka)} and ${numberInWords(paisa)} Paisa`;
}

// ---------------------------------------------------------------------------
// Code 128 B
// ---------------------------------------------------------------------------

/**
 * The 107 bar patterns, one per symbol value.
 *
 * Each is six module widths, bar first, alternating bar and space, and each adds up to
 * eleven modules — which is what the test checks, because a single mistyped digit here
 * would print a barcode that looks perfect and scans as something else. The last entry
 * is the stop pattern, which has a seventh bar.
 */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const STOP = 106;

/** Exported so a test can check the table has not been mistyped. */
export const CODE128_PATTERNS = PATTERNS;

/**
 * The module widths for one Code 128-B barcode, bar first.
 *
 * Set B covers every printable ASCII character, which is what a document number is.
 * Anything outside it would be unscannable, so it is refused rather than mangled.
 */
export function code128Modules(value: string): number[] {
  if (value === "") return [];
  const codes: number[] = [];
  for (const ch of value) {
    const n = ch.charCodeAt(0) - 32;
    if (n < 0 || n > 94) return [];
    codes.push(n);
  }

  let sum = START_B;
  codes.forEach((c, i) => { sum += c * (i + 1); });
  const symbols = [START_B, ...codes, sum % 103, STOP];

  return symbols.flatMap((v) => [...PATTERNS[v]].map(Number));
}

/**
 * That barcode as SVG, sized in whatever units the caller is laying out in.
 *
 * Drawn rather than fetched from a barcode service: an invoice has to print on a shop
 * counter whose internet is down, and sending every invoice number to somebody else's
 * server to get a picture back is not a thing to do with a customer's bill.
 */
export function code128Svg(value: string, opts?: { height?: number; module?: number }): {
  rects: { x: number; width: number }[];
  width: number;
  height: number;
} {
  const unit = opts?.module ?? 1;
  const height = opts?.height ?? 28;
  const widths = code128Modules(value);

  const rects: { x: number; width: number }[] = [];
  let x = 0;
  widths.forEach((w, i) => {
    // Even indexes are bars, odd are spaces.
    if (i % 2 === 0) rects.push({ x: x * unit, width: w * unit });
    x += w;
  });
  return { rects, width: x * unit, height };
}
