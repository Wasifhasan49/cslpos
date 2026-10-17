# CSL Counter — build prompts for Claude Code

Sequential prompts that take the foundation (database + counter screen) to a full
product that can replace BMS Smart Trader: first at CSL's store, then at any shop,
including chains with many branches.

## How to use

1. Do them **in order**. Each one assumes the ones before it are done and merged.
   The order matters: branches and price lists come early because almost everything
   else depends on them.
2. For each prompt: start a fresh Claude Code session in the `cslpos` folder, run
   `/autoplan`, paste the prompt, approve the plan, let it build. Then `/review` →
   `/qa` → `/ship` → `/context-save`, as usual.
3. Every prompt starts with the same **ground rules** block. Paste it each time.
4. Prompts marked **[You first]** need something from you before you paste them.
5. After each prompt, use the feature in the browser for 5 minutes. Most bugs show up
   there, not in tests.

| # | Prompt | What it gives you |
|---|---|---|
| P0 | Supabase + real logins | Sales saved for real |
| P1 | Branches, app shell and roles | Many branches per shop; each person sees only their screens |
| P2 | Setup lists and shop settings | Units, VAT, banks, card types, charges, areas, warranty terms |
| P3 | Products and price lists | Owner sets prices; retail/dealer/corporate tiers; min–max band; gifts |
| P4 | Import from BMS | No retyping hundreds of products |
| P5 | Stock in and stock corrections | Goods from suppliers, damage, counts, per branch |
| P6 | Purchase paperwork and supplier dues | Requisition → purchase order → receiving → supplier payments |
| P7 | Branch transfers | Move stock between branches with send/receive |
| P8 | Shifts and cash check | Catch missing cash |
| P9 | Sales history, reprint, void, returns | Mistakes and refunds |
| P10 | Credit sales (baki) and customers | Selling on due, collecting dues |
| P11 | Warranty lookup and claims | The computer-shop special |
| P12 | Owner dashboard (phone) | Per branch and whole business |
| P13 | Accounts 1: ledger, auto-posting, vouchers, cheques | Real double-entry books |
| P14 | Accounts 2: reports, period lock, export | Cash book, trial balance, P&L, balance sheet |
| P15 | SMS receipts and reminders | Receipts, due reminders, promotions |
| P16 | Printing: receipts, invoices, labels | Real hardware at the counter |
| P17 | Launch hardening and parallel run | Safe to trust with real money |
| P18 | Multi-shop signup and billing | Other shops can join and pay |

CSL's store needs P0–P12 to switch off BMS. P13–P14 bring accounts in line with BMS.

---

## Ground rules (paste at the top of every prompt)

```
Ground rules for this task:
- Read CLAUDE.md first (background, what we learned from BMS Smart Trader, product
  decisions, architecture) and docs/BUILD_PROMPTS.md for where this task fits.
- This is a product for MANY shops, some with MANY branches. CSL's single-branch
  store is the first customer, not the only one. Never hard-code anything about CSL.
- Stack stays: Next.js 15 App Router, TypeScript, Tailwind 4, shadcn-style components
  in src/components/ui, Zustand, Supabase (Postgres + Auth + RLS). Use pnpm. Don't add
  big new libraries without telling me why.
- Data scoping: every row has shop_id. Anything that happens at a place (stock,
  serials, sales, shifts, transfers, purchases, cash, vouchers) also has branch_id.
  RLS limits each login to its shop AND to the branches it's allowed to use.
  Catalogue data (products, price lists, setup lists, customers, suppliers, chart of
  accounts) is shop-wide.
- Business rules live in the DATABASE. Any write that touches money, stock, serials,
  prices, accounts or permissions goes through a Postgres function (security definer,
  `set search_path = public`, checks role, shop and branch inside). The browser never
  sends a price, cost or stock number that the database trusts.
- Counter staff (role 'cashier') must never read cost prices, PIN hashes, profit,
  accounts, or the audit log. Prove it with a test, not just the UI.
- Log sensitive actions to audit_log (who, what, before/after, branch).
- Document numbers (invoices, GRNs, POs, transfers, vouchers…) are per branch,
  never reused, and handed out inside the same transaction as the document.
- New migrations go in supabase/migrations/ with a timestamped name. Never edit an
  applied migration. Add checks to supabase/tests/ and keep scripts/test-db.sh passing.
- Keep demo mode working: anything new in the Backend interface (src/lib/backend/)
  gets a demo implementation with sample data (demo shop has 2 branches).
- UI: plain English, short sentences, tell people what to do next. Touch targets
  ≥ 44px. Works at phone width (390px), no sideways scrolling. Light theme, existing
  colour tokens in globals.css. Amounts in whole taka (formatTaka); codes and serials
  use the .code class. Advanced options stay hidden until a shop turns them on in
  Settings, so a small shop sees a simple app.
- Dhaka time (Asia/Dhaka) for all dates shown and all "today" logic.
- Before finishing: pnpm test, pnpm typecheck, pnpm lint, pnpm build, pnpm test:db
  all pass. Update CLAUDE.md (architecture + next steps) with anything that changed.
- At the end, explain in plain words what I can now do and how to try it.
```

---

## P0 — Supabase + real logins  [You first]

**Before pasting:** create a Supabase project (region Singapore). Run
`supabase/migrations/20261017000001_init.sql`, then `supabase/seed.sql` in its SQL
editor. Put the project URL and anon key in `.env.local` (see `.env.example`). In
Authentication → Users, create two test users (e.g. `owner@…` and `cashier@…`).

```
[Ground rules]

Task: make the app work against my real Supabase project with real logins.

1. Move auth to @supabase/ssr properly: server client, browser client, and middleware
   that refreshes the session and sends signed-out users to /login. Demo mode (no
   Supabase env vars) skips auth like today.
2. scripts/create-staff.ts (`pnpm staff:add`) using SUPABASE_SERVICE_ROLE_KEY from
   .env.local (server-only, never NEXT_PUBLIC): create/find the auth user, set a
   password, insert the staff row (shop, name, role, discount limit). Add the key to
   .env.example with a warning comment.
3. "Set my PIN" screen for owners/managers (4–6 digits, typed twice) using set_pin().
4. If the signed-in user has no staff row, show "This login isn't linked to a shop yet.
   Ask the owner." instead of a blank page.
5. README: exact steps to add a staff member.

Done when: I sign in as cashier, sell the sample splitter, see the sale in Supabase
with the right total and invoice number; sign in as owner, set a PIN, and approve a 10%
discount on a cashier sale with it.
```

---

## P1 — Branches, app shell and roles

```
[Ground rules]

Task: make the system multi-branch, then give it proper navigation by role. This is
a database change that everything later depends on, so get it right and test it hard.

Background: BMS has Company → Branch → Store (a store = a stock location inside a
branch, e.g. "Main Store", "Warehouse"). Many shops we'll sell to have several
branches. CSL has one.

Database (new migration):
- branches: shop_id, name, code (short, used in document numbers), address, phone,
  active. Every existing shop gets a "Main branch" and existing rows move to it.
- stock_locations ("stores" in BMS): branch_id, name, is_default. Each branch gets
  one default location. Keep it simple in the UI: only show locations when a branch
  has more than one.
- Stock moves from products.stock to a branch_stock table (product_id, location_id,
  qty). Serials get location_id. Sales, shifts, stock_movements, audit_log get
  branch_id. Invoice numbering moves from shops to branches
  (<shop prefix><branch code><year><6 digits>, e.g. CSLINV-MB-2026001790; keep CSL's
  numbering continuing from 1790).
- staff_branches: which branches each staff member can work in. Owners: all.
- Update complete_sale() and receive_stock(): they work in the user's CURRENT branch
  (passed in, checked against staff_branches) and its default location.
- RLS: a cashier at Branch A cannot read Branch B's sales, shifts or stock numbers
  (they CAN see that a product exists and its price). Owners see all branches.
  Managers see their assigned branches. Tests for all of this, with 2 branches.

App:
- Branch switcher in the header for people with more than one branch; remembers the
  last one; the counter shows the branch name clearly.
- Navigation: Counter, Sales, Warranty for everyone; Stock, Purchases, Transfers,
  Products, Customers, Suppliers for managers/owners; Dashboard, Accounts, Settings for
  owners (managers if the owner allows: settings flags). Placeholder pages for
  sections later prompts fill.
- Desktop top bar; phone bottom tab bar. Cashiers get at most 3 items.
- Role and branch checks in the UI AND on the server (redirect with a message). RLS
  stays the real guard.
- Settings → Branches: owner adds/edits branches and locations, assigns staff.
- Shared useStaff()/server helper: staff, role, shop, current branch, allowed branches.

Done when: in a shop with 2 branches, a cashier at Branch A can't see Branch B's sales
even by calling the API directly; stock sold at A doesn't change B's stock; the owner
can switch between branches and sees each one's invoice numbers.
```

---

## P2 — Setup lists and shop settings

```
[Ground rules]

Task: the setup lists BMS has under Primary Setup → General/Bank/Product Information,
done as one tidy Settings area instead of 20 separate screens.

Settings sections (owner, managers read-only unless allowed):
- Shop: name, logo, address, phone, email, BIN/VAT registration, receipt footer text,
  invoice prefix, currency (BDT default).
- Units of measure: pcs, box, metre, set… with decimals allowed or not (cable sold by
  the metre). Products get a unit (P3 uses it).
- Tax: VAT rates (name, %, inclusive or exclusive), AIT; HS codes (code, description,
  default VAT rate) for shops that import. A product can carry an HS code and VAT rate.
  The counter and complete_sale() calculate VAT correctly for inclusive and exclusive
  prices. Off by default ("This shop charges VAT" toggle).
- Extra charges: named charges added to a sale (delivery, installation, service), fixed
  or %, taxable or not. Discount types (e.g. "Eid offer", "Staff discount") for
  reporting why discounts were given.
- Payments: payment methods the shop accepts (cash, bKash, Nagad, Rocket, card, bank
  transfer, cheque, due) and which are on; card types and their charge %; bank
  accounts and mobile wallet accounts the money lands in (needed for accounts in P13).
- Areas: division → district → thana (upazila) list for Bangladesh, preloaded from a
  reliable public dataset (tell me the source), used in customer and supplier
  addresses. Countries list for suppliers.
- Warranty terms: named terms (e.g. "1 year replacement", "3 years service only") with
  months and the text printed on receipts. Products pick a term.
- Document settings: numbering per branch and per document type, with the next number
  editable by the owner (only forward, logged).
- Feature switches: VAT, multiple locations, price lists, credit sales, purchase
  orders, branch transfers, accounts, SMS. Off features disappear from menus.

All writes through functions with owner checks and audit_log entries. Seed sensible
defaults for a new shop.

Done when: I can turn VAT on, set 5% inclusive, sell an item, and the receipt shows the
VAT part correctly; a new shop starts with sensible defaults and nothing to configure.
```

---

## P3 — Products and price lists

```
[Ground rules]

Task: catalogue and pricing for owners/managers, including the price tiers BMS has.

Background: BMS has "Sales Price Fixing" with Retailer A/B/C and Dealer A/B/C prices
plus MRP with a lower and higher allowed price, per branch or all branches, and
"Customer Wise Discount" and "Sales Gift Fixing". At CSL the price list was EMPTY, so
staff typed prices by hand after peeking at cost. Our rule: prices are set by the owner
and fill in automatically; staff can only move within the allowed band.

Products (/products):
- List with search, category filter, quick filters (low stock, out of stock, inactive,
  serial items, no price set). Columns: name, code, category, price, cost and margin
  (managers only), stock for current branch and total, warranty.
- Add/edit: name, brand, model, code, barcode, category, unit, warranty term, HS code
  and VAT (if on), serial tracked, reorder level (per branch), active, photo.
  Blocking "serial tracked" changes when stock exists.
- Categories and brands: add, rename, reorder, merge (to fix BMS typos like
  "Convarter").

Price lists:
- price_lists: name (Retail, Dealer, Corporate… shop decides), active, default.
  Every shop has "Retail" as default. Each product has a price per list, an optional
  MRP, and an allowed band (min and max) per list.
- Optional branch override: a branch can have its own price for a product on a list.
- Customers get a price list (P10 uses it; walk-ins use the default).
- Customer-wise discount: a fixed % for a customer, applied automatically.
- Gifts/offers: "buy X get Y free" or "free item with product", with a date range;
  the free item goes on the sale at ৳0 and still leaves stock.
- At the counter: the price comes from the customer's list (branch override first).
  Staff can change the line price only within min–max; outside it needs a manager PIN.
  complete_sale() enforces all of this and logs overrides.
- Bulk price change: select products, set or adjust by % or taka per list, preview
  old → new, confirm. Price history per product from audit_log.

Writes through functions (upsert_product, set_prices, merge_categories,
bulk_update_prices) with role checks. Price lists hidden until the shop turns them on.

Done when: a dealer customer gets the dealer price automatically, a cashier can drop a
retail price only down to the minimum, and dropping it further asks for the PIN; as
cashier I still can't see cost or margin anywhere, including the network tab.
```

---

## P4 — Import from BMS  [You first]

**Before pasting:** at the store, export from BMS to Excel: product list (with prices
and warranty), current stock report, serial-number report, customer and supplier lists
if possible. Put them in a `bms-export/` folder in the repo, and add `bms-export/` to
`.gitignore` first (it's the shop's real data).

```
[Ground rules]

Task: an import wizard so any shop can move from BMS (or any spreadsheet) in one sitting.

First open the real files in bms-export/ and tell me what columns and quirks you see
(typos, merged cells, blank rows, codes with spaces, duplicates) before writing code.

- /settings/import (owner): imports for products, prices (per price list), opening
  stock per branch/location, serials, customers (with dues), suppliers (with dues).
- 4 steps each: upload .xlsx/.csv (explain library choice) → map columns (auto-guess
  from header names incl. BMS ones like "Model No/Caption", "Product Group"; remember
  mappings per shop) → review (every row OK / update / problem, in plain words;
  suggest category and brand clean-ups like "Convarter" → "Converter") → import in
  batches through functions that upsert by code, never delete, and log one audit
  entry with counts.
- Opening stock as stock_movements 'adjust_in', note 'Opening stock from import'.
  Opening customer/supplier dues become opening balances (P13 will post them to
  accounts; store them so that's possible).
- Dry-run toggle. Re-running the same file creates no duplicates.

Done when: the real BMS export goes into a fresh shop, re-running it changes nothing,
and the counter finds products by their BMS codes.
```

---

## P5 — Stock in and stock corrections

```
[Ground rules]

Task: receive goods directly (no purchase order) and fix stock when it's wrong, per
branch and location. P6 adds the formal purchase-order route on top of this.

- Suppliers (/suppliers): name, contact, phone, address (areas from P2), opening
  balance, notes. Shop-wide.
- Receive goods: supplier (optional), supplier invoice no., date, branch/location,
  cash or credit purchase, lines by scan/search like the counter. Non-serial: qty +
  unit cost. Serial: scan serials one after another (scanner sends Enter), paste many,
  or enter a range (BMS "Serial From/To") for sequential serials; duplicates flagged
  before saving. Extra costs (transport, labour) spread across lines by value. One
  function receive_goods() in one transaction; updates product cost using weighted
  average cost (explain it in CLAUDE.md, with a test). Number: GRN-<branch>-2026-000001.
  Viewable and printable later. Credit purchases add to the supplier's due.
- "Receive now, price later" (BMS "Purchase Without Price"): save without costs,
  flagged "Cost missing" until a manager fills them in.
- Cost correction after the fact (BMS "Purchase Price Amendment"): change a GRN line's
  cost, logged, recalculates average cost.
- Return to supplier: pick serials/qty and reason; reduces stock and supplier due.
- Stock correction (BMS Stock Amendment In/Out): + or − qty or serials, reason from a
  fixed list (Damaged, Lost, Found in count, Internal use, Other + note). Managers only.
- Stock count: pick a category or location, type what's on the shelf, see differences,
  apply as corrections in one go.
- Stock history per product and branch (who, what, why, when).
- Replace the old receive_stock() and update tests.

Done when: I receive 5 SSDs on credit by scanning serials, the supplier's due goes up,
I sell one, return one to the supplier, and the history shows all of it.
```

---

## P6 — Purchase paperwork and supplier dues

```
[Ground rules]

Task: the formal buying process from BMS, for shops that need it (feature switch
"Purchase orders"). Small shops keep using direct receiving from P5.

BMS chain: Purchase Requisition → Purchase Order → Order Wise Purchase (MRR, goods
received against the order) → Purchase Posting (approval) → accounts.

- Requisition: a branch asks for items (qty, needed by, note). Status: draft →
  submitted → approved/rejected (manager) → ordered.
- Purchase order: from one or more requisitions or from scratch; supplier, items, qty,
  agreed unit price, discount, extra charges, VAT, payment terms (days), delivery
  branch. Number PO-<branch>-2026-000001. Print/PDF to send to the supplier.
  Status: draft → sent → partly received → received → closed/cancelled.
- Receive against PO: opens P5's receive screen pre-filled; partial deliveries
  allowed; shows ordered / received / pending per line; prices locked to the PO unless
  a manager overrides (logged).
- Reorder suggestions: products at or below reorder level per branch, with average
  daily sales; one click to start a requisition or PO.
- Supplier dues: supplier ledger (purchases on credit, returns, payments), aging
  (0–30, 31–60, 60+ days), record a payment (cash/bank/bKash/cheque, which account),
  applied oldest first; payment receipt. Supplier statement PDF.
- Approvals: shop setting "POs over ৳X need owner approval" (manager PIN or owner
  login). No separate approve/cancel menus like BMS: approve and cancel are buttons on
  the document, with the reason logged.

Done when: a branch requests 10 keyboards, the owner approves, a PO goes to the
supplier, 6 arrive then 4 arrive, stock and supplier due update each time, and I pay the
supplier half and see the rest aged correctly.
```

---

## P7 — Branch transfers

```
[Ground rules]

Task: move stock between branches and locations, like BMS's Transfer and Receive menus,
but as one clear flow (feature switch "Branch transfers").

- Transfer request (optional): Branch B asks Branch A for items.
- Send: Branch A picks items (scan; serial items by serial), destination branch and
  location, note. Function send_transfer() takes stock out of A into "in transit".
  Number TR-<branch>-2026-000001. Printable transfer slip (goes with the goods).
- Receive: Branch B sees incoming transfers, checks what arrived (scan to confirm;
  mark short/damaged items with a reason), confirms. Stock goes into B. Shortages stay
  "in transit — disputed" until a manager resolves them (return to A, write off).
- Within one branch: move between locations (Shop floor ↔ Warehouse) in one step.
- Transfers move stock at cost (no profit); P13 posts inter-branch entries.
- Lists: outgoing, incoming, in transit with age; alert if in transit over 3 days.
- RLS: each branch sees transfers it sends or receives; owners see all.

Done when: Branch A sends 2 laptops by serial, they show as in transit, Branch B
receives one and marks one damaged, and stock and serial locations are right everywhere.
```

---

## P8 — Shifts and cash check

```
[Ground rules]

Task: open and close the cash drawer per branch so owners can see if money is missing.
In BMS nobody records cash received, so the drawer can't be checked. The `shifts`
table exists; make it branch-aware.

- Open shift: opening cash (with "Same as last close: ৳X"). open_shift(). One open
  shift per staff member per branch.
- Cash in/out during the day (expense, owner took cash, change bought) with reason.
  cash_movement(). Expenses pick an expense category (P13 posts them).
- Close shift: counted cash (optional note-by-note helper 1000 × _, 500 × _, …).
  close_shift() computes expected = opening + cash sales − change given − cash refunds
  + cash due collections − cash outs, stores the difference. Cashier only sees
  "Shift closed, thank you". Cashiers never see expected cash.
- Owner/manager view per branch: shifts with expected, counted, difference (red if
  short by more than a setting, default ৳50), totals per payment method so bKash,
  Nagad and card can be matched against statements.
- Rule: cashiers can't sell without an open shift; owners can, with a warning.

Done when: I open with ৳2,000, sell ৳1,000 cash, take ৳200 out for tea, close with
৳2,700 counted, and the owner sees "short ৳100" for that branch.
```

---

## P9 — Sales history, reprint, void and returns

```
[Ground rules]

Task: find any past sale, reprint it, and handle mistakes and returns.

- /sales: search by invoice, customer phone, serial, product; filter by date, branch,
  staff, payment method, status. Cashiers: their own sales today at their branch.
  Detail view with receipt layout and Reprint (marked "COPY").
- Void (same day, manager PIN, reason): void_sale() marks void, returns stock and
  serials, records refund method, logs. Voided numbers never reused.
- Return/exchange (within a setting, default 7 days; override with PIN): pick lines,
  qty, serials; refund by cash/bKash/Nagad/card/store credit/reduce due. return_sale()
  creates RET-<branch>-2026-000001, returns stock (faulty items → serial status 'rma',
  ask "Is it faulty?"), logs. Partial returns recalculate discount, VAT and gift items
  proportionally; write the rule in CLAUDE.md and test it.
- Returns are accepted at any branch of the same shop (stock goes back where returned).
- Exchange = return + new sale with the refund paying toward it, one counter flow.
- Cash refunds count against the open shift (P8).

Done when: I find yesterday's SSD sale by serial at another branch, return it as faulty,
the serial becomes 'rma' at the branch where it was returned, and the owner sees it
in the audit log.
```

---

## P10 — Credit sales (baki) and customers

```
[Ground rules]

Task: selling on due (BMS: Credit Customer, Periodical Credit Days/Limit, Due list with
SMS), plus a proper customer list. Feature switch "Credit sales".

- Customers (/customers): name, phone, company, address (areas), BIN/NID for
  corporate, price list (P3), customer discount, notes; purchase history across
  branches, total spent, warranty items owned. At the counter, typing a phone shows
  the name and price list.
- Customer groups (BMS "Trader Group"): Retail, Dealer, Corporate… for reports and
  default price list.
- Credit: allowed on due, credit limit, payment days, by managers only.
- Counter: payment method 'due' (allowed customers only) and split payments (part now,
  rest due). complete_sale() enforces customer required and limit (PIN to override).
- Collect payment: record method, amount, which account; applied oldest due first;
  receipt. Cash collections count in the shift (P8).
- Due list: per customer and branch, aging 0–30 / 31–60 / 60+, overdue vs payment
  days, "Remind" button (SMS in P15; until then copy a message).
- Customer statement PDF.

Done when: a corporate customer with a ৳50,000 limit buys a ৳72,000 laptop paying
৳30,000 now and ৳42,000 on due (with PIN for the limit), pays ৳20,000 next week, and the
due list shows ৳22,000 aged correctly.
```

---

## P11 — Warranty lookup and claims

```
[Ground rules]

Task: warranty the simple way. Claims are rare at CSL, but shops differ, so it must
handle a busy service counter too without BMS's 10 screens.

- /warranty lookup: one box for serial, invoice number or phone. Shows product, sold
  on, sold at which branch, sold by, customer, warranty term and "In warranty — 8
  months left" / "Out of warranty since …". Manual record for items sold before the
  switch (manager).
- Claims: problem, accessories received (checkboxes), photos, customer phone.
  Statuses: Received → Diagnosed → Sent to supplier → Back from supplier → Ready →
  Delivered (or Rejected / Repaired in-house). Each change timed and attributed.
  Swap unit: replacement serial recorded, old serial 'rma'. In-house repair: parts
  used come out of stock; optional service charge billed as a sale.
- Problem types list and technician assignment (BMS "Engineer Fixing").
- Claim slip WC-<branch>-2026-000001 for the customer.
- Claims list: by status, branch, technician, "waiting over 14 days". Supplier RMA
  list: what's with which supplier and since when.

Done when: I look up the SSD by serial, open a claim, send it to the supplier, get a
replacement back, deliver it, and the new serial carries the remaining warranty.
```

---

## P12 — Owner dashboard (phone first)

```
[Ground rules]

Task: the screen that sells this product to owners. Phone first. Whole business AND
per branch.

Data fix first: profit needs cost at the time of sale. Table sale_item_costs
(sale_item_id, shop_id, branch_id, unit_cost) filled by complete_sale() with the
weighted average cost, owners/managers only (RLS + test). Do NOT add cost to
sale_items (cashiers can read it).

Dashboard (/dashboard): all numbers from server-side Postgres functions, Dhaka time,
branch picker (All branches / one branch):
- Today: sales, profit, number of sales, average sale, each vs yesterday and vs same
  day last week. Per-branch comparison table when "All branches".
- Payment split (cash / bKash / Nagad / card / due).
- Busy hours (last 7 days).
- Best sellers by profit and quantity (7/30 days).
- Low stock per branch, with sold-in-last-30-days and "transfer from Branch B (has 8)".
- Dusty stock: not sold in 60+ days, money tied up (stock × cost).
- Staff: sales and discounts per person.
- Money owed: customer dues and supplier dues totals with aging.
- Watch list: discounts approved, price overrides, voids, returns, price changes, cash
  shortfalls, disputed transfers — latest 20, each linking to the record.
- Date range picker. Every number tappable to show what's behind it.
- Light charts (explain choice; plain SVG fine).

Done when: on my phone on 4G I see today's sales and profit for all branches in under
2 seconds, switch to one branch, and tap "Profit" to see the sales that make it up.
```

---

## P13 — Accounts 1: ledger, auto-posting, vouchers, cheques

```
[Ground rules]

Task: real double-entry accounts, matching what BMS's Accounts module does, but where
the everyday entries happen automatically. Feature switch "Accounts".

Explain double-entry in CLAUDE.md in plain words first (every taka goes in two places:
a debit and a credit that always balance), because I'll maintain this.

Database:
- Chart of accounts (BMS "General Accounts", "Accounts Group", "Sub Ledger"):
  groups (Assets, Liabilities, Equity, Income, Expenses) → accounts → optional sub-
  ledgers (each customer, supplier, bank account, wallet is a sub-ledger
  automatically). Seed a standard chart for a Bangladeshi trading shop (cash in hand
  per branch, bank, bKash/Nagad, receivables, payables, inventory, VAT payable, sales,
  sales returns, cost of goods sold, discounts, expenses…). Shop can add accounts.
- journal_entries + journal_lines (account, sub-ledger, branch, debit, credit,
  narration, source document). A constraint/function guarantees every entry balances.
  Entries are never edited; corrections are reversing entries.
- Auto-posting from every money event, inside the same transaction as the event:
  sale (by payment method, VAT, discount, COGS vs inventory at average cost), return,
  void, due collection, goods received (cash/credit), supplier return, supplier
  payment, stock correction (inventory loss/gain), branch transfer (inter-branch
  accounts), shift cash outs/expenses, opening balances from P4. Back-fill entries for
  existing data with a one-time function.

Screens (/accounts, owner and allowed managers):
- Vouchers (BMS Credit/Debit/Journal/Contra): receipt voucher, payment voucher,
  journal voucher, contra (cash ↔ bank). Number per branch. Optional two-step
  "entered → approved" (BMS "Voucher Posting") as a shop setting.
- Inter-branch vouchers (one branch pays for another), posting to both.
- Bank and wallet accounts: balances, deposits, withdrawals.
- Cheques (BMS Cheque Book, Cheque Treatment, Cheque History): cheque books for bank
  accounts; cheques issued and received with status (issued, cleared, bounced,
  cancelled); bounced cheques reverse their entries and flag the customer/supplier.
- Expense entry: quick screen for daily expenses by category and branch.

Tests: every auto-posted event balances; trial balance totals equal; a sale's COGS
matches its sale_item_costs; cashiers cannot read any journal data.

Done when: after a day of sales, returns, a supplier payment by cheque and a tea
expense, the cash-in-hand ledger for the branch equals the shift's counted cash plus
the recorded shortfall, and every entry balances.
```

---

## P14 — Accounts 2: reports, period lock and export

```
[Ground rules]

Task: the reports an accountant and owner need, and closing periods.

Reports (per branch and consolidated, any date range, PDF and Excel export, Dhaka
dates):
- Cash book and bank book (per account), day book (all entries for a day).
- Ledger for any account or sub-ledger (customer/supplier statement).
- Trial balance.
- Profit & loss (with gross profit from sales − COGS, then expenses), by month,
  branch comparison.
- Balance sheet.
- Receivables and payables aging.
- VAT report (output VAT on sales, input VAT on purchases) for shops that charge VAT.
- Stock valuation (qty × average cost) per branch/location, matching the inventory
  account balance (show the difference if any, it should be zero).
- Sales register, purchase register, stock register, transfer register, warranty
  register (BMS "Reports" menu equivalents), each a filterable list with totals.
- Modification register (BMS): the audit log as a report.

Period lock (BMS "Transaction Lock"): owner locks a month; nothing dated in it can be
created, edited, voided or returned without the owner unlocking (logged).

Export: Excel for everything; a Tally-compatible export of journal entries (research
Tally's import format; if it's too uncertain, a clean CSV + a note in CLAUDE.md).

Done when: the trial balance balances, the balance sheet's inventory equals the stock
valuation report, and locking September stops me from voiding a September sale.
```

---

## P15 — SMS receipts and reminders  [You first]

**Before pasting:** pick a Bangladeshi SMS gateway (e.g. SSL Wireless, BulkSMSBD, Alpha
SMS: compare price per SMS and sender ID rules), open an account, get the API key.

```
[Ground rules]

Task: SMS through <GATEWAY NAME> (docs: <LINK>), per shop (each shop can use its own
gateway account or ours).

- Server-only sending (route handler or Supabase Edge Function; explain choice). Keys
  never reach the browser.
- Templates per shop (BMS "SMS Format"): receipt, due reminder, warranty claim status,
  supplier PO, promotional. Placeholders {shop} {branch} {invoice} {total}
  {warranty_items} {due} {link}. Live character/part counter (GSM 160, Bangla Unicode 70).
- Receipt SMS from the counter (manual or automatic when a phone is entered).
- Due reminders from the due list, one or many.
- Warranty claim status updates to the customer.
- Promotional SMS (BMS "PromotionalSMS") to a customer group, with opt-out handling and
  a cost estimate before sending.
- sms_log: to, message, status, parts, cost, who, error. Monthly SMS usage per shop
  (for billing in P18). Rate limits; no duplicate sends. Test mode that logs only.

Done when: a real sale with my number sends me a receipt with the warranty date, and a
due reminder arrives for a test customer.
```

---

## P16 — Printing: receipts, invoices, labels  [You first]

**Before pasting:** note the store's receipt printer model and roll width (58/80 mm),
label printer (if any), and barcode scanner model.

```
[Ground rules]

Task: printing that works on real counter hardware: <PRINTER MODEL>, <LABEL PRINTER or
none>, <SCANNER MODEL>, and still works for other shops' hardware.

- Receipt layouts: 80 mm, 58 mm, A4/Letter invoice for corporate buyers (VAT/BIN,
  terms, signature lines), chosen per branch. Logo, branch address, footer text. Invoice
  barcode for returns. Warranty lines with serials and end dates.
- Other printables in the same style: delivery note (challan) for goods leaving before
  payment, GRN, PO, transfer slip, claim slip, payment receipts, customer/supplier
  statements, quotation (simple: items + prices + validity, convertible into a sale).
- Near one-click printing: dedicated print pages, correct @page size, documented Chrome
  kiosk-printing setup for counter PCs.
- Barcode labels (Code128) for products without one and for serial items; warranty
  stickers per serial (BMS "Serial Wise Sticker"); label size or A4 sticker sheets.
- The counter accepts scans of our own labels and of invoice barcodes (opens the sale
  for return/exchange).

Done when: a receipt prints cleanly on the store's printer and a label I print scans
straight into the counter.
```

---

## P17 — Launch hardening and parallel run with BMS

```
[Ground rules]

Task: make it safe to run with real money, then plan the side-by-side run with BMS.

- Security review (gstack /cso if available): RLS on every table; every security-
  definer function checks role, shop and branch; no service-role key in client bundles;
  no cost/profit/accounts data reachable by a cashier; cross-shop and cross-branch
  leakage tests. Fix findings.
- Load test: a shop with 5 branches, 20,000 products, 500,000 sales — the counter
  search and complete_sale stay fast; add indexes where needed and show timings.
- Playwright end-to-end tests: cash sale, serial sale, PIN discount, price override,
  void, return, transfer, PO receive, shift close, a voucher. Run in GitHub Actions
  with local Supabase on every push.
- Sentry (same setup as Kinetic CRM), shop/branch/staff ids on events, no customer
  phone numbers.
- Backups: Supabase options on our plan, plus a nightly per-shop export to storage.
- Vercel deployment, production env checklist, custom domain.
- Look up (don't guess) current Supabase and Vercel pricing for a commercial product;
  what we need for 1, 20 and 100 shops; write it in docs/COSTS.md.
- docs/PARALLEL_RUN.md: 2 weeks ringing every sale in both systems; nightly comparison
  of totals per payment method and 20 random stock counts; what to do when they differ;
  go/no-go checklist for switching BMS off.
- docs/STAFF_GUIDE.md (English + Bangla): one page for cashiers, one for managers, one
  for owners, with screenshots.

Done when: CI is green, it's live on Vercel, and I have the parallel-run and staff
guides ready for the store.
```

---

## P18 — Multi-shop signup and billing

Only after CSL's store has used it happily for a few weeks.

```
[Ground rules]

Task: any shop can sign up, set itself up and pay, without me touching the database.

- Landing page (English + Bangla) for shop owners: faster counter, prices staff can't
  change, cash check, branches, owner dashboard on the phone, warranty lookup,
  accounts, free move from BMS.
- Signup: owner account → shop → first branch → onboarding checklist (import products,
  add staff, set PIN, print a test receipt, make a test sale), with progress.
- Plans: e.g. per branch per month, with limits (branches, staff, SMS included) and
  feature switches tied to plans. Paid-until date; 7-day grace then sales blocked (not
  viewing) with a clear message. Manual bKash payment recording now; note in
  CLAUDE.md how to add SSLCommerz later.
- Super-admin area (separate role, not a shop role): shops, plan, branches, last
  activity, sales count, SMS usage; "view as shop" read-only for support, logged.
- Test: two shops with two branches each; prove no shop or branch sees another's data.

Done when: a friend signs up a test shop with 2 branches on their own, imports 10
products, sells one at each branch, and I see the shop in the admin area.
```

---

## Still not included (from BMS)

HR (departments, designations, attendance), sales orders with advance payment and
delivery dates, SR (sales representative) targets, dealer delivery points. If a paying
shop asks for one, write a new prompt in the same format and slot it in after P14.
