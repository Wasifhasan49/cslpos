-- P12 — Owner dashboard (phone first)
--
-- This is the screen that sells the product. An owner who can see today's takings and
-- today's profit from a phone, in a shop, in two seconds, will keep using it; one who
-- has to sit at a computer and run a report will not.
--
-- PROFIT NEEDS THE COST AT THE TIME OF SALE
-- A product's average cost moves every time stock is received (P5). Working out last
-- month's profit from today's cost is therefore wrong by exactly however much prices
-- have moved since — and always in the flattering direction when costs are rising. So
-- the cost is CAPTURED on the sale line as it happens.
--
-- It goes in its own table, not a column on `sale_items`, because cashiers can read
-- `sale_items`: they need the line to print a receipt. A cost column there would hand
-- every cashier the shop's margins, which is the one thing P3 exists to prevent.
--
-- ONE ROUND TRIP
-- The whole dashboard comes back from a single function. On 4G in a shop, six round
-- trips is six chances to be slow; one is one. Everything is worked out in Postgres
-- where the data is, and the browser only draws it.

-- ---------------------------------------------------------------------------
-- The data fix
-- ---------------------------------------------------------------------------

create table public.sale_item_costs (
  sale_item_id uuid primary key references public.sale_items(id) on delete cascade,
  shop_id      uuid not null references public.shops(id) on delete cascade,
  branch_id    uuid not null references public.branches(id),
  -- The weighted average cost of this product AT THE MOMENT it was sold.
  unit_cost    numeric(12,2)
);
create index sale_item_costs_branch_idx on public.sale_item_costs(branch_id);

/**
 * Capture the cost as the line is written.
 *
 * A trigger rather than a ninth copy of complete_sale(): the rule belongs to the sale
 * line wherever it is inserted from, and complete_sale() is already 450 lines.
 */
create or replace function public.capture_sale_cost() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.sale_item_costs (sale_item_id, shop_id, branch_id, unit_cost)
  select new.id, new.shop_id, s.branch_id,
         (select c.cost from public.product_costs c where c.product_id = new.product_id)
  from public.sales s where s.id = new.sale_id
  on conflict (sale_item_id) do nothing;
  return new;
end; $$;

create trigger sale_items_capture_cost
  after insert on public.sale_items
  for each row execute function public.capture_sale_cost();

-- Cost is cost: the same line as product_costs. A cashier must never read this.
alter table public.sale_item_costs enable row level security;
create policy sale_item_costs_read on public.sale_item_costs for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('see_cost')));

-- ---------------------------------------------------------------------------
-- The dashboard
-- ---------------------------------------------------------------------------

/**
 * Everything the dashboard shows, in one call.
 *
 * `p_from`/`p_to` default to today in Dhaka. The comparisons are against the same length
 * of time immediately before, and against the same days a week earlier — "up on
 * yesterday" and "up on last Tuesday" are different questions and an owner asks both.
 */
create or replace function public.dashboard(
  p_branch_id uuid default null,
  p_from      date default null,
  p_to        date default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_shop   uuid;
  v_from   date := coalesce(p_from, public.dhaka_today());
  v_to     date := coalesce(p_to, public.dhaka_today());
  v_days   integer;
  v_prev_from date;
  v_prev_to   date;
  v_week_from date;
  v_week_to   date;
  v_out    jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  -- Profit is the shop's business. A cashier has no dashboard.
  if not public.has_permission('view_reports') then raise exception 'NOT_ALLOWED:view_reports'; end if;
  if p_branch_id is not null and not public.can_use_branch(p_branch_id) then
    raise exception 'BRANCH_NOT_ALLOWED';
  end if;
  if v_to < v_from then raise exception 'BAD_DATE_RANGE'; end if;
  v_shop := v_me.shop_id;

  v_days := (v_to - v_from) + 1;
  v_prev_to := v_from - 1;
  v_prev_from := v_prev_to - (v_days - 1);
  v_week_from := v_from - 7;
  v_week_to := v_to - 7;

  with
  -- Every completed sale in reach, with its branch, once.
  scope as (
    select s.*, (s.created_at at time zone 'Asia/Dhaka')::date as on_date
    from public.sales s
    where s.shop_id = v_shop
      and s.status = 'completed'
      and s.branch_id = any(select unnest(public.current_branch_ids()))
      and (p_branch_id is null or s.branch_id = p_branch_id)
  ),
  -- Profit per line: what was charged after its share of the discount, less what the
  -- goods cost at the time. A line with no captured cost counts as no profit rather
  -- than as pure profit, which is the mistake that makes every report look wonderful.
  lines as (
    select s.id as sale_id, s.on_date, s.branch_id, s.staff_id, s.created_at,
           i.product_id, i.qty,
           round(i.line_total * (100 - s.discount_pct) / 100, 2) as charged,
           case when c.unit_cost is null then null
                else round(i.line_total * (100 - s.discount_pct) / 100, 2)
                     - c.unit_cost * i.qty end as profit,
           c.unit_cost is null as cost_missing
    from scope s
    join public.sale_items i on i.sale_id = s.id
    left join public.sale_item_costs c on c.sale_item_id = i.id
  ),
  period as (
    select
      (select coalesce(sum(total), 0) from scope where on_date between v_from and v_to) as sales,
      (select count(*) from scope where on_date between v_from and v_to) as sale_count,
      (select coalesce(sum(profit), 0) from lines where on_date between v_from and v_to) as profit,
      (select count(*) from lines where on_date between v_from and v_to and cost_missing) as no_cost_lines
  ),
  prev as (
    select
      (select coalesce(sum(total), 0) from scope where on_date between v_prev_from and v_prev_to) as sales,
      (select count(*) from scope where on_date between v_prev_from and v_prev_to) as sale_count,
      (select coalesce(sum(profit), 0) from lines where on_date between v_prev_from and v_prev_to) as profit
  ),
  week as (
    select
      (select coalesce(sum(total), 0) from scope where on_date between v_week_from and v_week_to) as sales,
      (select coalesce(sum(profit), 0) from lines where on_date between v_week_from and v_week_to) as profit
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'days', v_days,
    'branch_id', p_branch_id,
    'branch', (select name from public.branches where id = p_branch_id),

    'today', jsonb_build_object(
      'sales', p.sales, 'profit', p.profit, 'sale_count', p.sale_count,
      'average_sale', case when p.sale_count > 0 then round(p.sales / p.sale_count, 2) else 0 end,
      -- How many lines could not be costed. Shown, not hidden: a profit figure built on
      -- half-costed lines is worse than no profit figure.
      'lines_without_cost', p.no_cost_lines),
    'before', jsonb_build_object('sales', pr.sales, 'profit', pr.profit,
                                 'sale_count', pr.sale_count,
                                 'from', v_prev_from, 'to', v_prev_to),
    'week_before', jsonb_build_object('sales', w.sales, 'profit', w.profit,
                                      'from', v_week_from, 'to', v_week_to),

    -- Per branch, for when the owner is looking at the whole business.
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'branch_id', b.id, 'branch', b.name,
        'sales', coalesce(bs.sales, 0), 'profit', coalesce(bs.profit, 0),
        'sale_count', coalesce(bs.sale_count, 0)) order by coalesce(bs.sales, 0) desc), '[]'::jsonb)
      from public.branches b
      left join (
        select s.branch_id,
               sum(s.total) as sales,
               count(*) as sale_count,
               (select coalesce(sum(l.profit), 0) from lines l
                where l.branch_id = s.branch_id and l.on_date between v_from and v_to) as profit
        from scope s where s.on_date between v_from and v_to group by s.branch_id
      ) bs on bs.branch_id = b.id
      where b.shop_id = v_shop and b.active
        and b.id = any(select unnest(public.current_branch_ids()))),

    'by_method', (
      select coalesce(jsonb_object_agg(payment_method, amount), '{}'::jsonb)
      from (select payment_method, sum(total) as amount from scope
            where on_date between v_from and v_to group by payment_method) m),

    -- The row an owner coming from BMS expects to see.
    'summary', jsonb_build_object(
      'cash_sales', (select coalesce(sum(total - due_amount), 0) from scope
                     where on_date between v_from and v_to and payment_method <> 'due'),
      'credit_sales', (select coalesce(sum(due_amount), 0) from scope
                       where on_date between v_from and v_to),
      'sales_returns', (select coalesce(sum(r.total), 0) from public.sale_returns r
                        where r.shop_id = v_shop
                          and r.approval_status <> 'cancelled'
                          and (r.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
                          and (p_branch_id is null or r.branch_id = p_branch_id)
                          and r.branch_id = any(select unnest(public.current_branch_ids()))),
      'cash_purchases', (select coalesce(sum(g.total), 0) from public.grns g
                         where g.shop_id = v_shop and not g.is_credit
                           and (g.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
                           and (p_branch_id is null or g.branch_id = p_branch_id)
                           and g.branch_id = any(select unnest(public.current_branch_ids()))),
      'credit_purchases', (select coalesce(sum(g.total), 0) from public.grns g
                           where g.shop_id = v_shop and g.is_credit
                             and (g.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
                             and (p_branch_id is null or g.branch_id = p_branch_id)
                             and g.branch_id = any(select unnest(public.current_branch_ids()))),
      'purchase_returns', (select coalesce(sum(sr.total), 0) from public.supplier_returns sr
                           where sr.shop_id = v_shop
                             and (sr.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
                             and (p_branch_id is null or sr.branch_id = p_branch_id)
                             and sr.branch_id = any(select unnest(public.current_branch_ids()))),
      'claims_taken', (select count(*) from public.warranty_claims cl
                       where cl.shop_id = v_shop
                         and (cl.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
                         and (p_branch_id is null or cl.branch_id = p_branch_id)
                         and cl.branch_id = any(select unnest(public.current_branch_ids()))),
      'money_in', (select coalesce(sum(cp.amount), 0) from public.customer_payments cp
                   where cp.shop_id = v_shop
                     and (cp.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
                     and (p_branch_id is null or cp.branch_id = p_branch_id)
                     and cp.branch_id = any(select unnest(public.current_branch_ids()))),
      'money_out', (select coalesce(sum(sp.amount), 0) from public.supplier_payments sp
                    where sp.shop_id = v_shop
                      and (sp.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
                      and (p_branch_id is null or sp.branch_id = p_branch_id)
                      and sp.branch_id = any(select unnest(public.current_branch_ids())))),

    -- When the shop is actually busy, over the last 7 days. Staffing is the decision
    -- this answers, so it is hours and not minutes.
    'busy_hours', (
      select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'sales', amount, 'count', n)
             order by h), '[]'::jsonb)
      from (
        select extract(hour from (created_at at time zone 'Asia/Dhaka'))::int as h,
               sum(total) as amount, count(*) as n
        from scope
        where on_date between public.dhaka_today() - 6 and public.dhaka_today()
        group by 1
      ) b),

    'best_by_profit', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', product_id, 'product', name, 'qty', qty, 'sales', sales,
        'profit', profit) order by profit desc nulls last), '[]'::jsonb)
      from (
        select l.product_id, p.name, sum(l.qty) as qty, sum(l.charged) as sales,
               sum(l.profit) as profit
        from lines l join public.products p on p.id = l.product_id
        where l.on_date between v_from and v_to
        group by l.product_id, p.name
        order by sum(l.profit) desc nulls last
        limit 10
      ) t),

    'best_by_qty', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', product_id, 'product', name, 'qty', qty, 'sales', sales)
        order by qty desc), '[]'::jsonb)
      from (
        select l.product_id, p.name, sum(l.qty) as qty, sum(l.charged) as sales
        from lines l join public.products p on p.id = l.product_id
        where l.on_date between v_from and v_to
        group by l.product_id, p.name
        order by sum(l.qty) desc
        limit 10
      ) t),

    'staff', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'staff_id', staff_id, 'staff', name, 'sales', sales, 'sale_count', n,
        'discount_given', discounts, 'profit', profit) order by sales desc), '[]'::jsonb)
      from (
        select s.staff_id, st.name, sum(s.total) as sales, count(*) as n,
               sum(s.discount_amount) as discounts,
               (select coalesce(sum(l.profit), 0) from lines l
                where l.staff_id = s.staff_id and l.on_date between v_from and v_to) as profit
        from scope s join public.staff st on st.id = s.staff_id
        where s.on_date between v_from and v_to
        group by s.staff_id, st.name
      ) t),

    -- What is about to run out, with what the shop has sold lately and where else it is.
    'low_stock', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', id, 'product', name, 'code', code, 'branch', branch,
        'branch_id', branch_id, 'stock', stock, 'reorder_level', reorder_level,
        'sold_30', sold_30, 'elsewhere', elsewhere) order by stock, name), '[]'::jsonb)
      from (
        select p.id, p.name, p.code, b.name as branch, b.id as branch_id,
               coalesce(bs.qty, 0) as stock,
               coalesce(rl.level, p.reorder_level) as reorder_level,
               coalesce((select sum(-m.qty_change) from public.stock_movements m
                         where m.product_id = p.id and m.branch_id = b.id
                           and m.reason = 'sale'
                           and m.created_at > now() - interval '30 days'), 0) as sold_30,
               (select coalesce(jsonb_agg(jsonb_build_object('branch', b2.name, 'qty', q.qty)
                       order by q.qty desc), '[]'::jsonb)
                from (select bs2.branch_id, sum(bs2.qty) as qty from public.branch_stock bs2
                      where bs2.product_id = p.id and bs2.branch_id <> b.id
                      group by bs2.branch_id having sum(bs2.qty) > 0) q
                join public.branches b2 on b2.id = q.branch_id) as elsewhere
        from public.products p
        join public.branches b on b.shop_id = v_shop and b.active
        left join public.branch_stock bs on bs.product_id = p.id and bs.branch_id = b.id
        left join public.product_reorder_levels rl on rl.product_id = p.id and rl.branch_id = b.id
        where p.shop_id = v_shop and p.active and p.is_inventory
          and b.id = any(select unnest(public.current_branch_ids()))
          and (p_branch_id is null or b.id = p_branch_id)
          and coalesce(bs.qty, 0) <= coalesce(rl.level, p.reorder_level)
        limit 25
      ) t),

    -- Money sitting on a shelf doing nothing. The figure that changes buying decisions.
    'dusty_stock', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', id, 'product', name, 'code', code, 'stock', stock,
        'cost', cost, 'tied_up', tied_up, 'last_sold', last_sold)
        order by tied_up desc), '[]'::jsonb)
      from (
        select p.id, p.name, p.code,
               sum(bs.qty) as stock,
               (select c.cost from public.product_costs c where c.product_id = p.id) as cost,
               round(sum(bs.qty) * coalesce((select c.cost from public.product_costs c
                                             where c.product_id = p.id), 0), 2) as tied_up,
               (select max((m.created_at at time zone 'Asia/Dhaka')::date)
                from public.stock_movements m
                where m.product_id = p.id and m.reason = 'sale') as last_sold
        from public.products p
        join public.branch_stock bs on bs.product_id = p.id
        where p.shop_id = v_shop and p.active and p.is_inventory
          and bs.branch_id = any(select unnest(public.current_branch_ids()))
          and (p_branch_id is null or bs.branch_id = p_branch_id)
        group by p.id, p.name, p.code
        having sum(bs.qty) > 0
           and coalesce((select max(m.created_at) from public.stock_movements m
                         where m.product_id = p.id and m.reason = 'sale'),
                        'epoch'::timestamptz) < now() - interval '60 days'
        order by 6 desc
        limit 25
      ) t),

    'owed', jsonb_build_object(
      'by_customers', (select coalesce(sum(public.customer_due(c.id)), 0)
                       from public.customers c where c.shop_id = v_shop),
      'to_suppliers', (select coalesce(sum(public.supplier_balance(s.id)), 0)
                       from public.suppliers s where s.shop_id = v_shop and not s.is_cash_only)),

    -- The things an owner would want to have been told about, newest first.
    'watch', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'at', a.created_at, 'action', a.action, 'entity', a.entity,
        'entity_id', a.entity_id, 'branch', b.name,
        'who', st.name, 'details', a.details) order by a.created_at desc), '[]'::jsonb)
      from (
        select * from public.audit_log a2
        where a2.shop_id = v_shop
          and a2.action in ('discount_approved', 'price_overridden', 'sale_voided',
                            'sale_returned', 'price_set', 'bulk_price_change',
                            'credit_limit_overridden', 'transfer_disputed',
                            'po_price_overridden', 'stock_corrected', 'shift_closed',
                            'cash_out', 'opening_balance_set')
          and (a2.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
          and (p_branch_id is null or a2.branch_id = p_branch_id or a2.branch_id is null)
        order by a2.created_at desc
        limit 20
      ) a
      left join public.branches b on b.id = a.branch_id
      left join public.staff st on st.id = a.staff_id)
  ) into v_out
  from period p, prev pr, week w;

  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- Tapping a number
-- ---------------------------------------------------------------------------

/**
 * What is behind one of the dashboard's figures.
 *
 * A number an owner cannot open is a number they have to take on trust, and the whole
 * complaint about BMS is that its figures cannot be checked. Tapping "Profit" lists the
 * sales that make it up, line by line, with what each one actually earned.
 */
create or replace function public.dashboard_detail(
  p_kind      text,
  p_branch_id uuid default null,
  p_from      date default null,
  p_to        date default null,
  p_limit     integer default 100
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me   public.staff;
  v_shop uuid;
  v_from date := coalesce(p_from, public.dhaka_today());
  v_to   date := coalesce(p_to, public.dhaka_today());
  v_out  jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_reports') then raise exception 'NOT_ALLOWED:view_reports'; end if;
  if p_branch_id is not null and not public.can_use_branch(p_branch_id) then
    raise exception 'BRANCH_NOT_ALLOWED';
  end if;
  if p_kind not in ('sales', 'profit', 'returns', 'dues', 'supplier_dues') then
    raise exception 'BAD_DETAIL_KIND:%', p_kind;
  end if;
  v_shop := v_me.shop_id;

  if p_kind in ('sales', 'profit') then
    select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object(
        'id', s.id, 'invoice_no', s.invoice_no, 'at', s.created_at,
        'branch', b.name, 'staff', st.name,
        'customer', coalesce(c.name_text, c.phone),
        'total', s.total, 'discount', s.discount_amount,
        'payment_method', s.payment_method,
        -- What this sale actually earned, after its share of the discount and the cost
        -- of the goods as it stood on the day.
        'profit', (select coalesce(sum(
                     case when sc.unit_cost is null then 0
                          else round(i.line_total * (100 - s.discount_pct) / 100, 2)
                               - sc.unit_cost * i.qty end), 0)
                   from public.sale_items i
                   left join public.sale_item_costs sc on sc.sale_item_id = i.id
                   where i.sale_id = s.id),
        'lines_without_cost', (select count(*) from public.sale_items i
                               left join public.sale_item_costs sc on sc.sale_item_id = i.id
                               where i.sale_id = s.id and sc.unit_cost is null),
        'items', (select string_agg(i.name, ', ' order by i.name)
                  from public.sale_items i where i.sale_id = s.id)
      ) as x
      from public.sales s
      join public.branches b on b.id = s.branch_id
      join public.staff st on st.id = s.staff_id
      left join public.customers c on c.id = s.customer_id
      where s.shop_id = v_shop and s.status = 'completed'
        and s.branch_id = any(select unnest(public.current_branch_ids()))
        and (p_branch_id is null or s.branch_id = p_branch_id)
        and (s.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
      order by s.created_at desc
      limit greatest(coalesce(p_limit, 100), 1)
    ) q;

  elsif p_kind = 'returns' then
    select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object(
        'id', r.id, 'return_no', r.return_no, 'at', r.created_at,
        'branch', b.name, 'invoice_no', s.invoice_no,
        'total', r.total, 'refund_method', r.refund_method, 'reason', r.reason,
        'customer', coalesce(c.name_text, c.phone)) as x
      from public.sale_returns r
      join public.branches b on b.id = r.branch_id
      join public.sales s on s.id = r.sale_id
      left join public.customers c on c.id = r.customer_id
      where r.shop_id = v_shop and r.approval_status <> 'cancelled'
        and r.branch_id = any(select unnest(public.current_branch_ids()))
        and (p_branch_id is null or r.branch_id = p_branch_id)
        and (r.created_at at time zone 'Asia/Dhaka')::date between v_from and v_to
      order by r.created_at desc
      limit greatest(coalesce(p_limit, 100), 1)
    ) q;

  elsif p_kind = 'dues' then
    select coalesce(jsonb_agg(x order by (x->>'owed')::numeric desc), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object(
        'id', c.id, 'name', coalesce(c.name_text, c.phone), 'phone', c.phone,
        'company', c.company, 'owed', public.customer_due(c.id),
        'payment_days', c.payment_days) as x
      from public.customers c
      where c.shop_id = v_shop and public.customer_due(c.id) > 0
      limit greatest(coalesce(p_limit, 100), 1)
    ) q;

  else
    select coalesce(jsonb_agg(x order by (x->>'owed')::numeric desc), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object(
        'id', s.id, 'name', s.name, 'phone', s.phone,
        'owed', public.supplier_balance(s.id)) as x
      from public.suppliers s
      where s.shop_id = v_shop and not s.is_cash_only and public.supplier_balance(s.id) > 0
      limit greatest(coalesce(p_limit, 100), 1)
    ) q;
  end if;

  return v_out;
end; $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.dashboard(uuid, date, date) from public, anon;
revoke execute on function public.dashboard_detail(text, uuid, date, date, integer) from public, anon;
-- The trigger's own function is never called from outside.
revoke execute on function public.capture_sale_cost() from public, anon, authenticated;

grant execute on function public.dashboard(uuid, date, date) to authenticated;
grant execute on function public.dashboard_detail(text, uuid, date, date, integer) to authenticated;
