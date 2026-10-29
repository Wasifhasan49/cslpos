# What BMS Smart Trader actually does, and what we are not copying

From 68 photos, a filmed sale and 100 printed reports, at the store in October 2026.
This is the evidence the product decisions rest on; `docs/BMS_REPORTS.md` covers the
printouts column by column.

### What we learned from studying BMS (68 photos + a filmed sale, Oct 2026)

- BMS is a full trading ERP: 12 menus, ~200 screens. Counter staff use about 5.
- The sales screen has ~40 fields and 22 buttons. Staff are not technical and struggle with it.
- A filmed sale of 2 audio splitters (৳1,000) took ~50 s and ~14 clicks. A third of that
  was hunting through three linked dropdowns (Group → Brand → Model), partly because the
  product was filed under a misspelled category ("Convarter").
- **Prices are typed by hand.** BMS's price list ("Sales Price Fixing") is empty, so staff
  click "Show Cost" and decide the price themselves. Owner risk: under-charging or skimming.
- **Payment is never recorded.** The bill prints "PAID" without cash or card being entered,
  so the drawer can't be checked at day end.
- **No customer data.** Every walk-in is "Cash Customer" with a default mobile of "2026-01-01".
- Invoices are A4, show "1 Year" warranty but no serial number or end date, and advertise BMS.
- BMS strengths a replacement must keep: serial/IMEI tracking, serial history lookup,
  warranty (RMA) tracking, price tiers with min/max, re-order levels, credit customers,
  EMI/card, VAT, exchange, Excel import, an edit log, user permissions.
- Warranty claims are rare at this store; they just need tracking, not BMS's 10-screen RMA flow.
- Internet at the store is reliable, so the app is online-only (no offline mode).
- BMS can export to Excel, so data can be moved over.

### Product decisions (copied from how Shopify POS, Lightspeed and Odoo do it)

- Owner/manager sets selling prices; they fill in automatically. Counter staff can't edit them.
- Each staff member has a discount limit (%); above it a manager PIN is required; every
  approval is logged. Price changes are logged too.
- Counter staff never see cost prices (separate table, blocked by row-level security).
- Owner dashboard (next): today's sales and profit vs yesterday/last week, best sellers,
  low stock, "dusty" stock (unsold 60+ days), sales per staff, busy hours, discount and
  price-change log, cash drawer check. Must work on a phone.
