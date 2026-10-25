-- P5 — goods in, and fixing stock when it is wrong.
--
-- WEIGHTED AVERAGE COST, and why it matters here.
--
-- A shop buys the same SSD at 6,000 one month and 6,400 the next. If the cost is simply
-- overwritten, every SSD already on the shelf retrospectively "cost" 6,400 and the
-- margin on the ones bought cheaply disappears from the books. If it is left alone, the
-- new ones look more profitable than they are. Neither tells the owner what the stock on
-- the shelf is actually worth.
--
-- So the cost moves to the average of what is there:
--
--   new average = (stock on hand x current average + received qty x received cost)
--                 / (stock on hand + received qty)
--
-- Stock on hand is the whole shop, not one branch, because the cost of a product is a
-- buying fact rather than a shelf fact. With no stock on hand the received cost simply
-- becomes the average, which is also what happens on the very first receipt.
--
-- The caller has ALREADY put the received quantity on the shelf by the time the average
-- is worked out (the landed cost needs every line first), so the received quantity is
-- taken back off to get the stock as it was before. Forgetting that counts the new
-- stock at the old cost as well as the new one and drags the average the wrong way.
--
-- There is a test for this in supabase/tests/sales_rules_test.sql: 8 on hand at 6,000
-- plus 5 arriving at 6,400 gives 6,153.85.

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

create table public.supplier_groups (
  id       uuid primary key default gen_random_uuid(),
  shop_id  uuid not null references public.shops(id) on delete cascade,
  name     text not null,
  active   boolean not null default true,
  unique (shop_id, name)
);

alter table public.suppliers
  add column group_id      uuid references public.supplier_groups(id) on delete set null,
  add column division_id   integer references public.divisions(id),
  add column district_id   integer references public.districts(id),
  add column upazila_id    integer references public.upazilas(id),
  add column note          text,
  -- BMS's "Cash Supplier": a one-off seller with a name and a phone and no account.
  -- They can still be paid, they just never carry a balance.
  add column is_cash_only  boolean not null default false;

-- ---------------------------------------------------------------------------
-- More reasons for stock to move
-- ---------------------------------------------------------------------------

alter table public.stock_movements drop constraint stock_movements_reason_check;
alter table public.stock_movements add constraint stock_movements_reason_check
  check (reason in ('purchase', 'sale', 'return', 'adjust_in', 'adjust_out',
                    'return_to_supplier', 'transfer_in', 'transfer_out', 'count'));

-- The fixed list of why a correction was made, so "stock went down by 3" always has an
-- answer and the owner can tell damage from theft.
alter table public.stock_movements
  add column reason_detail text check (reason_detail is null or reason_detail in
    ('damaged', 'lost', 'found_in_count', 'internal_use', 'expired', 'other'));

-- Each product can say what its serials look like, so a mis-scan is caught at the
-- scanner rather than discovered at a warranty claim.
alter table public.products
  add column serial_pattern text,
  add column serial_length  integer check (serial_length is null or serial_length between 4 and 64);

-- ---------------------------------------------------------------------------
-- Goods received
-- ---------------------------------------------------------------------------

create table public.grns (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id) on delete cascade,
  branch_id           uuid not null references public.branches(id),
  location_id         uuid not null references public.stock_locations(id),
  grn_no              text not null,
  supplier_id         uuid references public.suppliers(id) on delete set null,
  supplier_invoice_no text,
  invoice_date        date,
  -- Credit adds to the supplier's due; cash does not.
  is_credit           boolean not null default false,
  subtotal            numeric(12,2) not null default 0,
  discount            numeric(12,2) not null default 0,
  charges             numeric(12,2) not null default 0,
  vat                 numeric(12,2) not null default 0,
  ait                 numeric(12,2) not null default 0,
  total               numeric(12,2) not null default 0,
  -- "Receive now, price later" (BMS "Purchase Without Price"): the goods are on the
  -- shelf and the invoice has not arrived. Flagged until a manager fills the costs in,
  -- because stock with no cost quietly reports infinite margin.
  cost_missing        boolean not null default false,
  note                text,
  attachment_url      text,
  staff_id            uuid not null references public.staff(id),
  created_at          timestamptz not null default now(),
  unique (shop_id, grn_no)
);
create index grns_branch_idx on public.grns(branch_id, created_at desc);
create index grns_supplier_idx on public.grns(supplier_id, created_at desc);

create table public.grn_items (
  id            uuid primary key default gen_random_uuid(),
  grn_id        uuid not null references public.grns(id) on delete cascade,
  shop_id       uuid not null references public.shops(id) on delete cascade,
  product_id    uuid not null references public.products(id),
  qty           integer not null check (qty > 0),
  unit_cost     numeric(12,2),
  line_discount numeric(12,2) not null default 0,
  -- What this line really cost once the document discount and the extra costs
  -- (transport, labour) were spread across it. This is what the average cost uses.
  landed_cost   numeric(12,2),
  line_total    numeric(12,2) not null default 0
);
create index grn_items_grn_idx on public.grn_items(grn_id);

create table public.grn_item_serials (
  grn_item_id uuid not null references public.grn_items(id) on delete cascade,
  serial_id   uuid not null references public.serials(id) on delete cascade,
  primary key (grn_item_id, serial_id)
);

-- Serials remember where they came from, which is what makes a serial history lookup
-- answer "when did we buy this, and from whom?" (P11 uses it).
alter table public.serials
  add column grn_id    uuid references public.grns(id) on delete set null,
  add column unit_cost numeric(12,2);

create table public.supplier_payments (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  branch_id  uuid not null references public.branches(id),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  grn_id     uuid references public.grns(id) on delete set null,
  amount     numeric(12,2) not null check (amount > 0),
  method     text not null check (method in ('cash', 'bank', 'bkash', 'nagad', 'rocket', 'cheque', 'card')),
  reference  text,
  paid_on    date not null default public.dhaka_today(),
  note       text,
  staff_id   uuid not null references public.staff(id),
  created_at timestamptz not null default now()
);
create index supplier_payments_supplier_idx on public.supplier_payments(supplier_id, paid_on desc);

create table public.supplier_returns (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid not null references public.branches(id),
  location_id uuid not null references public.stock_locations(id),
  return_no   text not null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  reason      text,
  total       numeric(12,2) not null default 0,
  staff_id    uuid not null references public.staff(id),
  created_at  timestamptz not null default now(),
  unique (shop_id, return_no)
);

create table public.supplier_return_items (
  id         uuid primary key default gen_random_uuid(),
  return_id  uuid not null references public.supplier_returns(id) on delete cascade,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.products(id),
  qty        integer not null check (qty > 0),
  unit_cost  numeric(12,2) not null default 0,
  line_total numeric(12,2) not null default 0
);

create table public.supplier_return_serials (
  return_item_id uuid not null references public.supplier_return_items(id) on delete cascade,
  serial_id      uuid not null references public.serials(id),
  primary key (return_item_id, serial_id)
);

-- ---------------------------------------------------------------------------
-- Stock counts
-- ---------------------------------------------------------------------------

create table public.stock_counts (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid not null references public.branches(id),
  location_id uuid not null references public.stock_locations(id),
  count_no    text not null,
  category_id uuid references public.categories(id) on delete set null,
  note        text,
  applied_at  timestamptz,
  staff_id    uuid not null references public.staff(id),
  created_at  timestamptz not null default now(),
  unique (shop_id, count_no)
);

create table public.stock_count_items (
  id         uuid primary key default gen_random_uuid(),
  count_id   uuid not null references public.stock_counts(id) on delete cascade,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.products(id),
  -- What the system thought, and what was actually on the shelf.
  expected   integer not null,
  counted    integer not null check (counted >= 0)
);

-- ---------------------------------------------------------------------------
-- What a supplier is owed
-- ---------------------------------------------------------------------------

/**
 * A supplier's balance: the opening balance they came in with, plus credit purchases,
 * less what has been paid and returned.
 *
 * Computed rather than stored, so it cannot drift out of step with the documents that
 * make it up. P13 posts the same figures to the ledger.
 */
create or replace function public.supplier_balance(p_supplier_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select
    coalesce((select amount from public.opening_balances where supplier_id = p_supplier_id), 0)
    + coalesce((select sum(total) from public.grns
                where supplier_id = p_supplier_id and is_credit), 0)
    - coalesce((select sum(amount) from public.supplier_payments where supplier_id = p_supplier_id), 0)
    - coalesce((select sum(total) from public.supplier_returns where supplier_id = p_supplier_id), 0);
$$;

-- ---------------------------------------------------------------------------
-- Weighted average cost
-- ---------------------------------------------------------------------------

/**
 * Move a product's cost towards the cost of what was just received.
 *
 * See the note at the top of this file. Returns the new average so the caller can
 * report it.
 */
create or replace function public.apply_avg_cost(
  p_product_id uuid, p_recv_qty integer, p_recv_unit_cost numeric
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_shop  uuid;
  v_stock integer;
  v_old   numeric(12,2);
  v_new   numeric(12,2);
begin
  if p_recv_qty is null or p_recv_qty <= 0 or p_recv_unit_cost is null then return null; end if;
  select shop_id into v_shop from public.products where id = p_product_id;

  -- Stock on hand BEFORE this receipt, across the whole shop. The caller has already
  -- added the received quantity, so take it back off.
  select greatest(coalesce(sum(qty), 0) - p_recv_qty, 0) into v_stock
    from public.branch_stock where product_id = p_product_id;
  select cost into v_old from public.product_costs where product_id = p_product_id;

  if v_old is null or v_stock <= 0 then
    v_new := round(p_recv_unit_cost, 2);
  else
    v_new := round(((v_stock * v_old) + (p_recv_qty * p_recv_unit_cost)) / (v_stock + p_recv_qty), 2);
  end if;

  insert into public.product_costs (product_id, shop_id, cost)
  values (p_product_id, v_shop, v_new)
  on conflict (product_id) do update set cost = excluded.cost, updated_at = now();

  return v_new;
end; $$;

-- ---------------------------------------------------------------------------
-- receive_goods
-- ---------------------------------------------------------------------------

/**
 * Receive goods, in one transaction.
 *
 * p_lines: [{ product_id, qty, unit_cost?, line_discount?, serials?: text[] }]
 *
 * Extra costs (transport, labour) are spread across the lines BY VALUE, not evenly: a
 * 72,000 laptop should carry more of the delivery charge than a 350 adapter. The result
 * is the landed cost, and that is what the average cost uses — otherwise the shop's
 * margin looks better than it is by exactly the cost of getting the goods there.
 */
create or replace function public.receive_goods(
  p_branch_id           uuid,
  p_lines               jsonb,
  p_supplier_id         uuid default null,
  p_supplier_invoice_no text default null,
  p_invoice_date        date default null,
  p_is_credit           boolean default false,
  p_discount            numeric default 0,
  p_extra_costs         numeric default 0,
  p_vat                 numeric default 0,
  p_ait                 numeric default 0,
  p_note                text default null,
  p_attachment_url      text default null,
  p_location_id         uuid default null,
  -- Pay the supplier straight from the receive screen.
  p_pay_amount          numeric default null,
  p_pay_method          text default null,
  p_pay_reference       text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me        public.staff;
  v_location  uuid;
  v_grn_id    uuid := gen_random_uuid();
  v_grn_no    text;
  v_line      jsonb;
  v_product   public.products;
  v_qty       integer;
  v_cost      numeric(12,2);
  v_disc      numeric(12,2);
  v_line_tot  numeric(12,2);
  v_subtotal  numeric(12,2) := 0;
  v_total     numeric(12,2);
  v_serials   text[];
  v_clean     text[];
  v_item_id   uuid;
  v_serial_id uuid;
  v_s         text;
  v_missing   boolean := false;
  v_item      record;
  v_share     numeric(12,2);
  v_landed    numeric(12,2);
  v_lines_out jsonb := '[]'::jsonb;
  v_avg       numeric(12,2);
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('receive_stock') then raise exception 'NOT_ALLOWED:receive_stock'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  v_location := coalesce(p_location_id, public.default_location(p_branch_id));
  if v_location is null
     or not exists (select 1 from public.stock_locations where id = v_location and branch_id = p_branch_id) then
    raise exception 'LOCATION_NOT_FOUND';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'NOTHING_RECEIVED';
  end if;

  if p_supplier_id is not null
     and not exists (select 1 from public.suppliers where id = p_supplier_id and shop_id = v_me.shop_id) then
    raise exception 'SUPPLIER_NOT_FOUND';
  end if;
  -- A credit purchase has to be owed to somebody.
  if p_is_credit and p_supplier_id is null then raise exception 'CREDIT_NEEDS_SUPPLIER'; end if;
  if p_is_credit and (select is_cash_only from public.suppliers where id = p_supplier_id) then
    raise exception 'CASH_SUPPLIER_NO_CREDIT';
  end if;

  v_grn_no := public.next_document_number(p_branch_id, 'grn');

  insert into public.grns (id, shop_id, branch_id, location_id, grn_no, supplier_id,
                           supplier_invoice_no, invoice_date, is_credit, discount, charges,
                           vat, ait, note, attachment_url, staff_id)
  values (v_grn_id, v_me.shop_id, p_branch_id, v_location, v_grn_no, p_supplier_id,
          nullif(btrim(coalesce(p_supplier_invoice_no, '')), ''), p_invoice_date, p_is_credit,
          coalesce(p_discount, 0), coalesce(p_extra_costs, 0), coalesce(p_vat, 0),
          coalesce(p_ait, 0), p_note, p_attachment_url, v_me.id);

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    select * into v_product from public.products
      where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    if not v_product.is_inventory then raise exception 'NOT_A_STOCK_ITEM:%', v_product.name; end if;

    v_serials := coalesce(array(select jsonb_array_elements_text(coalesce(v_line->'serials', '[]'::jsonb))), '{}');
    v_clean := array(select btrim(s) from unnest(v_serials) s where btrim(s) <> '');

    if v_product.is_serial then
      v_qty := coalesce(array_length(v_clean, 1), 0);
      if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;

      -- The same serial twice in one delivery is a scanning slip, not two items.
      if (select count(distinct s) from unnest(v_clean) s) <> v_qty then
        raise exception 'DUPLICATE_SERIAL_IN_LINE:%', v_product.name;
      end if;
      foreach v_s in array v_clean loop
        if exists (select 1 from public.serials where shop_id = v_me.shop_id and serial = v_s) then
          raise exception 'SERIAL_ALREADY_KNOWN:%', v_s;
        end if;
        -- Digit check: a product can say how long its serials are, so a short scan is
        -- refused here instead of surfacing at a warranty claim two years later.
        if v_product.serial_length is not null and length(v_s) <> v_product.serial_length then
          raise exception 'SERIAL_WRONG_LENGTH:%', v_s;
        end if;
        if v_product.serial_pattern is not null and v_s !~ v_product.serial_pattern then
          raise exception 'SERIAL_WRONG_SHAPE:%', v_s;
        end if;
      end loop;
    else
      v_qty := coalesce((v_line->>'qty')::integer, 0);
      if v_qty <= 0 then raise exception 'BAD_QTY:%', v_product.name; end if;
    end if;

    v_cost := (v_line->>'unit_cost')::numeric;
    if v_cost is null then v_missing := true; end if;
    v_disc := coalesce((v_line->>'line_discount')::numeric, 0);
    v_line_tot := greatest(coalesce(v_cost, 0) * v_qty - v_disc, 0);
    v_subtotal := v_subtotal + v_line_tot;

    v_item_id := gen_random_uuid();
    insert into public.grn_items (id, grn_id, shop_id, product_id, qty, unit_cost, line_discount, line_total)
    values (v_item_id, v_grn_id, v_me.shop_id, v_product.id, v_qty, v_cost, v_disc, v_line_tot);

    -- Stock moves now; the landed cost is worked out once every line is known.
    insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
    values (v_product.id, v_location, v_me.shop_id, p_branch_id, v_qty)
    on conflict (product_id, location_id) do update
      set qty = public.branch_stock.qty + excluded.qty, updated_at = now();

    if v_product.is_serial then
      foreach v_s in array v_clean loop
        insert into public.serials (shop_id, product_id, serial, location_id, grn_id, unit_cost)
        values (v_me.shop_id, v_product.id, v_s, v_location, v_grn_id, v_cost)
        returning id into v_serial_id;
        insert into public.grn_item_serials (grn_item_id, serial_id) values (v_item_id, v_serial_id);
      end loop;
    end if;

    insert into public.stock_movements (shop_id, branch_id, location_id, product_id,
                                        qty_change, reason, ref_id, staff_id, note)
    values (v_me.shop_id, p_branch_id, v_location, v_product.id, v_qty, 'purchase', v_grn_id,
            v_me.id, 'Received on ' || v_grn_no);
  end loop;

  -- Spread the document discount and the extra costs across the lines BY VALUE, then
  -- move each product's average cost towards its landed cost.
  for v_item in
    select gi.*, p.name from public.grn_items gi
    join public.products p on p.id = gi.product_id
    where gi.grn_id = v_grn_id
  loop
    if v_subtotal > 0 then
      v_share := round((v_item.line_total / v_subtotal)
                       * (coalesce(p_extra_costs, 0) - coalesce(p_discount, 0)), 2);
    else
      v_share := 0;
    end if;
    v_landed := case when v_item.unit_cost is null then null
                     else round((v_item.line_total + v_share) / v_item.qty, 2) end;
    update public.grn_items set landed_cost = v_landed where id = v_item.id;

    if v_landed is not null then
      v_avg := public.apply_avg_cost(v_item.product_id, v_item.qty, v_landed);
      update public.serials set unit_cost = v_landed
        where grn_id = v_grn_id and product_id = v_item.product_id;
    end if;

    v_lines_out := v_lines_out || jsonb_build_object(
      'name', v_item.name, 'qty', v_item.qty, 'unit_cost', v_item.unit_cost,
      'landed_cost', v_landed, 'line_total', v_item.line_total, 'average_cost', v_avg);
  end loop;

  v_total := greatest(v_subtotal - coalesce(p_discount, 0), 0)
             + coalesce(p_extra_costs, 0) + coalesce(p_vat, 0) + coalesce(p_ait, 0);

  update public.grns set subtotal = v_subtotal, total = v_total, cost_missing = v_missing
  where id = v_grn_id;

  -- Pay the supplier straight away, in full or in part.
  if p_pay_amount is not null and p_pay_amount > 0 then
    if p_supplier_id is null then raise exception 'PAYMENT_NEEDS_SUPPLIER'; end if;
    if p_pay_method is null then raise exception 'PAYMENT_METHOD_REQUIRED'; end if;
    insert into public.supplier_payments (shop_id, branch_id, supplier_id, grn_id, amount,
                                          method, reference, staff_id)
    values (v_me.shop_id, p_branch_id, p_supplier_id, v_grn_id, p_pay_amount, p_pay_method,
            nullif(btrim(coalesce(p_pay_reference, '')), ''), v_me.id);
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'goods_received', 'grn', v_grn_id,
          jsonb_build_object('grn_no', v_grn_no, 'total', v_total, 'lines', jsonb_array_length(p_lines),
                             'supplier', (select name from public.suppliers where id = p_supplier_id),
                             'credit', p_is_credit, 'cost_missing', v_missing));

  return jsonb_build_object(
    'id', v_grn_id, 'grn_no', v_grn_no, 'subtotal', v_subtotal, 'total', v_total,
    'cost_missing', v_missing, 'is_credit', p_is_credit,
    'supplier_due', case when p_supplier_id is null then null
                         else public.supplier_balance(p_supplier_id) end,
    'lines', v_lines_out);
end; $$;

-- The old receive_stock() is replaced by receive_goods(), which does the same thing
-- properly: a document, a cost, a supplier and a history entry rather than a bare
-- quantity. Kept as a thin wrapper so nothing that already calls it breaks.
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
declare v_res jsonb; v_qty integer;
begin
  v_res := public.receive_goods(
    p_branch_id,
    jsonb_build_array(jsonb_build_object(
      'product_id', p_product_id,
      'qty', p_qty,
      'unit_cost', p_unit_cost,
      'serials', coalesce(to_jsonb(p_serials), '[]'::jsonb))),
    null, null, null, false, 0, 0, 0, 0, p_note, null, p_location_id);
  select sum(qty) into v_qty from public.grn_items where grn_id = (v_res->>'id')::uuid;
  return v_qty;
end; $$;

-- ---------------------------------------------------------------------------
-- Cost correction after the fact (BMS "Purchase Price Amendment")
-- ---------------------------------------------------------------------------

create or replace function public.amend_grn_cost(
  p_grn_item_id uuid, p_unit_cost numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_item  public.grn_items;
  v_grn   public.grns;
  v_old   numeric(12,2);
  v_avg   numeric(12,2);
  v_total numeric(12,2);
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:receive_stock'; end if;
  if p_unit_cost is null or p_unit_cost < 0 then raise exception 'BAD_COST'; end if;

  select * into v_item from public.grn_items where id = p_grn_item_id and shop_id = v_me.shop_id;
  if not found then raise exception 'GRN_LINE_NOT_FOUND'; end if;
  select * into v_grn from public.grns where id = v_item.grn_id;
  if not public.can_use_branch(v_grn.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  v_old := v_item.unit_cost;
  update public.grn_items
    set unit_cost = p_unit_cost,
        line_total = greatest(p_unit_cost * qty - line_discount, 0),
        landed_cost = p_unit_cost
  where id = p_grn_item_id;

  -- The document total and the "cost missing" flag both follow.
  select coalesce(sum(line_total), 0) into v_total from public.grn_items where grn_id = v_grn.id;
  update public.grns set
    subtotal = v_total,
    total = greatest(v_total - discount, 0) + charges + vat + ait,
    cost_missing = exists (select 1 from public.grn_items where grn_id = v_grn.id and unit_cost is null)
  where id = v_grn.id;

  v_avg := public.apply_avg_cost(v_item.product_id, v_item.qty, p_unit_cost);
  update public.serials set unit_cost = p_unit_cost
    where grn_id = v_grn.id and product_id = v_item.product_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_grn.branch_id, v_me.id, 'grn_cost_amended', 'grn', v_grn.id,
          jsonb_build_object('grn_no', v_grn.grn_no,
                             'product', (select name from public.products where id = v_item.product_id),
                             'from', v_old, 'to', p_unit_cost, 'new_average_cost', v_avg));

  return jsonb_build_object('grn_no', v_grn.grn_no, 'from', v_old, 'to', p_unit_cost,
                            'average_cost', v_avg,
                            'cost_missing', (select cost_missing from public.grns where id = v_grn.id));
end; $$;

-- ---------------------------------------------------------------------------
-- Return to supplier
-- ---------------------------------------------------------------------------

create or replace function public.return_to_supplier(
  p_branch_id   uuid,
  p_lines       jsonb,   -- [{ product_id, qty, serials?: uuid[] (serial ids) }]
  p_supplier_id uuid default null,
  p_reason      text default null,
  p_location_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_location uuid;
  v_ret_id   uuid := gen_random_uuid();
  v_ret_no   text;
  v_line     jsonb;
  v_product  public.products;
  v_qty      integer;
  v_serials  uuid[];
  v_found    integer;
  v_cost     numeric(12,2);
  v_item_id  uuid;
  v_stock    integer;
  v_total    numeric(12,2) := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('adjust_stock') then raise exception 'NOT_ALLOWED:adjust_stock'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  v_location := coalesce(p_location_id, public.default_location(p_branch_id));
  if v_location is null then raise exception 'LOCATION_NOT_FOUND'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_RETURNED'; end if;

  v_ret_no := public.next_document_number(p_branch_id, 'return');

  insert into public.supplier_returns (id, shop_id, branch_id, location_id, return_no,
                                       supplier_id, reason, staff_id)
  values (v_ret_id, v_me.shop_id, p_branch_id, v_location, v_ret_no, p_supplier_id, p_reason, v_me.id);

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    select * into v_product from public.products
      where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

    v_serials := coalesce(array(select jsonb_array_elements_text(coalesce(v_line->'serials', '[]'::jsonb))::uuid), '{}');

    if v_product.is_serial then
      v_qty := coalesce(array_length(v_serials, 1), 0);
      if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
      -- Only something actually on this branch's shelf can go back.
      update public.serials set status = 'returned'
        where id = any(v_serials) and product_id = v_product.id and shop_id = v_me.shop_id
          and status = 'in_stock'
          and location_id in (select id from public.stock_locations where branch_id = p_branch_id);
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    else
      v_qty := coalesce((v_line->>'qty')::integer, 0);
      if v_qty <= 0 then raise exception 'BAD_QTY:%', v_product.name; end if;
    end if;

    select qty into v_stock from public.branch_stock
      where product_id = v_product.id and location_id = v_location for update;
    if coalesce(v_stock, 0) < v_qty then raise exception 'OUT_OF_STOCK:%', v_product.name; end if;
    update public.branch_stock set qty = qty - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location;

    -- Returned at what it cost, which is what reduces the supplier's due.
    select cost into v_cost from public.product_costs where product_id = v_product.id;
    v_cost := coalesce(v_cost, 0);

    v_item_id := gen_random_uuid();
    insert into public.supplier_return_items (id, return_id, shop_id, product_id, qty, unit_cost, line_total)
    values (v_item_id, v_ret_id, v_me.shop_id, v_product.id, v_qty, v_cost, v_cost * v_qty);
    insert into public.supplier_return_serials (return_item_id, serial_id)
      select v_item_id, unnest(v_serials);

    insert into public.stock_movements (shop_id, branch_id, location_id, product_id,
                                        qty_change, reason, ref_id, staff_id, note)
    values (v_me.shop_id, p_branch_id, v_location, v_product.id, -v_qty, 'return_to_supplier',
            v_ret_id, v_me.id, 'Returned on ' || v_ret_no || coalesce(' — ' || p_reason, ''));

    v_total := v_total + v_cost * v_qty;
  end loop;

  update public.supplier_returns set total = v_total where id = v_ret_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'returned_to_supplier', 'supplier_return', v_ret_id,
          jsonb_build_object('return_no', v_ret_no, 'total', v_total, 'reason', p_reason,
                             'supplier', (select name from public.suppliers where id = p_supplier_id)));

  return jsonb_build_object('id', v_ret_id, 'return_no', v_ret_no, 'total', v_total,
                            'supplier_due', case when p_supplier_id is null then null
                                                 else public.supplier_balance(p_supplier_id) end);
end; $$;

-- ---------------------------------------------------------------------------
-- Stock corrections
-- ---------------------------------------------------------------------------

/**
 * Put stock up or down with a reason, because "the number was wrong" is never the whole
 * story — the owner needs to be able to tell damage from theft.
 */
create or replace function public.correct_stock(
  p_branch_id   uuid,
  p_product_id  uuid,
  p_change      integer,
  p_reason      text,
  p_note        text default null,
  p_serials     jsonb default null,   -- serial ids to take out, or serial TEXT to add
  p_location_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_location uuid;
  v_product  public.products;
  v_stock    integer;
  v_serials  uuid[];
  v_texts    text[];
  v_found    integer;
  v_s        text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('adjust_stock') then raise exception 'NOT_ALLOWED:adjust_stock'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_reason not in ('damaged', 'lost', 'found_in_count', 'internal_use', 'expired', 'other') then
    raise exception 'BAD_STOCK_REASON:%', p_reason;
  end if;
  if p_reason = 'other' and coalesce(btrim(p_note), '') = '' then
    raise exception 'REASON_NOTE_REQUIRED';
  end if;
  if p_change = 0 then raise exception 'NOTHING_TO_CORRECT'; end if;

  v_location := coalesce(p_location_id, public.default_location(p_branch_id));
  if v_location is null then raise exception 'LOCATION_NOT_FOUND'; end if;

  select * into v_product from public.products where id = p_product_id and shop_id = v_me.shop_id;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if not v_product.is_inventory then raise exception 'NOT_A_STOCK_ITEM:%', v_product.name; end if;

  if v_product.is_serial then
    if p_serials is null or jsonb_array_length(p_serials) <> abs(p_change) then
      raise exception 'SERIAL_COUNT_MISMATCH:%', v_product.name;
    end if;
    if p_change < 0 then
      v_serials := array(select jsonb_array_elements_text(p_serials)::uuid);
      update public.serials set status = case when p_reason = 'internal_use' then 'sold' else 'rma' end
        where id = any(v_serials) and product_id = v_product.id and status = 'in_stock'
          and location_id in (select id from public.stock_locations where branch_id = p_branch_id);
      get diagnostics v_found = row_count;
      if v_found <> abs(p_change) then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    else
      v_texts := array(select btrim(s) from jsonb_array_elements_text(p_serials) s where btrim(s) <> '');
      foreach v_s in array v_texts loop
        if exists (select 1 from public.serials where shop_id = v_me.shop_id and serial = v_s) then
          raise exception 'SERIAL_ALREADY_KNOWN:%', v_s;
        end if;
        insert into public.serials (shop_id, product_id, serial, location_id)
        values (v_me.shop_id, v_product.id, v_s, v_location);
      end loop;
    end if;
  end if;

  select qty into v_stock from public.branch_stock
    where product_id = p_product_id and location_id = v_location for update;
  v_stock := coalesce(v_stock, 0);
  if v_stock + p_change < 0 then raise exception 'WOULD_GO_NEGATIVE:%', v_product.name; end if;

  insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
  values (p_product_id, v_location, v_me.shop_id, p_branch_id, greatest(p_change, 0))
  on conflict (product_id, location_id) do update
    set qty = public.branch_stock.qty + p_change, updated_at = now();

  insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                      reason, reason_detail, staff_id, note)
  values (v_me.shop_id, p_branch_id, v_location, p_product_id, p_change,
          case when p_change > 0 then 'adjust_in' else 'adjust_out' end, p_reason, v_me.id, p_note);

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'stock_corrected', 'product', p_product_id,
          jsonb_build_object('product', v_product.name, 'change', p_change, 'reason', p_reason,
                             'note', p_note, 'from', v_stock, 'to', v_stock + p_change));

  return jsonb_build_object('product', v_product.name, 'from', v_stock, 'to', v_stock + p_change,
                            'reason', p_reason);
end; $$;

-- ---------------------------------------------------------------------------
-- Stock count
-- ---------------------------------------------------------------------------

/**
 * Record what is actually on the shelf and apply the differences in one go.
 *
 * p_counted: [{ product_id, counted }]
 *
 * The expected figure is read at the moment of applying, not when the count started, so
 * a sale made while someone was counting does not turn into a phantom correction.
 */
create or replace function public.apply_stock_count(
  p_branch_id   uuid,
  p_counted     jsonb,
  p_category_id uuid default null,
  p_note        text default null,
  p_location_id uuid default null,
  p_dry_run     boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_location uuid;
  v_count_id uuid := gen_random_uuid();
  v_count_no text;
  v_row      jsonb;
  v_product  public.products;
  v_expected integer;
  v_counted  integer;
  v_diff     jsonb := '[]'::jsonb;
  v_changed  integer := 0;
  v_same     integer := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('adjust_stock') then raise exception 'NOT_ALLOWED:adjust_stock'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  v_location := coalesce(p_location_id, public.default_location(p_branch_id));
  if v_location is null then raise exception 'LOCATION_NOT_FOUND'; end if;

  if not p_dry_run then
    v_count_no := public.next_document_number(p_branch_id, 'adjustment');
    insert into public.stock_counts (id, shop_id, branch_id, location_id, count_no,
                                     category_id, note, staff_id)
    values (v_count_id, v_me.shop_id, p_branch_id, v_location, v_count_no, p_category_id,
            p_note, v_me.id);
  end if;

  for v_row in select e from jsonb_array_elements(p_counted) e loop
    select * into v_product from public.products
      where id = (v_row->>'product_id')::uuid and shop_id = v_me.shop_id;
    if not found then continue; end if;
    -- Serial items are counted by scanning serials, not by typing a number, so they are
    -- corrected one at a time instead of here.
    if v_product.is_serial or not v_product.is_inventory then continue; end if;

    v_counted := (v_row->>'counted')::integer;
    if v_counted is null or v_counted < 0 then continue; end if;

    select coalesce(qty, 0) into v_expected from public.branch_stock
      where product_id = v_product.id and location_id = v_location;
    v_expected := coalesce(v_expected, 0);

    if v_expected = v_counted then v_same := v_same + 1; continue; end if;

    v_diff := v_diff || jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name,
      'expected', v_expected, 'counted', v_counted, 'change', v_counted - v_expected);
    v_changed := v_changed + 1;

    if p_dry_run then continue; end if;

    insert into public.stock_count_items (count_id, shop_id, product_id, expected, counted)
    values (v_count_id, v_me.shop_id, v_product.id, v_expected, v_counted);

    update public.branch_stock set qty = v_counted, updated_at = now()
      where product_id = v_product.id and location_id = v_location;
    if not found then
      insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
      values (v_product.id, v_location, v_me.shop_id, p_branch_id, v_counted);
    end if;

    insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                        reason, reason_detail, ref_id, staff_id, note)
    values (v_me.shop_id, p_branch_id, v_location, v_product.id, v_counted - v_expected,
            'count', case when v_counted > v_expected then 'found_in_count' else 'lost' end,
            v_count_id, v_me.id, 'Stock count ' || v_count_no);
  end loop;

  if not p_dry_run then
    update public.stock_counts set applied_at = now() where id = v_count_id;
    insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
    values (v_me.shop_id, p_branch_id, v_me.id, 'stock_counted', 'stock_count', v_count_id,
            jsonb_build_object('count_no', v_count_no, 'corrected', v_changed, 'already_right', v_same));
  end if;

  return jsonb_build_object('dry_run', p_dry_run, 'count_no', v_count_no,
                            'corrected', v_changed, 'already_right', v_same, 'differences', v_diff);
end; $$;

-- ---------------------------------------------------------------------------
-- Stock history
-- ---------------------------------------------------------------------------

create or replace function public.stock_history(
  p_branch_id uuid, p_product_id uuid default null, p_limit integer default 100
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;

  select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'at', m.created_at, 'product', p.name, 'code', p.code,
      'change', m.qty_change, 'reason', m.reason, 'why', m.reason_detail,
      'note', m.note, 'who', s.name,
      'location', l.name
    ) as x
    from public.stock_movements m
    join public.products p on p.id = m.product_id
    left join public.staff s on s.id = m.staff_id
    left join public.stock_locations l on l.id = m.location_id
    where m.branch_id = p_branch_id
      and (p_product_id is null or m.product_id = p_product_id)
    order by m.created_at desc
    limit least(coalesce(p_limit, 100), 500)
  ) q;
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.supplier_groups        enable row level security;
alter table public.grns                   enable row level security;
alter table public.grn_items              enable row level security;
alter table public.grn_item_serials       enable row level security;
alter table public.supplier_payments      enable row level security;
alter table public.supplier_returns       enable row level security;
alter table public.supplier_return_items  enable row level security;
alter table public.supplier_return_serials enable row level security;
alter table public.stock_counts           enable row level security;
alter table public.stock_count_items      enable row level security;

create policy supplier_groups_read on public.supplier_groups for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy supplier_groups_write on public.supplier_groups for all to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()))
  with check (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

-- Everything about buying is money information: managers and owners, at their own
-- branches. A cashier must not be able to read what the shop pays.
create policy grns_read on public.grns for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())) and (select public.has_permission('see_cost')));
create policy grn_items_read on public.grn_items for select to authenticated
  using (exists (select 1 from public.grns g where g.id = grn_id
                 and g.branch_id = any(select unnest(public.current_branch_ids()))
                 and (select public.has_permission('see_cost'))));
create policy grn_item_serials_read on public.grn_item_serials for select to authenticated
  using (exists (select 1 from public.grn_items gi join public.grns g on g.id = gi.grn_id
                 where gi.id = grn_item_id
                   and g.branch_id = any(select unnest(public.current_branch_ids()))
                   and (select public.has_permission('see_cost'))));
create policy supplier_payments_read on public.supplier_payments for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())) and (select public.is_manager()));
create policy supplier_returns_read on public.supplier_returns for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())) and (select public.is_manager()));
create policy supplier_return_items_read on public.supplier_return_items for select to authenticated
  using (exists (select 1 from public.supplier_returns r where r.id = return_id
                 and r.branch_id = any(select unnest(public.current_branch_ids()))
                 and (select public.is_manager())));
create policy supplier_return_serials_read on public.supplier_return_serials for select to authenticated
  using (exists (select 1 from public.supplier_return_items i
                 join public.supplier_returns r on r.id = i.return_id
                 where i.id = return_item_id
                   and r.branch_id = any(select unnest(public.current_branch_ids()))
                   and (select public.is_manager())));
create policy stock_counts_read on public.stock_counts for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())) and (select public.is_manager()));
create policy stock_count_items_read on public.stock_count_items for select to authenticated
  using (exists (select 1 from public.stock_counts c where c.id = count_id
                 and c.branch_id = any(select unnest(public.current_branch_ids()))
                 and (select public.is_manager())));

-- Documents are written only by the functions above.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.supplier_balance(uuid) from public, anon;
revoke execute on function public.apply_avg_cost(uuid, integer, numeric) from public, anon;
revoke execute on function public.receive_goods(uuid, jsonb, uuid, text, date, boolean, numeric, numeric, numeric, numeric, text, text, uuid, numeric, text, text) from public, anon;
revoke execute on function public.amend_grn_cost(uuid, numeric) from public, anon;
revoke execute on function public.return_to_supplier(uuid, jsonb, uuid, text, uuid) from public, anon;
revoke execute on function public.correct_stock(uuid, uuid, integer, text, text, jsonb, uuid) from public, anon;
revoke execute on function public.apply_stock_count(uuid, jsonb, uuid, text, uuid, boolean) from public, anon;
revoke execute on function public.stock_history(uuid, uuid, integer) from public, anon;

grant execute on function public.supplier_balance(uuid) to authenticated;
grant execute on function public.apply_avg_cost(uuid, integer, numeric) to authenticated;
grant execute on function public.receive_goods(uuid, jsonb, uuid, text, date, boolean, numeric, numeric, numeric, numeric, text, text, uuid, numeric, text, text) to authenticated;
grant execute on function public.amend_grn_cost(uuid, numeric) to authenticated;
grant execute on function public.return_to_supplier(uuid, jsonb, uuid, text, uuid) to authenticated;
grant execute on function public.correct_stock(uuid, uuid, integer, text, text, jsonb, uuid) to authenticated;
grant execute on function public.apply_stock_count(uuid, jsonb, uuid, text, uuid, boolean) to authenticated;
grant execute on function public.stock_history(uuid, uuid, integer) to authenticated;
