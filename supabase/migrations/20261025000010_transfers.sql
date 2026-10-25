-- P7 — Branch transfers
--
-- Moving stock between branches, and between locations inside one branch. BMS has a
-- Transfer menu and a separate Receive menu; this is one document with two ends, so
-- what left and what arrived are the same row and can never disagree.
--
-- WHERE STOCK LIVES WHILE IT IS IN A VAN
-- Sending takes the stock out of the source location straight away and does NOT put it
-- anywhere else. The goods are the transfer document until someone receives them. That
-- means the shop's total on-hand dips for as long as the van is on the road, which is
-- the truth: nobody can sell those units at either end. The alternative — a hidden
-- "in transit" location that counts as stock — makes the figures add up on paper while
-- letting a branch promise goods it hasn't got.
--
-- A shortage is not quietly absorbed. If 2 laptops left and 1 arrived, the transfer
-- stays DISPUTED, with the missing unit still belonging to nobody, until a manager says
-- what happened: it went back to the sender, or it is written off. Either way it is
-- logged. Deciding automatically would hide exactly the loss this is here to catch.

-- ---------------------------------------------------------------------------
-- A serial can now be on the road
-- ---------------------------------------------------------------------------

alter table public.serials drop constraint serials_status_check;
alter table public.serials add constraint serials_status_check
  check (status in ('in_stock', 'sold', 'returned', 'rma', 'in_transit'));

-- ---------------------------------------------------------------------------
-- A request for a transfer is its own kind of document
-- ---------------------------------------------------------------------------

-- "TR-MB-2026000001 asked for it" and "TR-MB-2026000002 sent it" reading as the same
-- series is how paperwork gets mixed up, so a request gets its own type and its own
-- prefix. Three letters derived from the type name would give both "TRA".
alter table public.document_sequences drop constraint document_sequences_doc_type_check;
alter table public.document_sequences add constraint document_sequences_doc_type_check
  check (doc_type in (
    'invoice', 'return', 'quote', 'order', 'challan', 'grn', 'po', 'requisition',
    'transfer', 'transfer_request', 'adjustment', 'receipt', 'payment', 'voucher', 'cheque'
  ));

/**
 * Hand out the next number for a document, inside the caller's transaction.
 *
 * Same as before, with one addition: a document type whose first three letters would
 * clash with another type's gets a prefix of its own.
 */
create or replace function public.next_document_number(p_branch_id uuid, p_doc_type text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_shop    uuid := (select public.current_shop_id());
  v_branch  public.branches;
  v_seq     public.document_sequences;
  v_default text := case p_doc_type
                      when 'transfer_request' then 'TRQ'
                      else upper(substr(p_doc_type, 1, 3))
                    end;
begin
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  select * into v_branch from public.branches where id = p_branch_id;

  insert into public.document_sequences (shop_id, branch_id, doc_type)
  values (v_shop, p_branch_id, p_doc_type)
  on conflict (shop_id, branch_id, doc_type) do nothing;

  -- for update: two tills asking at once must not get the same number.
  select * into v_seq from public.document_sequences
    where shop_id = v_shop and branch_id = p_branch_id and doc_type = p_doc_type for update;

  update public.document_sequences set next_number = next_number + 1
    where shop_id = v_shop and branch_id = p_branch_id and doc_type = p_doc_type;

  return coalesce(nullif(v_seq.prefix, ''), v_default) || '-' || v_branch.code
         || '-' || to_char(public.dhaka_today(), 'YYYY') || lpad(v_seq.next_number::text, 6, '0');
end; $$;

-- ---------------------------------------------------------------------------
-- Which branch may send to which
-- ---------------------------------------------------------------------------

-- BMS calls this "Branch Wise Transfer Fixing". A shop that has not set any route can
-- send anywhere: a two-branch shop should not have to fill in a table before it can
-- move a keyboard. The moment the owner adds the FIRST route, the list becomes the
-- rule and anything not on it is refused — otherwise adding one route would silently
-- leave every other pair open, which is the opposite of what the owner just asked for.
create table public.transfer_routes (
  shop_id        uuid not null references public.shops(id) on delete cascade,
  from_branch_id uuid not null references public.branches(id) on delete cascade,
  to_branch_id   uuid not null references public.branches(id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (from_branch_id, to_branch_id),
  check (from_branch_id <> to_branch_id)
);

create or replace function public.can_transfer(p_from uuid, p_to uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_from = p_to then false
    when not exists (select 1 from public.transfer_routes
                     where shop_id = (select public.current_shop_id())) then true
    else exists (select 1 from public.transfer_routes
                 where from_branch_id = p_from and to_branch_id = p_to)
  end;
$$;

/** Owner only: open or close one direction between two branches. */
create or replace function public.save_transfer_route(
  p_from uuid, p_to uuid, p_allowed boolean
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_from text; v_to text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  if p_from = p_to then raise exception 'SAME_BRANCH'; end if;

  select name into v_from from public.branches where id = p_from and shop_id = v_me.shop_id;
  select name into v_to from public.branches where id = p_to and shop_id = v_me.shop_id;
  if v_from is null or v_to is null then raise exception 'BRANCH_NOT_FOUND'; end if;

  if p_allowed then
    insert into public.transfer_routes (shop_id, from_branch_id, to_branch_id)
    values (v_me.shop_id, p_from, p_to) on conflict do nothing;
  else
    delete from public.transfer_routes where from_branch_id = p_from and to_branch_id = p_to;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id,
          case when p_allowed then 'transfer_route_opened' else 'transfer_route_closed' end,
          'branch', p_from,
          jsonb_build_object('from', v_from, 'to', v_to));

  return jsonb_build_object('from', v_from, 'to', v_to, 'allowed', p_allowed);
end; $$;

-- ---------------------------------------------------------------------------
-- Transfer requests: one branch asks another
-- ---------------------------------------------------------------------------

create table public.transfer_requests (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  -- Who is being asked, and who is asking.
  from_branch_id uuid not null references public.branches(id),
  to_branch_id   uuid not null references public.branches(id),
  req_no        text not null,
  status        text not null default 'submitted'
                check (status in ('submitted', 'approved', 'rejected', 'sent', 'cancelled')),
  note          text,
  decided_by    uuid references public.staff(id),
  decided_at    timestamptz,
  decision_note text,
  staff_id      uuid not null references public.staff(id),
  created_at    timestamptz not null default now(),
  unique (shop_id, req_no),
  check (from_branch_id <> to_branch_id)
);
create index transfer_requests_from_idx on public.transfer_requests(from_branch_id, created_at desc);
create index transfer_requests_to_idx on public.transfer_requests(to_branch_id, created_at desc);

create table public.transfer_request_items (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.transfer_requests(id) on delete cascade,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.products(id),
  qty        integer not null check (qty > 0)
);
create index transfer_request_items_req_idx on public.transfer_request_items(request_id);

-- ---------------------------------------------------------------------------
-- Transfers
-- ---------------------------------------------------------------------------

create table public.transfers (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  transfer_no      text not null,
  from_branch_id   uuid not null references public.branches(id),
  from_location_id uuid not null references public.stock_locations(id),
  to_branch_id     uuid not null references public.branches(id),
  to_location_id   uuid not null references public.stock_locations(id),
  status           text not null default 'in_transit'
                   check (status in ('in_transit', 'received', 'disputed', 'cancelled')),
  note             text,
  request_id       uuid references public.transfer_requests(id) on delete set null,
  sent_by          uuid not null references public.staff(id),
  sent_at          timestamptz not null default now(),
  received_by      uuid references public.staff(id),
  received_at      timestamptz,
  resolved_by      uuid references public.staff(id),
  resolved_at      timestamptz,
  resolution       text check (resolution is null or resolution in ('returned', 'written_off')),
  -- What the goods are worth at cost. Transfers never make a profit: a branch is not a
  -- customer, and marking stock up on the way would invent margin out of nothing.
  total_cost       numeric(12,2) not null default 0,
  created_at       timestamptz not null default now(),
  unique (shop_id, transfer_no)
);
create index transfers_from_idx on public.transfers(from_branch_id, created_at desc);
create index transfers_to_idx on public.transfers(to_branch_id, created_at desc);

create table public.transfer_items (
  id           uuid primary key default gen_random_uuid(),
  transfer_id  uuid not null references public.transfers(id) on delete cascade,
  shop_id      uuid not null references public.shops(id) on delete cascade,
  product_id   uuid not null references public.products(id),
  qty          integer not null check (qty > 0),
  received_qty integer not null default 0 check (received_qty >= 0),
  -- Arrived, but broken. Counted as received so the van is accounted for, then written
  -- off at the destination, because that is where the damage was found.
  damaged_qty  integer not null default 0 check (damaged_qty >= 0),
  unit_cost    numeric(12,2),
  note         text
);
create index transfer_items_transfer_idx on public.transfer_items(transfer_id);

create table public.transfer_item_serials (
  transfer_item_id uuid not null references public.transfer_items(id) on delete cascade,
  serial_id        uuid not null references public.serials(id) on delete cascade,
  -- Null until the other end says. True = arrived fine, false = arrived broken.
  arrived_ok       boolean,
  primary key (transfer_item_id, serial_id)
);

-- ---------------------------------------------------------------------------
-- Asking
-- ---------------------------------------------------------------------------

/**
 * Branch B asks Branch A for stock. Optional: a manager who can see both branches can
 * simply send. This exists for the branch that cannot.
 */
create or replace function public.save_transfer_request(
  p_from_branch uuid,
  p_to_branch   uuid,
  p_lines       jsonb,          -- [{ product_id, qty }]
  p_note        text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_id uuid; v_no text; v_line jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('transfers') then raise exception 'FEATURE_OFF:transfers'; end if;
  -- You ask FOR your own branch, so that is the one you must be allowed to work in.
  if not public.can_use_branch(p_to_branch) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if not exists (select 1 from public.branches where id = p_from_branch and shop_id = v_me.shop_id and active) then
    raise exception 'BRANCH_NOT_FOUND';
  end if;
  if not public.can_transfer(p_from_branch, p_to_branch) then raise exception 'TRANSFER_NOT_ALLOWED'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_REQUESTED'; end if;

  v_no := public.next_document_number(p_to_branch, 'transfer_request');
  insert into public.transfer_requests (shop_id, from_branch_id, to_branch_id, req_no, note, staff_id)
  values (v_me.shop_id, p_from_branch, p_to_branch, v_no, p_note, v_me.id)
  returning id into v_id;

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    if not exists (select 1 from public.products
                   where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id) then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;
    insert into public.transfer_request_items (request_id, shop_id, product_id, qty)
    values (v_id, v_me.shop_id, (v_line->>'product_id')::uuid, (v_line->>'qty')::integer);
  end loop;

  return jsonb_build_object('id', v_id, 'req_no', v_no, 'status', 'submitted');
end; $$;

/** The branch being asked says yes or no. Sending still has to happen afterwards. */
create or replace function public.decide_transfer_request(
  p_request_id uuid, p_approve boolean, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_req public.transfer_requests;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('transfer_stock') then raise exception 'NOT_ALLOWED:transfer_stock'; end if;

  select * into v_req from public.transfer_requests where id = p_request_id and shop_id = v_me.shop_id;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if v_req.status <> 'submitted' then raise exception 'REQUEST_ALREADY_DECIDED:%', v_req.status; end if;
  -- The branch that has to hand the goods over is the one that decides.
  if not public.can_use_branch(v_req.from_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  update public.transfer_requests set
    status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = v_me.id, decided_at = now(), decision_note = p_note
  where id = p_request_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_req.from_branch_id, v_me.id,
          case when p_approve then 'transfer_request_approved' else 'transfer_request_rejected' end,
          'transfer_request', p_request_id,
          jsonb_build_object('req_no', v_req.req_no, 'note', p_note));

  return jsonb_build_object('req_no', v_req.req_no,
                            'status', case when p_approve then 'approved' else 'rejected' end);
end; $$;

-- ---------------------------------------------------------------------------
-- Sending
-- ---------------------------------------------------------------------------

/**
 * Take the goods out of the sending branch and put them on the road.
 *
 * Serial items are sent BY SERIAL: a transfer that says "2 laptops" without saying
 * which two cannot be received honestly, and a serial lookup afterwards would not know
 * where the machine went.
 */
create or replace function public.send_transfer(
  p_from_branch   uuid,
  p_to_branch     uuid,
  p_lines         jsonb,       -- [{ product_id, qty, serials?: uuid[] }]
  p_note          text default null,
  p_to_location   uuid default null,
  p_from_location uuid default null,
  p_request_id    uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_id       uuid;
  v_no       text;
  v_line     jsonb;
  v_product  public.products;
  v_from_loc uuid;
  v_to_loc   uuid;
  v_qty      integer;
  v_stock    integer;
  v_cost     numeric(12,2);
  v_total    numeric(12,2) := 0;
  v_item     uuid;
  v_serials  uuid[];
  v_found    integer;
  v_out      jsonb := '[]'::jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('transfers') then raise exception 'FEATURE_OFF:transfers'; end if;
  if not public.has_permission('transfer_stock') then raise exception 'NOT_ALLOWED:transfer_stock'; end if;
  if not public.can_use_branch(p_from_branch) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if not exists (select 1 from public.branches where id = p_to_branch and shop_id = v_me.shop_id and active) then
    raise exception 'BRANCH_NOT_FOUND';
  end if;
  if p_from_branch = p_to_branch then raise exception 'SAME_BRANCH'; end if;
  if not public.can_transfer(p_from_branch, p_to_branch) then raise exception 'TRANSFER_NOT_ALLOWED'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_TO_SEND'; end if;

  v_from_loc := coalesce(p_from_location, public.default_location(p_from_branch));
  v_to_loc := coalesce(p_to_location, public.default_location(p_to_branch));
  if v_from_loc is null or v_to_loc is null then raise exception 'LOCATION_NOT_FOUND'; end if;
  if not exists (select 1 from public.stock_locations where id = v_from_loc and branch_id = p_from_branch) then
    raise exception 'LOCATION_NOT_FOUND';
  end if;
  if not exists (select 1 from public.stock_locations where id = v_to_loc and branch_id = p_to_branch) then
    raise exception 'LOCATION_NOT_FOUND';
  end if;

  v_no := public.next_document_number(p_from_branch, 'transfer');
  insert into public.transfers (shop_id, transfer_no, from_branch_id, from_location_id,
                                to_branch_id, to_location_id, note, request_id, sent_by)
  values (v_me.shop_id, v_no, p_from_branch, v_from_loc, p_to_branch, v_to_loc,
          p_note, p_request_id, v_me.id)
  returning id into v_id;

  -- In product order, so two transfers of the same goods cannot deadlock on each other.
  for v_line in
    select e from jsonb_array_elements(p_lines) e order by e->>'product_id'
  loop
    select * into v_product from public.products
      where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    if not v_product.is_inventory then raise exception 'NOT_A_STOCK_ITEM:%', v_product.name; end if;

    if v_product.is_serial then
      v_serials := array(select jsonb_array_elements_text(coalesce(v_line->'serials', '[]'::jsonb))::uuid);
      v_qty := array_length(v_serials, 1);
      if coalesce(v_qty, 0) = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
    else
      v_qty := (v_line->>'qty')::integer;
      if coalesce(v_qty, 0) <= 0 then raise exception 'BAD_QTY:%', v_product.name; end if;
    end if;

    select cost into v_cost from public.product_costs where product_id = v_product.id;
    v_total := v_total + coalesce(v_cost, 0) * v_qty;

    insert into public.transfer_items (transfer_id, shop_id, product_id, qty, unit_cost)
    values (v_id, v_me.shop_id, v_product.id, v_qty, v_cost)
    returning id into v_item;

    if v_product.is_serial then
      -- On the road, not on a shelf. location_id stays at the sender until it arrives,
      -- so a serial that never turns up can still be traced to where it left from.
      update public.serials set status = 'in_transit'
        where id = any(v_serials) and product_id = v_product.id and status = 'in_stock'
          and location_id = v_from_loc;
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
      insert into public.transfer_item_serials (transfer_item_id, serial_id)
      select v_item, unnest(v_serials);
    end if;

    select qty into v_stock from public.branch_stock
      where product_id = v_product.id and location_id = v_from_loc for update;
    if coalesce(v_stock, 0) < v_qty then raise exception 'OUT_OF_STOCK:%', v_product.name; end if;
    update public.branch_stock set qty = qty - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_from_loc;

    insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                        reason, staff_id, note)
    values (v_me.shop_id, p_from_branch, v_from_loc, v_product.id, -v_qty,
            'transfer_out', v_me.id, v_no);

    v_out := v_out || jsonb_build_object('product', v_product.name, 'qty', v_qty,
                                         'unit_cost', v_cost);
  end loop;

  update public.transfers set total_cost = v_total where id = v_id;

  if p_request_id is not null then
    update public.transfer_requests set status = 'sent'
      where id = p_request_id and shop_id = v_me.shop_id and status = 'approved';
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_from_branch, v_me.id, 'transfer_sent', 'transfer', v_id,
          jsonb_build_object('transfer_no', v_no, 'to',
                             (select name from public.branches where id = p_to_branch),
                             'lines', v_out, 'total_cost', v_total));

  return jsonb_build_object('id', v_id, 'transfer_no', v_no, 'status', 'in_transit',
                            'total_cost', v_total, 'lines', v_out);
end; $$;

-- ---------------------------------------------------------------------------
-- Receiving
-- ---------------------------------------------------------------------------

/**
 * The other end checks what actually arrived.
 *
 * Each line says how many came in sound and how many came in broken. Anything left over
 * is short, and short means the transfer is DISPUTED until a manager decides. Nothing
 * about a shortage is guessed here.
 */
create or replace function public.receive_transfer(
  p_transfer_id uuid,
  p_lines       jsonb,      -- [{ item_id, ok_qty, damaged_qty?, serials_ok?: uuid[], serials_damaged?: uuid[], note? }]
  p_note        text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_tr       public.transfers;
  v_line     jsonb;
  v_item     public.transfer_items;
  v_product  public.products;
  v_ok       integer;
  v_damaged  integer;
  v_in       integer;
  v_short    integer;
  v_ok_ser   uuid[];
  v_bad_ser  uuid[];
  v_found    integer;
  v_any_short boolean := false;
  v_out      jsonb := '[]'::jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('transfer_stock') then raise exception 'NOT_ALLOWED:transfer_stock'; end if;

  select * into v_tr from public.transfers where id = p_transfer_id and shop_id = v_me.shop_id;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if v_tr.status <> 'in_transit' then raise exception 'TRANSFER_NOT_IN_TRANSIT:%', v_tr.status; end if;
  -- The receiving branch receives. The sender confirming its own delivery would make
  -- the check meaningless.
  if not public.can_use_branch(v_tr.to_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_RECEIVED'; end if;

  for v_line in select e from jsonb_array_elements(p_lines) e order by e->>'item_id' loop
    select * into v_item from public.transfer_items
      where id = (v_line->>'item_id')::uuid and transfer_id = p_transfer_id;
    if not found then raise exception 'TRANSFER_LINE_NOT_FOUND'; end if;
    select * into v_product from public.products where id = v_item.product_id;

    if v_product.is_serial then
      v_ok_ser := array(select jsonb_array_elements_text(coalesce(v_line->'serials_ok', '[]'::jsonb))::uuid);
      v_bad_ser := array(select jsonb_array_elements_text(coalesce(v_line->'serials_damaged', '[]'::jsonb))::uuid);
      v_ok := coalesce(array_length(v_ok_ser, 1), 0);
      v_damaged := coalesce(array_length(v_bad_ser, 1), 0);
    else
      v_ok := coalesce((v_line->>'ok_qty')::integer, 0);
      v_damaged := coalesce((v_line->>'damaged_qty')::integer, 0);
    end if;

    if v_ok < 0 or v_damaged < 0 then raise exception 'BAD_QTY:%', v_product.name; end if;
    v_in := v_ok + v_damaged;
    if v_in > v_item.qty then raise exception 'MORE_THAN_SENT:%', v_product.name; end if;
    v_short := v_item.qty - v_in;
    if v_short > 0 then v_any_short := true; end if;

    update public.transfer_items
      set received_qty = v_in, damaged_qty = v_damaged, note = coalesce(v_line->>'note', note)
      where id = v_item.id;

    if v_product.is_serial then
      -- Sound units land on the destination shelf; broken ones go straight to RMA,
      -- which is where a damaged unit belongs however it got damaged.
      if v_ok > 0 then
        update public.serials set status = 'in_stock', location_id = v_tr.to_location_id
          where id = any(v_ok_ser) and status = 'in_transit'
            and id in (select serial_id from public.transfer_item_serials where transfer_item_id = v_item.id);
        get diagnostics v_found = row_count;
        if v_found <> v_ok then raise exception 'SERIAL_NOT_ON_THIS_TRANSFER:%', v_product.name; end if;
        update public.transfer_item_serials set arrived_ok = true
          where transfer_item_id = v_item.id and serial_id = any(v_ok_ser);
      end if;
      if v_damaged > 0 then
        update public.serials set status = 'rma', location_id = v_tr.to_location_id
          where id = any(v_bad_ser) and status = 'in_transit'
            and id in (select serial_id from public.transfer_item_serials where transfer_item_id = v_item.id);
        get diagnostics v_found = row_count;
        if v_found <> v_damaged then raise exception 'SERIAL_NOT_ON_THIS_TRANSFER:%', v_product.name; end if;
        update public.transfer_item_serials set arrived_ok = false
          where transfer_item_id = v_item.id and serial_id = any(v_bad_ser);
      end if;
    end if;

    -- Only sound units become sellable stock. A damaged one arrived, and is recorded
    -- as arrived, but putting it on the shelf would let someone sell it.
    if v_ok > 0 then
      insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
      values (v_item.product_id, v_tr.to_location_id, v_me.shop_id, v_tr.to_branch_id, v_ok)
      on conflict (product_id, location_id) do update
        set qty = public.branch_stock.qty + v_ok, updated_at = now();
    end if;

    if v_ok > 0 then
      insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                          reason, staff_id, note)
      values (v_me.shop_id, v_tr.to_branch_id, v_tr.to_location_id, v_item.product_id, v_ok,
              'transfer_in', v_me.id, v_tr.transfer_no);
    end if;
    if v_damaged > 0 then
      insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                          reason, reason_detail, staff_id, note)
      values (v_me.shop_id, v_tr.to_branch_id, v_tr.to_location_id, v_item.product_id, 0,
              'adjust_out', 'damaged', v_me.id,
              v_tr.transfer_no || ': arrived damaged');
    end if;

    v_out := v_out || jsonb_build_object('product', v_product.name, 'sent', v_item.qty,
                                         'ok', v_ok, 'damaged', v_damaged, 'short', v_short);
  end loop;

  update public.transfers set
    status = case when v_any_short then 'disputed' else 'received' end,
    received_by = v_me.id, received_at = now(),
    note = case when p_note is null then note else coalesce(note || ' · ', '') || p_note end
  where id = p_transfer_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_tr.to_branch_id, v_me.id,
          case when v_any_short then 'transfer_disputed' else 'transfer_received' end,
          'transfer', p_transfer_id,
          jsonb_build_object('transfer_no', v_tr.transfer_no, 'lines', v_out, 'note', p_note));

  return jsonb_build_object('transfer_no', v_tr.transfer_no,
                            'status', case when v_any_short then 'disputed' else 'received' end,
                            'lines', v_out);
end; $$;

/**
 * Settle a shortage. A manager says where the missing goods went: back to the sender
 * (so the sending branch gets them on its shelf again) or written off (a loss, at the
 * sending branch, because that is where they were last seen).
 */
create or replace function public.resolve_transfer(
  p_transfer_id uuid, p_action text, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_tr    public.transfers;
  v_item  record;
  v_short integer;
  v_lost  numeric(12,2) := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
  if p_action not in ('returned', 'written_off') then raise exception 'BAD_RESOLUTION:%', p_action; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'RESOLUTION_NOTE_REQUIRED'; end if;

  select * into v_tr from public.transfers where id = p_transfer_id and shop_id = v_me.shop_id;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if v_tr.status <> 'disputed' then raise exception 'TRANSFER_NOT_DISPUTED:%', v_tr.status; end if;
  -- Either end may settle it; both have a stake in the answer.
  if not (public.can_use_branch(v_tr.from_branch_id) or public.can_use_branch(v_tr.to_branch_id)) then
    raise exception 'BRANCH_NOT_ALLOWED';
  end if;

  for v_item in
    select ti.*, p.name, p.is_serial from public.transfer_items ti
    join public.products p on p.id = ti.product_id
    where ti.transfer_id = p_transfer_id and ti.received_qty < ti.qty
    order by ti.product_id
  loop
    v_short := v_item.qty - v_item.received_qty;
    v_lost := v_lost + coalesce(v_item.unit_cost, 0) * v_short;

    if p_action = 'returned' then
      if v_item.is_serial then
        update public.serials set status = 'in_stock', location_id = v_tr.from_location_id
          where status = 'in_transit'
            and id in (select serial_id from public.transfer_item_serials
                       where transfer_item_id = v_item.id and arrived_ok is null);
      else
        insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
        values (v_item.product_id, v_tr.from_location_id, v_me.shop_id, v_tr.from_branch_id, v_short)
        on conflict (product_id, location_id) do update
          set qty = public.branch_stock.qty + v_short, updated_at = now();
      end if;
      insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                          reason, staff_id, note)
      values (v_me.shop_id, v_tr.from_branch_id, v_tr.from_location_id, v_item.product_id, v_short,
              'transfer_in', v_me.id, v_tr.transfer_no || ': came back');
    else
      if v_item.is_serial then
        update public.serials set status = 'rma'
          where status = 'in_transit'
            and id in (select serial_id from public.transfer_item_serials
                       where transfer_item_id = v_item.id and arrived_ok is null);
      end if;
      -- The stock already left the sender's shelf when it was sent, so writing it off
      -- is a record of the loss, not another deduction. Taking it off again would
      -- double-count goods the shop only lost once.
      insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                          reason, reason_detail, staff_id, note)
      values (v_me.shop_id, v_tr.from_branch_id, v_tr.from_location_id, v_item.product_id, 0,
              'adjust_out', 'lost', v_me.id, v_tr.transfer_no || ': lost in transit');
    end if;
  end loop;

  update public.transfers set status = 'received', resolution = p_action,
    resolved_by = v_me.id, resolved_at = now(),
    note = coalesce(note || ' · ', '') || p_note
  where id = p_transfer_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_tr.from_branch_id, v_me.id, 'transfer_resolved', 'transfer', p_transfer_id,
          jsonb_build_object('transfer_no', v_tr.transfer_no, 'resolution', p_action,
                             'cost_of_shortage', v_lost, 'note', p_note));

  return jsonb_build_object('transfer_no', v_tr.transfer_no, 'resolution', p_action,
                            'cost_of_shortage', v_lost);
end; $$;

-- ---------------------------------------------------------------------------
-- Within one branch
-- ---------------------------------------------------------------------------

/**
 * Shop floor ↔ warehouse, in one step. Nothing is in transit: the goods have not left
 * the building, so a second person confirming would be theatre.
 */
create or replace function public.move_within_branch(
  p_branch_id uuid,
  p_from_location uuid,
  p_to_location   uuid,
  p_lines         jsonb        -- [{ product_id, qty, serials?: uuid[] }]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.staff;
  v_line    jsonb;
  v_product public.products;
  v_qty     integer;
  v_stock   integer;
  v_serials uuid[];
  v_found   integer;
  v_moved   jsonb := '[]'::jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('transfer_stock') then raise exception 'NOT_ALLOWED:transfer_stock'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_from_location = p_to_location then raise exception 'SAME_LOCATION'; end if;
  if not exists (select 1 from public.stock_locations
                 where id = p_from_location and branch_id = p_branch_id and active) then
    raise exception 'LOCATION_NOT_FOUND';
  end if;
  if not exists (select 1 from public.stock_locations
                 where id = p_to_location and branch_id = p_branch_id and active) then
    raise exception 'LOCATION_NOT_FOUND';
  end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_TO_SEND'; end if;

  for v_line in select e from jsonb_array_elements(p_lines) e order by e->>'product_id' loop
    select * into v_product from public.products
      where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;

    if v_product.is_serial then
      v_serials := array(select jsonb_array_elements_text(coalesce(v_line->'serials', '[]'::jsonb))::uuid);
      v_qty := coalesce(array_length(v_serials, 1), 0);
      if v_qty = 0 then raise exception 'SERIAL_REQUIRED:%', v_product.name; end if;
      update public.serials set location_id = p_to_location
        where id = any(v_serials) and product_id = v_product.id
          and status = 'in_stock' and location_id = p_from_location;
      get diagnostics v_found = row_count;
      if v_found <> v_qty then raise exception 'SERIAL_NOT_AVAILABLE:%', v_product.name; end if;
    else
      v_qty := (v_line->>'qty')::integer;
      if coalesce(v_qty, 0) <= 0 then raise exception 'BAD_QTY:%', v_product.name; end if;
    end if;

    select qty into v_stock from public.branch_stock
      where product_id = v_product.id and location_id = p_from_location for update;
    if coalesce(v_stock, 0) < v_qty then raise exception 'OUT_OF_STOCK:%', v_product.name; end if;
    update public.branch_stock set qty = qty - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = p_from_location;
    insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
    values (v_product.id, p_to_location, v_me.shop_id, p_branch_id, v_qty)
    on conflict (product_id, location_id) do update
      set qty = public.branch_stock.qty + v_qty, updated_at = now();

    insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                        reason, staff_id, note)
    values (v_me.shop_id, p_branch_id, p_from_location, v_product.id, -v_qty, 'transfer_out',
            v_me.id, 'Moved within the branch'),
           (v_me.shop_id, p_branch_id, p_to_location, v_product.id, v_qty, 'transfer_in',
            v_me.id, 'Moved within the branch');

    v_moved := v_moved || jsonb_build_object('product', v_product.name, 'qty', v_qty);
  end loop;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'stock_moved_within_branch', 'branch', p_branch_id,
          jsonb_build_object(
            'from', (select name from public.stock_locations where id = p_from_location),
            'to', (select name from public.stock_locations where id = p_to_location),
            'lines', v_moved));

  return jsonb_build_object('lines', v_moved);
end; $$;

-- ---------------------------------------------------------------------------
-- Cancelling a transfer that never went
-- ---------------------------------------------------------------------------

/** Put it all back where it came from. Only before anything has been received. */
create or replace function public.cancel_transfer(
  p_transfer_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_tr public.transfers; v_item record;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('transfer_stock') then raise exception 'NOT_ALLOWED:transfer_stock'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'CANCEL_REASON_REQUIRED'; end if;

  select * into v_tr from public.transfers where id = p_transfer_id and shop_id = v_me.shop_id;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if v_tr.status <> 'in_transit' then raise exception 'TRANSFER_NOT_IN_TRANSIT:%', v_tr.status; end if;
  -- The branch that sent it is the one that can call it off.
  if not public.can_use_branch(v_tr.from_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  for v_item in
    select ti.*, p.is_serial from public.transfer_items ti
    join public.products p on p.id = ti.product_id
    where ti.transfer_id = p_transfer_id order by ti.product_id
  loop
    if v_item.is_serial then
      update public.serials set status = 'in_stock', location_id = v_tr.from_location_id
        where status = 'in_transit'
          and id in (select serial_id from public.transfer_item_serials where transfer_item_id = v_item.id);
    end if;
    insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
    values (v_item.product_id, v_tr.from_location_id, v_me.shop_id, v_tr.from_branch_id, v_item.qty)
    on conflict (product_id, location_id) do update
      set qty = public.branch_stock.qty + v_item.qty, updated_at = now();
    insert into public.stock_movements (shop_id, branch_id, location_id, product_id, qty_change,
                                        reason, staff_id, note)
    values (v_me.shop_id, v_tr.from_branch_id, v_tr.from_location_id, v_item.product_id, v_item.qty,
            'transfer_in', v_me.id, v_tr.transfer_no || ': called off');
  end loop;

  update public.transfers set status = 'cancelled',
    note = coalesce(note || ' · ', '') || p_reason where id = p_transfer_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_tr.from_branch_id, v_me.id, 'transfer_cancelled', 'transfer', p_transfer_id,
          jsonb_build_object('transfer_no', v_tr.transfer_no, 'reason', p_reason));

  return jsonb_build_object('transfer_no', v_tr.transfer_no, 'status', 'cancelled');
end; $$;

-- ---------------------------------------------------------------------------
-- What is on the road
-- ---------------------------------------------------------------------------

/**
 * Everything in transit for this shop, oldest first, with how many days it has been
 * out. Three days is the nudge: beyond that, goods nobody can sell are either lost or
 * forgotten, and both need someone to look.
 */
create or replace function public.in_transit(p_branch_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;

  select coalesce(jsonb_agg(x order by x->>'sent_at'), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'id', t.id, 'transfer_no', t.transfer_no, 'status', t.status,
      'from_branch', bf.name, 'to_branch', bt.name,
      'sent_at', t.sent_at,
      'days_out', (public.dhaka_today() - (t.sent_at at time zone 'Asia/Dhaka')::date),
      'total_cost', t.total_cost,
      'items', (select coalesce(jsonb_agg(jsonb_build_object(
                  'product', p.name, 'qty', ti.qty, 'received', ti.received_qty)), '[]'::jsonb)
                from public.transfer_items ti join public.products p on p.id = ti.product_id
                where ti.transfer_id = t.id)
    ) as x
    from public.transfers t
    join public.branches bf on bf.id = t.from_branch_id
    join public.branches bt on bt.id = t.to_branch_id
    where t.shop_id = (select public.current_shop_id())
      and t.status in ('in_transit', 'disputed')
      and (p_branch_id is null or t.from_branch_id = p_branch_id or t.to_branch_id = p_branch_id)
      and (t.from_branch_id = any(select unnest(public.current_branch_ids()))
           or t.to_branch_id = any(select unnest(public.current_branch_ids())))
  ) q;
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.transfer_routes          enable row level security;
alter table public.transfer_requests        enable row level security;
alter table public.transfer_request_items   enable row level security;
alter table public.transfers                enable row level security;
alter table public.transfer_items           enable row level security;
alter table public.transfer_item_serials    enable row level security;

create policy transfer_routes_read on public.transfer_routes for select to authenticated
  using (shop_id = (select public.current_shop_id()));

-- Each branch sees what it sends and what it is sent. Owners see every branch anyway,
-- because current_branch_ids() gives them all of them.
create policy transfer_requests_read on public.transfer_requests for select to authenticated
  using (from_branch_id = any(select unnest(public.current_branch_ids()))
         or to_branch_id = any(select unnest(public.current_branch_ids())));
create policy transfer_request_items_read on public.transfer_request_items for select to authenticated
  using (exists (select 1 from public.transfer_requests r where r.id = request_id
                 and (r.from_branch_id = any(select unnest(public.current_branch_ids()))
                      or r.to_branch_id = any(select unnest(public.current_branch_ids())))));

create policy transfers_read on public.transfers for select to authenticated
  using (from_branch_id = any(select unnest(public.current_branch_ids()))
         or to_branch_id = any(select unnest(public.current_branch_ids())));
create policy transfer_items_read on public.transfer_items for select to authenticated
  using (exists (select 1 from public.transfers t where t.id = transfer_id
                 and (t.from_branch_id = any(select unnest(public.current_branch_ids()))
                      or t.to_branch_id = any(select unnest(public.current_branch_ids())))));
create policy transfer_item_serials_read on public.transfer_item_serials for select to authenticated
  using (exists (select 1 from public.transfer_items ti
                 join public.transfers t on t.id = ti.transfer_id
                 where ti.id = transfer_item_id
                   and (t.from_branch_id = any(select unnest(public.current_branch_ids()))
                        or t.to_branch_id = any(select unnest(public.current_branch_ids())))));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.can_transfer(uuid, uuid) from public, anon;
revoke execute on function public.save_transfer_route(uuid, uuid, boolean) from public, anon;
revoke execute on function public.save_transfer_request(uuid, uuid, jsonb, text) from public, anon;
revoke execute on function public.decide_transfer_request(uuid, boolean, text) from public, anon;
revoke execute on function public.send_transfer(uuid, uuid, jsonb, text, uuid, uuid, uuid) from public, anon;
revoke execute on function public.receive_transfer(uuid, jsonb, text) from public, anon;
revoke execute on function public.resolve_transfer(uuid, text, text) from public, anon;
revoke execute on function public.move_within_branch(uuid, uuid, uuid, jsonb) from public, anon;
revoke execute on function public.cancel_transfer(uuid, text) from public, anon;
revoke execute on function public.in_transit(uuid) from public, anon;

grant execute on function public.can_transfer(uuid, uuid) to authenticated;
grant execute on function public.save_transfer_route(uuid, uuid, boolean) to authenticated;
grant execute on function public.save_transfer_request(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.decide_transfer_request(uuid, boolean, text) to authenticated;
grant execute on function public.send_transfer(uuid, uuid, jsonb, text, uuid, uuid, uuid) to authenticated;
grant execute on function public.receive_transfer(uuid, jsonb, text) to authenticated;
grant execute on function public.resolve_transfer(uuid, text, text) to authenticated;
grant execute on function public.move_within_branch(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.cancel_transfer(uuid, text) to authenticated;
grant execute on function public.in_transit(uuid) to authenticated;
