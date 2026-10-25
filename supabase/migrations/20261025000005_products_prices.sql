-- P3 — the catalogue, and the price tiers BMS calls "Sales Price Fixing".
--
-- The thing this fixes: at CSL the BMS price list is EMPTY, so staff click "Show Cost"
-- and decide the price themselves. That is the owner's single biggest exposure —
-- under-charging and skimming both look identical in the books.
--
-- So: the owner sets prices, they fill in automatically, and a cashier can only move
-- within a band the owner allowed. Below the band needs a manager's approval, and every
-- override is logged with the price that was used and the price that should have been.

-- ---------------------------------------------------------------------------
-- More on a product
-- ---------------------------------------------------------------------------

alter table public.products
  add column model          text,
  add column photo_url      text,
  -- Free text, because a laptop's spec is "i5-1235U / 16GB / 512GB" and no field layout
  -- survives contact with a computer shop's range.
  add column specification  text,
  add column weight_grams   integer check (weight_grams is null or weight_grams >= 0),
  -- BMS's "Inventory" checkbox, inverted. Off for services: OS setup, repair labour,
  -- installation. They sell at the counter and have no stock.
  add column is_inventory   boolean not null default true,
  -- An automatic discount on this product, inside whatever the seller is allowed.
  add column discount_kind  text check (discount_kind in ('fixed', 'percent')),
  add column discount_value numeric(12,2) check (discount_value is null or discount_value >= 0);

-- A serial item whose stock has already been counted cannot quietly become a
-- non-serial one: the serials would be orphaned and the stock figure would be a guess.
create or replace function public.guard_serial_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.is_serial is distinct from old.is_serial then
    if exists (select 1 from public.branch_stock where product_id = new.id and qty > 0)
       or exists (select 1 from public.serials where product_id = new.id and status = 'in_stock') then
      raise exception 'SERIAL_CHANGE_HAS_STOCK:%', old.name;
    end if;
  end if;
  return new;
end; $$;

create trigger products_guard_serial before update on public.products
  for each row execute function public.guard_serial_change();

-- Re-order level is a per-branch decision: the warehouse branch holds more than the
-- shop floor. products.reorder_level stays as the shop-wide default.
create table public.product_reorder_levels (
  product_id  uuid not null references public.products(id) on delete cascade,
  branch_id   uuid not null references public.branches(id) on delete cascade,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  level       integer not null default 0 check (level >= 0),
  primary key (product_id, branch_id)
);

-- ---------------------------------------------------------------------------
-- Product attributes (BMS "Product Classification")
-- ---------------------------------------------------------------------------
-- BMS has eight fixed classification screens: Group, Brand, Category, Color, Size,
-- Manufacturer, Article, Grade. Most shops use two. One generic system instead, where
-- the shop turns on the ones it needs.

create table public.attribute_types (
  id        uuid primary key default gen_random_uuid(),
  shop_id   uuid not null references public.shops(id) on delete cascade,
  key       text not null check (key ~ '^[a-z_]{2,20}$'),
  label     text not null,
  enabled   boolean not null default false,
  sort      integer not null default 0,
  unique (shop_id, key)
);

create table public.attribute_values (
  id        uuid primary key default gen_random_uuid(),
  shop_id   uuid not null references public.shops(id) on delete cascade,
  type_id   uuid not null references public.attribute_types(id) on delete cascade,
  value     text not null,
  sort      integer not null default 0,
  unique (type_id, value)
);
create index attribute_values_type_idx on public.attribute_values(type_id);

create table public.product_attributes (
  product_id  uuid not null references public.products(id) on delete cascade,
  value_id    uuid not null references public.attribute_values(id) on delete cascade,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  primary key (product_id, value_id)
);
create index product_attributes_value_idx on public.product_attributes(value_id);

-- ---------------------------------------------------------------------------
-- Price lists
-- ---------------------------------------------------------------------------

create table public.price_lists (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  active      boolean not null default true,
  sort        integer not null default 0,
  unique (shop_id, name)
);
-- Exactly one default, so "what does a walk-in pay?" always has one answer.
create unique index price_lists_one_default on public.price_lists(shop_id) where is_default;

/**
 * The price of one product on one list, optionally overridden for one branch.
 *
 * branch_id null  = the price everywhere on this list
 * branch_id set   = this branch only, and it wins
 *
 * min_price/max_price are the band a seller may move inside. Null min means the list
 * price is the floor; null max means there is no ceiling.
 */
create table public.product_prices (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  product_id     uuid not null references public.products(id) on delete cascade,
  price_list_id  uuid not null references public.price_lists(id) on delete cascade,
  branch_id      uuid references public.branches(id) on delete cascade,
  price          numeric(12,2) not null check (price >= 0),
  -- Maximum Retail Price, printed on the box. Shown so staff can see they are not
  -- selling above it.
  mrp            numeric(12,2) check (mrp is null or mrp >= 0),
  min_price      numeric(12,2) check (min_price is null or min_price >= 0),
  max_price      numeric(12,2) check (max_price is null or max_price >= 0),
  updated_at     timestamptz not null default now(),
  check (min_price is null or max_price is null or min_price <= max_price)
);
-- Two indexes rather than one, because null branch_id is the common row and a unique
-- constraint treats nulls as distinct.
create unique index product_prices_all_branches
  on public.product_prices(product_id, price_list_id) where branch_id is null;
create unique index product_prices_one_branch
  on public.product_prices(product_id, price_list_id, branch_id) where branch_id is not null;
create index product_prices_list_idx on public.product_prices(price_list_id, product_id);

-- What the shop agreed to pay. Receiving goods (P5/P6) pre-fills it and flags an
-- invoice that differs. supplier_id has no foreign key yet: suppliers arrive in P6.
create table public.purchase_prices (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  supplier_id uuid,
  price       numeric(12,2) not null check (price >= 0),
  updated_at  timestamptz not null default now()
);
create unique index purchase_prices_product_supplier
  on public.purchase_prices(product_id, coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Customers get a price list and an optional standing discount (BMS "Customer Wise
-- Discount"). Walk-ins have neither and pay the default list.
alter table public.customers
  add column name_text      text,
  add column price_list_id  uuid references public.price_lists(id) on delete set null,
  add column discount_pct   numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100);

-- Gifts and offers (BMS "Sales Gift Fixing"): buy X, get Y free. The free line goes on
-- the sale at zero and still leaves stock, because it physically left the shelf.
create table public.gift_offers (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  buy_product_id   uuid not null references public.products(id) on delete cascade,
  buy_qty          integer not null default 1 check (buy_qty > 0),
  free_product_id  uuid not null references public.products(id) on delete cascade,
  free_qty         integer not null default 1 check (free_qty > 0),
  starts_on        date,
  ends_on          date,
  active           boolean not null default true,
  check (starts_on is null or ends_on is null or starts_on <= ends_on)
);
create index gift_offers_buy_idx on public.gift_offers(shop_id, buy_product_id) where active;

-- Sale lines remember what was asked and what was charged, so an override is visible
-- on the sale itself and not only in the log.
alter table public.sale_items
  add column list_price      numeric(12,2),
  add column price_overridden boolean not null default false,
  add column is_gift         boolean not null default false;

-- ---------------------------------------------------------------------------
-- Defaults: every shop gets a Retail list
-- ---------------------------------------------------------------------------

create or replace function public.seed_price_defaults(p_shop_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_list uuid;
begin
  insert into public.price_lists (shop_id, name, is_default, sort)
  values (p_shop_id, 'Retail', true, 1)
  on conflict (shop_id, name) do nothing;

  select id into v_list from public.price_lists where shop_id = p_shop_id and is_default;

  -- Group and Brand on by default; the rest are there to be switched on.
  insert into public.attribute_types (shop_id, key, label, enabled, sort) values
    (p_shop_id, 'group', 'Group', true, 1),
    (p_shop_id, 'brand', 'Brand', true, 2),
    (p_shop_id, 'color', 'Colour', false, 3),
    (p_shop_id, 'size', 'Size', false, 4),
    (p_shop_id, 'manufacturer', 'Manufacturer', false, 5),
    (p_shop_id, 'article', 'Article', false, 6),
    (p_shop_id, 'grade', 'Grade', false, 7)
  on conflict (shop_id, key) do nothing;

  -- Move the price already on each product onto the default list, so nothing loses its
  -- price when this migration lands.
  insert into public.product_prices (shop_id, product_id, price_list_id, price)
  select p.shop_id, p.id, v_list, p.price
  from public.products p
  where p.shop_id = p_shop_id
  on conflict do nothing;

  -- A cashier may move a price WITHIN the band the owner set. That is the whole point of
  -- a band: without this, the band would be unreachable and every haggle would need a
  -- manager, which is the BMS problem in a different shape. Below the band still needs
  -- an approval — a band is the owner's standing permission, not a blanket one.
  update public.role_permissions set allowed = true
    where shop_id = p_shop_id and role = 'cashier' and perm = 'change_price';
end; $$;

select public.seed_price_defaults(id) from public.shops;

-- ---------------------------------------------------------------------------
-- Resolving a price
-- ---------------------------------------------------------------------------

/**
 * What one product costs on one list at one branch, and the band a seller may move in.
 *
 * Branch override first, then the all-branches row, then products.price as the last
 * resort so a product can never be unsellable just because nobody set a price.
 */
create or replace function public.resolve_price(
  p_product_id uuid, p_branch_id uuid, p_price_list_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_shop  uuid;
  v_list  uuid;
  v_row   public.product_prices;
  v_base  numeric(12,2);
begin
  select shop_id, price into v_shop, v_base from public.products where id = p_product_id;
  if v_shop is null then raise exception 'PRODUCT_NOT_FOUND'; end if;

  v_list := coalesce(p_price_list_id, (select id from public.price_lists where shop_id = v_shop and is_default));

  -- Branch override wins.
  select * into v_row from public.product_prices
    where product_id = p_product_id and price_list_id = v_list and branch_id = p_branch_id;
  if not found then
    select * into v_row from public.product_prices
      where product_id = p_product_id and price_list_id = v_list and branch_id is null;
  end if;

  if not found then
    return jsonb_build_object('price', v_base, 'mrp', null, 'min_price', v_base, 'max_price', null,
                              'price_list_id', v_list, 'from_list', false);
  end if;

  return jsonb_build_object(
    'price', v_row.price, 'mrp', v_row.mrp,
    -- No minimum set means the list price IS the floor: the owner has not given anyone
    -- permission to go below it.
    'min_price', coalesce(v_row.min_price, v_row.price),
    'max_price', v_row.max_price,
    'price_list_id', v_list, 'from_list', true);
end; $$;

-- ---------------------------------------------------------------------------
-- Catalogue writes
-- ---------------------------------------------------------------------------

create or replace function public.upsert_product(p_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_before jsonb;
  v_row    public.products;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:edit_settings'; end if;

  if p_id is null then
    if coalesce(btrim(p_values->>'name'), '') = '' then raise exception 'PRODUCT_NAME_REQUIRED'; end if;
    if coalesce(btrim(p_values->>'code'), '') = '' then raise exception 'PRODUCT_CODE_REQUIRED'; end if;

    insert into public.products (
      shop_id, code, barcode, name, brand, model, category_id, unit_id, vat_rate_id,
      hs_code_id, warranty_term_id, warranty_months, is_serial, is_inventory,
      reorder_level, specification, weight_grams, photo_url, discount_kind, discount_value,
      price, active)
    values (
      v_me.shop_id, btrim(p_values->>'code'), nullif(btrim(coalesce(p_values->>'barcode','')), ''),
      btrim(p_values->>'name'), p_values->>'brand', p_values->>'model',
      (p_values->>'category_id')::uuid, (p_values->>'unit_id')::uuid, (p_values->>'vat_rate_id')::uuid,
      (p_values->>'hs_code_id')::uuid, (p_values->>'warranty_term_id')::uuid,
      coalesce((p_values->>'warranty_months')::integer, 0),
      coalesce((p_values->>'is_serial')::boolean, false),
      coalesce((p_values->>'is_inventory')::boolean, true),
      coalesce((p_values->>'reorder_level')::integer, 0),
      p_values->>'specification', (p_values->>'weight_grams')::integer, p_values->>'photo_url',
      nullif(p_values->>'discount_kind', ''), (p_values->>'discount_value')::numeric,
      coalesce((p_values->>'price')::numeric, 0),
      coalesce((p_values->>'active')::boolean, true))
    returning * into v_row;

    -- A new product exists at every branch at zero, so stock reports show a real zero.
    insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
    select v_row.id, public.default_location(b.id), v_me.shop_id, b.id, 0
    from public.branches b where b.shop_id = v_me.shop_id and public.default_location(b.id) is not null
    on conflict do nothing;

    -- And it gets the default list price, so it is sellable immediately.
    insert into public.product_prices (shop_id, product_id, price_list_id, price)
    select v_me.shop_id, v_row.id, pl.id, v_row.price
    from public.price_lists pl where pl.shop_id = v_me.shop_id and pl.is_default
    on conflict do nothing;
  else
    select to_jsonb(p.*) into v_before from public.products p
      where p.id = p_id and p.shop_id = v_me.shop_id;
    if v_before is null then raise exception 'PRODUCT_NOT_FOUND'; end if;

    update public.products set
      code = coalesce(nullif(btrim(p_values->>'code'), ''), code),
      barcode = case when p_values ? 'barcode' then nullif(btrim(coalesce(p_values->>'barcode','')), '') else barcode end,
      name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
      brand = case when p_values ? 'brand' then p_values->>'brand' else brand end,
      model = case when p_values ? 'model' then p_values->>'model' else model end,
      category_id = case when p_values ? 'category_id' then (p_values->>'category_id')::uuid else category_id end,
      unit_id = case when p_values ? 'unit_id' then (p_values->>'unit_id')::uuid else unit_id end,
      vat_rate_id = case when p_values ? 'vat_rate_id' then (p_values->>'vat_rate_id')::uuid else vat_rate_id end,
      hs_code_id = case when p_values ? 'hs_code_id' then (p_values->>'hs_code_id')::uuid else hs_code_id end,
      warranty_term_id = case when p_values ? 'warranty_term_id' then (p_values->>'warranty_term_id')::uuid else warranty_term_id end,
      warranty_months = coalesce((p_values->>'warranty_months')::integer, warranty_months),
      is_serial = coalesce((p_values->>'is_serial')::boolean, is_serial),
      is_inventory = coalesce((p_values->>'is_inventory')::boolean, is_inventory),
      reorder_level = coalesce((p_values->>'reorder_level')::integer, reorder_level),
      specification = case when p_values ? 'specification' then p_values->>'specification' else specification end,
      weight_grams = case when p_values ? 'weight_grams' then (p_values->>'weight_grams')::integer else weight_grams end,
      photo_url = case when p_values ? 'photo_url' then p_values->>'photo_url' else photo_url end,
      discount_kind = case when p_values ? 'discount_kind' then nullif(p_values->>'discount_kind','') else discount_kind end,
      discount_value = case when p_values ? 'discount_value' then (p_values->>'discount_value')::numeric else discount_value end,
      active = coalesce((p_values->>'active')::boolean, active)
    where id = p_id
    returning * into v_row;

    insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
    values (v_me.shop_id, v_me.id, 'product_changed', 'product', p_id,
            jsonb_build_object('name', v_row.name, 'from', v_before - 'id', 'to', to_jsonb(v_row) - 'id'));
  end if;

  return to_jsonb(v_row);
end; $$;

/** Set the price, MRP and band for one product on one list (optionally one branch). */
create or replace function public.set_prices(
  p_product_id    uuid,
  p_price_list_id uuid,
  p_price         numeric,
  p_mrp           numeric default null,
  p_min_price     numeric default null,
  p_max_price     numeric default null,
  p_branch_id     uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_before public.product_prices;
  v_row    public.product_prices;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:edit_settings'; end if;
  if p_price is null or p_price < 0 then raise exception 'BAD_PRICE'; end if;
  if p_min_price is not null and p_max_price is not null and p_min_price > p_max_price then
    raise exception 'BAD_PRICE_BAND';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and shop_id = v_me.shop_id) then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  if not exists (select 1 from public.price_lists where id = p_price_list_id and shop_id = v_me.shop_id) then
    raise exception 'PRICE_LIST_NOT_FOUND';
  end if;
  if p_branch_id is not null
     and not exists (select 1 from public.branches where id = p_branch_id and shop_id = v_me.shop_id) then
    raise exception 'BRANCH_NOT_FOUND';
  end if;

  select * into v_before from public.product_prices
    where product_id = p_product_id and price_list_id = p_price_list_id
      and branch_id is not distinct from p_branch_id;

  if v_before.id is null then
    insert into public.product_prices (shop_id, product_id, price_list_id, branch_id, price, mrp, min_price, max_price)
    values (v_me.shop_id, p_product_id, p_price_list_id, p_branch_id, p_price, p_mrp, p_min_price, p_max_price)
    returning * into v_row;
  else
    update public.product_prices
      set price = p_price, mrp = p_mrp, min_price = p_min_price, max_price = p_max_price, updated_at = now()
    where id = v_before.id
    returning * into v_row;
  end if;

  -- The default list's price is mirrored onto products.price, so anything still reading
  -- that column (and resolve_price's last resort) stays correct.
  if p_branch_id is null
     and exists (select 1 from public.price_lists where id = p_price_list_id and is_default) then
    update public.products set price = p_price where id = p_product_id;
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'price_set', 'product', p_product_id,
          jsonb_build_object(
            'product', (select name from public.products where id = p_product_id),
            'list', (select name from public.price_lists where id = p_price_list_id),
            'from', jsonb_build_object('price', v_before.price, 'min', v_before.min_price, 'max', v_before.max_price),
            'to', jsonb_build_object('price', v_row.price, 'min', v_row.min_price, 'max', v_row.max_price)));

  return to_jsonb(v_row);
end; $$;

/**
 * Change many prices at once: set them all to one figure, or move them by a percentage
 * or an amount. Returns what changed so the screen can show old → new before anything
 * is committed by the caller's next action.
 */
create or replace function public.bulk_update_prices(
  p_product_ids   uuid[],
  p_price_list_id uuid,
  p_mode          text,          -- 'set' | 'percent' | 'amount'
  p_value         numeric,
  p_branch_id     uuid default null,
  p_dry_run       boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_id    uuid;
  v_cur   jsonb;
  v_old   numeric(12,2);
  v_new   numeric(12,2);
  v_out   jsonb := '[]'::jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:edit_settings'; end if;
  if p_mode not in ('set', 'percent', 'amount') then raise exception 'BAD_PRICE_MODE:%', p_mode; end if;
  if p_value is null then raise exception 'BAD_PRICE'; end if;
  if coalesce(array_length(p_product_ids, 1), 0) = 0 then raise exception 'NO_PRODUCTS_PICKED'; end if;

  foreach v_id in array p_product_ids loop
    if not exists (select 1 from public.products where id = v_id and shop_id = v_me.shop_id) then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;
    v_cur := public.resolve_price(v_id, p_branch_id, p_price_list_id);
    v_old := (v_cur->>'price')::numeric;
    v_new := case p_mode
      when 'set' then p_value
      when 'percent' then round(v_old * (100 + p_value) / 100, 2)
      else v_old + p_value
    end;
    if v_new < 0 then v_new := 0; end if;

    v_out := v_out || jsonb_build_object(
      'product_id', v_id,
      'name', (select name from public.products where id = v_id),
      'from', v_old, 'to', v_new);

    if not p_dry_run then
      perform public.set_prices(v_id, p_price_list_id, v_new,
                                (v_cur->>'mrp')::numeric,
                                (v_cur->>'min_price')::numeric,
                                (v_cur->>'max_price')::numeric,
                                p_branch_id);
    end if;
  end loop;

  return jsonb_build_object('dry_run', p_dry_run, 'changes', v_out);
end; $$;

/**
 * Merge one category into another, for fixing the typos BMS is full of —
 * "Convarter" into "Converters".
 */
create or replace function public.merge_categories(p_from uuid, p_into uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_from public.categories; v_into public.categories; v_moved integer;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:edit_settings'; end if;
  if p_from = p_into then raise exception 'SAME_CATEGORY'; end if;

  select * into v_from from public.categories where id = p_from and shop_id = v_me.shop_id;
  if not found then raise exception 'CATEGORY_NOT_FOUND'; end if;
  select * into v_into from public.categories where id = p_into and shop_id = v_me.shop_id;
  if not found then raise exception 'CATEGORY_NOT_FOUND'; end if;

  update public.products set category_id = p_into where category_id = p_from and shop_id = v_me.shop_id;
  get diagnostics v_moved = row_count;
  delete from public.categories where id = p_from;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'categories_merged', 'category', p_into,
          jsonb_build_object('from', v_from.name, 'into', v_into.name, 'products_moved', v_moved));

  return jsonb_build_object('from', v_from.name, 'into', v_into.name, 'products_moved', v_moved);
end; $$;

create or replace function public.save_price_list(
  p_id uuid, p_name text, p_is_default boolean default null, p_active boolean default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row public.price_lists;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;

  if p_is_default then
    update public.price_lists set is_default = false
      where shop_id = v_me.shop_id and is_default and (p_id is null or id <> p_id);
  end if;

  if p_id is null then
    if coalesce(btrim(p_name), '') = '' then raise exception 'PRICE_LIST_NAME_REQUIRED'; end if;
    insert into public.price_lists (shop_id, name, is_default)
    values (v_me.shop_id, btrim(p_name), coalesce(p_is_default, false))
    returning * into v_row;
  else
    -- A shop always needs one default list, or a walk-in has no price.
    if p_is_default is false or p_active is false then
      if (select is_default from public.price_lists where id = p_id) then
        raise exception 'LAST_PRICE_LIST';
      end if;
    end if;
    update public.price_lists
      set name = coalesce(nullif(btrim(p_name), ''), name),
          is_default = coalesce(p_is_default, is_default),
          active = coalesce(p_active, active)
    where id = p_id and shop_id = v_me.shop_id
    returning * into v_row;
    if v_row.id is null then raise exception 'PRICE_LIST_NOT_FOUND'; end if;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'price_list_saved', 'price_list', v_row.id,
          jsonb_build_object('name', v_row.name, 'is_default', v_row.is_default, 'active', v_row.active));
  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- What the screens read
-- ---------------------------------------------------------------------------

/**
 * The catalogue for one branch with prices from one list, for /products.
 *
 * Cost and margin are included ONLY if this login may see cost. A cashier gets the same
 * shape with those keys absent — not null, absent — so the numbers never reach the
 * browser at all, which is what "including the network tab" means.
 */
create or replace function public.catalogue(p_branch_id uuid, p_price_list_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_shop  uuid := (select public.current_shop_id());
  v_cost  boolean := public.has_permission('see_cost');
  v_list  uuid;
  v_out   jsonb;
begin
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  v_list := coalesce(p_price_list_id, (select id from public.price_lists where shop_id = v_shop and is_default));

  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) into v_out
  from (
    select jsonb_strip_nulls(jsonb_build_object(
      'id', p.id, 'code', p.code, 'barcode', p.barcode, 'name', p.name, 'brand', p.brand,
      'model', p.model, 'category_id', p.category_id, 'category', c.name,
      'unit', u.name, 'specification', p.specification, 'photo_url', p.photo_url,
      'warranty_months', coalesce(wt.months, p.warranty_months),
      'warranty_term', wt.name,
      'is_serial', p.is_serial, 'is_inventory', p.is_inventory, 'active', p.active,
      'reorder_level', coalesce(rl.level, p.reorder_level),
      'price', (pr->>'price')::numeric,
      'mrp', (pr->>'mrp')::numeric,
      'min_price', (pr->>'min_price')::numeric,
      'max_price', (pr->>'max_price')::numeric,
      'discount_kind', p.discount_kind, 'discount_value', p.discount_value,
      'stock', coalesce((select sum(bs.qty) from public.branch_stock bs
                         where bs.product_id = p.id and bs.branch_id = p_branch_id), 0),
      'total_stock', coalesce((select sum(bs.qty) from public.branch_stock bs
                               where bs.product_id = p.id), 0),
      -- Absent for a cashier, not null: the number is never sent.
      'cost', case when v_cost then pc.cost end,
      'margin_pct', case when v_cost and pc.cost is not null and pc.cost > 0
                         then round(((pr->>'price')::numeric - pc.cost) / pc.cost * 100, 1) end
    )) as x
    from public.products p
    left join public.categories c on c.id = p.category_id
    left join public.units u on u.id = p.unit_id
    left join public.warranty_terms wt on wt.id = p.warranty_term_id
    left join public.product_costs pc on pc.product_id = p.id and v_cost
    left join public.product_reorder_levels rl on rl.product_id = p.id and rl.branch_id = p_branch_id
    cross join lateral public.resolve_price(p.id, p_branch_id, v_list) pr
    where p.shop_id = v_shop
  ) q;
  return v_out;
end; $$;

-- branch_products() is what the counter uses. It now takes the price list so a dealer
-- customer's prices are the ones on screen, and carries the band so the counter knows
-- how far a price may move. The old one-argument version has to go, or a one-argument
-- call is ambiguous between the two.
drop function if exists public.branch_products(uuid);

create or replace function public.branch_products(p_branch_id uuid, p_price_list_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_shop uuid := (select public.current_shop_id());
  v_list uuid;
  v_out  jsonb;
begin
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  v_list := coalesce(p_price_list_id, (select id from public.price_lists where shop_id = v_shop and is_default));

  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'id', p.id, 'code', p.code, 'barcode', p.barcode, 'name', p.name, 'brand', p.brand,
      'category_id', p.category_id, 'price', (pr->>'price')::numeric,
      'mrp', (pr->>'mrp')::numeric,
      'min_price', (pr->>'min_price')::numeric, 'max_price', (pr->>'max_price')::numeric,
      'warranty_months', coalesce(wt.months, p.warranty_months),
      'is_serial', p.is_serial, 'is_inventory', p.is_inventory,
      'reorder_level', coalesce(rl.level, p.reorder_level),
      'discount_kind', p.discount_kind, 'discount_value', p.discount_value,
      -- A service has no stock to run out of, so the counter must not block on it.
      'stock', case when not p.is_inventory then 999999
                    else coalesce((select sum(bs.qty) from public.branch_stock bs
                                   where bs.product_id = p.id and bs.branch_id = p_branch_id), 0) end,
      'serials', coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'serial', s.serial) order by s.serial)
        from public.serials s
        join public.stock_locations l on l.id = s.location_id
        where s.product_id = p.id and s.status = 'in_stock' and l.branch_id = p_branch_id
      ), '[]'::jsonb)
    ) as x
    from public.products p
    left join public.warranty_terms wt on wt.id = p.warranty_term_id
    left join public.product_reorder_levels rl on rl.product_id = p.id and rl.branch_id = p_branch_id
    cross join lateral public.resolve_price(p.id, p_branch_id, v_list) pr
    where p.shop_id = v_shop and p.active
  ) q;
  return v_out;
end; $$;

/** A customer's price list and standing discount, looked up by phone at the counter. */
create or replace function public.customer_by_phone(p_phone text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', c.id, 'phone', c.phone, 'name', c.name_text,
    'price_list_id', coalesce(c.price_list_id, (select id from public.price_lists
                                                where shop_id = c.shop_id and is_default)),
    'price_list_name', coalesce(pl.name, (select name from public.price_lists
                                          where shop_id = c.shop_id and is_default)),
    'discount_pct', c.discount_pct)
  from public.customers c
  left join public.price_lists pl on pl.id = c.price_list_id
  where c.shop_id = (select public.current_shop_id()) and c.phone = p_phone;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.price_lists             enable row level security;
alter table public.product_prices          enable row level security;
alter table public.purchase_prices         enable row level security;
alter table public.product_reorder_levels  enable row level security;
alter table public.attribute_types         enable row level security;
alter table public.attribute_values        enable row level security;
alter table public.product_attributes      enable row level security;
alter table public.gift_offers             enable row level security;

-- Everyone needs to read prices: that is the point of them filling in automatically.
create policy price_lists_read on public.price_lists for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy product_prices_read on public.product_prices for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy reorder_levels_read on public.product_reorder_levels for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy attribute_types_read on public.attribute_types for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy attribute_values_read on public.attribute_values for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy product_attributes_read on public.product_attributes for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy gift_offers_read on public.gift_offers for select to authenticated
  using (shop_id = (select public.current_shop_id()));

-- A purchase price is what the shop PAYS, so it follows the cost permission.
create policy purchase_prices_read on public.purchase_prices for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.has_permission('see_cost')));

-- Attribute vocabulary and gifts are managed by managers directly; prices and products
-- go through the functions above.
create policy attribute_types_write on public.attribute_types for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy attribute_values_write on public.attribute_values for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy product_attributes_write on public.product_attributes for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy gift_offers_write on public.gift_offers for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy reorder_levels_write on public.product_reorder_levels for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));
create policy purchase_prices_write on public.purchase_prices for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

-- Customers can be edited by managers (P10 builds the screens).
create policy customers_write on public.customers for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.resolve_price(uuid, uuid, uuid) from public, anon;
revoke execute on function public.upsert_product(uuid, jsonb) from public, anon;
revoke execute on function public.set_prices(uuid, uuid, numeric, numeric, numeric, numeric, uuid) from public, anon;
revoke execute on function public.bulk_update_prices(uuid[], uuid, text, numeric, uuid, boolean) from public, anon;
revoke execute on function public.merge_categories(uuid, uuid) from public, anon;
revoke execute on function public.save_price_list(uuid, text, boolean, boolean) from public, anon;
revoke execute on function public.catalogue(uuid, uuid) from public, anon;
revoke execute on function public.branch_products(uuid, uuid) from public, anon;
revoke execute on function public.customer_by_phone(text) from public, anon;
revoke execute on function public.seed_price_defaults(uuid) from public, anon, authenticated;

grant execute on function public.resolve_price(uuid, uuid, uuid) to authenticated;
grant execute on function public.upsert_product(uuid, jsonb) to authenticated;
grant execute on function public.set_prices(uuid, uuid, numeric, numeric, numeric, numeric, uuid) to authenticated;
grant execute on function public.bulk_update_prices(uuid[], uuid, text, numeric, uuid, boolean) to authenticated;
grant execute on function public.merge_categories(uuid, uuid) to authenticated;
grant execute on function public.save_price_list(uuid, text, boolean, boolean) to authenticated;
grant execute on function public.catalogue(uuid, uuid) to authenticated;
grant execute on function public.branch_products(uuid, uuid) to authenticated;
grant execute on function public.customer_by_phone(text) to authenticated;
