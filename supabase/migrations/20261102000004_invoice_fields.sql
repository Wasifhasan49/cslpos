-- The A4 bill needs more of the sale than the till roll does.
--
-- The store's own invoice names who it is addressed to inside a company, where they
-- are, what the sale was for, and which of the floor staff made it — all of it already
-- stored by P10a's counter, none of it returned by sale_detail() until now, because
-- the only thing printing a sale was an 80mm receipt that has no room for any of it.

create or replace function public.sale_detail(p_sale_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_sale public.sales; v_out jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;

  select * into v_sale from public.sales where id = p_sale_id and shop_id = v_me.shop_id;
  if not found then raise exception 'SALE_NOT_FOUND'; end if;
  if not public.can_use_branch(v_sale.branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
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
    'paid_amount', s.paid_amount, 'due_amount', s.due_amount,
    'status', s.status, 'approval_status', s.approval_status,
    'void_reason', s.void_reason, 'refund_method', s.refund_method,
    'customer_id', s.customer_id,
    'customer_phone', c.phone, 'customer_name', c.name_text,
    -- What the A4 bill prints and the 80mm receipt does not: who inside the company it
    -- is addressed to, where they are, what the sale was for, and who made it.
    'attention', s.attention, 'customer_address', coalesce(s.customer_address, c.address),
    'customer_bin', s.customer_bin, 'narration', s.narration,
    'sold_by', coalesce(sb.name, st.name), 'extra_fields', s.extra_fields,
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
  left join public.staff sb on sb.id = s.sold_by
  left join public.customers c on c.id = s.customer_id
  where s.id = p_sale_id;

  return v_out;
end; $$;
