# BMS reports: what each one shows

This is the reference for P14 (reports) and P16 (printing). Use this file, not the PDFs in
`reports_samples/`. It was written from all 100 PDFs, printed from BMS at the store on
22 Oct 2026, and from the 5 photos of the report menus.

**What to copy:** what each report contains: the columns, the grouping, the subtotals and the
filters. **What not to copy:** the look and the bugs. BMS's quirks and errors are listed in
section 3 so we don't repeat them.

IDs used below: **P** = Purchase Register, **S** = Sales Register, **ST** = Stock Register,
**A** = Accounts Register, **T** = Transfer Register. The number is the report's position in
BMS's menu ("SL"). Where the menu photo was cut off, the number continues in the order the
samples were printed, and is marked †. "Sample" is the distinguishing part of the PDF file
name in `reports_samples/report samples/` (`T173340` = `CrystalReportViewer1 - 2026-10-22T173340…pdf`,
`(71)` = `CrystalReportViewer1 (71).pdf`). The sample shop has one branch. Most samples cover one
day (22 Oct), so many are empty and show only headings. Their columns are still exact.

---

## 1. How the BMS report screens work

- **Reports menu:** Purchase Register, Sales Register, Stock Register, Accounts Register,
  Transfer Register, Challan Register, RMA Service Register, RMA Stock Register,
  Modification Register. Only the first five were photographed or sampled. The other four
  are not covered here (P14 already lists them).
- **Each register is one screen:** a list of reports, with each row showing
  `SL | Caption | ☐ (checkbox) | Report SL | Print Preview | Print`.
  - "Report SL" and the captions can be changed by the owner. This is BMS's "Report Sort"
    and "Customising Report Caption" in Administrative Tools, and it is already in P14.
  - The checkbox appears to select reports for batch printing.
- **Filters seen on these screens:**
  - Company and Branch drop-downs at the top of every page.
  - Date From / Date To on every register.
  - An "All Date" checkbox on Accounts and Transfer.
  - An `All / Group Wise …` radio on Purchase. The rest of that row was cut off; it likely
    continues with Brand / Product / Supplier options.
  - A drop-down on Accounts, set to "Cheque Date Wise". The other value is likely "Voucher
    Date Wise".
- **Two kinds of date filter:** most reports take a date range (`22/10/2026 To 22/10/2026`).
  Stock and due reports take a single "as on" date.
- **Some lists are longer than the photos.** The Sales Register list has at least 44
  reports, not the 24 visible. The Stock Register list scrolls past #19, and the remaining
  items were not captured. The Accounts list has at least one more (A-24).

## 2. Common layout of every printout

- **Header:** logo on the left, shop name in bold, branch address on one line, then
  Phone / Email / Fax / Web (printed even when blank). Below that, the report title (bold,
  underlined, centred), then the date range or "as on" date.
- **Footer:**
  - `Print Date & Time: <date> <time>` on the left and `Page X of Y` on the right.
  - The column headings repeat on every page.
  - A few reports also print "Software developed by: Billing Master Software Ltd. Cell: …".
    We print nothing like that.
- **Product reports group by `Product Group → Brand → Product`.** A product without a brand
  goes under "N/A". There is a subtotal for each brand and each group, then a grand total.
- **Trader reports group by `Trader category (Customer / Supplier) → Trader group`.**
  Trader groups in the sample are "IDB" (shops in the market) and "Local Customer". There
  are subtotals at both levels, then a grand total.
- **Products have two names**, and reports use one or the other:
  - **Model No / Caption:** short, e.g. "Hp Blue Pin".
  - **Product Description:** long, e.g. "Hp Laptop Adapter Blue Pin".

  Keep both names and let each report choose. Default to the description, falling back to
  the model.
- **Rows link to their source.** "Date wise Sales" has a "Link: Click" column that opens the
  invoice. Every row in our reports that points at a document should open it when tapped.
- **Document numbers:** `CSLINV` (sale), `CSLPUR` (purchase), `CSLSRN` (sales return),
  then the year, then a 6-digit running number (e.g. `CSLINV2026001844`).
- **Cross-tab reports:** several reports turn a list into columns: one column per branch,
  per store (location) or per month, plus a Total column. Months print as "10. October"
  under the year.

## 3. BMS errors and quirks: don't copy these, and test that ours doesn't have them

These were found by comparing samples printed one minute apart on the same day.

1. **The books don't balance.** The Trial Balance (A-8) debit and credit totals differ, and
   the Balance Sheet (A-16) is out by the same amount. Our P13/P14 test is that both balance
   to the taka.
2. **BMS's stock reports disagree with each other:**
   - "Current Stock" (ST-1, ST-2, ST-6) and "Date Wise Stock" as on today (ST-11, ST-15)
     differ by 4 units and their value.
   - The Trial Balance uses one stock figure and the Balance Sheet uses the other.

   Ours must give one stock figure everywhere: current stock = stock as on today =
   inventory account.
3. **Profit is rounded inconsistently.** The Income Statement shows a whole-taka profit,
   while the Central Income Statement shows the same profit with 36 paisa added. Round once,
   in one place.
4. **Unit cost doesn't match the total.** In ST-6 the "Unit Cost" column doesn't always
   equal Total Cost ÷ Qty: it seems to print the latest purchase price, while the total uses
   average cost. In ours, unit cost must equal total ÷ qty.
5. **Cash sales show as not received.** "Sales Received" (A-14) shows cash sales under Sales
   but 0 under Received, because BMS never records the payment.
6. **Sales without a sales rep are left out.** The SR reports (S-11 to S-14) drop invoices
   that have no SR. In the sample, about a third of the day's sales were missing. Ours uses
   `sold_by`, which is always set, so every sale appears.
7. **"Top Sales" isn't sorted** (S-28): it prints in alphabetical order. Sort by amount,
   highest first.
8. **Printed titles don't match menu names**, e.g. menu "SR wise Item Sales Explicit"
   prints as "MPO wise Net Sales", and menu "…Pending for Purchase" prints as "…Pending for
   MRR". Two menu items print the same report (T-4 and T-5). Use one name for each report.
9. **Presentation:**
   - Paper sizes are mixed: Letter, A4 and a 900×612 pt size, in portrait or landscape.
   - Some footers use US dates (10/22/2026).
   - Some totals lack thousands separators, labels are cut short ("Sub Tota", "Menu."), and
     there are typos ("Combiend", "Recived", "Brach", "Debitt", "Paticulars").
   - Some printouts have no shop header.

   Ours: A4 everywhere (portrait, or landscape for wide reports), Dhaka dd/mm/yyyy, `৳` with
   thousands separators, and the same header on every report.

## 4. What these reports need underneath (for P14)

- **FIFO quantity layers (lot tracking).** Three kinds of BMS report depend on knowing which
  delivery each unit came from:
  - stock ageing by delivery (ST-9),
  - the purchase invoice shown on each sale line (S-2, S-15),
  - "Purchased Product Movement with Profit" (P-24).

  Serial items already carry this. For other items, BMS keeps the remaining quantity per
  receipt line and sells from the oldest first. **Default for P14:** give each GRN line a
  remaining quantity, use up the oldest first on sale, transfer out and supplier return, and
  give it back on returns. Record which receipt line each sale line came from. **Cost stays
  weighted average**, as P5 decided: the layers only track quantities and dates, not
  valuation or profit.
- **Opening stock imported from BMS** (P4) needs one layer per product, dated with the BMS
  purchase date where the export has it, or else the go-live date. BMS itself recorded
  opening stock as a purchase from a supplier named "Opening Stock".
- **"Without price" versions** (P-18, P-19) exist so staff who mustn't see cost can still
  check deliveries. Any report with cost or profit columns gets a version without them for
  users who lack the cost permission.
- **Data from later steps:**
  - P14 builds every report whose data exists by then.
  - **P14a** adds the sales-order, delivery and challan reports: S-21 to S-26, S-35 to S-37,
    S-42 and S-43 (delivered quantity), and ST-18.
  - **P14c** adds the reports for sales reps and MPOs (medical promotion officers; BMS uses
    MPO and SR interchangeably): S-11 to S-14, S-18, S-29, S-33 and S-41.

  P14 should build the report framework so these are one config entry each.

---

## 5. Purchase Register (25 in menu)

Screen filters: Date From, Date To, `All / Group Wise / …`.

| ID | Report | Sample | Layout |
|---|---|---|---|
| P-1 | Date wise Purchase | none | — |
| P-2 | Supplier wise Purchase | none | — |
| P-3 | Supplier wise Purchase Return | none | — |
| P-4 | Date wise Purchase Return | none | — |
| P-5 | Product wise Purchase | none | — |
| P-6 | Product wise Purchase Return | none | — |
| P-7 | Date Wise Purchase Requisition Pending for Purchase Order | none | — |
| P-8 | Date Wise Purchase Requisition Pending for Purchase | none | — |
| P-9 | Date Wise Purchase Order Pending for Purchase | T172930 | A4 portrait (empty) |
| P-10 | Date Wise Purchase Requisition | T172946 | A4 portrait (empty) |
| P-11 | Date Wise Purchase Order | T173000 | A4 portrait (empty) |
| P-12 | Product Wise Purchase Requisition Pending for Purchase Order | T173012 | A4 portrait (empty) |
| P-13 | Product Wise Purchase Requisition Pending for Purchase | T173027 | prints as "…Pending for MRR" |
| P-14 | Product Wise Purchase Order Pending for Purchase | T173041 | prints as "Product wise PO Pending for MRR" |
| P-15 | Product Wise Purchase Requisition | T173057 | A4 portrait (empty) |
| P-16 | Product Wise Purchase Order | T173117 | A4 portrait (empty) |
| P-17 | Product wise Purchase By Amount | none | — |
| P-18 | Supplier wise Purchase Without Price | T173137 | prints as "Supplier wise Purchase (WOP)" |
| P-19 | Product wise Purchase Without Price | T173152 | prints as "Product wise Purchase (WoP)" |
| P-20 | Store Wise Net Product Purchase | none | — |
| P-21 | Date Wise Net Product Purchase | T173214 | A4 landscape |
| P-22 | Supplier Wise Statement | T173234 | landscape |
| P-23 | Supplier and Product Wise Purchase | T173249 | A4 landscape |
| P-24 | Purchased Product Movement | T173304 | prints as "Purchased Products Movement with Profit" |
| P-25 | Supplier and Product wise Purchase Amendment Manual | T173322 | A4 landscape (empty) |

"MRR" means Material Receiving Report, i.e. goods received (our GRN). Columns and totals:

- **P-9 PO pending for purchase.** Grouped date → PO. Columns: `Purchase Order No. | Supplier Name | Product
  Description | Quantity | Unit`. Totals: per PO ("Invoice wise Total"), per date, "Total Pending
  Quantity". Pending = ordered − received.
- **P-10 Date wise requisition.** Columns: `Requisition No | Product Group | Product Description | Quantity | Unit`.
  Totals: per requisition, per date, Total Quantity.
- **P-11 Date wise PO.** Columns: `Order No | Requisition No | Product Group | Product Description | Quantity |
  Unit`. Totals as P-10.
- **P-12, P-13, P-15 (product wise requisition: pending for PO / pending for receipt / all).**
  Grouped product group → product. Columns: `Requisition No | Requisition Date | Product Code |
  Quantity | Unit`. Totals: per product, per product group, total (pending) quantity.
- **P-14, P-16 (product wise PO: pending for receipt / all).** Grouped product group → product.
  Columns: `Order No | Order Date | Requisition No | Supplier Name | Quantity | Unit`. Totals as
  P-12.
- **P-7, P-8 (no sample).** Same as P-10, filtered to requisitions not yet on a PO (P-7) or
  not yet received (P-8).
- **P-18 Supplier wise, without price.** Grouped supplier → date. Columns: `Date | Invoice No | Ref. No. |
  Product Description | Qty | UoM`. Qty subtotal per invoice, date and supplier; grand total
  qty. No money columns at all.
- **P-19 Product wise, without price.** Grouped product group → product. Columns: `Date | Invoice No |
  Supplier Name | Qty | UoM`. Subtotal per product and group; grand total qty.
- **P-21 Net product purchase.** Grouped group → brand → product. Columns: `Product Description | Purchase
  Qty | Unit Cost | Purchase Amount | Return Qty | Return Price | Return Amount | Net Qty |
  Net Purchase Amount`. Subtotals per brand and group; grand total.
- **P-22 Supplier statement.** One row per supplier with a balance or activity. Columns: `Supplier Name |
  Opening Balance | Purchase | Purchase Return | Net Purchase | Payment | Other Cr | Other Dr |
  Closing Balance`. Sub total and grand total. Closing = opening + net purchase − payment +
  other Cr − other Dr. A cash purchase shows the same amount under Purchase and Payment.
  Negative opening means the supplier owes us.
- **P-23 Supplier and product wise.** A flat list. Columns: `Date | Purchase No. | Supplier Name | Product Group |
  Product Brand | Product Description | Qty | Unit Price | Total Amount`. Grand total qty and
  amount.
- **P-24 Purchased product movement.** One block per purchase line:
  - supplier name as the heading, then `Invoice No.: … Date: …` and `Product Model: …`;
  - a small table with rows `Purchase`, `Sales`, `Stock in Hand` and columns
    `Transaction | Qty | Unit Price | Unit Cost | Cost Amount | Amount | Profit`;
  - "Total Profit" per block, and a grand total of profit.

  This shows what happened to each delivery. It needs the FIFO layers described in
  section 4.
- **P-25 Purchase amendment.** Columns: `SL | Date | Invoice No | Supplier Name | Product Description | Quantity |
  Rebate | Amount`; grand total. "Rebate" is a price adjustment from the supplier after the
  purchase. See the open questions in section 10.
- **P-1 to P-6, P-17 and P-20 (no sample).** Build these in the style of the reports above:
  - date / supplier / product lists of purchase lines with qty, unit cost and amount;
  - the return versions are the same against supplier returns;
  - P-17 is product totals sorted by amount;
  - P-20 is P-21 split by location.

## 6. Sales Register (24 in the photo, at least 44 in the sample)

Screen filters: Date From, Date To (Branch at the top of the page).

| ID | Report | Sample | Notes |
|---|---|---|---|
| S-1 | Date Wise Sales | T173340 | Letter portrait |
| S-2 | Product wise Sales | T173415 | A4 portrait |
| S-3 | Customer wise Sales | T173430 | |
| S-4 | Date wise Net Product Sales | T173445 | A4 landscape |
| S-5 | Customer wise Net Product Sales | T173457 | prints as "Customer Wise Net Sales(ALL)" |
| S-6 | Date Wise Gross Profit | T173527 | A4 landscape |
| S-7 | Product wise Gross Profit | T173547 | A4 portrait |
| S-8 | Date wise Sales Return | none | |
| S-9 | Product wise Sales Return | T173708 | empty |
| S-10 | Customer wise Sales Return | T173722 | empty |
| S-11 | SR wise Sales | T173734 | needs P14c |
| S-12 | SR wise Net Sales | T173826 | needs P14c |
| S-13 | SR wise Item Sales Explicit | T173852 | prints as "MPO wise Net Sales"; needs P14c |
| S-14 | SR wise Gross Profit | T173906 | needs P14c |
| S-15 | Explicit Product wise Sales | T173921 | identical to S-2 in the sample |
| S-16 | Customer wise Statement | T173938 | A4 landscape, 17 columns |
| S-17 | Branch wise Sales | T173952 | |
| S-18 | All SR wise Item Sales | T174005 | prints as "SR wise Net Sales"; needs P14c |
| S-19 | Date Wise Rebate | none | meaning unknown (section 10) |
| S-20 | Product wise Sales with Branch | T174029 | |
| S-21 | Date Wise Pending Sales Order | T174042 | prints as "Date Wise Pending Delivery"; needs P14a |
| S-22 | Date Wise Sales Order | T174055 | needs P14a |
| S-23 | Product Wise Pending Sales Order | T174108 | prints as "Product Wise Pending Delivery"; needs P14a |
| S-24 | Product Wise Sales Order | T174131 | needs P14a |
| S-25† | Customer wise Pending Delivery | T174152 | needs P14a |
| S-26† | Customer wise Sales Order | T174207 | needs P14a |
| S-27† | Date Wise Not Sales Product List | T174228 | 39 pages |
| S-28† | Date Wise Top Sales (Product wise) | T174302 | |
| S-29† | SR Wise Statement | T174318 | empty; needs P14c |
| S-30† | Product Group wise Net Sales | T174333 | A4 landscape |
| S-31† | Product Wise Sales Summary | T174346 | |
| S-32† | Date wise Sales Summary | T174401 | |
| S-33† | Product Group Wise Net Sales (MPO) | T174415 | needs P14c |
| S-34† | Branch Wise Sales Qty | T174427 | cross-tab |
| S-35† | Date wise Order Summary | T174439 | needs P14a |
| S-36† | Store wise Pending Sales Order | T174714 | needs P14a |
| S-37† | Date Wise Net Sales Order | T174729 | needs P14a |
| S-38† | Product Group Wise Net Sales by Customer | T174741 | cross-tab |
| S-39† | Product Group Wise Sales Qty | T174754 | cross-tab by month |
| S-40† | Branch Wise Net Sales | T174810 | cross-tab by month |
| S-41† | SR Wise & Customer Wise Statement | T174828 | empty; needs P14c |
| S-42† | Customer Wise Delivery | T174840 | empty; needs P14a |
| S-43† | Customer Wise Delivery Summary | T174850 | |
| S-44† | Branch Wise Sales (Amount) | T174909 | cross-tab |

Columns and totals:

- **S-1 Date wise Sales.** Grouped date → bill type ("Cash Bill", and presumably "Credit Bill"). Columns:
  `Invoice No | Ref No | Trader Name | Entered by | Total Amt | Discount | Ex. Char. | VAT |
  Amount | Link`. Subtotal per bill type and per date; grand total of the five money columns.
  "Entered by" is the staff member. Walk-in sales show trader "cash".
- **S-2 and S-15 Product wise Sales.** Grouped product → date. Columns: `Invoice No | Customer Name | Purchase
  Invoice | Ref. No. | Qty | Unit Price | Amount`. Product subtotal (qty, amount); grand total.
  **Purchase Invoice** is the GRN the unit came from (blank for services); it needs FIFO layers.
- **S-3 Customer wise Sales.** Grouped customer → date → invoice. Columns: `Invoice No | Product Description | Qty |
  Unit Price | Discount | Net Unit Price | Amount`. "Invoice wise Total Amount" (qty, amount),
  "Customer wise Total Amount", grand total.
- **S-4 Net product sales.** Grouped group → brand → product (model name). Columns: `Product Description | Sale Qty |
  Unit Price | Sales Amount | Return Qty | Return Price | Return Amount | Net Qty | Net Amount`.
  Subtotal per brand and group; grand total.
- **S-5 Customer net product sales.** Grouped customer → numbered product lines. Columns: `SL | Product Description | Sales Qty |
  Unit Price | Sales Amount | Return Qty | Unit Price | Return Amount | Net Qty | Net Amount`.
  Subtotal per customer; grand total.
- **S-6 Date wise Gross Profit.** Grouped by date. Columns: `Invoice No | Trader Name | Total Amount | Discount |
  Extra Charges | AIT | VAT | Net Payable Amount | Total Cost | Gross Profit | Profit %`. Date
  total and grand total, where Profit % = gross profit ÷ net payable. A service with no cost
  shows 100%.
- **S-7 Product wise Gross Profit.** Grouped by product group. Columns: `Product Description | Qty | Unit Price | Total
  Price | Unit Cost | Total Cost | Gross Profit | Profit %`. Group subtotal (qty, price, cost,
  profit, %); grand total.
- **S-9 Product wise Sales Return.** Columns: `Invoice No | Customer Name | Qty | Unit Price | Total Price`, grouped by
  product; grand total.
- **S-10 Customer wise Sales Return.** Columns: `Invoice No | Product Description | Qty | Unit Price | Total Price`, grouped
  by customer; grand total.
- **S-8 (no sample).** Like S-1 for returns.
- **S-11 SR wise Sales.** Grouped SR → date → invoice. Columns: `Invoice No | Customer Name | Total Amount | Discount |
  Extra Charges | AIT | VAT | Net Amount`. Subtotal per date and SR; grand total.
- **S-12 SR wise Net Sales.** One row per SR. Columns: `SR Name | Sales Qty | Return Qty | Sales Amount | Sales Return
  Amount | Net Sales Amount`; grand total.
- **S-13 SR wise Item Sales Explicit.** One SR per block (`SR Name: …`), then customer → product group →
  product. Columns: `Product Description | Sale Qty | Unit Price | Sales Amount | Return Qty | Unit
  Price | Return Amount | Net Qty | Net Amount`. Group subtotal (sales, return, net), customer
  total, grand total.
- **S-14 SR wise Gross Profit.** Grouped SR → date → invoice. Columns: `Invoice No | Customer Name | Total Amount |
  Discount | Extra Charges | AIT | VAT | Amount | Total Cost | Gross Profit`. Subtotals; grand
  total.
- **S-16 Customer wise Statement.** Grouped by trader group, one row per trader. Columns:
  `TraderName | Opening | Sales | S.Return Qty | Net Sales | Sales Qty | S.Return Qty |
  Purchase Qty | P.Return Qty | Purchase | Pur.Return | Receive | Payment | Other Cr | Other Dr |
  Discount | Due`. Group subtotal; grand total. It covers traders who both buy from and sell to
  the shop (other shops in the market), so purchases and payments to them reduce what they
  owe. Our customer and supplier records must allow one trader to be both. A negative Due
  means the shop owes them.
- **S-17 Branch wise Sales.** Grouped branch → date → invoice. Columns: `Invoice No | Customer Name | Total Amount |
  Discount | Extra Charges | AIT | VAT | Amount`. Subtotal per date and branch; grand total.
- **S-18 All SR wise Item Sales.** Grouped SR → product group → product. Same 9 columns as S-13. Subtotals per group
  and SR; grand total.
- **S-20 Product wise Sales with Branch.** Grouped branch → product → date. Columns: `Invoice No | Customer Name | Qty | Unit Price |
  Discount | Net Unit Price | Amount | Profit`. Product subtotal (qty, amount, profit); branch
  total; grand total.
- **S-21 Pending sales orders (pending delivery).** Columns: `Order No | Customer Name | Product Description | Pending Qty`. Subtotals
  per order and date; grand total.
- **S-22 Date wise Sales Order.** Columns: `Order No | Customer Group | Customer Name | Total Amount | Discount | Extra
  Charges | Ait | Vat | Amount`. Date total; grand total.
- **S-23 Product wise pending delivery.** Columns: `Product Name | Quantity`, grouped by product group; grand total.
- **S-24 and S-26 (sales orders by product / customer).** Columns: `Invoice No | Customer Name | Qty | Unit Price | Discount | Net Unit
  Price | Amount`; subtotal; grand total.
- **S-25 Customer wise pending delivery.** Columns: `Product Name | Quantity`. Totals per product group and customer; grand total.
- **S-27 Not sold in period.** Columns: `SL | Model No | Product Description`, listing every product with no sale in the
  range. BMS lists even products with zero stock (1,636 rows for one day). Ours shows products
  **in stock** with no sale in the range, with qty, stock value and days since last sale. This
  is the "dusty stock" view from the owner dashboard.
- **S-28 Top sellers.** Columns: `SL | Model No | Qty | Amount`; grand total. Sort by amount, highest first, with
  a "top N" option.
- **S-29 SR statement.** One row per customer under each SR. Columns: `TraderName | TraderAddress | Opening | Sales | S. Return | Net Sales |
  Purchase | Pur. Return | Receive | Payment | Journal Cr. | Journal Dr. | Cheque Rec. | Chq Paid
  | Closing Balance`.
- **S-30 Product group net sales.** Grouped brand → product group rows. Columns: `Product Brand/ Group | Sale Qty | Unit Price |
  Sales Amount | Return Qty | Return Amount | Net Qty | Net Amount`. Brand subtotal and grand
  total, then a `Discount:` line (invoice-level discount) and a `Net:` line. Unit Price on a
  group row = amount ÷ qty.
- **S-31 Product wise sales summary.** Grouped by date. Columns: `Invoice No | Customer | Product Model | Qty | Unit Price |
  Discount | Net Unit Price | Amount`; grand total.
- **S-32 Date wise Sales Summary.** Every invoice printed as a mini-bill:
  - a line with `<customer> Invoice No: … Ref No: … Date: …`;
  - item rows `Product Caption | Qty | Unit Price | Discount | Net Unit Price | Amount`;
  - then total qty, Total Amount, Narration, VAT, Less Discount, Service Charge and Net
    Payable Amount.

  Report footer: `Total VAT | Total AIT | Total Discount | Total Service Charge | Total`.
- **S-33 Product group net sales for one SR** (the SR's name prints under the title). Columns: `Product Group | Sale Qty | Unit
  Price | Sales Amount | Return Qty | Unit Price | Return Amount | Net Qty | Net Amount`; grand
  total, Discount, Net.
- **S-34 and S-44 (branch cross-tabs).** Per product group: rows = products, columns = one per branch + Total.
  Values are qty (S-34) or amount (S-44). Group Total row.
- **S-35 Date wise Order Summary.** The S-32 mini-bill layout for sales orders (`Order No. | Ref No. | Order Date`).
- **S-36 Store wise pending sales orders.** Columns: `Product Name | Qty`. Totals per product, product group, customer and store
  (location); grand total.
- **S-37 Date wise net sales orders.** The S-4 layout for sales orders.
- **S-38 Group sales by customer.** Per customer group heading (e.g. "Cash Customer"): rows = product groups, columns =
  customers + Total, values = qty.
- **S-39 Group sales by month.** Rows = product groups; columns = year → month ("10. October") + Total. Each cell
  holds qty and amount; there is a Total row.
- **S-40 Branch sales by month.** Rows = branches; columns = months + Total; values = net sales amount.
- **S-41 SR and customer statement.** Grouped SR → customer group. Columns: `Trader Name | Address | Opening | Sales | Sales
  Return | Discount | Net Sales | Receive | Other Dr | Other Cr | Due`. Subtotal, SR total,
  grand total.
- **S-42 Customer Wise Delivery.** Columns: `Date | Order No | Customer Name | Invoice No | Product Description | Qty |
  Unit`; grand total.
- **S-43 Customer Wise Delivery Summary.** Grouped by customer. Columns: `Product | Qty | Unit`; grand total (e.g. "8.00 PCS").
  Direct counter sales count as delivered.

## 7. Stock Register (19 visible; the list scrolls further)

Screen: Branch at the top; each row has Print Preview / Print. Filters weren't visible in
the photo. The "Date Wise" reports take an "as on" date, which prints under the title.

| ID | Report | Sample | Notes |
|---|---|---|---|
| ST-1 | Current Stock (Combined) with Cost | T174932 | 31 pages |
| ST-2 | Current Stock (Combined) | (71) | |
| ST-3 | Current Stock (Warehouse Wise) | none | |
| ST-4 | Current Stock (Warehouse Wise) with Cost | none | |
| ST-5 | Current Stock With Serial | (72) | serial items only |
| ST-6 | Combined Current Stock (All BR Summary) | (73) | |
| ST-7 | Product Ledger (Combined) | none | |
| ST-8 | Current Stock (With Branch) | (74) | prints as "Branch wise Current Stock"; A4 landscape, cross-tab |
| ST-9 | Current Stock With Ageing | (75) | needs FIFO layers |
| ST-10 | Current Stock With Serial Ageing | (76) | A4 portrait |
| ST-11 | Date Wise Stock with Cost | (77) | |
| ST-12 | Date Wise Product Status | (78) | A4 landscape |
| ST-13 | Current Stock With Serial Cost | (79) | 152 pages |
| ST-14 | Product Ledger With Order (Combined) | none | |
| ST-15 | Date Wise Stock | (80) | |
| ST-16 | Date Wise Stock Warehouse Wise With Cost | none | |
| ST-17 | Current Stock All Store | (81) | cross-tab by location |
| ST-18 | Date Wise Stock Sales Order Basis | (84) | needs P14a |
| ST-19 | Product Ledger (Warehouse) | none | |

Files (82) and (83) are missing from the folder. They are probably the product ledgers.

- **ST-1 Current stock with cost.** Grouped group → brand → product. Columns: `Product Model | Qty | UoM | Unit Cost | Total
  Cost`. Brand subtotal (qty, cost), group subtotal, grand total (qty, total cost). Unit cost is
  the average cost.
- **ST-2 Current stock.** Grouped group → brand → product. Columns: `Product Model | Unit of Measurement | Qty`.
  Subtotals per brand and group; grand total qty.
- **ST-3 and ST-4 (no sample).** ST-2 and ST-1 split by location (store) inside the branch.
- **ST-5 Current stock with serials.** One block per product (product name as the heading). Columns: `Invoice No | Product Description |
  Serial`, where Invoice No is the GRN it arrived on. Per product "Sub Total" (count); "Total Qty"
  at the end.
- **ST-6 All-branch summary.** Grouped by product group. Columns: `Product ID | Product Description | Qty | Unit Cost | Total
  Cost`. Group subtotal (qty, cost); grand total. In BMS, unit cost doesn't always match
  (section 3, item 4).
- **ST-7, ST-14, ST-19 Product ledger (no sample).** Every stock movement of one product with a running balance:
  date, document, in, out, balance. "With Order" adds sales-order commitments. "Warehouse" does
  it per location. Build this: it is the product equivalent of an account ledger, and every
  stock figure in other reports should be traceable through it.
- **ST-8 Branch cross-tab.** Per product group: `Product Name | <one column per branch> | Total`; group Total row.
- **ST-9 Ageing by delivery.** Grouped by product group. Columns: `InvoiceNo | ModelNo | Qty | Purchase Date | Age`
  (days, as on today). One row per delivery that still has stock (FIFO layer). A sales return
  shows as its own row, dated the return (`CSLSRN…`). No totals.
  - **Add:** bucket totals (0–30, 31–60, 61–90, 91–180, 180+ days) with qty and value. That is
    what the owner actually acts on.
- **ST-10 Serial ageing.** Grouped by product group. Columns: `InvoiceNo | ModelNo | Serial | Purchase Date | Age (Day)`.
  One row per serial in stock.
- **ST-11 Stock with cost as on a date.** Grouped by product group. Columns: `Product ID | Model No | Product Description | Qty |
  Unit Cost | Total Cost`. Group subtotal; grand total. Stock as it stood on that date.
- **ST-12 Date Wise Product Status.** The stock movement summary. Grouped group → brand → product
  (model). Columns: `Model No | Opening | Purchase | P. Return | Sales | S. Return | Amend. In |
  Amend. Out | Item Issue | Others In | Others Out | Transfer | Received | Closing`.
  - BMS prints the amendment columns as "Menu. In / Menu. Out". They are most likely Stock
    Amendment In and Out.
  - "Item Issue" is stock used internally or for repairs.
  - Brand subtotal, group subtotal and grand total on every column.
  - Closing = Opening + Purchase − P.Return − Sales + S.Return + Amend.In − Amend.Out −
    Item Issue + Others In − Others Out − Transfer + Received.
  - Must always reconcile with ST-15 at both dates.
- **ST-13 Stock with serials and cost.** One block per product (model, then description, as headings). Columns: `Invoice No | Date |
  Supplier Name | Qty | Status | Serial | Unit Cost`.
  - One row per delivery and serial still in stock. Status is "Purchase" or "Sales Return";
    opening stock shows supplier "Opening Stock".
  - Non-serial items appear too, with Serial blank.
  - Subtotal per invoice and per product; Total qty.
- **ST-15 Stock as on a date.** Grouped group → brand → product. Columns: `ModelNo | Product Description | Qty`. Subtotals;
  grand total.
- **ST-16 (no sample).** ST-11 split by location.
- **ST-17 Location cross-tab.** Per product group: `Product Name | UoM | <one column per location, e.g. "Main Store">
  | Total`; group Total row.
- **ST-18 Stock on sales-order basis.** Grouped group → brand → product. Columns: `Model No | Product Description | Qty`.
  The quantities are much larger than physical stock, and the list includes products not on
  the shelf. The meaning is unclear; see section 10. Until answered, build it as "available to
  promise" = on hand − reserved for open sales orders (needs P14a reservations).

## 8. Accounts Register (23 in menu, plus at least 1)

Screen filters: All Date checkbox, Date From, Date To, and a "Cheque Date Wise" drop-down
(the other option is probably "Voucher Date Wise"). This decides whether cheque entries are
dated by cheque date or entry date. Build it as a filter on the cheque and bank reports.

| ID | Report | Sample | Notes |
|---|---|---|---|
| A-1 | Branch Wise Due List | (85) | Letter landscape |
| A-2 | Bank Summary | (86) | empty |
| A-3 | Accounts Ledger | none | |
| A-4 | Date Wise Credit Voucher | (87) | empty, landscape |
| A-5 | Date Wise Debit Voucher | (88) | empty |
| A-6 | Date Wise Journal Voucher | (89) | empty |
| A-7 | Due List | (90) | prints as "All Traders Due List"; A4 portrait |
| A-8 | Trial Balance | (91) | |
| A-9 | Income Statement | (94) | |
| A-10 | Day Book | (95) | 2 pages |
| A-11 | Accounts Layer Wise Summary | none | |
| A-12 | Due List Without Treatment | (96) | identical to A-7 in the sample |
| A-13 | Bank Interest Calculator | none | |
| A-14 | Date Wise Sales Received | (97) | |
| A-15 | Date Wise Sales Received Explicit | (98) | 6 pages |
| A-16 | Balance Sheet Tree Format | (99) | |
| A-17 | Chart Of Accounts | (100) | landscape |
| A-18 | Supplier Information | T175942 | A4 portrait |
| A-19 | Trader Information | T175956 | prints as "Customer Information" |
| A-20 | Date Wise General Income | T180007 | |
| A-21 | Date Wise General Expenses | T180021 | |
| A-22 | Central Income Statement | T180031 | all branches |
| A-23 | Central Balance Sheet | T180046 | all branches |
| A-24† | Date wise Contra Voucher | T180115 | landscape |

- **A-1 Branch due list.** "As on" date. Rows grouped by trader group (customer groups and "Supplier").
  Columns: `Group | Name | <one column per branch> | Total`; group total; grand total. Signs
  are mixed (customer debts and supplier credits are both positive). Ours: separate
  Receivable and Payable columns rather than mixed signs.
- **A-2 Bank Summary.** Columns: `SL | Bank Account No. | BranchName | Opening Amount | Dr. Amount | CR. Amount | Closing
  Balance`; grand total.
- **A-3 Accounts Ledger (no sample).** One account's entries with a running balance: date,
  voucher, particulars, narration, debit, credit, balance, with opening and closing. P14
  already has this.
- **A-4 Credit vouchers (money received).** Columns: `SL | Date | Voucher ID | Particulars | Narration | Ref No. | Entered By | Bank Name &
  A/C No. | Cheque No | Chq. Date | Amount`. Three subtotal levels (probably date / account /
  mode); Total.
- **A-5 Debit vouchers (payments).** Columns: `SL | Date | Voucher ID | Particulars | Narration | Ref No. | Prepared By | Cheque No |
  Chq. Date | Amount`; subtotals; Total.
- **A-6 Journal vouchers.** Columns: `SL | Particulars | Narration | Voucher ID | Ref No. | Date | Prepared By | Cheque No |
  Cheq.Date | Debit | Credit`; Total.
- **A-7 and A-12 Due list.** "As on" date, in two sections, **Receivable** and **Payable**:
  - Inside each: trader category (Customer / Supplier) → trader group → rows
    `SL | Customer Name | Address | Mobile | Due`.
  - Group subtotal, category subtotal, section subtotal; grand total = receivable − payable.
  - A supplier who owes the shop is listed under Receivable, and a customer with an advance
    under Payable.
  - "Without Treatment" most likely excludes cheques not yet cleared (BMS "Cheque
    Treatment"). Build it as a toggle: include / exclude uncleared cheques.
- **A-8 Trial Balance.** Columns: `SL | Particulars | Debit | Credit`, grouped by account group, with a subtotal for
  each group, then totals. Ours must balance, with a drill-down into each ledger (already in
  P13).
- **A-9 and A-22 Income statement.** Columns: `A/C Ledger Name | Amount`. Lines: Sales Accounts; Cost of Goods Sold; Cost
  of Goods Sales Return; **Gross Profit**; then income and expense ledgers; then "Current
  Period: Profit AC". A-22 is all branches together.
- **A-10 Day Book.** Grouped date → voucher type (Purchase, Sales, and vouchers) → mode (Cash,
  Credit). Columns: `InvoiceNO | TraderName | Ref No | Narration | Debit | Credit`. Subtotal per mode and
  per voucher type; grand total.
  - BMS shows purchases as Debit and sales as Credit (seen from the trader's side).
  - Page 2, "Day Book (Summary)": `Particulars | Type | Opening | CR Amount | DR Amount |
    Closing` for each cash ledger ("CASH IN HAND"). Each is broken down by Purchase/Cash,
    Sales/Cash, Purchase/Credit, Sales/Credit, Debit voucher/General Payment, Debit
    voucher/Payment and Credit voucher/Receipt.
  - The sample prints three "CASH IN HAND" blocks with different openings; only the last
    matches the day. Ours: one block per cash or bank account, with opening + in − out =
    closing.
- **A-11 Accounts Layer Wise Summary (no sample).** Most likely account balances rolled up at
  each level of the chart (main group → sub group → ledger). Build it as the trial balance
  with a "level" selector.
- **A-13 Bank Interest Calculator (no sample).** Interest on a bank or loan balance over a
  period. Low priority: build last or skip, and note it.
- **A-14 Sales received (summary).** One row per trader type (Supplier, Credit Customer, Cash). Columns: `Name | Opening
  Due | Sales | Discount | Received | Sales Due | Current Due`; grand total. Current Due =
  Opening + Sales − Discount − Received.
- **A-15 Sales received (per trader).** The same columns, one row per trader, grouped by type; subtotal; grand total. Ours
  hides zero rows by default.
- **A-16 and A-23 Balance sheet.** Two side-by-side columns, `Liabilities | Amount | Assets | Amount`, as a tree
  (group → ledger):
  - **Liabilities:** Capital Accounts; Current Liabilities (Accounts Payable, Sundry
    Creditor); Profit (current period).
  - **Assets:** Current Asset (Cash, Stock, Sundry Debtor); Opening Capital; Profit
    (previous-period loss).

  Ours puts losses on the correct side and must balance. A-23 is all branches together.
- **A-17 Chart of Accounts.** Columns: `Main Group | Sub Group | Sub Group | Accounts Name | Sub Ledger Group1 | Sub Ledger
  Group2`, a tree up to 6 levels. The sample shop's chart makes a good **default expense
  list for a computer shop**:
  - **Indirect Expenses:** Bank Card Charge, Bank Charges, Salary Expenses (one sub-ledger
    per employee), and Shop Expenses (House Rent, Service Charge, BCS Subscription,
    Conveyance Bill, Telephone Bill, Mobile Bill, Wifi Bill, Stationery Cost, Lunch Bill,
    Entertainment Bill, Software Bill, Other Expenses).
  - **Current Asset:** Cash → Cash in Hand; Accounts Receivable → Trade Receivable;
    Inventory → Closing Stock.
  - **Current Liabilities:** Accounts Payable → Trade Payable (also used for an owner loan).
  - **Capital Accounts.**

  Seed these as the defaults in P13/P14 if they aren't already there.
- **A-18 and A-19 Supplier / customer lists.** Grouped by supplier or customer group. Columns: `SL | Code | Name | Address | Mobile | Contact
  Person | Opening Balance | Entered by`. In BMS, Code is empty and "Entered by" is
  "central" or a staff name. These are master lists (also printable from the supplier and
  customer screens).
- **A-20 and A-21 Income / expenses by ledger.** Columns: `SL | A/C Ledger Name | Amount`; total.
- **A-24 Contra vouchers.** Columns: `SL | Particulars | Narration | Voucher ID | Ref No. | Date | Mode | Cheque No | Chq.
  Date | Debit | Credit`; Total. (Contra = cash ↔ bank movement.)

## 9. Transfer Register (9 in menu)

Screen filters: All Date checkbox, Date From, Date To. "BR to BR" = between branches;
"Inhouse" = between locations (stores) inside one branch, which is `stock_locations` in our
schema.

| ID | Report | Sample |
|---|---|---|
| T-1 | Date wise Stock Transfer BR To BR | T180155 |
| T-2 | Product wise Stock Transfer BR To BR | T180206 |
| T-3 | Branch wise Stock Transfer | T180218 |
| T-4 | Date wise Stock Receive From Branch | T180229 (prints "…Receive Brach to Branch"; landscape) |
| T-5 | Product wise Stock Receive From Branch | T180350 (T180335 is T-4 printed again) |
| T-6 | Branch wise Stock Receive | T180402 |
| T-7 | Date wise Stock Transfer Inhouse | T180415 |
| T-8 | Product wise Stock Transfer Inhouse | T180425 |
| T-9 | Store wise Stock Transfer Inhouse | none |

All the transfer samples are empty (one branch, no transfers that day). Columns:

- **T-1 Transfers out by date.** Grouped by destination branch ("BRANCH TO:") → date → transfer. Columns: `Date | Transfer ID |
  Product Description | Store | Qty | Unit Price | Amount | Rec. Date`. Totals per transfer, date,
  branch; grand total. Rec. Date is when the other branch received it.
- **T-2 Transfers out by product.** Grouped by product. Columns: `Invoice No | Branch Name | Qty | Unit Cost | Amount`; subtotal;
  grand total.
- **T-3 Transfers by branch, priced.** Columns: `Invoice No | Product Description | Qty | Unit Price | Discount | Net Unit Price |
  Amount`; subtotal; grand total. The transfer is priced like a sale, for chains whose branches
  bill each other. Ours values transfers at cost; show a transfer price column only if the
  inter-branch price feature exists.
- **T-4 Receipts by date.** Columns: `Date | Receive ID | Transfer ID | Receive From | Product Description | Qty | Tr. Date`;
  grand total.
- **T-5 Receipts by product.** Grouped by product. Columns: `Receive ID | Transfer ID | Branch Name | Qty | Unit Price | Total
  Price`; product total; grand total.
- **T-6 Receipts by branch.** Columns: `Invoice No | Product Description | Qty | Unit Price | Total Price`; grand total.
- **T-7 In-branch transfers by date.** Columns: `Date | Transfer ID | Transfer From | Transfer To | Product Model | Qty | Receipt Date`.
  Totals per transfer and date; Total Qty.
- **T-8 In-branch transfers by product.** Per product (`Model No.: …`). Columns: `Invoice No. | Store From | Store To | Qty`;
  subtotal; grand total.
- **T-9 (no sample).** T-7 grouped by location.
- **Add (BMS lacks it):** "In transit". Transfers sent but not yet received, with days in
  transit, and disputed transfers (P7).

## 10. Open questions (ask at the store; until then, use the default given)

1. **"Date Wise Rebate" (S-19) and "Rebate" in purchase amendment (P-25).**
   - Is it a supplier rebate (money back after purchase) or a customer rebate?
   - Default: supplier rebate, recorded as a credit note against a GRN line that lowers its
     cost, and reported by date.
2. **ST-18 "Stock Sales Order Basis".** What does the Qty column mean? Default: available to
   promise (on hand − reserved).
3. **The rest of the Stock Register list** below #19, and the Challan, RMA Service, RMA Stock
   and Modification registers. Take a photo of each list.
4. **"Item Issue" and "Others In / Out"** in ST-12. What does the shop record there?
   Default: Item Issue = stock taken for internal use or repairs; Others = stock corrections
   that are not counts.
5. **A-11 Accounts Layer Wise Summary and A-13 Bank Interest Calculator:** does anyone use
   them? Default: build A-11, and skip A-13 with a note.
