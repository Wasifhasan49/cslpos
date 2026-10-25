-- P4 — moving a shop off BMS in one sitting.
--
-- Every import function here obeys the same three rules, because a migration that
-- half-works is worse than one that refuses:
--
--   1. UPSERT BY CODE, NEVER DELETE. A shop's export is not the whole truth — it may be
--      a partial report, or last week's. Importing it must never remove anything.
--   2. RE-RUNNING THE SAME FILE CHANGES NOTHING. That is the prompt's done-when, and it
--      is also what makes the import safe to retry when the first attempt times out.
--   3. ONE AUDIT ENTRY PER RUN, WITH COUNTS. Not one per row: an owner wants to know
--      "600 products, 12 updated" and not to scroll past 600 lines.

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------
-- P6 owns supplier paperwork; this is the minimum the import needs, so the agreed
-- purchase prices from P3 finally have something to point at.

create table public.suppliers (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  name         text not null,
  phone        text,
  address      text,
  country_code text references public.countries(code),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (shop_id, name)
);
create index suppliers_shop_idx on public.suppliers(shop_id) where active;

-- Now that suppliers exist, an agreed purchase price can name one.
alter table public.purchase_prices
  add constraint purchase_prices_supplier_fk
  foreign key (supplier_id) references public.suppliers(id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Opening balances
-- ---------------------------------------------------------------------------
-- What a customer owed, or what the shop owed a supplier, on the day it moved across.
-- Stored on its own rather than invented as a fake invoice, so P13 can post it to the
-- accounts properly and so it is always obvious which figures came from the old system.

create table public.opening_balances (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  party_kind  text not null check (party_kind in ('customer', 'supplier')),
  customer_id uuid references public.customers(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete cascade,
  amount      numeric(12,2) not null,
  as_of       date not null default public.dhaka_today(),
  source      text not null default 'import',
  note        text,
  created_at  timestamptz not null default now(),
  -- Exactly one of the two, and only one opening balance per party.
  check ((party_kind = 'customer' and customer_id is not null and supplier_id is null)
      or (party_kind = 'supplier' and supplier_id is not null and customer_id is null))
);
-- Plain unique indexes, not partial ones: a supplier row has customer_id null, and
-- nulls never conflict in a unique index, so this already means "one opening balance
-- per party". A partial index would also stop ON CONFLICT inferring it.
create unique index opening_balances_customer on public.opening_balances(customer_id);
create unique index opening_balances_supplier on public.opening_balances(supplier_id);

-- ---------------------------------------------------------------------------
-- Remembering how a shop's columns map
-- ---------------------------------------------------------------------------

create table public.import_mappings (
  shop_id     uuid not null references public.shops(id) on delete cascade,
  kind        text not null,
  mapping     jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (shop_id, kind)
);

create table public.import_runs (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid references public.branches(id) on delete set null,
  staff_id    uuid references public.staff(id),
  kind        text not null,
  file_name   text,
  dry_run     boolean not null default false,
  counts      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index import_runs_shop_idx on public.import_runs(shop_id, created_at desc);

create or replace function public.save_import_mapping(p_kind text, p_mapping jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('edit_settings') then raise exception 'NOT_ALLOWED:edit_settings'; end if;
  insert into public.import_mappings (shop_id, kind, mapping)
  values (v_me.shop_id, p_kind, p_mapping)
  on conflict (shop_id, kind) do update set mapping = excluded.mapping, updated_at = now();
end; $$;

/** Shared by every import function: who is allowed, and where the run gets logged. */
create or replace function public.log_import_run(
  p_kind text, p_counts jsonb, p_dry_run boolean, p_file text, p_branch_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_id uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  insert into public.import_runs (shop_id, branch_id, staff_id, kind, file_name, dry_run, counts)
  values (v_me.shop_id, p_branch_id, v_me.id, p_kind, p_file, p_dry_run, p_counts)
  returning id into v_id;

  -- One audit entry for the whole run, with counts.
  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id,
          case when p_dry_run then 'import_dry_run' else 'import_run' end,
          'import', v_id,
          jsonb_build_object('kind', p_kind, 'file', p_file) || p_counts);
  return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------

/**
 * Import products.
 *
 * p_rows: [{ code, name, category, brand, model, unit, price, mrp, warranty,
 *            barcode, is_serial, reorder_level, specification }]
 *
 * Categories, brands and units named in the file are created if the shop does not have
 * them, because a shop should not have to pre-build its own category list by hand
 * before it can move in.
 */
create or replace function public.import_products(
  p_rows jsonb, p_dry_run boolean default false, p_file text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_row      jsonb;
  v_code     text;
  v_cat      uuid;
  v_unit     uuid;
  v_existing public.products;
  v_added    integer := 0;
  v_updated  integer := 0;
  v_skipped  integer := 0;
  v_list     uuid;
  v_price    numeric(12,2);
  v_existing_price uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('edit_settings') then raise exception 'NOT_ALLOWED:edit_settings'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'NOTHING_TO_IMPORT'; end if;

  select id into v_list from public.price_lists where shop_id = v_me.shop_id and is_default;

  for v_row in select e from jsonb_array_elements(p_rows) e loop
    v_code := upper(btrim(v_row->>'code'));
    if v_code is null or v_code = '' then v_skipped := v_skipped + 1; continue; end if;
    if coalesce(btrim(v_row->>'name'), '') = '' then v_skipped := v_skipped + 1; continue; end if;

    v_cat := null;
    if coalesce(btrim(v_row->>'category'), '') <> '' then
      insert into public.categories (shop_id, name)
      values (v_me.shop_id, btrim(v_row->>'category'))
      on conflict (shop_id, name) do nothing;
      select id into v_cat from public.categories
        where shop_id = v_me.shop_id and name = btrim(v_row->>'category');
    end if;

    v_unit := null;
    if coalesce(btrim(v_row->>'unit'), '') <> '' then
      insert into public.units (shop_id, name) values (v_me.shop_id, btrim(v_row->>'unit'))
      on conflict (shop_id, name) do nothing;
      select id into v_unit from public.units
        where shop_id = v_me.shop_id and name = btrim(v_row->>'unit');
    end if;

    -- A row with no readable price keeps whatever price the shop already had, and a new
    -- product gets 0 — which the "no price set" filter on /products then surfaces.
    v_price := (v_row->>'price')::numeric;

    select * into v_existing from public.products where shop_id = v_me.shop_id and code = v_code;

    if p_dry_run then
      if v_existing.id is null then v_added := v_added + 1; else v_updated := v_updated + 1; end if;
      continue;
    end if;

    if v_existing.id is null then
      insert into public.products (
        shop_id, code, barcode, name, brand, model, category_id, unit_id,
        warranty_months, is_serial, reorder_level, specification, price, active)
      values (
        v_me.shop_id, v_code, nullif(btrim(coalesce(v_row->>'barcode', '')), ''),
        btrim(v_row->>'name'), nullif(btrim(coalesce(v_row->>'brand', '')), ''),
        nullif(btrim(coalesce(v_row->>'model', '')), ''), v_cat, v_unit,
        coalesce((v_row->>'warranty')::integer, 0),
        coalesce((v_row->>'is_serial')::boolean, false),
        coalesce((v_row->>'reorder_level')::integer, 0),
        nullif(btrim(coalesce(v_row->>'specification', '')), ''),
        coalesce(v_price, 0), true);
      v_added := v_added + 1;

      insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
      select (select id from public.products where shop_id = v_me.shop_id and code = v_code),
             public.default_location(b.id), v_me.shop_id, b.id, 0
      from public.branches b
      where b.shop_id = v_me.shop_id and public.default_location(b.id) is not null
      on conflict do nothing;
    else
      -- is_serial is deliberately NOT updated: a product that already has stock cannot
      -- change, and silently flipping it on a re-import would orphan serials.
      update public.products set
        name = btrim(v_row->>'name'),
        brand = coalesce(nullif(btrim(coalesce(v_row->>'brand', '')), ''), brand),
        model = coalesce(nullif(btrim(coalesce(v_row->>'model', '')), ''), model),
        barcode = coalesce(nullif(btrim(coalesce(v_row->>'barcode', '')), ''), barcode),
        category_id = coalesce(v_cat, category_id),
        unit_id = coalesce(v_unit, unit_id),
        warranty_months = coalesce((v_row->>'warranty')::integer, warranty_months),
        reorder_level = coalesce((v_row->>'reorder_level')::integer, reorder_level),
        specification = coalesce(nullif(btrim(coalesce(v_row->>'specification', '')), ''), specification),
        price = coalesce(v_price, price)
      where id = v_existing.id;
      v_updated := v_updated + 1;
    end if;

    -- Keep the default price list in step, so an imported product is sellable at once.
    -- Written as update-then-insert rather than ON CONFLICT: the unique index is partial
    -- (branch_id is null), and this also avoids calling set_prices(), which would add an
    -- audit row per product and bury the single run entry under 600 of them.
    if v_list is not null then
      select id into v_existing_price from public.product_prices
        where product_id = (select id from public.products where shop_id = v_me.shop_id and code = v_code)
          and price_list_id = v_list and branch_id is null;

      if v_existing_price is null then
        insert into public.product_prices (shop_id, product_id, price_list_id, price, mrp)
        select v_me.shop_id, p.id, v_list, coalesce(v_price, p.price), (v_row->>'mrp')::numeric
        from public.products p where p.shop_id = v_me.shop_id and p.code = v_code;
      else
        update public.product_prices set
          price = coalesce(v_price, price),
          mrp = coalesce((v_row->>'mrp')::numeric, mrp),
          updated_at = now()
        where id = v_existing_price;
      end if;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_skipped,
                            'run_id', public.log_import_run('products',
                              jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_skipped),
                              p_dry_run, p_file));
end; $$;

-- ---------------------------------------------------------------------------
-- Opening stock
-- ---------------------------------------------------------------------------

/**
 * Import what is on the shelf, as an opening-stock adjustment.
 *
 * It SETS the figure rather than adding to it, so re-running the same report leaves the
 * same number on the shelf instead of doubling it. The movement recorded is the
 * difference, which is what makes the stock history add up afterwards.
 */
create or replace function public.import_opening_stock(
  p_branch_id uuid, p_rows jsonb, p_dry_run boolean default false, p_file text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_row      jsonb;
  v_code     text;
  v_product  public.products;
  v_location uuid;
  v_qty      integer;
  v_current  integer;
  v_set      integer := 0;
  v_unchanged integer := 0;
  v_missing  integer := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('adjust_stock') then raise exception 'NOT_ALLOWED:adjust_stock'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  for v_row in select e from jsonb_array_elements(p_rows) e loop
    v_code := upper(btrim(v_row->>'code'));
    v_qty := (v_row->>'qty')::integer;
    if v_code = '' or v_qty is null or v_qty < 0 then v_missing := v_missing + 1; continue; end if;

    select * into v_product from public.products where shop_id = v_me.shop_id and code = v_code;
    if not found then v_missing := v_missing + 1; continue; end if;

    -- A named store becomes a location if the shop uses more than one.
    v_location := null;
    if coalesce(btrim(v_row->>'location'), '') <> '' then
      select id into v_location from public.stock_locations
        where branch_id = p_branch_id and lower(name) = lower(btrim(v_row->>'location')) and active;
    end if;
    v_location := coalesce(v_location, public.default_location(p_branch_id));
    if v_location is null then raise exception 'LOCATION_NOT_FOUND'; end if;

    select qty into v_current from public.branch_stock
      where product_id = v_product.id and location_id = v_location;
    v_current := coalesce(v_current, 0);

    if v_current = v_qty then v_unchanged := v_unchanged + 1; continue; end if;
    if p_dry_run then v_set := v_set + 1; continue; end if;

    insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
    values (v_product.id, v_location, v_me.shop_id, p_branch_id, v_qty)
    on conflict (product_id, location_id) do update set qty = excluded.qty, updated_at = now();

    insert into public.stock_movements (shop_id, branch_id, location_id, product_id,
                                        qty_change, reason, staff_id, note)
    values (v_me.shop_id, p_branch_id, v_location, v_product.id, v_qty - v_current,
            case when v_qty > v_current then 'adjust_in' else 'adjust_out' end,
            v_me.id, 'Opening stock from import');
    v_set := v_set + 1;
  end loop;

  return jsonb_build_object('set', v_set, 'unchanged', v_unchanged, 'missing', v_missing,
                            'run_id', public.log_import_run('stock',
                              jsonb_build_object('set', v_set, 'unchanged', v_unchanged, 'missing', v_missing),
                              p_dry_run, p_file, p_branch_id));
end; $$;

-- ---------------------------------------------------------------------------
-- Serials
-- ---------------------------------------------------------------------------

create or replace function public.import_serials(
  p_branch_id uuid, p_rows jsonb, p_dry_run boolean default false, p_file text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_row      jsonb;
  v_code     text;
  v_serial   text;
  v_product  public.products;
  v_location uuid;
  v_added    integer := 0;
  v_existing integer := 0;
  v_missing  integer := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('adjust_stock') then raise exception 'NOT_ALLOWED:adjust_stock'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  v_location := public.default_location(p_branch_id);
  if v_location is null then raise exception 'LOCATION_NOT_FOUND'; end if;

  for v_row in select e from jsonb_array_elements(p_rows) e loop
    v_code := upper(btrim(v_row->>'code'));
    v_serial := btrim(v_row->>'serial');
    if v_code = '' or v_serial = '' then v_missing := v_missing + 1; continue; end if;

    select * into v_product from public.products where shop_id = v_me.shop_id and code = v_code;
    if not found then v_missing := v_missing + 1; continue; end if;

    -- A serial the shop already has is left exactly as it is, whatever its status: it
    -- may have been sold since the export was taken, and re-importing must not
    -- resurrect it as available stock.
    if exists (select 1 from public.serials where shop_id = v_me.shop_id and serial = v_serial) then
      v_existing := v_existing + 1;
      continue;
    end if;
    if p_dry_run then v_added := v_added + 1; continue; end if;

    insert into public.serials (shop_id, product_id, serial, location_id)
    values (v_me.shop_id, v_product.id, v_serial, v_location);
    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added, 'already_there', v_existing, 'missing', v_missing,
                            'run_id', public.log_import_run('serials',
                              jsonb_build_object('added', v_added, 'already_there', v_existing, 'missing', v_missing),
                              p_dry_run, p_file, p_branch_id));
end; $$;

-- ---------------------------------------------------------------------------
-- Customers and suppliers
-- ---------------------------------------------------------------------------

create or replace function public.import_customers(
  p_rows jsonb, p_dry_run boolean default false, p_file text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_row     jsonb;
  v_phone   text;
  v_id      uuid;
  v_due     numeric(12,2);
  v_added   integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_dues    integer := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('edit_settings') then raise exception 'NOT_ALLOWED:edit_settings'; end if;

  for v_row in select e from jsonb_array_elements(p_rows) e loop
    v_phone := btrim(coalesce(v_row->>'phone', ''));
    -- No real mobile number means no customer: BMS gives every walk-in the same
    -- placeholder, and importing those would create one fictional customer per sale.
    if v_phone !~ '^01[0-9]{9}$' then v_skipped := v_skipped + 1; continue; end if;

    select id into v_id from public.customers where shop_id = v_me.shop_id and phone = v_phone;
    if p_dry_run then
      if v_id is null then v_added := v_added + 1; else v_updated := v_updated + 1; end if;
      continue;
    end if;

    if v_id is null then
      insert into public.customers (shop_id, phone, name_text)
      values (v_me.shop_id, v_phone, nullif(btrim(coalesce(v_row->>'name', '')), ''))
      returning id into v_id;
      v_added := v_added + 1;
    else
      update public.customers
        set name_text = coalesce(nullif(btrim(coalesce(v_row->>'name', '')), ''), name_text)
      where id = v_id;
      v_updated := v_updated + 1;
    end if;

    v_due := (v_row->>'due')::numeric;
    if v_due is not null and v_due <> 0 then
      insert into public.opening_balances (shop_id, party_kind, customer_id, amount, note)
      values (v_me.shop_id, 'customer', v_id, v_due, 'Due carried over from the old system')
      on conflict (customer_id) do update set amount = excluded.amount, as_of = public.dhaka_today();
      v_dues := v_dues + 1;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_skipped,
                            'opening_dues', v_dues,
                            'run_id', public.log_import_run('customers',
                              jsonb_build_object('added', v_added, 'updated', v_updated,
                                                 'skipped', v_skipped, 'opening_dues', v_dues),
                              p_dry_run, p_file));
end; $$;

create or replace function public.import_suppliers(
  p_rows jsonb, p_dry_run boolean default false, p_file text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_row     jsonb;
  v_name    text;
  v_id      uuid;
  v_due     numeric(12,2);
  v_added   integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_dues    integer := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('edit_settings') then raise exception 'NOT_ALLOWED:edit_settings'; end if;

  for v_row in select e from jsonb_array_elements(p_rows) e loop
    v_name := btrim(coalesce(v_row->>'name', ''));
    if v_name = '' then v_skipped := v_skipped + 1; continue; end if;

    select id into v_id from public.suppliers where shop_id = v_me.shop_id and name = v_name;
    if p_dry_run then
      if v_id is null then v_added := v_added + 1; else v_updated := v_updated + 1; end if;
      continue;
    end if;

    if v_id is null then
      insert into public.suppliers (shop_id, name, phone, address)
      values (v_me.shop_id, v_name,
              nullif(btrim(coalesce(v_row->>'phone', '')), ''),
              nullif(btrim(coalesce(v_row->>'address', '')), ''))
      returning id into v_id;
      v_added := v_added + 1;
    else
      update public.suppliers set
        phone = coalesce(nullif(btrim(coalesce(v_row->>'phone', '')), ''), phone),
        address = coalesce(nullif(btrim(coalesce(v_row->>'address', '')), ''), address)
      where id = v_id;
      v_updated := v_updated + 1;
    end if;

    v_due := (v_row->>'due')::numeric;
    if v_due is not null and v_due <> 0 then
      insert into public.opening_balances (shop_id, party_kind, supplier_id, amount, note)
      values (v_me.shop_id, 'supplier', v_id, v_due, 'Owed to them, carried over from the old system')
      on conflict (supplier_id) do update set amount = excluded.amount, as_of = public.dhaka_today();
      v_dues := v_dues + 1;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_skipped,
                            'opening_dues', v_dues,
                            'run_id', public.log_import_run('suppliers',
                              jsonb_build_object('added', v_added, 'updated', v_updated,
                                                 'skipped', v_skipped, 'opening_dues', v_dues),
                              p_dry_run, p_file));
end; $$;

-- ---------------------------------------------------------------------------
-- Prices (one list at a time)
-- ---------------------------------------------------------------------------

create or replace function public.import_prices(
  p_price_list_id uuid, p_rows jsonb, p_dry_run boolean default false, p_file text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_row     jsonb;
  v_code    text;
  v_product public.products;
  v_set     integer := 0;
  v_missing integer := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:edit_settings'; end if;
  if not exists (select 1 from public.price_lists where id = p_price_list_id and shop_id = v_me.shop_id) then
    raise exception 'PRICE_LIST_NOT_FOUND';
  end if;

  for v_row in select e from jsonb_array_elements(p_rows) e loop
    v_code := upper(btrim(v_row->>'code'));
    select * into v_product from public.products where shop_id = v_me.shop_id and code = v_code;
    if not found or (v_row->>'price') is null then v_missing := v_missing + 1; continue; end if;
    if p_dry_run then v_set := v_set + 1; continue; end if;

    perform public.set_prices(
      v_product.id, p_price_list_id, (v_row->>'price')::numeric,
      (v_row->>'mrp')::numeric, (v_row->>'min_price')::numeric, (v_row->>'max_price')::numeric, null);
    v_set := v_set + 1;
  end loop;

  return jsonb_build_object('set', v_set, 'missing', v_missing,
                            'run_id', public.log_import_run('prices',
                              jsonb_build_object('set', v_set, 'missing', v_missing),
                              p_dry_run, p_file));
end; $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.suppliers        enable row level security;
alter table public.opening_balances enable row level security;
alter table public.import_mappings  enable row level security;
alter table public.import_runs      enable row level security;

create policy suppliers_read on public.suppliers for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy suppliers_write on public.suppliers for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

-- What a customer owes is money information, so it follows the same rule as the rest of
-- the money: managers and owners only.
create policy opening_balances_read on public.opening_balances for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

create policy import_mappings_read on public.import_mappings for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy import_runs_read on public.import_runs for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.save_import_mapping(text, jsonb) from public, anon;
revoke execute on function public.log_import_run(text, jsonb, boolean, text, uuid) from public, anon;
revoke execute on function public.import_products(jsonb, boolean, text) from public, anon;
revoke execute on function public.import_opening_stock(uuid, jsonb, boolean, text) from public, anon;
revoke execute on function public.import_serials(uuid, jsonb, boolean, text) from public, anon;
revoke execute on function public.import_customers(jsonb, boolean, text) from public, anon;
revoke execute on function public.import_suppliers(jsonb, boolean, text) from public, anon;
revoke execute on function public.import_prices(uuid, jsonb, boolean, text) from public, anon;

grant execute on function public.save_import_mapping(text, jsonb) to authenticated;
grant execute on function public.log_import_run(text, jsonb, boolean, text, uuid) to authenticated;
grant execute on function public.import_products(jsonb, boolean, text) to authenticated;
grant execute on function public.import_opening_stock(uuid, jsonb, boolean, text) to authenticated;
grant execute on function public.import_serials(uuid, jsonb, boolean, text) to authenticated;
grant execute on function public.import_customers(jsonb, boolean, text) to authenticated;
grant execute on function public.import_suppliers(jsonb, boolean, text) to authenticated;
grant execute on function public.import_prices(uuid, jsonb, boolean, text) to authenticated;
