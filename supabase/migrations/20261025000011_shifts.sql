-- P8 — Shifts and the cash check
--
-- The reason this exists: in BMS nobody records cash received, so the bill prints
-- "PAID" and the drawer can never be checked. An owner has no way to tell a good day
-- from a day with money missing. A shift gives the drawer two ends — what was in it
-- when the till opened, and what was counted when it closed — and everything in between
-- is already recorded, so the difference is arithmetic rather than an accusation.
--
-- WHAT A CASHIER SEES
-- Nothing. Closing a shift tells the person who closed it "thank you" and no more. If
-- the till showed the expected figure, counting would stop being a count: anyone short
-- would simply type the expected number in. The owner sees expected, counted and the
-- difference; the cashier sees that the shift is closed.

-- ---------------------------------------------------------------------------
-- The drawer
-- ---------------------------------------------------------------------------

alter table public.shifts
  -- Counted = what was physically in the drawer. Difference is stored rather than
  -- recomputed, because the expected figure depends on sales that can later be voided
  -- or refunded, and "what we found that evening" must not change afterwards.
  add column difference   numeric(12,2),
  add column closed_by    uuid references public.staff(id),
  -- What the cashier counted, note by note, when they used the helper. Kept because a
  -- drawer that is 500 short reads very differently from one that is 500 short AND has
  -- no 500 notes in it at all.
  add column note_counts  jsonb;

-- How far out the drawer can be before it is worth asking about. Rounding and a 5-taka
-- coin are not theft; 500 is.
alter table public.shops
  add column cash_short_limit numeric(12,2) not null default 50
    check (cash_short_limit >= 0);

create table public.cash_movements (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid not null references public.branches(id),
  shift_id    uuid references public.shifts(id) on delete set null,
  direction   text not null check (direction in ('in', 'out')),
  amount      numeric(12,2) not null check (amount > 0),
  -- Why the money moved. 'expense' carries a category so P13 can post it to an account;
  -- the rest are drawer housekeeping.
  reason      text not null check (reason in ('expense', 'owner_took', 'owner_put_in',
                                              'bought_change', 'bank_deposit', 'other')),
  category_id uuid references public.transaction_categories(id),
  note        text,
  staff_id    uuid not null references public.staff(id),
  created_at  timestamptz not null default now()
);
create index cash_movements_shift_idx on public.cash_movements(shift_id);
create index cash_movements_branch_idx on public.cash_movements(branch_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Expense categories a shop actually has
-- ---------------------------------------------------------------------------

-- transaction_categories already carries `applies_to`, so an expense category is just a
-- category that applies to expenses. The P2 seed only gave sale channels, so a shop had
-- nothing sensible to pick when the owner took 200 for tea.
create or replace function public.seed_cash_defaults(p_shop_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.transaction_categories (shop_id, name, applies_to)
  values (p_shop_id, 'Tea and snacks',  '{expense}'),
         (p_shop_id, 'Transport',       '{expense}'),
         (p_shop_id, 'Electricity',     '{expense}'),
         (p_shop_id, 'Shop rent',       '{expense}'),
         (p_shop_id, 'Staff advance',   '{expense}'),
         (p_shop_id, 'Repairs',         '{expense}'),
         (p_shop_id, 'Office supplies', '{expense}')
  on conflict (shop_id, name) do nothing;
$$;

-- Shops that already exist get them too, or the cash-out screen opens with an empty list.
select public.seed_cash_defaults(id) from public.shops;

-- And every shop made from now on. Same function as P2, with one line added at the end,
-- so a brand-new shop is not missing the categories its first cash-out needs.
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
end; $$;

-- ---------------------------------------------------------------------------
-- Opening
-- ---------------------------------------------------------------------------

/** What the till needs to know before it can sell: is a drawer open, and with what. */
create or replace function public.current_shift(p_branch_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_shift public.shifts; v_last numeric(12,2);
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  select * into v_shift from public.shifts
    where staff_id = v_me.id and branch_id = p_branch_id and closed_at is null
    order by opened_at desc limit 1;

  -- What the last person to close this drawer counted, so opening is one tap instead of
  -- a guess. It is the branch's drawer, not this person's, so whoever closed it counts.
  select counted_cash into v_last from public.shifts
    where branch_id = p_branch_id and closed_at is not null
    order by closed_at desc limit 1;

  return jsonb_build_object(
    'open', v_shift.id is not null,
    'shift_id', v_shift.id,
    'opened_at', v_shift.opened_at,
    'opening_cash', v_shift.opening_cash,
    'last_close', v_last,
    -- An owner may sell without opening a drawer; a cashier may not. The till uses this
    -- to warn rather than to block, because the block lives in the database.
    'may_sell_without_shift', v_me.role = 'owner');
end; $$;

/** Open the drawer for the day. One open shift per person per branch. */
create or replace function public.open_shift(
  p_branch_id uuid, p_opening_cash numeric default 0
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_id uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if coalesce(p_opening_cash, 0) < 0 then raise exception 'BAD_CASH_AMOUNT'; end if;
  if exists (select 1 from public.shifts
             where staff_id = v_me.id and branch_id = p_branch_id and closed_at is null) then
    raise exception 'SHIFT_ALREADY_OPEN';
  end if;

  insert into public.shifts (shop_id, branch_id, staff_id, opening_cash)
  values (v_me.shop_id, p_branch_id, v_me.id, coalesce(p_opening_cash, 0))
  returning id into v_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'shift_opened', 'shift', v_id,
          jsonb_build_object('opening_cash', coalesce(p_opening_cash, 0)));

  return jsonb_build_object('shift_id', v_id, 'opening_cash', coalesce(p_opening_cash, 0));
end; $$;

-- ---------------------------------------------------------------------------
-- Cash in and out during the day
-- ---------------------------------------------------------------------------

/**
 * Money leaving or entering the drawer for something other than a sale.
 *
 * Without this, every 200 taka taken out for tea looks like a shortage at closing time,
 * and a real shortage gets explained away as "probably the tea money".
 */
create or replace function public.cash_movement(
  p_branch_id  uuid,
  p_direction  text,
  p_amount     numeric,
  p_reason     text,
  p_category_id uuid default null,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_shift uuid; v_id uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_direction not in ('in', 'out') then raise exception 'BAD_CASH_DIRECTION:%', p_direction; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_CASH_AMOUNT'; end if;
  if p_reason not in ('expense', 'owner_took', 'owner_put_in', 'bought_change',
                      'bank_deposit', 'other') then
    raise exception 'BAD_CASH_REASON:%', p_reason;
  end if;
  -- An expense with no category is an expense nobody can add up later.
  if p_reason = 'expense' and p_category_id is null then raise exception 'EXPENSE_CATEGORY_REQUIRED'; end if;
  if p_reason = 'other' and coalesce(btrim(p_note), '') = '' then raise exception 'REASON_NOTE_REQUIRED'; end if;
  if p_category_id is not null
     and not exists (select 1 from public.transaction_categories
                     where id = p_category_id and shop_id = v_me.shop_id) then
    raise exception 'CATEGORY_NOT_FOUND';
  end if;

  select id into v_shift from public.shifts
    where staff_id = v_me.id and branch_id = p_branch_id and closed_at is null
    order by opened_at desc limit 1;

  insert into public.cash_movements (shop_id, branch_id, shift_id, direction, amount,
                                     reason, category_id, note, staff_id)
  values (v_me.shop_id, p_branch_id, v_shift, p_direction, p_amount,
          p_reason, p_category_id, p_note, v_me.id)
  returning id into v_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id,
          case when p_direction = 'in' then 'cash_in' else 'cash_out' end,
          'cash_movement', v_id,
          jsonb_build_object('amount', p_amount, 'reason', p_reason, 'note', p_note,
                             'category', (select name from public.transaction_categories
                                          where id = p_category_id)));

  return jsonb_build_object('id', v_id, 'direction', p_direction, 'amount', p_amount);
end; $$;

-- ---------------------------------------------------------------------------
-- What the drawer should hold
-- ---------------------------------------------------------------------------

/**
 * Expected cash for a shift, from the documents.
 *
 * Drawer movement on a cash sale is what was handed over minus the change given back,
 * which is the sale total — but it is worked out from the two figures actually recorded,
 * so an over-entered `cash_received` shows up instead of hiding.
 *
 * Cash refunds (P9) and cash collected against a due (P10) belong in this sum too; they
 * do not exist yet, and when they do they are a line each here, not a new formula.
 */
create or replace function public.expected_cash(p_shift_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(s.opening_cash, 0)
       + coalesce((select sum(coalesce(sa.cash_received, sa.total) - coalesce(sa.change_given, 0))
                   from public.sales sa
                   where sa.shift_id = s.id and sa.payment_method = 'cash'
                     and sa.status = 'completed'), 0)
       + coalesce((select sum(case when cm.direction = 'in' then cm.amount else -cm.amount end)
                   from public.cash_movements cm where cm.shift_id = s.id), 0)
  from public.shifts s where s.id = p_shift_id;
$$;

/**
 * Close the drawer.
 *
 * The person closing gives one number: what they counted. Everything else is worked out
 * and stored. The result they get back says only that it is closed — see the note at the
 * top of this file for why.
 */
create or replace function public.close_shift(
  p_shift_id     uuid,
  p_counted_cash numeric,
  p_note         text default null,
  p_note_counts  jsonb default null   -- { "1000": 2, "500": 3, ... }
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_shift    public.shifts;
  v_expected numeric(12,2);
  v_diff     numeric(12,2);
  v_limit    numeric(12,2);
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if coalesce(p_counted_cash, -1) < 0 then raise exception 'BAD_CASH_AMOUNT'; end if;

  select * into v_shift from public.shifts where id = p_shift_id and shop_id = v_me.shop_id;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  if v_shift.closed_at is not null then raise exception 'SHIFT_ALREADY_CLOSED'; end if;
  if not public.can_use_branch(v_shift.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  -- Your own drawer, or a manager closing one that was left open.
  if v_shift.staff_id <> v_me.id and not public.is_manager() then raise exception 'NOT_MANAGER'; end if;

  v_expected := public.expected_cash(p_shift_id);
  v_diff := p_counted_cash - v_expected;
  select cash_short_limit into v_limit from public.shops where id = v_me.shop_id;

  update public.shifts set
    closed_at = now(), closed_by = v_me.id,
    expected_cash = v_expected, counted_cash = p_counted_cash, difference = v_diff,
    note_counts = p_note_counts,
    note = case when p_note is null then note else coalesce(note || ' · ', '') || p_note end
  where id = p_shift_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_shift.branch_id, v_me.id, 'shift_closed', 'shift', p_shift_id,
          jsonb_build_object('expected', v_expected, 'counted', p_counted_cash,
                             'difference', v_diff, 'note', p_note,
                             'over_limit', abs(v_diff) > coalesce(v_limit, 50)));

  -- A manager or owner closing a drawer is checking it, so they get the figures. Anyone
  -- else gets the acknowledgement and nothing to work backwards from.
  if public.is_manager() then
    return jsonb_build_object('closed', true, 'expected', v_expected,
                              'counted', p_counted_cash, 'difference', v_diff,
                              'over_limit', abs(v_diff) > coalesce(v_limit, 50));
  end if;
  return jsonb_build_object('closed', true);
end; $$;

-- ---------------------------------------------------------------------------
-- What the owner sees
-- ---------------------------------------------------------------------------

/**
 * Shifts at a branch, newest first, with the drawer check and the totals per payment
 * method — so bKash, Nagad and card can be matched against the statements that come
 * from elsewhere, which is the only way those ever get checked.
 */
create or replace function public.shift_list(p_branch_id uuid, p_limit integer default 30)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb; v_limit numeric(12,2);
begin
  if not public.is_manager() then raise exception 'NOT_ALLOWED:view_reports'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  select cash_short_limit into v_limit from public.shops where id = (select public.current_shop_id());

  select coalesce(jsonb_agg(x order by x->>'opened_at' desc), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'id', s.id,
      'staff', st.name,
      'opened_at', s.opened_at,
      'closed_at', s.closed_at,
      'opening_cash', s.opening_cash,
      -- An open drawer has no counted figure yet, so show where it stands instead.
      'expected_cash', coalesce(s.expected_cash, public.expected_cash(s.id)),
      'counted_cash', s.counted_cash,
      'difference', s.difference,
      'over_limit', s.difference is not null and abs(s.difference) > coalesce(v_limit, 50),
      'note', s.note,
      'note_counts', s.note_counts,
      'sales_count', (select count(*) from public.sales sa
                      where sa.shift_id = s.id and sa.status = 'completed'),
      'by_method', (select coalesce(jsonb_object_agg(m.payment_method, m.amount), '{}'::jsonb)
                    from (select sa.payment_method, sum(sa.total) as amount
                          from public.sales sa
                          where sa.shift_id = s.id and sa.status = 'completed'
                          group by sa.payment_method) m),
      'cash_out', (select coalesce(sum(amount), 0) from public.cash_movements
                   where shift_id = s.id and direction = 'out'),
      'cash_in', (select coalesce(sum(amount), 0) from public.cash_movements
                  where shift_id = s.id and direction = 'in'),
      'movements', (select coalesce(jsonb_agg(jsonb_build_object(
                      'at', cm.created_at, 'direction', cm.direction, 'amount', cm.amount,
                      'reason', cm.reason, 'note', cm.note,
                      'category', (select name from public.transaction_categories
                                   where id = cm.category_id),
                      'who', (select name from public.staff where id = cm.staff_id))
                      order by cm.created_at), '[]'::jsonb)
                    from public.cash_movements cm where cm.shift_id = s.id)
    ) as x
    from public.shifts s
    join public.staff st on st.id = s.staff_id
    where s.branch_id = p_branch_id
    order by s.opened_at desc
    limit greatest(p_limit, 1)
  ) q;
  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- No drawer, no selling
-- ---------------------------------------------------------------------------

/**
 * A cashier cannot sell without an open drawer.
 *
 * This is a trigger rather than another line in complete_sale() because complete_sale()
 * is already 400 lines and has been redefined five times; copying it a sixth time to add
 * one check is how the copies drift apart. The rule belongs to the SALE ROW, wherever it
 * is inserted from, which is exactly what a trigger is for.
 *
 * Owners are let through: the owner is the person who would be stealing from themselves,
 * and an owner locked out of their own till at 9pm will simply stop using the app. The
 * till warns them instead.
 */
create or replace function public.require_open_shift() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if new.shift_id is not null then return new; end if;
  select role into v_role from public.staff where id = new.staff_id;
  if v_role = 'owner' then return new; end if;
  if exists (select 1 from public.shifts
             where staff_id = new.staff_id and branch_id = new.branch_id and closed_at is null) then
    return new;
  end if;
  raise exception 'NO_OPEN_SHIFT';
end; $$;

create trigger sales_require_open_shift
  before insert on public.sales
  for each row execute function public.require_open_shift();

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
    cash_short_limit = coalesce((p_values->>'cash_short_limit')::numeric, cash_short_limit)
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

alter table public.cash_movements enable row level security;

-- A cashier may see the drawer movements at their own branch: they are the ones who
-- wrote most of them down, and hiding "owner took 200 for tea" from the person who will
-- be short 200 at closing time would be perverse.
create policy cash_movements_read on public.cash_movements for select to authenticated
  using (branch_id = any(select unnest(public.current_branch_ids())));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.current_shift(uuid) from public, anon;
revoke execute on function public.open_shift(uuid, numeric) from public, anon;
revoke execute on function public.cash_movement(uuid, text, numeric, text, uuid, text) from public, anon;
revoke execute on function public.close_shift(uuid, numeric, text, jsonb) from public, anon;
revoke execute on function public.shift_list(uuid, integer) from public, anon;
-- expected_cash() is the figure a cashier must not see, so it is callable only from
-- inside the functions above, never from the browser.
revoke execute on function public.expected_cash(uuid) from public, anon, authenticated;
revoke execute on function public.seed_cash_defaults(uuid) from public, anon, authenticated;

grant execute on function public.current_shift(uuid) to authenticated;
grant execute on function public.open_shift(uuid, numeric) to authenticated;
grant execute on function public.cash_movement(uuid, text, numeric, text, uuid, text) to authenticated;
grant execute on function public.close_shift(uuid, numeric, text, jsonb) to authenticated;
grant execute on function public.shift_list(uuid, integer) to authenticated;
