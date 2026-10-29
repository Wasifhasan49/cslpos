# Reports, the period lock and export

- **A report is configuration, not a query** (P14). BMS prints about a hundred reports
  across nine register screens, and nearly every one is the same shape: take a list of
  lines, group it two or three deep, total the money and the quantity at each level. So
  the database has ONE engine (`report_run()`) that does exactly that with
  `GROUP BY ROLLUP`, and a report is a row of configuration — which dataset, which
  grouping, which columns. The dozen that are genuinely a different shape (the trial
  balance, the balance sheet, a ledger, the day book) name a builder of their own. The
  catalogue lives in `src/lib/reports.ts`, because the screen and the engine both need
  it and two copies would drift; `scripts/gen-reports.mts` writes the seed migration
  from it, the same arrangement as the Bangladesh area list. **Re-run the generator;
  never hand-edit the generated file.** A field a dataset has not got is refused BY NAME
  when the migration runs, so a typo is a failed migration naming the report and the
  field rather than a report that silently comes out empty six months later.
- **The datasets are granted to nobody** (P14). The `v_rep_*` views hold cost, margin and
  every supplier price. They are read only through `report_run()`, which is security
  definer and checks the permission, the shop and the branches first; a view a cashier
  could select from directly would hand them the lot. Percentages and averages are
  RECOMPUTED at every subtotal rather than summed — BMS sums its profit-% column, so a
  subtotal over four lines can read 380%.
- **A closed month is closed** (P14, BMS's "Transaction Lock"). A September sale voided
  in October makes every report printed since then wrong and nobody finds out. So the
  owner closes a month and nothing dated in it can be created, edited, voided or
  returned — enforced by one guard trigger on every table that records something dated,
  with the date column's name as a trigger argument, checked on BOTH dates of an update
  so a document cannot be dragged out of a closed month either. Only the owner may close
  or open one; opening needs a reason and is logged, because "who opened August again,
  and why?" is the question that matters afterwards. The back-fills set a session flag
  to pass through, because they replay what has ALREADY happened.
- **Excel in the browser, PDF from the browser, Tally with a warning** (P14). The export
  needs no new library and no server: exceljs was already a dependency (P4 reads import
  files with it), and a PDF is the print stylesheet — the browser is better at making
  paper than anything we could add, and it repeats the column headings on every sheet.
  Tally imports XML, and the shape is stable, but it refuses a voucher whose ledger
  NAMES do not match its own exactly and no export can know what a particular accountant
  called their accounts. So the file is produced, and the screen says: import one
  voucher, fix the names, then import the year. The CSV is there for the accountant who
  would rather map the columns themselves, which in practice is most of them.
