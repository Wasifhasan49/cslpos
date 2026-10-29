# Who may do what, and how it is enforced

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
- **Navigation rules are data**, in `src/lib/nav.ts`: one list says who sees which
  section, `canSee()` answers it, and the same function backs both the menu and the
  server guard (`src/lib/guard.ts`) so they cannot disagree. Cashiers get at most 3 phone
  tabs. Owner-only sections can be shared with managers by a settings flag.
