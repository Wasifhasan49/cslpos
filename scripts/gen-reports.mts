#!/usr/bin/env tsx
/**
 * Write the report catalogue into a migration.
 *
 * src/lib/reports.ts is the one place a report is described — the screen reads it and
 * so does the database, so they cannot drift. This turns it into SQL. Same arrangement
 * as the Bangladesh area list (scripts/gen-areas.mts): re-run the generator, never
 * hand-edit the generated file.
 *
 *   pnpm reports:gen [path/to/migration.sql]
 *
 * Adding reports later means a NEW timestamped migration, because an applied one is
 * never edited: pass the new path.
 */
import { writeFileSync } from "node:fs";
import { REPORTS, type ReportDef } from "../src/lib/reports.ts";

const out = process.argv[2] ?? "supabase/migrations/20261026000019_report_defs.sql";

const lit = (v: string | null | undefined): string =>
  v === null || v === undefined ? "null" : `'${v.replace(/'/g, "''")}'`;
const arr = (v: readonly string[] | undefined): string =>
  !v || v.length === 0 ? "'{}'" : `array[${v.map(lit).join(", ")}]`;
const json = (v: unknown): string =>
  v === null || v === undefined ? "null" : `${lit(JSON.stringify(v))}::jsonb`;

function row(r: ReportDef): string {
  return `  (${[
    lit(r.key), lit(r.register), String(r.sl), lit(r.title), lit(r.note),
    lit(r.dataset), arr(r.groupBy), json(r.columns ?? []), json(r.pivot),
    lit(r.special), lit(r.dateMode ?? "range"), r.needsCost ? "true" : "false",
    lit(r.needs), r.landscape ? "true" : "false", lit(r.sortDesc),
    r.topDefault === undefined ? "null" : String(r.topDefault), json(r.filter),
  ].join(", ")})`;
}

const seen = new Set<string>();
for (const r of REPORTS) {
  if (seen.has(r.key)) throw new Error(`Two reports share the key ${r.key}`);
  seen.add(r.key);
  if (!r.needs && !r.special && !r.pivot && !r.dataset) {
    throw new Error(`${r.key} has no dataset, no pivot and no builder`);
  }
}

const sql = `-- GENERATED FILE — do not hand-edit.
-- Written by scripts/gen-reports.mts from src/lib/reports.ts, which is where a report
-- is described. Change that file and run \`pnpm reports:gen\`.
--
-- ${REPORTS.length} reports: the whole of docs/BMS_REPORTS.md, plus the ones this prompt asks
-- for that BMS has no equivalent of (a VAT return, stock valuation proved against the
-- stock account, profit by month, and a list of what is still in a van).

insert into public.report_defs
  (key, register, sl, title, note, dataset, group_by, columns, pivot, special,
   date_mode, needs_cost, needs, landscape, sort_desc, top_default, fixed_filter)
values
${REPORTS.map(row).join(",\n")}
on conflict (key) do update set
  register = excluded.register, sl = excluded.sl, title = excluded.title,
  note = excluded.note, dataset = excluded.dataset, group_by = excluded.group_by,
  columns = excluded.columns, pivot = excluded.pivot, special = excluded.special,
  date_mode = excluded.date_mode, needs_cost = excluded.needs_cost,
  needs = excluded.needs, landscape = excluded.landscape,
  sort_desc = excluded.sort_desc, top_default = excluded.top_default,
  fixed_filter = excluded.fixed_filter;

-- Every field a report names must exist in its dataset. Checked HERE, when the
-- migration runs, so a typo is a failed migration naming the report and the field
-- rather than a report that silently comes out empty six months later.
do $$
declare r record; f text; v_cols text[];
begin
  for r in select d.* from public.report_defs d where d.dataset is not null and d.needs is null loop
    select cols into v_cols from public.rep_datasets where dataset = r.dataset;
    if v_cols is null then
      raise exception '% names a dataset that does not exist: %', r.key, r.dataset;
    end if;
    foreach f in array r.group_by loop
      if not f = any(v_cols) then
        raise exception '% groups by a field its dataset has not got: %', r.key, f;
      end if;
    end loop;
    -- A column that is WORKED OUT (an average, a percentage) does not have to exist
    -- in the dataset: the engine writes it. One that is added up does.
    for f in select c->>'f' from jsonb_array_elements(r.columns) c
             where c->>'calc' is null or c->>'calc' = 'average' loop
      if not f = any(v_cols) then
        raise exception '% has a column its dataset has not got: %', r.key, f;
      end if;
    end loop;
    if r.pivot is not null then
      foreach f in array array[r.pivot->>'row', r.pivot->>'col', r.pivot->>'value'] loop
        if not f = any(v_cols) then
          raise exception '% pivots on a field its dataset has not got: %', r.key, f;
        end if;
      end loop;
    end if;
  end loop;
  for r in select d.* from public.report_defs d
           where d.special is not null and d.needs is null loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'rep_sp_' || r.special) then
      raise exception '% names a builder that does not exist: %', r.key, r.special;
    end if;
  end loop;
end $$;
`;

writeFileSync(out, sql);
console.log(`Wrote ${REPORTS.length} reports to ${out}`);
