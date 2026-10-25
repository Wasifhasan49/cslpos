# Build progress

One line per prompt from docs/BUILD_PROMPTS.md, newest at the bottom.

| Prompt | Status | Summary | What to test |
|---|---|---|---|
| P0 | done | Real logins, staff/shop setup commands, Approval PIN with lockout, owner-only staff changes. Plan: docs/plans/P0-supabase-logins.md | Live sign-in once a Supabase project is connected (`pnpm check`) |
| P1 | done | Multi-branch: branches, stock locations, per-branch stock/serials/sales, staff_branches, per-branch invoice numbers (`DEMO-MB-2026000001`). App shell with role-based menu (desktop top bar, phone tab bar), branch switcher that remembers the last branch, Settings → Branches and staff, placeholder pages for P3-P13. 62 tests. | Switch branch at the top of the counter: stock should change (Main 4 splitters, Second 6) and a part-built sale should clear. Settings → Branches: add a branch, add a stock location, tick who works where. A cashier should see only Counter/Sales/Warranty. |

| P2 | done | Database and screens: units, VAT rates + HS codes, extra charges, discount reasons, payment methods, card types, bank accounts, warranty terms, transaction categories, a 17-key permission system (role defaults + per-person overrides, checked inside the functions), per-branch/per-type document numbering (forward only, logged), feature switches, and the real Bangladesh area list (8 divisions, 64 districts, 494 upazilas, from github.com/nuhil/bangladesh-geocode). VAT works end to end, inclusive and exclusive, and is recalculated after a discount. A new shop is seeded with sensible defaults by `seed_shop_defaults()`. Feature switches hide menu sections. Settings has five sections (Shop, Lists, Features, Who can do what, Document numbers); the ten setup lists share one config-driven editor. 67 tests. | Settings → Features: turn on Branch transfers and watch Transfers appear in the menu straight away; turn it off and it goes. Settings → Who can do what: pick "Just Razu (cashier)" and set Receive stock to "Can" — he should then be able to take a delivery without being made a manager. Turn VAT on, give the 850 keyboard a 5% inclusive rate, and sell it: the total stays 850 with 40.48 of VAT. |

| P3 | **mostly done** | Price lists (Retail default + any the shop adds), a price per product per list with MRP and a min–max **band**, optional per-branch override. At the till the price comes from the customer's list (branch override first); a seller may move it inside the band, below it needs a manager PIN, and every override is logged with list price, charged price and the money given away. Customers carry a price list and a standing discount that applies with no approval. Non-inventory items (services) sell with no stock. Buy-X-get-Y gifts go on at ৳0 and still leave stock. `/products` with search, category and quick filters, add/edit, per-list price + band editing, bulk price change with a preview, and category merging (for BMS typos like "Convarter"). Cost and margin are **absent** from the data a cashier receives, not just hidden. 166 database checks. **Not done: screens for product attributes, gifts, purchase-price fixing, the printable price view, and price-list add/rename** (all exist in the database and are tested). | Products → switch the price list to Dealer: the keyboard should become 750, floor 700. At the counter, add the keyboard, type 01811000000: the price should drop to 750 with a "Dealer prices are being used" banner. Tap "change price", try 650 — it should refuse below 700 and name the manager requirement; 700 should be accepted. As a cashier, confirm no cost or margin appears on /products at all. |

## Waiting on Wasif

- Supabase: the old test project no longer resolves (paused or deleted). Create a new
  one, update .env.local, apply all migrations in order, then run `pnpm check`.
  Everything below is tested against a local Postgres instead; only real sign-in and
  live RLS are unverified.
- Before P14: Claude (chat) reviews reports_samples/ (~100 BMS report PDFs + 5 images)
  and writes docs/BMS_REPORTS.md. P14 and P16 should use that file, not the PDFs.
