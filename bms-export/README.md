# bms-export/

Put the shop's real BMS exports here. **They stay out of git** (see `.gitignore`):
they are the shop's customers, prices and stock.

Export from BMS to Excel:

- product list, with prices and warranty
- current stock report
- serial-number report
- customer list (with dues) and supplier list (with dues), if BMS will give them

Then: Settings → Import, and work through upload → map columns → review → import.

## samples/

Synthetic files with the same shape and the same quirks as a real BMS export —
`Model No/Caption` headers, a title row above the headers, misspelled categories,
blank rows, codes with stray spaces, numbers stored as text with commas, duplicate
codes. They are committed so the importer has something to be tested against.

They are NOT real data and the column names are a best reconstruction from the
BMS screenshots. **The importer still needs re-checking against a real export.**

Regenerate them with:

```bash
pnpm tsx scripts/make-sample-export.mts
```
