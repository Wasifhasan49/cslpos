-- P10 — Credit sales (baki) and customers
--
-- Selling on due is how a lot of trade in this market actually works, and it is the
-- thing most likely to lose a shop money quietly: BMS records every walk-in as "Cash
-- Customer" with a mobile of 2026-01-01, so a debt has nobody's name on it and the owner
-- finds out months later.
--
-- THE RULES THAT MATTER
--  * Anything on due needs a real customer. A phone number is the minimum, because it is
--    what the shop will use to chase it.
--  * The credit limit is checked against what they will owe AFTER this sale, not against
--    this sale alone. Three sales of 20,000 each to a customer with a 50,000 limit is
--    60,000 of exposure, and checking each one in isolation lets it through.
--  * Collections come off the OLDEST invoice first, like supplier payments, because that
--    is what both sides assume and it is the only way the aging buckets mean anything.
--  * A cash collection goes through the drawer, so the shift it happened on knows.

-- ---------------------------------------------------------------------------
-- One name per customer
-- ---------------------------------------------------------------------------

-- `customers` ended up with two name columns: `name` from the first migration and
-- `name_text` added in P3, which is the one everything writes. Two columns for one fact
-- is a trap — P9's sale search read the empty one — so they become one here.
update public.customers set name_text = coalesce(name_text, name) where name_text is null;
alter table public.customers drop column name;

-- ---------------------------------------------------------------------------
-- Customer groups (BMS "Trader Group")
-- ---------------------------------------------------------------------------

create table public.customer_groups (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  name          text not null,
  -- A group can carry the price list and standing discount its members get, so a new
  -- dealer is set up by picking "Dealer" rather than by remembering two fields.
  price_list_id uuid references public.price_lists(id) on delete set null,
  discount_pct  numeric(5,2) not null default 0
                check (discount_pct >= 0 and discount_pct <= 100),
  credit_allowed boolean not null default false,
  credit_limit  numeric(12,2) not null default 0 check (credit_limit >= 0),
  payment_days  integer not null default 0 check (payment_days >= 0),
  active        boolean not null default true,
  unique (shop_id, name)
);

alter table public.customers
  add column group_id      uuid references public.customer_groups(id) on delete set null,
  add column company        text,
  add column address        text,
  add column district_id    integer references public.districts(id),
  add column upazila_id     integer references public.upazilas(id),
  -- Corporate buyers need a BIN on the invoice; individuals sometimes give an NID.
  add column bin_vat        text,
  add column nid            text,
  add column note           text,
  add column credit_allowed boolean not null default false,
  -- 0 means "no ceiling set", which is a decision the owner has to make deliberately.
  add column credit_limit   numeric(12,2) not null default 0 check (credit_limit >= 0),
  -- How long they have to pay. Used to tell overdue from merely outstanding.
  add column payment_days   integer not null default 0 check (payment_days >= 0),
  add column active         boolean not null default true;

create index customers_group_idx on public.customers(group_id);

-- What a sale was paid now and what went on the slate. Split payments are normal:
-- 30,000 down on a laptop and the rest next month.
alter table public.sales
  add column due_amount  numeric(12,2) not null default 0 check (due_amount >= 0),
  add column paid_amount numeric(12,2) not null default 0;

-- The till can only take a payment method the shop has switched on, and that list
-- already has bank, cheque, rocket and due in it — but the column's own check was
-- still the original four, so turning one on in Settings would fail at the last step.
alter table public.sales drop constraint sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check
  check (payment_method in ('cash', 'bkash', 'nagad', 'card', 'rocket', 'bank',
                            'cheque', 'due'));

create table public.customer_payments (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id) on delete cascade,
  receipt_no  text not null,
  amount      numeric(12,2) not null check (amount > 0),
  method      text not null check (method in ('cash', 'bkash', 'nagad', 'card', 'rocket',
                                              'bank', 'cheque')),
  reference   text,
  account_id  uuid references public.bank_accounts(id),
  note        text,
  shift_id    uuid references public.shifts(id),
  staff_id    uuid not null references public.staff(id),
  created_at  timestamptz not null default now(),
  unique (shop_id, receipt_no)
);
create index customer_payments_customer_idx on public.customer_payments(customer_id, created_at desc);
create index customer_payments_branch_idx on public.customer_payments(branch_id, created_at desc);

-- ---------------------------------------------------------------------------
-- What a customer owes
-- ---------------------------------------------------------------------------

/**
 * Everything that put a customer in debt, less everything that took them out of it.
 *
 * Worked out from the documents every time rather than kept as a running total, for the
 * same reason the supplier balance is: a stored figure drifts, and nobody can say when.
 */
create or replace function public.customer_due(p_customer_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select
    coalesce((select sum(s.due_amount) from public.sales s
              where s.customer_id = p_customer_id and s.status = 'completed'), 0)
    + coalesce((select ob.amount from public.opening_balances ob
                where ob.customer_id = p_customer_id), 0)
    - coalesce((select sum(cp.amount) from public.customer_payments cp
                where cp.customer_id = p_customer_id), 0)
    -- A return refunded "off their due" reduces what they owe instead of handing cash
    -- back, and store credit is the shop owing them, so it counts the same way.
    - coalesce((select sum(r.total) from public.sale_returns r
                where r.customer_id = p_customer_id
                  and r.refund_method in ('reduce_due', 'store_credit')
                  and r.approval_status <> 'cancelled'), 0);
$$;

/**
 * How old the debt is: 0–30, 31–60, 60+ days, with collections applied OLDEST FIRST.
 *
 * `overdue` is a different question from `60+`: it is measured against the days this
 * customer was actually given, so a corporate buyer on 45-day terms is not overdue at
 * 40 days while a walk-in on no terms is overdue the next morning.
 */
create or replace function public.customer_aging(p_customer_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_paid   numeric(12,2);
  v_bucket record;
  v_b1     numeric(12,2) := 0;
  v_b2     numeric(12,2) := 0;
  v_b3     numeric(12,2) := 0;
  v_take   numeric(12,2);
  v_days   integer;
  v_over   numeric(12,2) := 0;
begin
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;

  select coalesce(payment_days, 0) into v_days from public.customers where id = p_customer_id;

  v_paid := coalesce((select sum(amount) from public.customer_payments
                      where customer_id = p_customer_id), 0)
          + coalesce((select sum(total) from public.sale_returns
                      where customer_id = p_customer_id
                        and refund_method in ('reduce_due', 'store_credit')
                        and approval_status <> 'cancelled'), 0);

  for v_bucket in
    select age, sum(amount) as amount, min(on_date) as oldest from (
      select case
               when public.dhaka_today() - on_date <= 30 then 1
               when public.dhaka_today() - on_date <= 60 then 2
               else 3
             end as age, amount, on_date
      from (
        select s.due_amount as amount, (s.created_at at time zone 'Asia/Dhaka')::date as on_date
        from public.sales s
        where s.customer_id = p_customer_id and s.status = 'completed' and s.due_amount > 0
        union all
        select ob.amount, ob.as_of
        from public.opening_balances ob where ob.customer_id = p_customer_id
      ) rows
    ) aged
    group by age
    order by age desc
  loop
    v_take := least(v_paid, v_bucket.amount);
    v_paid := v_paid - v_take;
    if v_bucket.age = 1 then v_b1 := v_bucket.amount - v_take;
    elsif v_bucket.age = 2 then v_b2 := v_bucket.amount - v_take;
    else v_b3 := v_bucket.amount - v_take;
    end if;
  end loop;

  -- Anything older than the days this customer was given.
  select coalesce(sum(left_over), 0) into v_over from (
    select greatest(s.due_amount
             - coalesce((select sum(cp.amount) from public.customer_payments cp
                         where cp.customer_id = p_customer_id
                           and cp.created_at < s.created_at), 0), 0) as left_over
    from public.sales s
    where s.customer_id = p_customer_id and s.status = 'completed' and s.due_amount > 0
      and public.dhaka_today() - (s.created_at at time zone 'Asia/Dhaka')::date > v_days
  ) q;

  return jsonb_build_object(
    'days_0_30', greatest(v_b1, 0), 'days_31_60', greatest(v_b2, 0),
    'days_60_plus', greatest(v_b3, 0),
    'total', public.customer_due(p_customer_id),
    'payment_days', v_days,
    'overdue', least(greatest(v_over, 0), greatest(public.customer_due(p_customer_id), 0)),
    'in_credit', greatest(v_paid, 0));
end; $$;

-- ---------------------------------------------------------------------------
-- Keeping the customer list
-- ---------------------------------------------------------------------------

/**
 * Add or change a customer.
 *
 * Anyone who can sell may put a name and a phone on a walk-in — that is how the list
 * gets built at all. The credit fields are a manager's decision, because a cashier who
 * can set their friend's limit to 500,000 has been handed the till.
 */
create or replace function public.save_customer(p_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_row    public.customers;
  v_before jsonb;
  v_credit boolean := p_values ?| array['credit_allowed', 'credit_limit', 'payment_days',
                                        'price_list_id', 'discount_pct', 'group_id'];
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;
  -- Credit, prices and discounts are the owner's levers, not the counter's.
  if v_credit and not public.is_manager() then raise exception 'NOT_MANAGER'; end if;

  if p_id is null then
    if coalesce(btrim(p_values->>'phone'), '') = '' then raise exception 'BAD_PHONE'; end if;
    insert into public.customers (
      shop_id, phone, name_text, company, address, district_id, upazila_id, bin_vat, nid,
      note, group_id, price_list_id, discount_pct, credit_allowed, credit_limit, payment_days)
    values (
      v_me.shop_id, btrim(p_values->>'phone'), nullif(btrim(coalesce(p_values->>'name', '')), ''),
      p_values->>'company', p_values->>'address',
      (p_values->>'district_id')::integer, (p_values->>'upazila_id')::integer,
      p_values->>'bin_vat', p_values->>'nid', p_values->>'note',
      (p_values->>'group_id')::uuid, (p_values->>'price_list_id')::uuid,
      coalesce((p_values->>'discount_pct')::numeric, 0),
      coalesce((p_values->>'credit_allowed')::boolean, false),
      coalesce((p_values->>'credit_limit')::numeric, 0),
      coalesce((p_values->>'payment_days')::integer, 0))
    on conflict (shop_id, phone) do update
      set name_text = coalesce(excluded.name_text, public.customers.name_text)
    returning * into v_row;
  else
    select to_jsonb(c.*) into v_before from public.customers c
      where c.id = p_id and c.shop_id = v_me.shop_id;
    if v_before is null then raise exception 'CUSTOMER_NOT_FOUND'; end if;

    update public.customers set
      phone = coalesce(nullif(btrim(p_values->>'phone'), ''), phone),
      name_text = case when p_values ? 'name' then nullif(btrim(coalesce(p_values->>'name','')), '') else name_text end,
      company = case when p_values ? 'company' then p_values->>'company' else company end,
      address = case when p_values ? 'address' then p_values->>'address' else address end,
      district_id = case when p_values ? 'district_id' then (p_values->>'district_id')::integer else district_id end,
      upazila_id = case when p_values ? 'upazila_id' then (p_values->>'upazila_id')::integer else upazila_id end,
      bin_vat = case when p_values ? 'bin_vat' then p_values->>'bin_vat' else bin_vat end,
      nid = case when p_values ? 'nid' then p_values->>'nid' else nid end,
      note = case when p_values ? 'note' then p_values->>'note' else note end,
      group_id = case when p_values ? 'group_id' then (p_values->>'group_id')::uuid else group_id end,
      price_list_id = case when p_values ? 'price_list_id' then (p_values->>'price_list_id')::uuid else price_list_id end,
      discount_pct = coalesce((p_values->>'discount_pct')::numeric, discount_pct),
      credit_allowed = coalesce((p_values->>'credit_allowed')::boolean, credit_allowed),
      credit_limit = coalesce((p_values->>'credit_limit')::numeric, credit_limit),
      payment_days = coalesce((p_values->>'payment_days')::integer, payment_days),
      active = coalesce((p_values->>'active')::boolean, active)
    where id = p_id
    returning * into v_row;

    if v_credit then
      insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
      values (v_me.shop_id, v_me.id, 'customer_credit_changed', 'customer', p_id,
              jsonb_build_object('name', coalesce(v_row.name_text, v_row.phone),
                                 'from', v_before - 'id', 'to', to_jsonb(v_row) - 'id'));
    end if;
  end if;

  return to_jsonb(v_row);
end; $$;

/** Customer groups: Retail, Dealer, Corporate. Owner and manager only. */
create or replace function public.save_customer_group(p_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row public.customer_groups;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
  if p_id is null and coalesce(btrim(p_values->>'name'), '') = '' then
    raise exception 'GROUP_NAME_REQUIRED';
  end if;

  if p_id is null then
    insert into public.customer_groups (shop_id, name, price_list_id, discount_pct,
                                        credit_allowed, credit_limit, payment_days)
    values (v_me.shop_id, btrim(p_values->>'name'), (p_values->>'price_list_id')::uuid,
            coalesce((p_values->>'discount_pct')::numeric, 0),
            coalesce((p_values->>'credit_allowed')::boolean, false),
            coalesce((p_values->>'credit_limit')::numeric, 0),
            coalesce((p_values->>'payment_days')::integer, 0))
    returning * into v_row;
  else
    update public.customer_groups set
      name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
      price_list_id = case when p_values ? 'price_list_id' then (p_values->>'price_list_id')::uuid else price_list_id end,
      discount_pct = coalesce((p_values->>'discount_pct')::numeric, discount_pct),
      credit_allowed = coalesce((p_values->>'credit_allowed')::boolean, credit_allowed),
      credit_limit = coalesce((p_values->>'credit_limit')::numeric, credit_limit),
      payment_days = coalesce((p_values->>'payment_days')::integer, payment_days),
      active = coalesce((p_values->>'active')::boolean, active)
    where id = p_id and shop_id = v_me.shop_id
    returning * into v_row;
    if v_row.id is null then raise exception 'GROUP_NOT_FOUND'; end if;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id,
          case when p_id is null then 'customer_group_added' else 'customer_group_changed' end,
          'customer_group', v_row.id, jsonb_build_object('name', v_row.name));
  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- Collecting
-- ---------------------------------------------------------------------------

/**
 * Take money off a customer's due.
 *
 * Applied to the oldest invoice first, which is what the customer assumes and the only
 * way the aging buckets mean anything. A cash collection goes through the drawer, so the
 * shift that took it is accountable for it at closing time.
 */
create or replace function public.collect_payment(
  p_branch_id   uuid,
  p_customer_id uuid,
  p_amount      numeric,
  p_method      text,
  p_reference   text default null,
  p_note        text default null,
  p_account_id  uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_cust  public.customers;
  v_owed  numeric(12,2);
  v_shift uuid;
  v_no    text;
  v_id    uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  -- Taking money in is a counter job; it is giving credit that needs a manager.
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_PAYMENT_AMOUNT'; end if;
  if p_method not in ('cash', 'bkash', 'nagad', 'card', 'rocket', 'bank', 'cheque') then
    raise exception 'BAD_PAYMENT_METHOD';
  end if;

  select * into v_cust from public.customers
    where id = p_customer_id and shop_id = v_me.shop_id;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if p_account_id is not null
     and not exists (select 1 from public.bank_accounts
                     where id = p_account_id and shop_id = v_me.shop_id) then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  v_owed := public.customer_due(p_customer_id);
  -- Overpaying is allowed and leaves the customer in credit, because refusing it at the
  -- counter means handing back notes the customer has already put down.

  select id into v_shift from public.shifts
    where staff_id = v_me.id and branch_id = p_branch_id and closed_at is null
    order by opened_at desc limit 1;

  v_no := public.next_document_number(p_branch_id, 'receipt');
  insert into public.customer_payments (shop_id, branch_id, customer_id, receipt_no, amount,
                                        method, reference, account_id, note, shift_id, staff_id)
  values (v_me.shop_id, p_branch_id, p_customer_id, v_no, p_amount, p_method,
          nullif(btrim(coalesce(p_reference, '')), ''), p_account_id, p_note, v_shift, v_me.id)
  returning id into v_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'customer_paid', 'customer', p_customer_id,
          jsonb_build_object('receipt_no', v_no,
                             'customer', coalesce(v_cust.name_text, v_cust.phone),
                             'amount', p_amount, 'method', p_method,
                             'was_owed', v_owed, 'now_owed', v_owed - p_amount));

  return jsonb_build_object('receipt_no', v_no, 'payment_id', v_id,
                            'customer', coalesce(v_cust.name_text, v_cust.phone),
                            'amount', p_amount, 'was_owed', v_owed,
                            'owed', public.customer_due(p_customer_id),
                            'shop_name', (select name from public.shops where id = v_me.shop_id),
                            'branch', (select name from public.branches where id = p_branch_id),
                            'taken_by', v_me.name);
end; $$;

-- ---------------------------------------------------------------------------
-- Who owes what
-- ---------------------------------------------------------------------------

/** Everyone with money outstanding, worst first, with how overdue they are. */
create or replace function public.due_list(p_branch_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;

  select coalesce(jsonb_agg(x order by (x->>'overdue')::numeric desc, (x->>'owed')::numeric desc),
                  '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'customer_id', c.id, 'name', coalesce(c.name_text, c.phone), 'phone', c.phone,
      'company', c.company, 'group', g.name,
      'credit_limit', c.credit_limit, 'payment_days', c.payment_days,
      'owed', public.customer_due(c.id),
      'aging', public.customer_aging(c.id),
      'overdue', (public.customer_aging(c.id)->>'overdue')::numeric,
      -- The last time anything was collected, so "we chased them in March" is visible.
      'last_paid', (select max(cp.created_at) from public.customer_payments cp
                    where cp.customer_id = c.id),
      'oldest_due', (select min((s.created_at at time zone 'Asia/Dhaka')::date)
                     from public.sales s
                     where s.customer_id = c.id and s.status = 'completed' and s.due_amount > 0)
    ) as x
    from public.customers c
    left join public.customer_groups g on g.id = c.group_id
    where c.shop_id = (select public.current_shop_id())
      and public.customer_due(c.id) > 0
      -- A due belongs to the shop, not to a branch, but an owner may want to see only
      -- what one branch sold on credit.
      and (p_branch_id is null
           or exists (select 1 from public.sales s
                      where s.customer_id = c.id and s.branch_id = p_branch_id
                        and s.due_amount > 0))
  ) q;
  return v_out;
end; $$;

/**
 * One customer's statement: everything that moved their balance, oldest first, plus what
 * they have bought and which serial-tracked items they own (for a warranty claim).
 */
create or replace function public.customer_statement(p_customer_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_cust public.customers; v_out jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;

  select * into v_cust from public.customers
    where id = p_customer_id and shop_id = v_me.shop_id;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;

  select jsonb_build_object(
    'customer_id', v_cust.id, 'name', coalesce(v_cust.name_text, v_cust.phone),
    'phone', v_cust.phone, 'company', v_cust.company, 'address', v_cust.address,
    'bin_vat', v_cust.bin_vat, 'nid', v_cust.nid, 'note', v_cust.note,
    'group', (select name from public.customer_groups where id = v_cust.group_id),
    'price_list', (select name from public.price_lists where id = v_cust.price_list_id),
    'discount_pct', v_cust.discount_pct,
    'credit_allowed', v_cust.credit_allowed, 'credit_limit', v_cust.credit_limit,
    'payment_days', v_cust.payment_days,
    'owed', public.customer_due(p_customer_id),
    'aging', public.customer_aging(p_customer_id),
    'total_spent', coalesce((select sum(s.total) from public.sales s
                             where s.customer_id = p_customer_id and s.status = 'completed'), 0),
    'sale_count', (select count(*) from public.sales s
                   where s.customer_id = p_customer_id and s.status = 'completed'),
    'entries', (
      select coalesce(jsonb_agg(e order by e->>'at'), '[]'::jsonb) from (
        select jsonb_build_object('at', ob.as_of, 'kind', 'opening',
                                  'document', 'Opening balance', 'change', ob.amount,
                                  'note', ob.note) as e
        from public.opening_balances ob where ob.customer_id = p_customer_id
        union all
        select jsonb_build_object('at', s.created_at, 'kind', 'sale',
                                  'document', s.invoice_no, 'change', s.due_amount,
                                  'note', 'Total ' || s.total || ', paid ' || s.paid_amount)
        from public.sales s
        where s.customer_id = p_customer_id and s.status = 'completed' and s.due_amount > 0
        union all
        select jsonb_build_object('at', cp.created_at, 'kind', 'payment',
                                  'document', cp.receipt_no, 'change', -cp.amount,
                                  'note', cp.method)
        from public.customer_payments cp where cp.customer_id = p_customer_id
        union all
        select jsonb_build_object('at', r.created_at, 'kind', 'return',
                                  'document', r.return_no, 'change', -r.total,
                                  'note', r.refund_method)
        from public.sale_returns r
        where r.customer_id = p_customer_id
          and r.refund_method in ('reduce_due', 'store_credit')
          and r.approval_status <> 'cancelled'
      ) q),
    -- Everything they have bought, newest first.
    'purchases', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'invoice_no', s.invoice_no, 'at', s.created_at,
               'branch', b.name, 'total', s.total, 'due', s.due_amount,
               'status', s.status,
               'items', (select string_agg(i.name, ', ') from public.sale_items i
                         where i.sale_id = s.id)) order by s.created_at desc), '[]'::jsonb)
      from public.sales s join public.branches b on b.id = s.branch_id
      where s.customer_id = p_customer_id),
    -- Serial-tracked items this customer owns, with the warranty end date: the answer
    -- to "my laptop has died, am I covered?" without hunting through invoices.
    'owns', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'serial', se.serial, 'product', i.name,
               'bought', (s.created_at at time zone 'Asia/Dhaka')::date,
               'invoice_no', s.invoice_no,
               'warranty_until', i.warranty_until,
               'in_warranty', i.warranty_until is not null
                              and i.warranty_until >= public.dhaka_today(),
               'status', se.status) order by se.serial), '[]'::jsonb)
      from public.sales s
      join public.sale_items i on i.sale_id = s.id
      join public.sale_item_serials sis on sis.sale_item_id = i.id
      join public.serials se on se.id = sis.serial_id
      where s.customer_id = p_customer_id and s.status = 'completed')
  ) into v_out;
  return v_out;
end; $$;

/** The customer list, with what each one owes. */
create or replace function public.customer_list(
  p_query text default null, p_limit integer default 100
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb; v_q text := nullif(btrim(coalesce(p_query, '')), '');
begin
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;

  select coalesce(jsonb_agg(x order by lower(x->>'name')), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'id', c.id, 'phone', c.phone, 'name', coalesce(c.name_text, c.phone),
      'company', c.company, 'address', c.address,
      'group_id', c.group_id, 'group', g.name,
      'price_list_id', c.price_list_id,
      'price_list', (select name from public.price_lists where id = c.price_list_id),
      'discount_pct', c.discount_pct, 'bin_vat', c.bin_vat, 'nid', c.nid,
      'note', c.note, 'active', c.active,
      'district_id', c.district_id, 'upazila_id', c.upazila_id,
      'credit_allowed', c.credit_allowed, 'credit_limit', c.credit_limit,
      'payment_days', c.payment_days,
      -- A cashier may take a payment, so they need to see the figure; what they must
      -- not see is cost and profit, which is a different thing.
      'owed', public.customer_due(c.id),
      'total_spent', coalesce((select sum(s.total) from public.sales s
                               where s.customer_id = c.id and s.status = 'completed'), 0)
    ) as x
    from public.customers c
    left join public.customer_groups g on g.id = c.group_id
    where c.shop_id = (select public.current_shop_id())
      and (v_q is null
           or c.phone like '%' || v_q || '%'
           or coalesce(c.name_text, '') ilike '%' || v_q || '%'
           or coalesce(c.company, '') ilike '%' || v_q || '%')
    limit greatest(coalesce(p_limit, 100), 1)
  ) q;
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- A customer's price list now comes from their group as well
-- ---------------------------------------------------------------------------

/**
 * What the counter learns from a phone number. The customer's own list wins; failing
 * that their group's, so setting up a dealer is one field rather than three.
 */
create or replace function public.customer_by_phone(p_phone text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;
  select jsonb_build_object(
    'id', c.id, 'phone', c.phone, 'name', c.name_text,
    'price_list_id', coalesce(c.price_list_id, g.price_list_id),
    'price_list_name', (select name from public.price_lists
                        where id = coalesce(c.price_list_id, g.price_list_id)),
    'discount_pct', greatest(c.discount_pct, coalesce(g.discount_pct, 0)),
    'group', g.name,
    'credit_allowed', c.credit_allowed,
    'credit_limit', c.credit_limit,
    'payment_days', c.payment_days,
    'owed', public.customer_due(c.id),
    -- How much more they may put on the slate right now. Null when no limit is set.
    'credit_left', case when c.credit_limit > 0
                        then greatest(c.credit_limit - public.customer_due(c.id), 0) end
  ) into v_out
  from public.customers c
  left join public.customer_groups g on g.id = c.group_id
  where c.shop_id = (select public.current_shop_id()) and c.phone = p_phone;
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- The till can now put part of a sale, or all of it, on the slate
-- ---------------------------------------------------------------------------

-- Same function as P3's, with the payment step rewritten: 'due' puts the whole total on
-- the slate, `p_due_amount` splits it, and the credit limit is checked against what the
-- customer will owe AFTER this sale. Everything above the payment step is unchanged.
--
-- The new argument has a default, so `create or replace` would leave the twelve-argument
-- version in place and every call would then be ambiguous. The old one goes first.
drop function if exists public.complete_sale(uuid, jsonb, text, numeric, uuid, text,
                                             numeric, text, jsonb, uuid, uuid, uuid);
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
  p_due_amount       numeric default 0
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
                            payment_method, discount_type_id, transaction_category_id)
  values (v_sale_id, v_shop.id, p_branch_id, v_invoice, v_staff.id, 0, 0,
          p_payment_method, p_discount_type_id, p_category_id);

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
          and status = 'in_stock'
          and location_id in (select id from public.stock_locations where branch_id = p_branch_id);
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    elsif v_qty <= 0 then
      raise exception 'BAD_QTY:%', v_product.name;
    end if;

    -- A service has no stock to take. It still goes on the bill.
    if v_product.is_inventory then
      select qty into v_stock from public.branch_stock
        where product_id = v_product.id and location_id = v_location for update;
      if v_stock is null then
        insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
        values (v_product.id, v_location, v_shop.id, p_branch_id, 0)
        on conflict (product_id, location_id) do nothing;
        v_stock := 0;
      end if;
      if v_stock < v_qty then raise exception 'OUT_OF_STOCK:%', v_product.name; end if;
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

  -- ---- Who is buying, before any question of credit -----------------------
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

  -- What is being handed over now is checked against the PAID part, not the total:
  -- a customer paying 30,000 of a 72,000 laptop is not short.
  if p_payment_method = 'cash' then
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
    due_amount = v_due, paid_amount = v_paid
  where id = v_sale_id;

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
    'customer_owes', case when v_customer is null then null else public.customer_due(v_customer) end,
    'items', v_lines);
end; $$;

-- ---------------------------------------------------------------------------
-- P9's two functions read the name column that has just gone
-- ---------------------------------------------------------------------------

create or replace function public.sale_history(
  p_branch_id uuid default null,
  p_query     text default null,
  p_from      date default null,
  p_to        date default null,
  p_staff_id  uuid default null,
  p_method    text default null,
  p_status    text default null,
  p_limit     integer default 50
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_out   jsonb;
  v_q     text := nullif(btrim(coalesce(p_query, '')), '');
  v_from  date := p_from;
  v_to    date := p_to;
  v_staff uuid := p_staff_id;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  if not public.is_manager() then
    v_staff := v_me.id;
    v_from := public.dhaka_today();
    v_to := public.dhaka_today();
  end if;

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'id', s.id, 'invoice_no', s.invoice_no, 'created_at', s.created_at,
      'branch', b.name, 'branch_id', s.branch_id, 'staff', st.name,
      'total', s.total, 'discount_amount', s.discount_amount,
      'payment_method', s.payment_method, 'status', s.status,
      'approval_status', s.approval_status,
      'due_amount', s.due_amount,
      'customer_phone', c.phone, 'customer_name', c.name_text,
      'item_count', (select coalesce(sum(i.qty), 0) from public.sale_items i where i.sale_id = s.id),
      'summary', (select string_agg(i.name, ', ' order by i.name)
                  from public.sale_items i where i.sale_id = s.id),
      'returned', (select coalesce(sum(ri.qty), 0) from public.sale_return_items ri
                   join public.sale_returns r on r.id = ri.return_id
                   join public.sale_items i2 on i2.id = ri.sale_item_id
                   where i2.sale_id = s.id and r.approval_status <> 'cancelled')
    ) as x
    from public.sales s
    join public.branches b on b.id = s.branch_id
    join public.staff st on st.id = s.staff_id
    left join public.customers c on c.id = s.customer_id
    where s.shop_id = v_me.shop_id
      and s.branch_id = any(select unnest(public.current_branch_ids()))
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and (v_staff is null or s.staff_id = v_staff)
      and (v_from is null or (s.created_at at time zone 'Asia/Dhaka')::date >= v_from)
      and (v_to is null or (s.created_at at time zone 'Asia/Dhaka')::date <= v_to)
      and (p_method is null or s.payment_method = p_method)
      and (p_status is null or s.status = p_status)
      and (v_q is null
           or s.invoice_no ilike '%' || v_q || '%'
           or c.phone like '%' || v_q || '%'
           or coalesce(c.name_text, '') ilike '%' || v_q || '%'
           or exists (select 1 from public.sale_items i
                      where i.sale_id = s.id and i.name ilike '%' || v_q || '%')
           or exists (select 1 from public.sale_items i
                      join public.sale_item_serials sis on sis.sale_item_id = i.id
                      join public.serials se on se.id = sis.serial_id
                      where i.sale_id = s.id and se.serial ilike '%' || v_q || '%'))
    order by s.created_at desc
    limit greatest(coalesce(p_limit, 50), 1)
  ) q;
  return v_out;
end; $$;

-- sale_detail() only needs the one line changing, so it is redefined from P9's version
-- with the name column corrected and the due figures added.
create or replace function public.sale_detail(p_sale_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_sale public.sales; v_out jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  select * into v_sale from public.sales where id = p_sale_id and shop_id = v_me.shop_id;
  if not found then raise exception 'SALE_NOT_FOUND'; end if;
  if not public.can_use_branch(v_sale.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if not public.is_manager() and v_sale.staff_id <> v_me.id then raise exception 'NOT_YOUR_SALE'; end if;

  select jsonb_build_object(
    'id', s.id, 'invoice_no', s.invoice_no, 'created_at', s.created_at,
    'branch', b.name, 'branch_id', s.branch_id, 'branch_address', b.address,
    'branch_phone', b.phone,
    'shop_name', sh.name, 'receipt_footer', sh.receipt_footer, 'bin_vat', sh.bin_vat,
    'staff', st.name,
    'subtotal', s.subtotal, 'discount_pct', s.discount_pct, 'discount_amount', s.discount_amount,
    'vat_amount', s.vat_amount, 'charges_amount', s.charges_amount, 'total', s.total,
    'payment_method', s.payment_method, 'cash_received', s.cash_received,
    'change_given', s.change_given, 'payment_ref', s.payment_ref,
    'paid_amount', s.paid_amount, 'due_amount', s.due_amount,
    'status', s.status, 'approval_status', s.approval_status,
    'void_reason', s.void_reason, 'refund_method', s.refund_method,
    'customer_id', s.customer_id,
    'customer_phone', c.phone, 'customer_name', c.name_text,
    'same_day', (s.created_at at time zone 'Asia/Dhaka')::date = public.dhaka_today(),
    'days_old', public.dhaka_today() - (s.created_at at time zone 'Asia/Dhaka')::date,
    'return_days', sh.return_days,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', i.id, 'product_id', i.product_id, 'name', i.name, 'qty', i.qty,
                'unit_price', i.unit_price, 'line_total', i.line_total,
                'vat_pct', i.vat_pct, 'vat_amount', i.vat_amount,
                'vat_inclusive', i.vat_inclusive, 'is_gift', i.is_gift,
                'warranty_until', i.warranty_until,
                'returned_qty', public.returned_qty(i.id),
                'refund_each', public.refund_for(i.id, 1),
                'is_serial', p.is_serial,
                'serials', (select coalesce(jsonb_agg(jsonb_build_object(
                              'id', se.id, 'serial', se.serial, 'status', se.status)), '[]'::jsonb)
                            from public.sale_item_serials sis
                            join public.serials se on se.id = sis.serial_id
                            where sis.sale_item_id = i.id)
              ) order by i.name), '[]'::jsonb)
              from public.sale_items i join public.products p on p.id = i.product_id
              where i.sale_id = s.id),
    'returns', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', r.id, 'return_no', r.return_no, 'created_at', r.created_at,
                  'branch', rb.name, 'total', r.total, 'reason', r.reason,
                  'refund_method', r.refund_method,
                  'approval_status', r.approval_status) order by r.created_at), '[]'::jsonb)
                from public.sale_returns r join public.branches rb on rb.id = r.branch_id
                where r.sale_id = s.id)
  ) into v_out
  from public.sales s
  join public.branches b on b.id = s.branch_id
  join public.shops sh on sh.id = s.shop_id
  join public.staff st on st.id = s.staff_id
  left join public.customers c on c.id = s.customer_id
  where s.id = p_sale_id;

  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- Cash collected on a due belongs to the drawer too
-- ---------------------------------------------------------------------------

create or replace function public.expected_cash(p_shift_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(s.opening_cash, 0)
       + coalesce((select sum(coalesce(sa.cash_received, sa.total) - coalesce(sa.change_given, 0))
                   from public.sales sa
                   where sa.shift_id = s.id and sa.payment_method = 'cash'
                     and sa.status = 'completed'), 0)
       -- A sale paid partly in cash and partly on due only put the paid part in the
       -- drawer; cash_received already reflects that, so nothing more is needed here.
       + coalesce((select sum(cp.amount) from public.customer_payments cp
                   where cp.shift_id = s.id and cp.method = 'cash'), 0)
       - coalesce((select sum(r.total) from public.sale_returns r
                   where r.shift_id = s.id and r.refund_method = 'cash'
                     and r.approval_status <> 'cancelled'), 0)
       + coalesce((select sum(case when cm.direction = 'in' then cm.amount else -cm.amount end)
                   from public.cash_movements cm where cm.shift_id = s.id), 0)
  from public.shifts s where s.id = p_shift_id;
$$;

-- ---------------------------------------------------------------------------
-- P6's opening-balance function read the name column that has just gone
-- ---------------------------------------------------------------------------

create or replace function public.set_opening_balance(
  p_party_kind text,
  p_party_id   uuid,
  p_amount     numeric,
  p_as_of      date default null,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_name text; v_when date := coalesce(p_as_of, public.dhaka_today());
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  if p_party_kind not in ('customer', 'supplier') then raise exception 'BAD_PARTY_KIND:%', p_party_kind; end if;
  if p_amount is null then raise exception 'BAD_PAYMENT_AMOUNT'; end if;
  if v_when > public.dhaka_today() then raise exception 'OPENING_DATE_IN_FUTURE'; end if;

  if p_party_kind = 'supplier' then
    select name into v_name from public.suppliers where id = p_party_id and shop_id = v_me.shop_id;
    if v_name is null then raise exception 'SUPPLIER_NOT_FOUND'; end if;
    insert into public.opening_balances (shop_id, party_kind, supplier_id, amount, as_of, source, note)
    values (v_me.shop_id, 'supplier', p_party_id, p_amount, v_when, 'manual', p_note)
    on conflict (supplier_id) do update
      set amount = excluded.amount, as_of = excluded.as_of, note = excluded.note;
  else
    select coalesce(name_text, phone) into v_name from public.customers
      where id = p_party_id and shop_id = v_me.shop_id;
    if v_name is null then raise exception 'CUSTOMER_NOT_FOUND'; end if;
    insert into public.opening_balances (shop_id, party_kind, customer_id, amount, as_of, source, note)
    values (v_me.shop_id, 'customer', p_party_id, p_amount, v_when, 'manual', p_note)
    on conflict (customer_id) do update
      set amount = excluded.amount, as_of = excluded.as_of, note = excluded.note;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'opening_balance_set', p_party_kind, p_party_id,
          jsonb_build_object('name', v_name, 'amount', p_amount, 'as_of', v_when, 'note', p_note));

  return jsonb_build_object('name', v_name, 'amount', p_amount, 'as_of', v_when);
end; $$;

-- ---------------------------------------------------------------------------
-- Turning credit sales on makes "on due" selectable at the till
-- ---------------------------------------------------------------------------

/**
 * Same as P2's, with one addition: switching credit sales on also enables the 'due'
 * payment method, and switching it off disables it again.
 *
 * Without this the owner flips the switch, nothing happens at the till, and the next
 * thing they do is ring up and ask why. The feature switch means "this shop sells on
 * due"; the payment method is how that is done, so they belong together.
 */
create or replace function public.set_feature(p_feature text, p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;

  insert into public.shop_features (shop_id, feature, enabled)
  values (v_me.shop_id, p_feature, p_enabled)
  on conflict (shop_id, feature) do update set enabled = excluded.enabled, updated_at = now();

  if p_feature = 'credit_sales' then
    update public.payment_methods set enabled = p_enabled
      where shop_id = v_me.shop_id and key = 'due';
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id, 'feature_changed', 'shop_feature',
          jsonb_build_object('feature', p_feature, 'to', p_enabled));
end; $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.customer_groups   enable row level security;
alter table public.customer_payments enable row level security;

create policy customer_groups_read on public.customer_groups for select to authenticated
  using (shop_id = (select public.current_shop_id()));
-- A cashier takes payments, so they see the receipts they wrote; what a customer owes
-- in total comes through customer_due(), which is a function and not a column.
create policy customer_payments_read on public.customer_payments for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.customer_due(uuid) from public, anon;
revoke execute on function public.customer_aging(uuid) from public, anon;
revoke execute on function public.save_customer(uuid, jsonb) from public, anon;
revoke execute on function public.save_customer_group(uuid, jsonb) from public, anon;
revoke execute on function public.collect_payment(uuid, uuid, numeric, text, text, text, uuid) from public, anon;
revoke execute on function public.due_list(uuid) from public, anon;
revoke execute on function public.customer_statement(uuid) from public, anon;
revoke execute on function public.customer_list(text, integer) from public, anon;

grant execute on function public.customer_due(uuid) to authenticated;
grant execute on function public.customer_aging(uuid) to authenticated;
grant execute on function public.save_customer(uuid, jsonb) to authenticated;
grant execute on function public.save_customer_group(uuid, jsonb) to authenticated;
grant execute on function public.collect_payment(uuid, uuid, numeric, text, text, text, uuid) to authenticated;
grant execute on function public.due_list(uuid) to authenticated;
grant execute on function public.customer_statement(uuid) to authenticated;
grant execute on function public.customer_list(text, integer) to authenticated;
grant execute on function public.complete_sale(uuid, jsonb, text, numeric, uuid, text, numeric, text, jsonb, uuid, uuid, uuid, numeric) to authenticated;
