-- Opening stock is worth something.
--
-- import_opening_stock() only ever set quantities, so a shop that moved its whole
-- catalogue over from BMS ended up with 3,397 units on the shelf and a stock valuation
-- of nothing. Everything downstream follows from that: the trial balance cannot agree
-- with a stock figure that is zero, the gross profit on the first month's sales is the
-- whole selling price, and "price it at cost plus a markup" — the one tool a catalogue
-- with no selling prices actually needs — has nothing to mark up.
--
-- BMS's Current Stock report prints the unit cost beside every line, so it comes in
-- with the quantity. The FIFO layer the movement opens picks it up, and the layer can
-- be dated from the delivery the goods actually came in on where the serial report
-- knows it; otherwise the stock counts as arriving on the day it was imported.
create or replace function public.import_opening_stock(
  p_branch_id uuid, p_rows jsonb, p_dry_run boolean default false, p_file text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me       public.staff;
  v_row      jsonb;
  v_code     text;
  v_product  public.products;
  v_location uuid;
  v_qty      integer;
  v_current  integer;
  v_cost     numeric(12,2);
  v_on       date;
  v_layer    uuid;
  v_set      integer := 0;
  v_unchanged integer := 0;
  v_missing  integer := 0;
  v_costed   integer := 0;
  v_value    numeric(14,2) := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('adjust_stock') then raise exception 'NOT_ALLOWED:adjust_stock'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  for v_row in select e from jsonb_array_elements(p_rows) e loop
    v_code := upper(btrim(v_row->>'code'));
    v_qty := (v_row->>'qty')::integer;
    if v_code = '' or v_qty is null or v_qty < 0 then v_missing := v_missing + 1; continue; end if;

    select * into v_product from public.products where shop_id = v_me.shop_id and code = v_code;
    if not found then v_missing := v_missing + 1; continue; end if;

    v_cost := nullif(btrim(coalesce(v_row->>'unit_cost', '')), '')::numeric;
    if v_cost is not null and v_cost < 0 then v_cost := null; end if;
    -- A date BMS printed, in either the way it prints them or the way SQL reads them.
    v_on := null;
    begin
      v_on := case
        when btrim(coalesce(v_row->>'purchase_date', '')) ~ '^\d{2}/\d{2}/\d{4}$'
          then to_date(btrim(v_row->>'purchase_date'), 'DD/MM/YYYY')
        else nullif(btrim(coalesce(v_row->>'purchase_date', '')), '')::date end;
    exception when others then v_on := null;
    end;
    -- Stock cannot have arrived after today, whatever the file says.
    if v_on is not null and v_on > public.dhaka_today() then v_on := null; end if;

    -- A named store becomes a location if the shop uses more than one.
    v_location := null;
    if coalesce(btrim(v_row->>'location'), '') <> '' then
      select id into v_location from public.stock_locations
        where branch_id = p_branch_id and lower(name) = lower(btrim(v_row->>'location')) and active;
    end if;
    v_location := coalesce(v_location, public.default_location(p_branch_id));
    if v_location is null then raise exception 'LOCATION_NOT_FOUND'; end if;

    select qty into v_current from public.branch_stock
      where product_id = v_product.id and location_id = v_location;
    v_current := coalesce(v_current, 0);

    if not p_dry_run and v_cost is not null then
      -- Before the movement, so the layer its trigger opens is already worth something.
      -- This is an opening balance, not a receipt, so it SETS the average rather than
      -- moving it: there was nothing on the books to average against.
      insert into public.product_costs (shop_id, product_id, cost)
      values (v_me.shop_id, v_product.id, v_cost)
      on conflict (product_id) do update set cost = excluded.cost, updated_at = now();
      v_costed := v_costed + 1;
    end if;
    if v_cost is not null then v_value := v_value + v_cost * v_qty; end if;

    if v_current = v_qty then v_unchanged := v_unchanged + 1; continue; end if;
    if p_dry_run then v_set := v_set + 1; continue; end if;

    insert into public.branch_stock (product_id, location_id, shop_id, branch_id, qty)
    values (v_product.id, v_location, v_me.shop_id, p_branch_id, v_qty)
    on conflict (product_id, location_id) do update set qty = excluded.qty, updated_at = now();

    insert into public.stock_movements (shop_id, branch_id, location_id, product_id,
                                        qty_change, reason, staff_id, note)
    values (v_me.shop_id, p_branch_id, v_location, v_product.id, v_qty - v_current,
            case when v_qty > v_current then 'adjust_in' else 'adjust_out' end,
            v_me.id, 'Opening stock from import');

    -- The layer that movement just opened, dated the day the goods really arrived.
    -- The movement itself keeps today's date: it happened today, whatever it records.
    if v_on is not null and v_qty > v_current then
      select id into v_layer from public.stock_layers
       where product_id = v_product.id and branch_id = p_branch_id and source_kind = 'opening'
       order by created_at desc limit 1;
      if v_layer is not null then
        update public.stock_layers set received_on = v_on where id = v_layer;
      end if;
    end if;
    v_set := v_set + 1;
  end loop;

  return jsonb_build_object('set', v_set, 'unchanged', v_unchanged, 'missing', v_missing,
                            'costed', v_costed, 'stock_value', round(v_value, 2),
                            'run_id', public.log_import_run('stock',
                              jsonb_build_object('set', v_set, 'unchanged', v_unchanged,
                                                 'missing', v_missing, 'costed', v_costed,
                                                 'stock_value', round(v_value, 2)),
                              p_dry_run, p_file, p_branch_id));
end; $$;

revoke execute on function public.import_opening_stock(uuid, jsonb, boolean, text) from public, anon;
grant execute on function public.import_opening_stock(uuid, jsonb, boolean, text) to authenticated;
