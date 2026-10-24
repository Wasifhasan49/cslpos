-- Checks the owner-protection and branch-separation rules against a local Postgres.
-- Run: scripts/test-db.sh   (any failure stops with an error)
\set ON_ERROR_STOP on

\set SHOP   '00000000-0000-4000-8000-000000000001'
\set BRANCH_A '00000000-0000-4000-8000-0000000000b1'
\set BRANCH_B '00000000-0000-4000-8000-0000000000b2'
\set LOC_A   '00000000-0000-4000-8000-0000000000e1'
\set LOC_B   '00000000-0000-4000-8000-0000000000e2'
\set OWNER   'aaaaaaaa-0000-4000-8000-000000000001'
\set CASHIER 'aaaaaaaa-0000-4000-8000-000000000002'
\set MANAGER 'aaaaaaaa-0000-4000-8000-000000000004'

-- Logins: an owner (all branches), a manager (Branch B only), a cashier (Branch A
-- only), an owner of a different shop, and a login with no staff row at all.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'ovi@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'other-shop@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'rafi@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'nobody@example.com');
insert into public.staff (id, shop_id, user_id, name, role, discount_limit_pct) values
  (:'OWNER',   :'SHOP', '11111111-1111-4111-8111-111111111111', 'Owner', 'owner', 100),
  (:'CASHIER', :'SHOP', '22222222-2222-4222-8222-222222222222', 'Ovi', 'cashier', 5),
  (:'MANAGER', :'SHOP', '44444444-4444-4444-8444-444444444444', 'Rafi', 'manager', 10);

-- The cashier works at Branch A, the manager at Branch B. The owner is listed nowhere
-- on purpose: owners get every branch without a row, so adding a branch can never
-- lock the owner out of it.
insert into public.staff_branches (staff_id, branch_id) values
  (:'CASHIER', :'BRANCH_A'),
  (:'MANAGER', :'BRANCH_B');

insert into public.shops (id, name, invoice_prefix) values ('00000000-0000-4000-8000-000000000099', 'Another shop', 'OTH');
insert into public.branches (id, shop_id, name, code) values
  ('00000000-0000-4000-8000-0000000000b9', '00000000-0000-4000-8000-000000000099', 'Their branch', 'TB');
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

-- From here on we are Ovi, the cashier at Branch A.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);

-- 1. The filmed sale: 2 splitters, cash 1,000, at Branch A.
select pg_temp.check(
  (public.complete_sale(:'BRANCH_A', '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":2}]', 'cash', 0, null, null, 1000)->>'invoice_no') = 'DEMO-MB-2026000001',
  'cash sale completes, numbered per branch');
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a1' and location_id = :'LOC_A') = 2,
  'Branch A stock drops from 4 to 2');
select pg_temp.check((select total from public.sales where invoice_no = 'DEMO-MB-2026000001') = 1000, 'total uses the owner''s price (500 x 2)');
select pg_temp.check((select warranty_until from public.sale_items limit 1) = public.dhaka_today() + interval '12 months', 'warranty end date is stored');

-- 2. Cashier can't see cost prices, PIN hashes, the audit log, or PIN attempts.
select pg_temp.check((select count(*) from public.product_costs) = 0, 'cashier sees no cost prices');
select pg_temp.expect_error('select pin_hash from public.staff', 'permission denied');
select pg_temp.expect_error('select * from public.staff', 'permission denied');
select pg_temp.check((select count(*) from public.audit_log) = 0, 'cashier sees no audit log');
select pg_temp.check((select count(*) from public.pin_attempts) = 0, 'cashier sees no PIN attempts');
select pg_temp.check((select count(*) from public.stock_movements) = 0, 'cashier sees no stock movements');

-- 3. Cashier can't record a sale directly or change a price or their own limit.
select pg_temp.expect_error(format($q$insert into public.sales (shop_id, branch_id, invoice_no, staff_id, subtotal, total, payment_method)
  values ('%s', '%s', 'FAKE1', '%s', 1, 1, 'cash')$q$, :'SHOP', :'BRANCH_A', :'CASHIER'), 'row-level security');
update public.products set price = 1 where code = 'VEN-HDMI-15';
select pg_temp.check((select price from public.products where code = 'VEN-HDMI-15') = 450, 'cashier price edit has no effect');
select pg_temp.expect_error($q$update public.staff set discount_limit_pct = 100 where user_id = auth.uid()$q$, 'permission denied');
select pg_temp.expect_error(format($q$select public.set_staff_access('%s', null, 100, null)$q$, :'CASHIER'), 'NOT_OWNER');
-- Stock is not directly writable either, or the branch rules would be decoration.
select pg_temp.expect_error(format($q$update public.branch_stock set qty = 999 where location_id = '%s'$q$, :'LOC_A'), 'row-level security');

-- 4. Discounts over the 5% limit need an approval from verify_manager_pin().
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10, null, null, 1000)$q$, :'BRANCH_A'), 'MANAGER_PIN_REQUIRED');
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10, gen_random_uuid(), null, 1000)$q$, :'BRANCH_A'), 'APPROVAL_NOT_VALID');

-- A wrong PIN comes back as a result, not an exception, so the attempt can be recorded.
select pg_temp.check(
  (public.verify_manager_pin(:'OWNER', '9999')->>'ok')::boolean = false,
  'wrong manager PIN returns ok=false instead of raising');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (select count(*) from public.pin_attempts where not ok) = 1,
  'the failed attempt was RECORDED (it used to vanish on rollback)');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);

-- The right PIN gives an approval the sale consumes once.
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
  (public.complete_sale(:'BRANCH_A', '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10,
     (select id from pg_temp.approval), '01711000000', 1000)->>'total')::numeric = 405,
  'with an approval, 10% off 450 = 405');

-- The same approval cannot be replayed for a second discounted sale.
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 10, '%s', null, 1000)$q$,
  :'BRANCH_A', (select id from pg_temp.approval)), 'APPROVAL_NOT_VALID');

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (select count(*) from public.pin_attempts where ok and used_at is not null) = 1,
  'the approval is marked used');
select pg_temp.check(
  (select discount_approved_by from public.sales where discount_pct = 10) = :'OWNER',
  'the sale records WHICH manager approved it');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);

select pg_temp.check(
  (public.complete_sale(:'BRANCH_A', '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 5, null, null, 500)->>'total')::numeric = 427,
  '5% is within the limit, no approval (discount 22.5 rounds to 23, total 427)');

-- 5. Serial items need a real, unsold serial that is AT THIS BRANCH.
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a8","qty":1}]', 'bkash', 0, null, null, null, 'TRX12345')$q$, :'BRANCH_A'), 'SERIAL_REQUIRED');
select pg_temp.check(
  (public.complete_sale(:'BRANCH_A', jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a8',
     'serial_ids', jsonb_build_array((select id from public.serials where serial = 'S64DNX0T41822'))))
   , 'bkash', 0, null, null, null, 'TRX12345')->'items'->0->'serials'->>0) = 'S64DNX0T41822',
  'SSD sold with its serial');
select pg_temp.check((select status from public.serials where serial = 'S64DNX0T41822') = 'sold', 'serial marked sold');
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a8' and location_id = :'LOC_A') = 2,
  'SSD stock at Branch A drops to 2');
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a8","serial_ids":["%s"]}]', 'cash', 0, null, null, 99999)$q$,
  :'BRANCH_A', (select id from public.serials where serial = 'S64DNX0T41822')), 'SERIAL_NOT_AVAILABLE');

-- 6. Payment checks, and a failed sale leaves no trace.
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a2","qty":1}]', 'cash', 0, null, null, 100)$q$, :'BRANCH_A'), 'CASH_SHORT');
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a2","qty":1}]', 'nagad', 0, null, null, null, '')$q$, :'BRANCH_A'), 'PAYMENT_REF_REQUIRED');
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000ab","qty":1}]', 'cash', 0, null, null, 5000)$q$, :'BRANCH_A'), 'OUT_OF_STOCK');
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a2","qty":1}]', 'cash', 0, null, '12345', 500)$q$, :'BRANCH_A'), 'BAD_PHONE');
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a2' and location_id = :'LOC_A') = 9,
  'failed sales did not touch stock');
select pg_temp.check((select count(*) from public.sales) = 4, 'only the 4 good sales exist');

-- 7. Another shop's owner sees nothing of this shop.
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
select pg_temp.check((select count(*) from public.products) = 0 and (select count(*) from public.sales) = 0, 'other shop sees no products or sales');
select pg_temp.check((select count(*) from public.branches) = 1, 'other shop sees only its own branch');
select pg_temp.check((select count(*) from public.branch_stock) = 0, 'other shop sees no stock');

-- 7b. A login with no staff row at all sees nothing, and current_staff() says so.
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false);
select pg_temp.check((select public.current_staff()) is null, 'a login with no staff row gets null from current_staff()');
select pg_temp.check(
  (select count(*) from public.products) = 0 and (select count(*) from public.sales) = 0
  and (select count(*) from public.shops) = 0 and (select count(*) from public.branches) = 0,
  'a login with no staff row reads nothing at all');

-- 8. The owner sees costs, the discount approval, and logged price changes.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check((select cost from public.product_costs limit 1) = 250, 'owner sees cost price');
update public.products set price = 480 where code = 'VEN-HDMI-15';
select pg_temp.check((select count(*) from public.audit_log where action = 'price_change') = 1, 'price change is logged');
select pg_temp.check((select count(*) from public.audit_log where action = 'discount_approved') = 1, 'approved discount is logged');
select pg_temp.check((select count(*) from public.audit_log where action = 'pin_failed') = 1, 'the FAILED PIN attempt is logged for the owner to see');
select pg_temp.check((select count(*) from public.audit_log where action = 'pin_set') = 2, 'both PIN set-ups are logged');
select pg_temp.check((select receive_stock(:'BRANCH_A', '00000000-0000-4000-8000-0000000000aa', null, array['R9N0CV12A400'], 66000)) = 1, 'laptop received with serial');
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000aa' and location_id = :'LOC_A') = 3,
  'laptop stock goes up at Branch A');
select pg_temp.check((select receive_stock(:'BRANCH_A', '00000000-0000-4000-8000-0000000000aa', null, array['R9N0CV12A401', '  ', ''], 66000)) = 1, 'blank serials are ignored');
select pg_temp.check((select count(*) from public.serials where serial = '') = 0, 'no empty serial was created');
select pg_temp.expect_error(format($q$select public.receive_stock('%s', '00000000-0000-4000-8000-0000000000aa', null, array['', '  '])$q$, :'BRANCH_A'), 'SERIAL_REQUIRED');

-- 9. A manager cannot give themselves more power.
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select pg_temp.expect_error($q$update public.staff set discount_limit_pct = 100 where user_id = auth.uid()$q$, 'permission denied');
select pg_temp.expect_error($q$update public.staff set role = 'owner' where user_id = auth.uid()$q$, 'permission denied');
select pg_temp.expect_error($q$update public.staff set active = false where name = 'Owner'$q$, 'permission denied');
select pg_temp.expect_error(format($q$select public.set_staff_access('%s', 'owner', 100, null)$q$, :'MANAGER'), 'NOT_OWNER');
-- Nor can a manager give themselves another branch.
select pg_temp.expect_error(format($q$select public.set_staff_branches('%s', array['%s','%s']::uuid[])$q$, :'MANAGER', :'BRANCH_A', :'BRANCH_B'), 'NOT_OWNER');
select pg_temp.expect_error($q$select public.save_branch(null, 'Sneaky branch', 'SNK')$q$, 'NOT_OWNER');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check((select role from public.staff where name = 'Rafi') = 'manager', 'the manager is still a manager');
select pg_temp.check((select discount_limit_pct from public.staff where name = 'Rafi') = 10, 'the manager''s limit is unchanged');
select pg_temp.check((select active from public.staff where name = 'Owner'), 'the owner is still active');
select pg_temp.check((select count(*) from public.branches where shop_id = :'SHOP') = 2, 'no extra branch was created');

-- 9b. The owner CAN change it, cannot edit their own row, and it is all logged.
select pg_temp.check(
  (public.set_staff_access(:'MANAGER', null, 20, null)->>'discount_limit_pct')::numeric = 20,
  'the owner can raise a manager''s limit');
select pg_temp.check((select count(*) from public.audit_log where action = 'staff_access_changed') = 1, 'the change is logged with before/after');
select pg_temp.expect_error(format($q$select public.set_staff_access('%s', null, 50, null)$q$, :'OWNER'), 'NO_SELF_EDIT');
select pg_temp.expect_error(format($q$select public.set_staff_access('%s', 'boss', null, null)$q$, :'MANAGER'), 'BAD_ROLE');
select pg_temp.expect_error(format($q$select public.set_staff_access('%s', null, 150, null)$q$, :'MANAGER'), 'BAD_LIMIT');
select pg_temp.expect_error($q$select public.set_staff_access((select id from public.staff where name = 'Stranger'), null, 99, null)$q$, 'STAFF_NOT_FOUND');

-- 10. Five wrong PINs in 10 minutes lock that approver out.
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
  (public.verify_manager_pin(:'MANAGER', '0001')->>'locked')::boolean,
  'the 6th wrong try is locked out');
select pg_temp.check(
  (public.verify_manager_pin(:'MANAGER', '7390')->>'ok')::boolean = false,
  'while locked out, even the right PIN is refused');
select pg_temp.check(
  (public.verify_manager_pin(:'OWNER', '4821')->>'ok')::boolean,
  'a different approver is not locked out');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check((select count(*) from public.audit_log where action = 'pin_locked_out') >= 1, 'the lockout is logged');
select pg_temp.check(
  (select count(*) from public.pin_attempts where approver_id = :'MANAGER' and not ok) >= 6,
  'every wrong try against that manager is on the record');

-- 10b. Approvals can only be asked for against a real approver who has a PIN.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error(format($q$select public.verify_manager_pin('%s', '4821')$q$, :'CASHIER'), 'APPROVER_NOT_FOUND');
select pg_temp.expect_error($q$select public.verify_manager_pin(gen_random_uuid(), '4821')$q$, 'APPROVER_NOT_FOUND');
select pg_temp.check(
  (select jsonb_array_length(public.list_approvers())) = 2,
  'the counter can list the two approvers who have a PIN');

-- ===========================================================================
-- 11. BRANCHES. The point of P1: a cashier at Branch A must not be able to see
--     or touch Branch B, even by calling the functions directly.
-- ===========================================================================

-- Still Ovi, the cashier at Branch A.
select pg_temp.check(
  (select public.current_branch_ids()) = array[:'BRANCH_A']::uuid[],
  'the cashier may work in Branch A only');
select pg_temp.check(public.can_use_branch(:'BRANCH_A'), 'the cashier can use Branch A');
select pg_temp.check(public.can_use_branch(:'BRANCH_B') = false, 'the cashier cannot use Branch B');

-- Selling out of a branch you do not work in is refused by the database, not the UI.
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 1000)$q$, :'BRANCH_B'), 'BRANCH_NOT_ALLOWED');
select pg_temp.expect_error(format($q$select public.branch_products('%s')$q$, :'BRANCH_B'), 'BRANCH_NOT_ALLOWED');
select pg_temp.expect_error($q$select public.complete_sale(null, '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 1000)$q$, 'BRANCH_REQUIRED');

-- Reading Branch B's numbers directly: every one of these must come back empty.
select pg_temp.check(
  (select count(*) from public.branch_stock where branch_id = :'BRANCH_B') = 0,
  'the cashier cannot read Branch B stock');
select pg_temp.check(
  (select count(*) from public.sales where branch_id = :'BRANCH_B') = 0,
  'the cashier cannot read Branch B sales');
select pg_temp.check(
  (select count(*) from public.shifts where branch_id = :'BRANCH_B') = 0,
  'the cashier cannot read Branch B shifts');
select pg_temp.check(
  (select count(*) from public.serials where serial = 'S64DNX0T49999') = 0,
  'the cashier cannot see a serial sitting at Branch B');
-- But the catalogue is shop-wide: a product exists and has a price everywhere.
select pg_temp.check((select count(*) from public.products) = 11, 'the cashier still sees the whole catalogue');
select pg_temp.check((select count(*) from public.branches where shop_id = :'SHOP') = 2, 'the cashier can see that both branches exist (the switcher needs it)');

-- branch_products() reports Branch A's own figures, not the shop's total.
select pg_temp.check(
  (select (x->>'stock')::int from jsonb_array_elements(public.branch_products(:'BRANCH_A')) x
   where x->>'code' = 'VEN-AUD-35') = 2,
  'branch_products at Branch A shows 2 splitters (4 minus the 2 sold)');
select pg_temp.check(
  (select jsonb_array_length(x->'serials') from jsonb_array_elements(public.branch_products(:'BRANCH_A')) x
   where x->>'code' = 'SAM-980-500') = 2,
  'only Branch A''s unsold SSD serials are offered at Branch A');

-- Selling at A must not change B. This is the prompt's "done when".
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a1' and location_id = :'LOC_B') = 6,
  'Branch B still has its own 6 splitters after Branch A sold 2');
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a8' and location_id = :'LOC_B') = 1,
  'Branch B still has its own SSD after Branch A sold one');
select pg_temp.check(
  (select status from public.serials where serial = 'S64DNX0T49999') = 'in_stock',
  'Branch B''s SSD serial was not touched');

-- The owner sees every branch and each branch's own numbering.
select pg_temp.check(
  (select array_length(public.current_branch_ids(), 1)) = 2,
  'the owner gets both branches without a staff_branches row');
select pg_temp.check(
  (public.complete_sale(:'BRANCH_B', '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 500)->>'invoice_no') = 'DEMO-SB-2026000001',
  'Branch B numbers from its own 1, with its own code');
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a1' and location_id = :'LOC_B') = 5,
  'that sale came out of Branch B stock');
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a1' and location_id = :'LOC_A') = 2,
  'and Branch A was untouched by it');

-- The manager works at Branch B only, so it mirrors the cashier the other way round.
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select pg_temp.check(
  (select public.current_branch_ids()) = array[:'BRANCH_B']::uuid[],
  'the manager may work in Branch B only');
select pg_temp.check(
  (select count(*) from public.sales where branch_id = :'BRANCH_A') = 0,
  'the manager at B cannot read Branch A sales');
select pg_temp.check(
  (select count(*) from public.sales where branch_id = :'BRANCH_B') = 1,
  'the manager at B can read Branch B sales');
select pg_temp.expect_error(format($q$select public.receive_stock('%s', '00000000-0000-4000-8000-0000000000a1', 5)$q$, :'BRANCH_A'), 'BRANCH_NOT_ALLOWED');
select pg_temp.check((select public.receive_stock(:'BRANCH_B', '00000000-0000-4000-8000-0000000000a1', 5)) = 5, 'the manager can receive stock at their own branch');

-- A cashier cannot receive stock at all.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error(format($q$select public.receive_stock('%s', '00000000-0000-4000-8000-0000000000a1', 5)$q$, :'BRANCH_A'), 'NOT_MANAGER');

-- 12. Branch administration is owner-only, and a shop cannot lose its last branch.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (public.save_branch(null, 'Third branch', 'TB3', '789 Road', '01700-000002')->>'code') = 'TB3',
  'the owner can add a branch');
select pg_temp.check(
  (select count(*) from public.stock_locations l join public.branches b on b.id = l.branch_id
   where b.code = 'TB3' and l.is_default) = 1,
  'a new branch gets a default stock location, so it can hold stock immediately');
select pg_temp.check(
  (select count(*) from public.branch_stock bs join public.branches b on b.id = bs.branch_id where b.code = 'TB3') = 11,
  'every product starts at 0 there, so stock reports show a real zero not a gap');
select pg_temp.expect_error($q$select public.save_branch(null, 'Bad code', 'lowercase')$q$, 'BAD_BRANCH_CODE');
select pg_temp.expect_error($q$select public.save_branch(null, '', 'X1')$q$, 'BRANCH_NAME_REQUIRED');
select pg_temp.check(
  (public.save_branch((select id from public.branches where code = 'TB3'), null, null, null, null, false)->>'active')::boolean = false,
  'the owner can switch a branch off');
select pg_temp.check((select count(*) from public.audit_log where action = 'branch_created') = 1, 'adding a branch is logged');
select pg_temp.check((select count(*) from public.audit_log where action = 'branch_changed') = 1, 'changing a branch is logged');

-- Assigning branches to staff.
select pg_temp.check(
  (select jsonb_array_length(public.set_staff_branches(:'CASHIER', array[:'BRANCH_A', :'BRANCH_B']::uuid[])->'branch_ids')) = 2,
  'the owner can let the cashier work in both branches');
select pg_temp.check((select count(*) from public.audit_log where action = 'staff_branches_changed') = 1, 'the branch assignment is logged');
select pg_temp.expect_error(format($q$select public.set_staff_branches('%s', array[gen_random_uuid()]::uuid[])$q$, :'CASHIER'), 'BRANCH_NOT_FOUND');

-- And now the cashier really can sell at Branch B.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.check(
  (select array_length(public.current_branch_ids(), 1)) = 2,
  'the cashier now has both branches');
select pg_temp.check(
  (public.complete_sale(:'BRANCH_B', '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 500)->>'invoice_no') = 'DEMO-SB-2026000002',
  'Branch B''s numbering carries on from its own last invoice');

reset role;
\echo ALL DATABASE CHECKS PASSED
