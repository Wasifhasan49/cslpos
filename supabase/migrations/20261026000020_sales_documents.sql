-- P14a — Quotations, sales orders and challans
--
-- THE PAPERWORK A CORPORATE ORDER NEEDS, AND NOTHING THE COUNTER HAS TO KNOW ABOUT
-- A walk-in buying a mouse is three taps and stays three taps (P10a). A company buying
-- ten keyboards wants a quotation on paper, then an order with an advance, then the
-- goods against a delivery note, then a bill — possibly in two deliveries, possibly
-- weeks apart. BMS has eight screens for that. This is the same chain behind one
-- feature switch, and any step can be skipped: an order can go straight to a bill, and
-- a challan can exist with no order behind it.
--
--   Quotation  →  Sales order  →  Challan (the goods leave)  →  Bill
--
-- WHAT RESERVED STOCK MEANS
-- An order holds stock at the branch. The counter shows "4 in stock, 2 reserved" and
-- will not sell the reserved two to a walk-in — because the alternative is explaining
-- to a company that the goods they ordered and paid an advance on went to somebody who
-- walked in. The reserved figure is WORKED OUT from the open orders rather than stored,
-- so it cannot drift: a stored counter that a cancelled line forgot to decrement is a
-- shop that can never sell that product again.
--
-- WHERE THE GOODS ARE BETWEEN DELIVERY AND BILLING
-- The challan takes the stock off the shelf, because it has physically gone. On the
-- books it moves to "goods delivered, not invoiced" — an asset, because the shop still
-- owns it until the bill says who bought it. The bill moves it from there to cost of
-- sales. Leaving it in stock would be the same lie P7 refuses about goods in a van.
--
-- WHY THE BILL STILL GOES THROUGH complete_sale()
-- A bill from a challan is a sale: the same VAT rules, the same discount band, the same
-- approval, the same invoice sequence, the same receipt. So it goes through the one
-- function that knows all that, with ONE documented exception — it does not move the
-- stock again, because the challan already did. That exception is a flag on p_extras,
-- not a second copy of 650 lines of sale rules.

alter table public.shop_features drop constraint shop_features_feature_check;
alter table public.shop_features add constraint shop_features_feature_check
  check (feature in (
    'vat', 'multi_location', 'price_lists', 'credit_sales', 'purchase_orders',
    'transfers', 'accounts', 'sms', 'extra_charges', 'hs_codes',
    'managers_see_dashboard', 'managers_see_accounts', 'managers_see_settings',
    -- New in P14a. Off for a new shop: a shop that sells over the counter has no use
    -- for a quotation, and should not have to look at one.
    'sales_documents'
  ));

-- QT-MB-2026000001, SO-MB-…, CH-MB-… rather than QUO/ORD/CHA, because that is what the
-- market calls them.
create or replace function public.next_document_number(p_branch_id uuid, p_doc_type text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_shop    uuid := (select public.current_shop_id());
  v_branch  public.branches;
  v_seq     public.document_sequences;
  v_default text := case p_doc_type
                      when 'transfer_request' then 'TRQ'
                      when 'quote'   then 'QT'
                      when 'order'   then 'SO'
                      when 'challan' then 'CH'
                      else upper(substr(p_doc_type, 1, 3))
                    end;
begin
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  select * into v_branch from public.branches where id = p_branch_id;

  insert into public.document_sequences (shop_id, branch_id, doc_type)
  values (v_shop, p_branch_id, p_doc_type)
  on conflict (shop_id, branch_id, doc_type) do nothing;

  select * into v_seq from public.document_sequences
    where shop_id = v_shop and branch_id = p_branch_id and doc_type = p_doc_type for update;

  update public.document_sequences set next_number = next_number + 1
    where shop_id = v_shop and branch_id = p_branch_id and doc_type = p_doc_type;

  return coalesce(nullif(v_seq.prefix, ''), v_default) || '-' || v_branch.code
         || '-' || to_char(public.dhaka_today(), 'YYYY') || lpad(v_seq.next_number::text, 6, '0');
end; $$;

-- ---------------------------------------------------------------------------
-- The documents
-- ---------------------------------------------------------------------------

create table public.quotations (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  branch_id     uuid not null references public.branches(id),
  quote_no      text not null,
  customer_id   uuid references public.customers(id) on delete set null,
  -- A company that has never bought anything yet is still worth quoting.
  customer_name text,
  customer_phone text,
  attention     text,
  address       text,
  -- After this date the prices are not promised any more. BMS has no such field, so
  -- its quotations are honoured for ever or argued about.
  valid_until   date,
  terms         text,
  note          text,
  subtotal      numeric(12,2) not null default 0,
  discount_pct  numeric(5,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  vat_amount    numeric(12,2) not null default 0,
  charges_amount numeric(12,2) not null default 0,
  total         numeric(12,2) not null default 0,
  status        text not null default 'draft'
                check (status in ('draft', 'sent', 'accepted', 'expired', 'lost')),
  status_note   text,
  staff_id      uuid not null references public.staff(id),
  created_at    timestamptz not null default now(),
  unique (shop_id, quote_no)
);
create index quotations_branch_idx on public.quotations(branch_id, created_at desc);
create index quotations_customer_idx on public.quotations(customer_id);

create table public.quotation_items (
  id            uuid primary key default gen_random_uuid(),
  quote_id      uuid not null references public.quotations(id) on delete cascade,
  shop_id       uuid not null references public.shops(id) on delete cascade,
  product_id    uuid not null references public.products(id),
  qty           integer not null check (qty > 0),
  unit_price    numeric(12,2) not null check (unit_price >= 0),
  line_discount numeric(12,2) not null default 0,
  -- BMS's "Free" column: goods thrown in. They still leave the shelf and still cost
  -- the shop money, so they are a line at zero rather than a line that is not there.
  is_free       boolean not null default false,
  line_total    numeric(12,2) not null default 0,
  note          text
);
create index quotation_items_quote_idx on public.quotation_items(quote_id);

create table public.sales_orders (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  branch_id     uuid not null references public.branches(id),
  so_no         text not null,
  quote_id      uuid references public.quotations(id) on delete set null,
  customer_id   uuid not null references public.customers(id),
  attention     text,
  address       text,
  -- When they want it. Orders past this date show red on the list, because a late
  -- order nobody has noticed is how a corporate customer is lost.
  delivery_date date,
  -- Where it goes, for a customer with more than one address (filled in by P14c).
  delivery_point_id uuid,
  sold_by       uuid references public.staff(id),
  payment_terms_days integer not null default 0 check (payment_terms_days >= 0),
  subtotal      numeric(12,2) not null default 0,
  discount_pct  numeric(5,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  vat_amount    numeric(12,2) not null default 0,
  charges_amount numeric(12,2) not null default 0,
  total         numeric(12,2) not null default 0,
  -- What they have already paid. Money the shop is holding, not money it has earned.
  advance_amount numeric(12,2) not null default 0 check (advance_amount >= 0),
  status        text not null default 'draft'
                check (status in ('draft', 'awaiting_approval', 'open', 'part_delivered',
                                  'delivered', 'billed', 'cancelled')),
  approved_by   uuid references public.staff(id),
  approved_at   timestamptz,
  cancel_reason text,
  note          text,
  terms         text,
  staff_id      uuid not null references public.staff(id),
  created_at    timestamptz not null default now(),
  unique (shop_id, so_no)
);
create index sales_orders_branch_idx on public.sales_orders(branch_id, created_at desc);
create index sales_orders_customer_idx on public.sales_orders(customer_id);
create index sales_orders_open_idx on public.sales_orders(shop_id, status)
  where status in ('open', 'part_delivered');

create table public.sales_order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.sales_orders(id) on delete cascade,
  shop_id       uuid not null references public.shops(id) on delete cascade,
  product_id    uuid not null references public.products(id),
  qty           integer not null check (qty > 0),
  -- How much of this line has physically gone, and how much has been invoiced. They
  -- are different questions: a challan can deliver goods that are billed a month later.
  delivered_qty integer not null default 0 check (delivered_qty >= 0),
  billed_qty    integer not null default 0 check (billed_qty >= 0),
  unit_price    numeric(12,2) not null check (unit_price >= 0),
  line_discount numeric(12,2) not null default 0,
  is_free       boolean not null default false,
  line_total    numeric(12,2) not null default 0,
  cancelled     boolean not null default false,
  note          text
);
create index sales_order_items_order_idx on public.sales_order_items(order_id);
create index sales_order_items_product_idx on public.sales_order_items(product_id);

/** Money taken before the goods went: the shop is holding it, not keeping it. */
create table public.customer_advances (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid not null references public.branches(id),
  order_id    uuid references public.sales_orders(id) on delete set null,
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount      numeric(12,2) not null check (amount <> 0),
  method      text not null,
  reference   text,
  -- Which sale used it up. Null means the shop is still holding it.
  used_on_sale_id uuid references public.sales(id) on delete set null,
  note        text,
  shift_id    uuid references public.shifts(id) on delete set null,
  staff_id    uuid not null references public.staff(id),
  created_at  timestamptz not null default now()
);
create index customer_advances_customer_idx on public.customer_advances(customer_id);
create index customer_advances_open_idx on public.customer_advances(shop_id)
  where used_on_sale_id is null;

create table public.challans (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  branch_id     uuid not null references public.branches(id),
  location_id   uuid not null references public.stock_locations(id),
  challan_no    text not null,
  order_id      uuid references public.sales_orders(id) on delete set null,
  customer_id   uuid not null references public.customers(id),
  attention     text,
  address       text,
  delivered_on  date not null default public.dhaka_today(),
  -- Who took it, and in what. The question asked when something does not arrive.
  carrier       text,
  vehicle_no    text,
  note          text,
  status        text not null default 'delivered'
                check (status in ('delivered', 'part_billed', 'billed', 'returned', 'cancelled')),
  -- What the goods are worth at cost, which is what sits in "delivered not invoiced".
  total_cost    numeric(12,2) not null default 0,
  staff_id      uuid not null references public.staff(id),
  created_at    timestamptz not null default now(),
  unique (shop_id, challan_no)
);
create index challans_branch_idx on public.challans(branch_id, created_at desc);
create index challans_order_idx on public.challans(order_id);
create index challans_open_idx on public.challans(shop_id, status)
  where status in ('delivered', 'part_billed');

create table public.challan_items (
  id            uuid primary key default gen_random_uuid(),
  challan_id    uuid not null references public.challans(id) on delete cascade,
  shop_id       uuid not null references public.shops(id) on delete cascade,
  product_id    uuid not null references public.products(id),
  order_item_id uuid references public.sales_order_items(id) on delete set null,
  qty           integer not null check (qty > 0),
  returned_qty  integer not null default 0 check (returned_qty >= 0),
  billed_qty    integer not null default 0 check (billed_qty >= 0),
  unit_price    numeric(12,2) not null default 0,
  line_discount numeric(12,2) not null default 0,
  is_free       boolean not null default false,
  unit_cost     numeric(12,2),
  note          text
);
create index challan_items_challan_idx on public.challan_items(challan_id);

create table public.challan_item_serials (
  challan_item_id uuid not null references public.challan_items(id) on delete cascade,
  serial_id       uuid not null references public.serials(id),
  -- Null until it is billed or comes back.
  returned        boolean not null default false,
  primary key (challan_item_id, serial_id)
);

-- A delivered serial is neither on the shelf nor sold: it is at the customer's, on a
-- delivery note, and the shop still owns it.
alter table public.serials drop constraint serials_status_check;
alter table public.serials add constraint serials_status_check
  check (status in ('in_stock', 'sold', 'returned', 'rma', 'in_transit',
                    'with_supplier', 'delivered'));

-- Which delivery note a bill came from, so the books know the goods have already left.
alter table public.sales add column challan_id uuid references public.challans(id) on delete set null;
alter table public.sales add column order_id uuid references public.sales_orders(id) on delete set null;

-- Stock left the building on a delivery note. Its own reason, because "sold" would be
-- a lie until somebody bills it.
alter table public.stock_movements drop constraint stock_movements_reason_check;
alter table public.stock_movements add constraint stock_movements_reason_check
  check (reason in ('purchase', 'sale', 'return', 'adjust_in', 'adjust_out',
                    'return_to_supplier', 'transfer_in', 'transfer_out', 'count',
                    'delivered', 'delivery_returned'));

-- ---------------------------------------------------------------------------
-- Reserved stock
-- ---------------------------------------------------------------------------

/**
 * How many of this product, at this branch, are promised to somebody already.
 *
 * WORKED OUT, not stored. A stored counter that a cancelled line forgot to decrement
 * leaves a shop unable to sell a product it has on the shelf, and nobody can tell why.
 * This can only ever be wrong if an order is wrong, which is visible.
 *
 * `p_ignore_order` is for billing the order itself: a line cannot be blocked by its own
 * reservation.
 */
create or replace function public.reserved_qty(
  p_product_id uuid, p_branch_id uuid, p_ignore_order uuid default null
) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(greatest(i.qty - i.delivered_qty, 0)), 0)::integer
  from public.sales_order_items i
  join public.sales_orders o on o.id = i.order_id
  where i.product_id = p_product_id
    and o.branch_id = p_branch_id
    and o.status in ('open', 'part_delivered', 'awaiting_approval')
    and not i.cancelled
    and (p_ignore_order is null or o.id <> p_ignore_order);
$$;

/** On the shelf, minus what is already promised. What a walk-in may actually buy. */
create or replace function public.available_qty(
  p_product_id uuid, p_branch_id uuid, p_ignore_order uuid default null
) returns integer
language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce((select sum(bs.qty) from public.branch_stock bs
              where bs.product_id = p_product_id and bs.branch_id = p_branch_id), 0)
    - case when public.feature_on('sales_documents')
           then public.reserved_qty(p_product_id, p_branch_id, p_ignore_order) else 0 end,
    0)::integer;
$$;

-- ---------------------------------------------------------------------------
-- Quotations
-- ---------------------------------------------------------------------------

/**
 * Write or change a quotation.
 *
 * Prices come from the customer's price list, the same as at the counter — a quotation
 * at a price the till will refuse to honour is worse than no quotation. A quotation
 * moves no stock and no money: it is a promise about prices, nothing more.
 */
create or replace function public.save_quotation(
  p_id uuid, p_values jsonb, p_lines jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_id      uuid := p_id;
  v_branch  uuid := (p_values->>'branch_id')::uuid;
  v_line    jsonb;
  v_product public.products;
  v_price   numeric(12,2);
  v_qty     integer;
  v_sub     numeric(12,2) := 0;
  v_vat     numeric(12,2) := 0;
  -- Inclusive VAT is already inside the price; only exclusive VAT is added on top.
  -- Same rule as the till (P2), and getting it wrong overstates every quotation.
  v_vat_add numeric(12,2) := 0;
  v_line_vat numeric(12,2);
  v_rate    public.vat_rates;
  v_amount  numeric(12,2);
  v_pct     numeric(5,2) := coalesce((p_values->>'discount_pct')::numeric, 0);
  v_disc    numeric(12,2);
  v_list    uuid;
  v_cust    uuid := (p_values->>'customer_id')::uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('sales_documents') then raise exception 'FEATURE_OFF:sales_documents'; end if;
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;
  if v_id is null and not public.can_use_branch(v_branch) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'EMPTY_SALE'; end if;

  if v_id is null then
    insert into public.quotations (shop_id, branch_id, quote_no, customer_id, customer_name,
      customer_phone, attention, address, valid_until, terms, note, discount_pct, staff_id)
    values (v_me.shop_id, v_branch, public.next_document_number(v_branch, 'quote'),
            v_cust, p_values->>'customer_name', p_values->>'customer_phone',
            p_values->>'attention', p_values->>'address',
            (p_values->>'valid_until')::date, p_values->>'terms', p_values->>'note',
            v_pct, v_me.id)
    returning id into v_id;
  else
    -- A quotation that has been accepted is a promise somebody is relying on.
    if (select status from public.quotations where id = v_id and shop_id = v_me.shop_id)
       <> 'draft' then
      raise exception 'QUOTE_NOT_DRAFT';
    end if;
    update public.quotations set
      customer_id = v_cust, customer_name = p_values->>'customer_name',
      customer_phone = p_values->>'customer_phone', attention = p_values->>'attention',
      address = p_values->>'address', valid_until = (p_values->>'valid_until')::date,
      terms = p_values->>'terms', note = p_values->>'note', discount_pct = v_pct
    where id = v_id and shop_id = v_me.shop_id;
    if not found then raise exception 'QUOTE_NOT_FOUND'; end if;
    delete from public.quotation_items where quote_id = v_id;
    select branch_id into v_branch from public.quotations where id = v_id;
  end if;

  if v_cust is not null then
    select price_list_id into v_list from public.customers where id = v_cust;
  end if;

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    select * into v_product from public.products
      where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id and active;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    v_qty := coalesce((v_line->>'qty')::integer, 0);
    if v_qty <= 0 then raise exception 'BAD_QTY:%', v_product.name; end if;

    if coalesce((v_line->>'is_free')::boolean, false) then
      v_price := 0;
    else
      v_price := coalesce((v_line->>'unit_price')::numeric,
                          public.resolve_price(v_product.id, v_branch, v_list));
    end if;
    v_amount := round(v_price * v_qty - coalesce((v_line->>'line_discount')::numeric, 0), 2);
    v_sub := v_sub + v_amount;

    insert into public.quotation_items (quote_id, shop_id, product_id, qty, unit_price,
                                        line_discount, is_free, line_total, note)
    values (v_id, v_me.shop_id, v_product.id, v_qty, v_price,
            coalesce((v_line->>'line_discount')::numeric, 0),
            coalesce((v_line->>'is_free')::boolean, false), v_amount, v_line->>'note');

    -- VAT the same way the till works it out: per line, on the discounted figure.
    if public.feature_on('vat') and v_product.vat_rate_id is not null then
      select * into v_rate from public.vat_rates where id = v_product.vat_rate_id;
      if found then
        v_line_vat := public.vat_on(round(v_amount * (100 - v_pct) / 100, 2),
                                    v_rate.percent, v_rate.is_inclusive);
        v_vat := v_vat + v_line_vat;
        if not v_rate.is_inclusive then v_vat_add := v_vat_add + v_line_vat; end if;
      end if;
    end if;
  end loop;

  v_disc := round(v_sub * v_pct / 100, 2);
  update public.quotations set
    subtotal = v_sub, discount_amount = v_disc, vat_amount = v_vat,
    total = round(v_sub - v_disc + v_vat_add, 2)
  where id = v_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_branch, v_me.id, 'quotation_saved', 'quotation', v_id,
          jsonb_build_object('lines', jsonb_array_length(p_lines)));

  return (select jsonb_build_object('id', q.id, 'quote_no', q.quote_no, 'total', q.total,
                                    'status', q.status)
          from public.quotations q where q.id = v_id);
end; $$;

/** Sent, accepted, expired or lost. Knowing which is how a shop learns anything. */
create or replace function public.set_quotation_status(
  p_id uuid, p_status text, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_q public.quotations;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  select * into v_q from public.quotations where id = p_id and shop_id = v_me.shop_id;
  if not found then raise exception 'QUOTE_NOT_FOUND'; end if;
  if p_status not in ('draft', 'sent', 'accepted', 'expired', 'lost') then
    raise exception 'BAD_QUOTE_STATUS:%', p_status;
  end if;
  -- "Lost" wants a reason: which competitor, and on what. That is the only way a
  -- quotation log teaches the shop anything.
  if p_status = 'lost' and coalesce(trim(p_note), '') = '' then
    raise exception 'REASON_REQUIRED';
  end if;

  update public.quotations set status = p_status, status_note = p_note where id = p_id;
  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_q.branch_id, v_me.id, 'quotation_' || p_status, 'quotation', p_id,
          jsonb_build_object('quote_no', v_q.quote_no, 'note', p_note));
  return jsonb_build_object('id', p_id, 'status', p_status);
end; $$;
