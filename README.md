# CSL Counter

A fast, simple sales counter for computer shops. Built first for CSL's own store
(Computer Services, BCS Computer City) to run alongside BMS Smart Trader, then to
sell to other shops.

A sale takes about 4 actions: scan or search → quantity → payment → complete.
The filmed BMS sale took about 14 clicks and 50 seconds.

## What works today

- **Counter screen**: one search box (works with any USB barcode scanner), category
  filters, prices fill in from the owner's price list, stock shown on every product.
- **Serial items** (laptops, RAM, SSDs, routers): the sale won't go through until a
  serial number is picked. Sold serials leave stock.
- **Discount limits**: each staff member has a limit (default 5%). Above it, a
  manager types their PIN. Every approval is logged.
- **Payments**: cash (with change worked out and quick cash buttons), bKash, Nagad
  (transaction ID), card (last 4 digits).
- **Receipt**: invoice number, serial numbers, warranty end date per item,
  payment details. Prints on an 80 mm receipt printer or A4.
- **Counter staff never see cost prices.** The database enforces this, not just the screen.
- **Demo mode**: runs with sample data and no setup, so anyone can try it.

## Try it (demo mode, 2 minutes)

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. No keys needed. The demo manager PIN is `1234`.

## Connect a real database (Supabase)

1. Create a Supabase project (region: Singapore is closest to Dhaka).
2. In the SQL editor, run `supabase/migrations/20261017000001_init.sql`, then
   `supabase/seed.sql` (sample products, replace later with the BMS export).
   Or with the Supabase CLI: `supabase link` then `supabase db push`.
3. Copy `.env.example` to `.env.local` and fill in the project URL and anon key.
4. Create logins in Supabase → Authentication → Users (email + password), then link
   each one to the shop in the SQL editor:

   ```sql
   insert into staff (shop_id, user_id, name, role, discount_limit_pct)
   values ('00000000-0000-4000-8000-000000000001', '<auth user id>', 'Ovi', 'cashier', 5);
   ```

   Use role `owner` or `manager` for people who can approve discounts.
5. Set each manager's or owner's approval PIN (4–6 digits) in the SQL editor:

   ```sql
   update staff set pin_hash = extensions.crypt('4821', extensions.gen_salt('bf'))
   where name = 'Owner name';
   ```

   (There's also a `set_pin()` function for a future "Set my PIN" screen.)
6. `pnpm dev`, open http://localhost:3000, sign in.

## Checks

```bash
pnpm test        # sale rules, totals, demo backend (vitest)
pnpm typecheck
pnpm lint
pnpm test:db     # migration + 20 database rule checks on a local Postgres
                 # needs psql and a running Postgres: PGHOST/PGPORT/PGUSER env vars
```

## How it's built

- Next.js 15 (App Router) + TypeScript + Tailwind 4 + shadcn-style components + Zustand
- Supabase: Postgres, logins, row-level security
- `src/lib/backend/` has one interface with two versions: `demo.ts` (in the browser)
  and `supabase.ts`. The screens don't know which one they're talking to.
- `src/lib/sale.ts` holds the sale rules for instant feedback on screen.
  The database function `complete_sale()` checks the same rules again and is the
  only way a sale gets saved. Prices always come from the database, never the browser.

See `CLAUDE.md` for decisions, background and next steps.
