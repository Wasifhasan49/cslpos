-- P11 — Warranty lookup and claims
--
-- Claims are rare at CSL — a handful a month — but shops differ, so this has to work at
-- a busy service counter too. BMS does it in about ten screens; the useful part of that
-- is three questions:
--
--   1. Is this thing in warranty?  (one box: serial, invoice or phone)
--   2. What is wrong with it, and where is it now?
--   3. When the customer comes back, what do we hand them?
--
-- THE RULE THAT MATTERS MOST
-- A replacement unit carries the REMAINING warranty of the thing it replaced, not a
-- fresh term. A customer whose laptop dies in month 22 of 24 gets a machine covered for
-- two more months; giving it a new 24 months hands out free cover the shop never sold,
-- and giving it none is the thing that makes people distrust a shop. `warranty_until` is
-- copied from the old unit onto the new one, and the claim says so.
--
-- WHERE THE ITEM IS
-- An item in for repair is NOT shop stock and NOT the customer's: it is in the shop's
-- hands and belongs to someone else. Its serial sits at 'rma' the whole time, and the
-- claim's status says where in the process it actually is — with us, with the supplier,
-- or on the shelf waiting for collection. That is what makes the RMA report (P14)
-- answerable at all.

-- ---------------------------------------------------------------------------
-- A claim is its own kind of document
-- ---------------------------------------------------------------------------

alter table public.document_sequences drop constraint document_sequences_doc_type_check;
alter table public.document_sequences add constraint document_sequences_doc_type_check
  check (doc_type in (
    'invoice', 'return', 'quote', 'order', 'challan', 'grn', 'po', 'requisition',
    'transfer', 'transfer_request', 'adjustment', 'receipt', 'payment', 'voucher',
    'cheque', 'claim'
  ));

-- A serial can now be out with a supplier for repair, which is not the same as being in
-- RMA on our own shelf: one is somebody else's problem to fix, the other is ours to chase.
alter table public.serials drop constraint serials_status_check;
alter table public.serials add constraint serials_status_check
  check (status in ('in_stock', 'sold', 'returned', 'rma', 'in_transit', 'with_supplier'));

-- ---------------------------------------------------------------------------
-- Setup: what goes wrong, and who fixes it
-- ---------------------------------------------------------------------------

-- BMS "Problem Setup". A fixed list beats free text because "screen" and "Screen" and
-- "display issue" are the same fault, and a shop wants to know which fault is costing it.
create table public.problem_types (
  id       uuid primary key default gen_random_uuid(),
  shop_id  uuid not null references public.shops(id) on delete cascade,
  name     text not null,
  active   boolean not null default true,
  sort     integer not null default 0,
  unique (shop_id, name)
);

-- BMS "Engineer Fixing". A technician may be a staff login or just a name: a shop that
-- sends work to the man two doors down still needs to know who has it.
create table public.technicians (
  id       uuid primary key default gen_random_uuid(),
  shop_id  uuid not null references public.shops(id) on delete cascade,
  name     text not null,
  phone    text,
  staff_id uuid references public.staff(id) on delete set null,
  active   boolean not null default true,
  unique (shop_id, name)
);

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------

create table public.warranty_claims (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  -- Where it was handed in. A chain takes a claim at any branch.
  branch_id     uuid not null references public.branches(id),
  claim_no      text not null,
  -- The unit. A serial-tracked item is the normal case; `item_text` covers the rest and
  -- anything sold before the shop switched over.
  serial_id     uuid references public.serials(id),
  product_id    uuid references public.products(id),
  item_text     text,
  -- The sale it came from, when we sold it. Null for a manual record.
  sale_id       uuid references public.sales(id),
  sale_item_id  uuid references public.sale_items(id),
  customer_id   uuid references public.customers(id),
  customer_phone text,
  customer_name text,
  -- Was it in warranty when it came in? Recorded at the time, because the date moves.
  in_warranty   boolean not null default false,
  warranty_until date,
  problem_type_id uuid references public.problem_types(id),
  problem       text not null,
  -- What came in with it: charger, box, bag. Checkboxes at the counter, so an argument
  -- about a missing charger has an answer.
  accessories   text[],
  photo_urls    text[],
  technician_id uuid references public.technicians(id),
  status        text not null default 'received'
                check (status in ('received', 'diagnosed', 'with_supplier',
                                  'back_from_supplier', 'repaired', 'ready',
                                  'delivered', 'rejected')),
  -- Who it went out to, and when, so "it's been with them three weeks" is a fact.
  supplier_id   uuid references public.suppliers(id),
  sent_at       timestamptz,
  back_at       timestamptz,
  -- What the customer actually got: the same unit back, or a different one.
  replacement_serial_id uuid references public.serials(id),
  resolution    text,
  -- What the shop charged, if anything. A warranty repair is free; an out-of-warranty
  -- one is a sale, and this points at it.
  service_sale_id uuid references public.sales(id),
  approval_status text not null default 'approved'
                  check (approval_status in ('approved', 'awaiting_approval', 'cancelled')),
  staff_id      uuid not null references public.staff(id),
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz,
  unique (shop_id, claim_no)
);
create index warranty_claims_branch_idx on public.warranty_claims(branch_id, created_at desc);
create index warranty_claims_serial_idx on public.warranty_claims(serial_id);
create index warranty_claims_status_idx on public.warranty_claims(shop_id, status);

-- Every status change, timed and attributed. BMS has an edit log; this is the same idea
-- for the one thing a customer will argue about: how long you had it.
create table public.claim_events (
  id         uuid primary key default gen_random_uuid(),
  claim_id   uuid not null references public.warranty_claims(id) on delete cascade,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  from_status text,
  to_status  text not null,
  note       text,
  staff_id   uuid not null references public.staff(id),
  created_at timestamptz not null default now()
);
create index claim_events_claim_idx on public.claim_events(claim_id, created_at);

-- Parts taken out of stock to fix something in-house.
create table public.claim_parts (
  id         uuid primary key default gen_random_uuid(),
  claim_id   uuid not null references public.warranty_claims(id) on delete cascade,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.products(id),
  qty        integer not null check (qty > 0),
  serial_id  uuid references public.serials(id),
  created_at timestamptz not null default now()
);

-- A shop can require a manager to sign off claim steps.
alter table public.shops
  add column claim_approval boolean not null default false;

-- Items sold before the shop switched over have no sale here, so the warranty has to be
-- recordable by hand. Owner and manager only: it is a promise the shop is making.
create table public.manual_warranties (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  serial        text not null,
  product_id    uuid references public.products(id),
  item_text     text,
  customer_phone text,
  customer_name text,
  sold_on       date,
  warranty_until date,
  note          text,
  staff_id      uuid not null references public.staff(id),
  created_at    timestamptz not null default now(),
  unique (shop_id, serial)
);

-- ---------------------------------------------------------------------------
-- Looking it up
-- ---------------------------------------------------------------------------

/**
 * One box: a serial, an invoice number or a phone.
 *
 * The person at the counter has a box in their hand with a sticker on it, or a receipt,
 * or just the customer's phone. Making them choose which kind of thing it is first is
 * exactly the sort of step that turns a 10-second job into a minute.
 */
create or replace function public.warranty_lookup(p_query text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_q text := nullif(btrim(coalesce(p_query, '')), ''); v_out jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_q is null then raise exception 'NOTHING_TO_LOOK_UP'; end if;

  select coalesce(jsonb_agg(x order by x->>'sold_on' desc nulls last), '[]'::jsonb) into v_out
  from (
    -- Things this shop sold, found by serial, invoice number or the customer's phone.
    select jsonb_build_object(
      'kind', 'sold',
      'serial_id', se.id, 'serial', se.serial, 'serial_status', se.status,
      'product_id', i.product_id, 'product', i.name,
      'sale_id', s.id, 'sale_item_id', i.id, 'invoice_no', s.invoice_no,
      'sold_on', (s.created_at at time zone 'Asia/Dhaka')::date,
      'branch', b.name, 'sold_by', st.name,
      'customer_id', s.customer_id, 'customer_phone', c.phone, 'customer_name', c.name_text,
      'warranty_months', i.warranty_months,
      'warranty_until', i.warranty_until,
      'warranty_text', (select wt.receipt_text from public.warranty_terms wt
                        join public.products p2 on p2.warranty_term_id = wt.id
                        where p2.id = i.product_id),
      'in_warranty', i.warranty_until is not null and i.warranty_until >= public.dhaka_today(),
      -- "8 months left" is what the customer asks; a date is what the shop has.
      'days_left', case when i.warranty_until is not null
                        then i.warranty_until - public.dhaka_today() end,
      'sale_status', s.status,
      'open_claim', (select cl.claim_no from public.warranty_claims cl
                     where cl.serial_id = se.id and cl.status not in ('delivered', 'rejected')
                     order by cl.created_at desc limit 1)
    ) as x
    from public.sale_items i
    join public.sales s on s.id = i.sale_id
    join public.branches b on b.id = s.branch_id
    join public.staff st on st.id = s.staff_id
    left join public.customers c on c.id = s.customer_id
    left join public.sale_item_serials sis on sis.sale_item_id = i.id
    left join public.serials se on se.id = sis.serial_id
    where s.shop_id = v_me.shop_id
      and (upper(coalesce(se.serial, '')) = upper(v_q)
           or upper(s.invoice_no) = upper(v_q)
           or c.phone = v_q
           or upper(coalesce(se.serial, '')) like upper(v_q) || '%')

    union all

    -- A unit given as a warranty SWAP has no sale line of its own — it left the shelf
    -- through a claim, not a till. Without this the customer walks out with a covered
    -- machine that looks up as unknown, which is the whole point of P11.
    select jsonb_build_object(
      'kind', 'replacement',
      'serial_id', rs.id, 'serial', rs.serial, 'serial_status', rs.status,
      'product_id', rs.product_id, 'product', rp.name,
      'sale_id', cl.sale_id, 'sale_item_id', cl.sale_item_id,
      'invoice_no', (select invoice_no from public.sales where id = cl.sale_id),
      'sold_on', (cl.delivered_at at time zone 'Asia/Dhaka')::date,
      'branch', cb.name, 'sold_by', (select name from public.staff where id = cl.staff_id),
      'customer_id', cl.customer_id,
      'customer_phone', coalesce(cl.customer_phone, cc.phone),
      'customer_name', coalesce(cl.customer_name, cc.name_text),
      'warranty_months', null,
      -- What was LEFT of the original cover, carried across by the claim.
      'warranty_until', cl.warranty_until,
      'warranty_text', 'Replaced under claim ' || cl.claim_no
                       || ', carrying the remaining warranty of ' || coalesce(os.serial, 'the original'),
      'in_warranty', cl.warranty_until is not null and cl.warranty_until >= public.dhaka_today(),
      'days_left', case when cl.warranty_until is not null
                        then cl.warranty_until - public.dhaka_today() end,
      'sale_status', 'completed',
      'open_claim', (select c2.claim_no from public.warranty_claims c2
                     where c2.serial_id = rs.id and c2.status not in ('delivered', 'rejected')
                     order by c2.created_at desc limit 1)
    )
    from public.warranty_claims cl
    join public.serials rs on rs.id = cl.replacement_serial_id
    join public.products rp on rp.id = rs.product_id
    join public.branches cb on cb.id = cl.branch_id
    left join public.serials os on os.id = cl.serial_id
    left join public.customers cc on cc.id = cl.customer_id
    where cl.shop_id = v_me.shop_id and cl.status = 'delivered'
      and (upper(rs.serial) = upper(v_q)
           or upper(cl.claim_no) = upper(v_q)
           or coalesce(cl.customer_phone, cc.phone) = v_q
           or upper(rs.serial) like upper(v_q) || '%')

    union all

    -- And things recorded by hand, for anything sold before the switch.
    select jsonb_build_object(
      'kind', 'manual',
      'serial_id', null, 'serial', mw.serial, 'serial_status', null,
      'product_id', mw.product_id,
      'product', coalesce(p.name, mw.item_text),
      'sale_id', null, 'sale_item_id', null, 'invoice_no', null,
      'sold_on', mw.sold_on,
      'branch', null, 'sold_by', null,
      'customer_id', null, 'customer_phone', mw.customer_phone, 'customer_name', mw.customer_name,
      'warranty_months', null,
      'warranty_until', mw.warranty_until,
      'warranty_text', mw.note,
      'in_warranty', mw.warranty_until is not null and mw.warranty_until >= public.dhaka_today(),
      'days_left', case when mw.warranty_until is not null
                        then mw.warranty_until - public.dhaka_today() end,
      'sale_status', null,
      'open_claim', null
    )
    from public.manual_warranties mw
    left join public.products p on p.id = mw.product_id
    where mw.shop_id = v_me.shop_id
      and (upper(mw.serial) = upper(v_q) or mw.customer_phone = v_q
           or upper(mw.serial) like upper(v_q) || '%')
  ) q;
  return v_out;
end; $$;

/** Record a warranty for something sold before the shop switched over. */
create or replace function public.save_manual_warranty(p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row public.manual_warranties;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  -- A promise the shop is making, so a manager makes it.
  if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
  if coalesce(btrim(p_values->>'serial'), '') = '' then raise exception 'SERIAL_REQUIRED:this item'; end if;
  if (p_values->>'product_id') is null and coalesce(btrim(p_values->>'item_text'), '') = '' then
    raise exception 'ITEM_REQUIRED';
  end if;

  insert into public.manual_warranties (shop_id, serial, product_id, item_text,
                                        customer_phone, customer_name, sold_on,
                                        warranty_until, note, staff_id)
  values (v_me.shop_id, btrim(p_values->>'serial'), (p_values->>'product_id')::uuid,
          nullif(btrim(coalesce(p_values->>'item_text', '')), ''),
          nullif(btrim(coalesce(p_values->>'customer_phone', '')), ''),
          nullif(btrim(coalesce(p_values->>'customer_name', '')), ''),
          (p_values->>'sold_on')::date, (p_values->>'warranty_until')::date,
          p_values->>'note', v_me.id)
  on conflict (shop_id, serial) do update
    set product_id = excluded.product_id, item_text = excluded.item_text,
        customer_phone = excluded.customer_phone, customer_name = excluded.customer_name,
        sold_on = excluded.sold_on, warranty_until = excluded.warranty_until,
        note = excluded.note
  returning * into v_row;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'manual_warranty_recorded', 'serial', v_row.id,
          jsonb_build_object('serial', v_row.serial, 'until', v_row.warranty_until));

  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- Opening a claim
-- ---------------------------------------------------------------------------

/**
 * Take the item in.
 *
 * Whether it was in warranty is recorded AT THIS MOMENT, not worked out later: a claim
 * opened on the last day of cover is in warranty even if it is settled three weeks after
 * the term ran out, and the customer should not lose by the shop being slow.
 */
create or replace function public.open_claim(
  p_branch_id   uuid,
  p_problem     text,
  p_serial_id   uuid default null,
  p_product_id  uuid default null,
  p_item_text   text default null,
  p_problem_type_id uuid default null,
  p_accessories text[] default null,
  p_photo_urls  text[] default null,
  p_customer_phone text default null,
  p_customer_name  text default null,
  p_technician_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_shop     public.shops;
  v_no       text;
  v_id       uuid;
  -- Scalars rather than a record: with no serial there is no sale to find, and an
  -- unassigned record cannot even be read from.
  v_sale_id      uuid;
  v_sale_item_id uuid;
  v_sale_product uuid;
  v_sale_until   date;
  v_sale_cust    uuid;
  v_until    date;
  v_in       boolean := false;
  v_customer uuid;
  v_phone    text := nullif(btrim(coalesce(p_customer_phone, '')), '');
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if coalesce(btrim(p_problem), '') = '' then raise exception 'PROBLEM_REQUIRED'; end if;
  if p_serial_id is null and p_product_id is null
     and coalesce(btrim(coalesce(p_item_text, '')), '') = '' then
    raise exception 'ITEM_REQUIRED';
  end if;
  select * into v_shop from public.shops where id = v_me.shop_id;

  if p_serial_id is not null then
    -- One open claim per unit: two claims on the same laptop is two people chasing the
    -- same supplier and telling the customer different things.
    if exists (select 1 from public.warranty_claims
               where serial_id = p_serial_id and status not in ('delivered', 'rejected')) then
      raise exception 'CLAIM_ALREADY_OPEN';
    end if;

    -- What it was sold on, so the cover and the customer come from the sale rather than
    -- from whatever the counter types.
    select i.id, i.sale_id, i.product_id, i.warranty_until, s.customer_id
      into v_sale_item_id, v_sale_id, v_sale_product, v_sale_until, v_sale_cust
    from public.sale_item_serials sis
    join public.sale_items i on i.id = sis.sale_item_id
    join public.sales s on s.id = i.sale_id
    where sis.serial_id = p_serial_id and s.shop_id = v_me.shop_id
    order by s.created_at desc limit 1;

    v_until := coalesce(v_sale_until,
                        (select warranty_until from public.manual_warranties
                         where shop_id = v_me.shop_id
                           and serial = (select serial from public.serials where id = p_serial_id)));
    v_customer := v_sale_cust;
  else
    v_until := null;
  end if;

  v_in := v_until is not null and v_until >= public.dhaka_today();

  if v_phone is not null and v_customer is null then
    select id into v_customer from public.customers
      where shop_id = v_me.shop_id and phone = v_phone;
  end if;

  v_no := public.next_document_number(p_branch_id, 'claim');
  insert into public.warranty_claims (
    shop_id, branch_id, claim_no, serial_id, product_id, item_text, sale_id, sale_item_id,
    customer_id, customer_phone, customer_name, in_warranty, warranty_until,
    problem_type_id, problem, accessories, photo_urls, technician_id,
    approval_status, staff_id)
  values (
    v_me.shop_id, p_branch_id, v_no, p_serial_id,
    coalesce(p_product_id, v_sale_product), nullif(btrim(coalesce(p_item_text, '')), ''),
    v_sale_id, v_sale_item_id,
    v_customer, v_phone, nullif(btrim(coalesce(p_customer_name, '')), ''),
    v_in, v_until, p_problem_type_id, btrim(p_problem), p_accessories, p_photo_urls,
    p_technician_id,
    case when v_shop.claim_approval then 'awaiting_approval' else 'approved' end,
    v_me.id)
  returning id into v_id;

  -- The unit is in the shop's hands and belongs to someone else: not stock, not sold.
  if p_serial_id is not null then
    update public.serials set status = 'rma' where id = p_serial_id;
  end if;

  insert into public.claim_events (claim_id, shop_id, from_status, to_status, note, staff_id)
  values (v_id, v_me.shop_id, null, 'received', btrim(p_problem), v_me.id);

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'claim_opened', 'warranty_claim', v_id,
          jsonb_build_object('claim_no', v_no, 'problem', btrim(p_problem),
                             'in_warranty', v_in, 'warranty_until', v_until,
                             'serial', (select serial from public.serials where id = p_serial_id)));

  return jsonb_build_object('id', v_id, 'claim_no', v_no, 'status', 'received',
                            'in_warranty', v_in, 'warranty_until', v_until,
                            'needs_approval', v_shop.claim_approval);
end; $$;

-- ---------------------------------------------------------------------------
-- Moving it along
-- ---------------------------------------------------------------------------

/**
 * Change where the claim is up to.
 *
 * Every step is timed and attributed, because "how long have you had it?" is the one
 * question a customer will argue about and the shop needs an answer that is not a
 * memory. Delivering a swap unit copies the REMAINING warranty onto the new serial —
 * see the note at the top of this file.
 */
create or replace function public.set_claim_status(
  p_claim_id    uuid,
  p_status      text,
  p_note        text default null,
  p_supplier_id uuid default null,
  p_replacement_serial_id uuid default null,
  p_technician_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_claim  public.warranty_claims;
  v_loc    uuid;
  v_until  date;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  select * into v_claim from public.warranty_claims
    where id = p_claim_id and shop_id = v_me.shop_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if not public.can_use_branch(v_claim.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if v_claim.approval_status = 'awaiting_approval' then raise exception 'CLAIM_NOT_APPROVED'; end if;
  if v_claim.status in ('delivered', 'rejected') then
    raise exception 'CLAIM_ALREADY_CLOSED:%', v_claim.status;
  end if;
  if p_status not in ('diagnosed', 'with_supplier', 'back_from_supplier', 'repaired',
                      'ready', 'delivered', 'rejected') then
    raise exception 'BAD_CLAIM_STATUS:%', p_status;
  end if;
  -- Sending it out needs to say who to, or "with the supplier" means nothing.
  if p_status = 'with_supplier' and coalesce(p_supplier_id, v_claim.supplier_id) is null then
    raise exception 'CLAIM_NEEDS_SUPPLIER';
  end if;
  if p_status = 'rejected' and coalesce(btrim(coalesce(p_note, '')), '') = '' then
    raise exception 'REJECT_REASON_REQUIRED';
  end if;

  v_loc := public.default_location(v_claim.branch_id);

  update public.warranty_claims set
    status = p_status,
    supplier_id = coalesce(p_supplier_id, supplier_id),
    technician_id = coalesce(p_technician_id, technician_id),
    sent_at = case when p_status = 'with_supplier' then now() else sent_at end,
    back_at = case when p_status = 'back_from_supplier' then now() else back_at end,
    replacement_serial_id = coalesce(p_replacement_serial_id, replacement_serial_id),
    resolution = case when p_status in ('delivered', 'rejected', 'repaired')
                      then coalesce(p_note, resolution) else resolution end,
    delivered_at = case when p_status = 'delivered' then now() else delivered_at end
  where id = p_claim_id;

  -- Where the unit physically is, at each step.
  if v_claim.serial_id is not null then
    if p_status = 'with_supplier' then
      update public.serials set status = 'with_supplier' where id = v_claim.serial_id;
    elsif p_status in ('back_from_supplier', 'repaired', 'ready') then
      update public.serials set status = 'rma', location_id = v_loc where id = v_claim.serial_id;
    end if;
  end if;

  if p_status = 'delivered' then
    if p_replacement_serial_id is not null then
      -- A SWAP. The old unit stays in RMA as the shop's problem; the new one goes to the
      -- customer carrying what was left of the original cover.
      v_until := v_claim.warranty_until;
      update public.serials set status = 'sold', sale_id = v_claim.sale_id
        where id = p_replacement_serial_id;
      -- The replacement leaves the shelf, because it physically has.
      update public.branch_stock set qty = greatest(qty - 1, 0), updated_at = now()
        where product_id = (select product_id from public.serials where id = p_replacement_serial_id)
          and location_id = v_loc;
      insert into public.stock_movements (shop_id, branch_id, location_id, product_id,
                                          qty_change, reason, reason_detail, staff_id, note)
      select v_me.shop_id, v_claim.branch_id, v_loc, s.product_id, -1, 'adjust_out',
             'other', v_me.id, v_claim.claim_no || ': given as a warranty replacement'
      from public.serials s where s.id = p_replacement_serial_id;
      if v_claim.serial_id is not null then
        update public.serials set status = 'rma' where id = v_claim.serial_id;
      end if;
    elsif v_claim.serial_id is not null then
      -- The same unit, repaired and handed back. It is the customer's again.
      update public.serials set status = 'sold', sale_id = v_claim.sale_id
        where id = v_claim.serial_id;
    end if;
  end if;

  insert into public.claim_events (claim_id, shop_id, from_status, to_status, note, staff_id)
  values (p_claim_id, v_me.shop_id, v_claim.status, p_status, p_note, v_me.id);

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_claim.branch_id, v_me.id, 'claim_' || p_status, 'warranty_claim',
          p_claim_id,
          jsonb_build_object('claim_no', v_claim.claim_no, 'from', v_claim.status,
                             'to', p_status, 'note', p_note,
                             'supplier', (select name from public.suppliers
                                          where id = coalesce(p_supplier_id, v_claim.supplier_id)),
                             'replacement', (select serial from public.serials
                                             where id = p_replacement_serial_id)));

  return jsonb_build_object(
    'claim_no', v_claim.claim_no, 'status', p_status,
    'replacement_serial', (select serial from public.serials where id = p_replacement_serial_id),
    'warranty_until', v_claim.warranty_until,
    'days_with_us', (public.dhaka_today() - (v_claim.created_at at time zone 'Asia/Dhaka')::date));
end; $$;

/** A manager signs off a claim, when the shop has asked for that. */
create or replace function public.approve_claim(
  p_claim_id uuid, p_approve boolean, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_claim public.warranty_claims; v_new text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('approve') then raise exception 'NOT_ALLOWED:approve'; end if;
  select * into v_claim from public.warranty_claims where id = p_claim_id and shop_id = v_me.shop_id;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.approval_status <> 'awaiting_approval' then
    raise exception 'NOT_AWAITING_APPROVAL:%', v_claim.approval_status;
  end if;
  if not p_approve and coalesce(btrim(coalesce(p_reason, '')), '') = '' then
    raise exception 'CANCEL_REASON_REQUIRED';
  end if;

  v_new := case when p_approve then 'approved' else 'cancelled' end;
  update public.warranty_claims set approval_status = v_new where id = p_claim_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_claim.branch_id, v_me.id,
          case when p_approve then 'claim_approved' else 'claim_cancelled' end,
          'warranty_claim', p_claim_id,
          jsonb_build_object('claim_no', v_claim.claim_no, 'reason', p_reason));

  return jsonb_build_object('claim_no', v_claim.claim_no, 'approval_status', v_new);
end; $$;

/**
 * Parts used fixing something in-house. They come out of stock, because they physically
 * left it — a repair that quietly consumes a 2,000-taka board and shows nothing is how
 * stock figures stop matching the shelf.
 */
create or replace function public.use_claim_part(
  p_claim_id uuid, p_product_id uuid, p_qty integer default 1, p_serial_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_claim public.warranty_claims; v_loc uuid; v_prod public.products;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('adjust_stock') then raise exception 'NOT_ALLOWED:adjust_stock'; end if;
  select * into v_claim from public.warranty_claims where id = p_claim_id and shop_id = v_me.shop_id;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if not public.can_use_branch(v_claim.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'BAD_QTY:the part'; end if;

  select * into v_prod from public.products where id = p_product_id and shop_id = v_me.shop_id;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  v_loc := public.default_location(v_claim.branch_id);

  if v_prod.is_serial then
    if p_serial_id is null then raise exception 'SERIAL_REQUIRED:%', v_prod.name; end if;
    update public.serials set status = 'sold' where id = p_serial_id and status = 'in_stock';
    if not found then raise exception 'SERIAL_NOT_AVAILABLE:%', v_prod.name; end if;
  end if;

  if (select coalesce(qty, 0) from public.branch_stock
      where product_id = p_product_id and location_id = v_loc) < p_qty then
    raise exception 'OUT_OF_STOCK:%', v_prod.name;
  end if;
  update public.branch_stock set qty = qty - p_qty, updated_at = now()
    where product_id = p_product_id and location_id = v_loc;

  insert into public.claim_parts (claim_id, shop_id, product_id, qty, serial_id)
  values (p_claim_id, v_me.shop_id, p_product_id, p_qty, p_serial_id);

  insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                      reason, reason_detail, staff_id, note)
  values (v_me.shop_id, v_claim.branch_id, v_loc, p_product_id, -p_qty, 'adjust_out',
          'internal_use', v_me.id, v_claim.claim_no || ': part used in repair');

  return jsonb_build_object('claim_no', v_claim.claim_no, 'product', v_prod.name, 'qty', p_qty);
end; $$;

-- ---------------------------------------------------------------------------
-- The lists a service counter works from
-- ---------------------------------------------------------------------------

/**
 * Claims, filtered the way a service counter actually asks: by status, by branch, by
 * technician, and "what has been sitting here too long".
 *
 * `days_waiting` is the figure that matters. A claim nobody has touched for three weeks
 * is the one the customer is about to ring about, and BMS has no way to see it.
 */
create or replace function public.claim_list(
  p_branch_id uuid default null,
  p_status    text default null,
  p_technician_id uuid default null,
  p_waiting_over integer default null,
  p_query     text default null,
  p_limit     integer default 100
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_out jsonb; v_q text := nullif(btrim(coalesce(p_query, '')), '');
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  select coalesce(jsonb_agg(x order by (x->>'days_waiting')::int desc), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'id', cl.id, 'claim_no', cl.claim_no, 'status', cl.status,
      'approval_status', cl.approval_status,
      'branch', b.name, 'branch_id', cl.branch_id,
      'product', coalesce(p.name, cl.item_text),
      'serial', se.serial, 'serial_id', cl.serial_id,
      'problem', cl.problem,
      'problem_type', pt.name,
      'accessories', to_jsonb(coalesce(cl.accessories, '{}')),
      'in_warranty', cl.in_warranty, 'warranty_until', cl.warranty_until,
      'customer_phone', coalesce(cl.customer_phone, c.phone),
      'customer_name', coalesce(cl.customer_name, c.name_text),
      'technician', t.name, 'technician_id', cl.technician_id,
      'supplier', sup.name, 'supplier_id', cl.supplier_id,
      'sent_at', cl.sent_at, 'back_at', cl.back_at,
      'created_at', cl.created_at, 'delivered_at', cl.delivered_at,
      'taken_in_by', st.name,
      'resolution', cl.resolution,
      'replacement_serial', rs.serial,
      -- How long the shop has had it. Stops at delivery, because after that it is not
      -- waiting for anything.
      'days_waiting', coalesce(cl.delivered_at::date, public.dhaka_today())
                      - (cl.created_at at time zone 'Asia/Dhaka')::date,
      'days_with_supplier', case when cl.sent_at is not null
                                 then coalesce(cl.back_at::date, public.dhaka_today())
                                      - (cl.sent_at at time zone 'Asia/Dhaka')::date end,
      'open', cl.status not in ('delivered', 'rejected'),
      'events', (select coalesce(jsonb_agg(jsonb_build_object(
                   'at', e.created_at, 'to', e.to_status, 'note', e.note,
                   'who', (select name from public.staff where id = e.staff_id))
                   order by e.created_at), '[]'::jsonb)
                 from public.claim_events e where e.claim_id = cl.id),
      'parts', (select coalesce(jsonb_agg(jsonb_build_object(
                  'product', pp.name, 'qty', cp.qty)), '[]'::jsonb)
                from public.claim_parts cp join public.products pp on pp.id = cp.product_id
                where cp.claim_id = cl.id)
    ) as x
    from public.warranty_claims cl
    join public.branches b on b.id = cl.branch_id
    join public.staff st on st.id = cl.staff_id
    left join public.products p on p.id = cl.product_id
    left join public.serials se on se.id = cl.serial_id
    left join public.serials rs on rs.id = cl.replacement_serial_id
    left join public.problem_types pt on pt.id = cl.problem_type_id
    left join public.technicians t on t.id = cl.technician_id
    left join public.suppliers sup on sup.id = cl.supplier_id
    left join public.customers c on c.id = cl.customer_id
    where cl.shop_id = v_me.shop_id
      and cl.branch_id = any(select unnest(public.current_branch_ids()))
      and (p_branch_id is null or cl.branch_id = p_branch_id)
      and (p_status is null
           or (p_status = 'open' and cl.status not in ('delivered', 'rejected'))
           or cl.status = p_status)
      and (p_technician_id is null or cl.technician_id = p_technician_id)
      and (p_waiting_over is null
           or coalesce(cl.delivered_at::date, public.dhaka_today())
              - (cl.created_at at time zone 'Asia/Dhaka')::date >= p_waiting_over)
      and (v_q is null
           or upper(cl.claim_no) like upper(v_q) || '%'
           or upper(coalesce(se.serial, '')) like upper(v_q) || '%'
           or coalesce(cl.customer_phone, c.phone, '') like '%' || v_q || '%'
           or coalesce(p.name, cl.item_text, '') ilike '%' || v_q || '%')
    limit greatest(coalesce(p_limit, 100), 1)
  ) q;
  return v_out;
end; $$;

/** What is out with which supplier, and since when. */
create or replace function public.supplier_rma_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;

  select coalesce(jsonb_agg(x order by (x->>'days_out')::int desc), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'supplier', s.name, 'supplier_id', s.id,
      'claim_no', cl.claim_no, 'claim_id', cl.id,
      'product', coalesce(p.name, cl.item_text), 'serial', se.serial,
      'sent_at', cl.sent_at,
      'days_out', public.dhaka_today() - (cl.sent_at at time zone 'Asia/Dhaka')::date,
      'problem', cl.problem,
      'branch', b.name
    ) as x
    from public.warranty_claims cl
    join public.suppliers s on s.id = cl.supplier_id
    join public.branches b on b.id = cl.branch_id
    left join public.products p on p.id = cl.product_id
    left join public.serials se on se.id = cl.serial_id
    where cl.shop_id = (select public.current_shop_id())
      and cl.status = 'with_supplier'
      and cl.branch_id = any(select unnest(public.current_branch_ids()))
  ) q;
  return v_out;
end; $$;

/** Problem types and technicians, for the dropdowns. */
create or replace function public.save_problem_type(p_id uuid, p_name text, p_active boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row public.problem_types;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
  if coalesce(btrim(coalesce(p_name, '')), '') = '' then raise exception 'NAME_REQUIRED'; end if;

  if p_id is null then
    insert into public.problem_types (shop_id, name) values (v_me.shop_id, btrim(p_name))
    on conflict (shop_id, name) do update set active = true
    returning * into v_row;
  else
    update public.problem_types set name = btrim(p_name), active = coalesce(p_active, active)
      where id = p_id and shop_id = v_me.shop_id returning * into v_row;
    if v_row.id is null then raise exception 'SETTING_NOT_FOUND'; end if;
  end if;
  return to_jsonb(v_row);
end; $$;

create or replace function public.save_technician(p_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row public.technicians;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
  if p_id is null and coalesce(btrim(p_values->>'name'), '') = '' then
    raise exception 'NAME_REQUIRED';
  end if;

  if p_id is null then
    insert into public.technicians (shop_id, name, phone, staff_id)
    values (v_me.shop_id, btrim(p_values->>'name'),
            nullif(btrim(coalesce(p_values->>'phone', '')), ''),
            (p_values->>'staff_id')::uuid)
    on conflict (shop_id, name) do update
      set phone = excluded.phone, staff_id = excluded.staff_id, active = true
    returning * into v_row;
  else
    update public.technicians set
      name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
      phone = case when p_values ? 'phone' then nullif(btrim(coalesce(p_values->>'phone','')), '') else phone end,
      staff_id = case when p_values ? 'staff_id' then (p_values->>'staff_id')::uuid else staff_id end,
      active = coalesce((p_values->>'active')::boolean, active)
    where id = p_id and shop_id = v_me.shop_id returning * into v_row;
    if v_row.id is null then raise exception 'SETTING_NOT_FOUND'; end if;
  end if;
  return to_jsonb(v_row);
end; $$;

/** A new shop gets the faults a computer shop actually sees. */
create or replace function public.seed_warranty_defaults(p_shop_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.problem_types (shop_id, name, sort)
  values (p_shop_id, 'Not switching on', 1),
         (p_shop_id, 'Screen fault', 2),
         (p_shop_id, 'Keyboard fault', 3),
         (p_shop_id, 'Battery not holding', 4),
         (p_shop_id, 'Overheating', 5),
         (p_shop_id, 'No sound', 6),
         (p_shop_id, 'Port or socket damaged', 7),
         (p_shop_id, 'Not detected', 8),
         (p_shop_id, 'Physical damage', 9),
         (p_shop_id, 'Other', 99)
  on conflict (shop_id, name) do nothing;
$$;

select public.seed_warranty_defaults(id) from public.shops;

-- And every shop made from now on. Same function as P2's, with one more line, so a
-- brand-new shop opens with a problem list rather than an empty dropdown.
create or replace function public.seed_shop_defaults(p_shop_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.units (shop_id, name, allow_decimals, sort) values
    (p_shop_id, 'pcs', false, 1), (p_shop_id, 'box', false, 2), (p_shop_id, 'set', false, 3),
    (p_shop_id, 'pair', false, 4), (p_shop_id, 'metre', true, 5), (p_shop_id, 'kg', true, 6)
  on conflict (shop_id, name) do nothing;

  -- Seeded but unused until the VAT switch goes on.
  insert into public.vat_rates (shop_id, name, pct, inclusive, is_default) values
    (p_shop_id, 'VAT 5% (inclusive)', 5, true, true),
    (p_shop_id, 'VAT 7.5% (inclusive)', 7.5, true, false),
    (p_shop_id, 'VAT 15% (inclusive)', 15, true, false),
    (p_shop_id, 'No VAT', 0, true, false)
  on conflict (shop_id, name) do nothing;

  insert into public.payment_methods (shop_id, key, label, enabled, needs_ref, sort) values
    (p_shop_id, 'cash',   'Cash',          true,  false, 1),
    (p_shop_id, 'bkash',  'bKash',         true,  true,  2),
    (p_shop_id, 'nagad',  'Nagad',         true,  true,  3),
    (p_shop_id, 'card',   'Card',          true,  true,  4),
    (p_shop_id, 'rocket', 'Rocket',        false, true,  5),
    (p_shop_id, 'bank',   'Bank transfer', false, true,  6),
    (p_shop_id, 'cheque', 'Cheque',        false, true,  7),
    (p_shop_id, 'due',    'On due (baki)', false, false, 8)
  on conflict (shop_id, key) do nothing;

  insert into public.card_types (shop_id, name, charge_pct) values
    (p_shop_id, 'Visa', 2), (p_shop_id, 'Mastercard', 2), (p_shop_id, 'American Express', 3)
  on conflict (shop_id, name) do nothing;

  insert into public.bank_accounts (shop_id, name, kind) values
    (p_shop_id, 'Counter cash drawer', 'cash_drawer')
  on conflict (shop_id, name) do nothing;

  -- The wording a computer shop actually uses, and the receipt text BMS never prints.
  insert into public.warranty_terms (shop_id, name, months, receipt_text) values
    (p_shop_id, 'No warranty', 0, 'No warranty on this item.'),
    (p_shop_id, '6 months replacement', 6, 'Replacement within 6 months for manufacturing faults. Physical damage and burn marks are not covered.'),
    (p_shop_id, '1 year replacement', 12, 'Replacement within 1 year for manufacturing faults. Physical damage and burn marks are not covered.'),
    (p_shop_id, '1 year service only', 12, 'Service within 1 year. Replacement is not included.'),
    (p_shop_id, '3 years service', 36, 'Service within 3 years. Replacement is not included.')
  on conflict (shop_id, name) do nothing;

  insert into public.discount_types (shop_id, name) values
    (p_shop_id, 'Regular customer'), (p_shop_id, 'Bulk purchase'),
    (p_shop_id, 'Staff discount'), (p_shop_id, 'Festival offer'),
    (p_shop_id, 'Price match')
  on conflict (shop_id, name) do nothing;

  insert into public.extra_charges (shop_id, name, kind, value, taxable) values
    (p_shop_id, 'Delivery', 'fixed', 0, false),
    (p_shop_id, 'Installation', 'fixed', 0, false),
    (p_shop_id, 'Service charge', 'percent', 0, false)
  on conflict (shop_id, name) do nothing;

  insert into public.transaction_categories (shop_id, name) values
    (p_shop_id, 'Walk-in'), (p_shop_id, 'Corporate'), (p_shop_id, 'Online'), (p_shop_id, 'Service')
  on conflict (shop_id, name) do nothing;

  -- Everything advanced is OFF, so a small shop sees a simple app.
  insert into public.shop_features (shop_id, feature, enabled) values
    (p_shop_id, 'vat', false), (p_shop_id, 'multi_location', false),
    (p_shop_id, 'price_lists', false), (p_shop_id, 'credit_sales', false),
    (p_shop_id, 'purchase_orders', false), (p_shop_id, 'transfers', false),
    (p_shop_id, 'accounts', false), (p_shop_id, 'sms', false),
    (p_shop_id, 'extra_charges', false), (p_shop_id, 'hs_codes', false),
    (p_shop_id, 'managers_see_dashboard', false), (p_shop_id, 'managers_see_accounts', false),
    (p_shop_id, 'managers_see_settings', false)
  on conflict (shop_id, feature) do nothing;

  -- Role defaults chosen so the behaviour already tested stays exactly the same:
  -- a cashier sells, a manager runs the shop floor, an owner does everything.
  insert into public.role_permissions (shop_id, role, perm, allowed, num_limit)
  select p_shop_id, r.role, k.key,
    case r.role
      when 'owner' then true
      when 'manager' then k.key in ('sell','give_discount','change_price','see_cost','void_sale',
                                    'return_sale','reprint','approve','receive_stock','adjust_stock',
                                    'transfer_stock','view_reports','export_reports')
      else k.key in ('sell','give_discount','reprint')
    end,
    case when k.key = 'give_discount' then
      case r.role when 'owner' then 100 when 'manager' then 10 else 5 end
    end
  from public.permission_keys k
  cross join (values ('owner'), ('manager'), ('cashier')) as r(role)
  on conflict (shop_id, role, perm) do nothing;

  -- Every branch starts with a sequence for each document type.
  insert into public.document_sequences (shop_id, branch_id, doc_type)
  select p_shop_id, b.id, d.doc_type
  from public.branches b
  cross join (values ('invoice'),('return'),('quote'),('order'),('challan'),('grn'),('po'),
                     ('requisition'),('transfer'),('adjustment'),('receipt'),('payment'),
                     ('voucher'),('cheque')) as d(doc_type)
  where b.shop_id = p_shop_id
  on conflict (shop_id, branch_id, doc_type) do nothing;

  -- Expense categories, so a cash-out has something to be filed under (P8).
  perform public.seed_cash_defaults(p_shop_id);
  -- And the faults a computer shop actually sees (P11).
  perform public.seed_warranty_defaults(p_shop_id);
end; $$;

-- ---------------------------------------------------------------------------
-- The shop setting
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
    card_charge_mode = coalesce(nullif(p_values->>'card_charge_mode', ''), card_charge_mode),
    claim_approval = coalesce((p_values->>'claim_approval')::boolean, claim_approval)
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

alter table public.problem_types      enable row level security;
alter table public.technicians        enable row level security;
alter table public.warranty_claims    enable row level security;
alter table public.claim_events       enable row level security;
alter table public.claim_parts        enable row level security;
alter table public.manual_warranties  enable row level security;

create policy problem_types_read on public.problem_types for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy technicians_read on public.technicians for select to authenticated
  using (shop_id = (select public.current_shop_id()));
-- Anyone at the branch can see its claims: the person at the counter is the one the
-- customer asks "where is my laptop?".
create policy warranty_claims_read on public.warranty_claims for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())));
create policy claim_events_read on public.claim_events for select to authenticated
  using (exists (select 1 from public.warranty_claims cl where cl.id = claim_id
                 and cl.branch_id = any(select unnest(public.current_branch_ids()))));
create policy claim_parts_read on public.claim_parts for select to authenticated
  using (exists (select 1 from public.warranty_claims cl where cl.id = claim_id
                 and cl.branch_id = any(select unnest(public.current_branch_ids()))));
create policy manual_warranties_read on public.manual_warranties for select to authenticated
  using (shop_id = (select public.current_shop_id()));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.warranty_lookup(text) from public, anon;
revoke execute on function public.save_manual_warranty(jsonb) from public, anon;
revoke execute on function public.open_claim(uuid, text, uuid, uuid, text, uuid, text[], text[], text, text, uuid) from public, anon;
revoke execute on function public.set_claim_status(uuid, text, text, uuid, uuid, uuid) from public, anon;
revoke execute on function public.approve_claim(uuid, boolean, text) from public, anon;
revoke execute on function public.use_claim_part(uuid, uuid, integer, uuid) from public, anon;
revoke execute on function public.claim_list(uuid, text, uuid, integer, text, integer) from public, anon;
revoke execute on function public.supplier_rma_list() from public, anon;
revoke execute on function public.save_problem_type(uuid, text, boolean) from public, anon;
revoke execute on function public.save_technician(uuid, jsonb) from public, anon;
revoke execute on function public.seed_warranty_defaults(uuid) from public, anon, authenticated;

grant execute on function public.warranty_lookup(text) to authenticated;
grant execute on function public.save_manual_warranty(jsonb) to authenticated;
grant execute on function public.open_claim(uuid, text, uuid, uuid, text, uuid, text[], text[], text, text, uuid) to authenticated;
grant execute on function public.set_claim_status(uuid, text, text, uuid, uuid, uuid) to authenticated;
grant execute on function public.approve_claim(uuid, boolean, text) to authenticated;
grant execute on function public.use_claim_part(uuid, uuid, integer, uuid) to authenticated;
grant execute on function public.claim_list(uuid, text, uuid, integer, text, integer) to authenticated;
grant execute on function public.supplier_rma_list() to authenticated;
grant execute on function public.save_problem_type(uuid, text, boolean) to authenticated;
grant execute on function public.save_technician(uuid, jsonb) to authenticated;
