-- P0 — real logins, and closing two holes the first migration left open.
--
-- 1. A manager could raise their own discount limit to 100%, promote themselves to
--    owner, and deactivate the owner — none of it logged. The `authenticated` UPDATE
--    grant on staff included role, discount_limit_pct and active. Now it is name only,
--    and those three change through set_staff_access(): owners only, never your own
--    row, always logged.
-- 2. A failed manager PIN left no trace at all. Because complete_sale() raised
--    MANAGER_PIN_INVALID, any audit row written before the raise was rolled back by it,
--    so failures were structurally impossible to log where the check lived. PIN checking
--    moves to verify_manager_pin(), which runs in its own transaction, RETURNS a result
--    instead of raising, records every attempt, and locks an approver out after 5 wrong
--    tries in 10 minutes. complete_sale() now consumes a short-lived approval instead of
--    taking a PIN, so the counter learns a PIN is wrong before the customer has waited
--    through the whole sale.

-- ---------------------------------------------------------------------------
-- Manager PIN attempts: the owner's record of who tried to approve what
-- ---------------------------------------------------------------------------

create table public.pin_attempts (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  approver_id  uuid not null references public.staff(id) on delete cascade,  -- whose PIN was tried
  staff_id     uuid not null references public.staff(id) on delete cascade,  -- who typed it
  ok           boolean not null,
  used_at      timestamptz,                   -- set when a sale consumes the approval
  created_at   timestamptz not null default now()
);
create index pin_attempts_approver_idx on public.pin_attempts(approver_id, created_at desc);
create index pin_attempts_shop_idx on public.pin_attempts(shop_id, created_at desc);

alter table public.pin_attempts enable row level security;

-- Only owners and managers see PIN attempts. A cashier must not learn that an
-- approver is one wrong try from being locked out.
create policy pin_attempts_read on public.pin_attempts for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

-- No insert/update policy: rows appear only through verify_manager_pin().

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Does the signed-in person already have an approval PIN? The hash itself is never
-- readable, so the "Set" / "Change" wording on the PIN screen needs this.
create or replace function public.has_pin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select pin_hash is not null from public.staff
                   where user_id = auth.uid() and active limit 1), false);
$$;

-- Everything the app needs about the signed-in person, in one round trip.
-- `select *` on staff fails for authenticated users (the table-level grant is revoked
-- so pin_hash stays unreadable), so without this every caller has to remember the exact
-- column list or get "permission denied for table staff".
-- Returns null when the login has no staff row — that is the "not linked to a shop"
-- case, and it is deliberately different from "not signed in".
create or replace function public.current_staff() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'staff_id', s.id,
    'shop_id', s.shop_id,
    'name', s.name,
    'role', s.role,
    'discount_limit_pct', s.discount_limit_pct,
    'shop_name', sh.name,
    'has_pin', s.pin_hash is not null
  )
  from public.staff s
  join public.shops sh on sh.id = s.shop_id
  where s.user_id = auth.uid() and s.active
  limit 1;
$$;

-- The owners and managers a cashier can ask for an approval, so the counter can name
-- the approver instead of matching the PIN against whoever happens to come first.
create or replace function public.list_approvers() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'role', role) order by name), '[]'::jsonb)
  from public.staff
  where shop_id = (select public.current_shop_id())
    and active and role in ('owner', 'manager') and pin_hash is not null;
$$;

-- ---------------------------------------------------------------------------
-- verify_manager_pin: the only place a PIN is checked
-- ---------------------------------------------------------------------------
-- RETURNS a result, never raises, for a wrong PIN or a lockout. That is the whole
-- point: a raise would roll back the attempt row and make failures invisible again.
-- On success returns an approval id that complete_sale() consumes once, within 10
-- minutes, so the PIN itself never travels with the sale.

create or replace function public.verify_manager_pin(p_approver_id uuid, p_pin text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_staff     public.staff;
  v_approver  public.staff;
  v_fails     integer;
  v_ok        boolean;
  v_id        uuid;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  select * into v_approver from public.staff
    where id = p_approver_id and shop_id = v_staff.shop_id and active
      and role in ('owner', 'manager');
  if not found then raise exception 'APPROVER_NOT_FOUND'; end if;
  if v_approver.pin_hash is null then raise exception 'APPROVER_HAS_NO_PIN:%', v_approver.name; end if;

  -- 5 wrong tries in 10 minutes locks this approver out.
  select count(*) into v_fails from public.pin_attempts
    where approver_id = p_approver_id and not ok and created_at > now() - interval '10 minutes';

  if v_fails >= 5 then
    insert into public.pin_attempts (shop_id, approver_id, staff_id, ok)
    values (v_staff.shop_id, p_approver_id, v_staff.id, false);
    insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
    values (v_staff.shop_id, v_staff.id, 'pin_locked_out', 'staff', p_approver_id,
            jsonb_build_object('approver', v_approver.name, 'fails_in_10_min', v_fails + 1));
    return jsonb_build_object('ok', false, 'locked', true, 'tries_left', 0);
  end if;

  v_ok := (p_pin is not null and p_pin <> '' and v_approver.pin_hash = crypt(p_pin, v_approver.pin_hash));

  insert into public.pin_attempts (shop_id, approver_id, staff_id, ok)
  values (v_staff.shop_id, p_approver_id, v_staff.id, v_ok)
  returning id into v_id;

  if not v_ok then
    insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
    values (v_staff.shop_id, v_staff.id, 'pin_failed', 'staff', p_approver_id,
            jsonb_build_object('approver', v_approver.name, 'fails_in_10_min', v_fails + 1));
    return jsonb_build_object('ok', false, 'locked', false, 'tries_left', 4 - v_fails);
  end if;

  return jsonb_build_object('ok', true, 'approval_id', v_id,
                            'approver_id', p_approver_id, 'approver_name', v_approver.name);
end; $$;

-- ---------------------------------------------------------------------------
-- set_staff_access: owners only, never your own row, always logged
-- ---------------------------------------------------------------------------

create or replace function public.set_staff_access(
  p_staff_id            uuid,
  p_role                text default null,
  p_discount_limit_pct  numeric default null,
  p_active              boolean default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_target  public.staff;
  v_owners  integer;
  v_new     public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;

  select * into v_target from public.staff where id = p_staff_id and shop_id = v_me.shop_id;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;

  -- An owner cannot change their own role, limit or active flag. Otherwise "owners only"
  -- is not a control, just a longer path to the same place.
  if v_target.id = v_me.id then raise exception 'NO_SELF_EDIT'; end if;

  if p_role is not null and p_role not in ('owner', 'manager', 'cashier') then
    raise exception 'BAD_ROLE:%', p_role;
  end if;
  if p_discount_limit_pct is not null and (p_discount_limit_pct < 0 or p_discount_limit_pct > 100) then
    raise exception 'BAD_LIMIT:%', p_discount_limit_pct;
  end if;

  -- Never leave the shop without an active owner, or nobody can administer it.
  if (p_active is false or p_role in ('manager', 'cashier')) and v_target.role = 'owner' then
    select count(*) into v_owners from public.staff
      where shop_id = v_me.shop_id and role = 'owner' and active and id <> v_target.id;
    if v_owners = 0 then raise exception 'LAST_OWNER'; end if;
  end if;

  update public.staff set
    role = coalesce(p_role, role),
    discount_limit_pct = coalesce(p_discount_limit_pct, discount_limit_pct),
    active = coalesce(p_active, active)
  where id = p_staff_id
  returning * into v_new;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'staff_access_changed', 'staff', p_staff_id,
          jsonb_build_object(
            'name', v_target.name,
            'from', jsonb_build_object('role', v_target.role,
                                       'discount_limit_pct', v_target.discount_limit_pct,
                                       'active', v_target.active),
            'to',   jsonb_build_object('role', v_new.role,
                                       'discount_limit_pct', v_new.discount_limit_pct,
                                       'active', v_new.active)));

  return jsonb_build_object('staff_id', p_staff_id, 'role', v_new.role,
                            'discount_limit_pct', v_new.discount_limit_pct, 'active', v_new.active);
end; $$;

-- Close the escalation path: name is the only column the app may write directly.
revoke update on public.staff from authenticated;
grant update (name) on public.staff to authenticated;

-- ---------------------------------------------------------------------------
-- set_pin: reject guessable PINs, and log that a PIN was set
-- ---------------------------------------------------------------------------

create or replace function public.set_pin(p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_me public.staff;
begin
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'BAD_PIN'; end if;
  -- All one digit (0000, 1111…) or a simple run up or down (1234, 54321…). The whole
  -- discount control rests on a cashier not being able to guess this.
  if p_pin ~ '^(.)\1*$'
     or position(p_pin in '01234567890') > 0
     or position(p_pin in '09876543210') > 0 then
    raise exception 'WEAK_PIN';
  end if;

  select * into v_me from public.staff
    where user_id = auth.uid() and active and role in ('owner', 'manager');
  if not found then raise exception 'NOT_MANAGER'; end if;

  update public.staff set pin_hash = crypt(p_pin, gen_salt('bf')) where id = v_me.id;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, case when v_me.pin_hash is null then 'pin_set' else 'pin_changed' end,
          'staff', v_me.id, jsonb_build_object('name', v_me.name));
end; $$;

-- ---------------------------------------------------------------------------
-- complete_sale: consumes an approval instead of taking a PIN
-- ---------------------------------------------------------------------------

drop function if exists public.complete_sale(jsonb, text, numeric, text, text, numeric, text);

create or replace function public.complete_sale(
  p_items           jsonb,
  p_payment_method  text,
  p_discount_pct    numeric default 0,
  p_approval_id     uuid default null,
  p_customer_phone  text default null,
  p_cash_received   numeric default null,
  p_payment_ref     text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_staff     public.staff;
  v_shop      public.shops;
  v_sale_id   uuid := gen_random_uuid();
  v_invoice   text;
  v_item      jsonb;
  v_product   public.products;
  v_qty       integer;
  v_serials   uuid[];
  v_found     integer;
  v_item_id   uuid;
  v_subtotal  numeric(12,2) := 0;
  v_pct       numeric(5,2) := coalesce(p_discount_pct, 0);
  v_discount  numeric(12,2);
  v_total     numeric(12,2);
  v_approver  uuid;
  v_customer  uuid;
  v_shift     uuid;
  v_change    numeric(12,2);
  v_lines     jsonb := '[]'::jsonb;
  v_today     date := public.dhaka_today();
  v_until     date;
begin
  select * into v_staff from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_SALE';
  end if;
  if p_payment_method not in ('cash', 'bkash', 'nagad', 'card') then
    raise exception 'BAD_PAYMENT_METHOD';
  end if;
  if v_pct < 0 or v_pct > 100 then raise exception 'BAD_DISCOUNT'; end if;

  -- A discount over this person's limit needs an approval from verify_manager_pin():
  -- unused, for this shop, and less than 10 minutes old. Claim it before anything else
  -- so a sale cannot be built on an approval that is about to be rejected.
  if v_pct > v_staff.discount_limit_pct then
    if p_approval_id is null then raise exception 'MANAGER_PIN_REQUIRED'; end if;
    update public.pin_attempts set used_at = now()
      where id = p_approval_id and shop_id = v_staff.shop_id and ok
        and used_at is null and created_at > now() - interval '10 minutes'
      returning approver_id into v_approver;
    if v_approver is null then raise exception 'APPROVAL_NOT_VALID'; end if;
  end if;

  -- Lock the shop row to hand out the next invoice number safely.
  select * into v_shop from public.shops where id = v_staff.shop_id for update;
  v_invoice := v_shop.invoice_prefix || to_char(v_today, 'YYYY') || lpad(v_shop.next_invoice::text, 6, '0');
  update public.shops set next_invoice = next_invoice + 1 where id = v_shop.id;

  insert into public.sales (id, shop_id, invoice_no, staff_id, subtotal, total, payment_method)
  values (v_sale_id, v_shop.id, v_invoice, v_staff.id, 0, 0, p_payment_method);

  -- Sorted by product id so concurrent sales take row locks in the same order and
  -- cannot deadlock on two products in opposite sequence (p_items order is the
  -- browser's choice, so it cannot be trusted to be consistent).
  for v_item in
    select e from jsonb_array_elements(p_items) e order by (e->>'product_id')
  loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = v_shop.id and active
      for update;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

    v_qty := coalesce((v_item->>'qty')::integer, 0);
    v_serials := coalesce(array(select jsonb_array_elements_text(coalesce(v_item->'serial_ids', '[]'::jsonb))::uuid), '{}');

    if v_product.is_serial then
      v_qty := coalesce(array_length(v_serials, 1), 0);
      if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
      update public.serials set status = 'sold', sale_id = v_sale_id
        where id = any(v_serials) and product_id = v_product.id and shop_id = v_shop.id and status = 'in_stock';
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    elsif v_qty <= 0 then
      raise exception 'BAD_QTY:%', v_product.name;
    end if;

    if v_product.stock < v_qty then raise exception 'OUT_OF_STOCK:%', v_product.name; end if;
    update public.products set stock = stock - v_qty where id = v_product.id;

    v_until := case when v_product.warranty_months > 0
                    then (v_today + make_interval(months => v_product.warranty_months))::date end;
    v_item_id := gen_random_uuid();
    insert into public.sale_items (id, sale_id, shop_id, product_id, name, qty, unit_price, line_total, warranty_months, warranty_until)
    values (v_item_id, v_sale_id, v_shop.id, v_product.id, v_product.name, v_qty, v_product.price,
            v_product.price * v_qty, v_product.warranty_months, v_until);
    insert into public.sale_item_serials (sale_item_id, serial_id) select v_item_id, unnest(v_serials);
    insert into public.stock_movements (shop_id, product_id, qty_change, reason, ref_id, staff_id)
    values (v_shop.id, v_product.id, -v_qty, 'sale', v_sale_id, v_staff.id);

    v_subtotal := v_subtotal + v_product.price * v_qty;
    v_lines := v_lines || jsonb_build_object(
      'name', v_product.name, 'qty', v_qty, 'unit_price', v_product.price,
      'line_total', v_product.price * v_qty, 'warranty_until', v_until,
      'serials', (select coalesce(jsonb_agg(serial), '[]'::jsonb) from public.serials where id = any(v_serials)));
  end loop;

  v_discount := round(v_subtotal * v_pct / 100);
  v_total := v_subtotal - v_discount;

  if v_approver is not null then
    insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
    values (v_shop.id, v_staff.id, 'discount_approved', 'sale', v_sale_id,
            jsonb_build_object('pct', v_pct, 'amount', v_discount, 'approved_by', v_approver,
                               'approved_by_name', (select name from public.staff where id = v_approver),
                               'invoice', v_invoice));
  end if;

  if p_payment_method = 'cash' then
    if p_cash_received is null or p_cash_received < v_total then raise exception 'CASH_SHORT'; end if;
    v_change := p_cash_received - v_total;
  else
    if p_payment_ref is null or length(trim(p_payment_ref)) < 4 then raise exception 'PAYMENT_REF_REQUIRED'; end if;
  end if;

  if p_customer_phone is not null and p_customer_phone <> '' then
    if p_customer_phone !~ '^01[0-9]{9}$' then raise exception 'BAD_PHONE'; end if;
    insert into public.customers (shop_id, phone) values (v_shop.id, p_customer_phone)
      on conflict (shop_id, phone) do update set phone = excluded.phone
      returning id into v_customer;
  end if;

  select id into v_shift from public.shifts
    where staff_id = v_staff.id and closed_at is null order by opened_at desc limit 1;

  update public.sales set
    subtotal = v_subtotal, discount_pct = v_pct, discount_amount = v_discount, total = v_total,
    cash_received = case when p_payment_method = 'cash' then p_cash_received end,
    change_given = v_change, payment_ref = nullif(trim(coalesce(p_payment_ref, '')), ''),
    discount_approved_by = v_approver, customer_id = v_customer, shift_id = v_shift
  where id = v_sale_id;

  return jsonb_build_object(
    'id', v_sale_id, 'invoice_no', v_invoice, 'created_at', now(),
    'staff_name', v_staff.name, 'shop_name', v_shop.name, 'shop_address', v_shop.address,
    'subtotal', v_subtotal, 'discount_pct', v_pct, 'discount_amount', v_discount, 'total', v_total,
    'payment_method', p_payment_method, 'cash_received', p_cash_received, 'change_given', v_change,
    'payment_ref', p_payment_ref, 'customer_phone', nullif(p_customer_phone, ''), 'items', v_lines);
end; $$;

-- ---------------------------------------------------------------------------
-- receive_stock: reject blank serials
-- ---------------------------------------------------------------------------

create or replace function public.receive_stock(
  p_product_id  uuid,
  p_qty         integer default null,
  p_serials     text[] default null,
  p_unit_cost   numeric default null,
  p_note        text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_staff    public.staff;
  v_product  public.products;
  v_qty      integer;
  v_clean    text[];
begin
  select * into v_staff from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  select * into v_product from public.products where id = p_product_id and shop_id = v_staff.shop_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

  if v_product.is_serial then
    -- A trailing comma in a pasted list used to create a serial of ''.
    v_clean := array(select trim(s) from unnest(coalesce(p_serials, '{}')) s where trim(s) <> '');
    v_qty := coalesce(array_length(v_clean, 1), 0);
    if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
    insert into public.serials (shop_id, product_id, serial)
      select v_staff.shop_id, v_product.id, s from unnest(v_clean) s;
  else
    v_qty := coalesce(p_qty, 0);
    if v_qty <= 0 then raise exception 'BAD_QTY:%', v_product.name; end if;
  end if;

  update public.products set stock = stock + v_qty where id = v_product.id;
  insert into public.stock_movements (shop_id, product_id, qty_change, reason, staff_id, note)
  values (v_staff.shop_id, v_product.id, v_qty, 'purchase', v_staff.id, p_note);

  if p_unit_cost is not null then
    insert into public.product_costs (product_id, shop_id, cost) values (v_product.id, v_staff.shop_id, p_unit_cost)
      on conflict (product_id) do update set cost = excluded.cost, updated_at = now();
  end if;
  return v_qty;
end; $$;

-- ---------------------------------------------------------------------------
-- Wrap the RLS helpers in a subselect
-- ---------------------------------------------------------------------------
-- Unwrapped, `shop_id = public.current_shop_id()` re-runs the security definer lookup
-- for every candidate row. Harmless on 11 products; not harmless on the owner dashboard
-- scanning a year of sales. Mechanical to do now, and much cheaper before P1 adds
-- branch_id to all the same policies.

drop policy shop_read on public.shops;
drop policy staff_read on public.staff;
drop policy categories_read on public.categories;
drop policy products_read on public.products;
drop policy serials_read on public.serials;
drop policy customers_read on public.customers;
drop policy sales_read on public.sales;
drop policy sale_items_read on public.sale_items;
drop policy sale_item_serials_read on public.sale_item_serials;
drop policy shifts_read on public.shifts;
drop policy costs_read on public.product_costs;
drop policy movements_read on public.stock_movements;
drop policy audit_read on public.audit_log;
drop policy categories_write on public.categories;
drop policy products_write on public.products;
drop policy costs_write on public.product_costs;
drop policy staff_write on public.staff;

create policy shop_read on public.shops for select to authenticated
  using (id = (select public.current_shop_id()));
create policy staff_read on public.staff for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy categories_read on public.categories for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy products_read on public.products for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy serials_read on public.serials for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy customers_read on public.customers for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy sales_read on public.sales for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy sale_items_read on public.sale_items for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy sale_item_serials_read on public.sale_item_serials for select to authenticated
  using (exists (select 1 from public.sale_items i
                 where i.id = sale_item_id and i.shop_id = (select public.current_shop_id())));
create policy shifts_read on public.shifts for select to authenticated
  using (shop_id = (select public.current_shop_id()));

create policy costs_read on public.product_costs for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy movements_read on public.stock_movements for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy audit_read on public.audit_log for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

create policy categories_write on public.categories for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy products_write on public.products for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy costs_write on public.product_costs for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy staff_write on public.staff for update to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.complete_sale(jsonb, text, numeric, uuid, text, numeric, text) from public, anon;
revoke execute on function public.verify_manager_pin(uuid, text) from public, anon;
revoke execute on function public.set_staff_access(uuid, text, numeric, boolean) from public, anon;
revoke execute on function public.current_staff() from public, anon;
revoke execute on function public.list_approvers() from public, anon;
revoke execute on function public.has_pin() from public, anon;

grant execute on function public.complete_sale(jsonb, text, numeric, uuid, text, numeric, text) to authenticated;
grant execute on function public.verify_manager_pin(uuid, text) to authenticated;
grant execute on function public.set_staff_access(uuid, text, numeric, boolean) to authenticated;
grant execute on function public.current_staff() to authenticated;
grant execute on function public.list_approvers() to authenticated;
grant execute on function public.has_pin() to authenticated;
