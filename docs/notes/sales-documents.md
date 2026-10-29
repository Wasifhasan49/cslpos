# Quotations, sales orders and challans (P14a)

The paperwork a corporate or bulk order needs. A walk-in buying a mouse is three taps
and stays three taps; a company buying ten keyboards wants a quotation on paper, then an
order with an advance, then the goods against a delivery note, then a bill — possibly in
two deliveries, possibly weeks apart. BMS has eight screens for that. This is the same
chain behind one feature switch (`sales_documents`, off by default), and **any step can
be skipped**: an order can go straight to a bill, and a delivery note can exist with no
order behind it.

    Quotation  →  Sales order  →  Challan (the goods leave)  →  Bill

- **Reserved stock is worked out, never stored.** An order holds stock at its branch;
  the counter shows "4 in stock, 2 reserved" and refuses to sell the two, because the
  alternative is explaining to a company that the goods they ordered and paid an advance
  on went to somebody who walked in. `reserved_qty()` sums the open order lines every
  time it is asked. A stored counter that a cancelled line forgot to decrement leaves a
  shop unable to sell a product it has on the shelf, and nobody can tell why.
- **A quotation moves nothing.** No stock, no money, no reservation — it is a promise
  about prices and it carries the date that promise runs out, which BMS has no field for,
  so its quotations are honoured for ever or argued about. Prices come from the
  customer's own price list, because a quotation at a price the till will refuse to
  honour is worse than no quotation. Once it has been sent it cannot be quietly
  rewritten, and marking one **lost** needs a reason: that is the only way a quotation
  log teaches the shop anything.
- **Where the goods are between delivery and billing.** The challan takes the stock off
  the shelf, because it has physically gone, and on the books it moves to "goods
  delivered, not invoiced" — an asset, because the shop still owns it until a bill says
  who bought it. Leaving it in stock would be the same lie P7 refuses about goods in a
  van. A serial goes to `delivered`: neither in stock nor sold, which is the truth, and
  what stops it being sold to somebody else while it sits at the customer's.
- **An advance is money HELD, not money earned.** There is no invoice yet, so it is a
  liability ("money held for customers") until there is one. Treating it as income is how
  a shop books profit on an order it has not delivered. Cash goes through the open drawer
  (P8), so the till still counts at the end of the day.
- **The bill still goes through `complete_sale()`.** A bill from a delivery note is a
  sale: the same VAT rules, the same discount band, the same approval, the same invoice
  sequence, the same receipt. So it goes through the one function that knows all that,
  with ONE documented exception — `p_extras->>'challan_id'` means the stock does not move
  again (the challan moved it) and the serials come from `delivered` rather than the
  shelf. A sibling function would have been a second copy of six hundred lines of sale
  rules, and the second copy is always the one that falls behind. `post_sale()` has the
  matching branch: a bill with a challan takes its cost of sales out of "delivered, not
  invoiced" instead of out of stock.
- **Goods back off a delivery note are not a sales return.** Nothing was sold, so there
  is nothing to refund: the stock goes back on the shelf and the order's delivered figure
  comes down, so the line is outstanding again and the reservation holds once more.
- **The figures to chase on** are on the lists: an order past its delivery date with
  something still to go, and a delivery note that has been out for days with nobody
  asking for the money.

Twelve of the reports P14 listed as "comes with P14a" now read real data
(docs/BMS_REPORTS.md section 4), including ST-18, where BMS prints quantities larger than
the shop physically has and nobody at the store could say what they meant. Ours reads it
as free to promise: on the shelf, minus what is already promised.
