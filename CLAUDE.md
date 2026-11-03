# CLAUDE.md — CSL Counter

Context for Claude Code (and humans) picking this up. Read this before changing anything.
It is deliberately short: the long explanations live in `docs/notes/`, linked below, and
each one is worth reading before you touch that part.

## What this is and why

CSL Technologies' first retail store (Computer Services, Shop 9 & 10, BCS Computer City,
Agargaon) uses **BMS Smart Trader**, about 2,000 BDT/month. Most shops in the market use
it too. CSL wants a simpler replacement, proven in its own store first, then sold to
other shops. It runs **alongside BMS** at first, not instead of it. Built solo by Wasif.

It is a product for MANY shops, including chains with many branches. **Never hard-code
anything about CSL**: its single-branch store is the first customer, not the only one.

What BMS does, what its staff struggle with, and the product decisions that came out of
studying it: **`docs/notes/bms.md`**. The three that matter most —

- The owner sets selling prices and they fill in automatically. In BMS the price list is
  empty, so staff peek at cost and type a number. This is the whole reason the app exists.
- Counter staff never see cost, margin, PIN hashes, profit, the accounts or the audit log.
  Not hidden on screen — not sent.
- Payment is recorded, so the drawer can be checked at day end. BMS prints "PAID" without
  anyone entering the cash.

## Architecture

- Next.js 15 App Router, TypeScript, Tailwind 4, Zustand, lucide-react. UI components in
  `src/components/ui/` are hand-written in the shadcn style. Supabase for Postgres, auth
  and row-level security. Deploy on Vercel. Use pnpm.
- **Business rules live in the DATABASE.** Any write touching money, stock, serials,
  prices, accounts or permissions goes through a security-definer Postgres function that
  checks role, shop and branch inside. The browser never sends a price, cost or stock
  number the database trusts. Errors are short codes (`OUT_OF_STOCK:<name>`);
  `friendlyError()` in `src/lib/sale.ts` turns them into plain words, and a test greps
  the migrations so a new `raise exception` cannot ship without a message.
- **Everything advanced is behind a feature switch** (`shop_features`, read by
  `feature_on()` and `navFor()`), off for a new shop, so a small shop sees a simple app.
- Who may do what — auth, demo mode, PINs, roles, the 17 permission keys, the nav rules:
  **`docs/notes/security.md`**.
- Multi-shop and multi-branch from day one, Dhaka dates, the area list:
  **`docs/notes/shape-of-the-data.md`**.
- Prices, bands, customer price lists, per-line VAT: **`docs/notes/pricing-and-vat.md`**.
- Weighted average cost, landed cost, transfers, FIFO layers, imports:
  **`docs/notes/stock-and-cost.md`**.
- Requisition → order → delivery: **`docs/notes/purchasing.md`**.
- The counter, returns, void, credit, warranty, captured profit: **`docs/notes/selling.md`**.
- The cash drawer and shifts: **`docs/notes/cash-and-shifts.md`**.
- Double entry, cheques, inter-branch, catching the books up:
  **`docs/notes/accounts.md`**.
- The report engine, the period lock, export: **`docs/notes/reports.md`**.
- Quotations, orders, delivery notes, advances: **`docs/notes/sales-documents.md`**.
- Employees, attendance, leave, salary: **`docs/notes/hr.md`**.
- Reps, dealers, delivery points, deposits: **`docs/notes/distribution.md`**.

## Where things live

- `supabase/migrations/` — timestamped, append-only. **Never edit an applied migration**;
  `create or replace` a function in a later one instead. **Apply every new migration to
  the live Supabase project in the same session you write it, and say so** — the live
  project has no migration table, so nothing else will notice a gap. Ask Wasif for the
  pooler connection string if you do not have it.
- `supabase/tests/sales_rules_test.sql` — every database rule, run by `pnpm test:db`
  against a local Postgres. 621 checks. Add to it whenever you add a rule.
- `src/lib/backend/` — the `Backend` interface, with `supabase.ts` and `demo.ts`.
  **Anything added to the interface needs a demo implementation that mirrors the same
  rules**, or demo mode shows figures the real shop cannot produce.
- `src/lib/sale.ts` — the sale rules repeated for instant on-screen feedback. Keep in
  step with the database; `sale.test.ts` and the SQL tests cover the same cases with the
  same numbers (5% off 450 → 23 discount, total 427).
- `src/lib/reports.ts` — the report catalogue, one entry per report. `pnpm reports:gen`
  writes the database seed from it; never hand-edit the generated migration.
- `src/lib/nav.ts`, `src/lib/guard.ts` — one list says who sees which section, and the
  same function backs both the menu and the server guard.
- `src/lib/settings-schema.ts` — the ten setup lists share one config-driven editor.
  Adding a list means adding a spec there, not writing a screen.
- `docs/BUILD_PROMPTS.md` — the build plan as prompts (P0–P18).
  `docs/BMS_REPORTS.md` — what every BMS printout contains.
  `docs/PROGRESS.md` — what each prompt built and what to test by hand.

## Conventions

- Plain English in the UI; short sentences; say what to do next ("Pick the serial number
  for …"). Advanced options stay hidden until a shop turns them on.
- Anything printed goes through `<PrintSheet>` (`src/components/print/print-sheet.tsx`):
  the shop's own logo, name and branch address from its settings, A4, bordered tables,
  Dhaka dd/mm/yyyy, and "Page X of Y" in the page's bottom margin box. Never hard-code a
  shop's details, and never name BMS on a printout.
- A customer may have no mobile number — most of the store's traders came over from BMS
  without a usable one — so they are found by name as well, and a sale can carry a
  customer id instead of a phone.
- Money: whole taka on screen (`formatTaka`), `numeric(12,2)` in the database.
- Touch targets ≥ 44 px; works at phone width (390px), no sideways scrolling; light theme.
- Product codes and serials use the `.code` class; amounts use `.num` (tabular digits).
- Dhaka time (`Asia/Dhaka`) for every date shown and all "today" logic.
- Document numbers are per branch, never reused, handed out inside the same transaction
  as the document: `<prefix>-<branch code>-<year><6 digits>`.
- Log anything sensitive to `audit_log` (who, what, before/after, branch).

## Setup commands

`pnpm check` (alias `pnpm run doctor`) checks an install end to end and names the fix for
each failure. `pnpm shop:init` creates a shop with its own name, invoice prefix and
starting number. `pnpm staff:add` creates logins (with `email_confirm: true`, or they
silently cannot sign in) and does `--list`, `--deactivate`, `--reset-password`; it refuses
to move someone between shops without `--move`. Scripts are `.mts` so tsx runs them.

To run it locally: `pnpm dev:demo` (sample data, no login). Plain `pnpm dev` uses the real
Supabase project in `.env.local` — keys present always means real auth, never demo mode.

## Checks to run before shipping

`pnpm test && pnpm typecheck && pnpm lint && pnpm build`, plus `pnpm test:db` when the SQL
changes. `pnpm test:db` needs a plain local Postgres: `PGHOST=/tmp PGPORT=5432`.

## Where the build is up to

The plan is `docs/BUILD_PROMPTS.md` (P0–P18); what each prompt built and what to test by
hand is `docs/PROGRESS.md`, which wins on detail. P0–P14 are done and committed.

| | |
|---|---|
| P0–P2 | Logins, branches, app shell, roles, setup lists, permissions, VAT, feature switches |
| P3–P5 | Products and owner-set price bands · import from BMS · goods in and corrections |
| P6–P7 | Requisition → order → receiving, supplier dues · branch transfers |
| P8–P10a | The cash drawer · sales history, void, returns · credit sales · the full counter |
| P11–P12 | Warranty lookup and claims · the owner dashboard |
| P13–P14 | Double-entry books · 132 reports, the period lock, export |
| P14a | Quotations, sales orders with advances, challans, reserved stock |
| P14b | Employees, attendance, leave, salary sheets |
| P14c | Sales reps and targets, dealers, delivery points, deposits, trader flags |
| **next** | **P15** SMS → P16 printing → P17 launch hardening → P18 multi-shop signup |

Loose ends worth knowing about, each noted in PROGRESS.md where it belongs: a few P3
and P5 screens are missing though the rules exist (product attributes, gifts,
purchase-price fixing, the printable price view, supplier groups, the GRN print view);
P4 now reads BMS's five report PDFs (`src/lib/import/bms-pdf.ts`), checked against the
store's real exports with `pnpm check:pdf`; P10a leaves the 80mm receipt's print choices
to P16, though the A4 bill is done; P11
has no claim photos; P13 has no sub-ledger picker on a typed journal voucher and no
screen for measuring a cheque leaf; every report in docs/BMS_REPORTS.md now runs except BMS's bank interest calculator, which nobody at the store was seen using.

**Before charging other shops:** paid Supabase and Vercel plans, backups, error
monitoring (Sentry).
