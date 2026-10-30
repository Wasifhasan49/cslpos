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

/**
 * Which areas a rep covers. BMS calls it SR Fixing.
 *
 * A whole district with no upazila named is the normal case — "Shanto has Dhaka" — so
 * upazila_id is nullable, and the uniqueness has to be an index over coalesce rather
 * than a primary key, because a primary key cannot hold a null.
 */
create table public.rep_areas (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  district_id integer references public.districts(id),
  upazila_id  integer references public.upazilas(id)
);
create unique index rep_areas_one_each
  on public.rep_areas(employee_id, coalesce(district_id, 0), coalesce(upazila_id, 0));

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

-- ---------------------------------------------------------------------------
-- Sales reps, their territory and their targets
-- ---------------------------------------------------------------------------

/** Make somebody a rep, set their territory and what they are paid on. */
create or replace function public.save_rep(p_employee_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_emp public.employees; v_area jsonb; v_n integer := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('distribution') then raise exception 'FEATURE_OFF:distribution'; end if;
  if not public.has_permission('manage_hr') then raise exception 'NOT_ALLOWED:manage_hr'; end if;
  select * into v_emp from public.employees
    where id = p_employee_id and shop_id = v_me.shop_id;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND'; end if;

  update public.employees set
    is_rep = coalesce((p_values->>'is_rep')::boolean, true),
    commission_pct = coalesce((p_values->>'commission_pct')::numeric, commission_pct),
    commission_on = coalesce(nullif(p_values->>'commission_on', ''), commission_on)
  where id = p_employee_id;

  -- The territory is replaced wholesale: "these are the areas" is easier to get right
  -- than adding and removing one at a time, and a rep with no areas covers none.
  if p_values ? 'areas' then
    delete from public.rep_areas where employee_id = p_employee_id;
    for v_area in select e from jsonb_array_elements(coalesce(p_values->'areas', '[]'::jsonb)) e loop
      insert into public.rep_areas (employee_id, shop_id, district_id, upazila_id)
      values (p_employee_id, v_me.shop_id,
              (v_area->>'district_id')::integer, (v_area->>'upazila_id')::integer)
      on conflict do nothing;
      v_n := v_n + 1;
    end loop;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'rep_saved', 'employee', p_employee_id,
          jsonb_build_object('name', v_emp.name, 'areas', v_n,
                             'commission_pct', p_values->>'commission_pct'));

  return jsonb_build_object('employee_id', p_employee_id, 'name', v_emp.name, 'areas', v_n);
end; $$;

/** What a rep was asked to do in a month. Stored as given; never recalculated. */
create or replace function public.save_rep_target(
  p_employee_id uuid, p_month date, p_values jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_month date := date_trunc('month', p_month)::date; v_id uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('distribution') then raise exception 'FEATURE_OFF:distribution'; end if;
  -- Setting somebody's target is a management decision, not a counter one.
  if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
  if not exists (select 1 from public.employees
                 where id = p_employee_id and shop_id = v_me.shop_id) then
    raise exception 'EMPLOYEE_NOT_FOUND';
  end if;
  if coalesce((p_values->>'target_amount')::numeric, 0) <= 0
     and coalesce((p_values->>'target_qty')::integer, 0) <= 0 then
    raise exception 'TARGET_NEEDS_A_FIGURE';
  end if;

  insert into public.rep_targets (shop_id, employee_id, for_month, target_amount,
                                  target_qty, category_id, brand, note, set_by)
  values (v_me.shop_id, p_employee_id, v_month,
          coalesce((p_values->>'target_amount')::numeric, 0),
          coalesce((p_values->>'target_qty')::integer, 0),
          (p_values->>'category_id')::uuid, nullif(p_values->>'brand', ''),
          p_values->>'note', v_me.id)
  on conflict (employee_id, for_month, category_id, brand) do update set
    target_amount = excluded.target_amount, target_qty = excluded.target_qty,
    note = excluded.note, set_by = excluded.set_by
  returning id into v_id;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'rep_target_set', 'employee', p_employee_id,
          jsonb_build_object('month', v_month, 'amount', p_values->>'target_amount'));

  return jsonb_build_object('id', v_id, 'month', v_month);
end; $$;

/**
 * Target against what actually happened.
 *
 * A rep's own numbers, on their phone, with nobody else's: `p_employee_id` null means
 * "me", and seeing anybody else's needs the staff-records permission. The run-rate is
 * worked out here rather than stored, because it changes every day — "you need 18,000 a
 * day for the rest of the month" is only true today.
 *
 * EVERY SALE COUNTS TOWARDS SOMEBODY. BMS's rep reports drop any invoice with no rep
 * against it, which was about a third of the sample day; ours fall back to who made the
 * sale, so the rep totals add up to the shop's takings.
 */
create or replace function public.rep_achievement(
  p_month date default null, p_employee_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_month date := date_trunc('month', coalesce(p_month, public.dhaka_today()))::date;
  v_last  date;
  v_mine  uuid;
  v_days  integer;
  v_left  integer;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('distribution') then raise exception 'FEATURE_OFF:distribution'; end if;

  select id into v_mine from public.employees
    where staff_id = v_me.id and shop_id = v_me.shop_id and active;
  if p_employee_id is not null and p_employee_id is distinct from v_mine
     and not public.has_permission('manage_hr') then
    raise exception 'NOT_ALLOWED:manage_hr';
  end if;
  -- A rep with no staff-records permission sees themselves and nobody else.
  if p_employee_id is null and not public.has_permission('manage_hr') then
    if v_mine is null then raise exception 'NOT_AN_EMPLOYEE'; end if;
  end if;

  v_last := (v_month + interval '1 month - 1 day')::date;
  v_days := extract(day from v_last)::integer;
  v_left := greatest(v_days - case when public.dhaka_today() between v_month and v_last
                                   then extract(day from public.dhaka_today())::integer
                                   else v_days end, 0);

  return jsonb_build_object(
    'month', v_month, 'days_in_month', v_days, 'days_left', v_left,
    'reps', (
      select coalesce(jsonb_agg(r order by r->>'name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'employee_id', e.id, 'name', e.name,
          'commission_pct', e.commission_pct, 'commission_on', e.commission_on,
          'target', coalesce(t.target_amount, 0),
          'target_qty', coalesce(t.target_qty, 0),
          'sold', coalesce(s.sold, 0), 'qty', coalesce(s.qty, 0),
          'profit', case when public.has_permission('see_cost') then coalesce(s.profit, 0) end,
          'done_pct', case when coalesce(t.target_amount, 0) > 0
                           then round(coalesce(s.sold, 0) / t.target_amount * 100, 1) end,
          'short_by', case when coalesce(t.target_amount, 0) > 0
                           then greatest(t.target_amount - coalesce(s.sold, 0), 0) end,
          -- What they have to average for the rest of the month to get there.
          'a_day_needed', case when coalesce(t.target_amount, 0) > 0 and v_left > 0
                               then round(greatest(t.target_amount - coalesce(s.sold, 0), 0)
                                          / v_left, 0) end,
          'commission', case when e.commission_pct > 0 and public.has_permission('see_salary')
                             then round(case when e.commission_on = 'profit'
                                             then coalesce(s.profit, 0)
                                             else coalesce(s.sold, 0) end
                                        * e.commission_pct / 100, 2) end,
          'customers', (select count(*) from public.customers c where c.rep_id = e.id)
        ) as r
        from public.employees e
        left join public.rep_targets t
          on t.employee_id = e.id and t.for_month = v_month
         and t.category_id is null and t.brand is null
        left join lateral (
          -- A sale counts towards a rep if they MADE it, or if it went to one of their
          -- customers — a rep's dealers ordering is the whole point of having reps, and
          -- somebody else ringing the order up at the counter does not change whose
          -- customer it was. Matched on ids, never on names: two people called Rahim
          -- would otherwise share a target.
          select sum(l.amount) as sold, sum(l.qty)::integer as qty, sum(l.profit) as profit
          from public.v_rep_sale_lines l
          join public.sales sa on sa.id = l.sale_id
          where l.d between v_month and v_last
            and (coalesce(sa.sold_by, sa.staff_id) = e.staff_id
                 or exists (select 1 from public.customers c
                            where c.id = sa.customer_id and c.rep_id = e.id))
        ) s on true
        where e.shop_id = v_me.shop_id and e.active and e.is_rep
          and (p_employee_id is null or e.id = p_employee_id)
          and (public.has_permission('manage_hr') or e.id = v_mine)
      ) q));
end; $$;

-- ---------------------------------------------------------------------------
-- Delivery points
-- ---------------------------------------------------------------------------

/** Where a customer wants things delivered. A dealer may have several. */
create or replace function public.save_delivery_point(
  p_id uuid, p_customer_id uuid, p_values jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_id uuid := p_id; v_row jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('distribution') then raise exception 'FEATURE_OFF:distribution'; end if;
  if not public.has_permission('manage_customers') then
    raise exception 'NOT_ALLOWED:manage_customers';
  end if;
  if coalesce(trim(p_values->>'name'), '') = '' then raise exception 'NAME_REQUIRED'; end if;
  if not exists (select 1 from public.customers
                 where id = p_customer_id and shop_id = v_me.shop_id) then
    raise exception 'CUSTOMER_NOT_FOUND';
  end if;

  -- One default per customer, so "where does this go?" always has an answer without
  -- anybody choosing — the same rule as a branch's default stock location.
  if coalesce((p_values->>'is_default')::boolean, false) then
    update public.delivery_points set is_default = false
      where customer_id = p_customer_id and id is distinct from v_id;
  end if;

  if v_id is null then
    insert into public.delivery_points (shop_id, customer_id, name, address, contact_name,
                                        contact_phone, district_id, upazila_id,
                                        is_default, note)
    values (v_me.shop_id, p_customer_id, trim(p_values->>'name'), p_values->>'address',
            p_values->>'contact_name', p_values->>'contact_phone',
            (p_values->>'district_id')::integer, (p_values->>'upazila_id')::integer,
            coalesce((p_values->>'is_default')::boolean,
                     not exists (select 1 from public.delivery_points
                                 where customer_id = p_customer_id)),
            p_values->>'note')
    returning id, to_jsonb(delivery_points.*) into v_id, v_row;
  else
    update public.delivery_points set
      name = coalesce(nullif(trim(p_values->>'name'), ''), name),
      address = coalesce(p_values->>'address', address),
      contact_name = coalesce(p_values->>'contact_name', contact_name),
      contact_phone = coalesce(p_values->>'contact_phone', contact_phone),
      district_id = coalesce((p_values->>'district_id')::integer, district_id),
      upazila_id = coalesce((p_values->>'upazila_id')::integer, upazila_id),
      is_default = coalesce((p_values->>'is_default')::boolean, is_default),
      active = coalesce((p_values->>'active')::boolean, active),
      note = coalesce(p_values->>'note', note)
    where id = v_id and shop_id = v_me.shop_id
    returning to_jsonb(delivery_points.*) into v_row;
    if v_row is null then raise exception 'DELIVERY_POINT_NOT_FOUND'; end if;
  end if;

  return v_row;
end; $$;

/** A customer's places, for the order and challan pickers. */
create or replace function public.delivery_point_list(p_customer_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'address', d.address,
      'contact_name', d.contact_name, 'contact_phone', d.contact_phone,
      'is_default', d.is_default, 'active', d.active, 'note', d.note)
      order by d.is_default desc, d.name), '[]'::jsonb)
    from public.delivery_points d
    where d.customer_id = p_customer_id and d.shop_id = v_me.shop_id and d.active);
end; $$;

-- ---------------------------------------------------------------------------
-- Security deposits
-- ---------------------------------------------------------------------------

create or replace function public.seed_deposit_account(p_shop_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (shop_id, group_id, code, name, role)
  select p_shop_id, ag.id, '2160', 'Dealer security deposits', 'customer_deposit'
  from public.account_groups ag
  where ag.shop_id = p_shop_id and ag.name = 'Current liabilities'
  on conflict (shop_id, code) do nothing;
end; $$;

alter table public.accounts drop constraint accounts_role_check;
alter table public.accounts add constraint accounts_role_check
  check (role is null or role in (
    'cash_in_hand', 'bank', 'wallet', 'receivable', 'payable', 'inventory',
    'vat_payable', 'sales', 'sales_return', 'cogs', 'discount_given',
    'purchase_return', 'stock_loss', 'stock_gain', 'inter_branch',
    'card_charge', 'opening_equity', 'rounding',
    'vat_input', 'ait_advance', 'stock_in_transit',
    'customer_advance', 'goods_delivered',
    -- New in P14c: money a dealer has left with the shop.
    'customer_deposit'));

select public.seed_deposit_account(id) from public.shops
where exists (select 1 from public.accounts a where a.shop_id = shops.id);

create or replace function public.add_shop_accounts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_accounts(new.id);
  perform public.seed_report_accounts(new.id);
  perform public.seed_sales_doc_accounts(new.id);
  perform public.seed_deposit_account(new.id);
  return new;
end; $$;

/**
 * Money a dealer leaves with the shop, or gets back.
 *
 * Positive takes it, negative returns it. It is a liability for as long as the shop is
 * holding it: this is the dealer's money, left against unpaid bills, and booking it as
 * income would show profit on money the shop may have to hand back. Cash goes through
 * the open drawer (P8), so the till still counts at the end of the day.
 */
create or replace function public.record_deposit(
  p_customer_id uuid, p_amount numeric, p_method text default 'cash',
  p_reference text default null, p_note text default null, p_branch_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me   public.staff;
  v_cust public.customers;
  v_branch uuid;
  v_held numeric(12,2);
  v_shift uuid;
  v_id   uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('distribution') then raise exception 'FEATURE_OFF:distribution'; end if;
  if not public.has_permission('manage_customers') then
    raise exception 'NOT_ALLOWED:manage_customers';
  end if;
  select * into v_cust from public.customers
    where id = p_customer_id and shop_id = v_me.shop_id;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if coalesce(p_amount, 0) = 0 then raise exception 'BAD_PAYMENT_AMOUNT'; end if;

  v_branch := coalesce(p_branch_id, v_cust.home_branch_id,
                       (select id from public.branches where shop_id = v_me.shop_id
                        order by created_at limit 1));

  -- Never hand back more than is being held: the rest would be a loan, which is a
  -- different thing with a different account.
  select coalesce(sum(amount), 0) into v_held from public.customer_deposits
    where customer_id = p_customer_id;
  if p_amount < 0 and v_held + p_amount < 0 then
    raise exception 'MORE_THAN_HELD:%', v_held::text;
  end if;

  if p_method = 'cash' then
    select id into v_shift from public.shifts
      where branch_id = v_branch and closed_at is null order by opened_at desc limit 1;
  end if;

  insert into public.customer_deposits (shop_id, branch_id, customer_id, amount, method,
                                        reference, note, shift_id, staff_id)
  values (v_me.shop_id, v_branch, p_customer_id, p_amount, p_method, p_reference,
          p_note, v_shift, v_me.id)
  returning id into v_id;

  if public.feature_on('accounts') then
    perform public.post_entry(v_me.shop_id, v_branch, public.dhaka_today(),
      case when p_amount > 0 then 'Security deposit from ' else 'Security deposit returned to ' end
        || coalesce(v_cust.name_text, v_cust.company, v_cust.phone),
      jsonb_build_array(
        jsonb_build_object('account_id',
          public.account_for_method(v_me.shop_id, p_method, v_branch),
          case when p_amount > 0 then 'debit' else 'credit' end, abs(p_amount)),
        jsonb_build_object('role', 'customer_deposit',
          case when p_amount > 0 then 'credit' else 'debit' end, abs(p_amount),
          'customer_id', p_customer_id)),
      'customer_payment', v_id, v_me.id);
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_branch, v_me.id,
          case when p_amount > 0 then 'deposit_taken' else 'deposit_returned' end,
          'customer', p_customer_id,
          jsonb_build_object('amount', p_amount, 'method', p_method,
                             'held_now', v_held + p_amount));

  return jsonb_build_object('id', v_id, 'amount', p_amount, 'held', v_held + p_amount);
end; $$;

/** What the shop is holding for one customer. */
create or replace function public.deposit_held(p_customer_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from public.customer_deposits
  where customer_id = p_customer_id;
$$;

-- complete_sale() again, with the trader flags. A blocked customer cannot buy on due and
-- a cash-only one cannot either — checked at the till, where it matters, rather than
-- printed in a report somebody reads afterwards. Everything else is unchanged.

create or replace function public.complete_sale(
  p_branch_id        uuid,
  -- [{ product_id, qty, serial_ids[], unit_price? }] — unit_price is what the seller
  -- wants to charge. Left out means "the price the owner set".
  p_items            jsonb,
  p_payment_method   text,
  p_discount_pct     numeric default 0,
  p_approval_id      uuid default null,
  p_customer_phone   text default null,
  p_cash_received    numeric default null,
  p_payment_ref      text default null,
  p_charges          jsonb default null,
  p_discount_type_id uuid default null,
  p_category_id      uuid default null,
  p_price_list_id    uuid default null,
  -- How much of the total the customer is NOT paying now. 0 is the normal sale.
  -- A payment method of 'due' means the whole lot, so this can be left out.
  p_due_amount       numeric default 0,
  -- Everything the advanced counter adds (P10a), as one object rather than twelve more
  -- arguments: { attention, customer_address, customer_bin, customer_nid, narration,
  -- sold_by, extra_fields, card: {type_id, bank, pos_account_id, last4},
  -- emi: {months, bank}, exchange: {description, serial, value, product_id,
  -- add_to_stock}, payments: [{method, amount, reference, account_id}] }
  p_extras           jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_staff     public.staff;
  v_shop      public.shops;
  v_branch    public.branches;
  v_location  uuid;
  v_sale_id   uuid := gen_random_uuid();
  v_invoice   text;
  v_item      jsonb;
  v_product   public.products;
  v_qty       integer;
  v_stock     integer;
  v_serials   uuid[];
  v_found     integer;
  v_item_id   uuid;
  v_subtotal  numeric(12,2) := 0;
  v_manual    numeric(5,2) := coalesce(p_discount_pct, 0);
  v_cust_pct  numeric(5,2) := 0;
  v_pct       numeric(5,2);
  v_discount  numeric(12,2);
  v_total     numeric(12,2);
  v_approver  uuid;
  v_need_ok   boolean := false;
  v_customer  uuid;
  v_cust      jsonb;
  v_list      uuid;
  v_shift     uuid;
  v_change    numeric(12,2);
  v_lines     jsonb := '[]'::jsonb;
  v_today     date := public.dhaka_today();
  v_until     date;
  v_vat_on    boolean := public.feature_on('vat');
  v_rate      public.vat_rates;
  v_line      numeric(12,2);
  v_line_vat  numeric(12,2);
  v_vat_total numeric(12,2) := 0;
  v_charge    jsonb;
  v_chg       public.extra_charges;
  v_chg_amt   numeric(12,2);
  v_charges   numeric(12,2) := 0;
  v_chg_list  jsonb := '[]'::jsonb;
  v_pay       public.payment_methods;
  v_item_ids  uuid[] := '{}';
  v_vat_pcts  numeric[] := '{}';
  v_vat_incl  boolean[] := '{}';
  v_i         integer;
  v_resolved  jsonb := '[]'::jsonb;
  v_pr        jsonb;
  v_want      numeric(12,2);
  v_listed    numeric(12,2);
  v_min       numeric(12,2);
  v_max       numeric(12,2);
  v_over      boolean;
  v_unit      numeric(12,2);
  v_gift      record;
  v_gift_qty  integer;
  v_due       numeric(12,2) := greatest(coalesce(p_due_amount, 0), 0);
  v_paid      numeric(12,2);
  v_cust_row  public.customers;
  v_owed      numeric(12,2);
  v_x         jsonb := coalesce(p_extras, '{}'::jsonb);
  v_sold_by   uuid;
  v_card      public.card_types;
  v_card_chg  numeric(12,2) := 0;
  v_emi       public.emi_plans;
  v_emi_chg   numeric(12,2) := 0;
  v_exchange  numeric(12,2) := 0;
  v_pay_sum   numeric(12,2) := 0;
  v_split     jsonb;
  v_field     text;
  v_ex        jsonb;
  v_ex_prod   public.products;
  v_ex_loc    uuid;
  v_ex_serial uuid;
  -- P14a: this bill is for goods that already went out on a delivery note. The ONE
  -- thing that changes is that the stock does not move again — everything else about a
  -- sale (prices, VAT, discount band, approval, invoice number, receipt) is identical,
  -- which is why this is a flag rather than a second copy of this function.
  v_challan   uuid := (v_x->>'challan_id')::uuid;
  v_order_id  uuid := (v_x->>'order_id')::uuid;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;

  if p_branch_id is null then raise exception 'BRANCH_REQUIRED'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  select * into v_branch from public.branches where id = p_branch_id for update;
  v_location := public.default_location(p_branch_id);
  if v_location is null then raise exception 'NO_STOCK_LOCATION:%', v_branch.name; end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_SALE';
  end if;

  select * into v_pay from public.payment_methods
    where shop_id = v_staff.shop_id and key = p_payment_method and enabled;
  if not found then raise exception 'BAD_PAYMENT_METHOD'; end if;
  if v_manual < 0 or v_manual > 100 then raise exception 'BAD_DISCOUNT'; end if;

  select * into v_shop from public.shops where id = v_staff.shop_id;

  -- The customer decides which price list applies. A walk-in gets the default.
  if p_customer_phone is not null and p_customer_phone <> '' then
    if p_customer_phone !~ '^01[0-9]{9}$' then raise exception 'BAD_PHONE'; end if;
    v_cust := public.customer_by_phone(p_customer_phone);
    if v_cust is not null then
      v_cust_pct := coalesce((v_cust->>'discount_pct')::numeric, 0);
    end if;
  end if;

  v_list := coalesce(
    p_price_list_id,
    (v_cust->>'price_list_id')::uuid,
    (select id from public.price_lists where shop_id = v_shop.id and is_default));

  -- ---- First pass: what may each line be charged at? -----------------------
  for v_item in select e from jsonb_array_elements(p_items) e order by (e->>'product_id') loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = v_shop.id and active;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

    v_pr := public.resolve_price(v_product.id, p_branch_id, v_list);
    v_listed := (v_pr->>'price')::numeric;
    v_min := (v_pr->>'min_price')::numeric;
    v_max := (v_pr->>'max_price')::numeric;

    if v_item ? 'unit_price' and (v_item->>'unit_price') is not null then
      v_want := (v_item->>'unit_price')::numeric;
      if v_want < 0 then raise exception 'BAD_PRICE'; end if;
    else
      v_want := v_listed;
    end if;

    v_over := v_want <> v_listed;
    if v_over then
      if not public.has_permission('change_price') then
        raise exception 'NOT_ALLOWED:change_price';
      end if;
      -- Inside the band is allowed outright. Outside it needs a manager.
      if (v_min is not null and v_want < v_min) or (v_max is not null and v_want > v_max) then
        v_need_ok := true;
      end if;
    end if;

    v_resolved := v_resolved || jsonb_build_object(
      'product_id', v_product.id, 'unit_price', v_want, 'list_price', v_listed,
      'overridden', v_over, 'min_price', v_min, 'max_price', v_max);
  end loop;

  -- A manual discount over this seller's limit also needs a manager. The customer's
  -- own standing discount does not: the owner set it.
  if v_manual > public.permission_limit('give_discount') then v_need_ok := true; end if;

  if v_need_ok then
    if p_approval_id is null then raise exception 'MANAGER_PIN_REQUIRED'; end if;
    update public.pin_attempts set used_at = now()
      where id = p_approval_id and shop_id = v_staff.shop_id and ok
        and used_at is null and created_at > now() - interval '10 minutes'
      returning approver_id into v_approver;
    if v_approver is null then raise exception 'APPROVAL_NOT_VALID'; end if;
  end if;

  -- The bigger of the two discounts applies; they do not stack, or a dealer on 10%
  -- asking for 5% more would quietly get 15%.
  v_pct := greatest(v_manual, v_cust_pct);

  if p_discount_type_id is not null
     and not exists (select 1 from public.discount_types
                     where id = p_discount_type_id and shop_id = v_shop.id and active) then
    raise exception 'BAD_DISCOUNT_TYPE';
  end if;
  if p_category_id is not null
     and not exists (select 1 from public.transaction_categories
                     where id = p_category_id and shop_id = v_shop.id and active) then
    raise exception 'BAD_CATEGORY';
  end if;

  v_invoice := v_shop.invoice_prefix || '-' || v_branch.code || '-'
               || to_char(v_today, 'YYYY') || lpad(v_branch.next_invoice::text, 6, '0');
  update public.branches set next_invoice = next_invoice + 1 where id = p_branch_id;

  insert into public.sales (id, shop_id, branch_id, invoice_no, staff_id, subtotal, total,
                            payment_method, discount_type_id, transaction_category_id,
                            challan_id, order_id)
  values (v_sale_id, v_shop.id, p_branch_id, v_invoice, v_staff.id, 0, 0,
          p_payment_method, p_discount_type_id, p_category_id, v_challan, v_order_id);

  -- ---- Second pass: move the stock and write the lines ---------------------
  for v_item in select e from jsonb_array_elements(p_items) e order by (e->>'product_id') loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = v_shop.id and active;

    select (r->>'unit_price')::numeric, (r->>'list_price')::numeric, (r->>'overridden')::boolean
      into v_unit, v_listed, v_over
    from jsonb_array_elements(v_resolved) r
    where (r->>'product_id')::uuid = v_product.id;

    v_qty := coalesce((v_item->>'qty')::integer, 0);
    v_serials := coalesce(array(select jsonb_array_elements_text(coalesce(v_item->'serial_ids', '[]'::jsonb))::uuid), '{}');

    if v_product.is_serial then
      v_qty := coalesce(array_length(v_serials, 1), 0);
      if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
      update public.serials set status = 'sold', sale_id = v_sale_id
        where id = any(v_serials) and product_id = v_product.id and shop_id = v_shop.id
          and status = case when v_challan is null then 'in_stock' else 'delivered' end
          and location_id in (select id from public.stock_locations where branch_id = p_branch_id);
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    elsif v_qty <= 0 then
      raise exception 'BAD_QTY:%', v_product.name;
    end if;

    -- A service has no stock to take. It still goes on the bill. Nor does a bill for
    -- goods already delivered: the challan took them off the shelf when the van left.
    if v_product.is_inventory and v_challan is null then
      select qty into v_stock from public.branch_stock
        where product_id = v_product.id and location_id = v_location for update;
      if v_stock is null then
        insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
        values (v_product.id, v_location, v_shop.id, p_branch_id, 0)
        on conflict (product_id, location_id) do nothing;
        v_stock := 0;
      end if;
      -- Out of stock is the plainer answer, so it comes first: a shelf with nothing on
      -- it is not "reserved". Then — stock promised to an order is not available to a
      -- walk-in. Billing the order itself passes its own id, because a line cannot be
      -- blocked by its own reservation.
      if v_stock < v_qty then raise exception 'OUT_OF_STOCK:%', v_product.name; end if;
      if public.available_qty(v_product.id, p_branch_id, v_order_id) < v_qty then
        raise exception 'RESERVED_FOR_AN_ORDER:%', v_product.name;
      end if;
      update public.branch_stock set qty = qty - v_qty, updated_at = now()
        where product_id = v_product.id and location_id = v_location;
      insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change, reason, ref_id, staff_id)
      values (v_shop.id, p_branch_id, v_location, v_product.id, -v_qty, 'sale', v_sale_id, v_staff.id);
    end if;

    -- The product's own automatic discount, if the owner set one.
    v_line := v_unit * v_qty;
    if v_product.discount_kind = 'percent' and coalesce(v_product.discount_value, 0) > 0 then
      v_line := round(v_line * (100 - least(v_product.discount_value, 100)) / 100, 2);
    elsif v_product.discount_kind = 'fixed' and coalesce(v_product.discount_value, 0) > 0 then
      v_line := greatest(v_line - v_product.discount_value * v_qty, 0);
    end if;

    v_rate := null;
    if v_vat_on and v_product.vat_rate_id is not null then
      select * into v_rate from public.vat_rates
        where id = v_product.vat_rate_id and shop_id = v_shop.id and active;
    end if;
    v_line_vat := case when v_rate.id is null then 0
                       else public.vat_on(v_line, v_rate.pct, v_rate.inclusive) end;

    v_until := case
      when v_product.warranty_term_id is not null then
        (select case when wt.months > 0 then (v_today + make_interval(months => wt.months))::date end
         from public.warranty_terms wt where wt.id = v_product.warranty_term_id)
      when v_product.warranty_months > 0 then (v_today + make_interval(months => v_product.warranty_months))::date
    end;

    v_item_id := gen_random_uuid();
    insert into public.sale_items (id, sale_id, shop_id, product_id, name, qty, unit_price,
                                   line_total, warranty_months, warranty_until,
                                   vat_pct, vat_amount, vat_inclusive,
                                   list_price, price_overridden)
    values (v_item_id, v_sale_id, v_shop.id, v_product.id, v_product.name, v_qty, v_unit,
            v_line, v_product.warranty_months, v_until,
            coalesce(v_rate.pct, 0), v_line_vat, coalesce(v_rate.inclusive, true),
            v_listed, v_over);

    insert into public.sale_item_serials (sale_item_id, serial_id) select v_item_id, unnest(v_serials);

    -- An override is logged with BOTH prices, so the owner can see what it cost them.
    if v_over then
      insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
      values (v_shop.id, p_branch_id, v_staff.id, 'price_overridden', 'sale', v_sale_id,
              jsonb_build_object('product', v_product.name, 'qty', v_qty,
                                 'list_price', v_listed, 'charged', v_unit,
                                 'difference', round((v_listed - v_unit) * v_qty, 2),
                                 'approved_by', v_approver, 'invoice', v_invoice));
    end if;

    v_subtotal := v_subtotal + v_line;
    if v_rate.id is not null and not v_rate.inclusive then
      v_vat_total := v_vat_total + v_line_vat;
    end if;
    v_item_ids := v_item_ids || v_item_id;
    v_vat_pcts := v_vat_pcts || coalesce(v_rate.pct, 0);
    v_vat_incl := v_vat_incl || coalesce(v_rate.inclusive, true);

    v_lines := v_lines || jsonb_build_object(
      'name', v_product.name, 'qty', v_qty, 'unit_price', v_unit,
      'list_price', v_listed, 'price_overridden', v_over,
      'line_total', v_line, 'warranty_until', v_until, 'is_gift', false,
      'vat_pct', coalesce(v_rate.pct, 0), 'vat_amount', v_line_vat,
      'vat_inclusive', coalesce(v_rate.inclusive, true),
      'serials', (select coalesce(jsonb_agg(serial), '[]'::jsonb) from public.serials where id = any(v_serials)));

    -- ---- Gifts: buy X get Y free -----------------------------------------
    for v_gift in
      select g.*, fp.name as free_name, fp.is_inventory as free_is_inventory,
             fp.is_serial as free_is_serial
      from public.gift_offers g
      join public.products fp on fp.id = g.free_product_id
      where g.shop_id = v_shop.id and g.active and g.buy_product_id = v_product.id
        and (g.starts_on is null or g.starts_on <= v_today)
        and (g.ends_on is null or g.ends_on >= v_today)
    loop
      v_gift_qty := (v_qty / v_gift.buy_qty) * v_gift.free_qty;
      if v_gift_qty <= 0 then continue; end if;
      -- A serial-tracked gift would need its serial picked, which the counter cannot do
      -- for a line it did not add. Skip rather than guess which unit left the shelf.
      if v_gift.free_is_serial then continue; end if;

      if v_gift.free_is_inventory then
        select qty into v_stock from public.branch_stock
          where product_id = v_gift.free_product_id and location_id = v_location for update;
        -- No free stock means no gift, not a failed sale.
        if coalesce(v_stock, 0) < v_gift_qty then continue; end if;
        update public.branch_stock set qty = qty - v_gift_qty, updated_at = now()
          where product_id = v_gift.free_product_id and location_id = v_location;
        insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change, reason, ref_id, staff_id, note)
        values (v_shop.id, p_branch_id, v_location, v_gift.free_product_id, -v_gift_qty, 'sale', v_sale_id, v_staff.id, 'Gift');
      end if;

      v_item_id := gen_random_uuid();
      insert into public.sale_items (id, sale_id, shop_id, product_id, name, qty, unit_price,
                                     line_total, warranty_months, warranty_until, list_price, is_gift)
      values (v_item_id, v_sale_id, v_shop.id, v_gift.free_product_id, v_gift.free_name,
              v_gift_qty, 0, 0, 0, null, 0, true);

      v_item_ids := v_item_ids || v_item_id;
      v_vat_pcts := v_vat_pcts || 0::numeric;
      v_vat_incl := v_vat_incl || true;

      v_lines := v_lines || jsonb_build_object(
        'name', v_gift.free_name, 'qty', v_gift_qty, 'unit_price', 0, 'list_price', 0,
        'price_overridden', false, 'line_total', 0, 'warranty_until', null, 'is_gift', true,
        'vat_pct', 0, 'vat_amount', 0, 'vat_inclusive', true, 'serials', '[]'::jsonb);
    end loop;
  end loop;

  v_discount := round(v_subtotal * v_pct / 100);

  if v_vat_on and v_pct > 0 then
    v_vat_total := 0;
    for v_i in 1 .. coalesce(array_length(v_item_ids, 1), 0) loop
      select line_total into v_line from public.sale_items where id = v_item_ids[v_i];
      v_line_vat := public.vat_on(round(v_line * (100 - v_pct) / 100, 2), v_vat_pcts[v_i], v_vat_incl[v_i]);
      update public.sale_items set vat_amount = v_line_vat where id = v_item_ids[v_i];
      if not v_vat_incl[v_i] then v_vat_total := v_vat_total + v_line_vat; end if;
      v_lines := jsonb_set(v_lines, array[(v_i - 1)::text, 'vat_amount'], to_jsonb(v_line_vat));
    end loop;
  end if;

  v_total := v_subtotal - v_discount + v_vat_total;

  if p_charges is not null and jsonb_typeof(p_charges) = 'array' then
    for v_charge in select e from jsonb_array_elements(p_charges) e loop
      select * into v_chg from public.extra_charges
        where id = (v_charge->>'charge_id')::uuid and shop_id = v_shop.id and active;
      if not found then raise exception 'BAD_CHARGE'; end if;
      v_chg_amt := case when v_chg.kind = 'percent'
                        then round((v_subtotal - v_discount) * v_chg.value / 100, 2)
                        else v_chg.value end;
      v_charges := v_charges + v_chg_amt;
      v_chg_list := v_chg_list || jsonb_build_object('name', v_chg.name, 'amount', v_chg_amt);
    end loop;
    v_total := v_total + v_charges;
  end if;

  if v_approver is not null and v_manual > public.permission_limit('give_discount') then
    insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
    values (v_shop.id, p_branch_id, v_staff.id, 'discount_approved', 'sale', v_sale_id,
            jsonb_build_object('pct', v_manual, 'amount', v_discount, 'approved_by', v_approver,
                               'approved_by_name', (select name from public.staff where id = v_approver),
                               'reason', (select name from public.discount_types where id = p_discount_type_id),
                               'invoice', v_invoice));
  end if;

  -- ---- Everything the advanced counter adds (P10a) -------------------------
  -- Who actually sold it. Defaults to whoever is logged in; a shop with floor staff and
  -- one till needs to credit the person who made the sale.
  v_sold_by := coalesce((v_x->>'sold_by')::uuid, v_staff.id);
  if not exists (select 1 from public.staff where id = v_sold_by and shop_id = v_shop.id and active) then
    raise exception 'STAFF_NOT_FOUND';
  end if;

  -- The shop's own extra fields: only ones it has actually defined, so a typo in the
  -- browser cannot invent a field nobody will ever look at again.
  if v_x ? 'extra_fields' then
    for v_field in select jsonb_object_keys(v_x->'extra_fields') loop
      if not exists (select 1 from public.sale_fields
                     where shop_id = v_shop.id and name = v_field and active) then
        raise exception 'UNKNOWN_SALE_FIELD:%', v_field;
      end if;
    end loop;
  end if;

  -- Card details, and the shop's decision about who pays the card company's cut.
  if v_x ? 'card' and (v_x->'card'->>'type_id') is not null then
    select * into v_card from public.card_types
      where id = (v_x->'card'->>'type_id')::uuid and shop_id = v_shop.id and active;
    if not found then raise exception 'CARD_TYPE_NOT_FOUND'; end if;
    if v_shop.card_charge_mode = 'add' then
      v_card_chg := round(v_total * v_card.charge_pct / 100, 2);
    end if;
  end if;

  -- EMI. Allowed on the product, run by the bank for that tenure, over the minimum.
  if v_x ? 'emi' and (v_x->'emi'->>'months') is not null then
    select * into v_emi from public.emi_plans
      where shop_id = v_shop.id and active
        and months = (v_x->'emi'->>'months')::integer
        and bank = coalesce(v_x->'emi'->>'bank', bank)
      order by bank limit 1;
    if not found then raise exception 'NO_EMI_PLAN:%', v_x->'emi'->>'months'; end if;
    if v_total < v_emi.min_amount then
      raise exception 'EMI_BELOW_MINIMUM:%', v_emi.min_amount::text;
    end if;
    -- Every line has to be EMI-able: a bank will not finance a laptop and a 50-taka
    -- cable on the same agreement.
    for v_item in select e from jsonb_array_elements(p_items) e loop
      if not public.emi_allowed((v_item->>'product_id')::uuid) then
        raise exception 'EMI_NOT_ALLOWED:%',
          (select name from public.products where id = (v_item->>'product_id')::uuid);
      end if;
    end loop;
    v_emi_chg := round(v_total * v_emi.charge_pct / 100, 2);
  end if;

  -- An old item taken in part payment. It cannot be worth more than the sale: handing
  -- cash out of the till for a used laptop is a purchase, not a sale, and dressing it up
  -- as one hides it from the books.
  if v_x ? 'exchange' and (v_x->'exchange'->>'value') is not null then
    v_exchange := greatest((v_x->'exchange'->>'value')::numeric, 0);
    if coalesce(btrim(v_x->'exchange'->>'description'), '') = '' then
      raise exception 'EXCHANGE_NEEDS_DESCRIPTION';
    end if;
  end if;

  v_total := v_total + v_card_chg + v_emi_chg;
  if v_exchange > v_total then raise exception 'EXCHANGE_OVER_TOTAL:%', v_total::text; end if;
  v_total := v_total - v_exchange;

  -- ---- Who is buying, before any question of credit -------------------------
  if p_customer_phone is not null and p_customer_phone <> '' then
    insert into public.customers (shop_id, phone) values (v_shop.id, p_customer_phone)
      on conflict (shop_id, phone) do update set phone = excluded.phone
      returning id into v_customer;
    select * into v_cust_row from public.customers where id = v_customer;
  end if;

  -- ---- Paying now, paying later, or some of each ---------------------------
  -- 'due' is the whole total on the slate; p_due_amount is a split, where the
  -- customer pays part now and the rest goes on the slate.
  if p_payment_method = 'due' then v_due := v_total; end if;
  if v_due > v_total then raise exception 'DUE_MORE_THAN_TOTAL'; end if;
  v_paid := v_total - v_due;

  if v_due > 0 then
    if not public.feature_on('credit_sales') then raise exception 'FEATURE_OFF:credit_sales'; end if;
    -- Somebody has to owe it. "Cash Customer" with a made-up phone — which is what BMS
    -- leaves behind — is a debt with nobody's name on it.
    if v_customer is null then raise exception 'DUE_NEEDS_CUSTOMER'; end if;
    if not v_cust_row.credit_allowed then raise exception 'CUSTOMER_HAS_NO_CREDIT:%', coalesce(v_cust_row.name_text, v_cust_row.phone); end if;
    -- The flags BMS calls Trader Flags, enforced where they matter rather than shown as
    -- a note somebody has to notice. A blocked customer is blocked at the till, not in
    -- a report read afterwards; "cash only" means what it says.
    if v_cust_row.blocked then
      raise exception 'CUSTOMER_BLOCKED:%', coalesce(v_cust_row.block_reason, 'no reason given');
    end if;
    if v_cust_row.cash_only then
      raise exception 'CUSTOMER_IS_CASH_ONLY:%', coalesce(v_cust_row.name_text, v_cust_row.phone);
    end if;

    -- The limit is on what they will owe AFTER this sale, not on this sale alone.
    v_owed := public.customer_due(v_customer);
    if v_cust_row.credit_limit > 0 and v_owed + v_due > v_cust_row.credit_limit then
      if v_approver is null then
        if p_approval_id is null then
          raise exception 'OVER_CREDIT_LIMIT:%', (v_cust_row.credit_limit - v_owed)::text;
        end if;
        update public.pin_attempts set used_at = now()
          where id = p_approval_id and shop_id = v_staff.shop_id and ok
            and used_at is null and created_at > now() - interval '10 minutes'
          returning approver_id into v_approver;
        if v_approver is null then raise exception 'APPROVAL_NOT_VALID'; end if;
      end if;
      insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
      values (v_shop.id, p_branch_id, v_staff.id, 'credit_limit_overridden', 'sale', v_sale_id,
              jsonb_build_object('customer', coalesce(v_cust_row.name_text, v_cust_row.phone),
                                 'limit', v_cust_row.credit_limit, 'already_owed', v_owed,
                                 'new_due', v_due, 'invoice', v_invoice,
                                 'approved_by', (select name from public.staff where id = v_approver)));
    end if;
  end if;

  -- A sale can be paid across several methods at once. When a breakdown is given it has
  -- to add up to what is being paid now, to the taka: off by one and the drawer is wrong
  -- at closing time and nobody knows why.
  if v_x ? 'payments' and jsonb_typeof(v_x->'payments') = 'array'
     and jsonb_array_length(v_x->'payments') > 0 then
    select coalesce(sum((e->>'amount')::numeric), 0) into v_pay_sum
      from jsonb_array_elements(v_x->'payments') e;
    if round(v_pay_sum, 2) <> round(v_paid, 2) then
      raise exception 'SPLIT_DOES_NOT_ADD_UP:%', v_paid::text;
    end if;
  end if;

  -- What is being handed over now is checked against the PAID part, not the total:
  -- a customer paying 30,000 of a 72,000 laptop is not short. With a split, the cash
  -- part is whatever the breakdown says, not the whole of what is due now.
  if v_pay_sum > 0 then
    select coalesce(sum((e->>'amount')::numeric), 0) into v_pay_sum
      from jsonb_array_elements(v_x->'payments') e where e->>'method' = 'cash';
    if p_cash_received is not null and p_cash_received > 0 then
      if p_cash_received < v_pay_sum then raise exception 'CASH_SHORT'; end if;
      v_change := p_cash_received - v_pay_sum;
    end if;
  elsif p_payment_method = 'cash' then
    if p_cash_received is null or p_cash_received < v_paid then raise exception 'CASH_SHORT'; end if;
    v_change := p_cash_received - v_paid;
  elsif v_pay.needs_ref and v_paid > 0 then
    if p_payment_ref is null or length(trim(p_payment_ref)) < 4 then raise exception 'PAYMENT_REF_REQUIRED'; end if;
  end if;

  select id into v_shift from public.shifts
    where staff_id = v_staff.id and branch_id = p_branch_id and closed_at is null
    order by opened_at desc limit 1;

  update public.sales set
    subtotal = v_subtotal, discount_pct = v_pct, discount_amount = v_discount, total = v_total,
    vat_amount = v_vat_total, charges_amount = v_charges,
    cash_received = case when p_payment_method = 'cash' then p_cash_received end,
    change_given = v_change, payment_ref = nullif(trim(coalesce(p_payment_ref, '')), ''),
    discount_approved_by = v_approver, customer_id = v_customer, shift_id = v_shift,
    due_amount = v_due, paid_amount = v_paid,
    attention = v_x->>'attention',
    customer_address = v_x->>'customer_address',
    customer_bin = v_x->>'customer_bin',
    customer_nid = v_x->>'customer_nid',
    narration = v_x->>'narration',
    sold_by = v_sold_by,
    extra_fields = v_x->'extra_fields',
    card_type_id = (v_x->'card'->>'type_id')::uuid,
    card_bank = v_x->'card'->>'bank',
    pos_account_id = (v_x->'card'->>'pos_account_id')::uuid,
    card_last4 = nullif(v_x->'card'->>'last4', ''),
    card_charge = v_card_chg,
    emi_months = (v_x->'emi'->>'months')::integer,
    emi_bank = coalesce(v_x->'emi'->>'bank', v_emi.bank),
    emi_charge = v_emi_chg,
    exchange_value = v_exchange
  where id = v_sale_id;

  -- The breakdown, when there was one.
  if v_x ? 'payments' and jsonb_typeof(v_x->'payments') = 'array' then
    for v_split in select e from jsonb_array_elements(v_x->'payments') e loop
      if (v_split->>'amount')::numeric > 0 then
        insert into public.sale_payments (sale_id, shop_id, method, amount, reference, account_id)
        values (v_sale_id, v_shop.id, v_split->>'method', (v_split->>'amount')::numeric,
                nullif(btrim(coalesce(v_split->>'reference', '')), ''),
                (v_split->>'account_id')::uuid);
      end if;
    end loop;
  end if;

  -- The old item, and optionally onto the shelf as a used unit.
  if v_exchange > 0 or (v_x ? 'exchange' and (v_x->'exchange'->>'description') is not null) then
    v_ex := v_x->'exchange';
    insert into public.sale_exchanges (sale_id, shop_id, branch_id, description, serial,
                                       value, product_id, added_to_stock)
    values (v_sale_id, v_shop.id, p_branch_id, btrim(v_ex->>'description'),
            nullif(btrim(coalesce(v_ex->>'serial', '')), ''), v_exchange,
            (v_ex->>'product_id')::uuid,
            coalesce((v_ex->>'add_to_stock')::boolean, false));

    if coalesce((v_ex->>'add_to_stock')::boolean, false) then
      if (v_ex->>'product_id') is null then raise exception 'EXCHANGE_NEEDS_PRODUCT'; end if;
      select * into v_ex_prod from public.products
        where id = (v_ex->>'product_id')::uuid and shop_id = v_shop.id;
      if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
      v_ex_loc := public.default_location(p_branch_id);

      if v_ex_prod.is_serial then
        if coalesce(btrim(v_ex->>'serial'), '') = '' then
          raise exception 'SERIAL_REQUIRED:%', v_ex_prod.name;
        end if;
        if exists (select 1 from public.serials
                   where shop_id = v_shop.id and serial = btrim(v_ex->>'serial')) then
          raise exception 'SERIAL_ALREADY_KNOWN:%', btrim(v_ex->>'serial');
        end if;
        insert into public.serials (shop_id, product_id, serial, location_id, unit_cost)
        values (v_shop.id, v_ex_prod.id, btrim(v_ex->>'serial'), v_ex_loc, v_exchange)
        returning id into v_ex_serial;
      end if;

      insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
      values (v_ex_prod.id, v_ex_loc, v_shop.id, p_branch_id, 1)
      on conflict (product_id, location_id) do update
        set qty = public.branch_stock.qty + 1, updated_at = now();

      -- The value given for it IS what the shop paid for it, so the average cost moves
      -- the same way a delivery moves it.
      perform public.apply_avg_cost(v_ex_prod.id, 1, v_exchange);

      insert into public.stock_movements (shop_id, branch_id, location_id, product_id,
                                          qty_change, reason, reason_detail, staff_id, note)
      values (v_shop.id, p_branch_id, v_ex_loc, v_ex_prod.id, 1, 'purchase', null, v_staff.id,
              v_invoice || ': taken in exchange');
    end if;
  end if;

  return jsonb_build_object(
    'id', v_sale_id, 'invoice_no', v_invoice, 'created_at', now(),
    'staff_name', v_staff.name, 'shop_name', v_shop.name, 'shop_address', v_shop.address,
    'branch_name', v_branch.name, 'branch_address', v_branch.address, 'branch_phone', v_branch.phone,
    'receipt_footer', v_shop.receipt_footer, 'bin_vat', v_shop.bin_vat, 'currency', v_shop.currency,
    'price_list_name', (select name from public.price_lists where id = v_list),
    'customer_name', v_cust->>'name',
    'subtotal', v_subtotal, 'discount_pct', v_pct, 'discount_amount', v_discount,
    'customer_discount_pct', v_cust_pct,
    'vat_amount', v_vat_total, 'charges_amount', v_charges, 'charges', v_chg_list,
    'total', v_total,
    'payment_method', p_payment_method, 'payment_label', v_pay.label,
    'cash_received', p_cash_received, 'change_given', v_change,
    'payment_ref', p_payment_ref, 'customer_phone', nullif(p_customer_phone, ''),
    'paid_amount', v_paid, 'due_amount', v_due,
    'card_charge', v_card_chg, 'emi_charge', v_emi_chg, 'exchange_value', v_exchange,
    'emi_months', (v_x->'emi'->>'months')::integer,
    'emi_bank', coalesce(v_x->'emi'->>'bank', v_emi.bank),
    'card_type', v_card.name, 'card_last4', nullif(v_x->'card'->>'last4', ''),
    'attention', v_x->>'attention', 'customer_bin', v_x->>'customer_bin',
    'narration', v_x->>'narration',
    'sold_by', (select name from public.staff where id = v_sold_by),
    'extra_fields', v_x->'extra_fields',
    'exchange', case when v_exchange > 0 or (v_x->'exchange'->>'description') is not null
                     then jsonb_build_object('description', v_x->'exchange'->>'description',
                                             'serial', v_x->'exchange'->>'serial',
                                             'value', v_exchange) end,
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
                   'method', sp.method, 'amount', sp.amount, 'reference', sp.reference)), '[]'::jsonb)
                 from public.sale_payments sp where sp.sale_id = v_sale_id),
    'customer_owes', case when v_customer is null then null else public.customer_due(v_customer) end,
    'items', v_lines);
end; $$;

-- ---------------------------------------------------------------------------
-- What kind of customer, whose, and where
-- ---------------------------------------------------------------------------

/**
 * Changing what a customer IS: retail to dealer, cash to credit (BMS "Trader Convert").
 *
 * One function rather than fields on the edit screen, because these are the changes
 * somebody will be asked about later: who made this dealer a dealer, and who allowed
 * them credit. Every one is logged with what it was before.
 */
create or replace function public.convert_customer(p_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_before jsonb; v_row public.customers;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('manage_customers') then
    raise exception 'NOT_ALLOWED:manage_customers';
  end if;
  select to_jsonb(c.*) into v_before from public.customers c
    where c.id = p_id and c.shop_id = v_me.shop_id;
  if v_before is null then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if p_values ? 'kind' and p_values->>'kind' not in ('retail', 'dealer', 'retailer', 'corporate') then
    raise exception 'BAD_CUSTOMER_KIND:%', p_values->>'kind';
  end if;
  -- Blocking somebody needs a reason: "why can this customer not buy?" is asked at the
  -- till, by somebody who was not there when the decision was made.
  if coalesce((p_values->>'blocked')::boolean, false)
     and coalesce(trim(p_values->>'block_reason'), '') = '' then
    raise exception 'REASON_REQUIRED';
  end if;

  update public.customers set
    kind = coalesce(nullif(p_values->>'kind', ''), kind),
    parent_id = case when p_values ? 'parent_id' then (p_values->>'parent_id')::uuid else parent_id end,
    rep_id = case when p_values ? 'rep_id' then (p_values->>'rep_id')::uuid else rep_id end,
    blocked = coalesce((p_values->>'blocked')::boolean, blocked),
    block_reason = case when p_values ? 'blocked'
                        then nullif(p_values->>'block_reason', '') else block_reason end,
    cash_only = coalesce((p_values->>'cash_only')::boolean, cash_only),
    is_vip = coalesce((p_values->>'is_vip')::boolean, is_vip),
    -- Converting to a dealer usually means giving them credit and a price list, so
    -- those come along rather than being a second trip through another screen.
    group_id = case when p_values ? 'group_id' then (p_values->>'group_id')::uuid else group_id end,
    price_list_id = case when p_values ? 'price_list_id'
                         then (p_values->>'price_list_id')::uuid else price_list_id end,
    credit_allowed = coalesce((p_values->>'credit_allowed')::boolean, credit_allowed),
    credit_limit = coalesce((p_values->>'credit_limit')::numeric, credit_limit),
    payment_days = coalesce((p_values->>'payment_days')::integer, payment_days)
  where id = p_id
  returning * into v_row;

  -- A sub-dealer cannot be its own parent, and a chain of one is not a chain.
  if v_row.parent_id = v_row.id then raise exception 'CUSTOMER_CANNOT_BE_ITS_OWN_DEALER'; end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'customer_converted', 'customer', p_id,
          jsonb_build_object('name', coalesce(v_row.name_text, v_row.phone),
                             'from', v_before - 'id', 'to', to_jsonb(v_row) - 'id'));

  return to_jsonb(v_row);
end; $$;

/**
 * Moving a customer to another branch (BMS "Branch Wise Trader Transfer").
 *
 * Their debts go with them, because a debt belongs to the customer and not to the
 * branch that happened to make the sale — but the SALES stay where they happened, or
 * last month's branch figures would change every time somebody moved a customer.
 */
create or replace function public.move_customer_branch(
  p_id uuid, p_branch_id uuid, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_cust public.customers; v_owed numeric(12,2);
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('manage_customers') then
    raise exception 'NOT_ALLOWED:manage_customers';
  end if;
  select * into v_cust from public.customers where id = p_id and shop_id = v_me.shop_id;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  v_owed := public.customer_due(p_id);
  update public.customers set home_branch_id = p_branch_id where id = p_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'customer_moved_branch', 'customer', p_id,
          jsonb_build_object('name', coalesce(v_cust.name_text, v_cust.phone),
                             'from', v_cust.home_branch_id, 'to', p_branch_id,
                             'owed', v_owed, 'reason', p_reason));

  return jsonb_build_object('id', p_id, 'branch_id', p_branch_id, 'owed', v_owed);
end; $$;

/**
 * One search box across everything a customer has: name, phone, company, their rep,
 * their area, what kind they are.
 *
 * The same thinking as the sales search (P9): whoever is looking has one thing in their
 * hand and should not have to know which field it lives in.
 */
create or replace function public.customer_search(
  p_query text default null, p_kind text default null, p_rep_id uuid default null,
  p_district_id integer default null, p_flag text default null,
  p_limit integer default 100
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_q text := nullif(btrim(coalesce(p_query, '')), '');
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;

  return (
    select coalesce(jsonb_agg(x order by lower(x->>'name')), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'id', c.id, 'phone', c.phone, 'name', coalesce(c.name_text, c.phone),
        'company', c.company, 'address', c.address,
        'kind', c.kind, 'group', g.name, 'group_id', c.group_id,
        'rep', e.name, 'rep_id', c.rep_id,
        'parent', (select coalesce(p.name_text, p.phone) from public.customers p
                   where p.id = c.parent_id),
        'parent_id', c.parent_id,
        'home_branch', b.name, 'home_branch_id', c.home_branch_id,
        'district_id', c.district_id, 'district',
          (select d.name from public.districts d where d.id = c.district_id),
        'blocked', c.blocked, 'block_reason', c.block_reason,
        'cash_only', c.cash_only, 'is_vip', c.is_vip,
        'credit_allowed', c.credit_allowed, 'credit_limit', c.credit_limit,
        'payment_days', c.payment_days,
        'owed', public.customer_due(c.id),
        'deposit', public.deposit_held(c.id),
        'delivery_points', (select count(*) from public.delivery_points dp
                            where dp.customer_id = c.id and dp.active),
        'active', c.active) as x
      from public.customers c
      left join public.customer_groups g on g.id = c.group_id
      left join public.employees e on e.id = c.rep_id
      left join public.branches b on b.id = c.home_branch_id
      where c.shop_id = v_me.shop_id
        and (v_q is null
             or c.phone like '%' || v_q || '%'
             or coalesce(c.name_text, '') ilike '%' || v_q || '%'
             or coalesce(c.company, '') ilike '%' || v_q || '%'
             or coalesce(c.address, '') ilike '%' || v_q || '%'
             or coalesce(e.name, '') ilike '%' || v_q || '%')
        and (p_kind is null or c.kind = p_kind)
        and (p_rep_id is null or c.rep_id = p_rep_id)
        and (p_district_id is null or c.district_id = p_district_id)
        and (p_flag is null
             or (p_flag = 'blocked' and c.blocked)
             or (p_flag = 'cash_only' and c.cash_only)
             or (p_flag = 'vip' and c.is_vip)
             or (p_flag = 'has_deposit' and public.deposit_held(c.id) > 0))
      limit greatest(coalesce(p_limit, 100), 1)
    ) q);
end; $$;

/** The reps, for the pickers and the settings screen. */
create or replace function public.rep_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', e.id, 'name', e.name, 'phone', e.phone,
      'branch', b.name, 'branch_id', e.branch_id,
      'commission_pct', e.commission_pct, 'commission_on', e.commission_on,
      'customers', (select count(*) from public.customers c where c.rep_id = e.id),
      'areas', (select coalesce(jsonb_agg(jsonb_build_object(
                  'district_id', ra.district_id,
                  'district', (select d.name from public.districts d where d.id = ra.district_id),
                  'upazila_id', ra.upazila_id,
                  'upazila', (select u.name from public.upazilas u where u.id = ra.upazila_id))),
                  '[]'::jsonb)
                from public.rep_areas ra where ra.employee_id = e.id))
      order by e.name), '[]'::jsonb)
    from public.employees e
    left join public.branches b on b.id = e.branch_id
    where e.shop_id = v_me.shop_id and e.active and e.is_rep);
end; $$;

-- ---------------------------------------------------------------------------
-- The reports the rep side unlocks
-- ---------------------------------------------------------------------------
--
-- The five still marked "needs P14c" in docs/BMS_REPORTS.md section 4. The sale
-- datasets already carry a `rep` column (it falls back to who made the sale, so no
-- invoice is dropped), so four of them are configuration; the rep statement needs a
-- view of its own.

create or replace view public.v_rep_statement as
select
  c.shop_id,
  coalesce(c.home_branch_id,
           (select b.id from public.branches b where b.shop_id = c.shop_id
            order by b.created_at limit 1)) as branch_id,
  coalesce(b.name, 'Whole shop') as branch,
  coalesce(e.name, 'No rep') as rep,
  coalesce(cg.name, 'Retail') as trader_group,
  initcap(c.kind) as kind,
  coalesce(c.name_text, c.company, c.phone) as trader,
  coalesce(c.address, '—') as address,
  c.id as customer_id,
  coalesce((select ob.amount from public.opening_balances ob where ob.customer_id = c.id), 0)
    as opening,
  coalesce((select sum(s.total) from public.sales s
            where s.customer_id = c.id and s.status = 'completed'), 0) as sales,
  coalesce((select sum(r.total) from public.sale_returns r
            where r.customer_id = c.id and r.approval_status <> 'cancelled'), 0) as returned,
  coalesce((select sum(s.discount_amount) from public.sales s
            where s.customer_id = c.id and s.status = 'completed'), 0) as discount,
  coalesce((select sum(cp.amount) from public.customer_payments cp
            where cp.customer_id = c.id), 0) as received,
  public.deposit_held(c.id) as deposit,
  public.customer_due(c.id) as due,
  -- A statement with no date range is "as it stands now", so the date is today: the
  -- figures are balances, not a period's movements.
  public.dhaka_today() as d,
  to_char(public.dhaka_today(), 'YYYY-MM') as month
from public.customers c
left join public.employees e on e.id = c.rep_id
left join public.customer_groups cg on cg.id = c.group_id
left join public.branches b on b.id = c.home_branch_id;

insert into public.rep_datasets (dataset, source, params, date_field, amount_field,
                                 qty_field, cost_field, profit_field) values
  ('rep_statement', 'public.v_rep_statement', '{}', 'd', 'sales', null, null, null);

do $$
declare r record; v_cols text[];
begin
  for r in select * from public.rep_datasets where cols = '{}' loop
    select array_agg(a.attname::text) into v_cols from pg_attribute a
    where a.attrelid = r.source::regclass and a.attnum > 0 and not a.attisdropped;
    if v_cols is null then raise exception 'NO COLUMNS FOUND FOR DATASET %', r.dataset; end if;
    update public.rep_datasets set cols = v_cols where dataset = r.dataset;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Who may read what
-- ---------------------------------------------------------------------------

alter table public.rep_areas         enable row level security;
alter table public.rep_targets       enable row level security;
alter table public.delivery_points   enable row level security;
alter table public.customer_deposits enable row level security;

-- Where to deliver is the counter's business: somebody has to tell the van.
create policy delivery_points_read on public.delivery_points for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy rep_areas_read on public.rep_areas for select to authenticated
  using (shop_id = (select public.current_shop_id()));
-- What somebody was asked to sell is between them and the owner.
create policy rep_targets_read on public.rep_targets for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and ((select public.has_permission('manage_hr'))
              or employee_id in (select e.id from public.employees e
                                 join public.staff s on s.id = e.staff_id
                                 where s.user_id = auth.uid())));
-- A deposit is money, so it follows the money permission.
create policy customer_deposits_read on public.customer_deposits for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('manage_customers')));

grant select on public.rep_areas, public.rep_targets, public.delivery_points,
                public.customer_deposits to authenticated;

grant execute on function public.save_rep(uuid, jsonb) to authenticated;
grant execute on function public.save_rep_target(uuid, date, jsonb) to authenticated;
grant execute on function public.rep_achievement(date, uuid) to authenticated;
grant execute on function public.rep_list() to authenticated;
grant execute on function public.save_delivery_point(uuid, uuid, jsonb) to authenticated;
grant execute on function public.delivery_point_list(uuid) to authenticated;
grant execute on function public.record_deposit(uuid, numeric, text, text, text, uuid) to authenticated;
grant execute on function public.deposit_held(uuid) to authenticated;
grant execute on function public.convert_customer(uuid, jsonb) to authenticated;
grant execute on function public.move_customer_branch(uuid, uuid, text) to authenticated;
grant execute on function public.customer_search(text, text, uuid, integer, text, integer) to authenticated;

revoke all on function public.seed_deposit_account(uuid) from authenticated;
