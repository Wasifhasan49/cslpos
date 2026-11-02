-- The letterhead, so a printout can carry the shop's own name, logo and address.
--
-- Every printable — a report, an invoice, a purchase order, a transfer slip, a statement,
-- a voucher — prints the same header, and it has to be THIS shop's header: the product is
-- sold to many shops and nothing may be hard-coded to the first one. The app already asks
-- who you are once, on load, so the letterhead travels with that answer rather than adding
-- a round trip to every print button.
--
-- Branch address and phone come along for the same reason: the header prints the branch
-- being worked in, not the head office, and the branch switcher already has the row.
create or replace function public.current_staff() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'staff_id', s.id,
    'shop_id', s.shop_id,
    'name', s.name,
    'role', s.role,
    'discount_limit_pct', s.discount_limit_pct,
    'shop_name', sh.name,
    'has_pin', s.pin_hash is not null,
    'letterhead', jsonb_build_object(
      'shop_name', sh.name,
      'logo_url', sh.logo_url,
      'address', sh.address,
      'phone', sh.phone,
      'email', sh.email,
      'bin_vat', sh.bin_vat
    ),
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id, 'name', b.name, 'code', b.code,
        'address', b.address, 'phone', b.phone,
        'locations', (
          select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'is_default', l.is_default)
                          order by l.is_default desc, l.name), '[]'::jsonb)
          from public.stock_locations l where l.branch_id = b.id and l.active
        )
      ) order by b.name), '[]'::jsonb)
      from public.branches b
      where b.id = any(public.current_branch_ids())
    )
  )
  from public.staff s
  join public.shops sh on sh.id = s.shop_id
  where s.user_id = auth.uid() and s.active
  limit 1;
$$;

-- Saving the shop's details, with two changes the logo needs.
--
-- 1. A logo can be taken off again. `coalesce(p_values->>'logo_url', logo_url)` cannot
--    express that: a json null reads as "not given". Asking whether the key is present
--    can, so sending an explicit null clears it.
-- 2. The logo is a data URL, tens of kilobytes of it, and the audit log kept a before
--    and an after copy on every save of any setting. The log says the logo changed and
--    leaves the bytes out.
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
    logo_url = case when p_values ? 'logo_url'
                    then nullif(btrim(coalesce(p_values->>'logo_url', '')), '')
                    else logo_url end,
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
    claim_approval = coalesce((p_values->>'claim_approval')::boolean, claim_approval),
    voucher_approval = coalesce((p_values->>'voucher_approval')::boolean, voucher_approval),
    so_approval_limit = coalesce((p_values->>'so_approval_limit')::numeric, so_approval_limit)
  where id = v_me.shop_id
  returning to_jsonb(shops.*) into v_row;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'shop_details_changed', 'shop', v_me.shop_id,
          jsonb_build_object(
            'from', v_before - 'id' - 'logo_url',
            'to', v_row - 'id' - 'logo_url',
            'logo_changed', coalesce(v_before->>'logo_url', '') <> coalesce(v_row->>'logo_url', '')));
  return v_row;
end; $$;
