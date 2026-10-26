-- P14 — Accounts 2: reports, period lock and export
--
-- WHAT THIS FILE IS FOR
-- docs/BMS_REPORTS.md is the checklist: a hundred BMS printouts, read column by
-- column. Nearly all of them are the same shape — take a list of lines, group it two
-- or three deep, total the money and the quantity at every level — so this file holds
-- ONE engine that does that, and a report is a row of configuration. The dozen that
-- are genuinely a different shape (the trial balance, the balance sheet, a ledger, the
-- day book) each name a builder of their own.
--
-- THE CONFIGURATION LIVES IN src/lib/reports.ts
-- Both the screen and this engine need to know a report's title, columns and grouping.
-- Rather than keep two copies that drift, that TypeScript file is the source and
-- scripts/gen-reports.mts writes the seed migration beside this one — the same
-- arrangement as the Bangladesh area list. Re-run the generator; never hand-edit the
-- generated file.
--
-- WHAT WE ARE NOT COPYING
-- BMS's trial balance does not balance, and its balance sheet is out by the same
-- amount. Its "current stock" and its "stock as on today" disagree by four units, and
-- its trial balance and balance sheet each quote a different one of them. Its unit
-- cost column is the latest purchase price printed next to a total built from the
-- average, so the column does not equal the total divided by the quantity. Its
-- percentage columns are summed instead of recomputed. Section 3 of BMS_REPORTS.md
-- lists all of it; every one of those is a check in supabase/tests.

-- ---------------------------------------------------------------------------
-- A moment, as the Dhaka calendar sees it
-- ---------------------------------------------------------------------------

/**
 * Six hours matter here. A sale at 1am Dhaka is 7pm the previous day in UTC, so a
 * report that sliced the timestamp would put the night's takings on the wrong day —
 * exactly the bug P12 found in the demo backend. Every date in every report in this
 * file comes from here.
 */
create or replace function public.dhaka_date(p_at timestamptz) returns date
language sql immutable set search_path = public as $$
  select (p_at at time zone 'Asia/Dhaka')::date;
$$;

-- ---------------------------------------------------------------------------
-- PART 1 — FIFO quantity layers
-- ---------------------------------------------------------------------------
--
-- Three kinds of report cannot be answered without knowing WHICH DELIVERY each unit
-- came from: how long stock has been sitting (ST-9, ST-10), which purchase invoice a
-- sold unit came in on (S-2, S-15), and what happened to one delivery (P-24). Serial
-- items already carry that, because a serial is one physical object. For everything
-- else we keep the remaining quantity per delivery line and sell the oldest first.
--
-- LAYERS TRACK QUANTITY AND DATE, NOT VALUE. The cost of a product stays the weighted
-- average decided in P5: a shop buying the same SSD at 6,000 and 6,400 does not want
-- yesterday's margin to change because today's delivery was dearer, and it does not
-- want two units on the same shelf to be worth different amounts. So a layer's
-- unit_cost is what that delivery cost — useful for "what did this batch cost us" —
-- and never used to value stock or work out profit.
--
-- ONE HOOK, NOT SEVEN. Every change to stock in the whole application already writes
-- a stock_movements row: that is what the table is for. So the layers hang off that
-- one trigger rather than off sales, deliveries, transfers, returns, counts, claims
-- and corrections separately. A path that moved stock without touching layers would
-- be a path whose ageing report quietly lies.

create table public.stock_layers (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid not null references public.branches(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  -- Where the units came from, in the words the reports use.
  source_kind text not null check (source_kind in (
    'purchase', 'opening', 'sale_return', 'transfer_in', 'adjust_in', 'exchange')),
  source_id   uuid,
  -- The document number, so a report can print it: GRN-MB-2026000001, RET-MB-…
  doc_no      text,
  supplier_id uuid references public.suppliers(id) on delete set null,
  received_on date not null,
  qty         integer not null check (qty > 0),
  -- How many of those units are still here. Zero means the layer is used up; it stays,
  -- because P-24 asks what happened to a delivery after it sold out.
  remaining   integer not null check (remaining >= 0),
  unit_cost   numeric(12,2),
  created_at  timestamptz not null default now()
);
create index stock_layers_pick_idx
  on public.stock_layers(branch_id, product_id, received_on, created_at);
create index stock_layers_open_idx
  on public.stock_layers(shop_id, product_id) where remaining > 0;
create index stock_layers_source_idx on public.stock_layers(source_kind, source_id);

/** Which delivery each sold unit came out of. */
create table public.sale_line_layers (
  sale_item_id uuid not null references public.sale_items(id) on delete cascade,
  layer_id     uuid not null references public.stock_layers(id) on delete cascade,
  qty          integer not null check (qty > 0),
  primary key (sale_item_id, layer_id)
);

/**
 * Stock arrived: open a layer.
 *
 * The document it came from decides the date and the number printed against it. A
 * delivery is dated by the SUPPLIER'S invoice date where there is one, not by when
 * somebody got round to typing it in, because that is the date the ageing report is
 * answering questions about.
 */
create or replace function public.layer_add(
  p_shop_id uuid, p_branch_id uuid, p_product_id uuid, p_qty integer,
  p_reason text, p_ref_id uuid, p_at timestamptz, p_note text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_kind text := 'adjust_in';
  v_doc  text;
  v_sup  uuid;
  v_on   date := public.dhaka_date(p_at);
  v_cost numeric(12,2);
begin
  if p_qty <= 0 then return; end if;

  if p_reason = 'purchase' and p_ref_id is not null then
    select 'purchase', g.grn_no, g.supplier_id, coalesce(g.invoice_date, public.dhaka_date(g.created_at)),
           (select coalesce(i.landed_cost, i.unit_cost) from public.grn_items i
            where i.grn_id = g.id and i.product_id = p_product_id limit 1)
      into v_kind, v_doc, v_sup, v_on, v_cost
    from public.grns g where g.id = p_ref_id;
  elsif p_reason in ('return', 'adjust_in') and p_ref_id is not null then
    -- A customer's return goes back on the shelf as its own layer, dated the day it
    -- came back: it has been in the shop as long as the shelf has had it, not as long
    -- as the original delivery.
    select 'sale_return', r.return_no into v_kind, v_doc
    from public.sale_returns r where r.id = p_ref_id;
    if v_doc is null then
      select 'sale_return', s.invoice_no into v_kind, v_doc
      from public.sales s where s.id = p_ref_id;
    end if;
  elsif p_reason = 'transfer_in' and p_ref_id is not null then
    select 'transfer_in', t.transfer_no into v_kind, v_doc
    from public.transfers t where t.id = p_ref_id;
  end if;

  if v_kind = 'adjust_in' and p_note is not null and p_note ilike 'opening stock%' then
    v_kind := 'opening';
  end if;
  if v_doc is null then v_doc := nullif(p_note, ''); end if;
  if v_cost is null then
    select cost into v_cost from public.product_costs where product_id = p_product_id;
  end if;

  insert into public.stock_layers (shop_id, branch_id, product_id, source_kind, source_id,
                                   doc_no, supplier_id, received_on, qty, remaining, unit_cost)
  values (p_shop_id, p_branch_id, p_product_id, v_kind, p_ref_id, v_doc, v_sup,
          v_on, p_qty, p_qty, v_cost);
end; $$;

/**
 * Stock left: take it off the oldest layers first.
 *
 * If the layers do not add up to what left — a shop whose history predates this
 * table, before the back-fill is run — we take what there is and stop. A missing
 * layer is a gap in a report, which is visible; raising here would stop a sale, which
 * would be a reporting feature breaking the till.
 */
create or replace function public.layer_take(
  p_shop_id uuid, p_branch_id uuid, p_product_id uuid, p_qty integer,
  p_reason text, p_ref_id uuid, p_sale_item_id uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_left integer := p_qty;
  v_take integer;
  v_item uuid := p_sale_item_id;
  v_layer record;
begin
  if p_qty <= 0 then return; end if;

  -- Which sale line this was, so S-2 can print the purchase invoice against it. The
  -- till passes the line in (complete_sale writes the stock movement BEFORE the line,
  -- so the trigger on the movement cannot know it yet); the back-fill, replaying old
  -- documents, looks it up — a line that has not been matched yet, so a sale with the
  -- same product twice links each line once.
  if v_item is null and p_reason = 'sale' and p_ref_id is not null then
    select i.id into v_item from public.sale_items i
    where i.sale_id = p_ref_id and i.product_id = p_product_id
      and not exists (select 1 from public.sale_line_layers sl where sl.sale_item_id = i.id)
    order by i.id limit 1;
  end if;

  for v_layer in
    select * from public.stock_layers
    where branch_id = p_branch_id and product_id = p_product_id and remaining > 0
    order by received_on, created_at
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_layer.remaining);
    update public.stock_layers set remaining = remaining - v_take where id = v_layer.id;
    if v_item is not null then
      insert into public.sale_line_layers (sale_item_id, layer_id, qty)
      values (v_item, v_layer.id, v_take)
      on conflict (sale_item_id, layer_id) do update set qty = sale_line_layers.qty + v_take;
    end if;
    v_left := v_left - v_take;
  end loop;
end; $$;

/**
 * Units came back: give them back to the layers they went out of.
 *
 * A return of something sold from a six-month-old delivery belongs back on that
 * delivery, not on a new one, or the ageing report resets the clock every time a
 * customer changes their mind.
 */
create or replace function public.layer_give_back(p_sale_id uuid, p_product_id uuid, p_qty integer)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_left integer := p_qty; v_give integer; v_row record;
begin
  for v_row in
    select sl.layer_id, sl.qty, l.qty as layer_qty, l.remaining
    from public.sale_line_layers sl
    join public.stock_layers l on l.id = sl.layer_id
    join public.sale_items i on i.id = sl.sale_item_id
    where i.sale_id = p_sale_id and i.product_id = p_product_id
    order by l.received_on desc
  loop
    exit when v_left <= 0;
    v_give := least(v_left, v_row.qty, v_row.layer_qty - v_row.remaining);
    if v_give <= 0 then continue; end if;
    update public.stock_layers set remaining = remaining + v_give where id = v_row.layer_id;
    v_left := v_left - v_give;
  end loop;
  return p_qty - v_left;
end; $$;

-- WHAT IT COST AT THE TIME, captured as the movement is written.
--
-- The same lesson as P12's captured sale cost. The weighted average moves every time
-- stock is received, so valuing a write-off from three months ago at today's average is
-- wrong by however much prices have moved — and the stock account and the stock
-- valuation then disagree for ever, with nothing to say which of them is right. One
-- trigger, so no caller has to remember.
alter table public.stock_movements add column unit_cost numeric(12,2);

create or replace function public.set_movement_cost() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.unit_cost is null and new.reason in ('transfer_out', 'transfer_in')
     and new.ref_id is not null then
    select ti.unit_cost into new.unit_cost from public.transfer_items ti
    where ti.transfer_id = new.ref_id and ti.product_id = new.product_id limit 1;
  end if;
  if new.unit_cost is null then
    select cost into new.unit_cost from public.product_costs where product_id = new.product_id;
  end if;
  return new;
end; $$;

create trigger stock_movements_cost
  before insert on public.stock_movements
  for each row execute function public.set_movement_cost();

/** The one hook: every stock movement, in or out. */
create or replace function public.apply_stock_layer() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_done integer := 0;
begin
  if new.qty_change = 0 or new.branch_id is null then return new; end if;

  if new.qty_change > 0 then
    -- Something coming back from a sale or a void: put it back where it came from
    -- first, and only open a new layer for whatever is left over.
    if new.reason = 'return' and new.ref_id is not null then
      v_done := public.layer_give_back(
        (select coalesce(r.sale_id, new.ref_id) from public.sale_returns r where r.id = new.ref_id),
        new.product_id, new.qty_change);
    end if;
    if new.qty_change - v_done > 0 then
      perform public.layer_add(new.shop_id, new.branch_id, new.product_id,
                               new.qty_change - v_done, new.reason, new.ref_id,
                               new.created_at, new.note);
    end if;
  else
    -- A sale's lines take their own layers (see below): at this point in
    -- complete_sale() the sale_items row does not exist yet, so there would be nothing
    -- to link the delivery to.
    if new.reason = 'sale' then return new; end if;
    perform public.layer_take(new.shop_id, new.branch_id, new.product_id,
                              -new.qty_change, new.reason, new.ref_id);
  end if;
  return new;
end; $$;

create trigger stock_movements_layers
  after insert on public.stock_movements
  for each row execute function public.apply_stock_layer();

/**
 * A sold line takes its units off the oldest deliveries.
 *
 * On the sale LINE rather than on the stock movement, because the line is what a report
 * prints the purchase invoice against — and because complete_sale() writes the movement
 * first, so at that moment there is no line to point at. The same reasoning as P12's
 * captured cost, which is a trigger on this table for the same reason.
 */
create or replace function public.take_sale_layers() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_branch uuid;
begin
  select s.branch_id into v_branch from public.sales s where s.id = new.sale_id;
  if v_branch is null then return new; end if;
  perform public.layer_take(new.shop_id, v_branch, new.product_id, new.qty,
                            'sale', new.sale_id, new.id);
  return new;
end; $$;

create trigger sale_items_take_layers
  after insert on public.sale_items
  for each row execute function public.take_sale_layers();

/**
 * Build the layers for a shop that was trading before this table existed.
 *
 * Layers are worked out FROM the movements, so they can always be rebuilt from
 * scratch; that is why this clears them first instead of trying to patch them. Safe
 * to press twice, which matters because a shop with two years of history may time the
 * first run out. Owner only: it rewrites a whole shop's reporting history.
 */
create or replace function public.backfill_stock_layers() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_mv record; v_n integer := 0; v_done integer;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found or v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;

  delete from public.sale_line_layers sl
    using public.stock_layers l where l.id = sl.layer_id and l.shop_id = v_me.shop_id;
  delete from public.stock_layers where shop_id = v_me.shop_id;

  for v_mv in
    select * from public.stock_movements
    where shop_id = v_me.shop_id and branch_id is not null and qty_change <> 0
    order by created_at, id
  loop
    if v_mv.qty_change > 0 then
      v_done := 0;
      if v_mv.reason = 'return' and v_mv.ref_id is not null then
        v_done := public.layer_give_back(
          (select coalesce(r.sale_id, v_mv.ref_id) from public.sale_returns r where r.id = v_mv.ref_id),
          v_mv.product_id, v_mv.qty_change);
      end if;
      if v_mv.qty_change - v_done > 0 then
        perform public.layer_add(v_mv.shop_id, v_mv.branch_id, v_mv.product_id,
                                 v_mv.qty_change - v_done, v_mv.reason, v_mv.ref_id,
                                 v_mv.created_at, v_mv.note);
      end if;
    else
      perform public.layer_take(v_mv.shop_id, v_mv.branch_id, v_mv.product_id,
                                -v_mv.qty_change, v_mv.reason, v_mv.ref_id);
    end if;
    v_n := v_n + 1;
  end loop;

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id, 'stock_layers_rebuilt', 'stock_layer',
          jsonb_build_object('movements', v_n));

  return jsonb_build_object(
    'movements', v_n,
    'layers', (select count(*) from public.stock_layers where shop_id = v_me.shop_id),
    'open_layers', (select count(*) from public.stock_layers
                    where shop_id = v_me.shop_id and remaining > 0));
end; $$;

-- ---------------------------------------------------------------------------
-- PART 2 — The period lock
-- ---------------------------------------------------------------------------
--
-- Once the owner has looked at a month's figures, signed off the VAT and told the
-- accountant, nothing in that month may change: a sale voided in September three
-- weeks later makes every report printed since then wrong, and nobody finds out.
-- BMS calls it Transaction Lock. Locking is per month, per shop, and only the owner
-- can do either half of it — and unlocking is logged, because "who opened August
-- again, and why?" is the question that matters afterwards.

create table public.period_locks (
  shop_id      uuid not null references public.shops(id) on delete cascade,
  -- Always the first day of the month, so "September 2026" is one row.
  locked_month date not null,
  note         text,
  locked_by    uuid not null references public.staff(id),
  locked_at    timestamptz not null default now(),
  primary key (shop_id, locked_month)
);

/** Is this date inside a month somebody has closed? */
create or replace function public.period_locked(p_date date, p_shop_id uuid default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.period_locks
    where shop_id = coalesce(p_shop_id, (select public.current_shop_id()))
      and locked_month = date_trunc('month', p_date)::date);
$$;

/**
 * Refuse to touch a closed month.
 *
 * The escape hatch is a session setting that only the back-fills set, because they
 * replay documents that have ALREADY happened — they post the entry a trigger would
 * have posted at the time, and refusing that would leave a locked month with no
 * books at all.
 */
create or replace function public.assert_period_open(p_date date, p_shop_id uuid default null)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.replaying_history', true), '') = 'on' then return; end if;
  if p_date is null then return; end if;
  if public.period_locked(p_date, p_shop_id) then
    raise exception 'PERIOD_LOCKED:%', to_char(p_date, 'FMMonth YYYY');
  end if;
end; $$;

/**
 * The guard itself, on every table that records something dated.
 *
 * One function for all of them: the date column's name comes in as a trigger
 * argument, and 'ts' says it is a timestamp that needs turning into a Dhaka date
 * first. An UPDATE is checked against BOTH dates, so a document cannot be dragged out
 * of a closed month either.
 */
create or replace function public.guard_period() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_col text := TG_ARGV[0]; v_kind text := coalesce(TG_ARGV[1], 'date');
        v_new text; v_old text; v_shop uuid;
begin
  v_shop := (to_jsonb(new)->>'shop_id')::uuid;
  v_new := to_jsonb(new)->>v_col;
  if v_kind = 'ts' then
    perform public.assert_period_open(public.dhaka_date(v_new::timestamptz), v_shop);
  else
    perform public.assert_period_open(v_new::date, v_shop);
  end if;
  if TG_OP = 'UPDATE' then
    v_old := to_jsonb(old)->>v_col;
    if v_old is distinct from v_new then
      if v_kind = 'ts' then
        perform public.assert_period_open(public.dhaka_date(v_old::timestamptz), v_shop);
      else
        perform public.assert_period_open(v_old::date, v_shop);
      end if;
    end if;
  end if;
  return new;
end; $$;

create trigger sales_period_lock before insert or update on public.sales
  for each row execute function public.guard_period('created_at', 'ts');
create trigger sale_returns_period_lock before insert or update on public.sale_returns
  for each row execute function public.guard_period('created_at', 'ts');
create trigger grns_period_lock before insert or update on public.grns
  for each row execute function public.guard_period('created_at', 'ts');
create trigger supplier_returns_period_lock before insert or update on public.supplier_returns
  for each row execute function public.guard_period('created_at', 'ts');
create trigger supplier_payments_period_lock before insert or update on public.supplier_payments
  for each row execute function public.guard_period('paid_on');
create trigger customer_payments_period_lock before insert or update on public.customer_payments
  for each row execute function public.guard_period('created_at', 'ts');
create trigger cash_movements_period_lock before insert or update on public.cash_movements
  for each row execute function public.guard_period('created_at', 'ts');
create trigger stock_movements_period_lock before insert or update on public.stock_movements
  for each row execute function public.guard_period('created_at', 'ts');
create trigger journal_entries_period_lock before insert or update on public.journal_entries
  for each row execute function public.guard_period('entry_date');
create trigger transfers_period_lock before insert or update on public.transfers
  for each row execute function public.guard_period('sent_at', 'ts');

/** Close a month, or open it again. Owner only, and both halves are logged. */
create or replace function public.lock_period(
  p_month date, p_locked boolean default true, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_month date := date_trunc('month', p_month)::date;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  -- Deliberately the owner alone, not a permission key. Closing the books is the one
  -- decision a shop cannot delegate and then disown.
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  if v_month > public.dhaka_today() then raise exception 'MONTH_NOT_FINISHED'; end if;

  if p_locked then
    insert into public.period_locks (shop_id, locked_month, note, locked_by)
    values (v_me.shop_id, v_month, p_note, v_me.id)
    on conflict (shop_id, locked_month)
      do update set note = excluded.note, locked_by = excluded.locked_by, locked_at = now();
  else
    if p_note is null or length(trim(p_note)) < 3 then raise exception 'REASON_REQUIRED'; end if;
    delete from public.period_locks where shop_id = v_me.shop_id and locked_month = v_month;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id,
          case when p_locked then 'period_locked' else 'period_unlocked' end, 'period',
          jsonb_build_object('month', v_month, 'note', p_note));

  return jsonb_build_object('month', v_month, 'locked', p_locked);
end; $$;

/** Which months are closed, newest first, and who closed them. */
create or replace function public.period_lock_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'month', l.locked_month, 'note', l.note, 'at', l.locked_at, 'who', s.name)
      order by l.locked_month desc), '[]'::jsonb)
    from public.period_locks l join public.staff s on s.id = l.locked_by
    where l.shop_id = v_me.shop_id);
end; $$;

-- ---------------------------------------------------------------------------
-- PART 3 — The datasets
-- ---------------------------------------------------------------------------
--
-- One view (or function, where a date has to go in) per kind of line a report can be
-- built from. Every report names one of these and the engine does the rest, so a new
-- report is configuration rather than SQL — and a column name that does not exist is
-- refused by name instead of quietly producing an empty page.
--
-- These views are NOT granted to anyone. Reports are read through report_run(), which
-- is security definer and checks the shop, the branch and the permission first. A view
-- a cashier could select from directly would hand them cost and profit.
--
-- Two names per product, as BMS has: "model" is the short caption staff recognise and
-- "product" is the full description. Reports use whichever BMS used.

-- Every sale line of a completed sale, with its share of the sale's discount.
create or replace view public.v_rep_sale_lines as
select
  s.shop_id, s.branch_id, b.name as branch, l.name as location,
  public.dhaka_date(s.created_at) as d,
  to_char(public.dhaka_date(s.created_at), 'YYYY-MM') as month,
  s.id as sale_id, s.invoice_no, s.payment_ref as ref_no,
  case s.payment_method when 'due' then 'Credit bill' when 'card' then 'Card bill'
       when 'cash' then 'Cash bill' else initcap(s.payment_method) || ' bill' end as bill_type,
  s.customer_id,
  coalesce(c.name_text, c.company, c.phone, 'Cash customer') as trader,
  coalesce(cg.name, 'Cash customer') as trader_group,
  st.name as entered_by, coalesce(sb.name, st.name) as sold_by, coalesce(sb.name, st.name) as rep,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  i.qty, i.unit_price,
  round(i.line_total * s.discount_pct / 100, 2) as discount,
  round(i.line_total * (100 - s.discount_pct) / 100, 2) as amount,
  case when i.qty > 0 then round(i.line_total * (100 - s.discount_pct) / 100 / i.qty, 2) end
    as net_unit_price,
  i.vat_amount as vat, 0::numeric(12,2) as ait, 0::numeric(12,2) as charges,
  sic.unit_cost,
  round(coalesce(sic.unit_cost, 0) * i.qty, 2) as cost,
  round(i.line_total * (100 - s.discount_pct) / 100 - coalesce(sic.unit_cost, 0) * i.qty, 2) as profit,
  -- Which delivery the units came out of (the FIFO layers). More than one is possible
  -- when a line spans two deliveries, so they are listed.
  (select string_agg(distinct sl2.doc_no, ', ')
   from public.sale_line_layers sll
   join public.stock_layers sl2 on sl2.id = sll.layer_id
   where sll.sale_item_id = i.id) as purchase_invoice,
  (select string_agg(se.serial, ', ' order by se.serial)
   from public.sale_item_serials sis join public.serials se on se.id = sis.serial_id
   where sis.sale_item_id = i.id) as serials,
  s.status
from public.sale_items i
join public.sales s on s.id = i.sale_id
join public.branches b on b.id = s.branch_id
join public.staff st on st.id = s.staff_id
left join public.staff sb on sb.id = s.sold_by
left join public.stock_locations l on l.branch_id = s.branch_id and l.is_default
left join public.customers c on c.id = s.customer_id
left join public.customer_groups cg on cg.id = c.group_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id
left join public.sale_item_costs sic on sic.sale_item_id = i.id
where s.status = 'completed' and s.approval_status = 'approved';

-- One row per invoice, for the registers that list bills rather than lines.
create or replace view public.v_rep_sale_docs as
select
  s.shop_id, s.branch_id, b.name as branch,
  public.dhaka_date(s.created_at) as d,
  to_char(public.dhaka_date(s.created_at), 'YYYY-MM') as month,
  s.id as sale_id, s.invoice_no, s.payment_ref as ref_no,
  case s.payment_method when 'due' then 'Credit bill' when 'card' then 'Card bill'
       when 'cash' then 'Cash bill' else initcap(s.payment_method) || ' bill' end as bill_type,
  s.customer_id,
  coalesce(c.name_text, c.company, c.phone, 'Cash customer') as trader,
  coalesce(cg.name, 'Cash customer') as trader_group,
  st.name as entered_by, coalesce(sb.name, st.name) as sold_by, coalesce(sb.name, st.name) as rep,
  (select coalesce(sum(i.qty), 0) from public.sale_items i where i.sale_id = s.id)::integer as qty,
  s.subtotal as total_amt, s.discount_amount as discount, s.charges_amount as charges,
  s.vat_amount as vat, 0::numeric(12,2) as ait, s.total as amount,
  s.due_amount, s.paid_amount,
  (select coalesce(sum(round(coalesce(sic.unit_cost, 0) * i.qty, 2)), 0)
   from public.sale_items i left join public.sale_item_costs sic on sic.sale_item_id = i.id
   where i.sale_id = s.id) as cost,
  s.total - s.vat_amount - s.charges_amount
    - (select coalesce(sum(round(coalesce(sic.unit_cost, 0) * i.qty, 2)), 0)
       from public.sale_items i left join public.sale_item_costs sic on sic.sale_item_id = i.id
       where i.sale_id = s.id) as profit,
  s.status
from public.sales s
join public.branches b on b.id = s.branch_id
join public.staff st on st.id = s.staff_id
left join public.staff sb on sb.id = s.sold_by
left join public.customers c on c.id = s.customer_id
left join public.customer_groups cg on cg.id = c.group_id
where s.status = 'completed' and s.approval_status = 'approved';

-- Returns, line by line. The amount is what actually went back (P9's share-of-the-
-- discount rule), not the shelf price.
create or replace view public.v_rep_return_lines as
select
  r.shop_id, r.branch_id, b.name as branch,
  public.dhaka_date(r.created_at) as d,
  to_char(public.dhaka_date(r.created_at), 'YYYY-MM') as month,
  r.return_no, s.invoice_no, r.reason, r.refund_method,
  coalesce(c.name_text, c.company, c.phone, 'Cash customer') as trader,
  coalesce(cg.name, 'Cash customer') as trader_group,
  ri.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  ri.qty, ri.refund_amount as amount,
  case when ri.qty > 0 then round(ri.refund_amount / ri.qty, 2) end as unit_price,
  ri.is_faulty,
  round(coalesce(sic.unit_cost, 0) * ri.qty, 2) as cost
from public.sale_return_items ri
join public.sale_returns r on r.id = ri.return_id
join public.branches b on b.id = r.branch_id
join public.sales s on s.id = r.sale_id
left join public.customers c on c.id = r.customer_id
left join public.customer_groups cg on cg.id = c.group_id
join public.products p on p.id = ri.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id
left join public.sale_item_costs sic on sic.sale_item_id = ri.sale_item_id
where r.approval_status <> 'cancelled';

-- Sold, returned, and what that leaves. Returns belong next to the sales they undo:
-- a product list that shows only the sales says the shop sold things it took back.
create or replace view public.v_rep_net_sales as
select shop_id, branch_id, branch, d, month, trader, trader_group, rep,
       product_id, code, model, product, category, brand, uom,
       sum(sale_qty)::integer as sale_qty, sum(sale_amount) as sale_amount,
       sum(discount) as discount,
       sum(return_qty)::integer as return_qty, sum(return_amount) as return_amount,
       sum(sale_qty - return_qty)::integer as net_qty,
       sum(sale_amount - return_amount) as net_amount,
       case when sum(sale_qty) > 0 then round(sum(sale_amount) / sum(sale_qty), 2) end as unit_price,
       sum(cost) as cost, sum(profit) as profit
from (
  select shop_id, branch_id, branch, d, month, trader, trader_group, rep,
         product_id, code, model, product, category, brand, uom,
         qty as sale_qty, amount as sale_amount, discount,
         0 as return_qty, 0::numeric as return_amount, cost, profit
  from public.v_rep_sale_lines
  union all
  select shop_id, branch_id, branch, d, month, trader, trader_group, 'N/A' as rep,
         product_id, code, model, product, category, brand, uom,
         0, 0::numeric, 0::numeric, qty, amount, -cost, -amount + cost
  from public.v_rep_return_lines
) q
group by shop_id, branch_id, branch, d, month, trader, trader_group, rep,
         product_id, code, model, product, category, brand, uom;

-- Deliveries, line by line. "amount" is the line as invoiced; the landed cost (the
-- line plus its share of the transport) is what the average cost used.
create or replace view public.v_rep_purchase_lines as
select
  g.shop_id, g.branch_id, b.name as branch, l.name as location,
  public.dhaka_date(g.created_at) as d,
  coalesce(g.invoice_date, public.dhaka_date(g.created_at)) as invoice_date,
  to_char(public.dhaka_date(g.created_at), 'YYYY-MM') as month,
  g.id as grn_id, g.grn_no as invoice_no, g.supplier_invoice_no as ref_no,
  case when g.is_credit then 'Credit purchase' else 'Cash purchase' end as bill_type,
  g.supplier_id, coalesce(sp.name, 'Cash supplier') as supplier,
  coalesce(sg.name, 'N/A') as supplier_group,
  st.name as entered_by,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  i.qty, i.unit_cost, coalesce(i.landed_cost, i.unit_cost) as landed_cost,
  i.line_total as amount, g.cost_missing
from public.grn_items i
join public.grns g on g.id = i.grn_id
join public.branches b on b.id = g.branch_id
join public.stock_locations l on l.id = g.location_id
join public.staff st on st.id = g.staff_id
left join public.suppliers sp on sp.id = g.supplier_id
left join public.supplier_groups sg on sg.id = sp.group_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id;

-- One row per delivery document, with the figures off its invoice.
create or replace view public.v_rep_purchase_docs as
select
  g.shop_id, g.branch_id, b.name as branch,
  public.dhaka_date(g.created_at) as d,
  to_char(public.dhaka_date(g.created_at), 'YYYY-MM') as month,
  g.grn_no as invoice_no, g.supplier_invoice_no as ref_no,
  case when g.is_credit then 'Credit purchase' else 'Cash purchase' end as bill_type,
  g.supplier_id, coalesce(sp.name, 'Cash supplier') as supplier,
  coalesce(sg.name, 'N/A') as supplier_group, st.name as entered_by,
  (select coalesce(sum(i.qty), 0) from public.grn_items i where i.grn_id = g.id)::integer as qty,
  g.subtotal as total_amt, g.discount, g.charges, g.vat, g.ait, g.total as amount
from public.grns g
join public.branches b on b.id = g.branch_id
join public.staff st on st.id = g.staff_id
left join public.suppliers sp on sp.id = g.supplier_id
left join public.supplier_groups sg on sg.id = sp.group_id;

create or replace view public.v_rep_supplier_return_lines as
select
  r.shop_id, r.branch_id, b.name as branch,
  public.dhaka_date(r.created_at) as d,
  to_char(public.dhaka_date(r.created_at), 'YYYY-MM') as month,
  r.return_no as invoice_no, r.reason,
  r.supplier_id, coalesce(sp.name, 'Cash supplier') as supplier,
  coalesce(sg.name, 'N/A') as supplier_group,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  i.qty, i.unit_cost, i.line_total as amount
from public.supplier_return_items i
join public.supplier_returns r on r.id = i.return_id
join public.branches b on b.id = r.branch_id
left join public.suppliers sp on sp.id = r.supplier_id
left join public.supplier_groups sg on sg.id = sp.group_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id;

-- Bought, returned, net — per product, per branch, per day.
create or replace view public.v_rep_net_purchase as
select shop_id, branch_id, branch, location, d, month,
       product_id, code, model, product, category, brand, uom,
       sum(purchase_qty)::integer as purchase_qty, sum(purchase_amount) as purchase_amount,
       sum(return_qty)::integer as return_qty, sum(return_amount) as return_amount,
       sum(purchase_qty - return_qty)::integer as net_qty,
       sum(purchase_amount - return_amount) as net_amount,
       case when sum(purchase_qty) > 0
            then round(sum(purchase_amount) / sum(purchase_qty), 2) end as unit_cost
from (
  select shop_id, branch_id, branch, location, d, month, product_id, code, model, product,
         category, brand, uom, qty as purchase_qty, amount as purchase_amount,
         0 as return_qty, 0::numeric as return_amount
  from public.v_rep_purchase_lines
  union all
  select shop_id, branch_id, branch, 'N/A' as location, d, month, product_id, code, model,
         product, category, brand, uom, 0, 0::numeric, qty, amount
  from public.v_rep_supplier_return_lines
) q
group by shop_id, branch_id, branch, location, d, month, product_id, code, model, product,
         category, brand, uom;

-- Requests for stock, with two kinds of "pending": not yet on an order, and on an
-- order but not yet delivered. BMS has a report for each and the difference matters —
-- the first is waiting on the office, the second on the supplier.
create or replace view public.v_rep_requisition_lines as
select
  r.shop_id, r.branch_id, b.name as branch,
  public.dhaka_date(r.created_at) as d,
  to_char(public.dhaka_date(r.created_at), 'YYYY-MM') as month,
  r.req_no, r.status, r.needed_by, st.name as entered_by,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  i.qty,
  case when exists (select 1 from public.purchase_order_items oi where oi.req_item_id = i.id)
       then 0 else i.qty end as pending_po_qty,
  greatest(i.qty - coalesce((select sum(oi.received_qty) from public.purchase_order_items oi
                             where oi.req_item_id = i.id), 0), 0)::integer as pending_qty
from public.requisition_items i
join public.requisitions r on r.id = i.req_id
join public.branches b on b.id = r.branch_id
join public.staff st on st.id = r.staff_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id
where r.status not in ('cancelled', 'rejected');

create or replace view public.v_rep_po_lines as
select
  o.shop_id, o.branch_id, b.name as branch,
  public.dhaka_date(o.created_at) as d,
  to_char(public.dhaka_date(o.created_at), 'YYYY-MM') as month,
  o.po_no as order_no, o.status, st.name as entered_by,
  o.supplier_id, sp.name as supplier, coalesce(sg.name, 'N/A') as supplier_group,
  (select string_agg(distinct rq.req_no, ', ')
   from public.requisition_items ri
   join public.requisitions rq on rq.id = ri.req_id
   where ri.id = i.req_item_id) as req_no,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  i.qty, i.received_qty,
  greatest(i.qty - i.received_qty, 0) as pending_qty,
  i.unit_price, round(i.qty * i.unit_price - i.line_discount, 2) as amount
from public.purchase_order_items i
join public.purchase_orders o on o.id = i.po_id
join public.branches b on b.id = o.branch_id
join public.staff st on st.id = o.staff_id
join public.suppliers sp on sp.id = o.supplier_id
left join public.supplier_groups sg on sg.id = sp.group_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id
where o.status not in ('cancelled', 'draft');

-- A delivery cost changed after the goods arrived: BMS's "purchase amendment", and the
-- answer to its open question about "rebate" — a supplier knocking money off after the
-- fact is a cost correction, so it is reported from the change itself.
create or replace view public.v_rep_amendments as
select
  a.shop_id, g.branch_id, b.name as branch,
  public.dhaka_date(a.created_at) as d,
  to_char(public.dhaka_date(a.created_at), 'YYYY-MM') as month,
  g.grn_no as invoice_no, coalesce(sp.name, 'Cash supplier') as supplier,
  st.name as who,
  p.id as product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce((a.details->>'qty')::integer, 0) as qty,
  round(coalesce((a.details->>'from')::numeric, 0)
        - coalesce((a.details->>'to')::numeric, 0), 2) as rebate,
  round(coalesce((a.details->>'to')::numeric, 0)
        * coalesce((a.details->>'qty')::numeric, 0), 2) as amount
from public.audit_log a
join public.grns g on g.id = a.entity_id
join public.branches b on b.id = g.branch_id
join public.staff st on st.id = a.staff_id
left join public.suppliers sp on sp.id = g.supplier_id
left join public.products p on p.id = (a.details->>'product_id')::uuid
left join public.categories cat on cat.id = p.category_id
where a.action = 'grn_cost_amended';

/**
 * Stock as it stood on a date, per branch and per place.
 *
 * "Current stock" is this with today's date. BMS keeps two separate reports and they
 * disagree by four units; here there is one answer, so the stock report, the valuation
 * and the inventory account cannot drift apart.
 *
 * Quantity comes from the movements rather than from branch_stock, because branch_stock
 * only knows about now. Today's figure is identical either way, and there is a check
 * that it is.
 */
create or replace function public.rep_stock_as_on(p_as_on date default null)
returns table (
  shop_id uuid, branch_id uuid, branch text, location text, location_id uuid,
  product_id uuid, code text, model text, product text, category text, brand text,
  uom text, qty bigint, unit_cost numeric, total_cost numeric,
  reorder_level integer, last_sold date, days_since_sale integer
)
language plpgsql stable security definer set search_path = public as $$
declare v_on date := coalesce(p_as_on, public.dhaka_today());
begin
  return query
  with moves as (
    select m.shop_id, m.branch_id, m.location_id, m.product_id, sum(m.qty_change) as qty
    from public.stock_movements m
    where m.branch_id is not null and public.dhaka_date(m.created_at) <= v_on
    group by m.shop_id, m.branch_id, m.location_id, m.product_id
  ), sold as (
    select si.product_id, max(public.dhaka_date(sa.created_at)) as last_sold
    from public.sale_items si join public.sales sa on sa.id = si.sale_id
    where sa.status = 'completed' and public.dhaka_date(sa.created_at) <= v_on
    group by si.product_id
  )
  select mv.shop_id, mv.branch_id, b.name, coalesce(l.name, 'Main store'), mv.location_id,
         p.id, p.code, coalesce(p.model, p.code), p.name,
         coalesce(cat.name, 'N/A'), coalesce(p.brand, 'N/A'), coalesce(u.name, 'PCS'),
         mv.qty, pc.cost, round(coalesce(pc.cost, 0) * mv.qty, 2),
         p.reorder_level, sd.last_sold, (v_on - sd.last_sold)::integer
  from moves mv
  join public.branches b on b.id = mv.branch_id
  left join public.stock_locations l on l.id = mv.location_id
  join public.products p on p.id = mv.product_id
  left join public.categories cat on cat.id = p.category_id
  left join public.units u on u.id = p.unit_id
  left join public.product_costs pc on pc.product_id = p.id
  left join sold sd on sd.product_id = p.id
  where mv.qty <> 0;
end; $$;

/**
 * On the shelf and not selling, for a period.
 *
 * BMS lists every product it has ever heard of, including 1,636 it does not stock —
 * 39 pages of paper nobody reads. The useful question is which of the things the shop
 * has PAID FOR are not moving, so this starts from stock on hand.
 */
create or replace function public.rep_dusty(p_from date default null, p_to date default null)
returns table (
  shop_id uuid, branch_id uuid, branch text, product_id uuid, code text, model text,
  product text, category text, brand text, uom text, qty bigint,
  stock_value numeric, days_since_sale integer
)
language sql stable security definer set search_path = public as $$
  select s.shop_id, s.branch_id, s.branch, s.product_id, s.code, s.model, s.product,
         s.category, s.brand, s.uom, s.qty, s.total_cost,
         coalesce(s.days_since_sale, 9999)
  from public.rep_stock_as_on(coalesce(p_to, public.dhaka_today())) s
  where s.qty > 0
    and not exists (
      select 1 from public.sale_items si
      join public.sales sa on sa.id = si.sale_id
      where si.product_id = s.product_id and sa.status = 'completed'
        and sa.branch_id = s.branch_id
        and public.dhaka_date(sa.created_at)
            between coalesce(p_from, '1900-01-01'::date) and coalesce(p_to, public.dhaka_today()));
$$;

/**
 * How long each delivery still on the shelf has been there.
 *
 * The quantity left is as it stands now — a layer does not remember what it held three
 * weeks ago — so an "as on" date here filters which deliveries to show and sets the
 * date the age is counted to. The note on the report says so.
 */
create or replace function public.rep_layers(p_as_on date default null)
returns table (
  shop_id uuid, branch_id uuid, branch text, product_id uuid, code text, model text,
  product text, category text, brand text, invoice_no text, supplier text,
  d date, qty integer, unit_cost numeric, amount numeric,
  age_days integer, age_bucket text
)
language plpgsql stable security definer set search_path = public as $$
declare v_on date := coalesce(p_as_on, public.dhaka_today());
begin
  return query
  select l.shop_id, l.branch_id, b.name, p.id, p.code, coalesce(p.model, p.code), p.name,
         coalesce(cat.name, 'N/A'), coalesce(p.brand, 'N/A'),
         coalesce(l.doc_no, initcap(replace(l.source_kind, '_', ' '))),
         coalesce(sp.name, '—'),
         l.received_on, l.remaining, l.unit_cost,
         round(coalesce(l.unit_cost, 0) * l.remaining, 2),
         (v_on - l.received_on)::integer,
         case
           when v_on - l.received_on <= 30  then '0 to 30 days'
           when v_on - l.received_on <= 60  then '31 to 60 days'
           when v_on - l.received_on <= 90  then '61 to 90 days'
           when v_on - l.received_on <= 180 then '91 to 180 days'
           else 'Over 180 days' end
  from public.stock_layers l
  join public.branches b on b.id = l.branch_id
  join public.products p on p.id = l.product_id
  left join public.categories cat on cat.id = p.category_id
  left join public.suppliers sp on sp.id = l.supplier_id
  where l.remaining > 0 and l.received_on <= v_on;
end; $$;

-- Every serial the shop is holding, with the delivery it arrived on.
create or replace view public.v_rep_serial_stock as
select
  se.shop_id, se.product_id,
  coalesce(se.location_id, (select id from public.stock_locations
                            where branch_id = g.branch_id and is_default)) as location_id,
  coalesce(g.branch_id, (select branch_id from public.stock_locations
                         where id = se.location_id)) as branch_id,
  coalesce(b.name, (select b2.name from public.stock_locations l2
                    join public.branches b2 on b2.id = l2.branch_id
                    where l2.id = se.location_id)) as branch,
  se.serial, se.status,
  coalesce(g.grn_no, 'Opening stock') as invoice_no,
  coalesce(sp.name, '—') as supplier,
  coalesce(g.invoice_date, public.dhaka_date(se.received_at)) as d,
  (public.dhaka_today() - coalesce(g.invoice_date, public.dhaka_date(se.received_at)))::integer
    as age_days,
  se.unit_cost, 1 as one,
  p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand
from public.serials se
left join public.grns g on g.id = se.grn_id
left join public.branches b on b.id = g.branch_id
left join public.suppliers sp on sp.id = g.supplier_id
join public.products p on p.id = se.product_id
left join public.categories cat on cat.id = p.category_id
where se.status = 'in_stock';

-- Transfers out, from the sending branch's side.
create or replace view public.v_rep_transfers_out as
select
  t.shop_id, t.from_branch_id as branch_id, fb.name as branch, tb.name as to_branch,
  public.dhaka_date(t.sent_at) as d,
  to_char(public.dhaka_date(t.sent_at), 'YYYY-MM') as month,
  t.transfer_no, t.status, fl.name as location, tl.name as to_location,
  public.dhaka_date(t.received_at) as received_on,
  st.name as entered_by,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  i.qty, i.received_qty, i.damaged_qty, i.unit_cost,
  round(coalesce(i.unit_cost, 0) * i.qty, 2) as amount
from public.transfer_items i
join public.transfers t on t.id = i.transfer_id
join public.branches fb on fb.id = t.from_branch_id
join public.branches tb on tb.id = t.to_branch_id
join public.stock_locations fl on fl.id = t.from_location_id
join public.stock_locations tl on tl.id = t.to_location_id
join public.staff st on st.id = t.sent_by
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id
where t.status <> 'cancelled';

-- The same transfers from the receiving branch's side, and only what actually arrived.
create or replace view public.v_rep_transfers_in as
select
  t.shop_id, t.to_branch_id as branch_id, tb.name as branch, fb.name as from_branch,
  public.dhaka_date(t.received_at) as d,
  to_char(public.dhaka_date(t.received_at), 'YYYY-MM') as month,
  t.transfer_no, t.status, public.dhaka_date(t.sent_at) as sent_on,
  tl.name as location,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  coalesce(u.name, 'PCS') as uom,
  i.received_qty as qty, i.damaged_qty, i.unit_cost,
  round(coalesce(i.unit_cost, 0) * i.received_qty, 2) as amount
from public.transfer_items i
join public.transfers t on t.id = i.transfer_id
join public.branches fb on fb.id = t.from_branch_id
join public.branches tb on tb.id = t.to_branch_id
join public.stock_locations tl on tl.id = t.to_location_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
left join public.units u on u.id = p.unit_id
where t.received_at is not null and i.received_qty > 0;

-- Moves between places inside one branch. The two legs are written in one statement,
-- so they share a timestamp: that is what pairs them.
create or replace view public.v_rep_inhouse as
select
  i.shop_id, i.branch_id, b.name as branch,
  public.dhaka_date(i.created_at) as d,
  to_char(public.dhaka_date(i.created_at), 'YYYY-MM') as month,
  coalesce(i.note, 'Moved inside the branch') as doc_no,
  fl.name as from_location, tl.name as to_location,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
  i.qty_change as qty, st.name as entered_by
from public.stock_movements i
join public.stock_movements o
  on o.shop_id = i.shop_id and o.product_id = i.product_id
 and o.created_at = i.created_at and o.reason = 'transfer_out'
 and o.branch_id = i.branch_id
join public.branches b on b.id = i.branch_id
join public.stock_locations tl on tl.id = i.location_id
join public.stock_locations fl on fl.id = o.location_id
join public.staff st on st.id = i.staff_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
where i.reason = 'transfer_in' and i.ref_id is null and i.qty_change > 0;

-- Sent and not arrived. BMS has no such report, which is why nobody chases a transfer
-- until a branch notices the stock missing.
create or replace view public.v_rep_in_transit as
select
  t.shop_id, t.from_branch_id as branch_id, fb.name as branch, tb.name as to_branch,
  t.transfer_no,
  public.dhaka_date(t.sent_at) as d,
  (public.dhaka_today() - public.dhaka_date(t.sent_at))::integer as days_out,
  case t.status when 'in_transit' then 'On the road'
                when 'disputed' then 'Short on arrival — needs settling'
                else initcap(t.status) end as status,
  i.product_id, p.code, coalesce(p.model, p.code) as model, p.name as product,
  coalesce(cat.name, 'N/A') as category,
  i.qty - i.received_qty as qty,
  round(coalesce(i.unit_cost, 0) * (i.qty - i.received_qty), 2) as amount
from public.transfer_items i
join public.transfers t on t.id = i.transfer_id
join public.branches fb on fb.id = t.from_branch_id
join public.branches tb on tb.id = t.to_branch_id
join public.products p on p.id = i.product_id
left join public.categories cat on cat.id = p.category_id
where t.status in ('in_transit', 'disputed') and i.qty > i.received_qty;

-- Every journal line, which is what the voucher registers and the ledgers are made of.
create or replace view public.v_rep_journal as
select
  e.shop_id, e.branch_id, b.name as branch,
  e.entry_date as d, to_char(e.entry_date, 'YYYY-MM') as month,
  e.id as entry_id, e.entry_no, e.narration, e.source_kind, e.source_id, e.status,
  st.name as entered_by,
  a.id as account_id, a.code as account_code, a.name as account, a.role as account_role,
  g.name as account_group, g.nature,
  l.debit, l.credit, l.note, l.customer_id, l.supplier_id, l.bank_account_id,
  coalesce(c.name_text, c.company, c.phone, s.name,
           (select ba.name from public.bank_accounts ba where ba.id = l.bank_account_id)) as party,
  ch.cheque_no, ch.cheque_date,
  coalesce(ch.drawn_on, (select ba.name || coalesce(' — ' || ba.account_no, '')
                         from public.bank_accounts ba where ba.id = a.bank_account_id)) as bank,
  coalesce(ch.cheque_no, e.entry_no) as ref_no,
  case when ch.id is not null then 'Cheque'
       when a.role = 'cash_in_hand' then 'Cash' else 'Transfer' end as mode,
  -- Which kind of voucher somebody typed. Worked out from the entry rather than stored,
  -- so the auto-posted entries can be told apart from the handful a person types.
  case when e.source_kind <> 'voucher' then 'auto'
       when (select count(*) filter (where a2.role in ('cash_in_hand', 'bank', 'wallet'))
             from public.journal_lines l2 join public.accounts a2 on a2.id = l2.account_id
             where l2.entry_id = e.id) = 2 then 'contra'
       when exists (select 1 from public.journal_lines l2 join public.accounts a2 on a2.id = l2.account_id
                    where l2.entry_id = e.id and l2.debit > 0
                      and a2.role in ('cash_in_hand', 'bank', 'wallet')) then 'receipt'
       when exists (select 1 from public.journal_lines l2 join public.accounts a2 on a2.id = l2.account_id
                    where l2.entry_id = e.id and l2.credit > 0
                      and a2.role in ('cash_in_hand', 'bank', 'wallet')) then 'payment'
       else 'journal' end as voucher_type
from public.journal_lines l
join public.journal_entries e on e.id = l.entry_id
join public.branches b on b.id = e.branch_id
join public.staff st on st.id = e.staff_id
join public.accounts a on a.id = l.account_id
join public.account_groups g on g.id = a.group_id
left join public.customers c on c.id = l.customer_id
left join public.suppliers s on s.id = l.supplier_id
left join public.cheques ch on ch.entry_id = e.id
where e.status = 'posted';

-- The voucher registers read the journal; income and expenses read one nature of it.
create or replace view public.v_rep_vouchers as select * from public.v_rep_journal;

create or replace view public.v_rep_income_lines as
select shop_id, branch_id, branch, d, month, entry_no, narration, account, account_code,
       party, credit - debit as amount
from public.v_rep_journal where nature = 'income';

create or replace view public.v_rep_expense_lines as
select shop_id, branch_id, branch, d, month, entry_no, narration, account, account_code,
       party, debit - credit as amount
from public.v_rep_journal where nature = 'expense';

create or replace view public.v_rep_cheques as
select
  c.shop_id, c.branch_id, b.name as branch,
  c.cheque_date as d, to_char(c.cheque_date, 'YYYY-MM') as month,
  c.cheque_no,
  case c.direction when 'issued' then 'We wrote it' else 'Somebody gave us one' end as direction,
  case c.status when 'issued' then 'Not settled yet' else initcap(c.status) end as status,
  coalesce(c.payee, cu.name_text, cu.company, cu.phone, sp.name, '—') as party,
  coalesce(c.drawn_on, ba.name) as bank,
  c.amount, public.dhaka_date(c.cleared_at) as settled_on, c.bounced_reason,
  st.name as entered_by
from public.cheques c
join public.branches b on b.id = c.branch_id
join public.staff st on st.id = c.staff_id
left join public.customers cu on cu.id = c.customer_id
left join public.suppliers sp on sp.id = c.supplier_id
left join public.bank_accounts ba on ba.id = c.bank_account_id;

-- The audit log as a report: BMS's Modification Register.
create or replace view public.v_rep_audit as
select
  a.shop_id, a.branch_id, coalesce(b.name, 'Whole shop') as branch,
  public.dhaka_date(a.created_at) as d,
  to_char(a.created_at at time zone 'Asia/Dhaka', 'HH24:MI') as at,
  to_char(public.dhaka_date(a.created_at), 'YYYY-MM') as month,
  initcap(replace(a.action, '_', ' ')) as action,
  coalesce(s.name, 'System') as who,
  coalesce(a.entity, '—') as entity,
  left(coalesce(a.details::text, ''), 300) as details
from public.audit_log a
left join public.staff s on s.id = a.staff_id
left join public.branches b on b.id = a.branch_id;

-- Warranty claims: BMS's RMA Service Register.
create or replace view public.v_rep_claims as
select
  cl.shop_id, cl.branch_id, b.name as branch,
  public.dhaka_date(cl.created_at) as d,
  to_char(public.dhaka_date(cl.created_at), 'YYYY-MM') as month,
  cl.claim_no,
  case cl.status when 'received' then 'Taken in' when 'diagnosed' then 'Looked at'
       when 'with_supplier' then 'With the supplier' when 'back_from_supplier' then 'Back'
       when 'repaired' then 'Repaired' when 'ready' then 'Ready'
       when 'delivered' then 'Given back' else 'Turned down' end as status,
  coalesce(c.name_text, c.company, cl.customer_name, cl.customer_phone, '—') as trader,
  coalesce(p.name, cl.item_text, '—') as product,
  coalesce(se.serial, '—') as serial,
  coalesce(pt.name, cl.problem) as fault, cl.problem,
  coalesce(t.name, '—') as technician,
  coalesce(sp.name, '—') as supplier,
  cl.in_warranty, cl.warranty_until,
  (coalesce(public.dhaka_date(cl.delivered_at), public.dhaka_today())
   - public.dhaka_date(cl.created_at))::integer as days_open
from public.warranty_claims cl
join public.branches b on b.id = cl.branch_id
left join public.customers c on c.id = cl.customer_id
left join public.products p on p.id = cl.product_id
left join public.serials se on se.id = cl.serial_id
left join public.problem_types pt on pt.id = cl.problem_type_id
left join public.technicians t on t.id = cl.technician_id
left join public.suppliers sp on sp.id = cl.supplier_id
where cl.approval_status <> 'cancelled';

-- What the shop is holding that is not its own stock: BMS's RMA Stock Register. An item
-- in for repair is neither stock nor the customer's, and that is exactly why it needs
-- its own report — otherwise it is invisible until somebody asks where it went.
create or replace view public.v_rep_rma_stock as
select
  cl.shop_id, cl.branch_id, b.name as branch,
  case cl.status when 'with_supplier' then 'Out with the supplier'
                 else 'Here, in for repair' end as where_is,
  case cl.status when 'with_supplier' then 'Out with the supplier'
                 else 'Here, in for repair' end as "where",
  coalesce(p.name, cl.item_text, '—') as product,
  coalesce(p.code, '—') as code,
  coalesce(se.serial, '—') as serial,
  cl.claim_no, coalesce(sp.name, '—') as supplier,
  public.dhaka_date(coalesce(cl.sent_at, cl.created_at)) as d,
  (public.dhaka_today() - public.dhaka_date(coalesce(cl.sent_at, cl.created_at)))::integer as days_out,
  coalesce(se.unit_cost, pc.cost) as unit_cost,
  coalesce(cat.name, 'N/A') as category
from public.warranty_claims cl
join public.branches b on b.id = cl.branch_id
left join public.products p on p.id = cl.product_id
left join public.categories cat on cat.id = p.category_id
left join public.product_costs pc on pc.product_id = cl.product_id
left join public.serials se on se.id = cl.serial_id
left join public.suppliers sp on sp.id = cl.supplier_id
where cl.status in ('received', 'diagnosed', 'with_supplier', 'back_from_supplier', 'repaired', 'ready')
  and cl.approval_status <> 'cancelled';

-- Customers and suppliers in one list. A trader in this market is often both: the shop
-- next door buys a cable in the morning and sells us a router in the afternoon.
create or replace view public.v_rep_traders as
select c.shop_id, 'customer' as kind, coalesce(cg.name, 'Retail') as trader_group,
       c.phone as code, coalesce(c.name_text, c.company, c.phone) as name,
       coalesce(c.address, '—') as address, c.phone as mobile,
       coalesce(c.company, '—') as company,
       coalesce((select ob.amount from public.opening_balances ob where ob.customer_id = c.id), 0) as opening,
       c.active
from public.customers c
left join public.customer_groups cg on cg.id = c.group_id
union all
select s.shop_id, 'supplier', coalesce(sg.name, 'N/A'),
       coalesce(s.phone, '—'), s.name, coalesce(s.address, '—'), coalesce(s.phone, '—'),
       '—',
       coalesce((select ob.amount from public.opening_balances ob where ob.supplier_id = s.id), 0),
       s.active
from public.suppliers s
left join public.supplier_groups sg on sg.id = s.group_id;

-- ---------------------------------------------------------------------------
-- PART 4 — The engine
-- ---------------------------------------------------------------------------

/**
 * Which datasets exist, and what they are called from SQL.
 *
 * `cols` is the whitelist: the engine builds its query from the report's configuration,
 * and a field name that is not in here is refused BY NAME. Nothing a browser sends
 * reaches the query — the configuration is seeded, not posted.
 *
 * The four *_field columns say what "the amount", "the quantity", "the cost" and "the
 * profit" are called in THIS dataset, so a column that has to be recomputed at every
 * subtotal (an average price, a profit percentage) does not need the dataset's column
 * names repeated in every report that uses it.
 */
create table public.rep_datasets (
  dataset      text primary key,
  source       text not null,
  -- Which filter values go into the source, in order, when it is a function.
  params       text[] not null default '{}',
  -- The column a date range or an "as on" date filters on, if any.
  date_field   text,
  cols         text[] not null default '{}',
  amount_field text,
  qty_field    text,
  cost_field   text,
  profit_field text
);

insert into public.rep_datasets (dataset, source, params, date_field, amount_field, qty_field, cost_field, profit_field) values
  ('sale_lines',            'public.v_rep_sale_lines',            '{}',            'd', 'amount', 'qty', 'cost', 'profit'),
  ('sale_docs',             'public.v_rep_sale_docs',             '{}',            'd', 'amount', 'qty', 'cost', 'profit'),
  ('return_lines',          'public.v_rep_return_lines',          '{}',            'd', 'amount', 'qty', 'cost', null),
  ('net_sales',             'public.v_rep_net_sales',             '{}',            'd', 'sale_amount', 'sale_qty', 'cost', 'profit'),
  ('purchase_lines',        'public.v_rep_purchase_lines',        '{}',            'd', 'amount', 'qty', 'amount', null),
  ('purchase_docs',         'public.v_rep_purchase_docs',         '{}',            'd', 'amount', 'qty', 'amount', null),
  ('supplier_return_lines', 'public.v_rep_supplier_return_lines', '{}',            'd', 'amount', 'qty', 'amount', null),
  ('net_purchase',          'public.v_rep_net_purchase',          '{}',            'd', 'purchase_amount', 'purchase_qty', 'purchase_amount', null),
  ('requisition_lines',     'public.v_rep_requisition_lines',     '{}',            'd', null, 'qty', null, null),
  ('po_lines',              'public.v_rep_po_lines',              '{}',            'd', 'amount', 'qty', null, null),
  ('amendments',            'public.v_rep_amendments',            '{}',            'd', 'amount', 'qty', 'amount', null),
  ('stock_as_on',           'public.rep_stock_as_on(%s)',         '{as_on}',       null, 'total_cost', 'qty', 'total_cost', null),
  ('dusty',                 'public.rep_dusty(%s, %s)',           '{from,to}',     null, 'stock_value', 'qty', 'stock_value', null),
  ('layers',                'public.rep_layers(%s)',              '{as_on}',       null, 'amount', 'qty', 'amount', null),
  ('serial_stock',          'public.v_rep_serial_stock',          '{}',            null, 'unit_cost', 'one', 'unit_cost', null),
  ('transfers_out',         'public.v_rep_transfers_out',         '{}',            'd', 'amount', 'qty', 'amount', null),
  ('transfers_in',          'public.v_rep_transfers_in',          '{}',            'd', 'amount', 'qty', 'amount', null),
  ('inhouse',               'public.v_rep_inhouse',               '{}',            'd', null, 'qty', null, null),
  ('in_transit',            'public.v_rep_in_transit',            '{}',            null, 'amount', 'qty', 'amount', null),
  ('journal',               'public.v_rep_journal',               '{}',            'd', 'debit', null, null, null),
  ('vouchers',              'public.v_rep_vouchers',              '{}',            'd', 'debit', null, null, null),
  ('income_lines',          'public.v_rep_income_lines',          '{}',            'd', 'amount', null, null, null),
  ('expense_lines',         'public.v_rep_expense_lines',         '{}',            'd', 'amount', null, null, null),
  ('cheques',               'public.v_rep_cheques',               '{}',            'd', 'amount', null, null, null),
  ('audit',                 'public.v_rep_audit',                 '{}',            'd', null, null, null, null),
  ('claims',                'public.v_rep_claims',                '{}',            'd', null, null, null, null),
  ('rma_stock',             'public.v_rep_rma_stock',             '{}',            null, 'unit_cost', null, 'unit_cost', null),
  ('traders',               'public.v_rep_traders',               '{}',            null, 'opening', null, null, null);

-- Fill the whitelist from the database itself, so it cannot fall out of step with the
-- views. A hand-typed list would be one more thing to forget.
do $$
declare r record; v_name text; v_cols text[];
begin
  for r in select * from public.rep_datasets loop
    if position('(' in r.source) > 0 then
      v_name := split_part(split_part(r.source, '(', 1), '.', 2);
      select array_agg(q.name::text) into v_cols from (
        select unnest(p.proargnames) as name, unnest(p.proargmodes) as mode
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where p.proname = v_name and n.nspname = 'public'
      ) q where q.mode = 't';
    else
      select array_agg(a.attname::text) into v_cols from pg_attribute a
      where a.attrelid = r.source::regclass and a.attnum > 0 and not a.attisdropped;
    end if;
    if v_cols is null then raise exception 'NO COLUMNS FOUND FOR DATASET %', r.dataset; end if;
    update public.rep_datasets set cols = v_cols where dataset = r.dataset;
  end loop;
end $$;

/** The catalogue. Seeded from src/lib/reports.ts by scripts/gen-reports.mts. */
create table public.report_defs (
  key          text primary key,
  register     text not null check (register in ('sales', 'purchase', 'stock', 'accounts',
                                                 'transfer', 'other')),
  sl           integer not null,
  title        text not null,
  note         text,
  dataset      text references public.rep_datasets(dataset),
  group_by     text[] not null default '{}',
  columns      jsonb not null default '[]'::jsonb,
  pivot        jsonb,
  special      text,
  date_mode    text not null default 'range' check (date_mode in ('range', 'as_on', 'none')),
  needs_cost   boolean not null default false,
  needs        text,
  landscape    boolean not null default false,
  sort_desc    text,
  top_default  integer,
  fixed_filter jsonb
);

/**
 * The owner's own titles and ordering (BMS's "Report Sort" and "Customising Report
 * Caption"). Per shop, so renaming "Trader" to "Customer" in one shop changes nothing
 * for another.
 */
create table public.report_settings (
  shop_id   uuid not null references public.shops(id) on delete cascade,
  key       text not null references public.report_defs(key) on delete cascade,
  title     text,
  sl        integer,
  -- { "<field>": "<what the heading should say>" }
  captions  jsonb,
  sort_by   text,
  updated_at timestamptz not null default now(),
  primary key (shop_id, key)
);

/** What the report is called here, after the owner has had their say. */
create or replace function public.rep_title(p_def public.report_defs, p_shop_id uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(trim(s.title), '') from public.report_settings s
                   where s.shop_id = p_shop_id and s.key = p_def.key), p_def.title);
$$;

/** The columns, with the shop's own headings applied. */
create or replace function public.rep_columns(p_def public.report_defs, p_shop_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(
    case when caps.caption is null then c
         else c || jsonb_build_object('l', caps.caption) end
    order by c.ord), '[]'::jsonb)
  from jsonb_array_elements(p_def.columns) with ordinality c(c, ord)
  left join lateral (
    select (select s.captions->>(c.c->>'f') from public.report_settings s
            where s.shop_id = p_shop_id and s.key = p_def.key) as caption) caps on true;
$$;

/**
 * THE ENGINE: group a dataset, total it at every level.
 *
 * The subtotals come from GROUP BY ROLLUP, which is exactly the shape BMS prints —
 * product group, then brand, then product, with a total at each step — and means the
 * engine never has to add anything up twice or in two places.
 *
 * Percentages and averages are RECOMPUTED at every level, never summed. BMS sums its
 * profit-% column, so a subtotal over four lines can read 380%.
 */
create or replace function public.report_grouped(
  p_def public.report_defs, p_filters jsonb, p_shop_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_ds      public.rep_datasets;
  v_src     text;
  v_args    text[] := '{}';
  v_param   text;
  v_where   text;
  v_groups  text[];
  v_g       text;
  v_parts   text[] := '{}';
  v_order   text[] := '{}';
  v_meas    text[] := '{}';
  v_sql     text;
  v_raw     jsonb;
  v_row     jsonb;
  v_rows    jsonb := '[]'::jsonb;
  v_totals  jsonb := '{}'::jsonb;
  v_col     jsonb;
  v_n       integer;
  v_mask    integer;
  v_level   integer;
  v_a       text;
  v_b       text;
  v_num     numeric;
  v_den     numeric;
  v_detail  integer := 0;
  v_top     integer := coalesce((p_filters->>'top')::integer, p_def.top_default);
  v_key     text;
begin
  select * into v_ds from public.rep_datasets where dataset = p_def.dataset;
  if not found then raise exception 'NO_SUCH_DATASET:%', coalesce(p_def.dataset, '(none)'); end if;

  -- The source, with any dates the dataset takes as arguments.
  foreach v_param in array v_ds.params loop
    v_args := v_args || case v_param
      when 'as_on' then quote_literal(coalesce(p_filters->>'as_on', public.dhaka_today()::text)) || '::date'
      when 'from'  then quote_nullable(p_filters->>'from') || '::date'
      when 'to'    then quote_nullable(p_filters->>'to') || '::date'
      else 'null' end;
  end loop;
  v_src := case when array_length(v_args, 1) is null then v_ds.source
                else format(v_ds.source, variadic v_args) end;

  -- Who may see what. The datasets are not under row-level security — they are only
  -- ever read through here — so the branch rule is applied explicitly, and a manager
  -- limited to one branch gets one branch's figures.
  v_where := format('shop_id = %L', p_shop_id);
  if 'branch_id' = any(v_ds.cols) then
    v_where := v_where || ' and public.can_use_branch(branch_id)';
    if p_filters->>'branch_id' is not null then
      v_where := v_where || format(' and branch_id = %L', (p_filters->>'branch_id')::uuid);
    end if;
  end if;
  if v_ds.date_field is not null then
    if p_def.date_mode = 'as_on' then
      v_where := v_where || format(' and %I <= %L::date', v_ds.date_field,
                                   coalesce(p_filters->>'as_on', public.dhaka_today()::text));
    else
      if p_filters->>'from' is not null then
        v_where := v_where || format(' and %I >= %L::date', v_ds.date_field, p_filters->>'from');
      end if;
      if p_filters->>'to' is not null then
        v_where := v_where || format(' and %I <= %L::date', v_ds.date_field, p_filters->>'to');
      end if;
    end if;
  end if;
  -- What this report always limits itself to (which kind of trader, which kind of
  -- voucher). Column names are checked against the dataset; values are literals.
  if p_def.fixed_filter is not null then
    for v_key in select jsonb_object_keys(p_def.fixed_filter) loop
      if not v_key = any(v_ds.cols) then raise exception 'NO_SUCH_FIELD:%', v_key; end if;
      v_where := v_where || format(' and %I = %L', v_key, p_def.fixed_filter->>v_key);
    end loop;
  end if;
  -- The filters a person can set on the screen, each only where the dataset has it.
  foreach v_key in array array['product_id', 'customer_id', 'supplier_id', 'account_id'] loop
    if p_filters->>v_key is not null and v_key = any(v_ds.cols) then
      v_where := v_where || format(' and %I = %L', v_key, (p_filters->>v_key)::uuid);
    end if;
  end loop;
  if p_filters->>'category' is not null and 'category' = any(v_ds.cols) then
    v_where := v_where || format(' and category = %L', p_filters->>'category');
  end if;

  v_groups := p_def.group_by;
  v_n := coalesce(array_length(v_groups, 1), 0);
  if v_n = 0 then raise exception 'REPORT_HAS_NO_GROUPING:%', p_def.key; end if;
  foreach v_g in array v_groups loop
    if not v_g = any(v_ds.cols) then raise exception 'NO_SUCH_FIELD:%', v_g; end if;
    v_parts := v_parts || format('%I', v_g);
  end loop;

  -- Which columns get added up, and which have to be worked out afterwards.
  for v_col in select c from jsonb_array_elements(p_def.columns) c loop
    -- A worked-out column (an average, a percentage) is written by this function, so it
    -- does not have to be a column of the dataset. Everything else does.
    if (v_col->>'calc' is null or v_col->>'calc' = 'average')
       and not (v_col->>'f') = any(v_ds.cols) then
      raise exception 'NO_SUCH_FIELD:%', v_col->>'f';
    end if;
    if (v_col->>'t') in ('qty', 'money', 'num')
       and (v_col->>'calc' is null or v_col->>'calc' = 'average') then
      if not (v_col->>'f') = any(v_meas) then v_meas := v_meas || (v_col->>'f'); end if;
    end if;
  end loop;
  -- The operands a percentage or an average needs, even when the report does not print
  -- them: a profit % with no profit column still has to divide something.
  foreach v_key in array array[v_ds.amount_field, v_ds.qty_field, v_ds.cost_field, v_ds.profit_field] loop
    if v_key is not null and v_key = any(v_ds.cols) and not v_key = any(v_meas) then
      if exists (select 1 from jsonb_array_elements(p_def.columns) c
                 where c->>'calc' is not null and c->>'calc' <> 'average') then
        v_meas := v_meas || v_key;
      end if;
    end if;
  end loop;

  v_sql := 'select ' || array_to_string(v_parts, ', ');
  -- A text column the report shows but does not group by (a serial list, a note).
  for v_col in select c from jsonb_array_elements(p_def.columns) c loop
    if (v_col->>'t') in ('text', 'date') and not (v_col->>'f') = any(v_groups)
       and (v_col->>'f') = any(v_ds.cols) then
      v_sql := v_sql || format(', min(%I::text) as %I', v_col->>'f', v_col->>'f');
    end if;
  end loop;
  foreach v_key in array v_meas loop
    v_sql := v_sql || format(', sum(coalesce(%I, 0)) as %I', v_key, v_key);
  end loop;
  v_sql := v_sql || ', count(*) as _rows, grouping(' || array_to_string(v_parts, ', ') || ') as _g';

  -- Subtotal rows sort after the rows they total, and the grand total comes last.
  for v_g in select unnest(v_groups[1:greatest(v_n - 1, 0)]) loop
    v_order := v_order || format('%I nulls last', v_g);
  end loop;
  if p_def.sort_desc is not null and p_def.sort_desc = any(v_ds.cols) then
    v_order := v_order || format('grouping(%I)', v_groups[v_n]);
    v_order := v_order || format('sum(coalesce(%I, 0)) desc', p_def.sort_desc);
  else
    v_order := v_order || format('%I nulls last', v_groups[v_n]);
  end if;

  v_sql := format('%s from %s where %s group by rollup(%s) order by %s',
                  v_sql, v_src, v_where, array_to_string(v_parts, ', '),
                  array_to_string(v_order, ', '));

  execute format('select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (%s) q', v_sql)
    into v_raw;

  -- Turn the raw rows into report rows: which level each one totals, the worked-out
  -- columns, and nothing in a text column on a subtotal row (a subtotal has no one
  -- invoice number, and printing the first one is how a report starts telling lies).
  for v_row in select r from jsonb_array_elements(v_raw) r loop
    v_mask := (v_row->>'_g')::integer;
    v_level := v_n;
    while v_level > 0 and (v_mask % 2) = 1 loop
      v_level := v_level - 1;
      v_mask := v_mask / 2;
    end loop;
    v_row := v_row - '_g';

    for v_col in select c from jsonb_array_elements(p_def.columns) c loop
      if v_col->>'calc' is not null then
        if v_col->>'calc' = 'average' then
          v_a := v_col->>'f'; v_b := '_rows';
        elsif v_col->>'calc' = 'avg_price' then
          v_a := v_ds.amount_field; v_b := v_ds.qty_field;
        elsif v_col->>'calc' = 'avg_cost' then
          v_a := v_ds.cost_field; v_b := v_ds.qty_field;
        elsif v_col->>'calc' = 'profit_pct' then
          v_a := v_ds.profit_field; v_b := v_ds.amount_field;
        else
          v_a := v_ds.profit_field; v_b := v_ds.cost_field;
        end if;
        v_num := case when v_a is null then null else (v_row->>v_a)::numeric end;
        v_den := case when v_b is null then null else (v_row->>v_b)::numeric end;
        v_row := v_row || jsonb_build_object(v_col->>'f',
          case when v_num is null or coalesce(v_den, 0) = 0 then null
               when (v_col->>'t') = 'pct' then round(v_num / v_den * 100, 1)
               else round(v_num / v_den, 2) end);
      elsif (v_col->>'t') in ('text', 'date') and v_level < v_n
            and not (v_col->>'f') = any(v_groups) then
        v_row := v_row || jsonb_build_object(v_col->>'f', null);
      end if;
    end loop;

    if v_level = 0 then
      v_totals := v_row || jsonb_build_object('_kind', 'total', '_level', 0);
    else
      if v_level = v_n then
        v_detail := v_detail + 1;
        if v_top is not null and v_detail > v_top then continue; end if;
      end if;
      v_rows := v_rows || jsonb_build_array(v_row || jsonb_build_object(
        '_kind', case when v_level = v_n then 'detail' else 'subtotal' end,
        '_level', v_level));
    end if;
  end loop;

  return jsonb_build_object('rows', v_rows, 'totals', v_totals,
                            'group_by', to_jsonb(v_groups));
end; $$;

/**
 * The cross-tabs: one column per branch, per place or per month.
 *
 * The columns are whatever the data has, so a shop that opens a third branch gets a
 * third column without anybody changing a report.
 */
create or replace function public.report_pivot(
  p_def public.report_defs, p_filters jsonb, p_shop_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_ds    public.rep_datasets;
  v_src   text;
  v_args  text[] := '{}';
  v_param text;
  v_where text;
  v_rowf  text := p_def.pivot->>'row';
  v_colf  text := p_def.pivot->>'col';
  v_valf  text := p_def.pivot->>'value';
  v_raw   jsonb;
  v_cells jsonb;
  v_cols  text[];
  v_colset jsonb := '[]'::jsonb;
  v_rows  jsonb := '[]'::jsonb;
  v_totals jsonb := '{}'::jsonb;
  v_c     text;
  v_r     jsonb;
  v_sum   numeric;
begin
  select * into v_ds from public.rep_datasets where dataset = p_def.dataset;
  if not found then raise exception 'NO_SUCH_DATASET:%', coalesce(p_def.dataset, '(none)'); end if;
  foreach v_c in array array[v_rowf, v_colf, v_valf] loop
    if not v_c = any(v_ds.cols) then raise exception 'NO_SUCH_FIELD:%', v_c; end if;
  end loop;

  foreach v_param in array v_ds.params loop
    v_args := v_args || case v_param
      when 'as_on' then quote_literal(coalesce(p_filters->>'as_on', public.dhaka_today()::text)) || '::date'
      when 'from'  then quote_nullable(p_filters->>'from') || '::date'
      when 'to'    then quote_nullable(p_filters->>'to') || '::date'
      else 'null' end;
  end loop;
  v_src := case when array_length(v_args, 1) is null then v_ds.source
                else format(v_ds.source, variadic v_args) end;

  v_where := format('shop_id = %L', p_shop_id);
  if 'branch_id' = any(v_ds.cols) then
    v_where := v_where || ' and public.can_use_branch(branch_id)';
    if p_filters->>'branch_id' is not null then
      v_where := v_where || format(' and branch_id = %L', (p_filters->>'branch_id')::uuid);
    end if;
  end if;
  if v_ds.date_field is not null then
    if p_def.date_mode = 'as_on' then
      v_where := v_where || format(' and %I <= %L::date', v_ds.date_field,
                                   coalesce(p_filters->>'as_on', public.dhaka_today()::text));
    else
      if p_filters->>'from' is not null then
        v_where := v_where || format(' and %I >= %L::date', v_ds.date_field, p_filters->>'from');
      end if;
      if p_filters->>'to' is not null then
        v_where := v_where || format(' and %I <= %L::date', v_ds.date_field, p_filters->>'to');
      end if;
    end if;
  end if;

  execute format(
    'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (
       select %I::text as r, %I::text as c, sum(coalesce(%I, 0)) as v
       from %s where %s group by 1, 2 order by 1, 2) q',
    v_rowf, v_colf, v_valf, v_src, v_where) into v_raw;

  select array_agg(distinct x.c order by x.c) into v_cols
  from jsonb_to_recordset(v_raw) as x(r text, c text, v numeric);
  v_cols := coalesce(v_cols, '{}');

  v_colset := jsonb_build_array(jsonb_build_object('f', '_row', 'l', initcap(replace(v_rowf, '_', ' ')), 't', 'text'));
  foreach v_c in array v_cols loop
    v_colset := v_colset || jsonb_build_array(jsonb_build_object('f', v_c, 'l', v_c, 't',
      case when v_valf like '%qty%' then 'qty' else 'money' end));
  end loop;
  v_colset := v_colset || jsonb_build_array(jsonb_build_object('f', '_total', 'l', 'Total', 't',
    case when v_valf like '%qty%' then 'qty' else 'money' end));

  for v_r in
    select jsonb_build_object('_row', x.r) || jsonb_object_agg(x.c, x.v)
           || jsonb_build_object('_total', sum(x.v), '_kind', 'detail', '_level', 1)
    from jsonb_to_recordset(v_raw) as x(r text, c text, v numeric)
    group by x.r order by x.r
  loop
    v_rows := v_rows || jsonb_build_array(v_r);
  end loop;

  select jsonb_build_object('_row', 'Total') || coalesce(jsonb_object_agg(x.c, x.s), '{}'::jsonb)
         || jsonb_build_object('_total', coalesce(sum(x.s), 0), '_kind', 'total', '_level', 0)
    into v_totals
  from (select x.c, sum(x.v) as s
        from jsonb_to_recordset(v_raw) as x(r text, c text, v numeric)
        group by x.c) x;

  return jsonb_build_object('rows', v_rows, 'totals', v_totals, 'columns', v_colset,
                            'pivot', true);
end; $$;

/**
 * Run a report.
 *
 * ONE way in, for every one of the hundred-odd reports: the permission is checked here,
 * the shop and the branches are applied here, and the answer always has the same shape
 * — so the screen that draws a sales register draws a trial balance too.
 */
create or replace function public.report_run(
  p_key text, p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me   public.staff;
  v_def  public.report_defs;
  v_body jsonb;
  v_f    jsonb := coalesce(p_filters, '{}'::jsonb);
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_reports') then raise exception 'NOT_ALLOWED:view_reports'; end if;

  select * into v_def from public.report_defs where key = p_key;
  if not found then raise exception 'NO_SUCH_REPORT:%', p_key; end if;
  if v_def.needs is not null then raise exception 'NOT_YET:%', v_def.needs; end if;
  -- Cost and profit are not the counter's business, and a report is not a way round
  -- that. BMS's answer was a second copy of each report "without price"; ours keeps
  -- those two (P-18, P-19) and puts the permission in front of the rest.
  if v_def.needs_cost and not public.has_permission('see_cost') then
    raise exception 'NOT_ALLOWED:see_cost';
  end if;
  if v_f->>'branch_id' is not null and not public.can_use_branch((v_f->>'branch_id')::uuid) then
    raise exception 'BRANCH_NOT_ALLOWED';
  end if;

  if v_def.special is not null then
    v_body := public.report_special(v_def, v_f, v_me);
  elsif v_def.pivot is not null then
    v_body := public.report_pivot(v_def, v_f, v_me.shop_id);
  else
    v_body := public.report_grouped(v_def, v_f, v_me.shop_id);
  end if;

  return jsonb_build_object(
    'key', v_def.key,
    'register', v_def.register,
    'title', public.rep_title(v_def, v_me.shop_id),
    'note', v_def.note,
    'date_mode', v_def.date_mode,
    'landscape', v_def.landscape,
    'columns', public.rep_columns(v_def, v_me.shop_id),
    'filters', v_f,
    'shop', (select name from public.shops where id = v_me.shop_id),
    'branch', (select name from public.branches where id = (v_f->>'branch_id')::uuid),
    'run_at', now(),
    'run_by', v_me.name
  ) || v_body;
end; $$;

/** The registers and what is in them, with the shop's own titles and order. */
create or replace function public.report_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_reports') then raise exception 'NOT_ALLOWED:view_reports'; end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'key', d.key, 'register', d.register,
      'sl', coalesce(s.sl, d.sl),
      'title', coalesce(nullif(trim(s.title), ''), d.title),
      'note', d.note,
      'date_mode', d.date_mode,
      'landscape', d.landscape,
      'needs', d.needs,
      'needs_cost', d.needs_cost,
      'renamed', s.title is not null,
      -- A report with cost columns is listed but marked, rather than hidden: "why can
      -- I not see the profit report" is a question with an answer.
      'allowed', d.needs is null and (not d.needs_cost or public.has_permission('see_cost')))
      order by d.register, coalesce(s.sl, d.sl)), '[]'::jsonb)
    from public.report_defs d
    left join public.report_settings s on s.shop_id = v_me.shop_id and s.key = d.key);
end; $$;

/** Rename a report, move it up the list, or rename one of its columns. Owner only. */
create or replace function public.save_report_setting(p_key text, p_values jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_def public.report_defs;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  select * into v_def from public.report_defs where key = p_key;
  if not found then raise exception 'NO_SUCH_REPORT:%', p_key; end if;

  insert into public.report_settings (shop_id, key, title, sl, captions, sort_by)
  values (v_me.shop_id, p_key,
          nullif(trim(coalesce(p_values->>'title', '')), ''),
          (p_values->>'sl')::integer,
          case when p_values ? 'captions' then p_values->'captions' end,
          nullif(trim(coalesce(p_values->>'sort_by', '')), ''))
  on conflict (shop_id, key) do update set
    title = coalesce(nullif(trim(coalesce(excluded.title, '')), ''), report_settings.title),
    sl = coalesce(excluded.sl, report_settings.sl),
    captions = coalesce(excluded.captions, report_settings.captions),
    sort_by = coalesce(excluded.sort_by, report_settings.sort_by),
    updated_at = now();

  -- Nothing here, and the report goes back to its own name and place.
  if coalesce(p_values->>'reset', 'false') = 'true' then
    delete from public.report_settings where shop_id = v_me.shop_id and key = p_key;
  end if;

  return jsonb_build_object('key', p_key);
end; $$;

-- ---------------------------------------------------------------------------
-- PART 5 — The reports that are not a grouped list
-- ---------------------------------------------------------------------------

/** An account's name, with its branch, but never the branch twice. */
create or replace function public.rep_account_label(p_name text, p_branch text)
returns text
language sql immutable as $$
  select case
    when p_branch is null then p_name
    -- The per-branch cash accounts are already called "Cash in hand — Main branch".
    when position(lower(p_branch) in lower(p_name)) > 0 then p_name
    else p_name || ' (' || p_branch || ')' end;
$$;

/** Every account's movement and balance over a period, for the accounts reports. */
create or replace function public.rep_balances(
  p_shop_id uuid, p_from date, p_to date, p_branch uuid
) returns table (
  account_id uuid, code text, name text, grp text, nature text, role text,
  branch text, debit numeric, credit numeric, balance numeric
)
language sql stable security definer set search_path = public as $$
  select a.id, a.code, a.name, g.name, g.nature, a.role,
         (select b.name from public.branches b where b.id = a.branch_id),
         coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0),
         case when g.nature in ('asset', 'expense')
              then coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0)
              else coalesce(sum(l.credit), 0) - coalesce(sum(l.debit), 0) end
  from public.accounts a
  join public.account_groups g on g.id = a.group_id
  left join public.journal_lines l on l.account_id = a.id
    and exists (select 1 from public.journal_entries e
                where e.id = l.entry_id and e.status = 'posted'
                  and (p_from is null or e.entry_date >= p_from)
                  and (p_to is null or e.entry_date <= p_to)
                  and (p_branch is null or e.branch_id = p_branch)
                  and public.can_use_branch(e.branch_id))
  where a.shop_id = p_shop_id and public.can_see_account(a.id)
  group by a.id, a.code, a.name, g.name, g.nature, a.role, a.branch_id;
$$;

/** What each customer and supplier owes, as it stood on a date. */
create or replace function public.rep_party_dues(p_shop_id uuid, p_as_on date)
returns table (
  kind text, party_id uuid, trader_group text, name text, address text, mobile text,
  due numeric, uncleared numeric
)
language sql stable security definer set search_path = public as $$
  select 'Customer', c.id, coalesce(cg.name, 'Retail'),
         coalesce(c.name_text, c.company, c.phone), coalesce(c.address, '—'), c.phone,
         coalesce((select sum(s.due_amount) from public.sales s
                   where s.customer_id = c.id and s.status = 'completed'
                     and public.dhaka_date(s.created_at) <= p_as_on), 0)
         + coalesce((select ob.amount from public.opening_balances ob
                     where ob.customer_id = c.id and ob.as_of <= p_as_on), 0)
         - coalesce((select sum(cp.amount) from public.customer_payments cp
                     where cp.customer_id = c.id
                       and public.dhaka_date(cp.created_at) <= p_as_on), 0)
         - coalesce((select sum(r.total) from public.sale_returns r
                     where r.customer_id = c.id
                       and r.refund_method in ('reduce_due', 'store_credit')
                       and r.approval_status <> 'cancelled'
                       and public.dhaka_date(r.created_at) <= p_as_on), 0),
         coalesce((select sum(ch.amount) from public.cheques ch
                   where ch.customer_id = c.id and ch.status = 'issued'
                     and ch.cheque_date <= p_as_on), 0)
  from public.customers c
  left join public.customer_groups cg on cg.id = c.group_id
  where c.shop_id = p_shop_id
  union all
  select 'Supplier', s.id, coalesce(sg.name, 'N/A'), s.name,
         coalesce(s.address, '—'), coalesce(s.phone, '—'),
         coalesce((select ob.amount from public.opening_balances ob
                   where ob.supplier_id = s.id and ob.as_of <= p_as_on), 0)
         + coalesce((select sum(g.total) from public.grns g
                     where g.supplier_id = s.id and g.is_credit
                       and public.dhaka_date(g.created_at) <= p_as_on), 0)
         - coalesce((select sum(sp.amount) from public.supplier_payments sp
                     where sp.supplier_id = s.id and sp.paid_on <= p_as_on), 0)
         - coalesce((select sum(sr.total) from public.supplier_returns sr
                     where sr.supplier_id = s.id
                       and public.dhaka_date(sr.created_at) <= p_as_on), 0),
         coalesce((select sum(ch.amount) from public.cheques ch
                   where ch.supplier_id = s.id and ch.status = 'issued'
                     and ch.cheque_date <= p_as_on), 0)
  from public.suppliers s
  left join public.supplier_groups sg on sg.id = s.group_id
  where s.shop_id = p_shop_id;
$$;

/** The two money columns, for the reports that print a list of particulars. */
create or replace function public.rep_two_col(p_label text default 'Particulars')
returns jsonb
language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('f', 'particulars', 'l', p_label, 't', 'text'),
    jsonb_build_object('f', 'amount', 'l', 'Amount', 't', 'money'));
$$;

/** One row of a printed statement or summary. */
create or replace function public.rep_row(
  p_particulars text, p_amount numeric, p_kind text default 'detail',
  p_extra jsonb default '{}'::jsonb
) returns jsonb
language sql immutable as $$
  select jsonb_build_object('particulars', p_particulars, 'amount', round(coalesce(p_amount, 0), 2),
                            '_kind', p_kind, '_level', case when p_kind = 'detail' then 1 else 0 end)
         || p_extra;
$$;

-- ---------------------------------------------------------------------------
-- PART 5 (first) — Three holes the done-when exposes
-- ---------------------------------------------------------------------------
--
-- The done-when of this prompt is that the balance sheet's stock figure equals the
-- stock valuation report. Testing that found three things P13 never posted:
--
-- 1. A DELIVERY WENT ON THE BOOKS AT ITS INVOICE TOTAL — VAT and advance income tax
--    included. Those are not stock: the VAT is reclaimable and the AIT is tax paid in
--    advance, and counting them as stock overstates the shelf by the tax on every
--    delivery. They now go to their own accounts, which is also where the VAT return
--    gets its input figure.
-- 2. STOCK CORRECTIONS NEVER TOUCHED THE BOOKS. Write off a damaged laptop and the
--    shelf lost it while the books still had it, so the two drifted apart by every
--    correction ever made — silently, because nothing compared them.
-- 3. TRANSFERS NEVER TOUCHED THE BOOKS EITHER. Goods off one branch's shelf and not
--    yet on another's are nobody's stock (P7, deliberately) but they are still the
--    shop's money, so they belong in an account of their own while the van is on the
--    road. Without one, every transfer in flight made the books look wrong.

alter table public.accounts drop constraint accounts_role_check;
alter table public.accounts add constraint accounts_role_check
  check (role is null or role in (
    'cash_in_hand', 'bank', 'wallet', 'receivable', 'payable', 'inventory',
    'vat_payable', 'sales', 'sales_return', 'cogs', 'discount_given',
    'purchase_return', 'stock_loss', 'stock_gain', 'inter_branch',
    'card_charge', 'opening_equity', 'rounding',
    -- New in P14.
    'vat_input', 'ait_advance', 'stock_in_transit'));

/** The three accounts the reports need, for shops that already have a chart. */
create or replace function public.seed_report_accounts(p_shop_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in
    select * from (values
      ('1250', 'VAT paid on purchases', 'Current assets', 'vat_input'),
      ('1260', 'Advance income tax',    'Current assets', 'ait_advance'),
      ('1350', 'Stock in transit',      'Current assets', 'stock_in_transit')
    ) as t(code, name, grp, role)
  loop
    insert into public.accounts (shop_id, group_id, code, name, role)
    select p_shop_id, ag.id, g.code, g.name, g.role
    from public.account_groups ag
    where ag.shop_id = p_shop_id and ag.name = g.grp
    on conflict (shop_id, code) do nothing;
  end loop;
end; $$;

select public.seed_report_accounts(id) from public.shops
where exists (select 1 from public.accounts a where a.shop_id = shops.id);

-- And for every shop from now on. P13's seeder is left exactly as it was — an applied
-- migration is never edited — so the trigger that calls it calls this as well.
create or replace function public.add_shop_accounts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_accounts(new.id);
  perform public.seed_report_accounts(new.id);
  return new;
end; $$;

/**
 * A delivery, posted properly.
 *
 * The goods go to stock at what they actually cost — the invoice total less the VAT and
 * the advance income tax — and the two taxes go where they belong. The cash side is
 * unchanged from P13: paid on the spot comes out of the drawer whether or not the shop
 * keeps books, because the drawer is short either way.
 */
create or replace function public.post_grn() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_lines jsonb; v_goods numeric(14,2);
begin
  if coalesce(new.total, 0) = 0 then return new; end if;

  if not new.is_credit and not exists (
       select 1 from public.cash_movements
       where source_kind = 'grn' and source_id = new.id) then
    insert into public.cash_movements (shop_id, branch_id, shift_id, direction, amount,
                                       reason, note, staff_id, source_kind, source_id)
    values (new.shop_id, new.branch_id,
            (select id from public.shifts where branch_id = new.branch_id
               and closed_at is null order by opened_at desc limit 1),
            'out', new.total, 'other', 'Paid for ' || new.grn_no, new.staff_id,
            'grn', new.id);
  end if;

  if not public.feature_on('accounts') then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'grn' and source_id = new.id) then
    return new;
  end if;

  v_goods := new.total - coalesce(new.vat, 0) - coalesce(new.ait, 0);
  v_lines := jsonb_build_array(
    jsonb_build_object('role', 'inventory', 'debit', v_goods, 'note', new.grn_no));
  if coalesce(new.vat, 0) > 0 then
    v_lines := v_lines || jsonb_build_object('role', 'vat_input', 'debit', new.vat,
                                             'note', 'VAT on ' || new.grn_no);
  end if;
  if coalesce(new.ait, 0) > 0 then
    v_lines := v_lines || jsonb_build_object('role', 'ait_advance', 'debit', new.ait,
                                             'note', 'AIT on ' || new.grn_no);
  end if;
  if new.is_credit then
    v_lines := v_lines || jsonb_build_object('role', 'payable', 'credit', new.total,
                                             'supplier_id', new.supplier_id);
  else
    v_lines := v_lines || jsonb_build_object(
      'role', 'cash_in_hand', 'credit', new.total, 'note', 'Paid for ' || new.grn_no);
  end if;

  perform public.post_entry(new.shop_id, new.branch_id,
    (new.created_at at time zone 'Asia/Dhaka')::date,
    'Goods received ' || new.grn_no, v_lines, 'grn', new.id, new.staff_id);
  return new;
end; $$;

/**
 * Stock moving for any other reason: a correction, a count, a write-off, a van.
 *
 * Valued at the weighted average cost, because that is what the shelf is worth. A
 * transfer leg uses the cost captured when the goods were SENT, so what leaves the
 * stock account and what lands in the transit account are the same figure even if a
 * delivery changed the average while the van was on the road.
 */
create or replace function public.post_stock_movement(new public.stock_movements)
returns void
language plpgsql security definer set search_path = public as $$
declare v_cost numeric(14,2); v_value numeric(14,2); v_qty integer := abs(new.qty_change);
begin
  if new.qty_change = 0 or new.branch_id is null then return; end if;
  -- These have their own documents, and their own entries.
  if new.reason in ('sale', 'return', 'return_to_supplier') then return; end if;
  if new.reason = 'purchase' and new.ref_id is not null then return; end if;
  if not public.feature_on('accounts') then return; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'stock_adjust' and source_id = new.id) then
    return;
  end if;

  -- What it was worth when it moved, captured on the row itself. Falling back to
  -- today's average is only for movements recorded before that column existed, and the
  -- stock valuation report shows the resulting difference rather than hiding it.
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
  elsif new.qty_change > 0 and new.reason = 'purchase' then
    -- Something taken in part-exchange. It goes on the shelf at what was given for it,
    -- and the sale it came from is worth that much more than the cash suggests.
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at), coalesce(new.note, 'Taken in part-exchange'),
      jsonb_build_array(
        jsonb_build_object('role', 'inventory', 'debit', v_value),
        jsonb_build_object('role', 'sales', 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  elsif new.qty_change > 0 then
    -- Stock the shop already had when it started keeping books is not a gain: it is
    -- what the owner put in. Anything else found on a shelf afterwards is.
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at),
      coalesce(new.note, 'Stock found'),
      jsonb_build_array(
        jsonb_build_object('role', 'inventory', 'debit', v_value),
        jsonb_build_object(
          'role', case when new.note ilike 'opening stock%' then 'opening_equity'
                       else 'stock_gain' end, 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  else
    perform public.post_entry(new.shop_id, new.branch_id,
      public.dhaka_date(new.created_at),
      coalesce(new.note, 'Stock written off'),
      jsonb_build_array(
        jsonb_build_object('role', 'stock_loss', 'debit', v_value),
        jsonb_build_object('role', 'inventory', 'credit', v_value)),
      'stock_adjust', new.id, new.staff_id);
  end if;
end; $$;

create or replace function public.post_stock_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.post_stock_movement(new);
  return new;
end; $$;

create trigger stock_movements_post
  after insert on public.stock_movements
  for each row execute function public.post_stock_change();

/**
 * Catch the books up on stock, for a shop that switched the accounts on later.
 *
 * P13's back-fill replays the documents — sales, deliveries, payments. This replays
 * what happened to STOCK: the opening figures, the corrections, the write-offs and the
 * vans. It is the same idea and the same safety: the posting rules are not copied, the
 * same function the trigger calls is called again, and the already-posted guard is what
 * makes it safe to press twice. Which matters, because the first run on a shop with two
 * years of history will time out and the owner will press it again.
 */
create or replace function public.backfill_stock_entries() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.staff; v_mv public.stock_movements; v_n integer := 0; v_t integer := 0;
  v_shelf numeric(14,2); v_books numeric(14,2); v_gap numeric(14,2) := 0; v_branch uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found or v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  if not public.feature_on('accounts') then raise exception 'FEATURE_OFF:accounts'; end if;

  -- Replaying what already happened is not dating something into a closed month.
  perform set_config('app.replaying_history', 'on', true);

  for v_mv in
    select * from public.stock_movements
    where shop_id = v_me.shop_id and branch_id is not null and qty_change <> 0
    order by created_at, id
  loop
    if not exists (select 1 from public.journal_entries
                   where source_kind = 'stock_adjust' and source_id = v_mv.id) then
      perform public.post_stock_movement(v_mv);
      -- Counted only if it actually posted: most movements belong to a document that
      -- posts its own entry, and reporting those as caught up would be a lie.
      if exists (select 1 from public.journal_entries
                 where source_kind = 'stock_adjust' and source_id = v_mv.id) then
        v_n := v_n + 1;
      end if;
    end if;
  end loop;

  -- And the transfers that ended in a loss.
  update public.transfers set status = status
  where shop_id = v_me.shop_id and status <> 'in_transit'
    and not exists (select 1 from public.journal_entries
                    where source_kind = 'transfer' and source_id = transfers.id);
  get diagnostics v_t = row_count;

  -- AND THEN BRING THE STOCK IN AT WHAT IT IS WORTH.
  --
  -- A shop that traded for two years before switching the books on has cost changes,
  -- revaluations and corrected invoices in its past that no replay can reconstruct —
  -- the figures those events used are gone. What IS known is what is on the shelves
  -- today and what it is worth, so the stock account is brought to that, against the
  -- owner's capital. It is what an accountant does when opening books mid-life: count
  -- the stock, bring it in at the count. One entry, named, so it is obvious what it is
  -- and what it is not.
  select coalesce(sum(s.total_cost), 0) into v_shelf
  from public.rep_stock_as_on(public.dhaka_today()) s
  where s.shop_id = v_me.shop_id;
  select coalesce(sum(l.debit - l.credit), 0) into v_books
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  join public.accounts a on a.id = l.account_id
  where a.shop_id = v_me.shop_id and a.role = 'inventory' and e.status = 'posted';
  v_gap := round(v_shelf - v_books, 2);
  if v_gap <> 0 then
    select s.branch_id into v_branch
    from public.rep_stock_as_on(public.dhaka_today()) s
    where s.shop_id = v_me.shop_id
    group by s.branch_id order by sum(s.total_cost) desc limit 1;
    perform public.post_entry(v_me.shop_id,
      coalesce(v_branch, (select id from public.branches where shop_id = v_me.shop_id
                          order by created_at limit 1)),
      public.dhaka_today(), 'Stock brought in at its counted value',
      jsonb_build_array(
        jsonb_build_object('role', 'inventory',
          case when v_gap > 0 then 'debit' else 'credit' end, abs(v_gap)),
        jsonb_build_object('role', 'opening_equity',
          case when v_gap > 0 then 'credit' else 'debit' end, abs(v_gap))),
      'opening_balance', null, v_me.id);
  end if;

  perform set_config('app.replaying_history', 'off', true);

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id, 'stock_entries_backfilled', 'journal_entry',
          jsonb_build_object('movements', v_n, 'transfers', v_t, 'stock_brought_in', v_gap));

  return jsonb_build_object('movements', v_n, 'transfers', v_t, 'stock_brought_in', v_gap);
end; $$;

/**
 * Goods that never arrived, or arrived broken.
 *
 * The units left the sending shelf when the van did, so the loss is not another
 * deduction from stock — it is moving what is sitting in the transit account out of it,
 * into a write-off. Posted from the transfer rather than from a stock movement, because
 * the movement for damage is deliberately a nil-quantity marker: nothing physically
 * moved, the goods simply turned out to be worthless.
 */
create or replace function public.post_transfer_loss() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_lost numeric(14,2); v_back numeric(14,2);
begin
  if not public.feature_on('accounts') then return new; end if;
  if new.status = 'in_transit' then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'transfer' and source_id = new.id) then
    return new;
  end if;
  -- Damaged on arrival: counted as received, never put on a shelf.
  select coalesce(sum(round(coalesce(ti.unit_cost, 0) * ti.damaged_qty, 2)), 0)
    into v_lost from public.transfer_items ti where ti.transfer_id = new.id;
  -- Short on arrival and written off by a manager.
  if new.resolution = 'written_off' then
    select v_lost + coalesce(sum(round(coalesce(ti.unit_cost, 0)
                                       * (ti.qty - ti.received_qty), 2)), 0)
      into v_lost from public.transfer_items ti where ti.transfer_id = new.id;
  end if;
  if v_lost = 0 then return new; end if;

  perform public.post_entry(new.shop_id, new.from_branch_id,
    public.dhaka_date(coalesce(new.resolved_at, new.received_at, new.sent_at)),
    'Lost in transit on ' || new.transfer_no,
    jsonb_build_array(
      jsonb_build_object('role', 'stock_loss', 'debit', v_lost),
      jsonb_build_object('role', 'stock_in_transit', 'credit', v_lost)),
    'transfer', new.id, new.sent_by);
  return new;
end; $$;

create trigger transfers_post_loss
  after update of status, resolution on public.transfers
  for each row execute function public.post_transfer_loss();

-- --- The trial balance: the two columns that must match -------------------

/**
 * Each account's NET balance, on its natural side.
 *
 * Gross debits always equal gross credits — that is arithmetic, and a report that
 * printed it would always "balance" while telling you nothing. What has to balance is
 * the nets: an asset with a credit balance (an overdrawn bank) appears on the credit
 * side, and the two columns still come out the same. BMS's does not.
 */
create or replace function public.rep_sp_trial_balance(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb := '[]'::jsonb; v_r record; v_grp text := null;
  v_gd numeric := 0; v_gc numeric := 0; v_td numeric := 0; v_tc numeric := 0;
  v_net numeric; v_d numeric; v_c numeric;
begin
  for v_r in
    select b.*, (b.debit - b.credit) as net
    from public.rep_balances(p_me.shop_id, (p_filters->>'from')::date,
                             (p_filters->>'to')::date, (p_filters->>'branch_id')::uuid) b
    where b.debit <> 0 or b.credit <> 0
    order by b.grp, b.code
  loop
    if v_grp is not null and v_r.grp <> v_grp then
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'particulars', v_grp || ' total', 'debit', v_gd, 'credit', v_gc,
        '_kind', 'subtotal', '_level', 1));
      v_gd := 0; v_gc := 0;
    end if;
    v_grp := v_r.grp;
    v_net := v_r.net;
    v_d := case when v_net > 0 then v_net else 0 end;
    v_c := case when v_net < 0 then -v_net else 0 end;
    v_gd := v_gd + v_d; v_gc := v_gc + v_c;
    v_td := v_td + v_d; v_tc := v_tc + v_c;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'code', v_r.code, 'group', v_r.grp,
      'particulars', public.rep_account_label(v_r.name, v_r.branch),
      'account_id', v_r.account_id, 'debit', v_d, 'credit', v_c,
      '_kind', 'detail', '_level', 2));
  end loop;
  if v_grp is not null then
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'particulars', v_grp || ' total', 'debit', v_gd, 'credit', v_gc,
      '_kind', 'subtotal', '_level', 1));
  end if;

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'code', 'l', 'Code', 't', 'text'),
      jsonb_build_object('f', 'particulars', 'l', 'Particulars', 't', 'text'),
      jsonb_build_object('f', 'debit', 'l', 'Debit', 't', 'money'),
      jsonb_build_object('f', 'credit', 'l', 'Credit', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'debit', v_td, 'credit', v_tc,
                                 '_kind', 'total', '_level', 0),
    'balanced', round(v_td, 2) = round(v_tc, 2),
    -- A ledger behind every line, because a number an owner cannot open is one they
    -- have to take on trust.
    'drill', 'account_id');
end; $$;

/** The same thing rolled up to account groups, for a one-page view (BMS's A-11). */
create or replace function public.rep_sp_layer_summary(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_rows jsonb := '[]'::jsonb; v_r record; v_td numeric := 0; v_tc numeric := 0;
begin
  for v_r in
    select b.grp, b.nature,
           sum(case when b.debit - b.credit > 0 then b.debit - b.credit else 0 end) as d,
           sum(case when b.debit - b.credit < 0 then b.credit - b.debit else 0 end) as c
    from public.rep_balances(p_me.shop_id, (p_filters->>'from')::date,
                             (p_filters->>'to')::date, (p_filters->>'branch_id')::uuid) b
    group by b.grp, b.nature
    having sum(abs(b.debit - b.credit)) <> 0
    order by b.nature, b.grp
  loop
    v_td := v_td + v_r.d; v_tc := v_tc + v_r.c;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'particulars', v_r.grp, 'nature', initcap(v_r.nature),
      'debit', v_r.d, 'credit', v_r.c, '_kind', 'detail', '_level', 1));
  end loop;
  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'particulars', 'l', 'Account group', 't', 'text'),
      jsonb_build_object('f', 'nature', 'l', 'Kind', 't', 'text'),
      jsonb_build_object('f', 'debit', 'l', 'Debit', 't', 'money'),
      jsonb_build_object('f', 'credit', 'l', 'Credit', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'debit', v_td, 'credit', v_tc,
                                 '_kind', 'total', '_level', 0));
end; $$;

/** The chart itself, as a printable tree (BMS's A-17). */
create or replace function public.rep_sp_chart(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'nature', 'l', 'Main Group', 't', 'text'),
      jsonb_build_object('f', 'particulars', 'l', 'Sub Group', 't', 'text'),
      jsonb_build_object('f', 'code', 'l', 'Code', 't', 'text'),
      jsonb_build_object('f', 'name', 'l', 'Account Name', 't', 'text'),
      jsonb_build_object('f', 'branch', 'l', 'Branch', 't', 'text'),
      jsonb_build_object('f', 'role', 'l', 'What it is for', 't', 'text')),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'nature', initcap(g.nature), 'particulars', g.name, 'code', a.code,
               'name', a.name, 'account_id', a.id,
               'branch', (select br.name from public.branches br where br.id = a.branch_id),
               'role', case when a.role is null then '—'
                            else initcap(replace(a.role, '_', ' ')) end,
               '_kind', 'detail', '_level', 1) order by g.sort, a.code), '[]'::jsonb)
             from public.accounts a
             join public.account_groups g on g.id = a.group_id
             where a.shop_id = p_me.shop_id and a.active and public.can_see_account(a.id)),
    'totals', '{}'::jsonb, 'drill', 'account_id');
end; $$;

/** Every bank account and wallet: opening, in, out, closing (BMS's A-2). */
create or replace function public.rep_sp_bank_summary(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb := '[]'::jsonb; v_r record; v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_to1 numeric := 0; v_to2 numeric := 0; v_to3 numeric := 0; v_to4 numeric := 0;
begin
  for v_r in
    select a.id, a.code, a.name,
           (select ba.account_no from public.bank_accounts ba where ba.id = a.bank_account_id) as acct_no,
           coalesce((select sum(l.debit - l.credit) from public.journal_lines l
                     join public.journal_entries e on e.id = l.entry_id
                     where l.account_id = a.id and e.status = 'posted'
                       and v_from is not null and e.entry_date < v_from
                       and (v_branch is null or e.branch_id = v_branch)
                       and public.can_use_branch(e.branch_id)), 0) as opening,
           coalesce((select sum(l.debit) from public.journal_lines l
                     join public.journal_entries e on e.id = l.entry_id
                     where l.account_id = a.id and e.status = 'posted'
                       and (v_from is null or e.entry_date >= v_from) and e.entry_date <= v_to
                       and (v_branch is null or e.branch_id = v_branch)
                       and public.can_use_branch(e.branch_id)), 0) as took_in,
           coalesce((select sum(l.credit) from public.journal_lines l
                     join public.journal_entries e on e.id = l.entry_id
                     where l.account_id = a.id and e.status = 'posted'
                       and (v_from is null or e.entry_date >= v_from) and e.entry_date <= v_to
                       and (v_branch is null or e.branch_id = v_branch)
                       and public.can_use_branch(e.branch_id)), 0) as paid_out
    from public.accounts a
    where a.shop_id = p_me.shop_id and a.role in ('bank', 'wallet')
      and public.can_see_account(a.id)
    order by a.code
  loop
    v_to1 := v_to1 + v_r.opening; v_to2 := v_to2 + v_r.took_in;
    v_to3 := v_to3 + v_r.paid_out;
    v_to4 := v_to4 + v_r.opening + v_r.took_in - v_r.paid_out;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'particulars', v_r.name, 'account_no', coalesce(v_r.acct_no, '—'),
      'account_id', v_r.id,
      'opening', v_r.opening, 'took_in', v_r.took_in, 'paid_out', v_r.paid_out,
      'closing', v_r.opening + v_r.took_in - v_r.paid_out,
      '_kind', 'detail', '_level', 1));
  end loop;
  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'particulars', 'l', 'Account', 't', 'text'),
      jsonb_build_object('f', 'account_no', 'l', 'Account No.', 't', 'text'),
      jsonb_build_object('f', 'opening', 'l', 'Opening', 't', 'money'),
      jsonb_build_object('f', 'took_in', 'l', 'Money in', 't', 'money'),
      jsonb_build_object('f', 'paid_out', 'l', 'Money out', 't', 'money'),
      jsonb_build_object('f', 'closing', 'l', 'Closing Balance', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'opening', v_to1,
      'took_in', v_to2, 'paid_out', v_to3, 'closing', v_to4, '_kind', 'total', '_level', 0),
    'drill', 'account_id');
end; $$;

-- --- Profit and loss, and the balance sheet ------------------------------

/**
 * Profit and loss.
 *
 * Sales less what the goods cost gives the gross profit; then the running costs come
 * off that. BMS rounds the same profit two different ways on two reports, 36 paisa
 * apart; here it is rounded once, at the end, in one place.
 *
 * A-22 is the same report with every branch together, so the branch filter is ignored.
 */
create or replace function public.rep_sp_profit_loss(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb := '[]'::jsonb; v_r record;
  v_branch uuid := case when p_def.key = 'A-22' then null else (p_filters->>'branch_id')::uuid end;
  v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_sales numeric := 0; v_returns numeric := 0; v_disc numeric := 0;
  v_cogs numeric := 0; v_direct numeric := 0; v_over numeric := 0; v_other numeric := 0;
  v_net_sales numeric; v_gross numeric; v_profit numeric;
begin
  for v_r in
    select * from public.rep_balances(p_me.shop_id, v_from, v_to, v_branch) b
    where b.nature in ('income', 'expense') and b.balance <> 0
    order by b.grp, b.code
  loop
    if v_r.role = 'sales' then v_sales := v_sales + v_r.balance;
    elsif v_r.role = 'sales_return' then v_returns := v_returns + v_r.balance;
    elsif v_r.role = 'discount_given' then v_disc := v_disc + v_r.balance;
    elsif v_r.role = 'cogs' then v_cogs := v_cogs + v_r.balance;
    elsif v_r.role = 'purchase_return' then v_direct := v_direct - v_r.balance;
    elsif v_r.nature = 'expense' and v_r.grp = 'Direct costs' then
      v_direct := v_direct + v_r.balance;
      v_rows := v_rows || jsonb_build_array(public.rep_row(v_r.name, v_r.balance, 'detail',
        jsonb_build_object('section', 'Direct costs', 'account_id', v_r.account_id)));
    elsif v_r.nature = 'expense' then
      v_over := v_over + v_r.balance;
    else
      v_other := v_other + v_r.balance;
    end if;
  end loop;

  -- A sales return is income the shop gave back, and a discount is money it chose to
  -- give away: both come off the top, where an owner can see what they cost.
  v_net_sales := v_sales - v_returns - v_disc;
  v_gross := v_net_sales - v_cogs - v_direct;

  v_rows := jsonb_build_array(
    public.rep_row('Sales', v_sales),
    public.rep_row('Less: sales returns', -v_returns),
    public.rep_row('Less: discounts given', -v_disc),
    public.rep_row('Net sales', v_net_sales, 'subtotal'),
    public.rep_row('Cost of goods sold', -v_cogs)) || v_rows;
  if v_direct <> 0 then
    v_rows := v_rows || jsonb_build_array(public.rep_row('Other direct costs', -v_direct));
  end if;
  v_rows := v_rows || jsonb_build_array(public.rep_row('Gross profit', v_gross, 'subtotal'));

  for v_r in
    select * from public.rep_balances(p_me.shop_id, v_from, v_to, v_branch) b
    where b.nature = 'expense' and b.grp <> 'Direct costs' and b.balance <> 0
    order by b.code
  loop
    v_rows := v_rows || jsonb_build_array(public.rep_row(v_r.name, -v_r.balance, 'detail',
      jsonb_build_object('account_id', v_r.account_id)));
  end loop;
  v_rows := v_rows || jsonb_build_array(public.rep_row('Total running costs', -v_over, 'subtotal'));
  if v_other <> 0 then
    v_rows := v_rows || jsonb_build_array(public.rep_row('Other income', v_other));
  end if;

  v_profit := round(v_gross - v_over + v_other, 2);
  return jsonb_build_object(
    'columns', public.rep_two_col('A/C Ledger Name'),
    'rows', v_rows,
    'totals', public.rep_row(
      case when v_profit >= 0 then 'Profit for the period' else 'Loss for the period' end,
      v_profit, 'total'),
    'drill', 'account_id');
end; $$;

/**
 * The balance sheet.
 *
 * What the shop owns on one side, what it owes and what the owner put in on the other,
 * and the profit so far. The two sides must come out the same; if they do not, the
 * report says so instead of quietly printing two different totals the way BMS does.
 *
 * A LOSS GOES ON THE CORRECT SIDE. BMS puts a previous-period loss under assets, which
 * makes the page add up and the meaning wrong.
 */
create or replace function public.rep_sp_balance_sheet(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_assets jsonb := '[]'::jsonb; v_liab jsonb := '[]'::jsonb; v_r record;
  v_branch uuid := case when p_def.key = 'A-23' then null else (p_filters->>'branch_id')::uuid end;
  v_as_on date := coalesce((p_filters->>'as_on')::date, public.dhaka_today());
  v_a numeric := 0; v_l numeric := 0; v_profit numeric := 0;
begin
  for v_r in
    select * from public.rep_balances(p_me.shop_id, null, v_as_on, v_branch) b
    where b.balance <> 0 order by b.grp, b.code
  loop
    if v_r.nature = 'asset' then
      v_a := v_a + v_r.balance;
      v_assets := v_assets || jsonb_build_array(public.rep_row(
        public.rep_account_label(v_r.name, v_r.branch), v_r.balance, 'detail',
        jsonb_build_object('group', v_r.grp, 'account_id', v_r.account_id)));
    elsif v_r.nature in ('liability', 'equity') then
      v_l := v_l + v_r.balance;
      v_liab := v_liab || jsonb_build_array(public.rep_row(
        v_r.name, v_r.balance, 'detail',
        jsonb_build_object('group', v_r.grp, 'account_id', v_r.account_id)));
    elsif v_r.nature = 'income' then
      v_profit := v_profit + v_r.balance;
    else
      v_profit := v_profit - v_r.balance;
    end if;
  end loop;

  v_profit := round(v_profit, 2);
  -- Profit the shop has made belongs to the owner, so it sits with the money they put
  -- in. A loss reduces it, on the same side, rather than appearing as something owned.
  v_liab := v_liab || jsonb_build_array(public.rep_row(
    case when v_profit >= 0 then 'Profit to date' else 'Loss to date' end, v_profit, 'detail',
    jsonb_build_object('group', 'Capital')));
  v_l := v_l + v_profit;

  return jsonb_build_object(
    'columns', public.rep_two_col('Particulars'),
    'sections', jsonb_build_array(
      jsonb_build_object('title', 'What the shop owes and the owner''s money',
                         'columns', public.rep_two_col('Liabilities'),
                         'rows', v_liab,
                         'totals', public.rep_row('Total', v_l, 'total')),
      jsonb_build_object('title', 'What the shop owns',
                         'columns', public.rep_two_col('Assets'),
                         'rows', v_assets,
                         'totals', public.rep_row('Total', v_a, 'total'))),
    'rows', '[]'::jsonb,
    'totals', jsonb_build_object('particulars', 'Difference',
                                 'amount', round(v_a - v_l, 2), '_kind', 'total', '_level', 0),
    'balanced', round(v_a, 2) = round(v_l, 2),
    'drill', 'account_id');
end; $$;

-- --- Ledgers, the day book and the cash book -----------------------------

/**
 * One account's entries with a running balance, and the same for one customer,
 * supplier or bank account inside it (BMS's A-3). The running balance is worked out
 * from the opening plus the lines shown, so what is on the screen adds up to what is
 * at the bottom of it.
 */
create or replace function public.rep_sp_ledger(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_acct uuid := (p_filters->>'account_id')::uuid;
  v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_cust uuid := (p_filters->>'customer_id')::uuid;
  v_supp uuid := (p_filters->>'supplier_id')::uuid;
  v_nature text; v_name text; v_opening numeric := 0; v_run numeric;
  v_rows jsonb := '[]'::jsonb; v_r record; v_d numeric := 0; v_c numeric := 0;
begin
  if v_acct is null then raise exception 'PICK_AN_ACCOUNT'; end if;
  if not public.can_see_account(v_acct) then raise exception 'ACCOUNT_NOT_ALLOWED'; end if;
  select g.nature, a.name into v_nature, v_name
  from public.accounts a join public.account_groups g on g.id = a.group_id
  where a.id = v_acct and a.shop_id = p_me.shop_id;
  if v_nature is null then raise exception 'ACCOUNT_NOT_FOUND'; end if;

  select coalesce(sum(case when v_nature in ('asset', 'expense')
                           then l.debit - l.credit else l.credit - l.debit end), 0)
    into v_opening
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  where l.account_id = v_acct and e.status = 'posted'
    and v_from is not null and e.entry_date < v_from
    and (v_branch is null or e.branch_id = v_branch)
    and (v_cust is null or l.customer_id = v_cust)
    and (v_supp is null or l.supplier_id = v_supp)
    and public.can_use_branch(e.branch_id);

  v_run := v_opening;
  for v_r in
    select e.entry_no, e.entry_date, e.narration, e.source_kind, e.id as entry_id,
           l.debit, l.credit, l.note, st.name as who, b.name as branch,
           coalesce(c.name_text, c.company, c.phone, s.name) as party
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.branches b on b.id = e.branch_id
    join public.staff st on st.id = e.staff_id
    left join public.customers c on c.id = l.customer_id
    left join public.suppliers s on s.id = l.supplier_id
    where l.account_id = v_acct and e.status = 'posted'
      and (v_from is null or e.entry_date >= v_from) and e.entry_date <= v_to
      and (v_branch is null or e.branch_id = v_branch)
      and (v_cust is null or l.customer_id = v_cust)
      and (v_supp is null or l.supplier_id = v_supp)
      and public.can_use_branch(e.branch_id)
    order by e.entry_date, e.created_at
  loop
    v_run := v_run + case when v_nature in ('asset', 'expense')
                          then v_r.debit - v_r.credit else v_r.credit - v_r.debit end;
    v_d := v_d + v_r.debit; v_c := v_c + v_r.credit;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'd', v_r.entry_date, 'entry_no', v_r.entry_no,
      'particulars', coalesce(v_r.party, v_r.note, initcap(replace(v_r.source_kind, '_', ' '))),
      'narration', coalesce(v_r.narration, '—'), 'branch', v_r.branch, 'who', v_r.who,
      'debit', v_r.debit, 'credit', v_r.credit, 'balance', round(v_run, 2),
      'entry_id', v_r.entry_id, '_kind', 'detail', '_level', 1));
  end loop;

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'd', 'l', 'Date', 't', 'date'),
      jsonb_build_object('f', 'entry_no', 'l', 'Voucher', 't', 'text'),
      jsonb_build_object('f', 'particulars', 'l', 'Particulars', 't', 'text'),
      jsonb_build_object('f', 'narration', 'l', 'Narration', 't', 'text'),
      jsonb_build_object('f', 'debit', 'l', 'Debit', 't', 'money'),
      jsonb_build_object('f', 'credit', 'l', 'Credit', 't', 'money'),
      jsonb_build_object('f', 'balance', 'l', 'Balance', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'debit', v_d, 'credit', v_c,
                                 'balance', round(v_run, 2), '_kind', 'total', '_level', 0),
    'opening', round(v_opening, 2),
    'account', v_name);
end; $$;

/**
 * The cash book, and the bank book: the same report, one account at a time.
 *
 * This is what a shift's counted cash is checked against, so it shows the opening, every
 * movement and the closing — and nothing else, because an owner reading it at the end of
 * the day is trying to answer one question.
 */
create or replace function public.rep_sp_cash_book(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_roles text[] := case when p_def.key = 'R-2' then array['bank', 'wallet']
                         else array['cash_in_hand'] end;
  v_sections jsonb := '[]'::jsonb; v_a record; v_body jsonb;
begin
  for v_a in
    select a.id, a.name from public.accounts a
    where a.shop_id = p_me.shop_id and a.role = any(v_roles) and public.can_see_account(a.id)
      and (p_filters->>'account_id' is null or a.id = (p_filters->>'account_id')::uuid)
      and (p_filters->>'branch_id' is null or a.branch_id is null
           or a.branch_id = (p_filters->>'branch_id')::uuid)
    order by a.code
  loop
    v_body := public.rep_sp_ledger(p_def, p_filters || jsonb_build_object('account_id', v_a.id), p_me);
    v_sections := v_sections || jsonb_build_array(jsonb_build_object(
      'title', v_a.name, 'columns', v_body->'columns', 'rows', v_body->'rows',
      'totals', v_body->'totals', 'opening', v_body->'opening'));
  end loop;
  -- A shop with no bank account is not an error, it is a shop that keeps its money in
  -- a drawer. Say so rather than failing.
  if jsonb_array_length(v_sections) = 0 then
    return jsonb_build_object(
      'columns', public.rep_two_col('Particulars'), 'rows', '[]'::jsonb,
      'totals', '{}'::jsonb,
      'note_extra', case when p_def.key = 'R-2'
        then 'This shop has no bank account or wallet on its books yet (Accounts → Chart).'
        else 'There is no cash account on the books yet (Accounts → Chart).' end);
  end if;
  return jsonb_build_object('columns', (v_sections->0)->'columns',
                            'sections', v_sections, 'rows', '[]'::jsonb,
                            'totals', '{}'::jsonb);
end; $$;

/**
 * The day book: everything that happened, by kind, with the cash and bank summary
 * underneath (BMS's A-10). Its summary prints three different "cash in hand" blocks
 * with three different openings, only the last of which is the day's; here there is one
 * block per account and opening + in − out = closing.
 */
create or replace function public.rep_sp_day_book(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := coalesce((p_filters->>'from')::date, public.dhaka_today());
  v_to date := coalesce((p_filters->>'to')::date, (p_filters->>'from')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_rows jsonb := '[]'::jsonb; v_r record; v_kind text := null;
  v_sd numeric := 0; v_sc numeric := 0; v_td numeric := 0; v_tc numeric := 0;
  v_summary jsonb := '[]'::jsonb; v_a record; v_open numeric; v_in numeric; v_out numeric;
begin
  for v_r in
    select e.entry_date, e.entry_no, e.narration, e.source_kind,
           initcap(replace(e.source_kind, '_', ' ')) as kind,
           sum(l.debit) as debit, sum(l.credit) as credit,
           max(coalesce(c.name_text, c.company, c.phone, s.name, '—')) as party, e.id as entry_id
    from public.journal_entries e
    join public.journal_lines l on l.entry_id = e.id
    left join public.customers c on c.id = l.customer_id
    left join public.suppliers s on s.id = l.supplier_id
    where e.shop_id = p_me.shop_id and e.status = 'posted'
      and e.entry_date between v_from and v_to
      and (v_branch is null or e.branch_id = v_branch)
      and public.can_use_branch(e.branch_id)
    group by e.id, e.entry_date, e.entry_no, e.narration, e.source_kind
    order by initcap(replace(e.source_kind, '_', ' ')), e.entry_date, e.entry_no
  loop
    if v_kind is not null and v_r.kind <> v_kind then
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'particulars', v_kind || ' total', 'debit', v_sd, 'credit', v_sc,
        '_kind', 'subtotal', '_level', 1));
      v_sd := 0; v_sc := 0;
    end if;
    v_kind := v_r.kind;
    v_sd := v_sd + v_r.debit; v_sc := v_sc + v_r.credit;
    v_td := v_td + v_r.debit; v_tc := v_tc + v_r.credit;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'kind', v_r.kind, 'd', v_r.entry_date, 'entry_no', v_r.entry_no,
      'particulars', v_r.party, 'narration', coalesce(v_r.narration, '—'),
      'debit', v_r.debit, 'credit', v_r.credit, 'entry_id', v_r.entry_id,
      '_kind', 'detail', '_level', 2));
  end loop;
  if v_kind is not null then
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'particulars', v_kind || ' total', 'debit', v_sd, 'credit', v_sc,
      '_kind', 'subtotal', '_level', 1));
  end if;

  for v_a in
    select a.id, a.name from public.accounts a
    where a.shop_id = p_me.shop_id and a.role in ('cash_in_hand', 'bank', 'wallet')
      and public.can_see_account(a.id)
      and (v_branch is null or a.branch_id is null or a.branch_id = v_branch)
    order by a.code
  loop
    select coalesce(sum(l.debit - l.credit), 0) into v_open
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
    where l.account_id = v_a.id and e.status = 'posted' and e.entry_date < v_from
      and (v_branch is null or e.branch_id = v_branch) and public.can_use_branch(e.branch_id);
    select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0) into v_in, v_out
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
    where l.account_id = v_a.id and e.status = 'posted'
      and e.entry_date between v_from and v_to
      and (v_branch is null or e.branch_id = v_branch) and public.can_use_branch(e.branch_id);
    if v_open <> 0 or v_in <> 0 or v_out <> 0 then
      v_summary := v_summary || jsonb_build_array(jsonb_build_object(
        'particulars', v_a.name, 'account_id', v_a.id, 'opening', v_open,
        'took_in', v_in, 'paid_out', v_out, 'closing', v_open + v_in - v_out,
        '_kind', 'detail', '_level', 1));
    end if;
  end loop;

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'kind', 'l', 'Kind', 't', 'text'),
      jsonb_build_object('f', 'd', 'l', 'Date', 't', 'date'),
      jsonb_build_object('f', 'entry_no', 'l', 'Voucher', 't', 'text'),
      jsonb_build_object('f', 'particulars', 'l', 'Trader', 't', 'text'),
      jsonb_build_object('f', 'narration', 'l', 'Narration', 't', 'text'),
      jsonb_build_object('f', 'debit', 'l', 'Debit', 't', 'money'),
      jsonb_build_object('f', 'credit', 'l', 'Credit', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'debit', v_td, 'credit', v_tc,
                                 '_kind', 'total', '_level', 0),
    'sections', jsonb_build_array(jsonb_build_object(
      'title', 'Cash and bank for the period',
      'columns', jsonb_build_array(
        jsonb_build_object('f', 'particulars', 'l', 'Account', 't', 'text'),
        jsonb_build_object('f', 'opening', 'l', 'Opening', 't', 'money'),
        jsonb_build_object('f', 'took_in', 'l', 'In', 't', 'money'),
        jsonb_build_object('f', 'paid_out', 'l', 'Out', 't', 'money'),
        jsonb_build_object('f', 'closing', 'l', 'Closing', 't', 'money')),
      'rows', v_summary, 'totals', '{}'::jsonb)),
    'drill', 'entry_id');
end; $$;

-- --- Who owes what -------------------------------------------------------

/**
 * The due list, in two sections: money coming in, then money going out.
 *
 * BMS prints customer debts and supplier credits in one column with mixed signs, so
 * adding the column up gives a number that means nothing. A SUPPLIER WHO OWES US goes
 * under receivable and a CUSTOMER IN CREDIT under payable, because that is where the
 * money actually is.
 *
 * A-12 counts cheques that have not cleared yet as still owed, which is the honest view
 * until the bank says otherwise; A-7 takes them as settled.
 */
create or replace function public.rep_sp_due_list(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_as_on date := coalesce((p_filters->>'as_on')::date, public.dhaka_today());
  v_uncleared boolean := p_def.key = 'A-12';
  v_recv jsonb := '[]'::jsonb; v_pay jsonb := '[]'::jsonb;
  v_r record; v_tr numeric := 0; v_tp numeric := 0; v_due numeric;
  v_cols jsonb := jsonb_build_array(
    jsonb_build_object('f', 'kind', 'l', 'Kind', 't', 'text'),
    jsonb_build_object('f', 'trader_group', 'l', 'Group', 't', 'text'),
    jsonb_build_object('f', 'particulars', 'l', 'Name', 't', 'text'),
    jsonb_build_object('f', 'address', 'l', 'Address', 't', 'text'),
    jsonb_build_object('f', 'mobile', 'l', 'Mobile', 't', 'text'),
    jsonb_build_object('f', 'amount', 'l', 'Due', 't', 'money'));
begin
  for v_r in
    select * from public.rep_party_dues(p_me.shop_id, v_as_on) d
    order by d.kind, d.trader_group, d.name
  loop
    v_due := round(v_r.due + case when v_uncleared then v_r.uncleared else 0 end, 2);
    if v_due = 0 then continue; end if;
    -- Which side it goes on depends on the sign, not on whether they are a customer.
    if (v_r.kind = 'Customer' and v_due > 0) or (v_r.kind = 'Supplier' and v_due < 0) then
      v_tr := v_tr + abs(v_due);
      v_recv := v_recv || jsonb_build_array(jsonb_build_object(
        'kind', v_r.kind, 'trader_group', v_r.trader_group, 'particulars', v_r.name,
        'address', v_r.address, 'mobile', v_r.mobile, 'amount', abs(v_due),
        'customer_id', case when v_r.kind = 'Customer' then v_r.party_id end,
        'supplier_id', case when v_r.kind = 'Supplier' then v_r.party_id end,
        '_kind', 'detail', '_level', 1));
    else
      v_tp := v_tp + abs(v_due);
      v_pay := v_pay || jsonb_build_array(jsonb_build_object(
        'kind', v_r.kind, 'trader_group', v_r.trader_group, 'particulars', v_r.name,
        'address', v_r.address, 'mobile', v_r.mobile, 'amount', abs(v_due),
        'customer_id', case when v_r.kind = 'Customer' then v_r.party_id end,
        'supplier_id', case when v_r.kind = 'Supplier' then v_r.party_id end,
        '_kind', 'detail', '_level', 1));
    end if;
  end loop;

  return jsonb_build_object(
    'columns', v_cols, 'rows', '[]'::jsonb,
    'sections', jsonb_build_array(
      jsonb_build_object('title', 'Owed to the shop', 'columns', v_cols, 'rows', v_recv,
                         'totals', public.rep_row('Total owed to the shop', v_tr, 'total')),
      jsonb_build_object('title', 'Owed by the shop', 'columns', v_cols, 'rows', v_pay,
                         'totals', public.rep_row('Total owed by the shop', v_tp, 'total'))),
    'totals', jsonb_build_object('particulars', 'Net position',
                                 'amount', round(v_tr - v_tp, 2), '_kind', 'total', '_level', 0));
end; $$;

/** The same, branch by branch, from the documents each branch raised (BMS's A-1). */
create or replace function public.rep_sp_branch_dues(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_as_on date := coalesce((p_filters->>'as_on')::date, public.dhaka_today());
  v_cols jsonb; v_rows jsonb := '[]'::jsonb; v_r record;
  v_tr numeric := 0; v_tp numeric := 0;
begin
  v_cols := jsonb_build_array(
    jsonb_build_object('f', 'branch', 'l', 'Branch', 't', 'text'),
    jsonb_build_object('f', 'particulars', 'l', 'Group', 't', 'text'),
    jsonb_build_object('f', 'receivable', 'l', 'Owed to the shop', 't', 'money'),
    jsonb_build_object('f', 'payable', 'l', 'Owed by the shop', 't', 'money'));

  for v_r in
    select b.name as branch, grp,
           sum(receivable) as receivable, sum(payable) as payable
    from (
      select s.branch_id, coalesce(cg.name, 'Retail') as grp,
             sum(s.due_amount) as receivable, 0::numeric as payable
      from public.sales s
      left join public.customers c on c.id = s.customer_id
      left join public.customer_groups cg on cg.id = c.group_id
      where s.shop_id = p_me.shop_id and s.status = 'completed' and s.due_amount > 0
        and public.dhaka_date(s.created_at) <= v_as_on
      group by s.branch_id, coalesce(cg.name, 'Retail')
      union all
      select g.branch_id, 'Supplier', 0::numeric, sum(g.total)
      from public.grns g
      where g.shop_id = p_me.shop_id and g.is_credit
        and public.dhaka_date(g.created_at) <= v_as_on
      group by g.branch_id
      union all
      select cp.branch_id, 'Retail', -sum(cp.amount), 0::numeric
      from public.customer_payments cp
      where cp.shop_id = p_me.shop_id and public.dhaka_date(cp.created_at) <= v_as_on
      group by cp.branch_id
      union all
      select sp.branch_id, 'Supplier', 0::numeric, -sum(sp.amount)
      from public.supplier_payments sp
      where sp.shop_id = p_me.shop_id and sp.paid_on <= v_as_on
      group by sp.branch_id
    ) q
    join public.branches b on b.id = q.branch_id
    where public.can_use_branch(q.branch_id)
      and (p_filters->>'branch_id' is null or q.branch_id = (p_filters->>'branch_id')::uuid)
    group by b.name, grp
    having sum(receivable) <> 0 or sum(payable) <> 0
    order by b.name, grp
  loop
    v_tr := v_tr + v_r.receivable; v_tp := v_tp + v_r.payable;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'branch', v_r.branch, 'particulars', v_r.grp,
      'receivable', round(v_r.receivable, 2), 'payable', round(v_r.payable, 2),
      '_kind', 'detail', '_level', 1));
  end loop;

  return jsonb_build_object(
    'columns', v_cols, 'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'receivable', round(v_tr, 2),
                                 'payable', round(v_tp, 2), '_kind', 'total', '_level', 0),
    'note_extra', 'Opening balances brought over from the old system are not tied to a branch and are left out of this one.');
end; $$;

/**
 * Sales and what actually came in (BMS's A-14 and A-15).
 *
 * BMS shows a cash sale under Sales and nothing under Received, because it never
 * records the payment — which is the single thing that made its cash reports useless.
 * Here the money is recorded, so this report says what it is supposed to say.
 */
create or replace function public.rep_sp_sales_received(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_detail boolean := p_def.key = 'A-15';
  v_rows jsonb := '[]'::jsonb; v_r record;
  v_t1 numeric := 0; v_t2 numeric := 0; v_t3 numeric := 0; v_t4 numeric := 0;
begin
  for v_r in
    select case when v_detail then coalesce(c.name_text, c.company, c.phone, 'Cash customer')
                else coalesce(cg.name, 'Cash customer') end as who,
           c.id as customer_id,
           coalesce(sum(s.total), 0) as sales,
           coalesce(sum(s.discount_amount), 0) as discount,
           coalesce(sum(s.paid_amount), 0) as received,
           coalesce(sum(s.due_amount), 0) as due
    from public.sales s
    left join public.customers c on c.id = s.customer_id
    left join public.customer_groups cg on cg.id = c.group_id
    where s.shop_id = p_me.shop_id and s.status = 'completed'
      and (v_from is null or public.dhaka_date(s.created_at) >= v_from)
      and public.dhaka_date(s.created_at) <= v_to
      and (v_branch is null or s.branch_id = v_branch)
      and public.can_use_branch(s.branch_id)
    group by 1, 2
    having coalesce(sum(s.total), 0) <> 0
    order by 1
  loop
    v_t1 := v_t1 + v_r.sales; v_t2 := v_t2 + v_r.discount;
    v_t3 := v_t3 + v_r.received; v_t4 := v_t4 + v_r.due;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'particulars', v_r.who, 'customer_id', v_r.customer_id,
      'sales', v_r.sales, 'discount', v_r.discount,
      'received', v_r.received, 'due', v_r.due,
      '_kind', 'detail', '_level', 1));
  end loop;

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'particulars', 'l', case when v_detail then 'Customer' else 'Kind of customer' end, 't', 'text'),
      jsonb_build_object('f', 'sales', 'l', 'Sales', 't', 'money'),
      jsonb_build_object('f', 'discount', 'l', 'Discount', 't', 'money'),
      jsonb_build_object('f', 'received', 'l', 'Received', 't', 'money'),
      jsonb_build_object('f', 'due', 'l', 'Left on due', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'sales', v_t1, 'discount', v_t2,
                                 'received', v_t3, 'due', v_t4, '_kind', 'total', '_level', 0));
end; $$;

/**
 * The supplier statement (P-22) and the trader statement (S-16).
 *
 * One row per party: what they were owed at the start, what happened, what is left. A
 * CASH PURCHASE SHOWS THE SAME FIGURE AS BOUGHT AND AS PAID, which is what makes the
 * closing balance come out right. A trader in this market is often both a customer and
 * a supplier, so S-16 shows both sides of one name.
 */
create or replace function public.rep_sp_supplier_statement(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_rows jsonb := '[]'::jsonb; v_r record;
  v_t jsonb := '{}'::jsonb;
  v_o numeric := 0; v_b numeric := 0; v_rt numeric := 0; v_p numeric := 0; v_cl numeric := 0;
begin
  for v_r in
    select s.id, s.name, coalesce(sg.name, 'N/A') as grp,
      coalesce((select ob.amount from public.opening_balances ob where ob.supplier_id = s.id
                and (v_from is null or ob.as_of < v_from)), 0)
      + coalesce((select sum(g.total) from public.grns g where g.supplier_id = s.id and g.is_credit
                  and v_from is not null and public.dhaka_date(g.created_at) < v_from), 0)
      - coalesce((select sum(sp.amount) from public.supplier_payments sp where sp.supplier_id = s.id
                  and v_from is not null and sp.paid_on < v_from), 0)
      - coalesce((select sum(sr.total) from public.supplier_returns sr where sr.supplier_id = s.id
                  and v_from is not null and public.dhaka_date(sr.created_at) < v_from), 0) as opening,
      coalesce((select sum(g.total) from public.grns g where g.supplier_id = s.id
                and public.dhaka_date(g.created_at) <= v_to
                and (v_from is null or public.dhaka_date(g.created_at) >= v_from)), 0) as bought,
      coalesce((select sum(sr.total) from public.supplier_returns sr where sr.supplier_id = s.id
                and public.dhaka_date(sr.created_at) <= v_to
                and (v_from is null or public.dhaka_date(sr.created_at) >= v_from)), 0) as returned,
      coalesce((select sum(sp.amount) from public.supplier_payments sp where sp.supplier_id = s.id
                and sp.paid_on <= v_to and (v_from is null or sp.paid_on >= v_from)), 0) as paid
    from public.suppliers s
    left join public.supplier_groups sg on sg.id = s.group_id
    where s.shop_id = p_me.shop_id
    order by coalesce(sg.name, 'N/A'), s.name
  loop
    if v_r.opening = 0 and v_r.bought = 0 and v_r.returned = 0 and v_r.paid = 0 then
      continue;
    end if;
    v_o := v_o + v_r.opening; v_b := v_b + v_r.bought;
    v_rt := v_rt + v_r.returned; v_p := v_p + v_r.paid;
    v_cl := v_cl + v_r.opening + v_r.bought - v_r.returned - v_r.paid;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'trader_group', v_r.grp, 'particulars', v_r.name, 'supplier_id', v_r.id,
      'opening', v_r.opening, 'bought', v_r.bought, 'returned', v_r.returned,
      'net', v_r.bought - v_r.returned, 'paid', v_r.paid,
      'closing', v_r.opening + v_r.bought - v_r.returned - v_r.paid,
      '_kind', 'detail', '_level', 1));
  end loop;

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'trader_group', 'l', 'Group', 't', 'text'),
      jsonb_build_object('f', 'particulars', 'l', 'Supplier Name', 't', 'text'),
      jsonb_build_object('f', 'opening', 'l', 'Opening Balance', 't', 'money'),
      jsonb_build_object('f', 'bought', 'l', 'Purchase', 't', 'money'),
      jsonb_build_object('f', 'returned', 'l', 'Purchase Return', 't', 'money'),
      jsonb_build_object('f', 'net', 'l', 'Net Purchase', 't', 'money'),
      jsonb_build_object('f', 'paid', 'l', 'Payment', 't', 'money'),
      jsonb_build_object('f', 'closing', 'l', 'Closing Balance', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'opening', v_o, 'bought', v_b,
      'returned', v_rt, 'net', v_b - v_rt, 'paid', v_p, 'closing', v_cl,
      '_kind', 'total', '_level', 0));
end; $$;

create or replace function public.rep_sp_trader_statement(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_rows jsonb := '[]'::jsonb; v_r record;
  v_t1 numeric := 0; v_t2 numeric := 0; v_t3 numeric := 0; v_t4 numeric := 0;
  v_t5 numeric := 0; v_t6 numeric := 0;
begin
  for v_r in
    select c.id, coalesce(c.name_text, c.company, c.phone) as name,
           coalesce(cg.name, 'Retail') as grp,
      coalesce((select ob.amount from public.opening_balances ob where ob.customer_id = c.id
                and (v_from is null or ob.as_of < v_from)), 0)
      + coalesce((select sum(s.due_amount) from public.sales s where s.customer_id = c.id
                  and s.status = 'completed' and v_from is not null
                  and public.dhaka_date(s.created_at) < v_from), 0)
      - coalesce((select sum(cp.amount) from public.customer_payments cp where cp.customer_id = c.id
                  and v_from is not null and public.dhaka_date(cp.created_at) < v_from), 0) as opening,
      coalesce((select sum(s.total) from public.sales s where s.customer_id = c.id
                and s.status = 'completed' and public.dhaka_date(s.created_at) <= v_to
                and (v_from is null or public.dhaka_date(s.created_at) >= v_from)), 0) as sales,
      coalesce((select sum(s.discount_amount) from public.sales s where s.customer_id = c.id
                and s.status = 'completed' and public.dhaka_date(s.created_at) <= v_to
                and (v_from is null or public.dhaka_date(s.created_at) >= v_from)), 0) as discount,
      coalesce((select sum(r.total) from public.sale_returns r where r.customer_id = c.id
                and r.approval_status <> 'cancelled' and public.dhaka_date(r.created_at) <= v_to
                and (v_from is null or public.dhaka_date(r.created_at) >= v_from)), 0) as returned,
      coalesce((select sum(cp.amount) from public.customer_payments cp where cp.customer_id = c.id
                and public.dhaka_date(cp.created_at) <= v_to
                and (v_from is null or public.dhaka_date(cp.created_at) >= v_from)), 0) as received,
      public.customer_due(c.id) as due
    from public.customers c
    left join public.customer_groups cg on cg.id = c.group_id
    where c.shop_id = p_me.shop_id
    order by coalesce(cg.name, 'Retail'), 2
  loop
    if v_r.opening = 0 and v_r.sales = 0 and v_r.returned = 0 and v_r.received = 0 then
      continue;
    end if;
    v_t1 := v_t1 + v_r.opening; v_t2 := v_t2 + v_r.sales; v_t3 := v_t3 + v_r.returned;
    v_t4 := v_t4 + v_r.received; v_t5 := v_t5 + v_r.discount; v_t6 := v_t6 + v_r.due;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'trader_group', v_r.grp, 'particulars', v_r.name, 'customer_id', v_r.id,
      'opening', v_r.opening, 'sales', v_r.sales, 'returned', v_r.returned,
      'net', v_r.sales - v_r.returned, 'discount', v_r.discount,
      'received', v_r.received, 'due', v_r.due,
      '_kind', 'detail', '_level', 1));
  end loop;

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'trader_group', 'l', 'Group', 't', 'text'),
      jsonb_build_object('f', 'particulars', 'l', 'Trader Name', 't', 'text'),
      jsonb_build_object('f', 'opening', 'l', 'Opening', 't', 'money'),
      jsonb_build_object('f', 'sales', 'l', 'Sales', 't', 'money'),
      jsonb_build_object('f', 'returned', 'l', 'Sales Return', 't', 'money'),
      jsonb_build_object('f', 'net', 'l', 'Net Sales', 't', 'money'),
      jsonb_build_object('f', 'discount', 'l', 'Discount', 't', 'money'),
      jsonb_build_object('f', 'received', 'l', 'Received', 't', 'money'),
      jsonb_build_object('f', 'due', 'l', 'Due now', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'opening', v_t1, 'sales', v_t2,
      'returned', v_t3, 'net', v_t2 - v_t3, 'discount', v_t5, 'received', v_t4,
      'due', v_t6, '_kind', 'total', '_level', 0));
end; $$;

-- --- Stock: the ledger, what moved, and what it is worth ------------------

/**
 * One product's stock ledger (BMS's ST-7, ST-14, ST-19).
 *
 * Every movement with a running balance. This is the report that makes every other
 * stock figure checkable: if the valuation and the books disagree, this is where you
 * find out which movement did it.
 */
create or replace function public.rep_sp_product_ledger(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_prod uuid := (p_filters->>'product_id')::uuid;
  v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_by_place boolean := p_def.key = 'ST-19';
  v_open bigint := 0; v_run bigint; v_rows jsonb := '[]'::jsonb; v_r record;
  v_in bigint := 0; v_out bigint := 0; v_name text; v_ordered integer := 0;
begin
  if v_prod is null then raise exception 'PICK_A_PRODUCT'; end if;
  select name into v_name from public.products where id = v_prod and shop_id = p_me.shop_id;
  if v_name is null then raise exception 'NO_SUCH_PRODUCT'; end if;

  select coalesce(sum(m.qty_change), 0) into v_open
  from public.stock_movements m
  where m.product_id = v_prod and m.branch_id is not null
    and public.can_use_branch(m.branch_id)
    and (v_branch is null or m.branch_id = v_branch)
    and v_from is not null and public.dhaka_date(m.created_at) < v_from;

  v_run := v_open;
  for v_r in
    select m.*, public.dhaka_date(m.created_at) as d, b.name as branch,
           l.name as location, st.name as who
    from public.stock_movements m
    join public.branches b on b.id = m.branch_id
    left join public.stock_locations l on l.id = m.location_id
    left join public.staff st on st.id = m.staff_id
    where m.product_id = v_prod and m.branch_id is not null
      and public.can_use_branch(m.branch_id)
      and (v_branch is null or m.branch_id = v_branch)
      and (v_from is null or public.dhaka_date(m.created_at) >= v_from)
      and public.dhaka_date(m.created_at) <= v_to
    order by m.created_at, m.id
  loop
    v_run := v_run + v_r.qty_change;
    if v_r.qty_change > 0 then v_in := v_in + v_r.qty_change;
    else v_out := v_out - v_r.qty_change; end if;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'd', v_r.d, 'branch', v_r.branch,
      'location', coalesce(v_r.location, 'Main store'),
      'particulars', initcap(replace(v_r.reason, '_', ' '))
                     || coalesce(' (' || v_r.reason_detail || ')', ''),
      'narration', coalesce(v_r.note, '—'), 'who', coalesce(v_r.who, 'System'),
      'took_in', case when v_r.qty_change > 0 then v_r.qty_change else 0 end,
      'paid_out', case when v_r.qty_change < 0 then -v_r.qty_change else 0 end,
      'balance', v_run, '_kind', 'detail', '_level', 1));
  end loop;

  -- "With order" (ST-14) also shows what is on an unfulfilled purchase order, because
  -- "do I need to buy more?" is a different question from "what is on the shelf?".
  if p_def.key = 'ST-14' then
    select coalesce(sum(greatest(i.qty - i.received_qty, 0)), 0)::integer into v_ordered
    from public.purchase_order_items i
    join public.purchase_orders o on o.id = i.po_id
    where i.product_id = v_prod and o.status in ('sent', 'partly_received', 'awaiting_approval');
  end if;

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'd', 'l', 'Date', 't', 'date'),
      jsonb_build_object('f', 'branch', 'l', 'Branch', 't', 'text'))
      || case when v_by_place then jsonb_build_array(
           jsonb_build_object('f', 'location', 'l', 'Store', 't', 'text'))
         else '[]'::jsonb end
      || jsonb_build_array(
      jsonb_build_object('f', 'particulars', 'l', 'What happened', 't', 'text'),
      jsonb_build_object('f', 'narration', 'l', 'Document', 't', 'text'),
      jsonb_build_object('f', 'who', 'l', 'Who', 't', 'text'),
      jsonb_build_object('f', 'took_in', 'l', 'In', 't', 'qty'),
      jsonb_build_object('f', 'paid_out', 'l', 'Out', 't', 'qty'),
      jsonb_build_object('f', 'balance', 'l', 'Balance', 't', 'qty')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'took_in', v_in, 'paid_out', v_out,
                                 'balance', v_run, '_kind', 'total', '_level', 0),
    'opening', v_open,
    'on_order', v_ordered,
    'account', v_name);
end; $$;

/**
 * What moved and what is left (BMS's ST-12, its stock movement summary).
 *
 * Closing = opening + bought − returned to supplier − sold + taken back + found −
 * written off − sent + received. The arithmetic is printed, so a figure that looks
 * wrong can be argued with; and it must reconcile with the stock report at both ends of
 * the period, which is a check in supabase/tests.
 */
create or replace function public.rep_sp_product_status(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_rows jsonb := '[]'::jsonb; v_r record; v_t jsonb := '{}'::jsonb;
  v_o bigint := 0; v_pu bigint := 0; v_pr bigint := 0; v_sa bigint := 0; v_sr bigint := 0;
  v_ai bigint := 0; v_ao bigint := 0; v_tr bigint := 0; v_rc bigint := 0; v_cl bigint := 0;
  v_oi bigint := 0; v_oo bigint := 0;
begin
  for v_r in
    select p.id, coalesce(cat.name, 'N/A') as category, coalesce(p.brand, 'N/A') as brand,
           coalesce(p.model, p.code) as model, p.name as product,
           coalesce(sum(case when public.dhaka_date(m.created_at) < v_from
                             then m.qty_change else 0 end), 0) as opening,
           coalesce(sum(case when m.reason = 'purchase' and m.qty_change > 0 and inp then m.qty_change else 0 end), 0) as purchased,
           coalesce(sum(case when m.reason = 'return_to_supplier' and inp then -m.qty_change else 0 end), 0) as to_supplier,
           coalesce(sum(case when m.reason = 'sale' and inp then -m.qty_change else 0 end), 0) as sold,
           coalesce(sum(case when m.reason = 'return' and inp then m.qty_change else 0 end), 0) as taken_back,
           coalesce(sum(case when m.reason = 'adjust_in' and inp then m.qty_change else 0 end), 0) as found,
           coalesce(sum(case when m.reason = 'adjust_out' and inp then -m.qty_change else 0 end), 0) as written_off,
           coalesce(sum(case when m.reason = 'transfer_out' and inp then -m.qty_change else 0 end), 0) as sent,
           coalesce(sum(case when m.reason = 'transfer_in' and inp then m.qty_change else 0 end), 0) as received,
           -- BMS calls these "Others In / Others Out": a stock count, and anything a
           -- later version of this app starts recording. Named rather than swept into
           -- the closing figure, so the line always adds up and an unexpected kind of
           -- movement shows itself instead of hiding in the total.
           coalesce(sum(case when m.reason = 'count' and inp and m.qty_change > 0
                             then m.qty_change else 0 end), 0) as others_in,
           coalesce(sum(case when m.reason = 'count' and inp and m.qty_change < 0
                             then -m.qty_change else 0 end), 0) as others_out,
           coalesce(sum(m.qty_change), 0) as closing
    from public.stock_movements m
    cross join lateral (select (v_from is null or public.dhaka_date(m.created_at) >= v_from) as inp) f
    join public.products p on p.id = m.product_id
    left join public.categories cat on cat.id = p.category_id
    where m.shop_id = p_me.shop_id and m.branch_id is not null
      and public.can_use_branch(m.branch_id)
      and (v_branch is null or m.branch_id = v_branch)
      and public.dhaka_date(m.created_at) <= v_to
    group by p.id, cat.name, p.brand, p.model, p.code, p.name
    having coalesce(sum(m.qty_change), 0) <> 0
        or coalesce(sum(case when f.inp then abs(m.qty_change) else 0 end), 0) <> 0
    order by coalesce(cat.name, 'N/A'), coalesce(p.brand, 'N/A'), p.name
  loop
    v_o := v_o + v_r.opening; v_pu := v_pu + v_r.purchased; v_pr := v_pr + v_r.to_supplier;
    v_sa := v_sa + v_r.sold; v_sr := v_sr + v_r.taken_back; v_ai := v_ai + v_r.found;
    v_ao := v_ao + v_r.written_off; v_tr := v_tr + v_r.sent; v_rc := v_rc + v_r.received;
    v_oi := v_oi + v_r.others_in; v_oo := v_oo + v_r.others_out;
    v_cl := v_cl + v_r.closing;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'category', v_r.category, 'brand', v_r.brand, 'model', v_r.model,
      'product', v_r.product, 'product_id', v_r.id,
      'opening', v_r.opening, 'purchased', v_r.purchased, 'to_supplier', v_r.to_supplier,
      'sold', v_r.sold, 'taken_back', v_r.taken_back, 'found', v_r.found,
      'written_off', v_r.written_off, 'sent', v_r.sent, 'received', v_r.received,
      'others_in', v_r.others_in, 'others_out', v_r.others_out,
      'closing', v_r.closing, '_kind', 'detail', '_level', 1));
  end loop;

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'category', 'l', 'Product Group', 't', 'text'),
      jsonb_build_object('f', 'model', 'l', 'Model No', 't', 'text'),
      jsonb_build_object('f', 'product', 'l', 'Product', 't', 'text'),
      jsonb_build_object('f', 'opening', 'l', 'Opening', 't', 'qty'),
      jsonb_build_object('f', 'purchased', 'l', 'Bought', 't', 'qty'),
      jsonb_build_object('f', 'to_supplier', 'l', 'Back to supplier', 't', 'qty'),
      jsonb_build_object('f', 'sold', 'l', 'Sold', 't', 'qty'),
      jsonb_build_object('f', 'taken_back', 'l', 'Taken back', 't', 'qty'),
      jsonb_build_object('f', 'found', 'l', 'Found', 't', 'qty'),
      jsonb_build_object('f', 'written_off', 'l', 'Written off', 't', 'qty'),
      jsonb_build_object('f', 'sent', 'l', 'Sent out', 't', 'qty'),
      jsonb_build_object('f', 'received', 'l', 'Received', 't', 'qty'),
      jsonb_build_object('f', 'others_in', 'l', 'Others in', 't', 'qty'),
      jsonb_build_object('f', 'others_out', 'l', 'Others out', 't', 'qty'),
      jsonb_build_object('f', 'closing', 'l', 'Closing', 't', 'qty')),
    'rows', v_rows,
    'totals', jsonb_build_object('product', 'Total', 'opening', v_o, 'purchased', v_pu,
      'to_supplier', v_pr, 'sold', v_sa, 'taken_back', v_sr, 'found', v_ai,
      'written_off', v_ao, 'sent', v_tr, 'received', v_rc,
      'others_in', v_oi, 'others_out', v_oo, 'closing', v_cl,
      '_kind', 'total', '_level', 0),
    'drill', 'product_id');
end; $$;

/**
 * Stock valuation, set against the stock account (the done-when of this prompt).
 *
 * Quantity on the shelf times the weighted average cost, per branch, next to what the
 * books say stock is worth — and the difference, which should be nothing. BMS has two
 * stock figures that differ by four units and no report that compares them, so nobody
 * can tell which one is wrong.
 *
 * Goods in a van are NOT on either shelf (P7), so they are shown on their own line and
 * counted in the comparison: that is where the shop's money actually is.
 */
create or replace function public.rep_sp_stock_valuation(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_as_on date := coalesce((p_filters->>'as_on')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_rows jsonb := '[]'::jsonb; v_r record;
  v_phys numeric := 0; v_books numeric := 0; v_transit numeric := 0; v_unvalued numeric := 0;
begin
  for v_r in
    select s.branch, sum(s.qty) as qty, sum(s.total_cost) as value
    from public.rep_stock_as_on(v_as_on) s
    where s.shop_id = p_me.shop_id and public.can_use_branch(s.branch_id)
      and (v_branch is null or s.branch_id = v_branch)
    group by s.branch order by s.branch
  loop
    v_phys := v_phys + v_r.value;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'particulars', 'On the shelf at ' || v_r.branch, 'qty', v_r.qty,
      'amount', round(v_r.value, 2), '_kind', 'detail', '_level', 1));
  end loop;

  select coalesce(sum(l.debit - l.credit), 0) into v_transit
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  join public.accounts a on a.id = l.account_id
  where a.shop_id = p_me.shop_id and a.role = 'stock_in_transit'
    and e.status = 'posted' and e.entry_date <= v_as_on
    and (v_branch is null or e.branch_id = v_branch)
    and public.can_use_branch(e.branch_id);
  if v_transit <> 0 then
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'particulars', 'In a van between branches', 'amount', round(v_transit, 2),
      '_kind', 'detail', '_level', 1));
  end if;

  select coalesce(sum(l.debit - l.credit), 0) into v_books
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  join public.accounts a on a.id = l.account_id
  where a.shop_id = p_me.shop_id and a.role = 'inventory'
    and e.status = 'posted' and e.entry_date <= v_as_on
    and (v_branch is null or e.branch_id = v_branch)
    and public.can_use_branch(e.branch_id);

  -- Stock that arrived with nobody recording what it cost — usually opening stock
  -- brought over from the old system. The shelf values it at whatever the product
  -- costs TODAY; the books never received a taka for it, because there was no figure
  -- to receive. Naming it is the point: a difference with no explanation is what makes
  -- an owner distrust both reports, and this is the one explanation there is.
  select coalesce(sum(round(coalesce(pc.cost, 0) * l.remaining, 2)), 0) into v_unvalued
  from public.stock_layers l
  left join public.product_costs pc on pc.product_id = l.product_id
  where l.shop_id = p_me.shop_id and l.remaining > 0 and l.unit_cost is null
    and public.can_use_branch(l.branch_id)
    and (v_branch is null or l.branch_id = v_branch);

  if v_unvalued <> 0 then
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'particulars', 'Of that, stock that arrived with no cost recorded',
      'amount', round(-v_unvalued, 2), '_kind', 'detail', '_level', 1));
  end if;

  v_rows := v_rows || jsonb_build_array(
    jsonb_build_object('particulars', 'Stock at cost, counted from the shelves',
                       'amount', round(v_phys - v_unvalued, 2), '_kind', 'subtotal', '_level', 0),
    jsonb_build_object('particulars', 'Stock account in the books',
                       'amount', round(v_books, 2), '_kind', 'subtotal', '_level', 0));

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'particulars', 'l', 'Particulars', 't', 'text'),
      jsonb_build_object('f', 'qty', 'l', 'Qty', 't', 'qty'),
      jsonb_build_object('f', 'amount', 'l', 'Value at cost', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Difference',
      'amount', round(v_books - (v_phys - v_unvalued), 2), '_kind', 'total', '_level', 0),
    -- A shop that does not keep books has nothing to compare the shelves WITH, so the
    -- question does not apply. Saying "they differ" would be blaming it for a feature
    -- it has not switched on.
    'note_extra', case when public.feature_on('accounts') then null
      else 'This shop does not keep accounts yet (Settings → Features → Accounts), '
           || 'so there is nothing to set the shelves against.' end,
    'balanced', case when public.feature_on('accounts')
      then round(v_books, 2) = round(v_phys - v_unvalued, 2) end,
    'stock_value', round(v_phys - v_unvalued, 2),
    'stock_on_shelves', round(v_phys, 2),
    'stock_no_cost', round(v_unvalued, 2),
    'stock_account', round(v_books, 2));
end; $$;

/**
 * The VAT return: what the shop charged, what it paid, and the difference.
 *
 * Only means anything for a shop that charges VAT, so the report says so rather than
 * printing three zeros.
 */
create or replace function public.rep_sp_vat_report(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_out numeric := 0; v_in numeric := 0; v_sales numeric := 0; v_purch numeric := 0;
  v_rows jsonb;
begin
  select coalesce(sum(s.vat_amount), 0), coalesce(sum(s.total - s.vat_amount), 0)
    into v_out, v_sales
  from public.sales s
  where s.shop_id = p_me.shop_id and s.status = 'completed'
    and (v_from is null or public.dhaka_date(s.created_at) >= v_from)
    and public.dhaka_date(s.created_at) <= v_to
    and (v_branch is null or s.branch_id = v_branch)
    and public.can_use_branch(s.branch_id);

  select coalesce(sum(g.vat), 0), coalesce(sum(g.total - g.vat - g.ait), 0)
    into v_in, v_purch
  from public.grns g
  where g.shop_id = p_me.shop_id
    and (v_from is null or public.dhaka_date(g.created_at) >= v_from)
    and public.dhaka_date(g.created_at) <= v_to
    and (v_branch is null or g.branch_id = v_branch)
    and public.can_use_branch(g.branch_id);

  v_rows := jsonb_build_array(
    public.rep_row('Sales in the period, before VAT', v_sales),
    public.rep_row('VAT charged to customers (output VAT)', v_out, 'subtotal'),
    public.rep_row('Purchases in the period, before VAT', v_purch),
    public.rep_row('VAT paid to suppliers (input VAT)', v_in, 'subtotal'));

  return jsonb_build_object(
    'columns', public.rep_two_col('Particulars'),
    'rows', v_rows,
    'totals', public.rep_row(
      case when v_out - v_in >= 0 then 'VAT the shop owes' else 'VAT the shop can reclaim' end,
      abs(round(v_out - v_in, 2)), 'total'),
    'note_extra', case when public.feature_on('vat') then null
                       else 'This shop does not charge VAT (Settings → Features), so these figures will be nil.' end);
end; $$;

/** Profit month by month, and the branches side by side (the prompt's P&L by month). */
create or replace function public.rep_sp_profit_by_month(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := coalesce((p_filters->>'from')::date,
                          date_trunc('month', public.dhaka_today() - interval '5 months')::date);
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_rows jsonb := '[]'::jsonb; v_branches jsonb := '[]'::jsonb; v_r record;
  v_ts numeric := 0; v_tc numeric := 0; v_te numeric := 0;
begin
  for v_r in
    select to_char(d, 'YYYY-MM') as mon,
           sum(amount) as sales, sum(cost) as cost
    from public.v_rep_sale_lines
    where shop_id = p_me.shop_id and d between v_from and v_to
      and public.can_use_branch(branch_id)
      and (v_branch is null or branch_id = v_branch)
    group by 1 order by 1
  loop
    v_ts := v_ts + v_r.sales; v_tc := v_tc + v_r.cost;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'particulars', to_char(to_date(v_r.mon, 'YYYY-MM'), 'FMMonth YYYY'),
      'sales', round(v_r.sales, 2), 'cost', round(v_r.cost, 2),
      'gross', round(v_r.sales - v_r.cost, 2),
      'costs', round(coalesce((
        select sum(l.debit - l.credit) from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
        join public.account_groups g on g.id = a.group_id
        where a.shop_id = p_me.shop_id and g.nature = 'expense' and a.role is null
          and e.status = 'posted' and to_char(e.entry_date, 'YYYY-MM') = v_r.mon
          and (v_branch is null or e.branch_id = v_branch)
          and public.can_use_branch(e.branch_id)), 0), 2),
      '_kind', 'detail', '_level', 1));
  end loop;
  -- Net profit per row, worked out from the two figures above it.
  select coalesce(jsonb_agg(r || jsonb_build_object(
           'net', round((r->>'gross')::numeric - (r->>'costs')::numeric, 2))), '[]'::jsonb)
    into v_rows from jsonb_array_elements(v_rows) r;
  select coalesce(sum((r->>'costs')::numeric), 0) into v_te
    from jsonb_array_elements(v_rows) r;

  for v_r in
    select branch, sum(amount) as sales, sum(cost) as cost
    from public.v_rep_sale_lines
    where shop_id = p_me.shop_id and d between v_from and v_to
      and public.can_use_branch(branch_id)
    group by 1 order by 1
  loop
    v_branches := v_branches || jsonb_build_array(jsonb_build_object(
      'particulars', v_r.branch, 'sales', round(v_r.sales, 2), 'cost', round(v_r.cost, 2),
      'gross', round(v_r.sales - v_r.cost, 2), '_kind', 'detail', '_level', 1));
  end loop;

  return jsonb_build_object(
    'columns', jsonb_build_array(
      jsonb_build_object('f', 'particulars', 'l', 'Month', 't', 'text'),
      jsonb_build_object('f', 'sales', 'l', 'Sales', 't', 'money'),
      jsonb_build_object('f', 'cost', 'l', 'Cost of goods', 't', 'money'),
      jsonb_build_object('f', 'gross', 'l', 'Gross profit', 't', 'money'),
      jsonb_build_object('f', 'costs', 'l', 'Running costs', 't', 'money'),
      jsonb_build_object('f', 'net', 'l', 'Net profit', 't', 'money')),
    'rows', v_rows,
    'totals', jsonb_build_object('particulars', 'Total', 'sales', round(v_ts, 2),
      'cost', round(v_tc, 2), 'gross', round(v_ts - v_tc, 2), 'costs', round(v_te, 2),
      'net', round(v_ts - v_tc - v_te, 2), '_kind', 'total', '_level', 0),
    'sections', jsonb_build_array(jsonb_build_object(
      'title', 'Branch by branch',
      'columns', jsonb_build_array(
        jsonb_build_object('f', 'particulars', 'l', 'Branch', 't', 'text'),
        jsonb_build_object('f', 'sales', 'l', 'Sales', 't', 'money'),
        jsonb_build_object('f', 'cost', 'l', 'Cost of goods', 't', 'money'),
        jsonb_build_object('f', 'gross', 'l', 'Gross profit', 't', 'money')),
      'rows', v_branches, 'totals', '{}'::jsonb)));
end; $$;

/**
 * What happened to each delivery (BMS's P-24).
 *
 * One block per delivery line: how many arrived, how many of THOSE have sold and for
 * how much, what is left, and the profit on the ones that went. This is the report the
 * FIFO layers exist for — without them, "how did that batch do?" cannot be answered at
 * all, only guessed at from averages.
 */
create or replace function public.rep_sp_purchase_movement(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := (p_filters->>'from')::date;
  v_to date := coalesce((p_filters->>'to')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_sections jsonb := '[]'::jsonb; v_l record; v_sold integer; v_revenue numeric;
  v_rows jsonb; v_profit numeric; v_total numeric := 0;
  v_cols jsonb := jsonb_build_array(
    jsonb_build_object('f', 'particulars', 'l', 'Transaction', 't', 'text'),
    jsonb_build_object('f', 'qty', 'l', 'Qty', 't', 'qty'),
    jsonb_build_object('f', 'unit_price', 'l', 'Unit Price', 't', 'money'),
    jsonb_build_object('f', 'amount', 'l', 'Amount', 't', 'money'),
    jsonb_build_object('f', 'profit', 'l', 'Profit', 't', 'money'));
begin
  for v_l in
    select l.id, l.doc_no, l.received_on, l.qty, l.remaining, l.unit_cost,
           p.name as product, coalesce(p.model, p.code) as model,
           coalesce(sp.name, 'Cash supplier') as supplier, b.name as branch
    from public.stock_layers l
    join public.products p on p.id = l.product_id
    join public.branches b on b.id = l.branch_id
    left join public.suppliers sp on sp.id = l.supplier_id
    where l.shop_id = p_me.shop_id and l.source_kind = 'purchase'
      and public.can_use_branch(l.branch_id)
      and (v_branch is null or l.branch_id = v_branch)
      and (v_from is null or l.received_on >= v_from) and l.received_on <= v_to
    order by l.received_on, l.doc_no, p.name
  loop
    select coalesce(sum(sl.qty), 0)::integer,
           coalesce(sum(round(sl.qty * i.unit_price, 2)), 0)
      into v_sold, v_revenue
    from public.sale_line_layers sl
    join public.sale_items i on i.id = sl.sale_item_id
    where sl.layer_id = v_l.id;

    v_profit := round(v_revenue - v_sold * coalesce(v_l.unit_cost, 0), 2);
    v_total := v_total + v_profit;
    v_rows := jsonb_build_array(
      jsonb_build_object('particulars', 'Arrived', 'qty', v_l.qty,
        'unit_price', v_l.unit_cost, 'amount', round(v_l.qty * coalesce(v_l.unit_cost, 0), 2),
        '_kind', 'detail', '_level', 1),
      jsonb_build_object('particulars', 'Sold', 'qty', v_sold,
        'unit_price', case when v_sold > 0 then round(v_revenue / v_sold, 2) end,
        'amount', v_revenue, 'profit', v_profit, '_kind', 'detail', '_level', 1),
      jsonb_build_object('particulars', 'Still on the shelf', 'qty', v_l.remaining,
        'unit_price', v_l.unit_cost,
        'amount', round(v_l.remaining * coalesce(v_l.unit_cost, 0), 2),
        '_kind', 'detail', '_level', 1));

    v_sections := v_sections || jsonb_build_array(jsonb_build_object(
      'title', v_l.supplier || ' · ' || coalesce(v_l.doc_no, '—')
               || ' · ' || to_char(v_l.received_on, 'DD/MM/YYYY') || ' · ' || v_l.product,
      'columns', v_cols, 'rows', v_rows,
      'totals', jsonb_build_object('particulars', 'Profit on this delivery',
                                   'profit', v_profit, '_kind', 'total', '_level', 0)));
  end loop;

  return jsonb_build_object(
    'columns', v_cols, 'rows', '[]'::jsonb, 'sections', v_sections,
    'totals', jsonb_build_object('particulars', 'Total profit on these deliveries',
                                 'profit', round(v_total, 2), '_kind', 'total', '_level', 0));
end; $$;

/**
 * Every bill of the period, printed as bills (BMS's S-32).
 *
 * What a shop prints at the end of a day to file. One section per invoice, with its
 * lines and its totals, and the day's totals at the end.
 */
create or replace function public.rep_sp_bill_book(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := coalesce((p_filters->>'from')::date, public.dhaka_today());
  v_to date := coalesce((p_filters->>'to')::date, (p_filters->>'from')::date, public.dhaka_today());
  v_branch uuid := (p_filters->>'branch_id')::uuid;
  v_sections jsonb := '[]'::jsonb; v_s record; v_rows jsonb;
  v_tv numeric := 0; v_td numeric := 0; v_tc numeric := 0; v_tt numeric := 0;
  v_cols jsonb := jsonb_build_array(
    jsonb_build_object('f', 'particulars', 'l', 'Product', 't', 'text'),
    jsonb_build_object('f', 'qty', 'l', 'Qty', 't', 'qty'),
    jsonb_build_object('f', 'unit_price', 'l', 'Unit Price', 't', 'money'),
    jsonb_build_object('f', 'discount', 'l', 'Discount', 't', 'money'),
    jsonb_build_object('f', 'net_unit_price', 'l', 'Net Unit Price', 't', 'money'),
    jsonb_build_object('f', 'amount', 'l', 'Amount', 't', 'money'));
begin
  for v_s in
    select * from public.v_rep_sale_docs d
    where d.shop_id = p_me.shop_id and d.d between v_from and v_to
      and public.can_use_branch(d.branch_id)
      and (v_branch is null or d.branch_id = v_branch)
    order by d.d, d.invoice_no
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
             'particulars', l.product, 'qty', l.qty, 'unit_price', l.unit_price,
             'discount', l.discount, 'net_unit_price', l.net_unit_price,
             'amount', l.amount, '_kind', 'detail', '_level', 1) order by l.product), '[]'::jsonb)
      into v_rows
    from public.v_rep_sale_lines l where l.invoice_no = v_s.invoice_no;

    v_tv := v_tv + v_s.vat; v_td := v_td + v_s.discount;
    v_tc := v_tc + v_s.charges; v_tt := v_tt + v_s.amount;
    v_sections := v_sections || jsonb_build_array(jsonb_build_object(
      'title', v_s.trader || ' · ' || v_s.invoice_no || ' · ' || to_char(v_s.d, 'DD/MM/YYYY')
               || ' · ' || v_s.bill_type,
      'columns', v_cols, 'rows', v_rows,
      'totals', jsonb_build_object(
        'particulars', 'Net payable', 'qty', v_s.qty, 'discount', v_s.discount,
        'amount', v_s.amount, '_kind', 'total', '_level', 0),
      'extra', jsonb_build_object('vat', v_s.vat, 'charges', v_s.charges,
                                  'narration', v_s.ref_no, 'sale_id', v_s.sale_id)));
  end loop;

  return jsonb_build_object(
    'columns', v_cols, 'rows', '[]'::jsonb, 'sections', v_sections,
    'totals', jsonb_build_object('particulars', 'For the period',
      'discount', round(v_td, 2), 'amount', round(v_tt, 2),
      'vat', round(v_tv, 2), 'charges', round(v_tc, 2), '_kind', 'total', '_level', 0));
end; $$;

/** Which builder a report with no grouping uses. */
create or replace function public.report_special(
  p_def public.report_defs, p_filters jsonb, p_me public.staff
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  return case p_def.special
    when 'trial_balance'      then public.rep_sp_trial_balance(p_def, p_filters, p_me)
    when 'layer_summary'      then public.rep_sp_layer_summary(p_def, p_filters, p_me)
    when 'chart'              then public.rep_sp_chart(p_def, p_filters, p_me)
    when 'bank_summary'       then public.rep_sp_bank_summary(p_def, p_filters, p_me)
    when 'profit_loss'        then public.rep_sp_profit_loss(p_def, p_filters, p_me)
    when 'balance_sheet'      then public.rep_sp_balance_sheet(p_def, p_filters, p_me)
    when 'ledger'             then public.rep_sp_ledger(p_def, p_filters, p_me)
    when 'cash_book'          then public.rep_sp_cash_book(p_def, p_filters, p_me)
    when 'day_book'           then public.rep_sp_day_book(p_def, p_filters, p_me)
    when 'due_list'           then public.rep_sp_due_list(p_def, p_filters, p_me)
    when 'branch_dues'        then public.rep_sp_branch_dues(p_def, p_filters, p_me)
    when 'sales_received'     then public.rep_sp_sales_received(p_def, p_filters, p_me)
    when 'supplier_statement' then public.rep_sp_supplier_statement(p_def, p_filters, p_me)
    when 'trader_statement'   then public.rep_sp_trader_statement(p_def, p_filters, p_me)
    when 'product_ledger'     then public.rep_sp_product_ledger(p_def, p_filters, p_me)
    when 'product_status'     then public.rep_sp_product_status(p_def, p_filters, p_me)
    when 'stock_valuation'    then public.rep_sp_stock_valuation(p_def, p_filters, p_me)
    when 'vat_report'         then public.rep_sp_vat_report(p_def, p_filters, p_me)
    when 'profit_by_month'    then public.rep_sp_profit_by_month(p_def, p_filters, p_me)
    when 'purchase_movement'  then public.rep_sp_purchase_movement(p_def, p_filters, p_me)
    when 'bill_book'          then public.rep_sp_bill_book(p_def, p_filters, p_me)
    else null end;
exception when others then
  if sqlstate = '22023' or sqlerrm like 'NO_SUCH_BUILDER%' then
    raise exception 'NO_SUCH_BUILDER:%', p_def.special;
  end if;
  raise;
end; $$;

-- ---------------------------------------------------------------------------
-- PART 6 — Export
-- ---------------------------------------------------------------------------
--
-- Excel and PDF are built in the BROWSER from whatever report_run() returned: exceljs
-- is already a dependency (P4 reads import files with it) and a PDF is the print
-- stylesheet, so no report needs its own export code and a new report can be exported
-- the moment it is listed.
--
-- The accountant's export is different: it has to carry the entries themselves, in a
-- shape another program will read. This returns one row per journal LINE with the
-- account and the party spelled out, which is what both a plain CSV and Tally's import
-- need. The Tally XML is assembled in the browser (src/lib/reports-export.ts) and its
-- shape is from Tally's published voucher import format — check ONE voucher in Tally
-- before trusting a year of them.

create or replace function public.journal_export(
  p_from date default null, p_to date default null, p_branch_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  if not public.has_permission('export_reports') then raise exception 'NOT_ALLOWED:export_reports'; end if;

  return jsonb_build_object(
    'shop', (select name from public.shops where id = v_me.shop_id),
    'from', p_from, 'to', p_to,
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', e.entry_date, 'entry_no', e.entry_no,
        'kind', case when e.source_kind = 'voucher' then 'Journal'
                     when e.source_kind = 'sale' then 'Sales'
                     when e.source_kind = 'grn' then 'Purchase'
                     when e.source_kind in ('customer_payment', 'supplier_payment') then 'Payment'
                     else 'Journal' end,
        'narration', coalesce(e.narration, ''),
        'account', a.name, 'account_code', a.code,
        'party', coalesce(c.name_text, c.company, c.phone, s.name, ''),
        'debit', l.debit, 'credit', l.credit, 'note', coalesce(l.note, ''),
        'branch', b.name) order by e.entry_date, e.entry_no), '[]'::jsonb)
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      join public.accounts a on a.id = l.account_id
      join public.branches b on b.id = e.branch_id
      left join public.customers c on c.id = l.customer_id
      left join public.suppliers s on s.id = l.supplier_id
      where e.shop_id = v_me.shop_id and e.status = 'posted'
        and (p_from is null or e.entry_date >= p_from)
        and (p_to is null or e.entry_date <= p_to)
        and (p_branch_id is null or e.branch_id = p_branch_id)
        and public.can_use_branch(e.branch_id)
        and public.can_see_account(l.account_id)));
end; $$;

-- ---------------------------------------------------------------------------
-- PART 7 — Who may read what
-- ---------------------------------------------------------------------------
--
-- The datasets (v_rep_*) are granted to NOBODY. They are read only through
-- report_run(), which is security definer and checks the permission, the shop and the
-- branches first — a view a cashier could select from directly would hand them every
-- cost and margin in the shop.

alter table public.stock_layers     enable row level security;
alter table public.sale_line_layers enable row level security;
alter table public.period_locks     enable row level security;
alter table public.report_defs      enable row level security;
alter table public.report_settings  enable row level security;
alter table public.rep_datasets     enable row level security;

-- A layer carries what a delivery cost, so it is cost data.
create policy stock_layers_read on public.stock_layers for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('see_cost'))
         and public.can_use_branch(branch_id));
create policy sale_line_layers_read on public.sale_line_layers for select to authenticated
  using ((select public.has_permission('see_cost'))
         and exists (select 1 from public.stock_layers l
                     where l.id = layer_id and l.shop_id = (select public.current_shop_id())));
-- Which months are closed is not a secret: a cashier who cannot void yesterday's sale
-- should be able to see why.
create policy period_locks_read on public.period_locks for select to authenticated
  using (shop_id = (select public.current_shop_id()));
-- The catalogue is reference data, like the permission list.
create policy report_defs_read on public.report_defs for select to authenticated using (true);
create policy report_settings_read on public.report_settings for select to authenticated
  using (shop_id = (select public.current_shop_id()));

grant select on public.stock_layers, public.sale_line_layers, public.period_locks,
                public.report_defs, public.report_settings to authenticated;

grant execute on function public.report_list() to authenticated;
grant execute on function public.report_run(text, jsonb) to authenticated;
grant execute on function public.save_report_setting(text, jsonb) to authenticated;
grant execute on function public.lock_period(date, boolean, text) to authenticated;
grant execute on function public.period_lock_list() to authenticated;
grant execute on function public.period_locked(date, uuid) to authenticated;
grant execute on function public.backfill_stock_layers() to authenticated;
grant execute on function public.backfill_stock_entries() to authenticated;
grant execute on function public.journal_export(date, date, uuid) to authenticated;
grant execute on function public.dhaka_date(timestamptz) to authenticated;

-- Everything else here is machinery. A caller who could run the builders directly
-- could run them for another shop.
revoke all on function public.report_grouped(public.report_defs, jsonb, uuid) from authenticated;
revoke all on function public.report_pivot(public.report_defs, jsonb, uuid) from authenticated;
revoke all on function public.report_special(public.report_defs, jsonb, public.staff) from authenticated;
revoke all on function public.rep_balances(uuid, date, date, uuid) from authenticated;
revoke all on function public.rep_party_dues(uuid, date) from authenticated;
revoke all on function public.rep_stock_as_on(date) from authenticated;
revoke all on function public.rep_dusty(date, date) from authenticated;
revoke all on function public.rep_layers(date) from authenticated;
revoke all on function public.rep_title(public.report_defs, uuid) from authenticated;
revoke all on function public.rep_columns(public.report_defs, uuid) from authenticated;
revoke all on function public.layer_add(uuid, uuid, uuid, integer, text, uuid, timestamptz, text) from authenticated;
revoke all on function public.layer_take(uuid, uuid, uuid, integer, text, uuid, uuid) from authenticated;
revoke all on function public.layer_give_back(uuid, uuid, integer) from authenticated;
revoke all on function public.assert_period_open(date, uuid) from authenticated;
revoke all on function public.seed_report_accounts(uuid) from authenticated;
revoke all on function public.post_stock_movement(public.stock_movements) from authenticated;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure::text as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'rep_sp_%'
  loop
    execute format('revoke all on function %s from authenticated', r.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Two more holes, found by insisting the books equal the shelves
-- ---------------------------------------------------------------------------
--
-- 4. A CORRECTED DELIVERY COST NEVER REACHED THE BOOKS. "Receive now, price later" is
--    a real flow — the goods are on the shelf and the invoice has not arrived — and
--    `amend_grn_cost()` fills the figure in afterwards. The stock value changed, the
--    supplier's due changed, and the journal kept the old number for ever, because the
--    posting trigger saw an entry already there and returned. And if some of those
--    units had already sold, the cost of sales was wrong too — by exactly the amount
--    the owner had been told the margin was.
-- 5. CHANGING A COST REVALUED STOCK THAT WAS ALREADY ON THE SHELF, silently. Importing
--    costs from BMS, or typing a cost in, makes every unit on hand worth more or less
--    than a moment ago. That is a real event with a real figure, and it belongs in the
--    books as one.
--
-- Neither is corrected by editing the old entry. A mistake is put right with another
-- entry, as P13 says: the first one stays, and the correction says what it is.

/**
 * A delivery whose figures changed after it was posted.
 *
 * Posts the DIFFERENCE, on every side that moved: the goods, the two taxes, the
 * supplier or the drawer. Then the cost of sales, for the units of that delivery that
 * have already gone — which the FIFO layers can say exactly.
 */
create or replace function public.post_grn_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_goods numeric(14,2); v_was_goods numeric(14,2);
  v_was_vat numeric(14,2); v_was_ait numeric(14,2); v_was_party numeric(14,2);
  v_lines jsonb := '[]'::jsonb;
  v_d_goods numeric(14,2); v_d_vat numeric(14,2); v_d_ait numeric(14,2); v_d_total numeric(14,2);
  v_item record; v_layer record; v_sold integer; v_d_cogs numeric(14,2);
begin
  if not public.feature_on('accounts') then return new; end if;
  -- Nothing posted yet means post_grn is about to do it properly.
  if not exists (select 1 from public.journal_entries
                 where source_kind = 'grn' and source_id = new.id) then
    return new;
  end if;

  v_goods := new.total - coalesce(new.vat, 0) - coalesce(new.ait, 0);
  select
    coalesce(sum(case when a.role = 'inventory' then l.debit - l.credit else 0 end), 0),
    coalesce(sum(case when a.role = 'vat_input' then l.debit - l.credit else 0 end), 0),
    coalesce(sum(case when a.role = 'ait_advance' then l.debit - l.credit else 0 end), 0),
    coalesce(sum(case when a.role in ('payable', 'cash_in_hand') then l.credit - l.debit else 0 end), 0)
    into v_was_goods, v_was_vat, v_was_ait, v_was_party
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  join public.accounts a on a.id = l.account_id
  where e.source_kind = 'grn' and e.source_id = new.id and e.status = 'posted';

  v_d_goods := round(v_goods - v_was_goods, 2);
  v_d_vat   := round(coalesce(new.vat, 0) - v_was_vat, 2);
  v_d_ait   := round(coalesce(new.ait, 0) - v_was_ait, 2);
  v_d_total := round(new.total - v_was_party, 2);

  if v_d_goods <> 0 or v_d_vat <> 0 or v_d_ait <> 0 or v_d_total <> 0 then
    if v_d_goods <> 0 then
      v_lines := v_lines || jsonb_build_object('role', 'inventory',
        case when v_d_goods > 0 then 'debit' else 'credit' end, abs(v_d_goods),
        'note', 'Cost corrected on ' || new.grn_no);
    end if;
    if v_d_vat <> 0 then
      v_lines := v_lines || jsonb_build_object('role', 'vat_input',
        case when v_d_vat > 0 then 'debit' else 'credit' end, abs(v_d_vat));
    end if;
    if v_d_ait <> 0 then
      v_lines := v_lines || jsonb_build_object('role', 'ait_advance',
        case when v_d_ait > 0 then 'debit' else 'credit' end, abs(v_d_ait));
    end if;
    if v_d_total <> 0 then
      v_lines := v_lines || jsonb_build_object(
        'role', case when new.is_credit then 'payable' else 'cash_in_hand' end,
        case when v_d_total > 0 then 'credit' else 'debit' end, abs(v_d_total),
        'supplier_id', case when new.is_credit then new.supplier_id end,
        'note', 'Cost corrected on ' || new.grn_no);
    end if;
    perform public.post_entry(new.shop_id, new.branch_id, public.dhaka_today(),
      'Cost corrected on ' || new.grn_no, v_lines, 'grn', new.id, new.staff_id);

    -- Paid in cash: the drawer has to move too, or the till is short by the correction.
    if not new.is_credit and v_d_total <> 0 then
      insert into public.cash_movements (shop_id, branch_id, shift_id, direction, amount,
                                         reason, note, staff_id, source_kind, source_id)
      values (new.shop_id, new.branch_id,
              (select id from public.shifts where branch_id = new.branch_id
                 and closed_at is null order by opened_at desc limit 1),
              case when v_d_total > 0 then 'out' else 'in' end, abs(v_d_total), 'other',
              'Cost corrected on ' || new.grn_no, new.staff_id, 'grn', new.id);
    end if;
  end if;

  -- And the units of this delivery that have already been sold: their cost of sales was
  -- worked out from the old figure.
  for v_item in
    select i.product_id, coalesce(i.landed_cost, i.unit_cost) as unit_cost
    from public.grn_items i where i.grn_id = new.id
  loop
    for v_layer in
      select l.id, l.unit_cost from public.stock_layers l
      where l.source_kind = 'purchase' and l.source_id = new.id
        and l.product_id = v_item.product_id
    loop
      if coalesce(v_layer.unit_cost, -1) = coalesce(v_item.unit_cost, -1) then continue; end if;
      select coalesce(sum(sl.qty), 0)::integer into v_sold
      from public.sale_line_layers sl where sl.layer_id = v_layer.id;
      v_d_cogs := round(v_sold * (coalesce(v_item.unit_cost, 0) - coalesce(v_layer.unit_cost, 0)), 2);
      update public.stock_layers set unit_cost = v_item.unit_cost where id = v_layer.id;
      if v_d_cogs <> 0 then
        perform public.post_entry(new.shop_id, new.branch_id, public.dhaka_today(),
          'Cost of sales corrected for ' || new.grn_no,
          jsonb_build_array(
            jsonb_build_object('role', 'cogs',
              case when v_d_cogs > 0 then 'debit' else 'credit' end, abs(v_d_cogs)),
            jsonb_build_object('role', 'inventory',
              case when v_d_cogs > 0 then 'credit' else 'debit' end, abs(v_d_cogs))),
          'grn', new.id, new.staff_id);
      end if;
    end loop;
  end loop;
  return new;
end; $$;

-- Named to run after grns_post, so a first posting is not treated as a correction.
create trigger grns_post_change
  after update of total, vat, ait on public.grns
  for each row execute function public.post_grn_change();

/**
 * A cost that changed with no delivery behind it: stock revalued.
 *
 * Every unit on hand is suddenly worth more or less than it was, and that is a figure.
 * Receiving goods is NOT this — the delivery's own entry already carries what the new
 * units cost — and neither is correcting a delivery's invoice, which is handled above.
 * Both are told apart by looking for their rows in this same transaction.
 */
create or replace function public.post_cost_revaluation() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old numeric(12,2) := case when TG_OP = 'UPDATE' then old.cost else 0 end;
  v_delta numeric(12,2);
  v_txn bigint := pg_current_xact_id()::text::bigint;
  v_b record; v_value numeric(14,2);
begin
  if not public.feature_on('accounts') then return new; end if;
  v_delta := round(coalesce(new.cost, 0) - coalesce(v_old, 0), 2);
  if v_delta = 0 then return new; end if;

  -- Goods arriving in this same transaction: the delivery posts its own value.
  if exists (select 1 from public.stock_movements m
             where m.product_id = new.product_id and m.reason = 'purchase'
               and m.xmin::text::bigint = v_txn) then
    return new;
  end if;
  -- A delivery's invoice being corrected in this same transaction: handled by the GRN.
  if exists (select 1 from public.grn_items i
             where i.product_id = new.product_id and i.xmin::text::bigint = v_txn) then
    return new;
  end if;

  for v_b in
    select bs.branch_id, sum(bs.qty) as qty from public.branch_stock bs
    where bs.product_id = new.product_id and bs.shop_id = new.shop_id and bs.qty > 0
    group by bs.branch_id
  loop
    v_value := round(v_b.qty * v_delta, 2);
    if v_value = 0 then continue; end if;
    perform public.post_entry(new.shop_id, v_b.branch_id, public.dhaka_today(),
      'Stock revalued: ' || (select name from public.products where id = new.product_id),
      jsonb_build_array(
        jsonb_build_object('role', 'inventory',
          case when v_value > 0 then 'debit' else 'credit' end, abs(v_value)),
        jsonb_build_object('role', case when v_value > 0 then 'stock_gain' else 'stock_loss' end,
          case when v_value > 0 then 'credit' else 'debit' end, abs(v_value))),
      'stock_adjust', null, null);
  end loop;
  return new;
end; $$;

create trigger product_costs_revalue
  after insert or update of cost on public.product_costs
  for each row execute function public.post_cost_revaluation();
