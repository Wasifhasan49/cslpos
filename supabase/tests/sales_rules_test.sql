-- Checks the owner-protection rules against a local Postgres.
-- Run: scripts/test-db.sh   (any failure stops with an error)
\set ON_ERROR_STOP on

-- Two logins: an owner (with a PIN) and a cashier (5% discount limit).
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'ovi@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'other-shop@example.com');
insert into public.staff (id, shop_id, user_id, name, role, discount_limit_pct) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Owner', 'owner', 100),
  ('aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Ovi', 'cashier', 5);
insert into public.shops (id, name) values ('00000000-0000-4000-8000-000000000099', 'Another shop');
insert into public.staff (shop_id, user_id, name, role) values
  ('00000000-0000-4000-8000-000000000099', '33333333-3333-4333-8333-333333333333', 'Stranger', 'owner');

-- Helper: run a statement and insist it fails with a given code.
create function pg_temp.expect_error(stmt text, code text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'EXPECTED % BUT STATEMENT SUCCEEDED: %', code, stmt;
exception when others then
  if position(code in sqlerrm) = 0 then
    raise exception 'EXPECTED % BUT GOT: %', code, sqlerrm;
  end if;
end; $$;
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'CHECK FAILED: %', what; end if; raise notice 'ok: %', what; end; $$;

-- Owner sets a PIN.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select public.set_pin('1234');

-- From here on we are Ovi, the cashier.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);

-- 1. The filmed sale: 2 splitters, cash 1,000.
select pg_temp.check(
  (public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":2}]', 'cash', 0, null, null, 1000)->>'invoice_no') = 'CSLINV2026001790',
  'cash sale completes with the next invoice number');
select pg_temp.check((select stock from public.products where code = 'VEN-AUD-35') = 2, 'stock drops from 4 to 2');
select pg_temp.check((select total from public.sales where invoice_no = 'CSLINV2026001790') = 1000, 'total uses the owner''s price (500 x 2)');
select pg_temp.check((select warranty_until from public.sale_items limit 1) = public.dhaka_today() + interval '12 months', 'warranty end date is stored');

-- 2. Cashier can't see cost prices, PIN hashes, or the audit log.
select pg_temp.check((select count(*) from public.product_costs) = 0, 'cashier sees no cost prices');
select pg_temp.expect_error('select pin_hash from public.staff', 'permission denied');
select pg_temp.check((select count(*) from public.audit_log) = 0, 'cashier sees no audit log');

-- 3. Cashier can't record a sale directly or change a price.
select pg_temp.expect_error($q$insert into public.sales (shop_id, invoice_no, staff_id, subtotal, total, payment_method)
  values ('00000000-0000-4000-8000-000000000001', 'FAKE1', 'aaaaaaaa-0000-4000-8000-000000000002', 1, 1, 'cash')$q$, 'row-level security');
update public.products set price = 1 where code = 'VEN-HDMI-15';
select pg_temp.check((select price from public.products where code = 'VEN-HDMI-15') = 450, 'cashier price edit has no effect');

-- 4. Discounts over the 5% limit need a manager PIN.
select pg_temp.expect_error($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10, null, null, 1000)$q$, 'MANAGER_PIN_REQUIRED');
select pg_temp.expect_error($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10, '9999', null, 1000)$q$, 'MANAGER_PIN_INVALID');
select pg_temp.check(
  (public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10, '1234', '01711000000', 1000)->>'total')::numeric = 405,
  'with the right PIN, 10% off 450 = 405');
select pg_temp.check(
  (public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 5, null, null, 500)->>'total')::numeric = 427,
  '5% is within the limit, no PIN (discount 22.5 rounds to 23, total 427)');

-- 5. Serial items need a real, unsold serial.
select pg_temp.expect_error($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a8","qty":1}]', 'bkash', 0, null, null, null, 'TRX12345')$q$, 'SERIAL_REQUIRED');
select pg_temp.check(
  (public.complete_sale(jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a8',
     'serial_ids', jsonb_build_array((select id from public.serials where serial = 'S64DNX0T41822'))))
   , 'bkash', 0, null, null, null, 'TRX12345')->'items'->0->'serials'->>0) = 'S64DNX0T41822',
  'SSD sold with its serial');
select pg_temp.check((select status from public.serials where serial = 'S64DNX0T41822') = 'sold', 'serial marked sold');
select pg_temp.check((select stock from public.products where code = 'SAM-980-500') = 2, 'SSD stock drops to 2');
select pg_temp.expect_error(format($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a8","serial_ids":["%s"]}]', 'cash', 0, null, null, 99999)$q$,
  (select id from public.serials where serial = 'S64DNX0T41822')), 'SERIAL_NOT_AVAILABLE');

-- 6. Payment checks, and a failed sale leaves no trace.
select pg_temp.expect_error($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a2","qty":1}]', 'cash', 0, null, null, 100)$q$, 'CASH_SHORT');
select pg_temp.expect_error($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a2","qty":1}]', 'nagad', 0, null, null, null, '')$q$, 'PAYMENT_REF_REQUIRED');
select pg_temp.expect_error($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000ab","qty":1}]', 'cash', 0, null, null, 5000)$q$, 'OUT_OF_STOCK');
select pg_temp.expect_error($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a2","qty":1}]', 'cash', 0, null, '12345', 500)$q$, 'BAD_PHONE');
select pg_temp.check((select stock from public.products where code = 'VEN-HDMI-15') = 9, 'failed sales did not touch stock');
select pg_temp.check((select count(*) from public.sales) = 4, 'only the 4 good sales exist');

-- 7. Another shop's owner sees nothing of this shop.
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
select pg_temp.check((select count(*) from public.products) = 0 and (select count(*) from public.sales) = 0, 'other shop sees no products or sales');

-- 8. The owner sees costs, the discount approval, and logged price changes.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check((select cost from public.product_costs limit 1) = 250, 'owner sees cost price');
update public.products set price = 480 where code = 'VEN-HDMI-15';
select pg_temp.check((select count(*) from public.audit_log where action = 'price_change') = 1, 'price change is logged');
select pg_temp.check((select count(*) from public.audit_log where action = 'discount_approved') = 1, 'PIN-approved discount is logged');
select pg_temp.check((select receive_stock('00000000-0000-4000-8000-0000000000aa', null, array['R9N0CV12A400'], 66000)) = 1, 'laptop received with serial');
select pg_temp.check((select stock from public.products where code = 'ASU-X1504') = 3, 'laptop stock goes up');

reset role;
\echo ALL DATABASE CHECKS PASSED
