-- CSL POS — first migration
-- Multi-shop from day one: every row belongs to a shop, and row-level security
-- keeps each shop's data separate. Money is stored in taka with 2 decimals.
-- Rules that protect the owner (prices, discount limits, stock) live in the
-- database functions at the bottom, so the browser can't bypass them.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.shops (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  address         text,
  phone           text,
  invoice_prefix  text not null default 'INV',
  next_invoice    integer not null default 1 check (next_invoice > 0),
  created_at      timestamptz not null default now()
);

-- One row per person who works in a shop. user_id links to a Supabase login.
create table public.staff (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id) on delete cascade,
  user_id             uuid unique references auth.users(id) on delete set null,
  name                text not null,
  role                text not null check (role in ('owner', 'manager', 'cashier')),
  discount_limit_pct  numeric(5,2) not null default 5 check (discount_limit_pct between 0 and 100),
  pin_hash            text,               -- manager approval PIN, hashed; never readable by the app
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);
create index staff_shop_idx on public.staff(shop_id);

create table public.categories (
  id       uuid primary key default gen_random_uuid(),
  shop_id  uuid not null references public.shops(id) on delete cascade,
  name     text not null,
  sort     integer not null default 0,
  unique (shop_id, name)
);

create table public.products (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  category_id      uuid references public.categories(id) on delete set null,
  code             text not null,          -- shop's own SKU; also what a barcode scan sends
  barcode          text,                   -- manufacturer barcode, if different from code
  name             text not null,
  brand            text,
  price            numeric(12,2) not null check (price >= 0),   -- selling price set by owner/manager
  warranty_months  integer not null default 0 check (warranty_months >= 0),
  is_serial        boolean not null default false,               -- laptops, RAM, SSDs, routers...
  stock            integer not null default 0 check (stock >= 0),
  reorder_level    integer not null default 0 check (reorder_level >= 0),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (shop_id, code)
);
create index products_shop_idx on public.products(shop_id);
create index products_barcode_idx on public.products(shop_id, barcode);

-- Cost price lives in its own table so counter staff can never read it.
create table public.product_costs (
  product_id  uuid primary key references public.products(id) on delete cascade,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  cost        numeric(12,2) not null check (cost >= 0),
  updated_at  timestamptz not null default now()
);

create table public.serials (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  product_id   uuid not null references public.products(id) on delete cascade,
  serial       text not null,
  status       text not null default 'in_stock' check (status in ('in_stock', 'sold', 'returned', 'rma')),
  sale_id      uuid,
  received_at  timestamptz not null default now(),
  unique (shop_id, serial)
);
create index serials_product_idx on public.serials(product_id, status);

create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  phone       text not null check (phone ~ '^01[0-9]{9}$'),
  name        text,
  created_at  timestamptz not null default now(),
  unique (shop_id, phone)
);

create table public.shifts (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  staff_id       uuid not null references public.staff(id),
  opened_at      timestamptz not null default now(),
  opening_cash   numeric(12,2) not null default 0,
  closed_at      timestamptz,
  expected_cash  numeric(12,2),
  counted_cash   numeric(12,2),
  note           text
);
create index shifts_open_idx on public.shifts(staff_id) where closed_at is null;

create table public.sales (
  id                    uuid primary key default gen_random_uuid(),
  shop_id               uuid not null references public.shops(id) on delete cascade,
  invoice_no            text not null,
  staff_id              uuid not null references public.staff(id),
  shift_id              uuid references public.shifts(id),
  customer_id           uuid references public.customers(id),
  subtotal              numeric(12,2) not null,
  discount_pct          numeric(5,2) not null default 0,
  discount_amount       numeric(12,2) not null default 0,
  total                 numeric(12,2) not null,
  payment_method        text not null check (payment_method in ('cash', 'bkash', 'nagad', 'card')),
  cash_received         numeric(12,2),
  change_given          numeric(12,2),
  payment_ref           text,
  discount_approved_by  uuid references public.staff(id),
  status                text not null default 'completed' check (status in ('completed', 'void')),
  created_at            timestamptz not null default now(),
  unique (shop_id, invoice_no)
);
create index sales_shop_time_idx on public.sales(shop_id, created_at desc);

alter table public.serials
  add constraint serials_sale_fk foreign key (sale_id) references public.sales(id) on delete set null;

create table public.sale_items (
  id               uuid primary key default gen_random_uuid(),
  sale_id          uuid not null references public.sales(id) on delete cascade,
  shop_id          uuid not null references public.shops(id) on delete cascade,
  product_id       uuid not null references public.products(id),
  name             text not null,           -- product name at time of sale
  qty              integer not null check (qty > 0),
  unit_price       numeric(12,2) not null,
  line_total       numeric(12,2) not null,
  warranty_months  integer not null default 0,
  warranty_until   date
);
create index sale_items_sale_idx on public.sale_items(sale_id);

create table public.sale_item_serials (
  sale_item_id  uuid not null references public.sale_items(id) on delete cascade,
  serial_id     uuid not null references public.serials(id),
  primary key (sale_item_id, serial_id)
);

-- Every change to stock, with a reason. Powers stock history and "dusty stock" reports.
create table public.stock_movements (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  qty_change  integer not null,
  reason      text not null check (reason in ('purchase', 'sale', 'return', 'adjust_in', 'adjust_out')),
  ref_id      uuid,
  staff_id    uuid references public.staff(id),
  note        text,
  created_at  timestamptz not null default now()
);
create index stock_movements_product_idx on public.stock_movements(product_id, created_at desc);

-- Who did what: discount approvals, price changes, voids. The owner's anti-theft view.
create table public.audit_log (
  id          bigint generated always as identity primary key,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  staff_id    uuid references public.staff(id),
  action      text not null,
  entity      text,
  entity_id   uuid,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_shop_time_idx on public.audit_log(shop_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Helpers: who is the logged-in person, and which shop are they in?
-- ---------------------------------------------------------------------------

create or replace function public.current_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.staff where user_id = auth.uid() and active limit 1;
$$;

create or replace function public.current_shop_id() returns uuid
language sql stable security definer set search_path = public as $$
  select shop_id from public.staff where user_id = auth.uid() and active limit 1;
$$;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('owner', 'manager') from public.staff
                   where user_id = auth.uid() and active limit 1), false);
$$;

create or replace function public.dhaka_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Dhaka')::date; $$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end; $$;

create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- Log every selling-price change (who changed it, from what, to what).
create or replace function public.log_price_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.price is distinct from old.price then
    insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
    values (new.shop_id, public.current_staff_id(), 'price_change', 'product', new.id,
            jsonb_build_object('from', old.price, 'to', new.price, 'name', new.name));
  end if;
  return new;
end; $$;

create trigger products_price_audit after update on public.products
  for each row execute function public.log_price_change();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.shops             enable row level security;
alter table public.staff             enable row level security;
alter table public.categories        enable row level security;
alter table public.products          enable row level security;
alter table public.product_costs     enable row level security;
alter table public.serials           enable row level security;
alter table public.customers         enable row level security;
alter table public.shifts            enable row level security;
alter table public.sales             enable row level security;
alter table public.sale_items        enable row level security;
alter table public.sale_item_serials enable row level security;
alter table public.stock_movements   enable row level security;
alter table public.audit_log         enable row level security;

-- Nobody who isn't logged in gets anything.
revoke all on all tables in schema public from anon;

-- Everyone in the shop can read the shop's everyday data.
create policy shop_read on public.shops for select to authenticated using (id = public.current_shop_id());
create policy staff_read on public.staff for select to authenticated using (shop_id = public.current_shop_id());
create policy categories_read on public.categories for select to authenticated using (shop_id = public.current_shop_id());
create policy products_read on public.products for select to authenticated using (shop_id = public.current_shop_id());
create policy serials_read on public.serials for select to authenticated using (shop_id = public.current_shop_id());
create policy customers_read on public.customers for select to authenticated using (shop_id = public.current_shop_id());
create policy sales_read on public.sales for select to authenticated using (shop_id = public.current_shop_id());
create policy sale_items_read on public.sale_items for select to authenticated using (shop_id = public.current_shop_id());
create policy sale_item_serials_read on public.sale_item_serials for select to authenticated
  using (exists (select 1 from public.sale_items i where i.id = sale_item_id and i.shop_id = public.current_shop_id()));
create policy shifts_read on public.shifts for select to authenticated using (shop_id = public.current_shop_id());

-- Only owners and managers see cost prices, stock history and the audit log.
create policy costs_read on public.product_costs for select to authenticated
  using (shop_id = public.current_shop_id() and public.is_manager());
create policy movements_read on public.stock_movements for select to authenticated
  using (shop_id = public.current_shop_id() and public.is_manager());
create policy audit_read on public.audit_log for select to authenticated
  using (shop_id = public.current_shop_id() and public.is_manager());

-- Only owners and managers edit the catalogue, prices and costs.
create policy categories_write on public.categories for all to authenticated
  using (shop_id = public.current_shop_id() and public.is_manager())
  with check (shop_id = public.current_shop_id() and public.is_manager());
create policy products_write on public.products for all to authenticated
  using (shop_id = public.current_shop_id() and public.is_manager())
  with check (shop_id = public.current_shop_id() and public.is_manager());
create policy costs_write on public.product_costs for all to authenticated
  using (shop_id = public.current_shop_id() and public.is_manager())
  with check (shop_id = public.current_shop_id() and public.is_manager());
create policy staff_write on public.staff for update to authenticated
  using (shop_id = public.current_shop_id() and public.is_manager())
  with check (shop_id = public.current_shop_id() and public.is_manager());

-- Sales, stock and serials change ONLY through the functions below
-- (no insert/update policies for them), so the rules can't be skipped.

-- The PIN hash is never readable from the app, even by managers.
revoke select on public.staff from authenticated;
grant select (id, shop_id, user_id, name, role, discount_limit_pct, active, created_at) on public.staff to authenticated;
revoke update on public.staff from authenticated;
grant update (name, role, discount_limit_pct, active) on public.staff to authenticated;

-- ---------------------------------------------------------------------------
-- complete_sale: the one way a sale gets recorded
-- ---------------------------------------------------------------------------
-- p_items: [{ "product_id": uuid, "qty": int, "serial_ids": [uuid, ...] }]
-- Prices come from the products table, never from the browser.
-- Errors are short codes the app turns into plain messages.

create or replace function public.complete_sale(
  p_items           jsonb,
  p_payment_method  text,
  p_discount_pct    numeric default 0,
  p_manager_pin     text default null,
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

  -- Lock the shop row to hand out the next invoice number safely.
  select * into v_shop from public.shops where id = v_staff.shop_id for update;
  v_invoice := v_shop.invoice_prefix || to_char(v_today, 'YYYY') || lpad(v_shop.next_invoice::text, 6, '0');
  update public.shops set next_invoice = next_invoice + 1 where id = v_shop.id;

  -- Insert the sale header first (totals filled in below) so items can point at it.
  insert into public.sales (id, shop_id, invoice_no, staff_id, subtotal, total, payment_method)
  values (v_sale_id, v_shop.id, v_invoice, v_staff.id, 0, 0, p_payment_method);

  for v_item in select * from jsonb_array_elements(p_items) loop
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

  -- Discount over this person's limit needs a manager's PIN.
  if v_pct > v_staff.discount_limit_pct then
    if p_manager_pin is null or p_manager_pin = '' then raise exception 'MANAGER_PIN_REQUIRED'; end if;
    select id into v_approver from public.staff
      where shop_id = v_shop.id and active and role in ('owner', 'manager')
        and pin_hash is not null and pin_hash = crypt(p_manager_pin, pin_hash)
      limit 1;
    if v_approver is null then raise exception 'MANAGER_PIN_INVALID'; end if;
    insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
    values (v_shop.id, v_staff.id, 'discount_approved', 'sale', v_sale_id,
            jsonb_build_object('pct', v_pct, 'amount', v_discount, 'approved_by', v_approver, 'invoice', v_invoice));
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
-- receive_stock: goods in from a supplier (with serials for serial items)
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
begin
  select * into v_staff from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  select * into v_product from public.products where id = p_product_id and shop_id = v_staff.shop_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

  if v_product.is_serial then
    v_qty := coalesce(array_length(p_serials, 1), 0);
    if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
    insert into public.serials (shop_id, product_id, serial)
      select v_staff.shop_id, v_product.id, trim(s) from unnest(p_serials) s;
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
-- set_pin: a manager or owner sets their own approval PIN (4–6 digits)
-- ---------------------------------------------------------------------------
create or replace function public.set_pin(p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin !~ '^[0-9]{4,6}$' then raise exception 'BAD_PIN'; end if;
  update public.staff set pin_hash = crypt(p_pin, gen_salt('bf'))
    where user_id = auth.uid() and active and role in ('owner', 'manager');
  if not found then raise exception 'NOT_MANAGER'; end if;
end; $$;

-- Functions are callable only by logged-in users.
revoke execute on function public.complete_sale(jsonb, text, numeric, text, text, numeric, text) from public, anon;
revoke execute on function public.receive_stock(uuid, integer, text[], numeric, text) from public, anon;
revoke execute on function public.set_pin(text) from public, anon;
grant execute on function public.complete_sale(jsonb, text, numeric, text, text, numeric, text) to authenticated;
grant execute on function public.receive_stock(uuid, integer, text[], numeric, text) to authenticated;
grant execute on function public.set_pin(text) to authenticated;
