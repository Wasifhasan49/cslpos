-- P2 — VAT, extra charges and the discount reason at the till.
--
-- complete_sale() gains tax. Two things make this fiddly and both are handled per line,
-- not on the total:
--
--   * Inclusive VAT (the normal case in Bangladesh retail) does not change what the
--     customer pays. The shelf price already contains the tax; the receipt just has to
--     say how much of it was tax. Working it out on the rounded total instead of per
--     line is how VAT returns end up a few taka out.
--   * Exclusive VAT is added on top, so the total goes UP after the discount.
--
-- VAT is off unless the shop turns it on, and a product with no rate is simply untaxed,
-- so a shop that never registered for VAT sells exactly as before.

drop function if exists public.complete_sale(uuid, jsonb, text, numeric, uuid, text, numeric, text);

create or replace function public.complete_sale(
  p_branch_id        uuid,
  p_items            jsonb,
  p_payment_method   text,
  p_discount_pct     numeric default 0,
  p_approval_id      uuid default null,
  p_customer_phone   text default null,
  p_cash_received    numeric default null,
  p_payment_ref      text default null,
  -- [{ "charge_id": uuid }] — the shop's configured charges to add to this sale.
  p_charges          jsonb default null,
  p_discount_type_id uuid default null,
  p_category_id      uuid default null
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
  v_vat_amts  numeric[] := '{}';
  v_i         integer;
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

  -- The shop decides which payment methods it takes, so an unconfigured one is refused
  -- rather than silently accepted.
  select * into v_pay from public.payment_methods
    where shop_id = v_staff.shop_id and key = p_payment_method and enabled;
  if not found then raise exception 'BAD_PAYMENT_METHOD'; end if;

  if v_pct < 0 or v_pct > 100 then raise exception 'BAD_DISCOUNT'; end if;

  if v_pct > public.permission_limit('give_discount') then
    if p_approval_id is null then raise exception 'MANAGER_PIN_REQUIRED'; end if;
    update public.pin_attempts set used_at = now()
      where id = p_approval_id and shop_id = v_staff.shop_id and ok
        and used_at is null and created_at > now() - interval '10 minutes'
      returning approver_id into v_approver;
    if v_approver is null then raise exception 'APPROVAL_NOT_VALID'; end if;
  end if;

  if p_discount_type_id is not null
     and not exists (select 1 from public.discount_types
                     where id = p_discount_type_id and shop_id = v_staff.shop_id and active) then
    raise exception 'BAD_DISCOUNT_TYPE';
  end if;
  if p_category_id is not null
     and not exists (select 1 from public.transaction_categories
                     where id = p_category_id and shop_id = v_staff.shop_id and active) then
    raise exception 'BAD_CATEGORY';
  end if;

  select * into v_shop from public.shops where id = v_staff.shop_id;

  v_invoice := v_shop.invoice_prefix || '-' || v_branch.code || '-'
               || to_char(v_today, 'YYYY') || lpad(v_branch.next_invoice::text, 6, '0');
  update public.branches set next_invoice = next_invoice + 1 where id = p_branch_id;

  insert into public.sales (id, shop_id, branch_id, invoice_no, staff_id, subtotal, total,
                            payment_method, discount_type_id, transaction_category_id)
  values (v_sale_id, v_shop.id, p_branch_id, v_invoice, v_staff.id, 0, 0,
          p_payment_method, p_discount_type_id, p_category_id);

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
      update public.serials set status = 'sold', sale_id = v_sale_id
        where id = any(v_serials) and product_id = v_product.id and shop_id = v_shop.id
          and status = 'in_stock'
          and location_id in (select id from public.stock_locations where branch_id = p_branch_id);
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    elsif v_qty <= 0 then
      raise exception 'BAD_QTY:%', v_product.name;
    end if;

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

    v_line := v_product.price * v_qty;

    -- VAT per line, only if the shop charges it and this product has a rate.
    v_rate := null;
    if v_vat_on and v_product.vat_rate_id is not null then
      select * into v_rate from public.vat_rates
        where id = v_product.vat_rate_id and shop_id = v_shop.id and active;
    end if;
    v_line_vat := case when v_rate.id is null then 0
                       else public.vat_on(v_line, v_rate.pct, v_rate.inclusive) end;

    -- Warranty months come from the term if the product has one, else its own number.
    v_until := case
      when v_product.warranty_term_id is not null then
        (select case when wt.months > 0 then (v_today + make_interval(months => wt.months))::date end
         from public.warranty_terms wt where wt.id = v_product.warranty_term_id)
      when v_product.warranty_months > 0 then (v_today + make_interval(months => v_product.warranty_months))::date
    end;

    v_item_id := gen_random_uuid();
    insert into public.sale_items (id, sale_id, shop_id, product_id, name, qty, unit_price,
                                   line_total, warranty_months, warranty_until,
                                   vat_pct, vat_amount, vat_inclusive)
    values (v_item_id, v_sale_id, v_shop.id, v_product.id, v_product.name, v_qty, v_product.price,
            v_line, v_product.warranty_months, v_until,
            coalesce(v_rate.pct, 0), v_line_vat, coalesce(v_rate.inclusive, true));

    insert into public.sale_item_serials (sale_item_id, serial_id) select v_item_id, unnest(v_serials);
    insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change, reason, ref_id, staff_id)
    values (v_shop.id, p_branch_id, v_location, v_product.id, -v_qty, 'sale', v_sale_id, v_staff.id);

    v_subtotal := v_subtotal + v_line;
    -- Exclusive VAT is added to the bill; inclusive VAT is already inside v_line.
    if v_rate.id is not null and not v_rate.inclusive then
      v_vat_total := v_vat_total + v_line_vat;
    end if;

    -- Kept so the per-line VAT can be rescaled after the discount, below.
    v_item_ids := v_item_ids || v_item_id;
    v_vat_pcts := v_vat_pcts || coalesce(v_rate.pct, 0);
    v_vat_incl := v_vat_incl || coalesce(v_rate.inclusive, true);
    v_vat_amts := v_vat_amts || v_line_vat;

    v_lines := v_lines || jsonb_build_object(
      'name', v_product.name, 'qty', v_qty, 'unit_price', v_product.price,
      'line_total', v_line, 'warranty_until', v_until,
      'vat_pct', coalesce(v_rate.pct, 0), 'vat_amount', v_line_vat,
      'vat_inclusive', coalesce(v_rate.inclusive, true),
      'serials', (select coalesce(jsonb_agg(serial), '[]'::jsonb) from public.serials where id = any(v_serials)));
  end loop;

  v_discount := round(v_subtotal * v_pct / 100);

  -- A discount reduces the taxable amount, so inclusive VAT has to be recalculated on
  -- the discounted line. Skipping this overstates the tax on every discounted sale.
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

  -- Extra charges, on top, after tax on the goods.
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

  if v_approver is not null then
    insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
    values (v_shop.id, p_branch_id, v_staff.id, 'discount_approved', 'sale', v_sale_id,
            jsonb_build_object('pct', v_pct, 'amount', v_discount, 'approved_by', v_approver,
                               'approved_by_name', (select name from public.staff where id = v_approver),
                               'reason', (select name from public.discount_types where id = p_discount_type_id),
                               'invoice', v_invoice));
  end if;

  if p_payment_method = 'cash' then
    if p_cash_received is null or p_cash_received < v_total then raise exception 'CASH_SHORT'; end if;
    v_change := p_cash_received - v_total;
  elsif v_pay.needs_ref then
    if p_payment_ref is null or length(trim(p_payment_ref)) < 4 then raise exception 'PAYMENT_REF_REQUIRED'; end if;
  end if;

  if p_customer_phone is not null and p_customer_phone <> '' then
    if p_customer_phone !~ '^01[0-9]{9}$' then raise exception 'BAD_PHONE'; end if;
    insert into public.customers (shop_id, phone) values (v_shop.id, p_customer_phone)
      on conflict (shop_id, phone) do update set phone = excluded.phone
      returning id into v_customer;
  end if;

  select id into v_shift from public.shifts
    where staff_id = v_staff.id and branch_id = p_branch_id and closed_at is null
    order by opened_at desc limit 1;

  update public.sales set
    subtotal = v_subtotal, discount_pct = v_pct, discount_amount = v_discount, total = v_total,
    vat_amount = v_vat_total, charges_amount = v_charges,
    cash_received = case when p_payment_method = 'cash' then p_cash_received end,
    change_given = v_change, payment_ref = nullif(trim(coalesce(p_payment_ref, '')), ''),
    discount_approved_by = v_approver, customer_id = v_customer, shift_id = v_shift
  where id = v_sale_id;

  return jsonb_build_object(
    'id', v_sale_id, 'invoice_no', v_invoice, 'created_at', now(),
    'staff_name', v_staff.name, 'shop_name', v_shop.name, 'shop_address', v_shop.address,
    'branch_name', v_branch.name, 'branch_address', v_branch.address, 'branch_phone', v_branch.phone,
    'receipt_footer', v_shop.receipt_footer, 'bin_vat', v_shop.bin_vat, 'currency', v_shop.currency,
    'subtotal', v_subtotal, 'discount_pct', v_pct, 'discount_amount', v_discount,
    'vat_amount', v_vat_total, 'vat_included', v_vat_on and v_vat_total = 0
      and exists (select 1 from public.sale_items where sale_id = v_sale_id and vat_pct > 0),
    'charges_amount', v_charges, 'charges', v_chg_list,
    'total', v_total,
    'payment_method', p_payment_method, 'payment_label', v_pay.label,
    'cash_received', p_cash_received, 'change_given', v_change,
    'payment_ref', p_payment_ref, 'customer_phone', nullif(p_customer_phone, ''), 'items', v_lines);
end; $$;

revoke execute on function public.complete_sale(uuid, jsonb, text, numeric, uuid, text, numeric, text, jsonb, uuid, uuid) from public, anon;
grant execute on function public.complete_sale(uuid, jsonb, text, numeric, uuid, text, numeric, text, jsonb, uuid, uuid) to authenticated;

-- receive_stock now checks the permission rather than the role, so an owner can let one
-- trusted cashier take deliveries without making them a manager.
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
  if not public.has_permission('receive_stock') then raise exception 'NOT_ALLOWED:receive_stock'; end if;
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

-- Cost prices follow the permission too, not just the role.
drop policy costs_read on public.product_costs;
create policy costs_read on public.product_costs for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.has_permission('see_cost')));
