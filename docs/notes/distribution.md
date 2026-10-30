# Sales reps, dealers and delivery points (P14c)

A shop that sells over a counter has one kind of customer. A shop that sells THROUGH
people — a rep with a territory, dealers who resell, sub-dealers under them — is a
different business, and BMS has eleven screens for it. All of this is behind the
`distribution` switch, off by default.

## A rep is an employee with a territory

P14b already has employees, with or without a login, so a rep is an employee row with
`is_rep` set, their areas in `rep_areas` and a commission rate. A parallel "sales rep"
table would mean paying somebody as an employee and targeting them as a rep with no
connection between the two records of the same person.

A rep covering a whole district with no upazila named is the normal case, so
`upazila_id` is nullable — which is why uniqueness is an index over `coalesce` rather
than a primary key, since a primary key cannot hold a null.

## Every sale counts towards somebody

BMS's rep reports silently drop any invoice with no rep against it: about a third of the
sample day (`docs/BMS_REPORTS.md` section 3, item 6). Here a sale counts towards a rep if
**they made it, or it went to one of their customers** — a rep's dealers ordering is the
whole point of having reps, and somebody else ringing the order up at the counter does
not change whose customer it was. The reports' `rep` column falls back to who made the
sale, so the rep totals add up to the shop's takings.

Matched on ids, never on names. Two people called Rahim would otherwise share a target.

## A target is not a forecast

It is what somebody was asked to do, so it is stored as given and never recalculated;
the achievement figure compares it with what actually happened. The run-rate — "you need
18,000 a day for the rest of the month" — is worked out on the fly, because it is only
true today.

A rep with no staff-records permission sees their own numbers and nobody else's.
Commission only appears for somebody allowed to see pay, and profit only for somebody
allowed to see cost.

## A security deposit is the dealer's money

The shop is holding it against unpaid bills, so it is a liability until it is handed back
or used — exactly like a customer advance (P14a). Booking it as income would show profit
on money the shop may have to return. Cash goes through the open drawer, so the till
still counts at the end of the day, and the shop can never hand back more than it holds:
the rest would be a loan, which is a different thing with a different account.

## The trader flags are enforced at the till

BMS shows them as a note somebody has to notice. Here `blocked` and `cash_only` both make
`complete_sale()` refuse a sale on due, by name and with the reason — because whoever is
at the till was not there when the decision was made. **Blocked is about credit, not
about existing**: a blocked customer can still pay cash. Blocking needs a reason, and the
conversion is logged, because "who made this a dealer, and who allowed them credit?" is
asked months later.

## Moving a customer between branches

Their debts go with them, because a debt belongs to the customer rather than to the
branch that happened to make the sale. The SALES stay where they happened, or last
month's branch figures would change every time somebody moved a customer. What they owed
at the time is written into the log entry.

## One search box

Name, phone, company, address, or the rep's name, with filters for kind and flag — the
same thinking as the sales search in P9: whoever is looking has one thing in their hand
and should not have to know which field it lives in.
