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
- **Auth**: `src/middleware.ts` refreshes the session and owns every redirect. The rules
  are a pure function in `src/lib/auth-route.ts` (unit-tested, deny-by-default: only
  `/login` is public). If Supabase Auth is *unreachable* the request is let through
  rather than treated as signed out — the database re-checks `auth.uid()` everywhere, and
  bouncing a signed-in cashier to `/login` mid-sale would destroy the sale (the cart is
  in-memory). `src/lib/env.ts` is the only place that decides demo mode; it has no
  imports so middleware can use it without pulling the backend into the edge bundle.
- **Demo mode is opt-in** (`NEXT_PUBLIC_DEMO_MODE=1`, or missing keys in development).
  It used to switch on whenever the keys were absent, so a production deploy with one
  forgotten env var served an open, sign-in-free counter. A half-filled `.env.local` is
  a config error, not demo mode.
- **Multi-shop AND multi-branch from day one**: every table has `shop_id`; anything that
  happens at a place (stock, serials, sales, shifts, movements) also has `branch_id`.
  The catalogue (products, categories, customers) is shop-wide, because a product is the
  same product everywhere. `current_branch_ids()` is the one source of truth for where a
  login may work; owners get every branch without a `staff_branches` row, so adding a
  branch can never lock the owner out of it. Stock lives in `branch_stock(product_id,
  location_id, qty)` — `products.stock` is gone, because it could only describe one place.
  Document numbers are per branch: `<shop prefix>-<branch code>-<year><6 digits>`.
- **Navigation rules are data**, in `src/lib/nav.ts`: one list says who sees which
  section, `canSee()` answers it, and the same function backs both the menu and the
  server guard (`src/lib/guard.ts`) so they cannot disagree. Cashiers get at most 3 phone
  tabs. Owner-only sections can be shared with managers by a settings flag.
- **Rules live in the database.** Sales, stock and serials have no insert/update policies;
  they change only through `complete_sale()` and `receive_stock()` (security definer).
  `complete_sale()` reads prices from `products`, checks stock, serials, discount limit,
  payment, phone; numbers the invoice (`<prefix><year><6 digits>`); sets warranty end
  dates in Dhaka time; logs approvals. It locks product rows in `product_id` order so
  two concurrent sales can't deadlock. Errors are short codes like `OUT_OF_STOCK:<name>`;
  `friendlyError()` in `src/lib/sale.ts` turns them into plain words — and a test greps
  the migrations so a new `raise exception` can't ship without a message.
- **PIN approvals go through `verify_manager_pin()`, not `complete_sale()`.** The counter
  names *which* manager is approving, that one person's PIN is checked immediately, and
  the function returns a single-use approval (10 minutes) that the sale consumes.
  It **returns** a result rather than raising, because raising rolled back the attempt
  row with it — which is why failed PINs used to leave no trace at all. Five wrong tries
  in 10 minutes locks that approver out. Every attempt lands in `pin_attempts` and
  `audit_log`. `set_pin()` also refuses guessable PINs (`1234`, `0000`).
- **Roles, discount limits and turning staff off are owner-only**, through
  `set_staff_access()`: it refuses self-edits, refuses to remove the last owner, and logs
  before/after. Before this, the `authenticated` UPDATE grant on `staff` included `role`,
  `discount_limit_pct` and `active`, so any manager could raise their own limit to 100%,
  promote themselves to owner, or deactivate the owner — unlogged. Only `name` is
  directly writable now.
- RLS helpers are wrapped as `(select public.current_shop_id())` so they are evaluated
  once per statement, not once per row.
- **Permissions sit on top of roles** (P2). 17 keys in `permission_keys`, defaults per
  role in `role_permissions`, per-person overrides in `staff_permissions`, and
  `has_permission()` / `permission_limit()` are what the FUNCTIONS check — so an owner
  can let one trusted cashier take deliveries without making them a manager. Owners
  always pass, or a shop could lock itself out of its own settings.
- **Feature switches** in `shop_features`, read by `feature_on()` and by `navFor()`, so
  an off feature has no menu item. Everything advanced is off for a new shop.
- **Prices are set by the owner and fill in automatically** (P3), which is the whole
  reason this product exists: in BMS the price list is empty, so staff peek at cost and
  type a number. `resolve_price()` is the one answer to "what does this cost?" — branch
  override, then the list price, then `products.price` as a last resort so nothing is
  ever unsellable. Each price carries a **band** (`min_price`/`max_price`); a seller may
  move inside it, below it needs a manager's approval, and `complete_sale()` logs the
  override with the list price, the charged price and the difference. **No minimum set
  means the list price IS the floor** — the owner has given nobody permission to go
  below it. Prices are resolved in a first pass, before any stock moves, so the function
  knows whether an approval is needed before it claims one.
- A customer's price list and standing discount come from their phone number, so a
  dealer sees dealer prices before the sale is completed. The standing discount needs no
  approval (the owner set it) and does not stack with a manual one — the bigger wins.
- **VAT** is per line, not per total, in `complete_sale()`. Inclusive (the normal case
  here) does not change what the customer pays; exclusive is added on top. A discount
  reduces the taxable amount, so inclusive VAT is recalculated on the discounted line —
  doing it on the total overstates the tax on every discounted sale.
- **Imports upsert by code and never delete** (P4). A shop's export may be partial or
  last week's, so importing one must never remove anything, and re-running the same file
  must change nothing — that is what makes it safe to retry after a timeout. Opening
  stock SETS the figure rather than adding to it (re-importing would otherwise double the
  shelf) and records the difference as the movement. One audit entry per run with counts,
  not one per row. Files are parsed in the BROWSER with exceljs, so the shop's customer
  list never leaves their machine except as the rows they confirm. `xlsx` (SheetJS) was
  rejected: npm is stuck at 0.18.5 from 2022 with open advisories.
- **The Bangladesh area list** (divisions → districts → upazilas) is national reference
  data with no `shop_id`, generated into a migration by `scripts/gen-areas.mts` from
  github.com/nuhil/bangladesh-geocode. Re-run the generator rather than hand-editing.
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

## Setup commands

`pnpm check` (alias `pnpm run doctor` — bare `pnpm doctor` is pnpm's own built-in) checks
an install end to end and names the fix for each failure. `pnpm shop:init` creates a shop
with its own name, invoice prefix and starting number, so no shop inherits another's
identity. `pnpm staff:add` creates logins (with `email_confirm: true`, or they silently
cannot sign in), and does `--list`, `--deactivate`, `--reset-password`. It refuses to move
someone between shops without `--move`, because `staff.user_id` is globally unique and a
silent move orphans their past sales. Scripts are `.mts` so tsx runs them as ESM.

## Next steps (in rough order)

The full build plan, as step-by-step prompts, is in `docs/BUILD_PROMPTS.md` (P0–P18):
branches, setup lists, price lists, purchase orders, transfers and full accounts
are all in scope because this is sold to many shops, including multi-branch chains.
The list below is the original short version; BUILD_PROMPTS.md wins where they differ.

1. ~~**Supabase project + real logins**~~ — done (P0). Middleware, `pnpm shop:init`,
   `pnpm staff:add`, `pnpm check`, and the `/pin` screen all exist. Still outstanding from
   P0: the migration has never been applied to a live Supabase project, so the end-to-end
   acceptance test (sell a splitter, approve a discount) has not been run against one.
2. ~~**Branches, app shell and roles**~~ — done (P1).
   ~~**Setup lists, permissions, VAT and feature switches**~~ — done (P2). The ten setup
   lists share one config-driven editor driven by `src/lib/settings-schema.ts`; adding a
   list means adding a spec there, not writing a screen.
   **Products and price lists** — mostly done (P3); attributes, gifts, purchase-price
   fixing, the printable price view and price-list add/rename have no screens yet.
3. ~~**Import from BMS**~~ — done (P4), but built against synthetic samples: the real
   export still needs checking against the auto-mapping in `src/lib/import/schema.ts`.
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
