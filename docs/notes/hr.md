# Staff records: employees, attendance and salary (P14b)

BMS has a whole HR module (Department, Profession, Designation, Position, Employee
Information) and shows Attendance / Late / Absent on its dashboard. A shop with four
staff needs none of it, so all of this is behind the `hr` switch, off by default.

## An employee is not a login

A cashier has a `staff` row because they sign in. A delivery boy, a technician and a
cleaner have no login at all and still have to be paid and marked present. So
`employees` is its own table with an **optional** link to a staff row. Making the login
the employee would mean inventing a login for everybody the shop employs — and logins are
what the whole permission system hangs off, so handing one to somebody who will never use
it is how shops end up with shared passwords.

## Checking in is guarded by a branch code, and says so

The prompt offered "the branch's own computers, or a branch PIN". This is a web app:
there is no device registry, and the honest options were the network the request came
from or a code kept at the branch.

An IP check breaks the morning the shop's router is replaced or the internet fails over
to somebody's phone — and when it breaks it locks everybody out of their own attendance,
the one thing they must not be locked out of. So the branch keeps a short code, the
person types it, and the row records which branch accepted it and that the person
recorded it themselves (`source = 'self'`). A manager can also mark somebody present,
and that lands as `source = 'manager'`.

**What this gives the shop is a record made at the branch, on the day.** That is what
attendance is for. It is not, and cannot be, proof of presence: a code everybody knows
proves nothing, and pretending otherwise would be worse than admitting it. The reports
print how each row was recorded, because a person checking themselves in and a manager's
word are not the same kind of evidence.

Clearing a branch's code turns check-ins off there, and a manager marks attendance
instead — the right answer for a branch where nobody has a phone to hand.

## A day nobody recorded is not a day absent

`attendance_day()` reports "not recorded" and the dashboard counts it separately. Only a
row that SAYS absent costs anybody money. A shop that forgot to mark attendance has not
thereby stopped paying anybody, and guessing would put a deduction on a salary that
nobody decided. The not-recorded count is shown in red, because it is the figure to chase
before any of the others mean anything.

## Approving leave writes the attendance

`decide_leave()` fills in those days as `leave`. Otherwise the salary sheet would dock
somebody for days the owner agreed to — the approval has to reach the thing that counts
the days, or it is just a note. Nobody approves their own leave.

## The salary sheet, and why every figure is on the line

Basic plus allowances, less a day's pay for each day marked absent, less any advance
still outstanding. **A day's pay is the month's salary divided by the days in THAT
month**, never a flat 30: February would otherwise pay 30 days for 28, and a day off in
February would cost more than a day off in March.

Each figure is stored on the salary line, not just the net. An employee who sees
"deductions 1,200" and cannot find out why does not trust the slip, and a shop that
cannot explain a deduction has the same argument every month. An advance is never taken
back beyond the salary itself — the rest waits for next month, or the shop has lent
somebody money and then paid them nothing.

Paying posts the salary to the books as a running cost **dated the end of the month it is
for**, not the day it was handed over, which is what a profit figure per month needs. Cash
leaves the drawer with `source_kind = 'salary'`, so P13's cash-movement posting leaves it
alone (the salary entry already recorded the cash side) and the till still counts at
closing time. Building a draft sheet again rebuilds it; a paid sheet is closed.

## Salary is a second permission

`manage_hr` covers the staff list, attendance and leave. `see_salary` covers what anybody
earns, advances and the sheets, and only the owner has it by default — a shop can let a
manager keep attendance without showing them the payroll. Both are refused in the
database, and the pay figures are **absent from the response** rather than zeroed, the
same way cost prices work.
