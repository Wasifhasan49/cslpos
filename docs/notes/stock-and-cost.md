# Stock: what it costs, where it is, and which delivery it came from

- **Weighted average cost** (P5). A shop buys the same SSD at 6,000 one month and 6,400
  the next. Overwriting the cost makes every unit already on the shelf retrospectively
  cost 6,400 and the margin on the cheap ones vanishes; leaving it alone makes the new
  ones look more profitable than they are. So the cost moves to the average of what is
  there: `(on hand x current average + received qty x received cost) / (on hand +
  received qty)`. On hand is the WHOLE SHOP, because a product's cost is a buying fact
  rather than a shelf fact. `apply_avg_cost()` subtracts the received quantity back off,
  because the caller has already put it on the shelf by then — forgetting that counts the
  new stock at the old cost as well and drags the average the wrong way.
- **Extra costs are spread by value, not evenly** (P5): a 72,000 laptop carries more of
  the delivery charge than a 350 adapter. The result is the landed cost, and that is what
  the average cost uses — otherwise the margin looks better than it is by exactly the
  cost of getting the goods there.
- **Transferred stock is off both shelves while it is in the van** (P7). `send_transfer()`
  takes it out of the sending branch and puts it NOWHERE; the goods are the transfer
  document until someone receives them, and serials go to `status = 'in_transit'`. The
  shop's on-hand dips for as long as the van is on the road, which is the truth — nobody
  can sell those units at either end. A hidden "in transit" location that counted as
  stock would make the figures add up on paper while letting a branch promise goods it
  hasn't got. A shortage is never absorbed: the transfer stays `disputed` until a
  manager says in `resolve_transfer()` whether the missing units went back or are a
  loss, and either answer is logged. Writing off does NOT deduct stock again, because
  it already left the shelf when it was sent. Transfer routes default to "anywhere";
  the first route an owner adds makes the list the rule.
- **FIFO layers track quantity and date, not value** (P14). Three kinds of report cannot
  be answered without knowing which delivery each unit came from: how long stock has
  been sitting, which purchase invoice a sold unit came in on, and what happened to one
  delivery. So `stock_layers` keeps the remaining quantity per delivery and the oldest
  is used first. **Cost stays the weighted average** decided in P5 — two units on the
  same shelf cannot be worth different amounts. The layers hang off ONE trigger on
  `stock_movements`, because every stock change in the app already writes one; a path
  that moved stock without touching layers would be a path whose ageing report quietly
  lies. A sale is the exception: its lines take their own layers, because
  `complete_sale()` writes the movement BEFORE the line exists, so the movement's
  trigger would have nothing to point at.
- **What it cost at the time, captured on the movement** (P14). The same lesson as P12's
  captured sale cost: the average moves every time stock is received, so valuing a
  write-off from three months ago at today's average is wrong by however much prices
  have moved — and the stock account and the stock valuation then disagree for ever,
  with nothing to say which is right. One trigger sets `stock_movements.unit_cost`, so
  no caller has to remember.
- **Imports upsert by code and never delete** (P4). A shop's export may be partial or
  last week's, so importing one must never remove anything, and re-running the same file
  must change nothing — that is what makes it safe to retry after a timeout. Opening
  stock SETS the figure rather than adding to it (re-importing would otherwise double the
  shelf) and records the difference as the movement. One audit entry per run with counts,
  not one per row. Files are parsed in the BROWSER with exceljs, so the shop's customer
  list never leaves their machine except as the rows they confirm. `xlsx` (SheetJS) was
  rejected: npm is stuck at 0.18.5 from 2022 with open advisories.
