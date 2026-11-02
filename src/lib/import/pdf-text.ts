/**
 * A PDF page as lines of positioned words.
 *
 * BMS cannot export Excel — its report viewer only prints — so the five reports a shop
 * hands over on go-live day arrive as PDFs. A PDF has no rows and no columns: it has
 * words, each at a point on the page. Everything else (which column a word is in,
 * whether a line is a heading, a wrapped address or a subtotal) is worked out from
 * those positions, which is what this file and `bms-pdf.ts` do.
 *
 * The reading is done in the browser with pdf.js, like the spreadsheet importer, so the
 * shop's whole customer list never leaves the machine. This module deliberately knows
 * nothing about pdf.js: it takes plain words, so the parsers can be tested against
 * made-up pages with no library and no sample file.
 */

export interface PdfWord {
  text: string;
  /** Points from the left edge of the page. */
  x: number;
  /** Points from the BOTTOM edge, which is how PDF measures. */
  y: number;
  /** Type size. BMS sets its group headings bigger than its data, which is the only
   *  reliable way to tell a heading from a wrapped name at the same indent. */
  size: number;
}

export interface PdfLine {
  y: number;
  /** Left to right. */
  words: PdfWord[];
  /** The words joined with single spaces, for matching titles and labels. */
  text: string;
  /** Where the line starts, which is what indentation means here. */
  x: number;
  /** The biggest type on the line. */
  size: number;
}

export interface PdfPage {
  lines: PdfLine[];
  width: number;
  height: number;
}

/**
 * Group words into lines.
 *
 * Words that belong to one printed line do not share a y to the decimal: a column of
 * numbers typically sits a point or so below the text beside it, because the two are
 * set in different sizes and sit on different baselines. Hence the tolerance.
 */
export function linesFrom(words: PdfWord[], tolerance = 3): PdfLine[] {
  const kept = words.filter((w) => w.text.trim() !== "");
  // Down the page, which is DECREASING y in PDF coordinates.
  const sorted = [...kept].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: PdfLine[] = [];
  let current: PdfWord[] = [];
  let top = 0;

  const flush = () => {
    if (current.length === 0) return;
    const ordered = [...current].sort((a, b) => a.x - b.x);
    lines.push({
      y: top,
      words: ordered,
      text: ordered.map((w) => w.text.trim()).join(" ").replace(/\s+/g, " ").trim(),
      x: ordered[0].x,
      size: Math.max(...ordered.map((w) => w.size)),
    });
    current = [];
  };

  for (const w of sorted) {
    if (current.length === 0 || Math.abs(top - w.y) <= tolerance) {
      if (current.length === 0) top = w.y;
      current.push(w);
    } else {
      flush();
      top = w.y;
      current.push(w);
    }
  }
  flush();
  return lines;
}

/** "12,400.00" → 12400, "-9,500.00" → -9500, anything else → null. */
export function money(text: string): number | null {
  const t = text.replace(/[,\s৳]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Whether this word is a figure rather than a word. */
export const isNumber = (text: string): boolean => money(text) !== null;
