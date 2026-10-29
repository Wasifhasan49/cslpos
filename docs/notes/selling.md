# Selling: the counter, returns, credit and warranty

- **The full counter is additive, and the simple sale stays four actions** (P10a). BMS's
  sales screen has ~40 fields and 22 buttons; the capability is not the problem, the
  arrangement is. So the corporate fields, the exchange, the split payment, the sold-by
  and the shop's own extra fields all live behind one "More options" line, the card panel
  appears only when Card is picked, and the EMI panel appears only when every line can
  actually go on EMI. Everything new reaches `complete_sale()` as ONE `p_extras` jsonb
  rather than twelve more arguments — it was already on thirteen, and a twenty-six
  argument function is one nobody can call correctly. What the database enforces, not the
  screen: EMI only on products the owner allows, for a tenure the bank runs, above that
  plan's minimum; the card charge is the shop's decision (`shops.card_charge_mode`), not
  the cashier's; an exchange can never be worth more than the sale, because paying the
  difference out is a purchase and dressing it up as a sale hides it; and a split payment
  has to add up to what is being paid now, to the taka, or the drawer is wrong at closing
  time. `price_help()` gives the counter the last price this customer paid, the last
  price anyone paid, and where the stock is — deliberately **not** cost or margin, which
  stays behind the `see_cost` permission. The on-screen total includes the card and EMI
  charges, because a button saying 72,000 next to a receipt saying 74,880 is a lie.
- **The partial-return rule** (P9), because a sale is not a list of independent lines.
  A whole-sale discount was spread over all of them, so refunding a line at its shelf
  price gives back MORE than the customer handed over, every time there was a discount.
  Returning q of a line sold as `qty` for `line_total` therefore refunds
  `line_total × q / qty × (100 − discount_pct) / 100`, plus `vat_amount × q / qty` **only
  when the VAT was exclusive** — inclusive VAT is already inside that figure, and adding
  it again refunds the tax twice. Extra charges (delivery, installation) come back only
  on a whole-sale return: on a partial one the van still drove. `refund_for()` in the
  database and `refundFor()` in `src/lib/sale.ts` are the same arithmetic, tested with
  the same numbers in both places, so the screen shows what will actually go back.
  A faulty item never reaches a shelf: its serial goes to `rma` at the branch where it
  was handed in (returns are accepted at any branch — that is where the box is).
- **Void is not return** (P9). A void says the sale should never have existed: same day
  only, with a manager's PIN, stock and serials back, and the invoice number stays burnt
  because a sequence with holes needs explaining to an auditor. A return is a real event
  with its own document (`RET-<branch>-<year><6 digits>`), and a sale that has been
  partly returned can no longer be voided or the goods would come back twice.
- **A debt has to have somebody's name on it** (P10). This is the thing most likely to
  lose a shop money quietly, and BMS records every walk-in as "Cash Customer" with a
  mobile of 2026-01-01, so the debt belongs to nobody. Anything on due therefore needs a
  real customer, and the **credit limit is checked against what they will owe AFTER this
  sale** — three sales of 20,000 to a customer with a 50,000 limit is 60,000 of exposure,
  and checking each in isolation lets it through. Over the limit needs a manager's PIN
  and is logged with the limit, what was already owed and the new due. Collections come
  off the **oldest invoice first**, like supplier payments, and `overdue` is measured
  against the days THAT customer was given — a corporate buyer on 45-day terms is not
  late at 40, which is a different question from "older than 60 days". Cash collected
  goes through the open drawer (P8). Turning the credit-sales feature on also enables the
  "due" payment method, because a switch that changes nothing at the till is a bug.
  `customers.name` and `customers.name_text` were two columns for one fact (P9's search
  read the empty one); P10 merges them and drops `name`.
- **A replacement carries the REMAINING warranty, not a fresh one** (P11). A customer
  whose laptop dies in month 22 of 24 gets a machine covered for two more months.
  A fresh 24 months hands out cover the shop never sold; none at all is what makes
  people distrust a shop. `set_claim_status()` copies `warranty_until` from the claim
  onto the swap unit, and `warranty_lookup()` has a third branch for exactly this case —
  a swap unit left through a claim rather than a till, so it has no sale line of its own
  and would otherwise look up as unknown. Whether something was in warranty is recorded
  when the claim is OPENED, not worked out later: a claim opened on the last day of cover
  is in warranty even if it is settled three weeks after the term ran out.
  An item in for repair is neither stock nor the customer's — its serial sits at `rma`
  while the shop has it and `with_supplier` while somebody else does, which is what makes
  the RMA report answerable. Every status change is timed and attributed, because "how
  long have you had it?" is the question customers argue about.
- **Profit needs the cost at the time of sale** (P12). A product's average cost moves
  every time stock is received, so working out last month's profit from today's cost is
  wrong by however much prices have moved — and always in the flattering direction when
  costs are rising. `sale_item_costs` captures it per line as the sale happens, via a
  trigger on `sale_items` rather than a ninth copy of `complete_sale()`. It is a separate
  table, not a column on `sale_items`, because cashiers can read `sale_items` to print a
  receipt and a cost column there would hand every cashier the shop's margins. A line
  with no captured cost counts as **no profit**, not as pure profit, and the dashboard
  says how many such lines there are — a profit figure built on half-costed lines is
  worse than no figure. The whole dashboard comes back from ONE `dashboard()` call: on 4G
  in a shop, six round trips is six chances to be slow. Every headline figure can be
  tapped (`dashboard_detail()`), because a number an owner cannot open is one they have
  to take on trust, which is the whole complaint about BMS.
