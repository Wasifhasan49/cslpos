# CSL Counter — build prompts for Claude Code

Sequential prompts that take the foundation (database + counter screen) to a full
product that can replace BMS Smart Trader: first at CSL's store, then at any shop,
including chains with many branches.

## How to use

The prompts below ARE the plan. They're written tight on purpose, so Claude Code
doesn't need to re-plan or re-review them. That saves a lot of usage.

**Hands-off (recommended).** Paste this once in Claude Code, in the `cslpos` folder:

```
Read CLAUDE.md and docs/BUILD_PROMPTS.md. Work through the prompts in the table's
order, starting after the last one marked done in docs/PROGRESS.md (create it if
missing). The prompt text is the plan: don't re-plan or re-review it. For each one:
build it, run the checks listed in the ground rules, fix failures, commit as
"<number>: <name>", and add a line to docs/PROGRESS.md (done, 2-line summary, what
I should test). Skip prompts marked [You first] and note what you need from me. If
checks still fail after 3 fix attempts, note the problem in PROGRESS.md and continue
with the next prompt that doesn't depend on it. Keep going until all are done or
skipped.
```

When a session stops (usage limit, new day), open Claude Code and type:
`Continue from docs/PROGRESS.md.`

**One at a time.** `Read docs/BUILD_PROMPTS.md and do P5.` (any number).

Notes:
- Prompts marked **[You first]** need something from you; do it, then tell Claude Code
  "<number> is unblocked".
- Check `docs/PROGRESS.md` any time to see where it's up to and what to test.
- Reference material from the store is in `reports_samples/` (BMS report PDFs and
  screenshots). Keep it out of git. The reports are summarised in `docs/BMS_REPORTS.md`;
  read that, not the PDFs.

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
| P10a | Counter: everything BMS's sales screen can do | EMI, card details, exchange, extra fields, last price, bulk serials |
| P11 | Warranty lookup and claims | The computer-shop special |
| P12 | Owner dashboard (phone) | Per branch and whole business |
| P13 | Accounts 1: ledger, auto-posting, vouchers, cheques | Real double-entry books |
| P14 | Accounts 2: reports, period lock, export | Cash book, trial balance, P&L, balance sheet |
| P14a | Quotations, sales orders and challans | Quote → order with advance → deliver → bill later |
| P14b | HR: employees, attendance, salary | BMS HR module and the dashboard's attendance box |
| P14c | Sales reps, dealers and delivery points | SR targets, dealer networks, security deposits |
| P15 | SMS receipts and reminders | Receipts, due reminders, promotions |
| P16 | Printing: receipts, invoices, labels | Real hardware at the counter |
| P17 | Launch hardening and parallel run | Safe to trust with real money |
| P18 | Multi-shop signup and billing | Other shops can join and pay |

CSL's store needs P0–P12 to switch off BMS. P13–P14c bring the rest of BMS across, so
every BMS module has an equivalent.

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
- Later prompts add quotations, sales orders with advance payment, challans (deliver
  now, bill later), HR (employees linked to staff logins), sales reps with targets, and
  dealer delivery points. Design earlier work so these slot in without rework: a sale
  can come from another document, stock can be reserved, a customer can have several
  delivery addresses and an assigned sales rep, a staff login can belong to an employee.
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
- Transaction categories (BMS "Transaction Category"): owner-defined labels for
  classifying purchases, sales and expenses in reports (e.g. "Corporate", "Online",
  "Service"). Ask me what CSL uses them for if unsure; build them as a simple tagged list.
- Permissions (BMS User Access Control, User Default Access Control, User Permission
  Change, Print Permission, Cheque Print Permission, User Wise Store Fixing, User Wise
  Ledger Fixing, Menu Configuration): on top of roles, a permission list per action —
  sell, give discount (with limit), change price within band, see cost, void, return,
  reprint, print/export reports, print cheques, receive stock, adjust stock, transfer,
  approve, view accounts, edit settings. Default permission sets per role, then per-user
  overrides. Per-user access to specific branches/locations and (for P13) specific
  accounts/ledgers. Owner can hide menu items per role. Every permission change is
  logged. Database functions check permissions, not just the UI.
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
  and VAT (if on: flat amount or %), serial tracked, reorder level (per branch), active,
  photo, specification (free text, e.g. "i5-1235U / 16GB / 512GB"), weight.
  Blocking "serial tracked" changes when stock exists.
- Product attributes (BMS "Product Classification": Group, Brand, Category, Color,
  Size, Manufacturer, Article, Grade): a generic attribute system — the shop turns on
  which attributes it uses and defines their values; products carry them; search and
  reports can filter by them. Group and Brand are on by default.
- Non-inventory items (BMS "Inventory" checkbox off): services and charges like
  installation, OS setup, repair labour — sold at the counter, no stock tracked.
- Product default discount (BMS Discount FLAT/PCT on the product): an optional flat or %
  discount applied automatically to that product, within staff limits.
- Purchase price fixing (BMS "Purchase Price Fixing"): an agreed purchase price per
  product (optionally per supplier). Receiving goods (P5) pre-fills it and flags any
  invoice price that differs.
- Price view (BMS "Sales Price View" / "Sales Price MRP View"): a read-only, searchable,
  printable price list per price list and branch, for staff and for customers.
- A "Barcode" action on each product prints its label (P16 does the layouts).
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

- Suppliers (/suppliers): name, contact, phone, address (areas from P2), supplier group
  (BMS "Trader Group"), opening balance, notes. Shop-wide. "Cash supplier" option for a
  one-off seller with just a name and phone, no account (BMS "Cash Supplier").
- Receive goods: supplier (optional), supplier invoice no., date, branch/location,
  cash or credit purchase, lines by scan/search like the counter. Non-serial: qty +
  unit cost and line discount. Serial: scan serials one after another (scanner sends
  Enter), paste many, or enter a range with a common prefix (BMS "Serial Common",
  "Serial From/To") for sequential serials; scan a QR code that contains several serials
  (BMS "QR Code"); "Digit check": each product can set the expected serial length/pattern
  and wrong scans are rejected; "Auto serial" (BMS "A.G Serial") generates shop serials
  for items that have none, and prints barcode labels for them. Duplicates flagged before
  saving. While adding a line, show qty available, last purchase price and last serial
  received for that product.
- Import lines from Excel/CSV (a supplier's packing list with models, qty, cost,
  serials). Attach a photo/PDF of the supplier's invoice to the GRN. Pay the supplier
  right from the receive screen (cash/bank/bKash/cheque) for full or part payment.
  Document-level discount, extra charges and VAT/AIT. Extra costs (transport, labour) spread across lines by value. One
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
- Transfer routes (BMS "Branch Wise Transfer Fixing"): owner sets which branches may send
  to which; others are blocked.
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
  Returns can arrive by courier: record courier name and tracking number (BMS
  "Courier"); attach photos of the returned item.
- Optional approval (BMS Approve/Cancel menus): a shop setting so that sales, returns and
  challans above a value, or all of them, wait for manager approval before they post to
  accounts. Approve and Cancel are buttons on the document, never separate menus. Off by
  default.
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

## P10a — Counter: everything BMS's sales screen can do

```
[Ground rules]

Task: give the counter every capability of BMS's Sales Invoice/Bill screen WITHOUT
losing the 4-action simple sale. The simple sale stays exactly as it is; everything
below lives behind a "More options" area or appears only when relevant.

From BMS's sales screen (fields and buttons we saw):
- Customer details on the sale: Attention (contact person), address, BIN and NID for
  corporate buyers, narration/notes, "sold by" sales person (defaults to the logged-in
  user, can be changed; used for staff performance and commission).
- Additional info (BMS "Additional Info" / "Edit Details"): shop-defined extra fields
  on a sale (e.g. "Reference", "PO number", "Laptop password noted"), shown on the
  invoice if the shop wants.
- Payments:
  - Card: card type (from P2), bank, POS machine/account it went through (BMS "POS A/C
    No"), last 4 digits, card charge % — shop setting: charge added to the bill or
    absorbed by the shop.
  - EMI: EMI allowed yes/no per product/category, tenure (3/6/9/12/18/24/36 months)
    with the bank, bank EMI charge rules per tenure, shown on the receipt.
  - Split payment across any methods (cash + card + bKash + due), with change worked out.
- Exchange / trade-in (BMS "Exchange", "Product Exchange" total): take an old item from
  the customer as part payment — describe it, value it, optionally add it to stock as a
  used item (with serial), and deduct the value from the bill.
- Price help for staff: last price this customer paid for this product, and last selling
  price; qty available at this branch and other branches. "Show cost" exists only as a
  permission (P2), off for cashiers.
- Serial items in bulk (BMS "Bulk Qty", "Serial From/To"): sell a run of serials by
  scanning first and last, or paste a list; import sale lines from Excel for big
  corporate orders.
- Extra charges (delivery, installation) and discount types (P2) on the sale.
- Print choices at the end: receipt, A4 invoice, challan, money receipt, warranty
  stickers, "print directly" without preview (BMS "Direct Print"), and choosing between
  saved print templates (BMS "Custom Preview"). Layouts come from P16.
- complete_sale() (or its successor) gets the new fields; every new rule (EMI eligibility,
  card charges, exchange value limits, sales person) is enforced in the database.

Done when: a simple cash sale still takes 4 actions, AND I can do a ৳72,000 laptop sale
on 12-month EMI by card with the bank charge added, taking an old laptop in exchange for
৳15,000, with Attention and BIN filled, and the receipt shows all of it correctly.
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
- Problem types list (BMS "Problem Setup") and technician assignment (BMS "Engineer
  Fixing"). Items held for warranty are their own stock status, so the RMA stock report
  (P14) shows what's with the shop, with suppliers, and ready for pickup.
- Optional approval/cancel of claim steps by a manager, as a shop setting.
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
- BMS-style summary row (what owners are used to): cash sales, credit sales, sales
  returns, cash purchases, credit purchases, purchase returns, warranty/service bills,
  money received, money paid, staff present/late/absent (once P14b exists).
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
- Inter-branch vouchers (one branch pays for another), posting to both. The receiving
  branch must accept ("authenticate") an inter-branch journal before it posts on their
  side (BMS "Inter BR. Journal Authentication").
- Fund transfer between branches (BMS "Fund Received"): branch A sends cash or bank
  money to branch B; B confirms receipt; both cash books update.
- Bank and wallet accounts: balances, deposits, withdrawals.
- Cheques (BMS Cheque Book, Cheque Treatment, Cheque History): cheque books for bank
  accounts; cheques issued and received with status (issued, cleared, bounced,
  cancelled); bounced cheques reverse their entries and flag the customer/supplier.
  Print cheques onto the bank's cheque leaf (payee, amount in figures and words, date)
  with a per-bank layout, only for users with the cheque-print permission (P2).
- Respect per-user account access from P2 (BMS "User Wise Ledger Fixing").
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

docs/BMS_REPORTS.md is the checklist: every report there with an ID (P-, S-, ST-, A-, T-)
is in scope, with the columns, grouping and totals it lists. Match content and look
(its section 2); its
section 3 lists BMS errors to test against, section 4 what the reports need underneath
(including FIFO quantity layers; cost stays weighted average). Reports marked "needs
P14a" or "needs P14c" are built in those prompts: make each report one config entry so
they are quick to add. Use the defaults in its section 10 for the open questions. Don't
open reports_samples/.

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
- RMA service register and RMA stock register (BMS): claims and items under warranty.
- Report settings (BMS "Report Sort", "Customising Report Caption"): owner can rename
  report titles and column captions and set default sort order; saved per shop.

Period lock (BMS "Transaction Lock"): owner locks a month; nothing dated in it can be
created, edited, voided or returned without the owner unlocking (logged).

Export: Excel for everything; a Tally-compatible export of journal entries (research
Tally's import format; if it's too uncertain, a clean CSV + a note in CLAUDE.md).

Done when: the trial balance balances, the balance sheet's inventory equals the stock
valuation report, and locking September stops me from voiding a September sale.
```

---

## P14a — Quotations, sales orders and challans

```
[Ground rules]

Task: the BMS sales paperwork for corporate and bulk buyers (feature switch
"Sales documents"). BMS screens: Price Quotation, Sales Order, Sales Order Adjustment,
Sales Bill From Sales Order, Challan, Challan Return, Sales Bill From Challan,
Delivery Requisition approval. Walk-in sales at the counter stay exactly as they are.

Flow: Quotation → Sales order → Challan (goods leave) → Bill. Any step can be skipped
(order straight to bill, challan without order).

- Quotation: customer, items, prices from the customer's price list (P3), discount,
  VAT, extra charges, validity date, terms. Number QT-<branch>-2026-000001.
  Status: draft → sent → accepted / expired / lost. "Convert to order" or "to sale".
- Sales order: customer, delivery date, delivery point (P14c), sales rep, items, free
  items (BMS "Free" column), payment terms (days), advance received (method and
  account). Reserves stock at the branch: reserved qty shows on the counter as
  "4 in stock, 2 reserved" and can't be sold to walk-ins. Number SO-…
  Order adjust (BMS "Sales Order Adjustment"): change qty or cancel lines, releasing
  the reservation; logged. Approval rule: orders over ৳X or with discount over the
  user's limit need a manager (PIN or login).
- Challan (delivery note): from an order or standalone; pick serials for serial items;
  stock leaves the branch now, status "delivered, not billed". Partial deliveries
  show ordered / delivered / pending per line. Challan return brings goods back.
  Number CH-…
- Bill from challan or order: picks up delivered lines, applies the advance, the rest
  goes to cash/due as a normal sale through complete_sale() (or a sibling function
  that shares its rules). Warranty starts on the delivery date.
- Lists with filters: open quotations, orders by delivery date (late ones in red),
  delivered-not-billed challans with age, advances not yet used.
- Accounts (P13): advance = customer advance (liability) until billed; challan moves
  stock at cost to "goods delivered not invoiced"; the bill clears both. Tests that
  everything balances.
- Printables for all four documents (layouts in P16).
- The sales-order, delivery and challan reports marked "needs P14a" in
  docs/BMS_REPORTS.md.

Done when: I quote a company 10 keyboards, convert to an order with ৳5,000 advance,
the counter shows them reserved, I deliver 6 on a challan, bill those 6 using the
advance, deliver and bill the last 4 next week, and every ledger balances.
```

---

## P14b — HR: employees, attendance and salary

```
[Ground rules]

Task: the BMS HR module (Department, Profession, Designation, Position, Employee
Information) plus the attendance numbers BMS shows on its dashboard (Attendance, Late,
Absent), and a simple salary sheet. Feature switch "HR".

- Setup lists: departments, designations, positions, professions (shop-wide).
- Employees: name, photo, phone, address (areas), joining date, branch, department,
  designation, NID number, emergency contact, documents (upload), status (active /
  left with date). Optional link to a staff login (P0), so cashiers are employees
  too. Religion and nationality fields exist in BMS: include them as OPTIONAL and
  hidden unless the shop turns them on. HR data is owner/HR-manager only (new role
  'hr' or a permission), never visible to other staff. Salary fields are owner-only.
- Attendance: check-in / check-out from the app (staff tap "I'm in" at the branch,
  limited to the branch's own computers or a branch PIN, explain your choice), or a
  manager marks it. Shift start time per branch; late after a grace period; absent if
  no check-in. Leave types (casual, sick, annual) with balances and approval.
  Holidays per shop.
- Dashboard (P12): today's present / late / absent per branch, like BMS.
- Monthly attendance report per employee and branch (Excel/PDF).
- Salary sheet: monthly, per employee: basic + allowances − deductions (absence, advance
  taken) = net; mark paid (method, account); salary slip printable; posts salary
  expense to accounts (P13). Salary advances to staff tracked and deducted.

Done when: two employees check in (one late), one takes a day's sick leave, the dashboard
shows present/late/absent correctly, and the month's salary sheet deducts the right
amount and posts to the salary expense account.
```

---

## P14c — Sales reps, dealers and delivery points

```
[Ground rules]

Task: the distribution side of BMS for shops that sell through sales reps and dealers
(feature switch "Distribution"). BMS screens: SR Fixing, Trader wise SR Fixing, SR
Wise Target, Dealer Information, Retailer Information, Delivery Point Fixing, Customer
Security, Trading Wise Trader Flag Fixing, Trader Convert, Branch Wise Trader Transfer,
Trader Search.

- Sales reps (SR): an SR is an employee or staff member with a territory (areas from
  P2). Assign customers/dealers to an SR. Sales, orders and quotations record the SR
  (defaults from the customer).
- Targets: monthly targets per SR by amount, quantity, or category/brand. Achievement
  report: target vs actual, % done, per day run-rate, ranking. SR's own view on the
  phone shows only their numbers.
- Commission (optional setting): % of sales or of profit per SR, monthly statement.
- Customer types: retail, dealer, retailer (sub-dealer), corporate, with the price list
  from P3. "Convert" a customer from one type to another (cash → credit, retail →
  dealer), logged.
- Delivery points: a customer can have several delivery addresses with contact person
  and phone; orders and challans (P14a) pick one.
- Customer security deposit (BMS "Customer Security"): money a dealer leaves with the
  shop; recorded, refundable, held as a liability in accounts, shown on the customer.
- Customer flags (BMS "Trader Flag"): e.g. "blocked", "cash only", "VIP", which the
  counter respects (blocked customers can't buy on due).
- Move a customer's home branch (BMS "Branch Wise Trader Transfer"), with their dues.
- Customer search across all fields (name, phone, company, SR, area, type).
- The SR/MPO reports marked "needs P14c" in docs/BMS_REPORTS.md.

Done when: an SR with a ৳5 lakh monthly target sees 40% achieved on their phone after
I record their dealers' orders, a dealer with a ৳50,000 security deposit shows it on
their profile and in the accounts, and a blocked customer can't buy on due.
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
  terms, signature lines), chosen per branch. Match what the real BMS invoice carries:
  amount in words ("Taka One Thousand Only", plus a Bangla option), prepared by, entry
  time, print date and time, bill type (paid/due), payment date, sales person,
  customer and authorised signature lines, page x of y — and add what BMS lacks: serial
  numbers, warranty end dates, payment method and change. Logo, branch address, footer text. Invoice
  barcode for returns. Warranty lines with serials and end dates.
- Other printables in the same style: quotation, sales order, challan (P14a), GRN, PO,
  transfer slip, claim slip, payment and advance receipts, salary slip (P14b),
  customer/supplier statements. Report and statement printouts follow sections 2 and 3
  of docs/BMS_REPORTS.md (same header everywhere, A4, Dhaka dates).
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
  Owners can also download a full copy of their shop's data from Settings (BMS
  "DataBase Backup"), as Excel/CSV files in one zip.
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

## Coverage check against BMS

With P14a–P14c, every BMS module we photographed has an equivalent. Not seen in the
photos, so check before launch (P17): the RMA screens themselves, BMS's admin settings,
and the report lists not yet photographed (docs/BMS_REPORTS.md section 10). The inside of
the BMS reports is covered in docs/BMS_REPORTS.md. Anything found
there becomes a new prompt in this format, slotted in before P17.
