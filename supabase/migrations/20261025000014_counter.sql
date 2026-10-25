-- P10a — Counter: everything BMS's sales screen can do
--
-- BMS's sales screen has about 40 fields and 22 buttons, and a filmed sale of two audio
-- splitters took 50 seconds and 14 clicks. The capability is not the problem; the
-- arrangement is. So everything here is ADDITIVE: the simple cash sale still takes four
-- actions, and all of this appears only when it is asked for or when it is relevant.
--
-- ONE JSONB PARAMETER, NOT TWELVE MORE
-- complete_sale() already takes thirteen arguments. Adding card type, POS account, card
-- last four, EMI months, EMI bank, attention, address, BIN, NID, narration, sold-by,
-- shop-defined fields, split payments and an exchange as positional arguments would make
-- a twenty-six argument function that nobody can call correctly. They arrive together in
-- `p_extras`, because they are one thing: what the advanced counter adds to a sale.
--
-- WHAT IS ENFORCED HERE RATHER THAN ON SCREEN
--  * EMI is only offered on products the owner allows it on, for a tenure the bank
--    actually runs, above that plan's minimum. A screen that offers 36 months on a
--    350-taka adapter is how a shop ends up arguing with a bank.
--  * The card charge is the shop's decision (absorb it or add it), not the cashier's.
--  * An exchange cannot be worth more than the sale: handing a customer cash out of the
--    till for their old laptop is a different transaction, and pretending it is a sale
--    hides it.
--  * Split payments must add up to what is being paid now. Off by one taka and the
--    drawer is wrong at closing time.

-- ---------------------------------------------------------------------------
-- What the shop decides
-- ---------------------------------------------------------------------------

alter table public.shops
  -- Who pays the card company's cut. Adding it to the bill is normal here; absorbing it
  -- is a choice some shops make to win the sale.
  add column card_charge_mode text not null default 'absorb'
    check (card_charge_mode in ('absorb', 'add'));

-- EMI is allowed per product, or per category when the product says nothing. Null means
-- "whatever the category says", so a shop sets it once for Laptops rather than on 200
-- products.
alter table public.products add column emi_allowed boolean;
alter table public.categories add column emi_allowed boolean not null default false;

/** Is EMI allowed on this product? The product's own answer wins; else the category's. */
create or replace function public.emi_allowed(p_product_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p.emi_allowed, c.emi_allowed, false)
  from public.products p
  left join public.categories c on c.id = p.category_id
  where p.id = p_product_id;
$$;

-- The bank's own rules: 12 months at 4%, 24 at 8%, nothing under 10,000. These come
-- from the bank, so they are data the owner types in rather than anything hard-coded.
create table public.emi_plans (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  bank       text not null,
  months     integer not null check (months > 0 and months <= 60),
  charge_pct numeric(5,2) not null default 0 check (charge_pct >= 0 and charge_pct <= 100),
  -- Banks will not run EMI on small amounts.
  min_amount numeric(12,2) not null default 0 check (min_amount >= 0),
  active     boolean not null default true,
  unique (shop_id, bank, months)
);

-- Shop-defined extra fields on a sale (BMS "Additional Info"): "PO number", "Reference",
-- "Laptop password noted". The shop decides which go on the printed invoice.
create table public.sale_fields (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  name            text not null,
  show_on_invoice boolean not null default false,
  sort            integer not null default 0,
  active          boolean not null default true,
  unique (shop_id, name)
);

-- ---------------------------------------------------------------------------
-- What goes on the sale
-- ---------------------------------------------------------------------------

alter table public.sales
  -- Who the invoice is addressed to inside a company, and the details a corporate
  -- buyer's accounts department will ask for.
  add column attention        text,
  add column customer_address text,
  add column customer_bin     text,
  add column customer_nid     text,
  add column narration        text,
  -- Who sold it. Defaults to whoever is logged in, but a shop with floor staff and one
  -- till needs to credit the person who actually made the sale.
  add column sold_by          uuid references public.staff(id),
  -- The shop's own fields, as { "PO number": "4471" }.
  add column extra_fields     jsonb,
  -- Card details (BMS "POS A/C No" is the machine the money went through).
  add column card_type_id     uuid references public.card_types(id),
  add column card_bank        text,
  add column pos_account_id   uuid references public.bank_accounts(id),
  add column card_last4       text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  add column card_charge      numeric(12,2) not null default 0,
  -- EMI.
  add column emi_months       integer check (emi_months is null or emi_months > 0),
  add column emi_bank         text,
  add column emi_charge       numeric(12,2) not null default 0,
  -- What an old item taken in part payment was worth.
  add column exchange_value   numeric(12,2) not null default 0 check (exchange_value >= 0);

-- Split payments. The sale keeps `payment_method` as the main one, so everything built
-- on it (the sales list, the drawer check) still works; this is the breakdown.
create table public.sale_payments (
  id         uuid primary key default gen_random_uuid(),
  sale_id    uuid not null references public.sales(id) on delete cascade,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  method     text not null check (method in ('cash', 'bkash', 'nagad', 'card', 'rocket',
                                             'bank', 'cheque', 'due', 'exchange')),
  amount     numeric(12,2) not null check (amount > 0),
  reference  text,
  account_id uuid references public.bank_accounts(id)
);
create index sale_payments_sale_idx on public.sale_payments(sale_id);

-- An old item taken in part payment (BMS "Exchange"). It can go back on the shelf as a
-- used unit, or just be recorded and dealt with later.
create table public.sale_exchanges (
  id             uuid primary key default gen_random_uuid(),
  sale_id        uuid not null references public.sales(id) on delete cascade,
  shop_id        uuid not null references public.shops(id) on delete cascade,
  branch_id      uuid not null references public.branches(id),
  description    text not null,
  serial         text,
  value          numeric(12,2) not null check (value >= 0),
  -- When the shop wants to resell it, which product it was booked in as.
  product_id     uuid references public.products(id),
  added_to_stock boolean not null default false,
  created_at     timestamptz not null default now()
);
create index sale_exchanges_sale_idx on public.sale_exchanges(sale_id);

-- ---------------------------------------------------------------------------
-- Price help for the person at the counter
-- ---------------------------------------------------------------------------

/**
 * What a seller needs to know before they argue about a price: what this customer paid
 * last time, what anyone paid last time, and how many are on the shelf here and
 * elsewhere.
 *
 * Deliberately NOT cost or margin. "Show cost" is a permission (P2) and is off for
 * cashiers; this is the information that helps without handing over the shop's numbers.
 */
create or replace function public.price_help(
  p_product_id uuid, p_branch_id uuid, p_customer_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_out jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  select jsonb_build_object(
    'product_id', p_product_id,
    'last_price_to_customer', (
      select i.unit_price from public.sale_items i
      join public.sales s on s.id = i.sale_id
      where i.product_id = p_product_id and s.customer_id = p_customer_id
        and s.status = 'completed' and p_customer_id is not null
      order by s.created_at desc limit 1),
    'last_price_to_customer_on', (
      select (s.created_at at time zone 'Asia/Dhaka')::date from public.sale_items i
      join public.sales s on s.id = i.sale_id
      where i.product_id = p_product_id and s.customer_id = p_customer_id
        and s.status = 'completed' and p_customer_id is not null
      order by s.created_at desc limit 1),
    'last_price', (
      select i.unit_price from public.sale_items i
      join public.sales s on s.id = i.sale_id
      where i.product_id = p_product_id and s.status = 'completed'
      order by s.created_at desc limit 1),
    'here', coalesce((select sum(bs.qty) from public.branch_stock bs
                      where bs.product_id = p_product_id and bs.branch_id = p_branch_id), 0),
    -- Where else it is, so "we haven't got one" can become "the other branch has two".
    'elsewhere', (
      select coalesce(jsonb_agg(jsonb_build_object('branch', b.name, 'qty', q.qty)
                      order by b.name), '[]'::jsonb)
      from (select bs.branch_id, sum(bs.qty) as qty from public.branch_stock bs
            where bs.product_id = p_product_id and bs.branch_id <> p_branch_id
            group by bs.branch_id having sum(bs.qty) > 0) q
      join public.branches b on b.id = q.branch_id
      where b.id = any(select unnest(public.current_branch_ids()))),
    'emi_allowed', public.emi_allowed(p_product_id),
    'emi_plans', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', e.id, 'bank', e.bank, 'months', e.months,
               'charge_pct', e.charge_pct, 'min_amount', e.min_amount)
               order by e.bank, e.months), '[]'::jsonb)
      from public.emi_plans e
      where e.shop_id = v_me.shop_id and e.active and public.emi_allowed(p_product_id))
  ) into v_out;
  return v_out;
end; $$;

/** The bank EMI plans a shop has set up. Owner and manager only to change. */
create or replace function public.save_emi_plan(p_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row public.emi_plans;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('edit_settings') then raise exception 'NOT_ALLOWED:edit_settings'; end if;
  if p_id is null and coalesce(btrim(p_values->>'bank'), '') = '' then
    raise exception 'EMI_BANK_REQUIRED';
  end if;

  if p_id is null then
    insert into public.emi_plans (shop_id, bank, months, charge_pct, min_amount)
    values (v_me.shop_id, btrim(p_values->>'bank'),
            coalesce((p_values->>'months')::integer, 12),
            coalesce((p_values->>'charge_pct')::numeric, 0),
            coalesce((p_values->>'min_amount')::numeric, 0))
    returning * into v_row;
  else
    update public.emi_plans set
      bank = coalesce(nullif(btrim(p_values->>'bank'), ''), bank),
      months = coalesce((p_values->>'months')::integer, months),
      charge_pct = coalesce((p_values->>'charge_pct')::numeric, charge_pct),
      min_amount = coalesce((p_values->>'min_amount')::numeric, min_amount),
      active = coalesce((p_values->>'active')::boolean, active)
    where id = p_id and shop_id = v_me.shop_id
    returning * into v_row;
    if v_row.id is null then raise exception 'EMI_PLAN_NOT_FOUND'; end if;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id,
          case when p_id is null then 'emi_plan_added' else 'emi_plan_changed' end,
          'emi_plan', v_row.id,
          jsonb_build_object('bank', v_row.bank, 'months', v_row.months,
                             'charge_pct', v_row.charge_pct));
  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- The sale itself
-- ---------------------------------------------------------------------------

-- Same function again, with `p_extras` added. The new argument has a default, so the
-- thirteen-argument version has to go or every call becomes ambiguous.
drop function if exists public.complete_sale(uuid, jsonb, text, numeric, uuid, text,
                                             numeric, text, jsonb, uuid, uuid, uuid, numeric);
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
-- The extra fields are a setup list like the other ten
-- ---------------------------------------------------------------------------

create or replace function public.save_setting_row(
  p_table  text,
  p_id     uuid,
  p_values jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_cols   text[];
  v_sets   text[] := '{}';
  v_key    text;
  v_sql    text;
  v_row    jsonb;
  v_before jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('edit_settings') then raise exception 'NOT_ALLOWED:edit_settings'; end if;

  -- An allow-list, not a pattern: p_table reaches a format() call, so anything not
  -- named here must never get through. `sale_fields` joins it in P10a.
  if p_table not in ('units', 'vat_rates', 'hs_codes', 'extra_charges', 'discount_types',
                     'payment_methods', 'card_types', 'bank_accounts', 'warranty_terms',
                     'transaction_categories', 'sale_fields') then
    raise exception 'BAD_SETTING_TABLE:%', p_table;
  end if;

  select array_agg(column_name::text) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = p_table
    and column_name not in ('id', 'shop_id');

  for v_key in select jsonb_object_keys(p_values) loop
    if not (v_key = any(v_cols)) then raise exception 'BAD_SETTING_FIELD:%', v_key; end if;
    v_sets := v_sets || format('%I = ($1->>%L)::%s', v_key, v_key,
      (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = p_table and column_name = v_key));
  end loop;
  if array_length(v_sets, 1) is null then raise exception 'NOTHING_TO_SAVE'; end if;

  if p_id is null then
    v_sql := format('insert into public.%I (shop_id, %s) select $2, %s returning to_jsonb(public.%I.*)',
      p_table,
      (select string_agg(format('%I', k), ', ') from jsonb_object_keys(p_values) k),
      (select string_agg(format('($1->>%L)::%s', k,
         (select data_type from information_schema.columns
          where table_schema = 'public' and table_name = p_table and column_name = k)), ', ')
       from jsonb_object_keys(p_values) k),
      p_table);
    execute v_sql into v_row using p_values, v_me.shop_id;
  else
    execute format('select to_jsonb(t.*) from public.%I t where t.id = $1 and t.shop_id = $2', p_table)
      into v_before using p_id, v_me.shop_id;
    if v_before is null then raise exception 'SETTING_NOT_FOUND'; end if;
    v_sql := format('update public.%I set %s where id = $2 and shop_id = $3 returning to_jsonb(public.%I.*)',
                    p_table, array_to_string(v_sets, ', '), p_table);
    execute v_sql into v_row using p_values, p_id, v_me.shop_id;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id, case when p_id is null then 'setting_added' else 'setting_changed' end,
          p_table, jsonb_build_object('from', v_before, 'to', v_row));

  return v_row;
end; $$;

-- ---------------------------------------------------------------------------
-- The new shop setting
-- ---------------------------------------------------------------------------

create or replace function public.save_shop_details(p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_before jsonb; v_row jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('edit_settings') then raise exception 'NOT_ALLOWED:edit_settings'; end if;

  select to_jsonb(s.*) into v_before from public.shops s where s.id = v_me.shop_id;

  update public.shops set
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
    address = coalesce(p_values->>'address', address),
    phone = coalesce(p_values->>'phone', phone),
    email = coalesce(p_values->>'email', email),
    logo_url = coalesce(p_values->>'logo_url', logo_url),
    bin_vat = coalesce(p_values->>'bin_vat', bin_vat),
    receipt_footer = coalesce(p_values->>'receipt_footer', receipt_footer),
    invoice_prefix = coalesce(nullif(upper(btrim(p_values->>'invoice_prefix')), ''), invoice_prefix),
    currency = coalesce(nullif(upper(btrim(p_values->>'currency')), ''), currency),
    ait_pct = coalesce((p_values->>'ait_pct')::numeric, ait_pct),
    po_approval_limit = coalesce((p_values->>'po_approval_limit')::numeric, po_approval_limit),
    cash_short_limit = coalesce((p_values->>'cash_short_limit')::numeric, cash_short_limit),
    return_days = coalesce((p_values->>'return_days')::integer, return_days),
    sale_approval_limit = coalesce((p_values->>'sale_approval_limit')::numeric, sale_approval_limit),
    approve_all_sales = coalesce((p_values->>'approve_all_sales')::boolean, approve_all_sales),
    card_charge_mode = coalesce(nullif(p_values->>'card_charge_mode', ''), card_charge_mode)
  where id = v_me.shop_id
  returning to_jsonb(shops.*) into v_row;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'shop_details_changed', 'shop', v_me.shop_id,
          jsonb_build_object('from', v_before - 'id', 'to', v_row - 'id'));
  return v_row;
end; $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.emi_plans      enable row level security;
alter table public.sale_fields    enable row level security;
alter table public.sale_payments  enable row level security;
alter table public.sale_exchanges enable row level security;

-- The counter needs the plans and the field names to offer them at all.
create policy emi_plans_read on public.emi_plans for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy sale_fields_read on public.sale_fields for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy sale_payments_read on public.sale_payments for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_id
                 and s.branch_id = any(select unnest(public.current_branch_ids()))));
create policy sale_exchanges_read on public.sale_exchanges for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.emi_allowed(uuid) from public, anon;
revoke execute on function public.price_help(uuid, uuid, uuid) from public, anon;
revoke execute on function public.save_emi_plan(uuid, jsonb) from public, anon;

grant execute on function public.emi_allowed(uuid) to authenticated;
grant execute on function public.price_help(uuid, uuid, uuid) to authenticated;
grant execute on function public.save_emi_plan(uuid, jsonb) to authenticated;
grant execute on function public.complete_sale(uuid, jsonb, text, numeric, uuid, text,
  numeric, text, jsonb, uuid, uuid, uuid, numeric, jsonb) to authenticated;
