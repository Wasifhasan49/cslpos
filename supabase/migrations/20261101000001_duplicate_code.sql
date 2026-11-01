-- QA pass: a product code that is already taken.
--
-- `products` has had `unique (shop_id, code)` since the first migration, so a second
-- product with the same code was never going to be stored — but upsert_product() did
-- not look, so what came back was Postgres's own "duplicate key value violates unique
-- constraint products_shop_id_code_key". Nothing turns that into words, and the person
-- typing it has no idea which product already has the code.
--
-- The code is what a barcode scan matches on, so this is worth naming properly: the
-- message carries the name of the product that already holds it.

create or replace function public.upsert_product(p_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_before jsonb;
  v_row    public.products;
  v_code   text;
  v_taken  text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:edit_settings'; end if;

  -- Whoever holds this code already, if anybody — on an edit, ignoring this product.
  v_code := nullif(btrim(coalesce(p_values->>'code', '')), '');
  if v_code is not null then
    select p.name into v_taken from public.products p
    where p.shop_id = v_me.shop_id and lower(p.code) = lower(v_code)
      and (p_id is null or p.id <> p_id)
    limit 1;
    if v_taken is not null then raise exception 'PRODUCT_CODE_TAKEN:%', v_taken; end if;
  end if;

  if p_id is null then
    if coalesce(btrim(p_values->>'name'), '') = '' then raise exception 'PRODUCT_NAME_REQUIRED'; end if;
    if v_code is null then raise exception 'PRODUCT_CODE_REQUIRED'; end if;

    insert into public.products (
      shop_id, code, barcode, name, brand, model, category_id, unit_id, vat_rate_id,
      hs_code_id, warranty_term_id, warranty_months, is_serial, is_inventory,
      reorder_level, specification, weight_grams, photo_url, discount_kind, discount_value,
      price, active)
    values (
      v_me.shop_id, v_code, nullif(btrim(coalesce(p_values->>'barcode','')), ''),
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
      code = coalesce(v_code, code),
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
