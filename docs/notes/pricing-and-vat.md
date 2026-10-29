# Prices, bands and VAT

- **Prices are set by the owner and fill in automatically** (P3), which is the whole
  reason this product exists: in BMS the price list is empty, so staff peek at cost and
  type a number. `resolve_price()` is the one answer to "what does this cost?" — branch
  override, then the list price, then `products.price` as a last resort so nothing is
  ever unsellable. Each price carries a **band** (`min_price`/`max_price`); a seller may
  move inside it, below it needs a manager's approval, and `complete_sale()` logs the
  override with the list price, the charged price and the difference. **No minimum set
  means the list price IS the floor** — the owner has given nobody permission to go
  below it. Prices are resolved in a first pass, before any stock moves, so the function
  knows whether an approval is needed before it claims one.
- A customer's price list and standing discount come from their phone number, so a
  dealer sees dealer prices before the sale is completed. The standing discount needs no
  approval (the owner set it) and does not stack with a manual one — the bigger wins.
- **VAT** is per line, not per total, in `complete_sale()`. Inclusive (the normal case
  here) does not change what the customer pays; exclusive is added on top. A discount
  reduces the taxable amount, so inclusive VAT is recalculated on the discounted line —
  doing it on the total overstates the tax on every discounted sale.
