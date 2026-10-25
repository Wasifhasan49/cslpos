-- P6 — the formal buying chain, for shops that want it.
--
-- BMS has Purchase Requisition → Purchase Order → Order Wise Purchase → Purchase
-- Posting, each on its own menu, plus separate Approve and Cancel screens. Here it is
-- the same chain with the approvals as BUTTONS ON THE DOCUMENT, because a separate
-- "approve" menu is how a shop ends up with twenty orders nobody ever approved.
--
-- Small shops never see any of it: the "purchase_orders" feature switch is off by
-- default and they keep receiving goods directly (P5).
--
-- The order does NOT move stock. Only receiving does, which is why a partly delivered
-- order has to track ordered / received / pending per line rather than per document.

-- ---------------------------------------------------------------------------
-- Requisitions: a branch asking for something
-- ---------------------------------------------------------------------------

create table public.requisitions (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  branch_id     uuid not null references public.branches(id),
  req_no        text not null,
  status        text not null default 'draft'
                check (status in ('draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled')),
  needed_by     date,
  note          text,
  decided_by    uuid references public.staff(id),
  decided_at    timestamptz,
  decision_note text,
  staff_id      uuid not null references public.staff(id),
  created_at    timestamptz not null default now(),
  unique (shop_id, req_no)
);
create index requisitions_branch_idx on public.requisitions(branch_id, created_at desc);

create table public.requisition_items (
  id         uuid primary key default gen_random_uuid(),
  req_id     uuid not null references public.requisitions(id) on delete cascade,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.products(id),
  qty        integer not null check (qty > 0),
  note       text
);
create index requisition_items_req_idx on public.requisition_items(req_id);

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------

create table public.purchase_orders (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  -- The branch the goods are to be delivered to.
  branch_id      uuid not null references public.branches(id),
  po_no          text not null,
  supplier_id    uuid not null references public.suppliers(id),
  status         text not null default 'draft'
                 check (status in ('draft', 'awaiting_approval', 'sent', 'partly_received',
                                   'received', 'closed', 'cancelled')),
  -- Days from the invoice date. Used for the aging buckets.
  payment_terms_days integer not null default 0 check (payment_terms_days >= 0),
  discount       numeric(12,2) not null default 0,
  charges        numeric(12,2) not null default 0,
  vat            numeric(12,2) not null default 0,
  subtotal       numeric(12,2) not null default 0,
  total          numeric(12,2) not null default 0,
  note           text,
  approved_by    uuid references public.staff(id),
  approved_at    timestamptz,
  cancelled_by   uuid references public.staff(id),
  cancelled_at   timestamptz,
  cancel_reason  text,
  staff_id       uuid not null references public.staff(id),
  created_at     timestamptz not null default now(),
  unique (shop_id, po_no)
);
create index purchase_orders_branch_idx on public.purchase_orders(branch_id, created_at desc);
create index purchase_orders_supplier_idx on public.purchase_orders(supplier_id, created_at desc);

create table public.purchase_order_items (
  id            uuid primary key default gen_random_uuid(),
  po_id         uuid not null references public.purchase_orders(id) on delete cascade,
  shop_id       uuid not null references public.shops(id) on delete cascade,
  product_id    uuid not null references public.products(id),
  qty           integer not null check (qty > 0),
  -- The price agreed with the supplier. Receiving is locked to it unless a manager
  -- overrides, and the override is logged.
  unit_price    numeric(12,2) not null check (unit_price >= 0),
  line_discount numeric(12,2) not null default 0,
  -- How much of this line has actually turned up. Partial deliveries are normal.
  received_qty  integer not null default 0 check (received_qty >= 0),
  req_item_id   uuid references public.requisition_items(id) on delete set null
);
create index purchase_order_items_po_idx on public.purchase_order_items(po_id);

-- A delivery can be against an order, which is what lets the order close itself.
alter table public.grns add column po_id uuid references public.purchase_orders(id) on delete set null;
alter table public.grn_items add column po_item_id uuid references public.purchase_order_items(id) on delete set null;

-- Which requisitions an order came from, so a branch can see what happened to its ask.
create table public.purchase_order_requisitions (
  po_id  uuid not null references public.purchase_orders(id) on delete cascade,
  req_id uuid not null references public.requisitions(id) on delete cascade,
  primary key (po_id, req_id)
);

-- A shop can require the owner to sign off anything big. 0 means never.
alter table public.shops
  add column po_approval_limit numeric(12,2) not null default 0
    check (po_approval_limit >= 0);

-- shops has no direct UPDATE policy on purpose, so the new setting has to go through
-- the one saver like every other shop detail.
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
    po_approval_limit = coalesce((p_values->>'po_approval_limit')::numeric, po_approval_limit)
  where id = v_me.shop_id
  returning to_jsonb(shops.*) into v_row;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'shop_details_changed', 'shop', v_me.shop_id,
          jsonb_build_object('from', v_before - 'id', 'to', v_row - 'id'));
  return v_row;
end; $$;

-- ---------------------------------------------------------------------------
-- Requisition functions
-- ---------------------------------------------------------------------------

create or replace function public.save_requisition(
  p_branch_id uuid,
  p_lines     jsonb,          -- [{ product_id, qty, note? }]
  p_needed_by date default null,
  p_note      text default null,
  p_req_id    uuid default null,
  p_submit    boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_id     uuid;
  v_no     text;
  v_line   jsonb;
  v_status text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('purchase_orders') then raise exception 'FEATURE_OFF:purchase_orders'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_REQUESTED'; end if;

  if p_req_id is null then
    v_no := public.next_document_number(p_branch_id, 'requisition');
    insert into public.requisitions (shop_id, branch_id, req_no, needed_by, note, staff_id,
                                     status)
    values (v_me.shop_id, p_branch_id, v_no, p_needed_by, p_note, v_me.id,
            case when p_submit then 'submitted' else 'draft' end)
    returning id, req_no into v_id, v_no;
  else
    select status into v_status from public.requisitions
      where id = p_req_id and shop_id = v_me.shop_id;
    if v_status is null then raise exception 'REQUISITION_NOT_FOUND'; end if;
    -- Once it has been decided on, the ask is history.
    if v_status not in ('draft', 'submitted') then raise exception 'REQUISITION_LOCKED:%', v_status; end if;

    update public.requisitions set
      needed_by = coalesce(p_needed_by, needed_by),
      note = coalesce(p_note, note),
      status = case when p_submit then 'submitted' else status end
    where id = p_req_id
    returning id, req_no into v_id, v_no;
    delete from public.requisition_items where req_id = v_id;
  end if;

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    if not exists (select 1 from public.products
                   where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id) then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;
    insert into public.requisition_items (req_id, shop_id, product_id, qty, note)
    values (v_id, v_me.shop_id, (v_line->>'product_id')::uuid,
            (v_line->>'qty')::integer, v_line->>'note');
  end loop;

  return jsonb_build_object('id', v_id, 'req_no', v_no,
                            'status', (select status from public.requisitions where id = v_id));
end; $$;

/** Approve or reject a branch's ask. Managers and owners; the reason is kept. */
create or replace function public.decide_requisition(
  p_req_id uuid, p_approve boolean, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_req public.requisitions;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('approve') then raise exception 'NOT_ALLOWED:approve'; end if;

  select * into v_req from public.requisitions where id = p_req_id and shop_id = v_me.shop_id;
  if not found then raise exception 'REQUISITION_NOT_FOUND'; end if;
  if v_req.status <> 'submitted' then raise exception 'REQUISITION_NOT_SUBMITTED:%', v_req.status; end if;
  if not public.can_use_branch(v_req.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  -- Approving your own request defeats the point of approving it.
  if v_req.staff_id = v_me.id then raise exception 'NO_SELF_APPROVAL'; end if;

  update public.requisitions set
    status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = v_me.id, decided_at = now(), decision_note = p_note
  where id = p_req_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_req.branch_id, v_me.id,
          case when p_approve then 'requisition_approved' else 'requisition_rejected' end,
          'requisition', p_req_id,
          jsonb_build_object('req_no', v_req.req_no, 'note', p_note,
                             'asked_by', (select name from public.staff where id = v_req.staff_id)));

  return jsonb_build_object('req_no', v_req.req_no,
                            'status', case when p_approve then 'approved' else 'rejected' end);
end; $$;

-- ---------------------------------------------------------------------------
-- Purchase order functions
-- ---------------------------------------------------------------------------

create or replace function public.save_purchase_order(
  p_branch_id   uuid,
  p_supplier_id uuid,
  p_lines       jsonb,        -- [{ product_id, qty, unit_price, line_discount?, req_item_id? }]
  p_terms_days  integer default 0,
  p_discount    numeric default 0,
  p_charges     numeric default 0,
  p_vat         numeric default 0,
  p_note        text default null,
  p_po_id       uuid default null,
  p_req_ids     uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_id       uuid;
  v_no       text;
  v_line     jsonb;
  v_subtotal numeric(12,2) := 0;
  v_total    numeric(12,2);
  v_status   text;
  v_limit    numeric(12,2);
  v_req      uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('purchase_orders') then raise exception 'FEATURE_OFF:purchase_orders'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:receive_stock'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_ORDERED'; end if;
  if not exists (select 1 from public.suppliers where id = p_supplier_id and shop_id = v_me.shop_id) then
    raise exception 'SUPPLIER_NOT_FOUND';
  end if;
  if (select is_cash_only from public.suppliers where id = p_supplier_id) and p_terms_days > 0 then
    raise exception 'CASH_SUPPLIER_NO_CREDIT';
  end if;

  if p_po_id is null then
    v_no := public.next_document_number(p_branch_id, 'po');
    insert into public.purchase_orders (shop_id, branch_id, po_no, supplier_id,
                                        payment_terms_days, discount, charges, vat, note, staff_id)
    values (v_me.shop_id, p_branch_id, v_no, p_supplier_id, coalesce(p_terms_days, 0),
            coalesce(p_discount, 0), coalesce(p_charges, 0), coalesce(p_vat, 0), p_note, v_me.id)
    returning id, po_no into v_id, v_no;
  else
    select status into v_status from public.purchase_orders
      where id = p_po_id and shop_id = v_me.shop_id;
    if v_status is null then raise exception 'PO_NOT_FOUND'; end if;
    -- Once anything has been delivered against it, the order is a record of what was
    -- agreed and cannot be rewritten.
    if v_status not in ('draft', 'awaiting_approval') then raise exception 'PO_LOCKED:%', v_status; end if;

    update public.purchase_orders set
      supplier_id = p_supplier_id,
      payment_terms_days = coalesce(p_terms_days, payment_terms_days),
      discount = coalesce(p_discount, discount),
      charges = coalesce(p_charges, charges),
      vat = coalesce(p_vat, vat),
      note = coalesce(p_note, note)
    where id = p_po_id
    returning id, po_no into v_id, v_no;
    delete from public.purchase_order_items where po_id = v_id;
  end if;

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    if not exists (select 1 from public.products
                   where id = (v_line->>'product_id')::uuid and shop_id = v_me.shop_id) then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;
    insert into public.purchase_order_items (po_id, shop_id, product_id, qty, unit_price,
                                             line_discount, req_item_id)
    values (v_id, v_me.shop_id, (v_line->>'product_id')::uuid, (v_line->>'qty')::integer,
            coalesce((v_line->>'unit_price')::numeric, 0),
            coalesce((v_line->>'line_discount')::numeric, 0),
            (v_line->>'req_item_id')::uuid);
    v_subtotal := v_subtotal
      + greatest(coalesce((v_line->>'unit_price')::numeric, 0) * (v_line->>'qty')::integer
                 - coalesce((v_line->>'line_discount')::numeric, 0), 0);
  end loop;

  v_total := greatest(v_subtotal - coalesce(p_discount, 0), 0)
             + coalesce(p_charges, 0) + coalesce(p_vat, 0);

  -- Over the shop's limit it needs the owner, so it waits rather than going out.
  select po_approval_limit into v_limit from public.shops where id = v_me.shop_id;
  update public.purchase_orders set
    subtotal = v_subtotal, total = v_total,
    status = case
      when status in ('sent', 'partly_received', 'received', 'closed', 'cancelled') then status
      when v_limit > 0 and v_total > v_limit and v_me.role <> 'owner' then 'awaiting_approval'
      else 'draft'
    end
  where id = v_id;

  if p_req_ids is not null then
    foreach v_req in array p_req_ids loop
      insert into public.purchase_order_requisitions (po_id, req_id) values (v_id, v_req)
      on conflict do nothing;
      update public.requisitions set status = 'ordered'
        where id = v_req and shop_id = v_me.shop_id and status = 'approved';
    end loop;
  end if;

  return jsonb_build_object('id', v_id, 'po_no', v_no, 'subtotal', v_subtotal, 'total', v_total,
                            'status', (select status from public.purchase_orders where id = v_id),
                            'needs_approval',
                            (select status = 'awaiting_approval' from public.purchase_orders where id = v_id));
end; $$;

/**
 * Approve, send or cancel an order.
 *
 * One function with buttons on the document rather than BMS's separate approve and
 * cancel menus, so a decision always happens where the thing being decided is visible.
 */
create or replace function public.set_po_status(
  p_po_id uuid, p_action text, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_po public.purchase_orders; v_new text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  select * into v_po from public.purchase_orders where id = p_po_id and shop_id = v_me.shop_id;
  if not found then raise exception 'PO_NOT_FOUND'; end if;
  if not public.can_use_branch(v_po.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  if p_action = 'approve' then
    if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
    if v_po.status <> 'awaiting_approval' then raise exception 'PO_NOT_AWAITING:%', v_po.status; end if;
    v_new := 'sent';
    update public.purchase_orders set status = v_new, approved_by = v_me.id, approved_at = now()
      where id = p_po_id;

  elsif p_action = 'send' then
    if not public.is_manager() then raise exception 'NOT_ALLOWED:receive_stock'; end if;
    if v_po.status <> 'draft' then raise exception 'PO_NOT_DRAFT:%', v_po.status; end if;
    v_new := 'sent';
    update public.purchase_orders set status = v_new where id = p_po_id;

  elsif p_action = 'cancel' then
    if not public.is_manager() then raise exception 'NOT_ALLOWED:receive_stock'; end if;
    if v_po.status in ('received', 'closed', 'cancelled') then
      raise exception 'PO_ALREADY_FINISHED:%', v_po.status;
    end if;
    -- Something has already turned up against it, so cancelling would hide a real
    -- delivery. Close it instead.
    if exists (select 1 from public.purchase_order_items where po_id = p_po_id and received_qty > 0) then
      raise exception 'PO_PARTLY_RECEIVED';
    end if;
    if coalesce(btrim(p_reason), '') = '' then raise exception 'CANCEL_REASON_REQUIRED'; end if;
    v_new := 'cancelled';
    update public.purchase_orders set status = v_new, cancelled_by = v_me.id,
      cancelled_at = now(), cancel_reason = p_reason where id = p_po_id;

  elsif p_action = 'close' then
    if not public.is_manager() then raise exception 'NOT_ALLOWED:receive_stock'; end if;
    v_new := 'closed';
    update public.purchase_orders set status = v_new where id = p_po_id;

  else
    raise exception 'BAD_PO_ACTION:%', p_action;
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_po.branch_id, v_me.id, 'po_' || p_action, 'purchase_order', p_po_id,
          jsonb_build_object('po_no', v_po.po_no, 'from', v_po.status, 'to', v_new,
                             'reason', p_reason, 'total', v_po.total));

  return jsonb_build_object('po_no', v_po.po_no, 'status', v_new);
end; $$;

/**
 * Receive against an order.
 *
 * Prices come from the order, not from the browser. A manager may override one, and the
 * override is logged with both figures — the agreed price is the whole reason an order
 * exists, so quietly paying something else would make it decorative.
 */
create or replace function public.receive_against_po(
  p_po_id               uuid,
  p_lines               jsonb,   -- [{ po_item_id, qty, serials?: text[], unit_cost? }]
  p_supplier_invoice_no text default null,
  p_invoice_date        date default null,
  p_is_credit           boolean default true,
  p_note                text default null,
  p_pay_amount          numeric default null,
  p_pay_method          text default null,
  p_pay_reference       text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me        public.staff;
  v_po        public.purchase_orders;
  v_line      jsonb;
  v_item      public.purchase_order_items;
  v_qty       integer;
  v_cost      numeric(12,2);
  v_recv      jsonb := '[]'::jsonb;
  v_res       jsonb;
  v_pending   integer;
  v_any_left  boolean;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('receive_stock') then raise exception 'NOT_ALLOWED:receive_stock'; end if;

  select * into v_po from public.purchase_orders where id = p_po_id and shop_id = v_me.shop_id;
  if not found then raise exception 'PO_NOT_FOUND'; end if;
  if not public.can_use_branch(v_po.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if v_po.status not in ('sent', 'partly_received') then
    raise exception 'PO_NOT_RECEIVABLE:%', v_po.status;
  end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_RECEIVED'; end if;

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    select * into v_item from public.purchase_order_items
      where id = (v_line->>'po_item_id')::uuid and po_id = p_po_id;
    if not found then raise exception 'PO_LINE_NOT_FOUND'; end if;

    v_qty := coalesce((v_line->>'qty')::integer, 0);
    if v_qty <= 0 then raise exception 'BAD_QTY:%', (select name from public.products where id = v_item.product_id); end if;

    -- More than was ordered is a conversation with the supplier, not a quiet accept.
    v_pending := v_item.qty - v_item.received_qty;
    if v_qty > v_pending then
      raise exception 'MORE_THAN_ORDERED:%', (select name from public.products where id = v_item.product_id);
    end if;

    v_cost := (v_line->>'unit_cost')::numeric;
    if v_cost is null then
      v_cost := v_item.unit_price;
    elsif v_cost <> v_item.unit_price then
      if not public.is_manager() then raise exception 'NOT_ALLOWED:change_price'; end if;
      insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
      values (v_me.shop_id, v_po.branch_id, v_me.id, 'po_price_overridden', 'purchase_order', p_po_id,
              jsonb_build_object('po_no', v_po.po_no,
                                 'product', (select name from public.products where id = v_item.product_id),
                                 'agreed', v_item.unit_price, 'invoiced', v_cost, 'qty', v_qty));
    end if;

    update public.purchase_order_items set received_qty = received_qty + v_qty where id = v_item.id;

    v_recv := v_recv || jsonb_build_object(
      'product_id', v_item.product_id, 'qty', v_qty, 'unit_cost', v_cost,
      'line_discount', 0, 'serials', coalesce(v_line->'serials', '[]'::jsonb),
      'po_item_id', v_item.id);
  end loop;

  -- The goods themselves go in through P5's one receiving path, so there is one place
  -- that moves stock, writes serials and works out the average cost.
  v_res := public.receive_goods(
    v_po.branch_id, v_recv, v_po.supplier_id, p_supplier_invoice_no, p_invoice_date,
    p_is_credit, 0, 0, 0, 0, p_note, null, null, p_pay_amount, p_pay_method, p_pay_reference);

  update public.grns set po_id = p_po_id where id = (v_res->>'id')::uuid;
  update public.grn_items gi set po_item_id = (r->>'po_item_id')::uuid
    from jsonb_array_elements(v_recv) r
    where gi.grn_id = (v_res->>'id')::uuid
      and gi.product_id = (r->>'product_id')::uuid;

  select exists (select 1 from public.purchase_order_items
                 where po_id = p_po_id and received_qty < qty) into v_any_left;
  update public.purchase_orders
    set status = case when v_any_left then 'partly_received' else 'received' end
  where id = p_po_id;

  return v_res
    || jsonb_build_object(
      'po_no', v_po.po_no,
      'po_status', case when v_any_left then 'partly_received' else 'received' end,
      'pending', (select coalesce(jsonb_agg(jsonb_build_object(
                    'product', p.name, 'ordered', i.qty, 'received', i.received_qty,
                    'pending', i.qty - i.received_qty)), '[]'::jsonb)
                  from public.purchase_order_items i
                  join public.products p on p.id = i.product_id
                  where i.po_id = p_po_id));
end; $$;

-- ---------------------------------------------------------------------------
-- Reorder suggestions
-- ---------------------------------------------------------------------------

/**
 * What to buy: anything at or below its re-order level at this branch, with how fast it
 * has been selling so the quantity is a decision rather than a guess.
 */
create or replace function public.reorder_suggestions(p_branch_id uuid, p_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;

  select coalesce(jsonb_agg(x order by (x->>'days_left')::numeric nulls last), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'product_id', p.id, 'name', p.name, 'code', p.code,
      'stock', coalesce(bs.qty, 0),
      'reorder_level', coalesce(rl.level, p.reorder_level),
      'sold_in_period', coalesce(sold.qty, 0),
      'per_day', round(coalesce(sold.qty, 0)::numeric / greatest(p_days, 1), 2),
      -- How long the shelf lasts at the recent rate. Null when nothing has sold, because
      -- "never runs out" and "sells 10 a day" are different problems.
      'days_left', case when coalesce(sold.qty, 0) > 0
                        then round(coalesce(bs.qty, 0)::numeric
                                   / (coalesce(sold.qty, 0)::numeric / greatest(p_days, 1)), 1) end,
      'suggest_qty', greatest(coalesce(rl.level, p.reorder_level) * 2 - coalesce(bs.qty, 0), 1),
      'last_cost', (select cost from public.product_costs where product_id = p.id)
    ) as x
    from public.products p
    left join public.branch_stock bs on bs.product_id = p.id and bs.branch_id = p_branch_id
    left join public.product_reorder_levels rl on rl.product_id = p.id and rl.branch_id = p_branch_id
    left join lateral (
      select sum(-m.qty_change) as qty from public.stock_movements m
      where m.product_id = p.id and m.branch_id = p_branch_id and m.reason = 'sale'
        and m.created_at > now() - make_interval(days => greatest(p_days, 1))
    ) sold on true
    where p.shop_id = (select public.current_shop_id())
      and p.active and p.is_inventory
      and coalesce(bs.qty, 0) <= coalesce(rl.level, p.reorder_level)
  ) q;
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- Supplier dues, aging, and payments
-- ---------------------------------------------------------------------------

/**
 * A supplier's ledger: everything that moved their balance, oldest first.
 */
create or replace function public.supplier_ledger(p_supplier_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;
  if not exists (select 1 from public.suppliers
                 where id = p_supplier_id and shop_id = (select public.current_shop_id())) then
    raise exception 'SUPPLIER_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(x order by x->>'at'), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object('at', ob.as_of, 'kind', 'opening', 'document', 'Opening balance',
                              'change', ob.amount, 'note', ob.note) as x
    from public.opening_balances ob where ob.supplier_id = p_supplier_id
    union all
    select jsonb_build_object('at', g.created_at, 'kind', 'purchase', 'document', g.grn_no,
                              'change', g.total, 'note', g.supplier_invoice_no)
    from public.grns g where g.supplier_id = p_supplier_id and g.is_credit
    union all
    select jsonb_build_object('at', sp.created_at, 'kind', 'payment', 'document', sp.method,
                              'change', -sp.amount, 'note', sp.reference)
    from public.supplier_payments sp where sp.supplier_id = p_supplier_id
    union all
    select jsonb_build_object('at', sr.created_at, 'kind', 'return', 'document', sr.return_no,
                              'change', -sr.total, 'note', sr.reason)
    from public.supplier_returns sr where sr.supplier_id = p_supplier_id
  ) q;
  return v_out;
end; $$;

/**
 * How old a supplier's debt is: 0–30, 31–60, 60+ days.
 *
 * Payments are applied OLDEST FIRST, which is what a supplier assumes and what makes
 * the buckets mean anything. Applying them newest-first would keep the oldest invoice
 * perpetually overdue while the shop paid steadily.
 */
create or replace function public.supplier_aging(p_supplier_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_paid    numeric(12,2);
  v_bucket  record;
  v_b1      numeric(12,2) := 0;
  v_b2      numeric(12,2) := 0;
  v_b3      numeric(12,2) := 0;
  v_take    numeric(12,2);
begin
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;

  -- Everything that reduced the balance, to be spread over the oldest debt first.
  v_paid := coalesce((select sum(amount) from public.supplier_payments where supplier_id = p_supplier_id), 0)
          + coalesce((select sum(total) from public.supplier_returns where supplier_id = p_supplier_id), 0);

  for v_bucket in
    select age, sum(amount) as amount from (
      select case
               when public.dhaka_today() - ob.as_of <= 30 then 1
               when public.dhaka_today() - ob.as_of <= 60 then 2
               else 3
             end as age,
             ob.amount,
             ob.as_of as on_date
      from public.opening_balances ob where ob.supplier_id = p_supplier_id
      union all
      select case
               when public.dhaka_today() - (g.created_at at time zone 'Asia/Dhaka')::date <= 30 then 1
               when public.dhaka_today() - (g.created_at at time zone 'Asia/Dhaka')::date <= 60 then 2
               else 3
             end,
             g.total,
             (g.created_at at time zone 'Asia/Dhaka')::date
      from public.grns g where g.supplier_id = p_supplier_id and g.is_credit
    ) rows
    group by age
    order by age desc    -- oldest bucket first
  loop
    v_take := least(v_paid, v_bucket.amount);
    v_paid := v_paid - v_take;
    if v_bucket.age = 1 then v_b1 := v_bucket.amount - v_take;
    elsif v_bucket.age = 2 then v_b2 := v_bucket.amount - v_take;
    else v_b3 := v_bucket.amount - v_take;
    end if;
  end loop;

  return jsonb_build_object(
    'days_0_30', greatest(v_b1, 0), 'days_31_60', greatest(v_b2, 0), 'days_60_plus', greatest(v_b3, 0),
    'total', public.supplier_balance(p_supplier_id),
    -- A credit note or overpayment that has not been used up yet.
    'unapplied', greatest(v_paid, 0));
end; $$;

/**
 * Record what a customer or supplier owed on the day the shop moved across.
 *
 * The import sets these too (P4), but a shop that typed its catalogue in by hand still
 * needs a way to say "we already owed this supplier 45,000, as of last month". The date
 * matters: an opening balance from 90 days ago belongs in the 60+ aging bucket, not
 * today's, and `opening_balances` has no write policy so it can only come through here.
 */
create or replace function public.set_opening_balance(
  p_party_kind text,
  p_party_id   uuid,
  p_amount     numeric,
  p_as_of      date default null,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_name text; v_when date := coalesce(p_as_of, public.dhaka_today());
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  if p_party_kind not in ('customer', 'supplier') then raise exception 'BAD_PARTY_KIND:%', p_party_kind; end if;
  if p_amount is null then raise exception 'BAD_PAYMENT_AMOUNT'; end if;
  -- A balance dated in the future would age backwards.
  if v_when > public.dhaka_today() then raise exception 'OPENING_DATE_IN_FUTURE'; end if;

  if p_party_kind = 'supplier' then
    select name into v_name from public.suppliers where id = p_party_id and shop_id = v_me.shop_id;
    if v_name is null then raise exception 'SUPPLIER_NOT_FOUND'; end if;
    insert into public.opening_balances (shop_id, party_kind, supplier_id, amount, as_of, source, note)
    values (v_me.shop_id, 'supplier', p_party_id, p_amount, v_when, 'manual', p_note)
    on conflict (supplier_id) do update
      set amount = excluded.amount, as_of = excluded.as_of, note = excluded.note;
  else
    select coalesce(name, phone) into v_name from public.customers
      where id = p_party_id and shop_id = v_me.shop_id;
    if v_name is null then raise exception 'CUSTOMER_NOT_FOUND'; end if;
    insert into public.opening_balances (shop_id, party_kind, customer_id, amount, as_of, source, note)
    values (v_me.shop_id, 'customer', p_party_id, p_amount, v_when, 'manual', p_note)
    on conflict (customer_id) do update
      set amount = excluded.amount, as_of = excluded.as_of, note = excluded.note;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'opening_balance_set', p_party_kind, p_party_id,
          jsonb_build_object('name', v_name, 'amount', p_amount, 'as_of', v_when, 'note', p_note));

  return jsonb_build_object('name', v_name, 'amount', p_amount, 'as_of', v_when);
end; $$;

create or replace function public.pay_supplier(
  p_branch_id   uuid,
  p_supplier_id uuid,
  p_amount      numeric,
  p_method      text,
  p_reference   text default null,
  p_note        text default null,
  p_account_id  uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_id uuid; v_sup public.suppliers;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'BAD_PAYMENT_AMOUNT'; end if;

  select * into v_sup from public.suppliers where id = p_supplier_id and shop_id = v_me.shop_id;
  if not found then raise exception 'SUPPLIER_NOT_FOUND'; end if;
  if p_account_id is not null
     and not exists (select 1 from public.bank_accounts where id = p_account_id and shop_id = v_me.shop_id) then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  insert into public.supplier_payments (shop_id, branch_id, supplier_id, amount, method,
                                        reference, note, staff_id)
  values (v_me.shop_id, p_branch_id, p_supplier_id, p_amount, p_method,
          nullif(btrim(coalesce(p_reference, '')), ''), p_note, v_me.id)
  returning id into v_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'supplier_paid', 'supplier', p_supplier_id,
          jsonb_build_object('supplier', v_sup.name, 'amount', p_amount, 'method', p_method,
                             'reference', p_reference,
                             'balance_after', public.supplier_balance(p_supplier_id)));

  return jsonb_build_object('payment_id', v_id, 'supplier', v_sup.name, 'amount', p_amount,
                            'balance', public.supplier_balance(p_supplier_id),
                            'aging', public.supplier_aging(p_supplier_id));
end; $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.requisitions                 enable row level security;
alter table public.requisition_items            enable row level security;
alter table public.purchase_orders              enable row level security;
alter table public.purchase_order_items         enable row level security;
alter table public.purchase_order_requisitions  enable row level security;

-- A requisition is a request, not money, so anyone at the branch can see what has been
-- asked for. What it will cost is on the order, which is restricted.
create policy requisitions_read on public.requisitions for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())));
create policy requisition_items_read on public.requisition_items for select to authenticated
  using (exists (select 1 from public.requisitions r where r.id = req_id
                 and r.branch_id = any(select unnest(public.current_branch_ids()))));

create policy purchase_orders_read on public.purchase_orders for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids()))
         and (select public.has_permission('see_cost')));
create policy purchase_order_items_read on public.purchase_order_items for select to authenticated
  using (exists (select 1 from public.purchase_orders po where po.id = po_id
                 and po.branch_id = any(select unnest(public.current_branch_ids()))
                 and (select public.has_permission('see_cost'))));
create policy po_requisitions_read on public.purchase_order_requisitions for select to authenticated
  using (exists (select 1 from public.purchase_orders po where po.id = po_id
                 and po.branch_id = any(select unnest(public.current_branch_ids()))));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.save_requisition(uuid, jsonb, date, text, uuid, boolean) from public, anon;
revoke execute on function public.decide_requisition(uuid, boolean, text) from public, anon;
revoke execute on function public.save_purchase_order(uuid, uuid, jsonb, integer, numeric, numeric, numeric, text, uuid, uuid[]) from public, anon;
revoke execute on function public.set_po_status(uuid, text, text) from public, anon;
revoke execute on function public.receive_against_po(uuid, jsonb, text, date, boolean, text, numeric, text, text) from public, anon;
revoke execute on function public.reorder_suggestions(uuid, integer) from public, anon;
revoke execute on function public.supplier_ledger(uuid) from public, anon;
revoke execute on function public.supplier_aging(uuid) from public, anon;
revoke execute on function public.pay_supplier(uuid, uuid, numeric, text, text, text, uuid) from public, anon;
revoke execute on function public.set_opening_balance(text, uuid, numeric, date, text) from public, anon;

grant execute on function public.save_requisition(uuid, jsonb, date, text, uuid, boolean) to authenticated;
grant execute on function public.decide_requisition(uuid, boolean, text) to authenticated;
grant execute on function public.save_purchase_order(uuid, uuid, jsonb, integer, numeric, numeric, numeric, text, uuid, uuid[]) to authenticated;
grant execute on function public.set_po_status(uuid, text, text) to authenticated;
grant execute on function public.receive_against_po(uuid, jsonb, text, date, boolean, text, numeric, text, text) to authenticated;
grant execute on function public.reorder_suggestions(uuid, integer) to authenticated;
grant execute on function public.supplier_ledger(uuid) to authenticated;
grant execute on function public.supplier_aging(uuid) to authenticated;
grant execute on function public.pay_supplier(uuid, uuid, numeric, text, text, text, uuid) to authenticated;
grant execute on function public.set_opening_balance(text, uuid, numeric, date, text) to authenticated;
