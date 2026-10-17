# CLAUDE.md — CSL Counter

Context for Claude Code (and humans) picking this up. Read this before changing anything.

## What this is and why

CSL Technologies' first retail store (Computer Services, Shop 9 & 10, BCS Computer City,
Agargaon) uses **BMS Smart Trader** by Billing Master Software Ltd, about 2,000 BDT/month.
Most shops in the market use it too. CSL wants a simpler replacement, proven in its own
store first (management agreed), then sold to other shops. It runs **alongside BMS** at
first, not instead of it. Built solo by Wasif. It is a product for MANY shops, including
chains with many branches; CSL's single-branch store is only the first customer.

### What we learned from studying BMS (68 photos + a filmed sale, Oct 2026)

- BMS is a full trading ERP: 12 menus, ~200 screens. Counter staff use about 5.
- The sales screen has ~40 fields and 22 buttons. Staff are not technical and struggle with it.
- A filmed sale of 2 audio splitters (৳1,000) took ~50 s and ~14 clicks. A third of that
  was hunting through three linked dropdowns (Group → Brand → Model), partly because the
  product was filed under a misspelled category ("Convarter").
- **Prices are typed by hand.** BMS's price list ("Sales Price Fixing") is empty, so staff
  click "Show Cost" and decide the price themselves. Owner risk: under-charging or skimming.
- **Payment is never recorded.** The bill prints "PAID" without cash or card being entered,
  so the drawer can't be checked at day end.
- **No customer data.** Every walk-in is "Cash Customer" with a default mobile of "2026-01-01".
- Invoices are A4, show "1 Year" warranty but no serial number or end date, and advertise BMS.
- BMS strengths a replacement must keep: serial/IMEI tracking, serial history lookup,
  warranty (RMA) tracking, price tiers with min/max, re-order levels, credit customers,
  EMI/card, VAT, exchange, Excel import, an edit log, user permissions.
- Warranty claims are rare at this store; they just need tracking, not BMS's 10-screen RMA flow.
- Internet at the store is reliable, so the app is online-only (no offline mode).
- BMS can export to Excel, so data can be moved over.

### Product decisions (copied from how Shopify POS, Lightspeed and Odoo do it)

- Owner/manager sets selling prices; they fill in automatically. Counter staff can't edit them.
- Each staff member has a discount limit (%); above it a manager PIN is required; every
  approval is logged. Price changes are logged too.
- Counter staff never see cost prices (separate table, blocked by row-level security).
- Owner dashboard (next): today's sales and profit vs yesterday/last week, best sellers,
  low stock, "dusty" stock (unsold 60+ days), sales per staff, busy hours, discount and
  price-change log, cash drawer check. Must work on a phone.

## Architecture

- Next.js 15 App Router, TypeScript, Tailwind 4, Zustand, lucide-react. UI components in
  `src/components/ui/` are hand-written in the shadcn style (the shadcn registry was
  unreachable when this was built). Running `npx shadcn add …` later is fine.
- Supabase for Postgres, auth and row-level security. Deploy on Vercel.
- **Multi-shop from day one**: every table has `shop_id`; RLS limits each login to its shop.
- **Rules live in the database.** Sales, stock and serials have no insert/update policies;
  they change only through `complete_sale()` and `receive_stock()` (security definer).
  `complete_sale()` reads prices from `products`, checks stock, serials, discount limit +
  manager PIN (bcrypt via pgcrypto), payment, phone; numbers the invoice
  (`<prefix><year><6 digits>`, CSL starts at 1790 to follow on from BMS); sets warranty
  end dates in Dhaka time; logs approvals. Errors are short codes like `OUT_OF_STOCK:<name>`;
  `friendlyError()` in `src/lib/sale.ts` turns them into plain words.
- `src/lib/sale.ts` repeats the rules for instant on-screen feedback. Keep the two in sync;
  the tests in `src/lib/sale.test.ts` and `supabase/tests/sales_rules_test.sql` cover the
  same cases (e.g. 5% off 450 → 23 discount, total 427).
- `src/lib/backend/` — `Backend` interface; `demo.ts` (in-browser sample data, mirrors the
  database rules) and `supabase.ts`. Demo mode turns on when Supabase env vars are missing.

## Conventions

- Plain English in the UI; short sentences; say what to do next ("Pick the serial number for …").
- Money: whole taka on screen (`formatTaka`), numeric(12,2) in the database.
- Touch targets ≥ 44 px; works at phone width; light theme only.
- Product codes and serials use the `.code` (monospace) class; amounts use `.num` (tabular digits).

## Next steps (in rough order)

The full build plan, as step-by-step prompts, is in `docs/BUILD_PROMPTS.md` (P0–P18):
branches, setup lists, price lists, purchase orders, transfers and full accounts
are all in scope because this is sold to many shops, including multi-branch chains.
The list below is the original short version; BUILD_PROMPTS.md wins where they differ.

1. **Supabase project + real logins** for the store's staff; set manager PINs (needs a small
   "Set my PIN" screen for managers; today it's `select set_pin('…')`).
2. **Import from BMS**: CSV/Excel import of products (code, name, brand, category, price,
   warranty, serial flag, stock) and serials. Fix category typos while importing.
3. **Stock in** screen (calls `receive_stock()`), with serial scanning for serial items.
4. **Owner dashboard** (phone-first), see product decisions above.
5. **Shifts + cash check**: open with opening cash, close with counted cash; flag shortfalls.
   Tables exist (`shifts`); `complete_sale()` already links sales to the open shift.
6. **Returns/exchanges** and **void sale** (manager only, logged).
7. **Warranty lookup** by serial or phone; simple claim log (received → sent to supplier → returned).
8. **SMS receipts** via a Bangladeshi SMS gateway (button exists, not connected).
9. Product/price management screens for owners (today: SQL editor).
10. Before charging other shops: paid Supabase + Vercel plans, backups, error monitoring (Sentry).

Not planned yet: HR, sales orders with advance payment, SR targets (see BUILD_PROMPTS.md).

## Checks to run before shipping

`pnpm test && pnpm typecheck && pnpm lint && pnpm build`, plus `pnpm test:db` when the SQL changes.
