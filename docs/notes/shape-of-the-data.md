# The shape of the data

- **Multi-shop AND multi-branch from day one**: every table has `shop_id`; anything that
  happens at a place (stock, serials, sales, shifts, movements) also has `branch_id`.
  The catalogue (products, categories, customers) is shop-wide, because a product is the
  same product everywhere. `current_branch_ids()` is the one source of truth for where a
  login may work; owners get every branch without a `staff_branches` row, so adding a
  branch can never lock the owner out of it. Stock lives in `branch_stock(product_id,
  location_id, qty)` — `products.stock` is gone, because it could only describe one place.
  Document numbers are per branch: `<shop prefix>-<branch code>-<year><6 digits>`.
- **Dhaka dates, not UTC slices.** `dhakaDate()` in `src/lib/sale.ts` turns a moment into
  its Dhaka calendar date. An ISO string's first ten characters are its UTC date, and
  Dhaka is six hours ahead, so between midnight and 6am slicing the string gives
  YESTERDAY — a shop open at 1am would see its night's takings land on the wrong day.
  The database already did this right (`at time zone 'Asia/Dhaka'`); the demo backend
  did not, until P12.
- **The Bangladesh area list** (divisions → districts → upazilas) is national reference
  data with no `shop_id`, generated into a migration by `scripts/gen-areas.mts` from
  github.com/nuhil/bangladesh-geocode. Re-run the generator rather than hand-editing.
