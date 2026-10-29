# The cash drawer

- **The drawer has two ends, and a cashier only sees one of them** (P8). This is the
  whole reason the shift exists: BMS never records cash received, so the bill prints
  "PAID" and nobody can tell a good day from one with money missing. `open_shift()`
  takes what is in the drawer now, `cash_movement()` records every taka that leaves for
  tea or the bank (an expense must name a category, or it cannot be added up later), and
  `close_shift()` works out expected = opening + cash taken in − change given + cash in
  − cash out, stores the difference, and returns **only "closed" to a cashier**. If the
  till showed the expected figure, counting would stop being a count: anyone short would
  type the expected number in. `expected_cash()` has no grant to `authenticated` at all.
  The owner sees expected, counted, difference and the totals per payment method, so
  bKash and card can be matched against statements. A cashier cannot sell without an
  open drawer — enforced by the `sales_require_open_shift` trigger rather than a sixth
  copy of `complete_sale()`, because the rule belongs to the sale row wherever it is
  inserted from. Owners are let through with a warning on screen: an owner locked out of
  their own till at 9pm stops using the app.
