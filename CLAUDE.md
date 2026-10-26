# CLAUDE.md — CSL Counter

Context for Claude Code (and humans) picking this up. Read this before changing anything.

## What this is and why

CSL Technologies' first retail store (Computer Services, Shop 9 & 10, BCS Computer City,
Agargaon) uses **BMS Smart Trader** by Billing Master Software Ltd, about 2,000 BDT/month.
Most shops in the market use it too. CSL wants a simpler replacement, proven in its own
store first (management agreed), then sold to other shops. It runs **alongside BMS** at
first, not instead of it. Built solo by Wasif. It is a product for MANY shops, including
chains with many branches; CSL's single-branch store is only the first customer.

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

## Architecture

- Next.js 15 App Router, TypeScript, Tailwind 4, Zustand, lucide-react. UI components in
  `src/components/ui/` are hand-written in the shadcn style (the shadcn registry was
  unreachable when this was built). Running `npx shadcn add …` later is fine.
- Supabase for Postgres, auth and row-level security. Deploy on Vercel.
- **Auth**: `src/middleware.ts` refreshes the session and owns every redirect. The rules
  are a pure function in `src/lib/auth-route.ts` (unit-tested, deny-by-default: only
  `/login` is public). If Supabase Auth is *unreachable* the request is let through
  rather than treated as signed out — the database re-checks `auth.uid()` everywhere, and
  bouncing a signed-in cashier to `/login` mid-sale would destroy the sale (the cart is
  in-memory). `src/lib/env.ts` is the only place that decides demo mode; it has no
  imports so middleware can use it without pulling the backend into the edge bundle.
- **Demo mode is opt-in** (`NEXT_PUBLIC_DEMO_MODE=1`, or missing keys in development).
  It used to switch on whenever the keys were absent, so a production deploy with one
  forgotten env var served an open, sign-in-free counter. A half-filled `.env.local` is
  a config error, not demo mode.
- **Multi-shop AND multi-branch from day one**: every table has `shop_id`; anything that
  happens at a place (stock, serials, sales, shifts, movements) also has `branch_id`.
  The catalogue (products, categories, customers) is shop-wide, because a product is the
  same product everywhere. `current_branch_ids()` is the one source of truth for where a
  login may work; owners get every branch without a `staff_branches` row, so adding a
  branch can never lock the owner out of it. Stock lives in `branch_stock(product_id,
  location_id, qty)` — `products.stock` is gone, because it could only describe one place.
  Document numbers are per branch: `<shop prefix>-<branch code>-<year><6 digits>`.
- **Navigation rules are data**, in `src/lib/nav.ts`: one list says who sees which
  section, `canSee()` answers it, and the same function backs both the menu and the
  server guard (`src/lib/guard.ts`) so they cannot disagree. Cashiers get at most 3 phone
  tabs. Owner-only sections can be shared with managers by a settings flag.
- **Rules live in the database.** Sales, stock and serials have no insert/update policies;
  they change only through `complete_sale()` and `receive_stock()` (security definer).
  `complete_sale()` reads prices from `products`, checks stock, serials, discount limit,
  payment, phone; numbers the invoice (`<prefix><year><6 digits>`); sets warranty end
  dates in Dhaka time; logs approvals. It locks product rows in `product_id` order so
  two concurrent sales can't deadlock. Errors are short codes like `OUT_OF_STOCK:<name>`;
  `friendlyError()` in `src/lib/sale.ts` turns them into plain words — and a test greps
  the migrations so a new `raise exception` can't ship without a message.
- **PIN approvals go through `verify_manager_pin()`, not `complete_sale()`.** The counter
  names *which* manager is approving, that one person's PIN is checked immediately, and
  the function returns a single-use approval (10 minutes) that the sale consumes.
  It **returns** a result rather than raising, because raising rolled back the attempt
  row with it — which is why failed PINs used to leave no trace at all. Five wrong tries
  in 10 minutes locks that approver out. Every attempt lands in `pin_attempts` and
  `audit_log`. `set_pin()` also refuses guessable PINs (`1234`, `0000`).
- **Roles, discount limits and turning staff off are owner-only**, through
  `set_staff_access()`: it refuses self-edits, refuses to remove the last owner, and logs
  before/after. Before this, the `authenticated` UPDATE grant on `staff` included `role`,
  `discount_limit_pct` and `active`, so any manager could raise their own limit to 100%,
  promote themselves to owner, or deactivate the owner — unlogged. Only `name` is
  directly writable now.
- RLS helpers are wrapped as `(select public.current_shop_id())` so they are evaluated
  once per statement, not once per row.
- **Permissions sit on top of roles** (P2). 17 keys in `permission_keys`, defaults per
  role in `role_permissions`, per-person overrides in `staff_permissions`, and
  `has_permission()` / `permission_limit()` are what the FUNCTIONS check — so an owner
  can let one trusted cashier take deliveries without making them a manager. Owners
  always pass, or a shop could lock itself out of its own settings.
- **Feature switches** in `shop_features`, read by `feature_on()` and by `navFor()`, so
  an off feature has no menu item. Everything advanced is off for a new shop.
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
- **Purchase paperwork is one chain, not four menus** (P6). Requisition → purchase order
  → receiving against it. Approve, send, cancel and close are buttons on the document
  (`set_po_status()`), not BMS's separate approve and cancel menus, so a decision
  happens where the thing being decided is visible. `receive_against_po()` delegates
  the goods to P5's `receive_goods()`, so there is still ONE path that moves stock,
  writes serials and moves the average cost. Prices come off the order; a manager may
  override one and both figures are logged, because an order whose agreed price is
  quietly ignored is decoration. An order over `shops.po_approval_limit` goes to
  `awaiting_approval` instead of out. Supplier payments are applied **oldest first** in
  `supplier_aging()`, which is what a supplier assumes — newest-first would keep the
  oldest invoice perpetually overdue while the shop paid steadily.
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
- **Double entry, in plain words** (P13). Every taka is written down twice: once as a
  **debit** and once as a **credit**, and the two always add up to the same figure. A
  1,000 taka cash sale is 1,000 INTO the cash drawer (debit) and 1,000 OUT of sales
  (credit) — the same event seen from both ends, "where the money went" and "where it
  came from". Assets and expenses go UP on the debit side; liabilities, equity and income
  go up on the credit side, and that is the only rule there is. If the two columns of the
  trial balance ever differ, something is wrong — which is exactly what the report is for.
  Two **deferred constraint triggers** enforce it, so an entry that does not balance cannot
  be committed even by a bug; `post_entry()` is the one place an entry is written and
  numbered. Entries are NEVER edited: a mistake is put right with a **reversing entry**
  (the same lines with the sides swapped), because a corrected entry with no trace of the
  correction is indistinguishable from a cover-up. The everyday entries write themselves —
  sales, returns, deliveries, supplier payments, collections and drawer movements all post
  from triggers inside the same transaction as the event, so the books cannot drift from
  what happened. A person only types the handful BMS calls vouchers.
- **A cash purchase comes out of the drawer** (P13). `post_grn` and `post_supplier_payment`
  record a drawer movement for anything paid in cash, and they do it whether or not the
  accounts feature is on, because the till is short either way: without it the books said
  the money had gone while the drawer still expected it, and the cashier was short by the
  price of the delivery at closing time. The movement carries the document it came from,
  and `post_cash_movement` leaves those alone — the GRN's own entry already recorded the
  cash side, and posting it twice would halve the drawer.
- **A cheque is a promise, not money** (P13). It posts against the supplier or customer
  when it is written, and the bank balance moves only when it CLEARS; a bounce reverses
  the entry the cheque caused, which is why the cheque keeps that entry's id. Paying a
  supplier by cheque posts ONCE: the payment is the money event and the cheque is the
  paper it went out on, so `save_cheque()` takes the payment's existing entry rather than
  writing a second one. The words on a cheque are printed as well as the figures, because
  the words are what a bank honours when the figures have been tampered with —
  `taka_in_words()` and `takaInWords()` in `src/lib/cheque.ts` are the same arithmetic,
  tested with the same numbers, in crore/lakh/thousand rather than millions.
- **An inter-branch entry is not on the other branch's books until they accept it** (P13).
  The sender posts immediately (their money has gone); the receiver's side is written by
  `accept_inter_branch()`. A branch that can be charged without agreeing is a branch whose
  figures somebody else controls. Money sent lands in their cash book; a bill paid for them
  lands in the expense account the sender named, because handing them cash and paying their
  courier are not the same thing.
- **Turning the books on mid-life** (P13). `backfill_accounts()` does not keep a second
  copy of the posting rules: it touches each document so the same trigger that would have
  posted it at the time runs now, and the already-posted guard in every trigger is what
  makes it safe to press twice — which matters, because the first run on a shop with two
  years of sales will time out and the owner will press it again.
- **Dhaka dates, not UTC slices.** `dhakaDate()` in `src/lib/sale.ts` turns a moment into
  its Dhaka calendar date. An ISO string's first ten characters are its UTC date, and
  Dhaka is six hours ahead, so between midnight and 6am slicing the string gives
  YESTERDAY — a shop open at 1am would see its night's takings land on the wrong day.
  The database already did this right (`at time zone 'Asia/Dhaka'`); the demo backend
  did not, until P12.
- **Imports upsert by code and never delete** (P4). A shop's export may be partial or
  last week's, so importing one must never remove anything, and re-running the same file
  must change nothing — that is what makes it safe to retry after a timeout. Opening
  stock SETS the figure rather than adding to it (re-importing would otherwise double the
  shelf) and records the difference as the movement. One audit entry per run with counts,
  not one per row. Files are parsed in the BROWSER with exceljs, so the shop's customer
  list never leaves their machine except as the rows they confirm. `xlsx` (SheetJS) was
  rejected: npm is stuck at 0.18.5 from 2022 with open advisories.
- **The Bangladesh area list** (divisions → districts → upazilas) is national reference
  data with no `shop_id`, generated into a migration by `scripts/gen-areas.mts` from
  github.com/nuhil/bangladesh-geocode. Re-run the generator rather than hand-editing.
- `src/lib/sale.ts` repeats the rules for instant on-screen feedback. Keep the two in sync;
  the tests in `src/lib/sale.test.ts` and `supabase/tests/sales_rules_test.sql` cover the
  same cases (e.g. 5% off 450 → 23 discount, total 427).
- `src/lib/backend/` — `Backend` interface; `demo.ts` (in-browser sample data, mirrors the
  database rules) and `supabase.ts`. Demo mode turns on when Supabase env vars are missing.

## Conventions

- Plain English in the UI; short sentences; say what to do next ("Pick the serial number for …").
- Money: whole taka on screen (`formatTaka`), numeric(12,2) in the database.
- Touch targets ≥ 44 px; works at phone width; light theme only.
- Product codes and serials use the `.code` (monospace) class; amounts use `.num` (tabular digits).

## Setup commands

`pnpm check` (alias `pnpm run doctor` — bare `pnpm doctor` is pnpm's own built-in) checks
an install end to end and names the fix for each failure. `pnpm shop:init` creates a shop
with its own name, invoice prefix and starting number, so no shop inherits another's
identity. `pnpm staff:add` creates logins (with `email_confirm: true`, or they silently
cannot sign in), and does `--list`, `--deactivate`, `--reset-password`. It refuses to move
someone between shops without `--move`, because `staff.user_id` is globally unique and a
silent move orphans their past sales. Scripts are `.mts` so tsx runs them as ESM.

## Next steps (in rough order)

The full build plan, as step-by-step prompts, is in `docs/BUILD_PROMPTS.md` (P0–P18):
branches, setup lists, price lists, purchase orders, transfers and full accounts
are all in scope because this is sold to many shops, including multi-branch chains.
The list below is the original short version; BUILD_PROMPTS.md wins where they differ.

1. ~~**Supabase project + real logins**~~ — done (P0). Middleware, `pnpm shop:init`,
   `pnpm staff:add`, `pnpm check`, and the `/pin` screen all exist. Still outstanding from
   P0: the migration has never been applied to a live Supabase project, so the end-to-end
   acceptance test (sell a splitter, approve a discount) has not been run against one.
2. ~~**Branches, app shell and roles**~~ — done (P1).
   ~~**Setup lists, permissions, VAT and feature switches**~~ — done (P2). The ten setup
   lists share one config-driven editor driven by `src/lib/settings-schema.ts`; adding a
   list means adding a spec there, not writing a screen.
   **Products and price lists** — mostly done (P3); attributes, gifts, purchase-price
   fixing, the printable price view and price-list add/rename have no screens yet.
3. ~~**Import from BMS**~~ — done (P4), but built against synthetic samples: the real
   export still needs checking against the auto-mapping in `src/lib/import/schema.ts`.
   ~~**Stock in and corrections**~~ — mostly done (P5); supplier groups, line discounts,
   packing-list import, invoice attachments and the GRN print view have no screens yet.
4. ~~**Purchase paperwork and supplier dues**~~ — done (P6). Requisitions, purchase
   orders with approval limits, receiving against an order, reorder suggestions,
   supplier ledger and aging.
   ~~**Branch transfers**~~ — done (P7): send and receive with in-transit stock,
   disputed shortages, moves inside a branch, and transfer routes.
5. ~~**Shifts and the cash check**~~ — done (P8): open and close the drawer, cash in and
   out with reasons, and the owner's drawer check per branch at `/cash`.
6. ~~**Sales history, reprint, void and returns**~~ — done (P9): one search box for
   invoice, phone, serial or product; a COPY-marked reprint; void; and partial returns
   with the discount and VAT shares worked out.
   ~~**Credit sales and customers**~~ — done (P10): customer records with groups, credit
   limits and terms, selling part or all of a sale on due, collecting against the oldest
   invoice, a due list with aging, and a printable statement.
   ~~**The full counter**~~ — done (P10a): corporate fields, sold-by, shop-defined extra
   fields, card and POS details, bank EMI plans, exchange/trade-in, split payments,
   bulk serial picking and price help — all folded away so the simple sale is untouched.
   **Not done:** importing sale lines from Excel for a big corporate order, and the print
   choices (A4 invoice, challan, money receipt, warranty stickers, direct print) which
   belong to P16.
7. ~~**Warranty lookup and claims**~~ — done (P11): one box for serial, invoice or
   phone; claims with timed steps, technicians, parts out of stock, supplier RMA and a
   claim slip. **Not done:** photo attachments on a claim (the column is there), and
   billing an out-of-warranty repair as a sale from the claim itself.
8. ~~**Owner dashboard**~~ — done (P12): today's sales and profit against yesterday and
   last week, per branch, the BMS-style summary row, busy hours, best sellers, low and
   dusty stock, sales per person, money owed, and a watch list — all in one round trip,
   with every headline figure tappable. **Not done:** charts beyond the busy-hours bars,
   and staff attendance (waiting on P14b).
9. ~~**Accounts 1**~~ — done (P13): a seeded chart of accounts, auto-posting from every
   money event, vouchers with optional two-step approval, inter-branch entries the other
   branch has to accept, cheque books with clearing and bouncing, cheque printing onto the
   bank's leaf, an expenses screen, the trial balance and per-account ledgers, and a
   one-time back-fill. **Not done:** sub-ledger pickers on a typed journal voucher (the
   function takes them; the screen offers receipt, payment and contra), measuring a bank's
   cheque leaf from the UI (`save_cheque_layout()` exists, no screen), and everything in
   **P14** — reports, the period lock and export.
   Then SMS receipts and printing.
10. Before charging other shops: paid Supabase + Vercel plans, backups, error monitoring (Sentry).

Not planned yet: HR, sales orders with advance payment, SR targets (see BUILD_PROMPTS.md).

## Checks to run before shipping

`pnpm test && pnpm typecheck && pnpm lint && pnpm build`, plus `pnpm test:db` when the SQL changes.
