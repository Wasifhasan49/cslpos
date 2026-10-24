-- Checks the owner-protection rules against a local Postgres.
-- Run: scripts/test-db.sh   (any failure stops with an error)
\set ON_ERROR_STOP on

-- Logins: an owner (with a PIN), a manager (with a PIN), a cashier on a 5% limit,
-- an owner of a different shop, and a login with no staff row at all.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'ovi@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'other-shop@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'rafi@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'nobody@example.com');
insert into public.staff (id, shop_id, user_id, name, role, discount_limit_pct) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Owner', 'owner', 100),
  ('aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Ovi', 'cashier', 5),
  ('aaaaaaaa-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'Rafi', 'manager', 10);
insert into public.shops (id, name, invoice_prefix) values ('00000000-0000-4000-8000-000000000099', 'Another shop', 'OTH');
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

-- The owner and the manager each set a PIN.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select public.set_pin('4821');
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select public.set_pin('7390');

-- 0. Guessable PINs are refused, and so is a cashier trying to set one.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.expect_error($q$select public.set_pin('123')$q$, 'BAD_PIN');
select pg_temp.expect_error($q$select public.set_pin('1234567')$q$, 'BAD_PIN');
select pg_temp.expect_error($q$select public.set_pin('abcd')$q$, 'BAD_PIN');
select pg_temp.expect_error($q$select public.set_pin('0000')$q$, 'WEAK_PIN');
select pg_temp.expect_error($q$select public.set_pin('1111')$q$, 'WEAK_PIN');
select pg_temp.expect_error($q$select public.set_pin('1234')$q$, 'WEAK_PIN');
select pg_temp.expect_error($q$select public.set_pin('4321')$q$, 'WEAK_PIN');
select pg_temp.check((select public.has_pin()), 'owner has a PIN');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error($q$select public.set_pin('4821')$q$, 'NOT_MANAGER');
select pg_temp.check((select public.has_pin()) = false, 'cashier has no PIN');

-- From here on we are Ovi, the cashier.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);

-- 1. The filmed sale: 2 splitters, cash 1,000.
select pg_temp.check(
  (public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":2}]', 'cash', 0, null, null, 1000)->>'invoice_no') = 'DEMO2026000001',
  'cash sale completes with the next invoice number');
select pg_temp.check((select stock from public.products where code = 'VEN-AUD-35') = 2, 'stock drops from 4 to 2');
select pg_temp.check((select total from public.sales where invoice_no = 'DEMO2026000001') = 1000, 'total uses the owner''s price (500 x 2)');
select pg_temp.check((select warranty_until from public.sale_items limit 1) = public.dhaka_today() + interval '12 months', 'warranty end date is stored');

-- 2. Cashier can't see cost prices, PIN hashes, the audit log, or PIN attempts.
select pg_temp.check((select count(*) from public.product_costs) = 0, 'cashier sees no cost prices');
select pg_temp.expect_error('select pin_hash from public.staff', 'permission denied');
select pg_temp.expect_error('select * from public.staff', 'permission denied');
select pg_temp.check((select count(*) from public.audit_log) = 0, 'cashier sees no audit log');
select pg_temp.check((select count(*) from public.pin_attempts) = 0, 'cashier sees no PIN attempts');

-- 3. Cashier can't record a sale directly or change a price or their own limit.
select pg_temp.expect_error($q$insert into public.sales (shop_id, invoice_no, staff_id, subtotal, total, payment_method)
  values ('00000000-0000-4000-8000-000000000001', 'FAKE1', 'aaaaaaaa-0000-4000-8000-000000000002', 1, 1, 'cash')$q$, 'row-level security');
update public.products set price = 1 where code = 'VEN-HDMI-15';
select pg_temp.check((select price from public.products where code = 'VEN-HDMI-15') = 450, 'cashier price edit has no effect');
select pg_temp.expect_error($q$update public.staff set discount_limit_pct = 100 where user_id = auth.uid()$q$, 'permission denied');
select pg_temp.expect_error($q$select public.set_staff_access('aaaaaaaa-0000-4000-8000-000000000002', null, 100, null)$q$, 'NOT_OWNER');

-- 4. Discounts over the 5% limit need an approval from verify_manager_pin().
select pg_temp.expect_error($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10, null, null, 1000)$q$, 'MANAGER_PIN_REQUIRED');
select pg_temp.expect_error($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10, gen_random_uuid(), null, 1000)$q$, 'APPROVAL_NOT_VALID');

-- A wrong PIN comes back as a result, not an exception, so the attempt can be recorded.
select pg_temp.check(
  (public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000001', '9999')->>'ok')::boolean = false,
  'wrong manager PIN returns ok=false instead of raising');
-- Checked as the owner, because a cashier must not be able to read PIN attempts and
-- learn that an approver is one wrong try from being locked out.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (select count(*) from public.pin_attempts where not ok) = 1,
  'the failed attempt was RECORDED (it used to vanish on rollback)');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);

-- The right PIN gives an approval the sale consumes once. The approval id comes back
-- from verify_manager_pin() — a cashier cannot read pin_attempts to find one.
create table pg_temp.approval (id uuid);
do $$
declare r jsonb;
begin
  r := public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000001', '4821');
  if not (r->>'ok')::boolean then raise exception 'RIGHT PIN WAS REFUSED: %', r; end if;
  if r->>'approver_name' <> 'Owner' then raise exception 'WRONG APPROVER NAMED: %', r; end if;
  insert into pg_temp.approval values ((r->>'approval_id')::uuid);
  raise notice 'ok: right manager PIN approves and names the approver';
end $$;

select pg_temp.check(
  (public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10,
     (select id from pg_temp.approval), '01711000000', 1000)->>'total')::numeric = 405,
  'with an approval, 10% off 450 = 405');

-- The same approval cannot be replayed for a second discounted sale.
select pg_temp.expect_error(format($q$select public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10, '%s', null, 1000)$q$,
  (select id from pg_temp.approval)), 'APPROVAL_NOT_VALID');

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (select count(*) from public.pin_attempts where ok and used_at is not null) = 1,
  'the approval is marked used');
select pg_temp.check(
  (select discount_approved_by from public.sales where discount_pct = 10) = 'aaaaaaaa-0000-4000-8000-000000000001',
  'the sale records WHICH manager approved it');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);

select pg_temp.check(
  (public.complete_sale('[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 5, null, null, 500)->>'total')::numeric = 427,
  '5% is within the limit, no approval (discount 22.5 rounds to 23, total 427)');

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

-- 7b. A login with no staff row at all sees nothing, and current_staff() says so.
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false);
select pg_temp.check((select public.current_staff()) is null, 'a login with no staff row gets null from current_staff()');
select pg_temp.check(
  (select count(*) from public.products) = 0 and (select count(*) from public.sales) = 0
  and (select count(*) from public.shops) = 0,
  'a login with no staff row reads nothing at all');

-- 8. The owner sees costs, the discount approval, and logged price changes.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check((select cost from public.product_costs limit 1) = 250, 'owner sees cost price');
update public.products set price = 480 where code = 'VEN-HDMI-15';
select pg_temp.check((select count(*) from public.audit_log where action = 'price_change') = 1, 'price change is logged');
select pg_temp.check((select count(*) from public.audit_log where action = 'discount_approved') = 1, 'approved discount is logged');
select pg_temp.check((select count(*) from public.audit_log where action = 'pin_failed') = 1, 'the FAILED PIN attempt is logged for the owner to see');
select pg_temp.check((select count(*) from public.audit_log where action = 'pin_set') = 2, 'both PIN set-ups are logged');
select pg_temp.check((select receive_stock('00000000-0000-4000-8000-0000000000aa', null, array['R9N0CV12A400'], 66000)) = 1, 'laptop received with serial');
select pg_temp.check((select stock from public.products where code = 'ASU-X1504') = 3, 'laptop stock goes up');
-- A trailing comma in a pasted serial list used to create a serial of ''.
select pg_temp.check((select receive_stock('00000000-0000-4000-8000-0000000000aa', null, array['R9N0CV12A401', '  ', ''], 66000)) = 1, 'blank serials are ignored');
select pg_temp.check((select count(*) from public.serials where serial = '') = 0, 'no empty serial was created');
select pg_temp.expect_error($q$select public.receive_stock('00000000-0000-4000-8000-0000000000aa', null, array['', '  '])$q$, 'SERIAL_REQUIRED');

-- 9. A manager cannot give themselves more power. This is the hole P0 closed:
--    before, any manager could raise their own limit to 100%, promote themselves to
--    owner, and deactivate the owner — none of it logged.
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select pg_temp.expect_error($q$update public.staff set discount_limit_pct = 100 where user_id = auth.uid()$q$, 'permission denied');
select pg_temp.expect_error($q$update public.staff set role = 'owner' where user_id = auth.uid()$q$, 'permission denied');
select pg_temp.expect_error($q$update public.staff set active = false where name = 'Owner'$q$, 'permission denied');
select pg_temp.expect_error($q$select public.set_staff_access('aaaaaaaa-0000-4000-8000-000000000004', 'owner', 100, null)$q$, 'NOT_OWNER');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check((select role from public.staff where name = 'Rafi') = 'manager', 'the manager is still a manager');
select pg_temp.check((select discount_limit_pct from public.staff where name = 'Rafi') = 10, 'the manager''s limit is unchanged');
select pg_temp.check((select active from public.staff where name = 'Owner'), 'the owner is still active');

-- 9b. The owner CAN change it, cannot edit their own row, and it is all logged.
select pg_temp.check(
  (public.set_staff_access('aaaaaaaa-0000-4000-8000-000000000004', null, 20, null)->>'discount_limit_pct')::numeric = 20,
  'the owner can raise a manager''s limit');
select pg_temp.check((select count(*) from public.audit_log where action = 'staff_access_changed') = 1, 'the change is logged with before/after');
select pg_temp.expect_error($q$select public.set_staff_access('aaaaaaaa-0000-4000-8000-000000000001', null, 50, null)$q$, 'NO_SELF_EDIT');
select pg_temp.expect_error($q$select public.set_staff_access('aaaaaaaa-0000-4000-8000-000000000004', 'boss', null, null)$q$, 'BAD_ROLE');
select pg_temp.expect_error($q$select public.set_staff_access('aaaaaaaa-0000-4000-8000-000000000004', null, 150, null)$q$, 'BAD_LIMIT');
-- A staff row in another shop is invisible, not editable.
select pg_temp.expect_error($q$select public.set_staff_access((select id from public.staff where name = 'Stranger'), null, 99, null)$q$, 'STAFF_NOT_FOUND');

-- 10. Five wrong PINs in 10 minutes lock that approver out. Rafi is the victim here so
--     the owner's attempt counter stays clean for the sales above.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
do $$
declare i integer; r jsonb;
begin
  for i in 1..5 loop
    r := public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000004', '0001');
    if (r->>'ok')::boolean then raise exception 'WRONG PIN WAS ACCEPTED'; end if;
    if (r->>'locked')::boolean then raise exception 'LOCKED TOO EARLY at attempt %', i; end if;
  end loop;
end $$;
select pg_temp.check(
  (public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000004', '0001')->>'locked')::boolean,
  'the 6th wrong try is locked out');
-- Locked means locked even with the RIGHT PIN, or the lockout is decoration.
select pg_temp.check(
  (public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000004', '7390')->>'ok')::boolean = false,
  'while locked out, even the right PIN is refused');
-- The owner is unaffected: a lockout is per approver, so one cashier hammering one
-- manager cannot stop the shop from selling.
select pg_temp.check(
  (public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000001', '4821')->>'ok')::boolean,
  'a different approver is not locked out');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check((select count(*) from public.audit_log where action = 'pin_locked_out') >= 1, 'the lockout is logged');
select pg_temp.check(
  (select count(*) from public.pin_attempts where approver_id = 'aaaaaaaa-0000-4000-8000-000000000004' and not ok) >= 6,
  'every wrong try against that manager is on the record');

-- 10b. Approvals can only be asked for against a real approver who has a PIN.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error($q$select public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000002', '4821')$q$, 'APPROVER_NOT_FOUND');
select pg_temp.expect_error($q$select public.verify_manager_pin(gen_random_uuid(), '4821')$q$, 'APPROVER_NOT_FOUND');
select pg_temp.check(
  (select jsonb_array_length(public.list_approvers())) = 2,
  'the counter can list the two approvers who have a PIN');

reset role;
\echo ALL DATABASE CHECKS PASSED
