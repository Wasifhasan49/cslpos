-- P1 — branches, stock locations, and branch-scoped security.
--
-- BMS models a business as Company → Branch → Store, where a "store" is a stock
-- location inside a branch ("Main Store", "Warehouse"). Shops we sell to have several
-- branches; CSL has one. Everything that happens at a PLACE now carries branch_id:
-- stock, serials, sales, shifts, movements. The catalogue (products, categories,
-- customers) stays shop-wide, because a product is the same product in every branch.
--
-- The important consequence: a cashier at Branch A must not be able to read Branch B's
-- sales, shifts or stock numbers even by calling the API directly. They CAN still see
-- that a product exists and what it costs the customer, because that is shop-wide.

-- ---------------------------------------------------------------------------
-- Branches and stock locations
-- ---------------------------------------------------------------------------

create table public.branches (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  name          text not null,
  -- Short, and it goes in every document number, so it must not change casually.
  code          text not null check (code ~ '^[A-Z0-9]{1,6}$'),
  address       text,
  phone         text,
  -- Document numbering is per branch and per document type, so two branches can
  -- never hand out the same invoice number.
  next_invoice  integer not null default 1 check (next_invoice > 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (shop_id, code),
  unique (shop_id, name)
);
create index branches_shop_idx on public.branches(shop_id) where active;

create table public.stock_locations (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid not null references public.branches(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (branch_id, name)
);
-- Exactly one default location per branch, so "where does this stock go?" always has
-- one answer without the caller having to choose.
create unique index stock_locations_one_default on public.stock_locations(branch_id) where is_default;
create index stock_locations_branch_idx on public.stock_locations(branch_id) where active;

-- Which branches a staff member may work in. Owners are not listed here: they get
-- every branch in their shop (see current_branch_ids()).
create table public.staff_branches (
  staff_id    uuid not null references public.staff(id) on delete cascade,
  branch_id   uuid not null references public.branches(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (staff_id, branch_id)
);
create index staff_branches_branch_idx on public.staff_branches(branch_id);

-- Stock per product per location. This replaces products.stock, which could only ever
-- describe one place.
create table public.branch_stock (
  product_id   uuid not null references public.products(id) on delete cascade,
  location_id  uuid not null references public.stock_locations(id) on delete cascade,
  shop_id      uuid not null references public.shops(id) on delete cascade,
  branch_id    uuid not null references public.branches(id) on delete cascade,
  qty          integer not null default 0 check (qty >= 0),
  updated_at   timestamptz not null default now(),
  primary key (product_id, location_id)
);
create index branch_stock_branch_idx on public.branch_stock(branch_id, product_id);
create index branch_stock_shop_idx on public.branch_stock(shop_id, product_id);

-- ---------------------------------------------------------------------------
-- Give every existing shop a branch, and move its data into it
-- ---------------------------------------------------------------------------

insert into public.branches (shop_id, name, code, address, phone, next_invoice)
select id, 'Main branch', 'MB', address, phone, next_invoice from public.shops;

insert into public.stock_locations (shop_id, branch_id, name, is_default)
select b.shop_id, b.id, 'Main store', true from public.branches b;

-- Everyone who already exists can work in their shop's only branch.
insert into public.staff_branches (staff_id, branch_id)
select s.id, b.id from public.staff s join public.branches b on b.shop_id = s.shop_id;

-- ---------------------------------------------------------------------------
-- branch_id on everything that happens at a place
-- ---------------------------------------------------------------------------

alter table public.sales add column branch_id uuid references public.branches(id);
alter table public.shifts add column branch_id uuid references public.branches(id);
alter table public.stock_movements
  add column branch_id uuid references public.branches(id),
  add column location_id uuid references public.stock_locations(id);
alter table public.serials add column location_id uuid references public.stock_locations(id);
-- Nullable on audit_log: some actions (a price change, a role change) are shop-wide
-- and do not belong to any one branch.
alter table public.audit_log add column branch_id uuid references public.branches(id);

update public.sales s set branch_id = b.id
  from public.branches b where b.shop_id = s.shop_id and s.branch_id is null;
update public.shifts sh set branch_id = b.id
  from public.branches b where b.shop_id = sh.shop_id and sh.branch_id is null;
update public.stock_movements m set branch_id = b.id, location_id = l.id
  from public.branches b join public.stock_locations l on l.branch_id = b.id and l.is_default
  where b.shop_id = m.shop_id and m.branch_id is null;
update public.serials sr set location_id = l.id
  from public.branches b join public.stock_locations l on l.branch_id = b.id and l.is_default
  where b.shop_id = sr.shop_id and sr.location_id is null;

-- Move the stock figures into branch_stock at each branch's default location.
insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
select p.id, l.id, p.shop_id, b.id, p.stock
from public.products p
join public.branches b on b.shop_id = p.shop_id
join public.stock_locations l on l.branch_id = b.id and l.is_default;

-- Now that the data has moved, stop there being two answers to "how much stock?".
alter table public.sales alter column branch_id set not null;
alter table public.shifts alter column branch_id set not null;
alter table public.stock_movements alter column branch_id set not null;
alter table public.products drop column stock;
alter table public.shops drop column next_invoice;

-- Reorder level stays on the product: it is a buying decision, and per-branch
-- re-order points are a later problem (P5/P6).

-- ---------------------------------------------------------------------------
-- Who can work where
-- ---------------------------------------------------------------------------

-- Every branch this login may use. Owners get all of their shop's branches without
-- needing a staff_branches row, so adding a branch never locks the owner out of it.
create or replace function public.current_branch_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(b.id), '{}')
  from public.branches b
  join public.staff s on s.shop_id = b.shop_id
  where s.user_id = auth.uid() and s.active and b.active
    and (s.role = 'owner' or exists (
      select 1 from public.staff_branches sb where sb.staff_id = s.id and sb.branch_id = b.id
    ));
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'owner' from public.staff
                   where user_id = auth.uid() and active limit 1), false);
$$;

create or replace function public.can_use_branch(p_branch_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_branch_id = any(public.current_branch_ids());
$$;

/** The location stock moves through for a branch, when the caller has not picked one. */
create or replace function public.default_location(p_branch_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.stock_locations
  where branch_id = p_branch_id and is_default and active limit 1;
$$;

-- current_staff() now carries the branches too, so the app needs one round trip to
-- know who you are, where you may work, and what you may see.
create or replace function public.current_staff() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'staff_id', s.id,
    'shop_id', s.shop_id,
    'name', s.name,
    'role', s.role,
    'discount_limit_pct', s.discount_limit_pct,
    'shop_name', sh.name,
    'has_pin', s.pin_hash is not null,
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code,
        'locations', (
          select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'is_default', l.is_default)
                          order by l.is_default desc, l.name), '[]'::jsonb)
          from public.stock_locations l where l.branch_id = b.id and l.active
        )
      ) order by b.name), '[]'::jsonb)
      from public.branches b
      where b.id = any(public.current_branch_ids())
    )
  )
  from public.staff s
  join public.shops sh on sh.id = s.shop_id
  where s.user_id = auth.uid() and s.active
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Branch administration (owner only, logged)
-- ---------------------------------------------------------------------------

create or replace function public.save_branch(
  p_branch_id  uuid default null,
  p_name       text default null,
  p_code       text default null,
  p_address    text default null,
  p_phone      text default null,
  p_active     boolean default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_before  public.branches;
  v_row     public.branches;
  v_others  integer;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;

  if p_branch_id is null then
    if p_name is null or btrim(p_name) = '' then raise exception 'BRANCH_NAME_REQUIRED'; end if;
    if p_code is null or p_code !~ '^[A-Z0-9]{1,6}$' then raise exception 'BAD_BRANCH_CODE'; end if;

    insert into public.branches (shop_id, name, code, address, phone)
    values (v_me.shop_id, btrim(p_name), p_code, p_address, p_phone)
    returning * into v_row;

    -- A branch with no location cannot hold stock, so it gets one immediately.
    insert into public.stock_locations (shop_id, branch_id, name, is_default)
    values (v_me.shop_id, v_row.id, 'Main store', true);

    -- Existing products start at zero here rather than being absent, so stock reports
    -- show a real 0 instead of a gap.
    insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
    select p.id, public.default_location(v_row.id), v_me.shop_id, v_row.id, 0
    from public.products p where p.shop_id = v_me.shop_id;

    insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
    values (v_me.shop_id, v_row.id, v_me.id, 'branch_created', 'branch', v_row.id,
            jsonb_build_object('name', v_row.name, 'code', v_row.code));
  else
    select * into v_before from public.branches where id = p_branch_id and shop_id = v_me.shop_id;
    if not found then raise exception 'BRANCH_NOT_FOUND'; end if;

    -- The last active branch cannot be switched off: the shop would have nowhere to sell.
    if p_active is false and v_before.active then
      select count(*) into v_others from public.branches
        where shop_id = v_me.shop_id and active and id <> p_branch_id;
      if v_others = 0 then raise exception 'LAST_BRANCH'; end if;
    end if;

    update public.branches set
      name = coalesce(nullif(btrim(p_name), ''), name),
      code = coalesce(p_code, code),
      address = coalesce(p_address, address),
      phone = coalesce(p_phone, phone),
      active = coalesce(p_active, active)
    where id = p_branch_id
    returning * into v_row;

    insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
    values (v_me.shop_id, v_row.id, v_me.id, 'branch_changed', 'branch', v_row.id,
            jsonb_build_object(
              'from', jsonb_build_object('name', v_before.name, 'code', v_before.code, 'active', v_before.active),
              'to', jsonb_build_object('name', v_row.name, 'code', v_row.code, 'active', v_row.active)));
  end if;

  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'code', v_row.code, 'active', v_row.active);
end; $$;

create or replace function public.save_stock_location(
  p_branch_id    uuid,
  p_name         text,
  p_location_id  uuid default null,
  p_is_default   boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me   public.staff;
  v_row  public.stock_locations;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and shop_id = v_me.shop_id) then
    raise exception 'BRANCH_NOT_FOUND';
  end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'LOCATION_NAME_REQUIRED'; end if;

  if p_is_default then
    -- One default per branch, enforced by a unique index, so clear the old one first.
    update public.stock_locations set is_default = false
      where branch_id = p_branch_id and is_default
        and (p_location_id is null or id <> p_location_id);
  end if;

  if p_location_id is null then
    insert into public.stock_locations (shop_id, branch_id, name, is_default)
    values (v_me.shop_id, p_branch_id, btrim(p_name), p_is_default)
    returning * into v_row;

    insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
    select p.id, v_row.id, v_me.shop_id, p_branch_id, 0
    from public.products p where p.shop_id = v_me.shop_id;
  else
    update public.stock_locations
      set name = btrim(p_name), is_default = coalesce(p_is_default, is_default)
    where id = p_location_id and branch_id = p_branch_id
    returning * into v_row;
    if not found then raise exception 'LOCATION_NOT_FOUND'; end if;
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'stock_location_saved', 'stock_location', v_row.id,
          jsonb_build_object('name', v_row.name, 'is_default', v_row.is_default));

  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'is_default', v_row.is_default);
end; $$;

/** Replace the whole set of branches one staff member may work in. */
create or replace function public.set_staff_branches(p_staff_id uuid, p_branch_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_target  public.staff;
  v_before  uuid[];
  v_bad     integer;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;

  select * into v_target from public.staff where id = p_staff_id and shop_id = v_me.shop_id;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;

  select count(*) into v_bad from unnest(coalesce(p_branch_ids, '{}')) bid
    where not exists (select 1 from public.branches where id = bid and shop_id = v_me.shop_id);
  if v_bad > 0 then raise exception 'BRANCH_NOT_FOUND'; end if;

  select coalesce(array_agg(branch_id order by branch_id), '{}') into v_before
    from public.staff_branches where staff_id = p_staff_id;

  delete from public.staff_branches where staff_id = p_staff_id;
  insert into public.staff_branches (staff_id, branch_id)
    select p_staff_id, bid from unnest(coalesce(p_branch_ids, '{}')) bid;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'staff_branches_changed', 'staff', p_staff_id,
          jsonb_build_object('name', v_target.name, 'from', v_before, 'to', coalesce(p_branch_ids, '{}')));

  return jsonb_build_object('staff_id', p_staff_id, 'branch_ids', coalesce(p_branch_ids, '{}'));
end; $$;

-- ---------------------------------------------------------------------------
-- Row-level security, now branch-aware
-- ---------------------------------------------------------------------------

alter table public.branches        enable row level security;
alter table public.stock_locations enable row level security;
alter table public.staff_branches  enable row level security;
alter table public.branch_stock    enable row level security;

-- Everyone can see which branches exist in their shop (the switcher needs it, and a
-- branch's name is not a secret). What happens INSIDE a branch is another matter.
create policy branches_read on public.branches for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy stock_locations_read on public.stock_locations for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy staff_branches_read on public.staff_branches for select to authenticated
  using (exists (select 1 from public.staff s
                 where s.id = staff_id and s.shop_id = (select public.current_shop_id())));

-- Stock numbers are per branch and only for branches you work in. This is the rule
-- that stops a cashier at Branch A reading Branch B's stock through the API.
create policy branch_stock_read on public.branch_stock for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())));

-- Branches and locations change only through save_branch()/save_stock_location().

-- Re-scope the tables that just gained branch_id.
drop policy sales_read on public.sales;
drop policy sale_items_read on public.sale_items;
drop policy sale_item_serials_read on public.sale_item_serials;
drop policy shifts_read on public.shifts;
drop policy serials_read on public.serials;
drop policy movements_read on public.stock_movements;
drop policy audit_read on public.audit_log;

create policy sales_read on public.sales for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())));
create policy sale_items_read on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s
                 where s.id = sale_id and s.branch_id = any(select unnest(public.current_branch_ids()))));
create policy sale_item_serials_read on public.sale_item_serials for select to authenticated
  using (exists (select 1 from public.sale_items i join public.sales s on s.id = i.sale_id
                 where i.id = sale_item_id and s.branch_id = any(select unnest(public.current_branch_ids()))));
create policy shifts_read on public.shifts for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())));
-- A serial is a physical object sitting in one location, so it follows the branch.
create policy serials_read on public.serials for select to authenticated
  using (location_id is null or exists (
    select 1 from public.stock_locations l
    where l.id = location_id and l.branch_id = any(select unnest(public.current_branch_ids()))));
create policy movements_read on public.stock_movements for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids()))
         and (select public.is_manager()));
-- Owners see their whole shop's log, including branches they have since switched off —
-- otherwise closing a branch would quietly hide its history, which is the opposite of
-- what an audit log is for. Managers see shop-wide entries plus their own branches'.
create policy audit_read on public.audit_log for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager())
         and ((select public.is_owner())
              or branch_id is null
              or branch_id = any(select unnest(public.current_branch_ids()))));

-- ---------------------------------------------------------------------------
-- complete_sale: now works in one branch
-- ---------------------------------------------------------------------------

drop function if exists public.complete_sale(jsonb, text, numeric, uuid, text, numeric, text);

create or replace function public.complete_sale(
  p_branch_id       uuid,
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

  -- Checked here, not trusted from the browser: a cashier cannot sell out of a branch
  -- they do not work in.
  if p_branch_id is null then raise exception 'BRANCH_REQUIRED'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  select * into v_branch from public.branches where id = p_branch_id for update;
  v_location := public.default_location(p_branch_id);
  if v_location is null then raise exception 'NO_STOCK_LOCATION:%', v_branch.name; end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_SALE';
  end if;
  if p_payment_method not in ('cash', 'bkash', 'nagad', 'card') then
    raise exception 'BAD_PAYMENT_METHOD';
  end if;
  if v_pct < 0 or v_pct > 100 then raise exception 'BAD_DISCOUNT'; end if;

  if v_pct > v_staff.discount_limit_pct then
    if p_approval_id is null then raise exception 'MANAGER_PIN_REQUIRED'; end if;
    update public.pin_attempts set used_at = now()
      where id = p_approval_id and shop_id = v_staff.shop_id and ok
        and used_at is null and created_at > now() - interval '10 minutes'
      returning approver_id into v_approver;
    if v_approver is null then raise exception 'APPROVAL_NOT_VALID'; end if;
  end if;

  select * into v_shop from public.shops where id = v_staff.shop_id;

  -- Numbering is per branch, so two branches selling at once cannot collide.
  -- <shop prefix>-<branch code>-<year><6 digits>, e.g. CSLINV-MB-2026001790
  v_invoice := v_shop.invoice_prefix || '-' || v_branch.code || '-'
               || to_char(v_today, 'YYYY') || lpad(v_branch.next_invoice::text, 6, '0');
  update public.branches set next_invoice = next_invoice + 1 where id = p_branch_id;

  insert into public.sales (id, shop_id, branch_id, invoice_no, staff_id, subtotal, total, payment_method)
  values (v_sale_id, v_shop.id, p_branch_id, v_invoice, v_staff.id, 0, 0, p_payment_method);

  for v_item in
    select e from jsonb_array_elements(p_items) e order by (e->>'product_id')
  loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = v_shop.id and active;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

    v_qty := coalesce((v_item->>'qty')::integer, 0);
    v_serials := coalesce(array(select jsonb_array_elements_text(coalesce(v_item->'serial_ids', '[]'::jsonb))::uuid), '{}');

    if v_product.is_serial then
      v_qty := coalesce(array_length(v_serials, 1), 0);
      if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
      -- The serial has to be in stock AT THIS BRANCH, not merely somewhere in the shop.
      update public.serials set status = 'sold', sale_id = v_sale_id
        where id = any(v_serials) and product_id = v_product.id and shop_id = v_shop.id
          and status = 'in_stock'
          and location_id in (select id from public.stock_locations where branch_id = p_branch_id);
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    elsif v_qty <= 0 then
      raise exception 'BAD_QTY:%', v_product.name;
    end if;

    -- Lock this branch's row only, so a sale at Branch A never waits on Branch B.
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

    v_until := case when v_product.warranty_months > 0
                    then (v_today + make_interval(months => v_product.warranty_months))::date end;
    v_item_id := gen_random_uuid();
    insert into public.sale_items (id, sale_id, shop_id, product_id, name, qty, unit_price, line_total, warranty_months, warranty_until)
    values (v_item_id, v_sale_id, v_shop.id, v_product.id, v_product.name, v_qty, v_product.price,
            v_product.price * v_qty, v_product.warranty_months, v_until);
    insert into public.sale_item_serials (sale_item_id, serial_id) select v_item_id, unnest(v_serials);
    insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change, reason, ref_id, staff_id)
    values (v_shop.id, p_branch_id, v_location, v_product.id, -v_qty, 'sale', v_sale_id, v_staff.id);

    v_subtotal := v_subtotal + v_product.price * v_qty;
    v_lines := v_lines || jsonb_build_object(
      'name', v_product.name, 'qty', v_qty, 'unit_price', v_product.price,
      'line_total', v_product.price * v_qty, 'warranty_until', v_until,
      'serials', (select coalesce(jsonb_agg(serial), '[]'::jsonb) from public.serials where id = any(v_serials)));
  end loop;

  v_discount := round(v_subtotal * v_pct / 100);
  v_total := v_subtotal - v_discount;

  if v_approver is not null then
    insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
    values (v_shop.id, p_branch_id, v_staff.id, 'discount_approved', 'sale', v_sale_id,
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

  -- The shift has to be the one open at THIS branch.
  select id into v_shift from public.shifts
    where staff_id = v_staff.id and branch_id = p_branch_id and closed_at is null
    order by opened_at desc limit 1;

  update public.sales set
    subtotal = v_subtotal, discount_pct = v_pct, discount_amount = v_discount, total = v_total,
    cash_received = case when p_payment_method = 'cash' then p_cash_received end,
    change_given = v_change, payment_ref = nullif(trim(coalesce(p_payment_ref, '')), ''),
    discount_approved_by = v_approver, customer_id = v_customer, shift_id = v_shift
  where id = v_sale_id;

  return jsonb_build_object(
    'id', v_sale_id, 'invoice_no', v_invoice, 'created_at', now(),
    'staff_name', v_staff.name, 'shop_name', v_shop.name, 'shop_address', v_shop.address,
    'branch_name', v_branch.name, 'branch_address', v_branch.address, 'branch_phone', v_branch.phone,
    'subtotal', v_subtotal, 'discount_pct', v_pct, 'discount_amount', v_discount, 'total', v_total,
    'payment_method', p_payment_method, 'cash_received', p_cash_received, 'change_given', v_change,
    'payment_ref', p_payment_ref, 'customer_phone', nullif(p_customer_phone, ''), 'items', v_lines);
end; $$;

-- ---------------------------------------------------------------------------
-- receive_stock: into a branch's location
-- ---------------------------------------------------------------------------

drop function if exists public.receive_stock(uuid, integer, text[], numeric, text);

create or replace function public.receive_stock(
  p_branch_id   uuid,
  p_product_id  uuid,
  p_qty         integer default null,
  p_serials     text[] default null,
  p_unit_cost   numeric default null,
  p_note        text default null,
  p_location_id uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_staff    public.staff;
  v_product  public.products;
  v_location uuid;
  v_qty      integer;
  v_clean    text[];
begin
  select * into v_staff from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
  if p_branch_id is null then raise exception 'BRANCH_REQUIRED'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  v_location := coalesce(p_location_id, public.default_location(p_branch_id));
  if v_location is null
     or not exists (select 1 from public.stock_locations where id = v_location and branch_id = p_branch_id) then
    raise exception 'LOCATION_NOT_FOUND';
  end if;

  select * into v_product from public.products where id = p_product_id and shop_id = v_staff.shop_id;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

  if v_product.is_serial then
    v_clean := array(select trim(s) from unnest(coalesce(p_serials, '{}')) s where trim(s) <> '');
    v_qty := coalesce(array_length(v_clean, 1), 0);
    if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
    insert into public.serials (shop_id, product_id, serial, location_id)
      select v_staff.shop_id, v_product.id, s, v_location from unnest(v_clean) s;
  else
    v_qty := coalesce(p_qty, 0);
    if v_qty <= 0 then raise exception 'BAD_QTY:%', v_product.name; end if;
  end if;

  insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
  values (v_product.id, v_location, v_staff.shop_id, p_branch_id, v_qty)
  on conflict (product_id, location_id) do update
    set qty = public.branch_stock.qty + excluded.qty, updated_at = now();

  insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change, reason, staff_id, note)
  values (v_staff.shop_id, p_branch_id, v_location, v_product.id, v_qty, 'purchase', v_staff.id, p_note);

  if p_unit_cost is not null then
    insert into public.product_costs (product_id, shop_id, cost) values (v_product.id, v_staff.shop_id, p_unit_cost)
      on conflict (product_id) do update set cost = excluded.cost, updated_at = now();
  end if;
  return v_qty;
end; $$;

-- ---------------------------------------------------------------------------
-- Stock for the screens: one row per product for one branch
-- ---------------------------------------------------------------------------

create or replace function public.branch_products(p_branch_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'id', p.id, 'code', p.code, 'barcode', p.barcode, 'name', p.name, 'brand', p.brand,
      'category_id', p.category_id, 'price', p.price, 'warranty_months', p.warranty_months,
      'is_serial', p.is_serial, 'reorder_level', p.reorder_level,
      'stock', coalesce((select sum(bs.qty) from public.branch_stock bs
                         where bs.product_id = p.id and bs.branch_id = p_branch_id), 0),
      'serials', coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'serial', s.serial) order by s.serial)
        from public.serials s
        join public.stock_locations l on l.id = s.location_id
        where s.product_id = p.id and s.status = 'in_stock' and l.branch_id = p_branch_id
      ), '[]'::jsonb)
    ) as x
    from public.products p
    where p.shop_id = (select public.current_shop_id()) and p.active
  ) q;
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.complete_sale(uuid, jsonb, text, numeric, uuid, text, numeric, text) from public, anon;
revoke execute on function public.receive_stock(uuid, uuid, integer, text[], numeric, text, uuid) from public, anon;
revoke execute on function public.current_branch_ids() from public, anon;
revoke execute on function public.can_use_branch(uuid) from public, anon;
revoke execute on function public.is_owner() from public, anon;
revoke execute on function public.default_location(uuid) from public, anon;
revoke execute on function public.branch_products(uuid) from public, anon;
revoke execute on function public.save_branch(uuid, text, text, text, text, boolean) from public, anon;
revoke execute on function public.save_stock_location(uuid, text, uuid, boolean) from public, anon;
revoke execute on function public.set_staff_branches(uuid, uuid[]) from public, anon;

grant execute on function public.complete_sale(uuid, jsonb, text, numeric, uuid, text, numeric, text) to authenticated;
grant execute on function public.receive_stock(uuid, uuid, integer, text[], numeric, text, uuid) to authenticated;
grant execute on function public.current_branch_ids() to authenticated;
grant execute on function public.can_use_branch(uuid) to authenticated;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.default_location(uuid) to authenticated;
grant execute on function public.branch_products(uuid) to authenticated;
grant execute on function public.save_branch(uuid, text, text, text, text, boolean) to authenticated;
grant execute on function public.save_stock_location(uuid, text, uuid, boolean) to authenticated;
grant execute on function public.set_staff_branches(uuid, uuid[]) to authenticated;
