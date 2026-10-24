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
- **Discount limits**: each staff member has a limit (default 5%). Above it, a named
  manager approves with their PIN. The approval is checked immediately and logged —
  and so is every failed attempt.
- **Approval PIN screen** (`/pin`, owners and managers): set or change the PIN that
  approves big discounts. Guessable PINs (`1234`, `0000`) are refused.
- **Payments**: cash (with change worked out and quick cash buttons), bKash, Nagad
  (transaction ID), card (last 4 digits).
- **Receipt**: invoice number, serial numbers, warranty end date per item,
  payment details. Prints on an 80 mm receipt printer or A4.
- **Counter staff never see cost prices.** The database enforces this, not just the screen.
- **Only the owner can change what staff may do.** Roles, discount limits and
  turning someone off go through one audited, owner-only path — a manager can't
  raise their own limit or promote themselves.
- **Demo mode**: runs with sample data and no setup, so anyone can try it.

## Try it (demo mode, 2 minutes)

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. No keys needed, nothing is saved. The demo approval PIN
is `1234` until you change it at `/pin` (demo changes last until you reload).

## Connect a real database (Supabase)

Four commands and some copying. Run `pnpm check` at any point and it will tell you
what is still missing.

1. **Install and create the project.**

   ```bash
   pnpm install
   ```

   Create a Supabase project (region: Singapore is closest to Dhaka).

2. **Create the tables.** In the Supabase SQL editor, run the files in
   `supabase/migrations/` **oldest first**:

   - `20261017000001_init.sql`
   - `20261017120000_auth_and_pin_hardening.sql`

3. **Add your keys.** Copy `.env.example` to `.env.local` and fill in all three
   values from Supabase → Project Settings → API. `.env.example` says exactly where
   each one is and which is safe in a browser.

   ```bash
   cp .env.example .env.local
   pnpm check          # confirms the keys work before you go further
   ```

4. **Create the shop.**

   ```bash
   pnpm shop:init
   ```

   It asks for the shop's name, address, phone, invoice prefix and the number to
   start invoices at — so each shop gets its own identity and its own numbering. If
   the shop is replacing another system, start the numbering where that one stopped.

   Add `--with-samples` to also load the sample catalogue (it needs
   `supabase/seed.sql` to have been run once in the SQL editor first).

5. **Add the first owner**, then everyone else.

   ```bash
   pnpm staff:add --email you@example.com --name "Your name" --role owner
   ```

6. **Set the approval PIN.** `pnpm dev`, sign in as the owner, open `/pin`, and set a
   4–6 digit PIN. Until someone does, big discounts can't be approved — and the
   counter says so at the moment it matters.

```bash
pnpm check    # everything green? you're done
```

## Add a staff member

```bash
pnpm staff:add --email ovi@csl.com.bd --name "Ovi" --role cashier --discount-limit 5
```

It creates the login (already confirmed, so they can sign in straight away), links
it to the shop, and prints a generated password **once**:

```
  project         abcdefgh.supabase.co
  shop            Computer Services
  email           ovi@csl.com.bd (new login)
  name            Ovi
  role            cashier
  discount limit  5%

Add this staff member? (y/n) y
✓ Created the login for ovi@csl.com.bd

✓ Ovi is a cashier at Computer Services
  staff id 7c1e… · discount limit 5%

  Password for ovi@csl.com.bd, shown once:

    rKpQ7mWxn4TfbcHy

  Give it to them directly. Nobody can read it back later.
```

Roles are `owner`, `manager` or `cashier`. Run it again for the same email to change
someone's name, role or limit. The password is never a command-line flag, so it can't
end up in your shell history — use `--password-stdin` if you want to choose it.

Other things it does:

```bash
pnpm staff:add --list                                 # who's in the shop
pnpm staff:add --email ovi@csl.com.bd --reset-password  # forgot their password
pnpm staff:add --email ovi@csl.com.bd --deactivate      # they left
pnpm shop:init --list                                  # shops in this project
```

A manager who forgets their **PIN** (not password) can sign in and set a new one at
`/pin`. Nobody else can reset it for them yet.

## Troubleshooting

Run `pnpm check` first — it names the problem and the fix. Common ones:

| What you see | What it means |
|---|---|
| "This login isn't set up yet" | The login works but has no staff row, or was turned off. Run `pnpm staff:add --list` and check the email matches exactly. |
| "No products yet" | The shop has an empty catalogue. `pnpm shop:init --with-samples`, or run `supabase/seed.sql`. |
| Demo mode when you didn't want it | A key is missing or blank in `.env.local`. `pnpm check` will say which. Set `NEXT_PUBLIC_DEMO_MODE=0` to force the real database and see the actual error. |
| "The database tables aren't set up yet" | The migrations haven't been run. See step 2. |
| "The Supabase keys were rejected" | Re-copy them from Project Settings → API, then restart `pnpm dev` — `NEXT_PUBLIC_` values are read at build time. |
| "Too many wrong tries… locked for 10 minutes" | Five wrong PIN attempts. Deliberate. The owner can see every attempt in `audit_log`. |

## Checks

```bash
pnpm test        # sale rules, redirect rules, staff lookup, demo backend (vitest)
pnpm typecheck
pnpm lint
pnpm build
pnpm test:db     # migrations + seed + database rule checks on a local Postgres
                 # needs psql and a running Postgres: PGHOST=/tmp PGPORT=5432 pnpm test:db
pnpm check       # is THIS install set up correctly?
```

`pnpm test:db` refuses to run against a Supabase cluster, because it creates its own
`auth` stub and the `anon` role is shared across a whole Postgres instance.

Note: `pnpm check` and `pnpm run doctor` are the same command. `pnpm doctor` on its
own runs pnpm's own built-in, not this one.

## How it's built

- Next.js 15 (App Router) + TypeScript + Tailwind 4 + shadcn-style components + Zustand
- Supabase: Postgres, logins, row-level security
- `src/middleware.ts` refreshes the session on every request and owns every redirect.
  The rules themselves live in `src/lib/auth-route.ts` as one pure function, so they
  are unit-tested rather than hoped about. If Supabase Auth can't be reached, the
  request is let through rather than treated as signed out — the database is the real
  guard, and bouncing a signed-in cashier to the login page mid-sale would lose the sale.
- `src/lib/backend/` has one interface with two versions: `demo.ts` (in the browser)
  and `supabase.ts`. The screens don't know which one they're talking to.
- `src/lib/sale.ts` holds the sale rules for instant feedback on screen.
  The database function `complete_sale()` checks the same rules again and is the
  only way a sale gets saved. Prices always come from the database, never the browser.
- PINs are checked by `verify_manager_pin()`, in its own transaction, so a failed
  attempt can be recorded. Inside `complete_sale()` it couldn't be: raising the error
  rolled the audit row back with it.

See `CLAUDE.md` for decisions, background and next steps, and `docs/BUILD_PROMPTS.md`
for the build plan.
