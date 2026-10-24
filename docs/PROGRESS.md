# Build progress

One line per prompt from docs/BUILD_PROMPTS.md, newest at the bottom.

| Prompt | Status | Summary | What to test |
|---|---|---|---|
| P0 | done | Real logins, staff/shop setup commands, Approval PIN with lockout, owner-only staff changes. Plan: docs/plans/P0-supabase-logins.md | Live sign-in once a Supabase project is connected (`pnpm check`) |
| P1 | done | Multi-branch: branches, stock locations, per-branch stock/serials/sales, staff_branches, per-branch invoice numbers (`DEMO-MB-2026000001`). App shell with role-based menu (desktop top bar, phone tab bar), branch switcher that remembers the last branch, Settings → Branches and staff, placeholder pages for P3-P13. 62 tests. | Switch branch at the top of the counter: stock should change (Main 4 splitters, Second 6) and a part-built sale should clear. Settings → Branches: add a branch, add a stock location, tick who works where. A cashier should see only Counter/Sales/Warranty. |

| P2 | **part done** | Database side complete: units, VAT rates + HS codes, extra charges, discount reasons, payment methods, card types, bank accounts, warranty terms, transaction categories, a 17-key permission system (role defaults + per-person overrides, checked inside the functions), per-branch/per-type document numbering (forward only, logged), feature switches, and the real Bangladesh area list (8 divisions, 64 districts, 494 upazilas, from github.com/nuhil/bangladesh-geocode). VAT works end to end, inclusive and exclusive, and is recalculated after a discount. A new shop is seeded with sensible defaults by `seed_shop_defaults()`. Feature switches hide menu sections. **Not done: the Settings UI screens** (only Settings → Branches from P1 exists). 67 tests. | Turn VAT on in the database and sell the 850 keyboard: the total should stay 850 with 40.48 of VAT. A cashier should not be able to receive stock until the owner gives them that one permission. |

## Waiting on Wasif

- Supabase: the old test project no longer resolves (paused or deleted). Create a new
  one, update .env.local, apply all migrations in order, then run `pnpm check`.
  Everything below is tested against a local Postgres instead; only real sign-in and
  live RLS are unverified.
- **P2 is unfinished**: the Settings screens still need building (shop details, units,
  tax, charges, payments, warranty terms, categories, permissions, document numbers,
  feature switches). Everything they would write to already exists and is tested, so
  this is UI work on top of a finished database.
- Before P14: Claude (chat) reviews reports_samples/ (~100 BMS report PDFs + 5 images)
  and writes docs/BMS_REPORTS.md. P14 and P16 should use that file, not the PDFs.
