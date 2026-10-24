# TODOS

Deferred work, with where it belongs. Written down because vague intentions are lies.
Source: /autoplan review of P0 (docs/plans/P0-supabase-logins.md), 2026-10-17.

## Before the store goes live on real money
- [ ] **Second Supabase project for Vercel previews.** Preview deploys currently share the
      one project, so a preview deploy writes to the store's real data. (P17)
- [ ] **Focus-ring contrast.** `--color-focus: #e8a33d` on white is ~2:1, under the 3:1
      minimum for non-text indicators. Global token in globals.css, so changing it restyles
      every screen — do it deliberately, not inside a feature step.
- [ ] **Owner-only `reset_pin(p_staff_id)`.** `set_pin()` is self-only and `pin_hash` is
      ungranted, so today nobody can clear a departed manager's PIN except the service-role key.
- [ ] **Password reset without the CLI.** Supabase invite/magic link, so the owner can serve
      a forgotten password without Wasif's laptop.
- [ ] **Sentry + backups + paid plans.** (P17, and step 10 of CLAUDE.md)

## P1 (branches)
- [ ] **`complete_sale()` holds the shop-row lock across `crypt()`** (~100ms), serializing
      every sale in a shop. Invisible at one counter; real for a chain with several terminals
      on one shop_id. NOTE: this lock also accidentally prevents product-lock-ordering
      deadlocks, since `p_items` order is browser-controlled — do not remove it without
      sorting the item loop by product_id first.
- [ ] **`revoke all ... from anon` only covers tables that existed when it ran.** Every table
      added in P1+ gets Supabase's default anon grants back. RLS is the real guard, so this is
      belt-and-braces — but add it to the P1 migration checklist.
- [ ] **Split `Backend` into `CounterBackend` / `AdminBackend`.** It is becoming a god object
      and every addition must be mirrored in demo.ts.
- [ ] **Is `staff.user_id` unique per shop or globally?** It is global today, so one person
      cannot hold staff rows in two shops — which collides with P1's `staff_branches`.
- [ ] **Staff management screen.** P0 ships a CLI; the screen needs P1's nav shell.

## P3 / P4 (products, import)
- [ ] **`listProducts()` loads the whole catalogue plus every in-stock serial, unpaginated.**
      Fine at hundreds; a problem at 20k.
- [ ] **Record sale duration and click count in `sales`.** The only way to prove the "faster
      than BMS" claim (BMS: ~50s, ~14 clicks). Only meaningful against the real catalogue.

## P17 (hardening)
- [ ] **Playwright E2E + CI** for sign-in -> sell -> PIN-approve. Would be the real
      2am-Friday test. An afternoon now, a week later.
- [ ] **Docker Compose Postgres for `pnpm test:db`** so it needs no host Postgres.
- [ ] **Rate limiting on sign-in** (separate from, and less valuable than, PIN lockout).
- [ ] **Session timeout / idle lock at the counter.** Needs a shop setting.

## P18 (multi-shop)
- [ ] **One `pnpm setup` wizard** that writes .env.local, applies the migration, creates the
      shop and the first owner. Needs the Supabase CLI or Management API.

## Open questions raised but not decided (the CEO voice; outside P0's scope)
- [ ] **Written IP/ownership agreement with CSL management** before this becomes a business
      living inside an employer's store: who owns the IP, whose data the pilot's is, what CSL
      gets, right to resell.
- [ ] **Validate that a second shop wants this** before P1 locks the multi-branch schema.
      BCS Computer City has hundreds of shops within walking distance.
- [ ] **Consider the read-only owner dashboard on top of BMS's Excel export** as a cheaper
      wedge than full replacement: no counter change, no staff retraining, no parallel run.
