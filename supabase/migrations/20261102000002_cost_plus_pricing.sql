-- Pricing a catalogue that arrived with no prices.
--
-- BMS keeps no selling price — that is the whole reason this app exists — so a shop that
-- imports its 1,600 products from BMS's reports gets 1,600 products with a price of
-- nothing. Typing them in one at a time is not a thing anybody will do, and the existing
-- bulk tool cannot help: a percentage of zero is zero.
--
-- So the owner prices a whole product group or brand at once, from what the stock cost
-- plus the margin they work on. Cost is the weighted average the books already hold, not
-- a figure from the browser — the rule that every price decision is made in the database
-- holds here as much as at the till.

/**
 * A price the way a shop writes one.
 *
 * 68.51 + 40% is 95.914, and nobody prices anything at 95.91. It goes UP to the next
 * step so a markup is never quietly eroded, and the step grows with the price: five taka
 * matters on a cable and nothing at all on a laptop.
 */
create or replace function public.round_price(p_amount numeric) returns numeric
language sql immutable as $$
  select case
    when p_amount is null or p_amount <= 0 then 0
    when p_amount < 1000  then ceil(p_amount / 5) * 5
    when p_amount < 10000 then ceil(p_amount / 10) * 10
    else ceil(p_amount / 50) * 50
  end::numeric(12,2);
$$;

/**
 * Change many prices at once: set them all to one figure, move them by a percentage or
 * an amount, or work them out from cost plus a markup.
 *
 * Returns what changed so the screen can show old → new before anything is committed.
 * A product whose cost nobody knows is reported with a reason and left alone: guessing a
 * price from a cost of zero would put the whole catalogue on the shelf at nothing.
 */
create or replace function public.bulk_update_prices(
  p_product_ids   uuid[],
  p_price_list_id uuid,
  p_mode          text,          -- 'set' | 'percent' | 'amount' | 'cost_plus'
  p_value         numeric,
  p_branch_id     uuid default null,
  p_dry_run       boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_id    uuid;
  v_cur   jsonb;
  v_old   numeric(12,2);
  v_new   numeric(12,2);
  v_cost  numeric(12,2);
  v_mrp   numeric(12,2);
  v_min   numeric(12,2);
  v_max   numeric(12,2);
  v_note  text;
  v_out   jsonb := '[]'::jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.is_manager() then raise exception 'NOT_ALLOWED:edit_settings'; end if;
  if p_mode not in ('set', 'percent', 'amount', 'cost_plus') then raise exception 'BAD_PRICE_MODE:%', p_mode; end if;
  if p_value is null then raise exception 'BAD_PRICE'; end if;
  if coalesce(array_length(p_product_ids, 1), 0) = 0 then raise exception 'NO_PRODUCTS_PICKED'; end if;

  foreach v_id in array p_product_ids loop
    if not exists (select 1 from public.products where id = v_id and shop_id = v_me.shop_id) then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;
    v_cur := public.resolve_price(v_id, p_branch_id, p_price_list_id);
    v_old := (v_cur->>'price')::numeric;
    v_note := null;

    -- The band as it is STORED, not as resolve_price() reports it. resolve_price()
    -- answers the counter's question — "how low may this be sold?" — and when the owner
    -- has set no floor the answer is the list price itself. That is the wrong figure
    -- here twice over: it would stop the owner ever lowering a price, and writing it
    -- back would give every product a floor it never had.
    select mrp, min_price, max_price into v_mrp, v_min, v_max
      from public.product_prices
     where product_id = v_id and price_list_id = p_price_list_id
       and branch_id is not distinct from p_branch_id;

    if p_mode = 'cost_plus' then
      select cost into v_cost from public.product_costs where product_id = v_id;
      if v_cost is null or v_cost <= 0 then
        -- Nothing has ever been received at a cost, so there is nothing to mark up.
        v_new := v_old;
        v_note := 'no cost recorded yet, so this one is left alone';
      else
        v_new := public.round_price(v_cost * (100 + p_value) / 100);
      end if;
    else
      v_new := case p_mode
        when 'set' then p_value
        when 'percent' then round(v_old * (100 + p_value) / 100, 2)
        else v_old + p_value
      end;
    end if;
    if v_new < 0 then v_new := 0; end if;

    -- A floor or ceiling the owner really did set is the last word: a markup landing
    -- under the lowest allowed price would hand the counter a price it may not sell at.
    if v_min is not null and v_new < v_min then
      v_new := v_min;
      v_note := coalesce(v_note, 'held up to the lowest price allowed');
    end if;
    if v_max is not null and v_new > v_max then
      v_new := v_max;
      v_note := coalesce(v_note, 'held down to the highest price allowed');
    end if;

    v_out := v_out || jsonb_build_object(
      'product_id', v_id,
      'name', (select name from public.products where id = v_id),
      'from', v_old, 'to', v_new, 'note', v_note);

    if not p_dry_run and v_new <> v_old then
      perform public.set_prices(v_id, p_price_list_id, v_new, v_mrp, v_min, v_max, p_branch_id);
    end if;
  end loop;

  return jsonb_build_object('dry_run', p_dry_run, 'changes', v_out);
end; $$;

revoke execute on function public.round_price(numeric) from public, anon;
grant execute on function public.round_price(numeric) to authenticated;
