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
                          (public.resolve_price(v_product.id, v_branch, v_list)->>'price')::numeric);
    end if;
    v_amount := round(v_price * v_qty - coalesce((v_line->>'line_discount')::numeric, 0), 2);
    v_sub := v_sub + v_amount;

    insert into public.quotation_items (quote_id, shop_id, product_id, qty, unit_price,
                                        line_discount, is_free, line_total, note)
    values (v_id, v_me.shop_id, v_product.id, v_qty, v_price,
            coalesce((v_line->>'line_discount')::numeric, 0),
            coalesce((v_line->>'is_free')::boolean, false), v_amount, v_line->>'note');

    -- VAT the same way the till works it out: per line, on the discounted figure.
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

-- An order over this goes to the owner instead of out. 0 means "no ceiling set", the
-- same convention as the purchase-order limit (P6).
alter table public.shops
  add column so_approval_limit numeric(12,2) not null default 0
    check (so_approval_limit >= 0);

-- ---------------------------------------------------------------------------
-- Sales orders
-- ---------------------------------------------------------------------------

/**
 * Write or change an order.
 *
 * An order with no customer is a debt and a promise belonging to nobody, so unlike a
 * quotation it needs a real one (the same rule as a credit sale, P10).
 *
 * Saving does not check stock. The shop can accept an order for goods it has not got
 * yet — that is what an order IS — and the reservation only ever holds back what is
 * actually on the shelf.
 */
create or replace function public.save_sales_order(
  p_id uuid, p_values jsonb, p_lines jsonb, p_approval_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_shop    public.shops;
  v_id      uuid := p_id;
  v_branch  uuid := (p_values->>'branch_id')::uuid;
  v_line    jsonb;
  v_product public.products;
  v_price   numeric(12,2);
  v_qty     integer;
  v_sub     numeric(12,2) := 0;
  v_amount  numeric(12,2);
  v_pct     numeric(5,2) := coalesce((p_values->>'discount_pct')::numeric, 0);
  v_disc    numeric(12,2);
  v_total   numeric(12,2);
  v_list    uuid;
  v_cust    uuid := (p_values->>'customer_id')::uuid;
  v_status  text;
  v_approver uuid;
  v_need_ok boolean := false;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('sales_documents') then raise exception 'FEATURE_OFF:sales_documents'; end if;
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'EMPTY_SALE'; end if;
  if v_cust is null then raise exception 'CREDIT_NEEDS_CUSTOMER'; end if;
  select * into v_shop from public.shops where id = v_me.shop_id;

  if v_id is not null then
    select status into v_status from public.sales_orders
      where id = v_id and shop_id = v_me.shop_id;
    if v_status is null then raise exception 'ORDER_NOT_FOUND'; end if;
    -- Once goods have gone, the order is history. Changing quantities is what
    -- adjust_sales_order() is for, and it says what changed and why.
    if v_status not in ('draft', 'awaiting_approval', 'open') then
      raise exception 'ORDER_ALREADY_MOVING';
    end if;
    select branch_id into v_branch from public.sales_orders where id = v_id;
  elsif not public.can_use_branch(v_branch) then
    raise exception 'BRANCH_NOT_ALLOWED';
  end if;

  select price_list_id into v_list from public.customers where id = v_cust;

  -- First pass: work the money out, so the approval decision is made before anything
  -- is written (the same order of operations as the till).
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
                          (public.resolve_price(v_product.id, v_branch, v_list)->>'price')::numeric);
    end if;
    v_sub := v_sub + round(v_price * v_qty - coalesce((v_line->>'line_discount')::numeric, 0), 2);
  end loop;
  v_disc := round(v_sub * v_pct / 100, 2);

  if v_pct > public.permission_limit('give_discount') then v_need_ok := true; end if;
  if v_shop.so_approval_limit > 0 and v_sub - v_disc > v_shop.so_approval_limit then
    v_need_ok := true;
  end if;
  -- A manager signing in person clears it now; otherwise the order waits for one,
  -- because an order is a promise the shop has to keep.
  if v_need_ok and p_approval_id is not null then
    update public.pin_attempts set used_at = now()
      where id = p_approval_id and shop_id = v_me.shop_id and ok
        and used_at is null and created_at > now() - interval '10 minutes'
      returning approver_id into v_approver;
    if v_approver is null then raise exception 'APPROVAL_NOT_VALID'; end if;
    v_need_ok := false;
  end if;

  if v_id is null then
    insert into public.sales_orders (shop_id, branch_id, so_no, quote_id, customer_id,
      attention, address, delivery_date, delivery_point_id, sold_by,
      payment_terms_days, discount_pct, note, terms, staff_id)
    values (v_me.shop_id, v_branch, public.next_document_number(v_branch, 'order'),
            (p_values->>'quote_id')::uuid, v_cust,
            p_values->>'attention', p_values->>'address',
            (p_values->>'delivery_date')::date, (p_values->>'delivery_point_id')::uuid,
            coalesce((p_values->>'sold_by')::uuid, v_me.id),
            coalesce((p_values->>'payment_terms_days')::integer,
                     (select payment_days from public.customers where id = v_cust), 0),
            v_pct, p_values->>'note', p_values->>'terms', v_me.id)
    returning id into v_id;
  else
    update public.sales_orders set
      customer_id = v_cust, attention = p_values->>'attention',
      address = p_values->>'address',
      delivery_date = (p_values->>'delivery_date')::date,
      delivery_point_id = (p_values->>'delivery_point_id')::uuid,
      sold_by = coalesce((p_values->>'sold_by')::uuid, sold_by),
      payment_terms_days = coalesce((p_values->>'payment_terms_days')::integer, payment_terms_days),
      discount_pct = v_pct, note = p_values->>'note', terms = p_values->>'terms'
    where id = v_id;
    delete from public.sales_order_items where order_id = v_id;
  end if;

  v_sub := 0;
  for v_line in select e from jsonb_array_elements(p_lines) e loop
    select * into v_product from public.products
      where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id and active;
    v_qty := (v_line->>'qty')::integer;
    if coalesce((v_line->>'is_free')::boolean, false) then
      v_price := 0;
    else
      v_price := coalesce((v_line->>'unit_price')::numeric,
                          (public.resolve_price(v_product.id, v_branch, v_list)->>'price')::numeric);
    end if;
    v_amount := round(v_price * v_qty - coalesce((v_line->>'line_discount')::numeric, 0), 2);
    v_sub := v_sub + v_amount;

    insert into public.sales_order_items (order_id, shop_id, product_id, qty, unit_price,
                                          line_discount, is_free, line_total, note)
    values (v_id, v_me.shop_id, v_product.id, v_qty, v_price,
            coalesce((v_line->>'line_discount')::numeric, 0),
            coalesce((v_line->>'is_free')::boolean, false), v_amount, v_line->>'note');

  end loop;

  perform public.recalc_order_totals(v_id);
  select total into v_total from public.sales_orders where id = v_id;
  v_status := case
    when coalesce(p_values->>'send', 'false') <> 'true' then 'draft'
    when v_need_ok then 'awaiting_approval'
    else 'open' end;

  update public.sales_orders set
    status = v_status,
    approved_by = case when v_approver is not null then v_approver else approved_by end,
    approved_at = case when v_approver is not null then now() else approved_at end
  where id = v_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_branch, v_me.id, 'sales_order_saved', 'sales_order', v_id,
          jsonb_build_object('total', v_total, 'status', v_status,
                             'approved_by', v_approver, 'discount_pct', v_pct));

  return (select jsonb_build_object('id', o.id, 'so_no', o.so_no, 'total', o.total,
                                    'status', o.status, 'waiting_for_approval',
                                    o.status = 'awaiting_approval')
          from public.sales_orders o where o.id = v_id);
end; $$;


/** Add an order up from its lines. One place, so a change and a save cannot differ. */
create or replace function public.recalc_order_totals(p_order_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_o public.sales_orders; v_i record; v_rate public.vat_rates;
  v_sub numeric(12,2) := 0; v_vat numeric(12,2) := 0; v_add numeric(12,2) := 0;
  v_lv numeric(12,2); v_disc numeric(12,2);
begin
  select * into v_o from public.sales_orders where id = p_order_id;
  for v_i in
    select i.*, p.vat_rate_id from public.sales_order_items i
    join public.products p on p.id = i.product_id
    where i.order_id = p_order_id and not i.cancelled
  loop
    v_sub := v_sub + v_i.line_total;
    if public.feature_on('vat') and v_i.vat_rate_id is not null then
      select * into v_rate from public.vat_rates where id = v_i.vat_rate_id;
      if found then
        v_lv := public.vat_on(round(v_i.line_total * (100 - v_o.discount_pct) / 100, 2),
                              v_rate.percent, v_rate.is_inclusive);
        v_vat := v_vat + v_lv;
        if not v_rate.is_inclusive then v_add := v_add + v_lv; end if;
      end if;
    end if;
  end loop;
  v_disc := round(v_sub * v_o.discount_pct / 100, 2);
  update public.sales_orders set
    subtotal = v_sub, discount_amount = v_disc, vat_amount = v_vat,
    total = round(v_sub - v_disc + v_add, 2)
  where id = p_order_id;
end; $$;

/**
 * Change what is still outstanding on a live order, or call lines off (BMS's "Sales
 * Order Adjustment").
 *
 * A quantity can never go below what has already gone out of the door, and cancelling
 * a line releases its reservation — which is the whole point: stock held for an order
 * nobody is going to take is stock the shop cannot sell.
 */
create or replace function public.adjust_sales_order(
  p_order_id uuid, p_lines jsonb, p_note text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_order public.sales_orders;
  v_line  jsonb;
  v_item  public.sales_order_items;
  v_qty   integer;
  v_was   jsonb := '[]'::jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
  select * into v_order from public.sales_orders where id = p_order_id and shop_id = v_me.shop_id;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status in ('billed', 'cancelled') then raise exception 'ORDER_CLOSED'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'REASON_REQUIRED'; end if;

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    select * into v_item from public.sales_order_items
      where id = (v_line->>'id')::uuid and order_id = p_order_id;
    if not found then raise exception 'SALE_LINE_NOT_FOUND'; end if;

    if coalesce((v_line->>'cancel')::boolean, false) then
      if v_item.delivered_qty > 0 then raise exception 'ALREADY_DELIVERED:%', v_item.id; end if;
      update public.sales_order_items set cancelled = true where id = v_item.id;
      v_was := v_was || jsonb_build_object('line', v_item.id, 'cancelled', true,
                                           'was_qty', v_item.qty);
    else
      v_qty := coalesce((v_line->>'qty')::integer, v_item.qty);
      if v_qty < v_item.delivered_qty then
        raise exception 'LESS_THAN_DELIVERED:%', v_item.delivered_qty;
      end if;
      if v_qty <= 0 then raise exception 'BAD_QTY'; end if;
      update public.sales_order_items set
        qty = v_qty,
        line_total = round(unit_price * v_qty - line_discount, 2)
      where id = v_item.id;
      v_was := v_was || jsonb_build_object('line', v_item.id, 'was_qty', v_item.qty,
                                           'now_qty', v_qty);
    end if;
  end loop;

  perform public.recalc_order_totals(p_order_id);
  update public.sales_orders set note = coalesce(note || ' · ', '') || p_note
    where id = p_order_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_order.branch_id, v_me.id, 'sales_order_adjusted', 'sales_order',
          p_order_id, jsonb_build_object('so_no', v_order.so_no, 'note', p_note,
                                         'changes', v_was));

  return jsonb_build_object('id', p_order_id, 'changes', jsonb_array_length(v_was));
end; $$;

/** Approve an order that was waiting, send a draft out, or call the whole thing off. */
create or replace function public.set_order_status(
  p_order_id uuid, p_action text, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_order public.sales_orders; v_status text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  select * into v_order from public.sales_orders where id = p_order_id and shop_id = v_me.shop_id;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  if p_action = 'send' then
    if v_order.status <> 'draft' then raise exception 'ORDER_NOT_DRAFT'; end if;
    v_status := 'open';
  elsif p_action = 'approve' then
    if v_order.status <> 'awaiting_approval' then raise exception 'ORDER_NOT_WAITING'; end if;
    if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
    -- Nobody approves their own order. The same rule as a purchase requisition (P6).
    if v_order.staff_id = v_me.id then raise exception 'NO_SELF_APPROVAL'; end if;
    v_status := 'open';
  elsif p_action = 'cancel' then
    if v_order.status in ('billed', 'cancelled') then raise exception 'ORDER_CLOSED'; end if;
    if exists (select 1 from public.sales_order_items
               where order_id = p_order_id and delivered_qty > 0) then
      raise exception 'ALREADY_DELIVERED:%', v_order.so_no;
    end if;
    if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
    if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
    v_status := 'cancelled';
  else
    raise exception 'BAD_ORDER_ACTION:%', p_action;
  end if;

  update public.sales_orders set
    status = v_status,
    approved_by = case when p_action = 'approve' then v_me.id else approved_by end,
    approved_at = case when p_action = 'approve' then now() else approved_at end,
    cancel_reason = case when p_action = 'cancel' then p_reason else cancel_reason end
  where id = p_order_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_order.branch_id, v_me.id, 'sales_order_' || p_action,
          'sales_order', p_order_id,
          jsonb_build_object('so_no', v_order.so_no, 'reason', p_reason));

  return jsonb_build_object('id', p_order_id, 'status', v_status);
end; $$;

/**
 * Money taken before the goods go.
 *
 * It is NOT income and it is not a payment against an invoice — there is no invoice yet.
 * The shop is holding the customer's money, which is a liability until the bill exists.
 * Cash goes through the open drawer (P8), so the till still counts at the end of the day.
 */
create or replace function public.record_advance(
  p_order_id uuid, p_amount numeric, p_method text default 'cash',
  p_reference text default null, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_order public.sales_orders;
  v_id    uuid;
  v_shift uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  select * into v_order from public.sales_orders where id = p_order_id and shop_id = v_me.shop_id;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status in ('cancelled') then raise exception 'ORDER_CLOSED'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_PAYMENT_AMOUNT'; end if;
  if not exists (select 1 from public.payment_methods
                 where shop_id = v_me.shop_id and key = p_method and enabled) then
    raise exception 'BAD_PAYMENT_METHOD:%', p_method;
  end if;
  -- More than the order is worth is not an advance, it is a mistake with a decimal point.
  if v_order.advance_amount + p_amount > v_order.total and v_order.total > 0 then
    raise exception 'ADVANCE_OVER_ORDER';
  end if;

  if p_method = 'cash' then
    select id into v_shift from public.shifts
      where branch_id = v_order.branch_id and closed_at is null
      order by opened_at desc limit 1;
  end if;

  insert into public.customer_advances (shop_id, branch_id, order_id, customer_id, amount,
                                        method, reference, note, shift_id, staff_id)
  values (v_me.shop_id, v_order.branch_id, p_order_id, v_order.customer_id, p_amount,
          p_method, p_reference, p_note, v_shift, v_me.id)
  returning id into v_id;

  update public.sales_orders set advance_amount = advance_amount + p_amount
    where id = p_order_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_order.branch_id, v_me.id, 'advance_received', 'sales_order',
          p_order_id, jsonb_build_object('so_no', v_order.so_no, 'amount', p_amount,
                                         'method', p_method));

  return jsonb_build_object('id', v_id, 'order_id', p_order_id, 'amount', p_amount,
                            'advance_total', v_order.advance_amount + p_amount);
end; $$;

-- ---------------------------------------------------------------------------
-- Challans: the goods leave
-- ---------------------------------------------------------------------------

/**
 * Deliver goods, against an order or on their own.
 *
 * The stock comes off the shelf NOW, because it has physically gone. On the books it
 * moves to "goods delivered, not invoiced": the shop still owns it until a bill says
 * who bought it, so it is still an asset, just not one on a shelf. A serial goes to
 * `delivered` — neither in stock nor sold, which is the truth, and what stops it being
 * sold to somebody else while it sits at the customer's.
 *
 * Partial deliveries are the normal case, so the order keeps ordered / delivered /
 * pending per line rather than a single status.
 */
create or replace function public.save_challan(
  p_branch_id uuid, p_values jsonb, p_lines jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_order   public.sales_orders;
  v_id      uuid;
  v_no      text;
  v_line    jsonb;
  v_product public.products;
  v_item    public.sales_order_items;
  v_item_id uuid;
  v_qty     integer;
  v_serials uuid[];
  v_found   integer;
  v_stock   integer;
  v_location uuid;
  v_cost    numeric(12,2);
  v_total   numeric(12,2) := 0;
  v_cust    uuid := (p_values->>'customer_id')::uuid;
  v_out     jsonb := '[]'::jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('sales_documents') then raise exception 'FEATURE_OFF:sales_documents'; end if;
  if not public.has_permission('sell') then raise exception 'NOT_ALLOWED:sell'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_DELIVERED'; end if;

  if p_values->>'order_id' is not null then
    select * into v_order from public.sales_orders
      where id = (p_values->>'order_id')::uuid and shop_id = v_me.shop_id;
    if not found then raise exception 'ORDER_NOT_FOUND'; end if;
    if v_order.status not in ('open', 'part_delivered') then raise exception 'ORDER_NOT_OPEN'; end if;
    v_cust := v_order.customer_id;
  end if;
  if v_cust is null then raise exception 'CREDIT_NEEDS_CUSTOMER'; end if;

  v_location := coalesce((p_values->>'location_id')::uuid, public.default_location(p_branch_id));
  if v_location is null then raise exception 'NO_STOCK_LOCATION'; end if;

  v_no := public.next_document_number(p_branch_id, 'challan');
  insert into public.challans (shop_id, branch_id, location_id, challan_no, order_id,
                               customer_id, attention, address, delivered_on, carrier,
                               vehicle_no, note, staff_id)
  values (v_me.shop_id, p_branch_id, v_location, v_no, v_order.id, v_cust,
          coalesce(p_values->>'attention', v_order.attention),
          coalesce(p_values->>'address', v_order.address),
          coalesce((p_values->>'delivered_on')::date, public.dhaka_today()),
          p_values->>'carrier', p_values->>'vehicle_no', p_values->>'note', v_me.id)
  returning id into v_id;

  -- In product order, like the till, so two deliveries of the same goods cannot
  -- deadlock against each other.
  for v_line in select e from jsonb_array_elements(p_lines) e order by (e->>'product_id') loop
    select * into v_product from public.products
      where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id and active;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

    v_item := null;
    if v_line->>'order_item_id' is not null then
      select * into v_item from public.sales_order_items
        where id = (v_line->>'order_item_id')::uuid and order_id = v_order.id and not cancelled;
      if not found then raise exception 'SALE_LINE_NOT_FOUND'; end if;
    end if;

    v_qty := coalesce((v_line->>'qty')::integer, 0);
    v_serials := coalesce(array(select jsonb_array_elements_text(
                                  coalesce(v_line->'serial_ids', '[]'::jsonb))::uuid), '{}');
    if v_product.is_serial then
      v_qty := coalesce(array_length(v_serials, 1), 0);
      if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
    elsif v_qty <= 0 then
      raise exception 'BAD_QTY:%', v_product.name;
    end if;

    -- Never more than the order still has outstanding.
    if v_item.id is not null and v_qty > v_item.qty - v_item.delivered_qty then
      raise exception 'MORE_THAN_ORDERED:%', v_product.name;
    end if;

    if v_product.is_inventory then
      select qty into v_stock from public.branch_stock
        where product_id = v_product.id and location_id = v_location for update;
      if coalesce(v_stock, 0) < v_qty then raise exception 'OUT_OF_STOCK:%', v_product.name; end if;
      update public.branch_stock set qty = qty - v_qty, updated_at = now()
        where product_id = v_product.id and location_id = v_location;
    end if;

    if v_product.is_serial then
      update public.serials set status = 'delivered'
        where id = any(v_serials) and product_id = v_product.id and shop_id = v_me.shop_id
          and status = 'in_stock'
          and location_id in (select id from public.stock_locations where branch_id = p_branch_id);
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    end if;

    select cost into v_cost from public.product_costs where product_id = v_product.id;
    v_total := v_total + round(coalesce(v_cost, 0) * v_qty, 2);

    insert into public.challan_items (challan_id, shop_id, product_id, order_item_id, qty,
                                      unit_price, line_discount, is_free, unit_cost, note)
    values (v_id, v_me.shop_id, v_product.id, v_item.id, v_qty,
            coalesce(v_item.unit_price, (v_line->>'unit_price')::numeric,
                     (public.resolve_price(v_product.id, p_branch_id,
                        (select price_list_id from public.customers where id = v_cust))->>'price')::numeric),
            coalesce(v_item.line_discount, 0),
            coalesce(v_item.is_free, (v_line->>'is_free')::boolean, false),
            v_cost, v_line->>'note')
    returning id into v_item_id;

    if v_product.is_serial then
      insert into public.challan_item_serials (challan_item_id, serial_id)
      select v_item_id, s from unnest(v_serials) s;
    end if;

    if v_product.is_inventory then
      insert into public.stock_movements (shop_id, branch_id, location_id, product_id,
                                          qty_change, reason, ref_id, staff_id, note)
      values (v_me.shop_id, p_branch_id, v_location, v_product.id, -v_qty, 'delivered',
              v_id, v_me.id, v_no);
    end if;

    if v_item.id is not null then
      update public.sales_order_items set delivered_qty = delivered_qty + v_qty
        where id = v_item.id;
    end if;

    v_out := v_out || jsonb_build_object('product', v_product.name, 'qty', v_qty);
  end loop;

  update public.challans set total_cost = v_total where id = v_id;

  -- Where the order stands now: everything gone, or some of it.
  if v_order.id is not null then
    update public.sales_orders set status = case
      when not exists (select 1 from public.sales_order_items
                       where order_id = v_order.id and not cancelled
                         and delivered_qty < qty) then 'delivered'
      else 'part_delivered' end
    where id = v_order.id;
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'challan_delivered', 'challan', v_id,
          jsonb_build_object('challan_no', v_no, 'order', v_order.so_no,
                             'at_cost', v_total, 'lines', v_out));

  return jsonb_build_object('id', v_id, 'challan_no', v_no, 'at_cost', v_total,
                            'order_status', (select status from public.sales_orders
                                             where id = v_order.id),
                            'lines', v_out);
end; $$;

/**
 * Goods coming back off a delivery note, before anybody billed them.
 *
 * Not a sales return: nothing was sold, so there is nothing to refund. The stock goes
 * back on the shelf and the order's delivered figure comes down, so the line is
 * outstanding again and the reservation holds once more.
 */
create or replace function public.return_challan(
  p_challan_id uuid, p_lines jsonb, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_ch      public.challans;
  v_line    jsonb;
  v_item    public.challan_items;
  v_qty     integer;
  v_serials uuid[];
  v_product public.products;
  v_back    integer := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('return_sale') then raise exception 'NOT_ALLOWED:return_sale'; end if;
  select * into v_ch from public.challans where id = p_challan_id and shop_id = v_me.shop_id;
  if not found then raise exception 'CHALLAN_NOT_FOUND'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    select * into v_item from public.challan_items
      where id = (v_line->>'id')::uuid and challan_id = p_challan_id;
    if not found then raise exception 'SALE_LINE_NOT_FOUND'; end if;
    select * into v_product from public.products where id = v_item.product_id;

    v_serials := coalesce(array(select jsonb_array_elements_text(
                                  coalesce(v_line->'serial_ids', '[]'::jsonb))::uuid), '{}');
    v_qty := coalesce((v_line->>'qty')::integer, 0);
    if v_product.is_serial then v_qty := coalesce(array_length(v_serials, 1), 0); end if;
    if v_qty <= 0 then continue; end if;
    -- Billed goods are a sales return, which refunds money; this does not.
    if v_qty > v_item.qty - v_item.returned_qty - v_item.billed_qty then
      raise exception 'MORE_THAN_DELIVERED:%', v_product.name;
    end if;

    if v_product.is_inventory then
      insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
      values (v_item.product_id, v_ch.location_id, v_me.shop_id, v_ch.branch_id, v_qty)
      on conflict (product_id, location_id) do update
        set qty = public.branch_stock.qty + v_qty, updated_at = now();
      insert into public.stock_movements (shop_id, branch_id, location_id, product_id,
                                          qty_change, reason, ref_id, staff_id, note)
      values (v_me.shop_id, v_ch.branch_id, v_ch.location_id, v_item.product_id, v_qty,
              'delivery_returned', p_challan_id, v_me.id,
              v_ch.challan_no || ': came back');
    end if;

    if v_product.is_serial then
      update public.serials set status = 'in_stock', location_id = v_ch.location_id
        where id = any(v_serials) and status = 'delivered' and shop_id = v_me.shop_id;
      update public.challan_item_serials set returned = true
        where challan_item_id = v_item.id and serial_id = any(v_serials);
    end if;

    update public.challan_items set returned_qty = returned_qty + v_qty where id = v_item.id;
    if v_item.order_item_id is not null then
      update public.sales_order_items set delivered_qty = greatest(delivered_qty - v_qty, 0)
        where id = v_item.order_item_id;
    end if;
    v_back := v_back + v_qty;
  end loop;

  if v_back = 0 then raise exception 'NOTHING_RETURNED'; end if;

  update public.challans set
    status = case when not exists (select 1 from public.challan_items
                                   where challan_id = p_challan_id
                                     and qty > returned_qty) then 'returned'
                  else status end,
    note = coalesce(note || ' · ', '') || p_reason
  where id = p_challan_id;

  -- The order has outstanding lines again.
  if v_ch.order_id is not null then
    update public.sales_orders set status = case
      when exists (select 1 from public.sales_order_items
                   where order_id = v_ch.order_id and not cancelled and delivered_qty < qty)
        and status = 'delivered' then 'part_delivered'
      else status end
    where id = v_ch.order_id;
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_ch.branch_id, v_me.id, 'challan_returned', 'challan', p_challan_id,
          jsonb_build_object('challan_no', v_ch.challan_no, 'qty', v_back, 'reason', p_reason));

  return jsonb_build_object('id', p_challan_id, 'returned', v_back);
end; $$;

-- ---------------------------------------------------------------------------
-- Billing: the same sale function, with the stock already gone
-- ---------------------------------------------------------------------------
--
-- complete_sale() again, unchanged except for four lines: a bill that names a challan
-- does not move the stock (the delivery note did) and takes its serials from
-- `delivered` rather than `in_stock`, and the sale remembers which papers it came from.
-- A sibling function would have meant a second copy of six hundred lines of sale rules,
-- and the second copy is always the one that falls behind.

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
  -- P14a: this bill is for goods that already went out on a delivery note. The ONE
  -- thing that changes is that the stock does not move again — everything else about a
  -- sale (prices, VAT, discount band, approval, invoice number, receipt) is identical,
  -- which is why this is a flag rather than a second copy of this function.
  v_challan   uuid := (v_x->>'challan_id')::uuid;
  v_order_id  uuid := (v_x->>'order_id')::uuid;
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
                            payment_method, discount_type_id, transaction_category_id,
                            challan_id, order_id)
  values (v_sale_id, v_shop.id, p_branch_id, v_invoice, v_staff.id, 0, 0,
          p_payment_method, p_discount_type_id, p_category_id, v_challan, v_order_id);

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
          and status = case when v_challan is null then 'in_stock' else 'delivered' end
          and location_id in (select id from public.stock_locations where branch_id = p_branch_id);
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    elsif v_qty <= 0 then
      raise exception 'BAD_QTY:%', v_product.name;
    end if;

    -- A service has no stock to take. It still goes on the bill. Nor does a bill for
    -- goods already delivered: the challan took them off the shelf when the van left.
    if v_product.is_inventory and v_challan is null then
      select qty into v_stock from public.branch_stock
        where product_id = v_product.id and location_id = v_location for update;
      if v_stock is null then
        insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
        values (v_product.id, v_location, v_shop.id, p_branch_id, 0)
        on conflict (product_id, location_id) do nothing;
        v_stock := 0;
      end if;
      -- Out of stock is the plainer answer, so it comes first: a shelf with nothing on
      -- it is not "reserved". Then — stock promised to an order is not available to a
      -- walk-in. Billing the order itself passes its own id, because a line cannot be
      -- blocked by its own reservation.
      if v_stock < v_qty then raise exception 'OUT_OF_STOCK:%', v_product.name; end if;
      if public.available_qty(v_product.id, p_branch_id, v_order_id) < v_qty then
        raise exception 'RESERVED_FOR_AN_ORDER:%', v_product.name;
      end if;
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

/**
 * Bill a delivery note.
 *
 * Takes the lines that have gone out and not yet been invoiced, applies whatever advance
 * the order is holding, and sends the rest through the till's own function. The advance
 * is applied FIRST and what is left decides whether anything is still owed — a customer
 * who paid 5,000 up front on a 6,000 delivery owes 1,000, not 6,000.
 */
create or replace function public.bill_challan(
  p_challan_id uuid, p_payment_method text default 'cash',
  p_cash_received numeric default null, p_payment_ref text default null,
  p_due_amount numeric default null, p_approval_id uuid default null,
  p_extras jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_ch     public.challans;
  v_items  jsonb := '[]'::jsonb;
  v_i      record;
  v_phone  text;
  v_sale   jsonb;
  v_adv    numeric(12,2) := 0;
  v_use    numeric(12,2) := 0;
  v_total  numeric(12,2);
  v_due    numeric(12,2);
  v_list   uuid;
  v_pct    numeric(5,2) := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  select * into v_ch from public.challans where id = p_challan_id and shop_id = v_me.shop_id;
  if not found then raise exception 'CHALLAN_NOT_FOUND'; end if;
  if v_ch.status in ('billed', 'cancelled') then raise exception 'CHALLAN_ALREADY_BILLED'; end if;

  for v_i in
    select ci.*, p.is_serial,
           (select coalesce(jsonb_agg(s.serial_id), '[]'::jsonb)
            from public.challan_item_serials s
            where s.challan_item_id = ci.id and not s.returned) as serial_ids
    from public.challan_items ci
    join public.products p on p.id = ci.product_id
    where ci.challan_id = p_challan_id
      and ci.qty - ci.returned_qty - ci.billed_qty > 0
  loop
    v_items := v_items || jsonb_build_object(
      'product_id', v_i.product_id,
      'qty', v_i.qty - v_i.returned_qty - v_i.billed_qty,
      'unit_price', v_i.unit_price,
      'serial_ids', v_i.serial_ids);
  end loop;
  if jsonb_array_length(v_items) = 0 then raise exception 'NOTHING_TO_BILL'; end if;

  select phone, price_list_id into v_phone, v_list
    from public.customers where id = v_ch.customer_id;
  if v_ch.order_id is not null then
    select discount_pct into v_pct from public.sales_orders where id = v_ch.order_id;
  end if;

  -- What the customer has already handed over, against this order.
  select coalesce(sum(amount), 0) into v_adv from public.customer_advances
    where order_id = v_ch.order_id and used_on_sale_id is null;

  v_sale := public.complete_sale(
    p_branch_id        => v_ch.branch_id,
    p_items            => v_items,
    p_payment_method   => p_payment_method,
    p_discount_pct     => v_pct,
    p_approval_id      => p_approval_id,
    p_customer_phone   => v_phone,
    p_cash_received    => p_cash_received,
    p_payment_ref      => p_payment_ref,
    p_price_list_id    => v_list,
    p_due_amount       => coalesce(p_due_amount, 0),
    p_extras           => coalesce(p_extras, '{}'::jsonb)
                          || jsonb_build_object('challan_id', p_challan_id,
                                                'order_id', v_ch.order_id));

  v_total := (v_sale->>'total')::numeric;
  v_use := least(v_adv, v_total);
  if v_use > 0 then
    update public.customer_advances set used_on_sale_id = (v_sale->>'id')::uuid
      where order_id = v_ch.order_id and used_on_sale_id is null;
    -- The advance pays for this bill, so it is not still owed.
    update public.sales set paid_amount = least(paid_amount + v_use, total),
                            due_amount = greatest(total - least(paid_amount + v_use, total), 0)
      where id = (v_sale->>'id')::uuid;
    select due_amount into v_due from public.sales where id = (v_sale->>'id')::uuid;
  end if;

  update public.challan_items set billed_qty = qty - returned_qty where challan_id = p_challan_id;
  update public.challans set status = 'billed' where id = p_challan_id;

  if v_ch.order_id is not null then
    update public.sales_order_items i set billed_qty = least(i.delivered_qty, i.qty)
      where i.order_id = v_ch.order_id;
    update public.sales_orders set status = case
      when not exists (select 1 from public.sales_order_items
                       where order_id = v_ch.order_id and not cancelled and billed_qty < qty)
        then 'billed' else status end
    where id = v_ch.order_id;
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_ch.branch_id, v_me.id, 'challan_billed', 'challan', p_challan_id,
          jsonb_build_object('challan_no', v_ch.challan_no, 'invoice', v_sale->>'invoice_no',
                             'advance_used', v_use));

  return v_sale || jsonb_build_object('challan_no', v_ch.challan_no,
                                      'advance_used', v_use,
                                      'still_owed', coalesce(v_due, (v_sale->>'due_amount')::numeric, 0));
end; $$;

/**
 * Bill an order with no delivery note in between — the goods go now.
 *
 * Writes the challan first and bills that, so there is always a delivery note behind a
 * bill. One path for the goods leaving, whether or not the shop printed the note.
 */
create or replace function public.bill_order(
  p_order_id uuid, p_payment_method text default 'cash',
  p_cash_received numeric default null, p_payment_ref text default null,
  p_due_amount numeric default null, p_approval_id uuid default null,
  p_extras jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_order public.sales_orders;
  v_lines jsonb := '[]'::jsonb;
  v_i     record;
  v_ch    jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  select * into v_order from public.sales_orders
    where id = p_order_id and shop_id = v_me.shop_id;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status not in ('open', 'part_delivered') then raise exception 'ORDER_NOT_OPEN'; end if;

  for v_i in
    select i.id, i.product_id, i.qty - i.delivered_qty as left_to_go
    from public.sales_order_items i
    where i.order_id = p_order_id and not i.cancelled and i.qty > i.delivered_qty
  loop
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_i.product_id, 'order_item_id', v_i.id, 'qty', v_i.left_to_go,
      'serial_ids', coalesce(
        (select jsonb_agg(x) from jsonb_array_elements(
           coalesce(p_extras->'serials'->(v_i.product_id::text), '[]'::jsonb)) x),
        '[]'::jsonb));
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'NOTHING_TO_BILL'; end if;

  v_ch := public.save_challan(v_order.branch_id,
    jsonb_build_object('order_id', p_order_id), v_lines);

  return public.bill_challan((v_ch->>'id')::uuid, p_payment_method, p_cash_received,
                             p_payment_ref, p_due_amount, p_approval_id, p_extras);
end; $$;

-- ---------------------------------------------------------------------------
-- The books
-- ---------------------------------------------------------------------------
--
-- Two accounts this chain needs, and nothing else changes:
--
-- "Money held for customers" is a LIABILITY. An advance is not income and not a payment
-- against an invoice — there is no invoice yet. The shop is holding somebody else's
-- money and owes them either goods or a refund. Treating it as income is how a shop
-- books profit on an order it has not delivered.
--
-- "Goods delivered, not invoiced" is an ASSET. Between the van leaving and the bill
-- going out, the goods are not on a shelf and are not yet a sale. They are still the
-- shop's, so they are still worth what they cost — just not stock. Leaving them in
-- stock is the same lie P7 refuses about goods in a van.

alter table public.accounts drop constraint accounts_role_check;
alter table public.accounts add constraint accounts_role_check
  check (role is null or role in (
    'cash_in_hand', 'bank', 'wallet', 'receivable', 'payable', 'inventory',
    'vat_payable', 'sales', 'sales_return', 'cogs', 'discount_given',
    'purchase_return', 'stock_loss', 'stock_gain', 'inter_branch',
    'card_charge', 'opening_equity', 'rounding',
    'vat_input', 'ait_advance', 'stock_in_transit',
    -- New in P14a.
    'customer_advance', 'goods_delivered'));

create or replace function public.seed_sales_doc_accounts(p_shop_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in
    select * from (values
      ('1360', 'Goods delivered, not invoiced', 'Current assets',      'goods_delivered'),
      ('2150', 'Money held for customers',      'Current liabilities', 'customer_advance')
    ) as t(code, name, grp, role)
  loop
    insert into public.accounts (shop_id, group_id, code, name, role)
    select p_shop_id, ag.id, g.code, g.name, g.role
    from public.account_groups ag
    where ag.shop_id = p_shop_id and ag.name = g.grp
    on conflict (shop_id, code) do nothing;
  end loop;
end; $$;

select public.seed_sales_doc_accounts(id) from public.shops
where exists (select 1 from public.accounts a where a.shop_id = shops.id);

create or replace function public.add_shop_accounts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_accounts(new.id);
  perform public.seed_report_accounts(new.id);
  perform public.seed_sales_doc_accounts(new.id);
  return new;
end; $$;

/**
 * Stock moving, with two more reasons it can move.
 *
 * Goods going out on a delivery note leave stock and land in "delivered, not invoiced";
 * goods coming back off one do the reverse. Valued at the cost captured on the movement
 * (P14), so what leaves one account is exactly what arrives in the other.
 */
create or replace function public.post_stock_movement(new public.stock_movements)
returns void
language plpgsql security definer set search_path = public as $$
declare v_cost numeric(14,2); v_value numeric(14,2); v_qty integer := abs(new.qty_change);
begin
  if new.qty_change = 0 or new.branch_id is null then return; end if;
  if new.reason in ('sale', 'return', 'return_to_supplier') then return; end if;
  if new.reason = 'purchase' and new.ref_id is not null then return; end if;
  if not public.feature_on('accounts') then return; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'stock_adjust' and source_id = new.id) then
    return;
  end if;

  v_cost := new.unit_cost;
  if v_cost is null and new.reason in ('transfer_out', 'transfer_in') and new.ref_id is not null then
    select ti.unit_cost into v_cost from public.transfer_items ti
    where ti.transfer_id = new.ref_id and ti.product_id = new.product_id limit 1;
  end if;
  if v_cost is null then
    select cost into v_cost from public.product_costs where product_id = new.product_id;
  end if;
  v_value := round(coalesce(v_cost, 0) * v_qty, 2);
  if v_value = 0 then return; end if;

  if new.reason = 'transfer_out' then
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at), coalesce(new.note, 'Stock sent out'),
      jsonb_build_array(
        jsonb_build_object('role', 'stock_in_transit', 'debit', v_value),
        jsonb_build_object('role', 'inventory', 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  elsif new.reason = 'transfer_in' then
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at), coalesce(new.note, 'Stock arrived'),
      jsonb_build_array(
        jsonb_build_object('role', 'inventory', 'debit', v_value),
        jsonb_build_object('role', 'stock_in_transit', 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  elsif new.reason = 'delivered' then
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at),
      coalesce(new.note, 'Delivered, not yet invoiced'),
      jsonb_build_array(
        jsonb_build_object('role', 'goods_delivered', 'debit', v_value),
        jsonb_build_object('role', 'inventory', 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  elsif new.reason = 'delivery_returned' then
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at),
      coalesce(new.note, 'Came back off a delivery note'),
      jsonb_build_array(
        jsonb_build_object('role', 'inventory', 'debit', v_value),
        jsonb_build_object('role', 'goods_delivered', 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  elsif new.qty_change > 0 and new.reason = 'purchase' then
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at), coalesce(new.note, 'Taken in part-exchange'),
      jsonb_build_array(
        jsonb_build_object('role', 'inventory', 'debit', v_value),
        jsonb_build_object('role', 'sales', 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  elsif new.qty_change > 0 then
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at), coalesce(new.note, 'Stock found'),
      jsonb_build_array(
        jsonb_build_object('role', 'inventory', 'debit', v_value),
        jsonb_build_object(
          'role', case when new.note ilike 'opening stock%' then 'opening_equity'
                       else 'stock_gain' end, 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  else
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at), coalesce(new.note, 'Stock written off'),
      jsonb_build_array(
        jsonb_build_object('role', 'stock_loss', 'debit', v_value),
        jsonb_build_object('role', 'inventory', 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  end if;
end; $$;

/** An advance: money in, and a liability for as long as the shop is holding it. */
create or replace function public.post_advance() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.feature_on('accounts') then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'customer_payment' and source_id = new.id) then
    return new;
  end if;
  perform public.post_entry(new.shop_id, new.branch_id,
    public.dhaka_date(new.created_at),
    'Advance received on ' || coalesce(
      (select so_no from public.sales_orders where id = new.order_id), 'an order'),
    jsonb_build_array(
      jsonb_build_object('account_id',
        public.account_for_method(new.shop_id, new.method, new.branch_id),
        'debit', new.amount),
      jsonb_build_object('role', 'customer_advance', 'credit', new.amount,
                         'customer_id', new.customer_id)),
    'customer_payment', new.id, new.staff_id);
  return new;
end; $$;

create trigger customer_advances_post
  after insert on public.customer_advances
  for each row execute function public.post_advance();

/**
 * The advance being spent.
 *
 * The bill has already posted what the customer owes. This takes the money the shop was
 * holding and sets it against that, which is what "applying an advance" means: the
 * liability goes, and the customer owes that much less.
 */
create or replace function public.post_advance_use() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_invoice text;
begin
  if not public.feature_on('accounts') then return new; end if;
  if new.used_on_sale_id is null or old.used_on_sale_id is not null then return new; end if;
  select invoice_no into v_invoice from public.sales where id = new.used_on_sale_id;
  perform public.post_entry(new.shop_id, new.branch_id, public.dhaka_today(),
    'Advance applied to ' || coalesce(v_invoice, 'a bill'),
    jsonb_build_array(
      jsonb_build_object('role', 'customer_advance', 'debit', new.amount,
                         'customer_id', new.customer_id),
      jsonb_build_object('role', 'receivable', 'credit', new.amount,
                         'customer_id', new.customer_id)),
    'customer_payment', new.id, new.staff_id);
  return new;
end; $$;

create trigger customer_advances_post_use
  after update of used_on_sale_id on public.customer_advances
  for each row execute function public.post_advance_use();

-- post_sale() again, with one change: a bill for goods that already went out on a
-- delivery note takes its cost of sales out of "delivered, not invoiced" rather than out
-- of stock.

create or replace function public.post_sale() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_lines jsonb := '[]'::jsonb;
  v_cogs  numeric(14,2);
  v_paid  numeric(14,2);
  v_goods numeric(14,2);
begin
  if not public.feature_on('accounts') then return new; end if;
  if new.status <> 'completed' then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'sale' and source_id = new.id) then
    return new;
  end if;

  v_paid := greatest(coalesce(new.paid_amount, new.total), 0);
  -- What the goods themselves earned, before VAT and charges: that is what "sales" means.
  v_goods := new.total - coalesce(new.vat_amount, 0) - coalesce(new.charges_amount, 0)
             - coalesce(new.card_charge, 0) - coalesce(new.emi_charge, 0);

  -- Money in, by however it arrived.
  if v_paid > 0 then
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.account_for_method(new.shop_id, new.payment_method, new.branch_id),
      'debit', v_paid, 'note', 'Paid on ' || new.invoice_no);
  end if;
  -- And what is still owed, against that customer.
  if coalesce(new.due_amount, 0) > 0 then
    v_lines := v_lines || jsonb_build_object(
      'role', 'receivable', 'debit', new.due_amount,
      'customer_id', new.customer_id, 'note', 'On due from ' || new.invoice_no);
  end if;
  -- The discount is money the shop chose to give away, not income it never had.
  if coalesce(new.discount_amount, 0) > 0 then
    v_lines := v_lines || jsonb_build_object(
      'role', 'discount_given', 'debit', new.discount_amount,
      'note', 'Discount on ' || new.invoice_no);
  end if;

  v_lines := v_lines || jsonb_build_object(
    'role', 'sales', 'credit', v_goods + coalesce(new.discount_amount, 0),
    'note', new.invoice_no);
  if coalesce(new.vat_amount, 0) > 0 then
    v_lines := v_lines || jsonb_build_object(
      'role', 'vat_payable', 'credit', new.vat_amount, 'note', 'VAT on ' || new.invoice_no);
  end if;
  if coalesce(new.charges_amount, 0) + coalesce(new.card_charge, 0)
     + coalesce(new.emi_charge, 0) > 0 then
    v_lines := v_lines || jsonb_build_object(
      'role', 'sales', 'credit', coalesce(new.charges_amount, 0) + coalesce(new.card_charge, 0)
                                 + coalesce(new.emi_charge, 0),
      'note', 'Charges on ' || new.invoice_no);
  end if;

  perform public.post_entry(new.shop_id, new.branch_id,
    (new.created_at at time zone 'Asia/Dhaka')::date,
    'Sale ' || new.invoice_no, v_lines, 'sale', new.id, new.staff_id);

  -- The goods leaving the shelf is its own event: stock down, cost of sales up. It uses
  -- the SAME captured cost the dashboard's profit uses, so the two cannot disagree.
  select coalesce(sum(c.unit_cost * i.qty), 0) into v_cogs
  from public.sale_items i
  join public.sale_item_costs c on c.sale_item_id = i.id
  where i.sale_id = new.id;

  if v_cogs > 0 then
    -- Where the goods come OUT of depends on whether they are still on a shelf. A bill
    -- for a delivery note takes them out of "delivered, not invoiced", because the
    -- challan already took them out of stock; taking them out of stock twice would show
    -- the shop half the goods it has.
    perform public.post_entry(new.shop_id, new.branch_id,
      (new.created_at at time zone 'Asia/Dhaka')::date,
      'Cost of goods on ' || new.invoice_no,
      jsonb_build_array(
        jsonb_build_object('role', 'cogs', 'debit', v_cogs),
        jsonb_build_object(
          'role', case when new.challan_id is null then 'inventory' else 'goods_delivered' end,
          'credit', v_cogs)),
      'sale', new.id, new.staff_id);
  end if;

  return new;
end; $$;

-- The counter's product list, with what is promised to somebody else. Serials sitting at
-- a customer's on a delivery note are listed separately, because billing a challan has
-- to pick from those rather than from the shelf.

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
      -- Promised to an order and not yet gone. The counter shows "4 in stock, 2
      -- reserved" and will not sell the two: the alternative is explaining to a company
      -- that the goods they ordered and paid an advance on went to a walk-in.
      'reserved', case when not p.is_inventory then 0
                       else public.reserved_qty(p.id, p_branch_id) end,
      'serials', coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'serial', s.serial) order by s.serial)
        from public.serials s
        join public.stock_locations l on l.id = s.location_id
        where s.product_id = p.id and s.status = 'in_stock' and l.branch_id = p_branch_id
      ), '[]'::jsonb),
      'delivered_serials', coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'serial', s.serial) order by s.serial)
        from public.serials s
        join public.stock_locations l on l.id = s.location_id
        where s.product_id = p.id and s.status = 'delivered' and l.branch_id = p_branch_id
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

-- ---------------------------------------------------------------------------
-- The lists
-- ---------------------------------------------------------------------------

/** Open quotations, newest first, with whether they have run out of time. */
create or replace function public.quotation_list(
  p_branch_id uuid default null, p_status text default null,
  p_from date default null, p_to date default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id, 'quote_no', q.quote_no, 'date', public.dhaka_date(q.created_at),
      'branch', b.name, 'branch_id', q.branch_id,
      'customer', coalesce(c.name_text, c.company, q.customer_name, q.customer_phone, '—'),
      'customer_id', q.customer_id,
      'total', q.total, 'status', q.status, 'valid_until', q.valid_until,
      -- A quotation past its date is not binding any more, and saying so is the point
      -- of having the date: BMS has no such field, so its quotations are argued about.
      'out_of_date', q.valid_until is not null and q.valid_until < public.dhaka_today()
                     and q.status in ('draft', 'sent'),
      'lines', (select count(*) from public.quotation_items qi where qi.quote_id = q.id),
      'who', s.name)
      order by q.created_at desc), '[]'::jsonb)
    from public.quotations q
    join public.branches b on b.id = q.branch_id
    join public.staff s on s.id = q.staff_id
    left join public.customers c on c.id = q.customer_id
    where q.shop_id = v_me.shop_id
      and public.can_use_branch(q.branch_id)
      and (p_branch_id is null or q.branch_id = p_branch_id)
      and (p_status is null or q.status = p_status)
      and (p_from is null or public.dhaka_date(q.created_at) >= p_from)
      and (p_to is null or public.dhaka_date(q.created_at) <= p_to));
end; $$;

/** Orders, with what is still to go and whether the delivery date has passed. */
create or replace function public.order_list(
  p_branch_id uuid default null, p_status text default null,
  p_from date default null, p_to date default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'so_no', o.so_no, 'date', public.dhaka_date(o.created_at),
      'branch', b.name, 'branch_id', o.branch_id,
      'customer', coalesce(c.name_text, c.company, c.phone), 'customer_id', o.customer_id,
      'delivery_date', o.delivery_date, 'status', o.status,
      'total', o.total, 'advance', o.advance_amount,
      'ordered', (select coalesce(sum(i.qty), 0) from public.sales_order_items i
                  where i.order_id = o.id and not i.cancelled),
      'delivered', (select coalesce(sum(i.delivered_qty), 0) from public.sales_order_items i
                    where i.order_id = o.id and not i.cancelled),
      'pending', (select coalesce(sum(greatest(i.qty - i.delivered_qty, 0)), 0)
                  from public.sales_order_items i
                  where i.order_id = o.id and not i.cancelled),
      -- Late: the day they were promised has gone and something is still outstanding.
      -- A late order nobody has noticed is how a corporate customer is lost.
      'late', o.delivery_date is not null and o.delivery_date < public.dhaka_today()
              and o.status in ('open', 'part_delivered'),
      'days_late', case when o.delivery_date is not null and o.delivery_date < public.dhaka_today()
                             and o.status in ('open', 'part_delivered')
                        then public.dhaka_today() - o.delivery_date end,
      'quote_no', (select q.quote_no from public.quotations q where q.id = o.quote_id),
      'who', s.name, 'sold_by', sb.name)
      order by o.delivery_date nulls last, o.created_at desc), '[]'::jsonb)
    from public.sales_orders o
    join public.branches b on b.id = o.branch_id
    join public.staff s on s.id = o.staff_id
    left join public.staff sb on sb.id = o.sold_by
    join public.customers c on c.id = o.customer_id
    where o.shop_id = v_me.shop_id
      and public.can_use_branch(o.branch_id)
      and (p_branch_id is null or o.branch_id = p_branch_id)
      and (p_status is null or o.status = p_status
           or (p_status = 'open' and o.status in ('open', 'part_delivered')))
      and (p_from is null or public.dhaka_date(o.created_at) >= p_from)
      and (p_to is null or public.dhaka_date(o.created_at) <= p_to));
end; $$;

/** Delivery notes, and how long each unbilled one has been out. */
create or replace function public.challan_list(
  p_branch_id uuid default null, p_status text default null,
  p_from date default null, p_to date default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', ch.id, 'challan_no', ch.challan_no, 'date', ch.delivered_on,
      'branch', b.name, 'branch_id', ch.branch_id,
      'customer', coalesce(c.name_text, c.company, c.phone), 'customer_id', ch.customer_id,
      'order_no', (select o.so_no from public.sales_orders o where o.id = ch.order_id),
      'order_id', ch.order_id,
      'status', ch.status, 'at_cost', ch.total_cost,
      'carrier', ch.carrier, 'vehicle_no', ch.vehicle_no,
      'qty', (select coalesce(sum(i.qty - i.returned_qty), 0) from public.challan_items i
              where i.challan_id = ch.id),
      'to_bill', (select coalesce(sum(i.qty - i.returned_qty - i.billed_qty), 0)
                  from public.challan_items i where i.challan_id = ch.id),
      -- Days out with no bill. This is the figure to chase on: goods gone, money not
      -- asked for, and nobody looking.
      'days_unbilled', case when ch.status in ('delivered', 'part_billed')
                            then public.dhaka_today() - ch.delivered_on end,
      'invoice_no', (select sl.invoice_no from public.sales sl where sl.challan_id = ch.id
                     order by sl.created_at limit 1),
      'who', s.name)
      order by ch.delivered_on desc, ch.created_at desc), '[]'::jsonb)
    from public.challans ch
    join public.branches b on b.id = ch.branch_id
    join public.staff s on s.id = ch.staff_id
    join public.customers c on c.id = ch.customer_id
    where ch.shop_id = v_me.shop_id
      and public.can_use_branch(ch.branch_id)
      and (p_branch_id is null or ch.branch_id = p_branch_id)
      and (p_status is null or ch.status = p_status
           or (p_status = 'unbilled' and ch.status in ('delivered', 'part_billed')))
      and (p_from is null or ch.delivered_on >= p_from)
      and (p_to is null or ch.delivered_on <= p_to));
end; $$;

/** Money the shop is holding and has not yet set against a bill. */
create or replace function public.advance_list(p_branch_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'date', public.dhaka_date(a.created_at),
      'customer', coalesce(c.name_text, c.company, c.phone), 'customer_id', a.customer_id,
      'order_no', (select o.so_no from public.sales_orders o where o.id = a.order_id),
      'order_id', a.order_id, 'amount', a.amount, 'method', a.method,
      'reference', a.reference, 'branch', b.name,
      'days_held', public.dhaka_today() - public.dhaka_date(a.created_at),
      'who', s.name)
      order by a.created_at), '[]'::jsonb)
    from public.customer_advances a
    join public.branches b on b.id = a.branch_id
    join public.staff s on s.id = a.staff_id
    join public.customers c on c.id = a.customer_id
    where a.shop_id = v_me.shop_id and a.used_on_sale_id is null
      and public.can_use_branch(a.branch_id)
      and (p_branch_id is null or a.branch_id = p_branch_id));
end; $$;

/** One document, with its lines, for the screen and for printing. */
create or replace function public.sales_document(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_out jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  if p_kind = 'quotation' then
    select jsonb_build_object(
      'kind', 'quotation', 'id', q.id, 'no', q.quote_no,
      'date', public.dhaka_date(q.created_at), 'status', q.status,
      'branch', b.name, 'branch_id', q.branch_id,
      'customer', coalesce(c.name_text, c.company, q.customer_name, '—'),
      'customer_id', q.customer_id, 'phone', coalesce(c.phone, q.customer_phone),
      'attention', q.attention, 'address', coalesce(q.address, c.address),
      'valid_until', q.valid_until, 'terms', q.terms, 'note', q.note,
      'subtotal', q.subtotal, 'discount_pct', q.discount_pct,
      'discount_amount', q.discount_amount, 'vat_amount', q.vat_amount,
      'total', q.total, 'who', s.name,
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', i.id, 'product_id', i.product_id, 'product', p.name, 'code', p.code,
          'qty', i.qty, 'unit_price', i.unit_price, 'line_discount', i.line_discount,
          'is_free', i.is_free, 'line_total', i.line_total, 'note', i.note,
          'is_serial', p.is_serial) order by p.name), '[]'::jsonb)
        from public.quotation_items i join public.products p on p.id = i.product_id
        where i.quote_id = q.id))
      into v_out
    from public.quotations q
    join public.branches b on b.id = q.branch_id
    join public.staff s on s.id = q.staff_id
    left join public.customers c on c.id = q.customer_id
    where q.id = p_id and q.shop_id = v_me.shop_id;

  elsif p_kind = 'order' then
    select jsonb_build_object(
      'kind', 'order', 'id', o.id, 'no', o.so_no,
      'date', public.dhaka_date(o.created_at), 'status', o.status,
      'branch', b.name, 'branch_id', o.branch_id,
      'customer', coalesce(c.name_text, c.company, c.phone), 'customer_id', o.customer_id,
      'phone', c.phone, 'attention', o.attention,
      'address', coalesce(o.address, c.address),
      'delivery_date', o.delivery_date, 'payment_terms_days', o.payment_terms_days,
      'terms', o.terms, 'note', o.note,
      'subtotal', o.subtotal, 'discount_pct', o.discount_pct,
      'discount_amount', o.discount_amount, 'vat_amount', o.vat_amount,
      'total', o.total, 'advance', o.advance_amount,
      'quote_no', (select q.quote_no from public.quotations q where q.id = o.quote_id),
      'who', s.name, 'sold_by', sb.name,
      'approved_by', (select st.name from public.staff st where st.id = o.approved_by),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', i.id, 'product_id', i.product_id, 'product', p.name, 'code', p.code,
          'qty', i.qty, 'delivered_qty', i.delivered_qty, 'billed_qty', i.billed_qty,
          'pending_qty', greatest(i.qty - i.delivered_qty, 0),
          'unit_price', i.unit_price, 'line_discount', i.line_discount,
          'is_free', i.is_free, 'line_total', i.line_total, 'cancelled', i.cancelled,
          'note', i.note, 'is_serial', p.is_serial,
          'in_stock', public.available_qty(i.product_id, o.branch_id, o.id))
          order by p.name), '[]'::jsonb)
        from public.sales_order_items i join public.products p on p.id = i.product_id
        where i.order_id = o.id),
      'challans', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', ch.id, 'challan_no', ch.challan_no, 'date', ch.delivered_on,
          'status', ch.status) order by ch.delivered_on), '[]'::jsonb)
        from public.challans ch where ch.order_id = o.id))
      into v_out
    from public.sales_orders o
    join public.branches b on b.id = o.branch_id
    join public.staff s on s.id = o.staff_id
    left join public.staff sb on sb.id = o.sold_by
    join public.customers c on c.id = o.customer_id
    where o.id = p_id and o.shop_id = v_me.shop_id;

  elsif p_kind = 'challan' then
    select jsonb_build_object(
      'kind', 'challan', 'id', ch.id, 'no', ch.challan_no, 'date', ch.delivered_on,
      'status', ch.status, 'branch', b.name, 'branch_id', ch.branch_id,
      'customer', coalesce(c.name_text, c.company, c.phone), 'customer_id', ch.customer_id,
      'phone', c.phone, 'attention', ch.attention,
      'address', coalesce(ch.address, c.address),
      'carrier', ch.carrier, 'vehicle_no', ch.vehicle_no, 'note', ch.note,
      'order_no', (select o.so_no from public.sales_orders o where o.id = ch.order_id),
      'order_id', ch.order_id, 'who', s.name,
      'invoice_no', (select sl.invoice_no from public.sales sl where sl.challan_id = ch.id
                     order by sl.created_at limit 1),
      'advance_waiting', coalesce((select sum(a.amount) from public.customer_advances a
                                   where a.order_id = ch.order_id and a.used_on_sale_id is null), 0),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', i.id, 'product_id', i.product_id, 'product', p.name, 'code', p.code,
          'qty', i.qty, 'returned_qty', i.returned_qty, 'billed_qty', i.billed_qty,
          'to_bill', i.qty - i.returned_qty - i.billed_qty,
          'unit_price', i.unit_price, 'is_free', i.is_free, 'is_serial', p.is_serial,
          'serials', (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', se.id, 'serial', se.serial, 'returned', cs.returned)), '[]'::jsonb)
                      from public.challan_item_serials cs
                      join public.serials se on se.id = cs.serial_id
                      where cs.challan_item_id = i.id))
          order by p.name), '[]'::jsonb)
        from public.challan_items i join public.products p on p.id = i.product_id
        where i.challan_id = ch.id))
      into v_out
    from public.challans ch
    join public.branches b on b.id = ch.branch_id
    join public.staff s on s.id = ch.staff_id
    join public.customers c on c.id = ch.customer_id
    where ch.id = p_id and ch.shop_id = v_me.shop_id;
  else
    raise exception 'BAD_DOCUMENT_KIND:%', p_kind;
  end if;

  if v_out is null then raise exception 'DOCUMENT_NOT_FOUND'; end if;
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- Who may read what
-- ---------------------------------------------------------------------------
--
-- Read for anybody in the shop who may sell (the counter has to see that stock is
-- reserved, and a delivery is handed over by whoever is there). Written only through
-- the functions above, which is why there are no insert or update policies.

alter table public.quotations          enable row level security;
alter table public.quotation_items     enable row level security;
alter table public.sales_orders        enable row level security;
alter table public.sales_order_items   enable row level security;
alter table public.challans            enable row level security;
alter table public.challan_items       enable row level security;
alter table public.challan_item_serials enable row level security;
alter table public.customer_advances   enable row level security;

create policy quotations_read on public.quotations for select to authenticated
  using (shop_id = (select public.current_shop_id()) and public.can_use_branch(branch_id));
create policy quotation_items_read on public.quotation_items for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy sales_orders_read on public.sales_orders for select to authenticated
  using (shop_id = (select public.current_shop_id()) and public.can_use_branch(branch_id));
create policy sales_order_items_read on public.sales_order_items for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy challans_read on public.challans for select to authenticated
  using (shop_id = (select public.current_shop_id()) and public.can_use_branch(branch_id));
create policy challan_items_read on public.challan_items for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy challan_item_serials_read on public.challan_item_serials for select to authenticated
  using (exists (select 1 from public.challan_items i
                 where i.id = challan_item_id and i.shop_id = (select public.current_shop_id())));
-- An advance is money, so it is the manager's business, not the counter's.
create policy customer_advances_read on public.customer_advances for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('view_reports')));

grant select on public.quotations, public.quotation_items, public.sales_orders,
                public.sales_order_items, public.challans, public.challan_items,
                public.challan_item_serials, public.customer_advances to authenticated;

grant execute on function public.save_quotation(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.set_quotation_status(uuid, text, text) to authenticated;
grant execute on function public.save_sales_order(uuid, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.adjust_sales_order(uuid, jsonb, text) to authenticated;
grant execute on function public.set_order_status(uuid, text, text) to authenticated;
grant execute on function public.record_advance(uuid, numeric, text, text, text) to authenticated;
grant execute on function public.save_challan(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.return_challan(uuid, jsonb, text) to authenticated;
grant execute on function public.bill_challan(uuid, text, numeric, text, numeric, uuid, jsonb) to authenticated;
grant execute on function public.bill_order(uuid, text, numeric, text, numeric, uuid, jsonb) to authenticated;
grant execute on function public.quotation_list(uuid, text, date, date) to authenticated;
grant execute on function public.order_list(uuid, text, date, date) to authenticated;
grant execute on function public.challan_list(uuid, text, date, date) to authenticated;
grant execute on function public.advance_list(uuid) to authenticated;
grant execute on function public.sales_document(text, uuid) to authenticated;
grant execute on function public.reserved_qty(uuid, uuid, uuid) to authenticated;
grant execute on function public.available_qty(uuid, uuid, uuid) to authenticated;

revoke all on function public.recalc_order_totals(uuid) from authenticated;
revoke all on function public.seed_sales_doc_accounts(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- The reports this chain unlocks
-- ---------------------------------------------------------------------------
--
-- Twelve of the reports P14 listed as "comes with P14a" (docs/BMS_REPORTS.md section 4).
-- They needed order and delivery lines to read; now they have them, so each is three
-- datasets and a dozen rows of configuration in src/lib/reports.ts.

create or replace view public.v_rep_order_lines as
select
  o.shop_id, o.branch_id, b.name as branch,
  public.dhaka_date(o.created_at) as d,
  to_char(public.dhaka_date(o.created_at), 'YYYY-MM') as month,
  o.delivery_date, o.so_no as order_no, o.status as order_status,
  o.customer_id, coalesce(c.name_text, c.company, c.phone) as trader,
  coalesce(cg.name, 'Retail') as trader_group,
  st.name as entered_by, coalesce(sb.name, st.name) as rep,
  l.name as location,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  i.qty, i.delivered_qty, i.billed_qty,
  greatest(i.qty - i.delivered_qty, 0) as pending_qty,
  i.unit_price, i.line_discount, i.is_free,
  round(i.line_total * (100 - o.discount_pct) / 100, 2) as amount,
  round(i.line_total * o.discount_pct / 100, 2) as discount,
  case when i.qty > 0
       then round(i.line_total * (100 - o.discount_pct) / 100 / i.qty, 2) end as net_unit_price,
  o.advance_amount, o.total as order_total
from public.sales_order_items i
join public.sales_orders o on o.id = i.order_id
join public.branches b on b.id = o.branch_id
join public.staff st on st.id = o.staff_id
left join public.staff sb on sb.id = o.sold_by
left join public.stock_locations l on l.branch_id = o.branch_id and l.is_default
join public.customers c on c.id = o.customer_id
left join public.customer_groups cg on cg.id = c.group_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id
where not i.cancelled and o.status not in ('draft', 'cancelled');

create or replace view public.v_rep_order_docs as
select
  o.shop_id, o.branch_id, b.name as branch,
  public.dhaka_date(o.created_at) as d,
  to_char(public.dhaka_date(o.created_at), 'YYYY-MM') as month,
  o.so_no as order_no, o.delivery_date, o.status as order_status,
  o.customer_id, coalesce(c.name_text, c.company, c.phone) as trader,
  coalesce(cg.name, 'Retail') as trader_group,
  st.name as entered_by, coalesce(sb.name, st.name) as rep,
  (select coalesce(sum(i.qty), 0) from public.sales_order_items i
   where i.order_id = o.id and not i.cancelled)::integer as qty,
  o.subtotal as total_amt, o.discount_amount as discount,
  o.charges_amount as charges, o.vat_amount as vat, 0::numeric(12,2) as ait,
  o.total as amount, o.advance_amount,
  (select q.quote_no from public.quotations q where q.id = o.quote_id) as quote_no
from public.sales_orders o
join public.branches b on b.id = o.branch_id
join public.staff st on st.id = o.staff_id
left join public.staff sb on sb.id = o.sold_by
join public.customers c on c.id = o.customer_id
left join public.customer_groups cg on cg.id = c.group_id
where o.status not in ('draft', 'cancelled');

-- What actually went out of the door. A counter sale is delivered the moment it is
-- rung up, so it counts here too — BMS's delivery reports leave them out, which makes
-- "what did we deliver this month" answer the wrong question.
create or replace view public.v_rep_deliveries as
select
  ch.shop_id, ch.branch_id, b.name as branch,
  ch.delivered_on as d,
  to_char(ch.delivered_on, 'YYYY-MM') as month,
  ch.challan_no as delivery_no,
  (select o.so_no from public.sales_orders o where o.id = ch.order_id) as order_no,
  (select sl.invoice_no from public.sales sl where sl.challan_id = ch.id
   order by sl.created_at limit 1) as invoice_no,
  ch.customer_id, coalesce(c.name_text, c.company, c.phone) as trader,
  coalesce(cg.name, 'Retail') as trader_group,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  i.qty - i.returned_qty as qty,
  round(i.unit_price * (i.qty - i.returned_qty), 2) as amount,
  ch.status
from public.challan_items i
join public.challans ch on ch.id = i.challan_id
join public.branches b on b.id = ch.branch_id
join public.customers c on c.id = ch.customer_id
left join public.customer_groups cg on cg.id = c.group_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id
where ch.status <> 'cancelled' and i.qty > i.returned_qty
union all
select
  s.shop_id, s.branch_id, b.name,
  public.dhaka_date(s.created_at),
  to_char(public.dhaka_date(s.created_at), 'YYYY-MM'),
  s.invoice_no, null, s.invoice_no,
  s.customer_id, coalesce(c.name_text, c.company, c.phone, 'Cash customer'),
  coalesce(cg.name, 'Cash customer'),
  i.product_id, p.code, coalesce(p.model, p.code), p.name,
  coalesce(cat.name, 'N/A'), coalesce(p.brand, 'N/A'), coalesce(u.name, 'PCS'),
  i.qty, i.line_total, 'billed'
from public.sale_items i
join public.sales s on s.id = i.sale_id
join public.branches b on b.id = s.branch_id
left join public.customers c on c.id = s.customer_id
left join public.customer_groups cg on cg.id = c.group_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id
where s.status = 'completed' and s.challan_id is null;

/**
 * Free to promise: on the shelf, minus what is already promised.
 *
 * BMS's ST-18 prints quantities larger than the shop physically has and nobody at the
 * store could say what they meant (docs/BMS_REPORTS.md, open question 2). This is the
 * reading that is useful: what a salesperson may safely promise today.
 */
create or replace function public.rep_free_to_promise(p_as_on date default null)
returns table (
  shop_id uuid, branch_id uuid, branch text, product_id uuid, code text, model text,
  product text, category text, brand text, uom text,
  qty bigint, reserved bigint, free bigint
)
language sql stable security definer set search_path = public as $$
  select s.shop_id, s.branch_id, s.branch, s.product_id, s.code, s.model, s.product,
         s.category, s.brand, s.uom,
         s.qty,
         public.reserved_qty(s.product_id, s.branch_id)::bigint,
         greatest(s.qty - public.reserved_qty(s.product_id, s.branch_id), 0)::bigint
  from public.rep_stock_as_on(p_as_on) s;
$$;

insert into public.rep_datasets (dataset, source, params, date_field, amount_field,
                                 qty_field, cost_field, profit_field) values
  ('order_lines',     'public.v_rep_order_lines',  '{}',      'd',  'amount', 'qty', null, null),
  ('order_docs',      'public.v_rep_order_docs',   '{}',      'd',  'amount', 'qty', null, null),
  ('deliveries',      'public.v_rep_deliveries',   '{}',      'd',  'amount', 'qty', null, null),
  ('free_to_promise', 'public.rep_free_to_promise(%s)', '{as_on}', null, null, 'free', null, null);

do $$
declare r record; v_cols text[]; v_name text;
begin
  for r in select * from public.rep_datasets where cols = '{}' loop
    if position('(' in r.source) > 0 then
      v_name := split_part(split_part(r.source, '(', 1), '.', 2);
      select array_agg(q.name::text) into v_cols from (
        select unnest(p.proargnames) as name, unnest(p.proargmodes) as mode
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = v_name and n.nspname = 'public') q
      where q.mode = 't';
    else
      select array_agg(a.attname::text) into v_cols from pg_attribute a
      where a.attrelid = r.source::regclass and a.attnum > 0 and not a.attisdropped;
    end if;
    if v_cols is null then raise exception 'NO COLUMNS FOUND FOR DATASET %', r.dataset; end if;
    update public.rep_datasets set cols = v_cols where dataset = r.dataset;
  end loop;
end $$;

-- The shop settings, with the sales-order approval limit added.

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
    card_charge_mode = coalesce(nullif(p_values->>'card_charge_mode', ''), card_charge_mode),
    claim_approval = coalesce((p_values->>'claim_approval')::boolean, claim_approval),
    voucher_approval = coalesce((p_values->>'voucher_approval')::boolean, voucher_approval),
    so_approval_limit = coalesce((p_values->>'so_approval_limit')::numeric, so_approval_limit)
  where id = v_me.shop_id
  returning to_jsonb(shops.*) into v_row;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'shop_details_changed', 'shop', v_me.shop_id,
          jsonb_build_object('from', v_before - 'id', 'to', v_row - 'id'));
  return v_row;
end; $$;
