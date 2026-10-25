-- P9 — Sales history, reprint, void and returns
--
-- THE PARTIAL-RETURN RULE
-- A sale is not a list of independent lines: a whole-sale discount was spread across all
-- of them, VAT was worked out on the discounted figures, and a delivery charge was paid
-- once for the lot. Refunding a line at its shelf price therefore gives back more than
-- the customer handed over, every single time there was a discount.
--
-- So a returned quantity q of a line that was sold as qty for line_total refunds:
--
--   share    = line_total * q / qty                     -- before the whole-sale discount
--   charged  = share * (100 - sale.discount_pct) / 100   -- what was actually paid
--   vat_back = vat_amount * q / qty, added ONLY when the VAT was exclusive
--              (inclusive VAT is already inside `charged`, so adding it twice would
--              refund the tax twice)
--   refund   = charged + vat_back
--
-- Extra charges (delivery, installation) are refunded only when the whole sale comes
-- back. On a partial return the van still drove and the fitter still came: refunding a
-- share of that pays the customer for work the shop actually did.
--
-- A gift line went out at zero, so returning it refunds nothing — but the stock has to
-- come back or the shelf is permanently short. The counter works out how many gifts the
-- returned quantity earned and offers them; the database only insists that nothing is
-- returned twice.
--
-- VOID vs RETURN
-- A void is "this sale should never have existed" — same day only, with a manager's PIN,
-- and the invoice number stays burnt so the sequence has no gaps to explain. A return is
-- "the customer brought it back", which is a real event on its own document with its own
-- number, and it can happen at any branch of the shop.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

alter table public.shops
  -- How long after the sale a return is routine. Past it a manager has to approve.
  add column return_days integer not null default 7 check (return_days >= 0),
  -- BMS has Approve and Cancel menus for documents. Off by default: a shop of three
  -- people approving its own sales all day is theatre. 0 means "no value threshold".
  add column sale_approval_limit numeric(12,2) not null default 0
    check (sale_approval_limit >= 0),
  add column approve_all_sales boolean not null default false;

alter table public.sales
  -- Approved by default, so nothing that works today changes when the setting is off.
  -- A sale awaiting approval has still MOVED THE STOCK — the goods went out of the door;
  -- what waits is the posting to the books (P13).
  add column approval_status text not null default 'approved'
    check (approval_status in ('approved', 'awaiting_approval', 'cancelled')),
  add column approved_by     uuid references public.staff(id),
  add column approved_at     timestamptz,
  add column void_reason     text,
  add column voided_by       uuid references public.staff(id),
  add column voided_at       timestamptz,
  -- How the money went back when a sale was voided.
  add column refund_method   text,
  add column refund_ref      text;

create index sales_branch_time_idx on public.sales(branch_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Returns
-- ---------------------------------------------------------------------------

create table public.sale_returns (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  -- Where it was handed back, which is not always where it was bought.
  branch_id     uuid not null references public.branches(id),
  location_id   uuid not null references public.stock_locations(id),
  return_no     text not null,
  sale_id       uuid not null references public.sales(id),
  customer_id   uuid references public.customers(id),
  subtotal      numeric(12,2) not null default 0,
  vat_amount    numeric(12,2) not null default 0,
  charges_back  numeric(12,2) not null default 0,
  total         numeric(12,2) not null default 0,
  refund_method text not null check (refund_method in ('cash', 'bkash', 'nagad', 'card',
                                                        'store_credit', 'reduce_due')),
  refund_ref    text,
  reason        text,
  -- Returns arrive by courier too (BMS calls it "Courier").
  courier_name     text,
  courier_tracking text,
  -- Photos of what came back, so a dispute later has evidence.
  photo_urls    text[],
  approval_status text not null default 'approved'
    check (approval_status in ('approved', 'awaiting_approval', 'cancelled')),
  staff_id      uuid not null references public.staff(id),
  shift_id      uuid references public.shifts(id),
  created_at    timestamptz not null default now(),
  unique (shop_id, return_no)
);
create index sale_returns_branch_idx on public.sale_returns(branch_id, created_at desc);
create index sale_returns_sale_idx on public.sale_returns(sale_id);

create table public.sale_return_items (
  id            uuid primary key default gen_random_uuid(),
  return_id     uuid not null references public.sale_returns(id) on delete cascade,
  shop_id       uuid not null references public.shops(id) on delete cascade,
  sale_item_id  uuid not null references public.sale_items(id),
  product_id    uuid not null references public.products(id),
  qty           integer not null check (qty > 0),
  -- What this quantity is actually being refunded, after its share of the discount.
  refund_amount numeric(12,2) not null,
  -- A faulty item does not go back on the shelf; it goes to RMA for the supplier (P11).
  is_faulty     boolean not null default false
);
create index sale_return_items_return_idx on public.sale_return_items(return_id);

create table public.sale_return_serials (
  return_item_id uuid not null references public.sale_return_items(id) on delete cascade,
  serial_id      uuid not null references public.serials(id),
  primary key (return_item_id, serial_id)
);

-- Store credit has to live somewhere or it is a promise with no record. P10 spends it.
create table public.customer_credits (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount      numeric(12,2) not null check (amount <> 0),
  return_id   uuid references public.sale_returns(id) on delete set null,
  sale_id     uuid references public.sales(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);
create index customer_credits_customer_idx on public.customer_credits(customer_id);

-- ---------------------------------------------------------------------------
-- How much of a line is still returnable
-- ---------------------------------------------------------------------------

/** What the customer actually paid for q of this line, by the rule at the top. */
create or replace function public.refund_for(p_sale_item_id uuid, p_qty integer)
returns numeric
language sql stable security definer set search_path = public as $$
  select round(
           (i.line_total * p_qty / i.qty) * (100 - s.discount_pct) / 100
           + case when i.vat_inclusive then 0 else i.vat_amount * p_qty / i.qty end
         , 2)
  from public.sale_items i join public.sales s on s.id = i.sale_id
  where i.id = p_sale_item_id;
$$;

/** How many of this line have already gone back, so nothing is returned twice. */
create or replace function public.returned_qty(p_sale_item_id uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(ri.qty), 0)::integer
  from public.sale_return_items ri
  join public.sale_returns r on r.id = ri.return_id
  where ri.sale_item_id = p_sale_item_id and r.approval_status <> 'cancelled';
$$;

-- ---------------------------------------------------------------------------
-- Finding a sale
-- ---------------------------------------------------------------------------

/**
 * Search the sales. One box: an invoice number, a phone, a serial or a product name all
 * go in the same field, because the person at the counter has one thing in their hand
 * and should not have to know which kind of thing it is.
 *
 * A cashier sees their OWN sales at their OWN branch, today. Everything a cashier could
 * use to work out the shop's takings is somebody else's business.
 */
create or replace function public.sale_history(
  p_branch_id uuid default null,
  p_query     text default null,
  p_from      date default null,
  p_to        date default null,
  p_staff_id  uuid default null,
  p_method    text default null,
  p_status    text default null,
  p_limit     integer default 50
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_out   jsonb;
  v_q     text := nullif(btrim(coalesce(p_query, '')), '');
  v_from  date := p_from;
  v_to    date := p_to;
  v_staff uuid := p_staff_id;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  if not public.is_manager() then
    -- Not a restriction the browser can ask to lift: it is applied here.
    v_staff := v_me.id;
    v_from := public.dhaka_today();
    v_to := public.dhaka_today();
  end if;

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'id', s.id, 'invoice_no', s.invoice_no, 'created_at', s.created_at,
      'branch', b.name, 'branch_id', s.branch_id, 'staff', st.name,
      'total', s.total, 'discount_amount', s.discount_amount,
      'payment_method', s.payment_method, 'status', s.status,
      'approval_status', s.approval_status,
      'customer_phone', c.phone, 'customer_name', c.name,
      'item_count', (select coalesce(sum(i.qty), 0) from public.sale_items i where i.sale_id = s.id),
      'summary', (select string_agg(i.name, ', ' order by i.name)
                  from public.sale_items i where i.sale_id = s.id),
      -- A sale that has been returned in part looks the same as any other in a list,
      -- which is how the same item gets refunded twice.
      'returned', (select coalesce(sum(ri.qty), 0) from public.sale_return_items ri
                   join public.sale_returns r on r.id = ri.return_id
                   join public.sale_items i2 on i2.id = ri.sale_item_id
                   where i2.sale_id = s.id and r.approval_status <> 'cancelled')
    ) as x
    from public.sales s
    join public.branches b on b.id = s.branch_id
    join public.staff st on st.id = s.staff_id
    left join public.customers c on c.id = s.customer_id
    where s.shop_id = v_me.shop_id
      and s.branch_id = any(select unnest(public.current_branch_ids()))
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and (v_staff is null or s.staff_id = v_staff)
      and (v_from is null or (s.created_at at time zone 'Asia/Dhaka')::date >= v_from)
      and (v_to is null or (s.created_at at time zone 'Asia/Dhaka')::date <= v_to)
      and (p_method is null or s.payment_method = p_method)
      and (p_status is null or s.status = p_status)
      and (v_q is null
           or s.invoice_no ilike '%' || v_q || '%'
           or c.phone like '%' || v_q || '%'
           or exists (select 1 from public.sale_items i
                      where i.sale_id = s.id and i.name ilike '%' || v_q || '%')
           or exists (select 1 from public.sale_items i
                      join public.sale_item_serials sis on sis.sale_item_id = i.id
                      join public.serials se on se.id = sis.serial_id
                      where i.sale_id = s.id and se.serial ilike '%' || v_q || '%'))
    order by s.created_at desc
    limit greatest(coalesce(p_limit, 50), 1)
  ) q;
  return v_out;
end; $$;

/** One sale in full, for the detail view and the reprint. */
create or replace function public.sale_detail(p_sale_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_sale public.sales; v_out jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  select * into v_sale from public.sales where id = p_sale_id and shop_id = v_me.shop_id;
  if not found then raise exception 'SALE_NOT_FOUND'; end if;
  if not public.can_use_branch(v_sale.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  -- A cashier may look up what they themselves sold; other people's sales are not theirs.
  if not public.is_manager() and v_sale.staff_id <> v_me.id then raise exception 'NOT_YOUR_SALE'; end if;

  select jsonb_build_object(
    'id', s.id, 'invoice_no', s.invoice_no, 'created_at', s.created_at,
    'branch', b.name, 'branch_id', s.branch_id, 'branch_address', b.address,
    'branch_phone', b.phone,
    'shop_name', sh.name, 'receipt_footer', sh.receipt_footer, 'bin_vat', sh.bin_vat,
    'staff', st.name,
    'subtotal', s.subtotal, 'discount_pct', s.discount_pct, 'discount_amount', s.discount_amount,
    'vat_amount', s.vat_amount, 'charges_amount', s.charges_amount, 'total', s.total,
    'payment_method', s.payment_method, 'cash_received', s.cash_received,
    'change_given', s.change_given, 'payment_ref', s.payment_ref,
    'status', s.status, 'approval_status', s.approval_status,
    'void_reason', s.void_reason, 'refund_method', s.refund_method,
    'customer_phone', c.phone, 'customer_name', c.name,
    -- Same day? Then it can still be voided rather than returned.
    'same_day', (s.created_at at time zone 'Asia/Dhaka')::date = public.dhaka_today(),
    'days_old', public.dhaka_today() - (s.created_at at time zone 'Asia/Dhaka')::date,
    'return_days', sh.return_days,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', i.id, 'product_id', i.product_id, 'name', i.name, 'qty', i.qty,
                'unit_price', i.unit_price, 'line_total', i.line_total,
                'vat_pct', i.vat_pct, 'vat_amount', i.vat_amount,
                'vat_inclusive', i.vat_inclusive, 'is_gift', i.is_gift,
                'warranty_until', i.warranty_until,
                'returned_qty', public.returned_qty(i.id),
                'refund_each', public.refund_for(i.id, 1),
                'is_serial', p.is_serial,
                'serials', (select coalesce(jsonb_agg(jsonb_build_object(
                              'id', se.id, 'serial', se.serial, 'status', se.status)), '[]'::jsonb)
                            from public.sale_item_serials sis
                            join public.serials se on se.id = sis.serial_id
                            where sis.sale_item_id = i.id)
              ) order by i.name), '[]'::jsonb)
              from public.sale_items i join public.products p on p.id = i.product_id
              where i.sale_id = s.id),
    'returns', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', r.id, 'return_no', r.return_no, 'created_at', r.created_at,
                  'branch', rb.name, 'total', r.total, 'reason', r.reason,
                  'refund_method', r.refund_method,
                  'approval_status', r.approval_status) order by r.created_at), '[]'::jsonb)
                from public.sale_returns r join public.branches rb on rb.id = r.branch_id
                where r.sale_id = s.id)
  ) into v_out
  from public.sales s
  join public.branches b on b.id = s.branch_id
  join public.shops sh on sh.id = s.shop_id
  join public.staff st on st.id = s.staff_id
  left join public.customers c on c.id = s.customer_id
  where s.id = p_sale_id;

  -- Deliberately not logged. Looking at a sale is not an edit, and a row per view would
  -- bury the voids and refunds the log exists to make findable.
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- Void
-- ---------------------------------------------------------------------------

/**
 * This sale should never have existed: wrong customer, wrong product, rung up twice.
 *
 * Same day only. After that the shop's own day has been counted and closed, and undoing
 * a sale from last week silently changes a figure somebody has already acted on — that
 * is what a return is for.
 */
create or replace function public.void_sale(
  p_sale_id       uuid,
  p_reason        text,
  p_approval_id   uuid default null,
  p_refund_method text default null,
  p_refund_ref    text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_sale     public.sales;
  v_item     record;
  v_location uuid;
  v_approver uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('void_sale') then raise exception 'NOT_ALLOWED:void_sale'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'VOID_REASON_REQUIRED'; end if;

  select * into v_sale from public.sales where id = p_sale_id and shop_id = v_me.shop_id for update;
  if not found then raise exception 'SALE_NOT_FOUND'; end if;
  if not public.can_use_branch(v_sale.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if v_sale.status = 'void' then raise exception 'SALE_ALREADY_VOID'; end if;
  if (v_sale.created_at at time zone 'Asia/Dhaka')::date <> public.dhaka_today() then
    raise exception 'VOID_TOO_LATE';
  end if;
  -- Part of it has already come back on its own document, so voiding the whole thing
  -- would return the same goods twice.
  if exists (select 1 from public.sale_return_items ri
             join public.sale_returns r on r.id = ri.return_id
             join public.sale_items i on i.id = ri.sale_item_id
             where i.sale_id = p_sale_id and r.approval_status <> 'cancelled') then
    raise exception 'SALE_PARTLY_RETURNED';
  end if;

  -- A void needs a manager, even when a manager is the one doing it: the approval is
  -- the record of who agreed, and `verify_manager_pin()` already names that person.
  if not public.is_manager() then
    if p_approval_id is null then raise exception 'MANAGER_PIN_REQUIRED'; end if;
    -- Single use, ten minutes, exactly as a discount approval is consumed.
    update public.pin_attempts set used_at = now()
      where id = p_approval_id and shop_id = v_me.shop_id and ok
        and used_at is null and created_at > now() - interval '10 minutes'
      returning approver_id into v_approver;
    if v_approver is null then raise exception 'APPROVAL_NOT_VALID'; end if;
  end if;

  v_location := public.default_location(v_sale.branch_id);

  for v_item in
    select i.*, p.is_serial from public.sale_items i
    join public.products p on p.id = i.product_id
    where i.sale_id = p_sale_id order by i.product_id
  loop
    if v_item.is_serial then
      update public.serials set status = 'in_stock', sale_id = null, location_id = v_location
        where id in (select serial_id from public.sale_item_serials where sale_item_id = v_item.id);
    end if;
    insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
    values (v_item.product_id, v_location, v_me.shop_id, v_sale.branch_id, v_item.qty)
    on conflict (product_id, location_id) do update
      set qty = public.branch_stock.qty + v_item.qty, updated_at = now();
    insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                        reason, staff_id, note)
    values (v_me.shop_id, v_sale.branch_id, v_location, v_item.product_id, v_item.qty,
            'return', v_me.id, v_sale.invoice_no || ': sale voided');
  end loop;

  -- The invoice number stays burnt. A sequence with holes in it needs explaining to an
  -- auditor; a voided invoice explains itself.
  update public.sales set
    status = 'void', void_reason = p_reason, voided_by = v_me.id, voided_at = now(),
    refund_method = p_refund_method, refund_ref = p_refund_ref
  where id = p_sale_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_sale.branch_id, v_me.id, 'sale_voided', 'sale', p_sale_id,
          jsonb_build_object('invoice_no', v_sale.invoice_no, 'total', v_sale.total,
                             'reason', p_reason, 'refund_method', p_refund_method,
                             'approved_by', (select name from public.staff where id = v_approver)));

  return jsonb_build_object('invoice_no', v_sale.invoice_no, 'status', 'void',
                            'refunded', v_sale.total);
end; $$;

-- ---------------------------------------------------------------------------
-- Return
-- ---------------------------------------------------------------------------

/**
 * The customer brought it back.
 *
 * Accepted at ANY branch of the shop, and the stock goes back where it was handed in —
 * that is where the box physically is. Faulty items do not go on the shelf at all; their
 * serials go to 'rma' so the warranty flow (P11) can send them to the supplier.
 */
create or replace function public.return_sale(
  p_sale_id       uuid,
  p_branch_id     uuid,
  p_lines         jsonb,       -- [{ sale_item_id, qty, serial_ids?: uuid[], is_faulty? }]
  p_refund_method text,
  p_reason        text default null,
  p_refund_ref    text default null,
  p_approval_id   uuid default null,
  p_courier_name  text default null,
  p_courier_tracking text default null,
  p_photo_urls    text[] default null,
  p_location_id   uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me        public.staff;
  v_sale      public.sales;
  v_shop      public.shops;
  v_line      jsonb;
  v_item      record;
  v_qty       integer;
  v_already   integer;
  v_refund    numeric(12,2);
  v_subtotal  numeric(12,2) := 0;
  v_vat       numeric(12,2) := 0;
  v_charges   numeric(12,2) := 0;
  v_total     numeric(12,2);
  v_location  uuid;
  v_return_id uuid;
  v_no        text;
  v_item_id   uuid;
  v_serials   uuid[];
  v_found     integer;
  v_faulty    boolean;
  v_approver  uuid;
  v_all_back  boolean;
  v_shift     uuid;
  v_out       jsonb := '[]'::jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('return_sale') then raise exception 'NOT_ALLOWED:return_sale'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_RETURNED'; end if;
  if p_refund_method not in ('cash', 'bkash', 'nagad', 'card', 'store_credit', 'reduce_due') then
    raise exception 'BAD_REFUND_METHOD:%', p_refund_method;
  end if;

  select * into v_shop from public.shops where id = v_me.shop_id;
  select * into v_sale from public.sales where id = p_sale_id and shop_id = v_me.shop_id for update;
  if not found then raise exception 'SALE_NOT_FOUND'; end if;
  if v_sale.status = 'void' then raise exception 'SALE_IS_VOID'; end if;

  -- Past the shop's window a manager has to agree. The window is a shop setting, not a
  -- rule of the software: a phone shop and a parts shop do not have the same one.
  if public.dhaka_today() - (v_sale.created_at at time zone 'Asia/Dhaka')::date > v_shop.return_days then
    if not public.is_manager() then
      if p_approval_id is null then
        raise exception 'RETURN_TOO_LATE:%', v_shop.return_days;
      end if;
      update public.pin_attempts set used_at = now()
        where id = p_approval_id and shop_id = v_me.shop_id and ok
          and used_at is null and created_at > now() - interval '10 minutes'
        returning approver_id into v_approver;
      if v_approver is null then raise exception 'APPROVAL_NOT_VALID'; end if;
    end if;
  end if;

  v_location := coalesce(p_location_id, public.default_location(p_branch_id));
  if v_location is null then raise exception 'LOCATION_NOT_FOUND'; end if;

  v_no := public.next_document_number(p_branch_id, 'return');
  insert into public.sale_returns (shop_id, branch_id, location_id, return_no, sale_id,
                                   customer_id, refund_method, refund_ref, reason,
                                   courier_name, courier_tracking, photo_urls, staff_id)
  values (v_me.shop_id, p_branch_id, v_location, v_no, p_sale_id,
          v_sale.customer_id, p_refund_method, p_refund_ref, p_reason,
          p_courier_name, p_courier_tracking, p_photo_urls, v_me.id)
  returning id into v_return_id;

  for v_line in select e from jsonb_array_elements(p_lines) e order by e->>'sale_item_id' loop
    select i.*, p.is_serial, p.name as product_name into v_item
    from public.sale_items i join public.products p on p.id = i.product_id
    where i.id = (v_line->>'sale_item_id')::uuid and i.sale_id = p_sale_id;
    if not found then raise exception 'SALE_LINE_NOT_FOUND'; end if;

    v_faulty := coalesce((v_line->>'is_faulty')::boolean, false);
    if v_item.is_serial then
      v_serials := array(select jsonb_array_elements_text(coalesce(v_line->'serial_ids', '[]'::jsonb))::uuid);
      v_qty := coalesce(array_length(v_serials, 1), 0);
      if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_item.product_name; end if;
    else
      v_qty := (v_line->>'qty')::integer;
      if coalesce(v_qty, 0) <= 0 then raise exception 'BAD_QTY:%', v_item.product_name; end if;
    end if;

    v_already := public.returned_qty(v_item.id);
    if v_already + v_qty > v_item.qty then
      raise exception 'MORE_THAN_SOLD:%', v_item.product_name;
    end if;

    v_refund := public.refund_for(v_item.id, v_qty);
    v_subtotal := v_subtotal + round(v_item.line_total * v_qty / v_item.qty
                                     * (100 - v_sale.discount_pct) / 100, 2);
    if not v_item.vat_inclusive then
      v_vat := v_vat + round(v_item.vat_amount * v_qty / v_item.qty, 2);
    end if;

    insert into public.sale_return_items (return_id, shop_id, sale_item_id, product_id,
                                          qty, refund_amount, is_faulty)
    values (v_return_id, v_me.shop_id, v_item.id, v_item.product_id, v_qty, v_refund, v_faulty)
    returning id into v_item_id;

    if v_item.is_serial then
      -- Only serials that were actually on this sale, and not already back.
      update public.serials set
        status = case when v_faulty then 'rma' else 'in_stock' end,
        sale_id = case when v_faulty then sale_id else null end,
        location_id = v_location
      where id = any(v_serials) and status = 'sold'
        and id in (select serial_id from public.sale_item_serials where sale_item_id = v_item.id);
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_ON_THIS_SALE:%', v_item.product_name; end if;
      insert into public.sale_return_serials (return_item_id, serial_id)
      select v_item_id, unnest(v_serials);
    end if;

    -- A faulty item never reaches the shelf. It came back, it is recorded as back, and
    -- it is in RMA — putting it in branch_stock would let somebody sell it again.
    if not v_faulty then
      insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
      values (v_item.product_id, v_location, v_me.shop_id, p_branch_id, v_qty)
      on conflict (product_id, location_id) do update
        set qty = public.branch_stock.qty + v_qty, updated_at = now();
    end if;

    insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                        reason, reason_detail, staff_id, note)
    values (v_me.shop_id, p_branch_id, v_location, v_item.product_id,
            case when v_faulty then 0 else v_qty end,
            'return', case when v_faulty then 'damaged' end, v_me.id,
            v_no || ' against ' || v_sale.invoice_no
                 || case when v_faulty then ' (faulty, sent to RMA)' else '' end);

    v_out := v_out || jsonb_build_object('name', v_item.name, 'qty', v_qty,
                                         'refund', v_refund, 'faulty', v_faulty);
  end loop;

  -- Extra charges come back only when the whole sale does: see the note at the top.
  select not exists (select 1 from public.sale_items i
                     where i.sale_id = p_sale_id and public.returned_qty(i.id) < i.qty)
    into v_all_back;
  if v_all_back then v_charges := v_sale.charges_amount; end if;

  v_total := v_subtotal + v_vat + v_charges;

  -- A cash refund comes out of the drawer, so the shift it happened on has to know.
  select id into v_shift from public.shifts
    where staff_id = v_me.id and branch_id = p_branch_id and closed_at is null
    order by opened_at desc limit 1;

  update public.sale_returns set subtotal = v_subtotal, vat_amount = v_vat,
    charges_back = v_charges, total = v_total, shift_id = v_shift
  where id = v_return_id;

  if p_refund_method = 'store_credit' then
    if v_sale.customer_id is null then raise exception 'CREDIT_NEEDS_CUSTOMER'; end if;
    insert into public.customer_credits (shop_id, customer_id, amount, return_id, note)
    values (v_me.shop_id, v_sale.customer_id, v_total, v_return_id,
            'Store credit from ' || v_no);
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'sale_returned', 'sale_return', v_return_id,
          jsonb_build_object('return_no', v_no, 'invoice_no', v_sale.invoice_no,
                             'total', v_total, 'refund_method', p_refund_method,
                             'reason', p_reason, 'lines', v_out,
                             'courier', p_courier_name,
                             'approved_by', (select name from public.staff where id = v_approver)));

  return jsonb_build_object('return_no', v_no, 'total', v_total, 'subtotal', v_subtotal,
                            'vat_amount', v_vat, 'charges_back', v_charges,
                            'refund_method', p_refund_method, 'lines', v_out,
                            'whole_sale_returned', v_all_back);
end; $$;

-- ---------------------------------------------------------------------------
-- Approving a document, where a shop wants that
-- ---------------------------------------------------------------------------

/** Approve or cancel a sale or a return. Buttons on the document, never a menu. */
create or replace function public.set_sale_approval(
  p_kind text,            -- 'sale' or 'return'
  p_id   uuid,
  p_action text,          -- 'approve' or 'cancel'
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_branch uuid; v_no text; v_status text; v_new text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('approve') then raise exception 'NOT_ALLOWED:approve'; end if;
  if p_action not in ('approve', 'cancel') then raise exception 'BAD_APPROVAL_ACTION:%', p_action; end if;
  if p_action = 'cancel' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'CANCEL_REASON_REQUIRED';
  end if;

  if p_kind = 'sale' then
    select branch_id, invoice_no, approval_status into v_branch, v_no, v_status
      from public.sales where id = p_id and shop_id = v_me.shop_id;
  elsif p_kind = 'return' then
    select branch_id, return_no, approval_status into v_branch, v_no, v_status
      from public.sale_returns where id = p_id and shop_id = v_me.shop_id;
  else
    raise exception 'BAD_APPROVAL_KIND:%', p_kind;
  end if;
  if v_no is null then raise exception 'SALE_NOT_FOUND'; end if;
  if not public.can_use_branch(v_branch) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if v_status <> 'awaiting_approval' then raise exception 'NOT_AWAITING_APPROVAL:%', v_status; end if;

  v_new := case when p_action = 'approve' then 'approved' else 'cancelled' end;
  if p_kind = 'sale' then
    update public.sales set approval_status = v_new, approved_by = v_me.id, approved_at = now()
      where id = p_id;
  else
    update public.sale_returns set approval_status = v_new where id = p_id;
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_branch, v_me.id,
          p_kind || '_' || p_action || 'd', p_kind, p_id,
          jsonb_build_object('number', v_no, 'reason', p_reason));

  return jsonb_build_object('number', v_no, 'approval_status', v_new);
end; $$;

-- ---------------------------------------------------------------------------
-- A sale that needs approving says so
-- ---------------------------------------------------------------------------

/**
 * Hold a sale for approval when the shop asked for that.
 *
 * A trigger for the same reason as the shift check: the rule belongs to the sale row,
 * and complete_sale() is long enough. The stock has already moved either way — what is
 * held is the posting, not the goods.
 */
create or replace function public.apply_sale_approval() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_shop public.shops;
begin
  select * into v_shop from public.shops where id = new.shop_id;
  if v_shop.approve_all_sales
     or (v_shop.sale_approval_limit > 0 and new.total > v_shop.sale_approval_limit) then
    new.approval_status := 'awaiting_approval';
  end if;
  return new;
end; $$;

-- On UPDATE, because complete_sale() inserts the row with a total of 0 and fills the
-- figures in afterwards: at insert time there is no amount to compare the limit against.
create trigger sales_apply_approval
  before update of total on public.sales
  for each row when (new.status = 'completed' and new.approval_status = 'approved')
  execute function public.apply_sale_approval();

-- ---------------------------------------------------------------------------
-- Cash refunds come out of the drawer
-- ---------------------------------------------------------------------------

/**
 * Expected cash, now including what went back out as a cash refund. This is the line the
 * P8 migration said would be added here rather than a new formula.
 */
create or replace function public.expected_cash(p_shift_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(s.opening_cash, 0)
       + coalesce((select sum(coalesce(sa.cash_received, sa.total) - coalesce(sa.change_given, 0))
                   from public.sales sa
                   where sa.shift_id = s.id and sa.payment_method = 'cash'
                     and sa.status = 'completed'), 0)
       - coalesce((select sum(r.total) from public.sale_returns r
                   where r.shift_id = s.id and r.refund_method = 'cash'
                     and r.approval_status <> 'cancelled'), 0)
       + coalesce((select sum(case when cm.direction = 'in' then cm.amount else -cm.amount end)
                   from public.cash_movements cm where cm.shift_id = s.id), 0)
  from public.shifts s where s.id = p_shift_id;
$$;

-- ---------------------------------------------------------------------------
-- The shop settings
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
    approve_all_sales = coalesce((p_values->>'approve_all_sales')::boolean, approve_all_sales)
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

alter table public.sale_returns        enable row level security;
alter table public.sale_return_items   enable row level security;
alter table public.sale_return_serials enable row level security;
alter table public.customer_credits    enable row level security;

create policy sale_returns_read on public.sale_returns for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())));
create policy sale_return_items_read on public.sale_return_items for select to authenticated
  using (exists (select 1 from public.sale_returns r where r.id = return_id
                 and r.branch_id = any(select unnest(public.current_branch_ids()))));
create policy sale_return_serials_read on public.sale_return_serials for select to authenticated
  using (exists (select 1 from public.sale_return_items ri
                 join public.sale_returns r on r.id = ri.return_id
                 where ri.id = return_item_id
                   and r.branch_id = any(select unnest(public.current_branch_ids()))));
-- What a customer is owed is money, so it follows the same line as cost prices.
create policy customer_credits_read on public.customer_credits for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.is_manager()));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.refund_for(uuid, integer) from public, anon;
revoke execute on function public.returned_qty(uuid) from public, anon;
revoke execute on function public.sale_history(uuid, text, date, date, uuid, text, text, integer) from public, anon;
revoke execute on function public.sale_detail(uuid) from public, anon;
revoke execute on function public.void_sale(uuid, text, uuid, text, text) from public, anon;
revoke execute on function public.return_sale(uuid, uuid, jsonb, text, text, text, uuid, text, text, text[], uuid) from public, anon;
revoke execute on function public.set_sale_approval(text, uuid, text, text) from public, anon;

grant execute on function public.refund_for(uuid, integer) to authenticated;
grant execute on function public.returned_qty(uuid) to authenticated;
grant execute on function public.sale_history(uuid, text, date, date, uuid, text, text, integer) to authenticated;
grant execute on function public.sale_detail(uuid) to authenticated;
grant execute on function public.void_sale(uuid, text, uuid, text, text) to authenticated;
grant execute on function public.return_sale(uuid, uuid, jsonb, text, text, text, uuid, text, text, text[], uuid) to authenticated;
grant execute on function public.set_sale_approval(text, uuid, text, text) to authenticated;
