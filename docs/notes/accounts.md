# The books

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
- **Insisting the books equal the shelves found five holes** (P14). The done-when was
  that the balance sheet's stock figure equals the stock valuation report, and getting
  there turned up five things nothing was posting. A delivery went on the books at its
  INVOICE TOTAL, VAT and advance income tax included, overstating stock by the tax on
  every delivery (they now go to their own accounts, which is also where the VAT return
  gets its input figure). Stock corrections never touched the books at all, so the shelf
  and the ledger drifted apart by every write-off ever made. Transfers never touched
  them either, so goods in a van — nobody's stock by P7's design, but still the shop's
  money — were simply missing; they now sit in a stock-in-transit account while the van
  is on the road. A corrected delivery cost (`amend_grn_cost`, the "receive now, price
  later" flow) left the journal with the old figure AND the cost of sales wrong on any
  of those units that had already sold. And changing a cost revalued stock already on
  the shelf with no entry anywhere. Each is now posted — none by editing the old entry,
  all by posting another one.
- **Bringing stock in at its counted value** (P14). A shop that traded for two years
  before switching the books on has cost changes and corrected invoices in its past that
  no replay can reconstruct: the figures those events used are gone. What IS known is
  what is on the shelves today and what it cost, so `backfill_stock_entries()` brings
  the stock account to that against the owner's capital — what an accountant does when
  opening books mid-life — in one named entry, so it is obvious what it is and what it
  is not.
