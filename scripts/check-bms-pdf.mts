/**
 * Read BMS report PDFs and say what came out of them.
 *
 * The real exports carry the shop's whole customer list, so they are never committed
 * and the tests use small made-up fixtures in the same shape. This is how the real ones
 * get checked: point it at a folder of them and it prints the row counts and the totals
 * beside the totals the reports themselves print, so a quiet parsing failure shows up as
 * two figures that disagree.
 *
 *   pnpm check:pdf "reports_samples/New Reports from Avik"
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { linesFrom, type PdfPage, type PdfWord } from "../src/lib/import/pdf-text";
import { readBmsPdf } from "../src/lib/import/bms-pdf";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

async function pagesOf(file: string): Promise<PdfPage[]> {
  const data = new Uint8Array(readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const out: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const view = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words: PdfWord[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const t = item.transform as number[];
      words.push({ text: item.str, x: t[4], y: t[5], size: Math.abs(t[0]) || 0 });
    }
    out.push({ lines: linesFrom(words), width: view.width, height: view.height });
  }
  return out;
}

const where = process.argv[2] ?? "reports_samples/New Reports from Avik";
const files = statSync(where).isDirectory()
  ? readdirSync(where).filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => join(where, f))
  : [where];

if (files.length === 0) {
  console.error(`No PDFs in ${where}`);
  process.exit(1);
}

let bad = 0;
for (const file of files) {
  const pages = await pagesOf(file);
  try {
    const read = readBmsPdf(pages);
    console.log(`\n${file.split("/").pop()}  (${pages.length} pages)`);
    console.log(`  report:  ${read.report}`);
    for (const [name, grid] of Object.entries(read.grids)) {
      console.log(`  sheet:   ${name} — ${grid.length - 1} rows`);
    }
    console.log(`  totals:  ${JSON.stringify(read.totals)}`);
    for (const w of read.warnings) console.log(`  !        ${w}`);
  } catch (e) {
    bad += 1;
    console.log(`\n${file.split("/").pop()}: ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(bad > 0 ? 1 : 0);
