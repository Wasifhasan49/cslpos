-- P14c — Sales reps, dealers and delivery points
--
-- WHAT THIS IS FOR
-- A shop that sells over a counter has one kind of customer. A shop that sells THROUGH
-- people — a rep with a territory, dealers who resell, sub-dealers under them — has a
-- different business, and BMS has eleven screens for it. All of this is behind the
-- "Distribution" switch and off by default.
--
-- THE DECISIONS WORTH KNOWING
--
-- 1. A REP IS AN EMPLOYEE WITH A TERRITORY, not a new kind of person. P14b already has
--    employees (with or without a login), so a rep is an employee row flagged as one,
--    with the areas they cover. Inventing a parallel "sales rep" table would mean
--    paying somebody as an employee and targeting them as a rep with no connection
--    between the two.
--
-- 2. EVERY SALE ALREADY HAS A REP. BMS's SR reports silently drop every invoice with no
--    rep against it — about a third of the sample day (docs/BMS_REPORTS.md section 3,
--    item 6). Ours fall back to `sold_by`, which `complete_sale()` always sets, so a
--    counter sale belongs to whoever made it and the totals add up to the day's takings.
--
-- 3. A TARGET IS NOT A FORECAST. It is what somebody was asked to do, so it is stored
--    as given and never recalculated: the achievement report compares it with what
--    actually happened. A run-rate ("you need 18,000 a day for the rest of the month")
--    is worked out on the fly, because it changes every day.
--
-- 4. A SECURITY DEPOSIT IS THE DEALER'S MONEY. The shop is holding it against unpaid
--    bills; it is a liability until it is handed back or used, exactly like a customer
--    advance (P14a). Treating it as income would book profit on money the shop may have
--    to return.

alter table public.shop_features drop constraint shop_features_feature_check;
alter table public.shop_features add constraint shop_features_feature_check
  check (feature in (
    'vat', 'multi_location', 'price_lists', 'credit_sales', 'purchase_orders',
    'transfers', 'accounts', 'sms', 'extra_charges', 'hs_codes',
    'managers_see_dashboard', 'managers_see_accounts', 'managers_see_settings',
    'sales_documents', 'hr', 'hr_extra_fields',
    -- New in P14c.
    'distribution'
  ));

insert into public.permission_keys (key, label, area, has_limit, sort) values
  ('manage_customers', 'Change customer records and limits', 'counter', false, 90)
on conflict (key) do nothing;

insert into public.role_permissions (shop_id, role, perm, allowed)
select s.id, r.role, 'manage_customers', r.role in ('owner', 'manager')
from public.shops s
cross join (values ('owner'), ('manager'), ('cashier')) as r(role)
on conflict (shop_id, role, perm) do nothing;

-- ---------------------------------------------------------------------------
-- Sales reps
-- ---------------------------------------------------------------------------

-- A rep is an employee with a territory. The flag lives on the employee rather than in
-- a table of its own, so the person who is paid and the person who is targeted are the
-- same row.
alter table public.employees
  add column is_rep boolean not null default false,
  -- Of sales, or of profit — a shop that pays on sales rewards discounting, and a shop
  -- that pays on profit has to show the rep the margin. Both exist; the owner chooses.
  add column commission_pct numeric(5,2) not null default 0
    check (commission_pct >= 0 and commission_pct <= 100),
  add column commission_on text not null default 'sales'
    check (commission_on in ('sales', 'profit'));

/** Which areas a rep covers. BMS calls it SR Fixing. */
create table public.rep_areas (
  employee_id uuid not null references public.employees(id) on delete cascade,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  district_id integer references public.districts(id),
  upazila_id  integer references public.upazilas(id),
  primary key (employee_id, district_id, upazila_id)
);

/** What somebody was asked to do in a month. Stored as given, never recalculated. */
create table public.rep_targets (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  for_month   date not null,
  -- By money, by quantity, or inside one category. A shop pushing a brand sets the
  -- third; most set the first.
  target_amount numeric(12,2) not null default 0 check (target_amount >= 0),
  target_qty    integer not null default 0 check (target_qty >= 0),
  category_id   uuid references public.categories(id) on delete set null,
  brand         text,
  note        text,
  set_by      uuid not null references public.staff(id),
  created_at  timestamptz not null default now(),
  unique (employee_id, for_month, category_id, brand)
);
create index rep_targets_month_idx on public.rep_targets(shop_id, for_month);

-- ---------------------------------------------------------------------------
-- Customers: what kind, whose, and where to deliver
-- ---------------------------------------------------------------------------

alter table public.customers
  -- Retail, dealer, retailer (a sub-dealer under a dealer), corporate. The price list
  -- still comes from the group (P10); this is what the shop CALLS them, which is what
  -- the distribution reports group by.
  add column kind text not null default 'retail'
    check (kind in ('retail', 'dealer', 'retailer', 'corporate')),
  -- Which dealer a sub-dealer sits under.
  add column parent_id uuid references public.customers(id) on delete set null,
  -- Whose customer this is. Sales default their rep from here.
  add column rep_id uuid references public.employees(id) on delete set null,
  -- Where they are, for a rep's territory and for the area reports.
  add column home_branch_id uuid references public.branches(id) on delete set null,
  -- BMS's "Trader Flag". The counter respects these.
  add column blocked boolean not null default false,
  add column block_reason text,
  add column cash_only boolean not null default false,
  add column is_vip boolean not null default false;
create index customers_rep_idx on public.customers(rep_id);
create index customers_kind_idx on public.customers(shop_id, kind);

/** A customer can have several places to deliver to. BMS: Delivery Point Fixing. */
create table public.delivery_points (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  name        text not null,
  address     text,
  contact_name text,
  contact_phone text,
  district_id integer references public.districts(id),
  upazila_id  integer references public.upazilas(id),
  is_default  boolean not null default false,
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  unique (customer_id, name)
);
create unique index delivery_points_one_default on public.delivery_points(customer_id)
  where is_default;

-- Now that delivery points exist, an order can name one (the column was waiting in P14a).
alter table public.sales_orders
  add constraint sales_orders_delivery_point_fk
  foreign key (delivery_point_id) references public.delivery_points(id) on delete set null;
alter table public.challans
  add column delivery_point_id uuid references public.delivery_points(id) on delete set null;

/**
 * Money a dealer leaves with the shop against unpaid bills.
 *
 * It is THEIR money: a liability until it is handed back or used to settle something.
 * Recording it as income would book profit on money the shop may have to return.
 */
create table public.customer_deposits (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id) on delete cascade,
  -- Positive: taken. Negative: given back or used against a bill.
  amount      numeric(12,2) not null check (amount <> 0),
  method      text not null default 'cash',
  reference   text,
  note        text,
  shift_id    uuid references public.shifts(id) on delete set null,
  staff_id    uuid not null references public.staff(id),
  created_at  timestamptz not null default now()
);
create index customer_deposits_customer_idx on public.customer_deposits(customer_id);
