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
select pg_temp.check((select count(*) from public.products) = 12, 'the cashier still sees the whole catalogue');
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
-- 550, not 500: Branch B has its own price for the splitter, and a branch override
-- beats the all-branches price.
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b2',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 550);
  if (r->>'invoice_no') <> 'DEMO-SB-2026000001' then
    raise exception 'WRONG INVOICE: %', r->>'invoice_no';
  end if;
  if (r->>'total')::numeric <> 550 then
    raise exception 'BRANCH PRICE OVERRIDE IGNORED: %', r->>'total';
  end if;
  raise notice 'ok: Branch B numbers from its own 1 and charges its own 550 price';
end $$;
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
select pg_temp.expect_error(format($q$select public.receive_stock('%s', '00000000-0000-4000-8000-0000000000a1', 5)$q$, :'BRANCH_A'), 'NOT_ALLOWED:receive_stock');

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
  (select count(*) from public.branch_stock bs join public.branches b on b.id = bs.branch_id where b.code = 'TB3') = 12,
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
  (public.complete_sale(:'BRANCH_B', '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 550)->>'invoice_no') = 'DEMO-SB-2026000002',
  'Branch B''s numbering carries on from its own last invoice');

-- ===========================================================================
-- 13. SETTINGS, PERMISSIONS AND VAT (P2)
-- ===========================================================================

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

-- A new shop is usable with nothing configured.
select pg_temp.check((select count(*) from public.units where shop_id = :'SHOP') >= 6, 'a new shop has units');
select pg_temp.check((select count(*) from public.payment_methods where shop_id = :'SHOP' and enabled) >= 4, 'a new shop takes cash, bKash, Nagad and card');
select pg_temp.check((select count(*) from public.warranty_terms where shop_id = :'SHOP') >= 4, 'a new shop has warranty terms with receipt wording');
select pg_temp.check((select count(*) from public.discount_types where shop_id = :'SHOP') >= 4, 'a new shop has discount reasons');
select pg_temp.check((select count(*) from public.vat_rates where shop_id = :'SHOP') >= 3, 'a new shop has VAT rates ready');
select pg_temp.check(public.feature_on('vat') = false, 'but VAT is OFF until the shop turns it on');
select pg_temp.check(public.feature_on('accounts') = false, 'and so are accounts, so a small shop sees a simple app');

-- Permissions: the defaults match the roles that already existed.
select pg_temp.check(public.has_permission('edit_settings'), 'the owner can change settings');
select pg_temp.check(public.has_permission('see_cost'), 'the owner can see costs');
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select pg_temp.check(public.has_permission('receive_stock'), 'a manager can receive stock');
select pg_temp.check(public.has_permission('see_cost'), 'a manager can see costs');
select pg_temp.check(public.has_permission('edit_settings') = false, 'a manager cannot change settings');
select pg_temp.check(public.has_permission('view_accounts') = false, 'a manager cannot see the accounts');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.check(public.has_permission('sell'), 'a cashier can sell');
select pg_temp.check(public.has_permission('see_cost') = false, 'a cashier cannot see costs');
select pg_temp.check(public.has_permission('receive_stock') = false, 'a cashier cannot receive stock');
select pg_temp.check(public.permission_limit('give_discount') = 5, 'the cashier''s discount limit is 5%');

-- Only the owner changes permissions, and it is logged.
select pg_temp.expect_error($q$select public.set_role_permission('cashier', 'see_cost', true)$q$, 'NOT_OWNER');
select pg_temp.expect_error($q$select public.set_staff_permission('aaaaaaaa-0000-4000-8000-000000000002', 'see_cost', true)$q$, 'NOT_OWNER');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select public.set_staff_permission(:'CASHIER', 'receive_stock', true);
select pg_temp.check((select count(*) from public.audit_log where action = 'permission_changed') = 1, 'the permission change is logged');
select pg_temp.expect_error($q$select public.set_role_permission('cashier', 'not_a_real_permission', true)$q$, 'BAD_PERMISSION');

-- That one cashier can now take a delivery, without becoming a manager.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.check(public.has_permission('receive_stock'), 'the per-person override beats the role default');
select pg_temp.check((select public.receive_stock(:'BRANCH_A', '00000000-0000-4000-8000-0000000000a2', 1)) = 1, 'and the function lets them through');
-- Taking it away again puts them back on the role default.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select public.set_staff_permission(:'CASHIER', 'receive_stock', null);
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.check(public.has_permission('receive_stock') = false, 'clearing the override restores the role default');

-- VAT. The prompt'''s done-when: turn it on, set 5% inclusive, sell, see the VAT part.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select public.set_feature('vat', true);
select pg_temp.check(public.feature_on('vat'), 'VAT is on');
update public.products set vat_rate_id = (select id from public.vat_rates where shop_id = :'SHOP' and pct = 5 and inclusive)
  where shop_id = :'SHOP' and code = 'LOG-K120';

-- Inclusive: an 850 keyboard still costs 850, and 40.48 of it is VAT.
--   850 * 5 / 105 = 40.476… -> 40.48
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]', 'cash', 0, null, null, 850);
  if (r->>'total')::numeric <> 850 then raise exception 'INCLUSIVE VAT CHANGED THE TOTAL: %', r->>'total'; end if;
  if (r->'items'->0->>'vat_amount')::numeric <> 40.48 then
    raise exception 'WRONG INCLUSIVE VAT: %', r->'items'->0->>'vat_amount';
  end if;
  raise notice 'ok: 5%% inclusive VAT on 850 is 40.48 and the customer still pays 850';
end $$;

-- Inclusive VAT after a discount is worked out on the DISCOUNTED line, or every
-- discounted sale overstates the tax. 850 - 10% = 765; 765 * 5 / 105 = 36.43.
do $$
declare r jsonb; a jsonb;
begin
  a := public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000001', '4821');
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]', 'cash', 10,
        (a->>'approval_id')::uuid, null, 850);
  if (r->>'total')::numeric <> 765 then raise exception 'WRONG DISCOUNTED TOTAL: %', r->>'total'; end if;
  if (r->'items'->0->>'vat_amount')::numeric <> 36.43 then
    raise exception 'VAT NOT RECALCULATED AFTER DISCOUNT: %', r->'items'->0->>'vat_amount';
  end if;
  raise notice 'ok: a 10%% discount drops the inclusive VAT from 40.48 to 36.43';
end $$;

-- Exclusive: the tax goes ON TOP, so the customer pays more than the shelf price.
-- Changed through the saver, because vat_rates has no write policy: the setup lists are
-- only writable through the functions, which is the point.
select public.save_setting_row('vat_rates',
  (select id from public.vat_rates where shop_id = :'SHOP' and pct = 5), '{"inclusive":false}');
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]', 'cash', 0, null, null, 900);
  if (r->>'total')::numeric <> 892.50 then raise exception 'EXCLUSIVE VAT NOT ADDED: %', r->>'total'; end if;
  if (r->>'vat_amount')::numeric <> 42.50 then raise exception 'WRONG EXCLUSIVE VAT: %', r->>'vat_amount'; end if;
  raise notice 'ok: 5%% exclusive VAT turns 850 into 892.50, with 42.50 of tax';
end $$;

-- A product with no rate is untaxed even with VAT on, so a shop can tax some lines.
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 0, null, null, 450);
  if (r->>'vat_amount')::numeric <> 0 then raise exception 'UNTAXED PRODUCT GOT VAT: %', r->>'vat_amount'; end if;
  if (r->>'total')::numeric <> 450 then raise exception 'UNTAXED TOTAL CHANGED: %', r->>'total'; end if;
  raise notice 'ok: a product with no VAT rate is untaxed';
end $$;

-- Turning VAT off goes back to no tax anywhere.
select public.set_feature('vat', false);
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]', 'cash', 0, null, null, 850);
  if (r->>'vat_amount')::numeric <> 0 then raise exception 'VAT STILL CHARGED WHEN OFF: %', r->>'vat_amount'; end if;
  if (r->'items'->0->>'vat_amount')::numeric <> 0 then raise exception 'LINE VAT STILL SET WHEN OFF'; end if;
  raise notice 'ok: turning VAT off stops it being charged';
end $$;

-- A payment method the shop has not turned on is refused.
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cheque', 0, null, null, null, 'CHQ123456')$q$, :'BRANCH_A'), 'BAD_PAYMENT_METHOD');

-- Extra charges are added on top and named on the receipt.
select public.set_feature('extra_charges', true);
select public.save_setting_row('extra_charges',
  (select id from public.extra_charges where shop_id = :'SHOP' and name = 'Delivery'), '{"value":100}');
do $$
declare r jsonb; chg uuid;
begin
  select id into chg from public.extra_charges where name = 'Delivery';
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 0, null, null, 600,
        null, jsonb_build_array(jsonb_build_object('charge_id', chg)));
  if (r->>'total')::numeric <> 550 then raise exception 'CHARGE NOT ADDED: %', r->>'total'; end if;
  if (r->'charges'->0->>'name') <> 'Delivery' then raise exception 'CHARGE NOT NAMED: %', r->'charges'; end if;
  raise notice 'ok: a 100 delivery charge turns a 450 mouse into 550, named on the receipt';
end $$;

-- A discount reason is recorded, so the owner's report says WHY.
-- Sold by the CASHIER on purpose: an owner's 20% is inside their own 100% limit, so it
-- needs no approval and correctly logs nothing to approve.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
do $$
declare r jsonb; a jsonb; dt uuid;
begin
  select id into dt from public.discount_types where name = 'Festival offer';
  a := public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000001', '4821');
  if not (a->>'ok')::boolean then raise exception 'APPROVAL REFUSED: %', a; end if;
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]', 'cash', 20,
        (a->>'approval_id')::uuid, null, 400, null, null, dt);
  if (select discount_type_id from public.sales where id = (r->>'id')::uuid) <> dt then
    raise exception 'DISCOUNT REASON NOT SAVED';
  end if;
  raise notice 'ok: the discount reason is saved on the sale';
end $$;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'discount_approved' and details->>'reason' = 'Festival offer') = 1,
  'and the reason is in the audit log the owner reads');

-- Document numbering: per branch, per type, forward only, logged.
-- Uses purchase orders, because goods-received numbers are consumed by the receive
-- tests above and this check is about the numbering, not about GRNs.
select pg_temp.check(public.next_document_number(:'BRANCH_A', 'po') = 'PO-MB-' || to_char(public.dhaka_today(), 'YYYY') || '000001', 'the first purchase order at Branch A');
select pg_temp.check(public.next_document_number(:'BRANCH_A', 'po') = 'PO-MB-' || to_char(public.dhaka_today(), 'YYYY') || '000002', 'and the next one follows');
select pg_temp.check(public.next_document_number(:'BRANCH_B', 'po') = 'PO-SB-' || to_char(public.dhaka_today(), 'YYYY') || '000001', 'Branch B numbers its own from 1');
select public.set_document_next_number(:'BRANCH_A', 'po', 500);
select pg_temp.check(public.next_document_number(:'BRANCH_A', 'po') = 'PO-MB-' || to_char(public.dhaka_today(), 'YYYY') || '000500', 'the owner can skip ahead to match a paper book');
select pg_temp.expect_error(format($q$select public.set_document_next_number('%s', 'po', 2)$q$, :'BRANCH_A'), 'NUMBER_GOES_BACKWARDS');
select pg_temp.check((select count(*) from public.audit_log where action = 'document_number_changed') = 1, 'changing a document number is logged');

-- Settings writes need the permission, go through the one saver, and are logged.
select pg_temp.check((public.save_setting_row('units', null, '{"name":"dozen","allow_decimals":false}')->>'name') = 'dozen', 'the owner can add a unit');
select pg_temp.expect_error($q$select public.save_setting_row('staff', null, '{"name":"nope"}')$q$, 'BAD_SETTING_TABLE');
select pg_temp.expect_error($q$select public.save_setting_row('units', null, '{"shop_id":"00000000-0000-4000-8000-000000000099"}')$q$, 'BAD_SETTING_FIELD');
select pg_temp.check((public.save_shop_details('{"receipt_footer":"Thank you. Keep this for warranty."}')->>'receipt_footer') = 'Thank you. Keep this for warranty.', 'the owner can set the receipt footer');
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select pg_temp.expect_error($q$select public.save_setting_row('units', null, '{"name":"sneaky"}')$q$, 'NOT_ALLOWED:edit_settings');
select pg_temp.expect_error($q$select public.save_shop_details('{"name":"Rafi Shop"}')$q$, 'NOT_ALLOWED:edit_settings');
select pg_temp.expect_error($q$select public.set_feature('accounts', true)$q$, 'NOT_OWNER');

-- The area list is national reference data every shop reads.
select pg_temp.check((select count(*) from public.divisions) = 8, 'all 8 divisions');
select pg_temp.check((select count(*) from public.districts) = 64, 'all 64 districts');
select pg_temp.check((select count(*) from public.upazilas) > 480, 'nearly 500 upazilas (thanas)');
select pg_temp.check((select name from public.districts where id = 1) = 'Comilla', 'districts carry real names');
select pg_temp.check((select count(*) from public.upazilas u join public.districts d on d.id = u.district_id where d.name = 'Dhaka') > 1, 'Dhaka district has its thanas');
select pg_temp.check((select count(*) from public.countries) > 10, 'countries for suppliers who import');


-- ===========================================================================
-- 14. PRODUCTS AND PRICES (P3)
-- ===========================================================================
-- The rule this product exists for: the owner sets prices, they fill in
-- automatically, and a seller may only move inside the band the owner allowed.

\set LIST_RETAIL '(select id from public.price_lists where shop_id = ''00000000-0000-4000-8000-000000000001'' and is_default)'
\set LIST_DEALER '00000000-0000-4000-8000-0000000000f2'
\set KEYBOARD '00000000-0000-4000-8000-0000000000a5'
\set MOUSE    '00000000-0000-4000-8000-0000000000a4'
\set SERVICE  '00000000-0000-4000-8000-0000000000ac'
\set HDMI     '00000000-0000-4000-8000-0000000000a2'
\set ADAPTER  '00000000-0000-4000-8000-0000000000a3'

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

-- Every shop gets a Retail list, and every product a price on it, so nothing is
-- unsellable just because nobody opened the pricing screen.
select pg_temp.check((select count(*) from public.price_lists where shop_id = :'SHOP' and is_default) = 1, 'the shop has exactly one default price list');
select pg_temp.check(
  (select count(*) from public.products p where p.shop_id = :'SHOP'
     and not exists (select 1 from public.product_prices pp
                     where pp.product_id = p.id and pp.branch_id is null
                       and pp.price_list_id = (select id from public.price_lists where shop_id = :'SHOP' and is_default))) = 0,
  'every product has a price on the default list');

-- resolve_price: branch override beats the all-branches price.
select pg_temp.check((public.resolve_price(:'KEYBOARD', :'BRANCH_A')->>'price')::numeric = 850, 'the keyboard is 850 at Branch A');
select pg_temp.check((public.resolve_price('00000000-0000-4000-8000-0000000000a1', :'BRANCH_A')->>'price')::numeric = 500, 'the splitter is 500 at Branch A');
select pg_temp.check((public.resolve_price('00000000-0000-4000-8000-0000000000a1', :'BRANCH_B')->>'price')::numeric = 550, 'but 550 at Branch B, where there is an override');

-- With no minimum set, the list price IS the floor: nobody has been given permission
-- to go below it.
select pg_temp.check((public.resolve_price(:'MOUSE', :'BRANCH_A')->>'min_price')::numeric = 450, 'with no band, the list price is the floor');
select pg_temp.check((public.resolve_price(:'KEYBOARD', :'BRANCH_A')->>'min_price')::numeric = 800, 'the keyboard may go down to 800');
select pg_temp.check((public.resolve_price(:'KEYBOARD', :'BRANCH_A')->>'mrp')::numeric = 950, 'and its MRP is on the record');

-- The dealer list is cheaper.
select pg_temp.check((public.resolve_price(:'KEYBOARD', :'BRANCH_A', :'LIST_DEALER')->>'price')::numeric = 750, 'a dealer pays 750 for the keyboard');

-- ---- The done-when, part 1: a dealer gets the dealer price automatically ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
do $$
declare r jsonb;
begin
  -- The cashier passes no price list at all; the customer's phone number decides it.
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]', 'cash', 0, null,
        '01811000000', 750);
  if (r->>'total')::numeric <> 750 then raise exception 'DEALER PRICE NOT APPLIED: %', r->>'total'; end if;
  if (r->>'price_list_name') <> 'Dealer' then raise exception 'WRONG PRICE LIST: %', r->>'price_list_name'; end if;
  if (r->'items'->0->>'unit_price')::numeric <> 750 then raise exception 'WRONG LINE PRICE'; end if;
  raise notice 'ok: a dealer customer is charged 750 automatically, from their own price list';
end $$;

-- A walk-in with no phone number still pays retail.
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]', 'cash', 0, null, null, 850);
  if (r->>'total')::numeric <> 850 then raise exception 'WALK-IN NOT CHARGED RETAIL: %', r->>'total'; end if;
  raise notice 'ok: a walk-in pays the retail 850';
end $$;

-- A customer's standing discount applies on its own, with no approval: the owner set it.
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]', 'cash', 0, null,
        '01911000000', 800);
  -- 8% off 850 = 68, so 782.
  if (r->>'total')::numeric <> 782 then raise exception 'STANDING DISCOUNT NOT APPLIED: %', r->>'total'; end if;
  if (r->>'customer_discount_pct')::numeric <> 8 then raise exception 'DISCOUNT NOT REPORTED'; end if;
  raise notice 'ok: a regular customer gets their 8%% automatically, no PIN';
end $$;

-- ---- The done-when, part 2: the band, and the PIN below it ----
-- Down to the minimum is allowed outright.
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1,"unit_price":800}]',
        'cash', 0, null, null, 800);
  if (r->>'total')::numeric <> 800 then raise exception 'MINIMUM PRICE REFUSED: %', r->>'total'; end if;
  if not (r->'items'->0->>'price_overridden')::boolean then raise exception 'OVERRIDE NOT FLAGGED'; end if;
  if (r->'items'->0->>'list_price')::numeric <> 850 then raise exception 'LIST PRICE NOT KEPT'; end if;
  raise notice 'ok: a cashier may drop the keyboard to its 800 minimum without asking';
end $$;

-- One taka below it is refused without a manager.
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1,"unit_price":799}]', 'cash', 0, null, null, 799)$q$, :'BRANCH_A'), 'MANAGER_PIN_REQUIRED');

-- A product with no band cannot be discounted by a cashier at all.
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1,"unit_price":400}]', 'cash', 0, null, null, 400)$q$, :'BRANCH_A'), 'MANAGER_PIN_REQUIRED');

-- With a manager's approval it goes through, and the override is logged with BOTH
-- prices so the owner can see what it cost them.
do $$
declare r jsonb; a jsonb;
begin
  a := public.verify_manager_pin('aaaaaaaa-0000-4000-8000-000000000001', '4821');
  if not (a->>'ok')::boolean then raise exception 'APPROVAL REFUSED: %', a; end if;
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":2,"unit_price":700}]',
        'cash', 0, (a->>'approval_id')::uuid, null, 1400);
  if (r->>'total')::numeric <> 1400 then raise exception 'APPROVED OVERRIDE REFUSED: %', r->>'total'; end if;
  raise notice 'ok: with a PIN, the keyboard goes out at 700';
end $$;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
do $$
declare d jsonb;
begin
  select details into d from public.audit_log
    where action = 'price_overridden' and (details->>'charged')::numeric = 700 limit 1;
  if d is null then raise exception 'OVERRIDE NOT LOGGED'; end if;
  if (d->>'list_price')::numeric <> 850 then raise exception 'LIST PRICE MISSING FROM LOG: %', d; end if;
  -- 2 x (850 - 700) = 300 the shop gave away.
  if (d->>'difference')::numeric <> 300 then raise exception 'GIVEAWAY NOT COMPUTED: %', d; end if;
  raise notice 'ok: the override is logged with list 850, charged 700, and 300 given away';
end $$;

-- Raising the price above the list is an override too, not a free pass.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1,"unit_price":600}]', 'cash', 0, null, null, 600)$q$, :'BRANCH_A'), 'MANAGER_PIN_REQUIRED');

-- ---- The done-when, part 3: a cashier sees no cost or margin, anywhere ----
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.catalogue(:'BRANCH_A')) x where x ? 'cost') = 0,
  'the catalogue a cashier receives has no cost key at all');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.catalogue(:'BRANCH_A')) x where x ? 'margin_pct') = 0,
  'and no margin key either');
select pg_temp.check((select count(*) from public.product_costs) = 0, 'and the cost table is still empty to them');
select pg_temp.check((select count(*) from public.purchase_prices) = 0, 'and so are agreed purchase prices');
-- The owner does get them.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
-- Earlier tests received stock with a unit cost, so more than one product has a cost
-- by now; what matters is that the owner gets them and the cashier gets none.
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.catalogue(:'BRANCH_A')) x where x ? 'cost') >= 1,
  'the owner sees cost on the products that have one');
select pg_temp.check(
  (select (x->>'cost')::numeric from jsonb_array_elements(public.catalogue(:'BRANCH_A')) x
   where x->>'code' = 'VEN-AUD-35') = 250,
  'and it is the real figure');
select pg_temp.check(
  (select (x->>'margin_pct')::numeric from jsonb_array_elements(public.catalogue(:'BRANCH_A')) x
   where x->>'code' = 'VEN-AUD-35') = 100,
  'and its margin: 500 sold, 250 cost, 100%');

-- ---- Services have no stock to run out of ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000ac","qty":3}]', 'cash', 0, null, null, 1500);
  if (r->>'total')::numeric <> 1500 then raise exception 'SERVICE NOT BILLED: %', r->>'total'; end if;
  raise notice 'ok: a service bills three times over with no stock at all';
end $$;
select pg_temp.check(
  (select count(*) from public.stock_movements sm join public.products p on p.id = sm.product_id
   where p.code = 'SVC-OS') = 0,
  'and it moves no stock, because there is none to move');

-- ---- Gifts: buy one HDMI cable, get a Type-C adapter free ----
do $$
declare r jsonb; gift jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a2","qty":2}]', 'cash', 0, null, null, 1000);
  select e into gift from jsonb_array_elements(r->'items') e where (e->>'is_gift')::boolean;
  if gift is null then raise exception 'NO GIFT LINE: %', r->'items'; end if;
  if (gift->>'qty')::integer <> 2 then raise exception 'WRONG GIFT QTY: %', gift; end if;
  if (gift->>'line_total')::numeric <> 0 then raise exception 'GIFT WAS CHARGED FOR: %', gift; end if;
  -- 2 cables at 450 and nothing for the adapters.
  if (r->>'total')::numeric <> 900 then raise exception 'GIFT CHANGED THE TOTAL: %', r->>'total'; end if;
  raise notice 'ok: two cables bring two free adapters, at zero, and the total is still 900';
end $$;
-- The gift still left the shelf, so it still left stock: 7 adapters minus 2.
select pg_temp.check(
  (select qty from public.branch_stock where product_id = :'ADAPTER' and location_id = :'LOC_A') = 5,
  'the free adapters came out of stock, because they physically left');

-- ---- Owner-only catalogue and price writes ----
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (public.upsert_product(null, '{"name":"Test cable","code":"TST-1","price":100}')->>'code') = 'TST-1',
  'the owner can add a product');
select pg_temp.check(
  (select count(*) from public.product_prices pp join public.products p on p.id = pp.product_id
   where p.code = 'TST-1') >= 1,
  'and it gets a price on the default list, so it is sellable at once');
select pg_temp.check(
  (select count(*) from public.branch_stock bs join public.products p on p.id = bs.product_id
   where p.code = 'TST-1') >= 2,
  'and a zero-stock row at every branch');
select pg_temp.expect_error($q$select public.upsert_product(null, '{"code":"X"}')$q$, 'PRODUCT_NAME_REQUIRED');
select pg_temp.expect_error($q$select public.upsert_product(null, '{"name":"X"}')$q$, 'PRODUCT_CODE_REQUIRED');

-- A serial item with stock cannot quietly become a non-serial one.
select pg_temp.expect_error($q$update public.products set is_serial = false where code = 'SAM-980-500'$q$, 'SERIAL_CHANGE_HAS_STOCK');

-- Price bands are checked when set, not only when used.
select pg_temp.expect_error(format($q$select public.set_prices('%s', '%s', 500, null, 600, 400)$q$, :'MOUSE', :LIST_RETAIL), 'BAD_PRICE_BAND');
select pg_temp.check(
  (public.set_prices(:'MOUSE', :'LIST_DEALER', 410, null, 390)->>'price')::numeric = 410,
  'the owner can set a dealer price and its floor');

-- Bulk price change, with a dry run first so the screen can show old → new.
do $$
declare r jsonb;
begin
  r := public.bulk_update_prices(array['00000000-0000-4000-8000-0000000000a4']::uuid[],
        (select id from public.price_lists where shop_id = '00000000-0000-4000-8000-000000000001' and is_default),
        'percent', 10, null, true);
  if not (r->>'dry_run')::boolean then raise exception 'DRY RUN NOT FLAGGED'; end if;
  if (r->'changes'->0->>'from')::numeric <> 450 then raise exception 'WRONG OLD PRICE: %', r; end if;
  if (r->'changes'->0->>'to')::numeric <> 495 then raise exception 'WRONG NEW PRICE: %', r; end if;
  raise notice 'ok: a dry run shows 450 becoming 495 and changes nothing';
end $$;
select pg_temp.check((public.resolve_price(:'MOUSE', :'BRANCH_A')->>'price')::numeric = 450, 'and the price really is unchanged after a dry run');
select public.bulk_update_prices(array[:'MOUSE']::uuid[], :LIST_RETAIL, 'percent', 10, null, false);
select pg_temp.check((public.resolve_price(:'MOUSE', :'BRANCH_A')->>'price')::numeric = 495, 'then the real run applies it');
select pg_temp.expect_error(format($q$select public.bulk_update_prices(array['%s']::uuid[], '%s', 'sideways', 10)$q$, :'MOUSE', :LIST_RETAIL), 'BAD_PRICE_MODE');
select pg_temp.expect_error(format($q$select public.bulk_update_prices(array[]::uuid[], '%s', 'set', 10)$q$, :LIST_RETAIL), 'NO_PRODUCTS_PICKED');

-- Price history is in the audit log, which is how an owner sees who changed what.
-- One direct set_prices and one through the bulk change: both logged, and the bulk
-- dry run logged nothing because it wrote nothing.
select pg_temp.check((select count(*) from public.audit_log where action = 'price_set') >= 2, 'every price change is logged, including the ones made in bulk');
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'price_set'
     and (details->'to'->>'price')::numeric = 495) = 1,
  'and the log carries the old and new price');

-- Merging categories, for fixing the BMS typos ("Convarter" into "Converters").
select pg_temp.check(
  (public.merge_categories(
    (select id from public.categories where name = 'Printing'),
    (select id from public.categories where name = 'Accessories'))->>'products_moved')::integer = 1,
  'merging a category moves its products');
select pg_temp.check((select count(*) from public.categories where name = 'Printing') = 0, 'and the old category is gone');
select pg_temp.check((select count(*) from public.audit_log where action = 'categories_merged') = 1, 'and the merge is logged');
select pg_temp.expect_error($q$select public.merge_categories(
  (select id from public.categories where name = 'Accessories'),
  (select id from public.categories where name = 'Accessories'))$q$, 'SAME_CATEGORY');

-- Price lists: owner only, and a shop always keeps a default.
select pg_temp.check((public.save_price_list(null, 'Corporate')->>'name') = 'Corporate', 'the owner can add a price list');
select pg_temp.expect_error($q$select public.save_price_list(
  (select id from public.price_lists where is_default and shop_id = '00000000-0000-4000-8000-000000000001'),
  null, false)$q$, 'LAST_PRICE_LIST');
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select pg_temp.expect_error($q$select public.save_price_list(null, 'Sneaky')$q$, 'NOT_OWNER');
-- A manager CAN set prices: that is their job.
select pg_temp.check(
  (public.set_prices('00000000-0000-4000-8000-0000000000a6', :LIST_RETAIL, 1250)->>'price')::numeric = 1250,
  'a manager can set a price');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error(format($q$select public.set_prices('%s', '%s', 1)$q$, :'MOUSE', :LIST_RETAIL), 'NOT_ALLOWED');
select pg_temp.expect_error($q$select public.upsert_product(null, '{"name":"Nope","code":"NOPE"}')$q$, 'NOT_ALLOWED');
select pg_temp.expect_error($q$select public.merge_categories(
  (select id from public.categories where name = 'Laptops'),
  (select id from public.categories where name = 'Accessories'))$q$, 'NOT_ALLOWED');

-- Attributes: Group and Brand on by default, the rest there to be switched on.
select pg_temp.check((select count(*) from public.attribute_types where shop_id = :'SHOP' and enabled) = 2, 'Group and Brand are on by default');
select pg_temp.check((select count(*) from public.attribute_types where shop_id = :'SHOP') = 7, 'and five more are there to switch on');


-- ===========================================================================
-- 15. IMPORT FROM BMS (P4)
-- ===========================================================================
-- The done-when: a real export goes into a fresh shop, re-running it changes
-- nothing, and the counter finds products by their BMS codes.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

\set IMPORT_ROWS '[{"code":"BMS-NEW-1","name":"Imported cable","category":"Convarter","brand":"Vention","unit":"Pcs","price":320,"mrp":400,"warranty":12},{"code":"BMS-NEW-2","name":"Imported mouse","category":"Accesories","brand":"Logitach","unit":"Pcs","price":480,"warranty":12},{"code":"VEN-AUD-35","name":"Vention Audio 3.5mm to 2 Female 3.5mm","category":"Cables & adapters","price":520,"warranty":12}]'

-- First run: two new, one update of a product the shop already had.
do $$
declare r jsonb;
begin
  r := public.import_products('[{"code":"BMS-NEW-1","name":"Imported cable","category":"Convarter","brand":"Vention","unit":"Pcs","price":320,"mrp":400,"warranty":12},{"code":"BMS-NEW-2","name":"Imported mouse","category":"Accesories","brand":"Logitach","unit":"Pcs","price":480,"warranty":12},{"code":"VEN-AUD-35","name":"Vention Audio 3.5mm to 2 Female 3.5mm","category":"Cables & adapters","price":520,"warranty":12}]'::jsonb,
        false, 'bms-products.csv');
  if (r->>'added')::int <> 2 then raise exception 'WRONG ADDED COUNT: %', r; end if;
  if (r->>'updated')::int <> 1 then raise exception 'WRONG UPDATED COUNT: %', r; end if;
  raise notice 'ok: the import added 2 products and updated 1';
end $$;

-- Categories and units named in the file were created, so a shop does not have to
-- pre-build its own lists before it can move in.
select pg_temp.check((select count(*) from public.categories where shop_id = :'SHOP' and name = 'Convarter') = 1, 'a category named in the file is created');
select pg_temp.check((select count(*) from public.units where shop_id = :'SHOP' and name = 'Pcs') = 1, 'and so is a unit');

-- The counter can find an imported product by its BMS code, with its price.
select pg_temp.check(
  (select (x->>'price')::numeric from jsonb_array_elements(public.branch_products(:'BRANCH_A')) x
   where x->>'code' = 'BMS-NEW-1') = 320,
  'the counter finds the imported product by its BMS code, at its imported price');
select pg_temp.check(
  (select price from public.products where shop_id = :'SHOP' and code = 'VEN-AUD-35') = 520,
  'and the existing product took the new price');

-- ---- Re-running the same file changes nothing ----
do $$
declare before_count int; after_count int; r jsonb; before_price numeric; after_price numeric;
begin
  select count(*) into before_count from public.products where shop_id = '00000000-0000-4000-8000-000000000001';
  select price into before_price from public.products where code = 'BMS-NEW-1';

  r := public.import_products('[{"code":"BMS-NEW-1","name":"Imported cable","category":"Convarter","brand":"Vention","unit":"Pcs","price":320,"mrp":400,"warranty":12},{"code":"BMS-NEW-2","name":"Imported mouse","category":"Accesories","brand":"Logitach","unit":"Pcs","price":480,"warranty":12},{"code":"VEN-AUD-35","name":"Vention Audio 3.5mm to 2 Female 3.5mm","category":"Cables & adapters","price":520,"warranty":12}]'::jsonb,
        false, 'bms-products.csv');

  select count(*) into after_count from public.products where shop_id = '00000000-0000-4000-8000-000000000001';
  select price into after_price from public.products where code = 'BMS-NEW-1';

  if (r->>'added')::int <> 0 then raise exception 'RE-RUN ADDED SOMETHING: %', r; end if;
  if after_count <> before_count then raise exception 'RE-RUN CHANGED THE PRODUCT COUNT: % -> %', before_count, after_count; end if;
  if after_price <> before_price then raise exception 'RE-RUN CHANGED A PRICE'; end if;
  raise notice 'ok: re-running the same file adds nothing and changes nothing';
end $$;

-- An import never deletes: a partial export must not wipe the catalogue.
do $$
declare before_count int; after_count int;
begin
  select count(*) into before_count from public.products where shop_id = '00000000-0000-4000-8000-000000000001';
  perform public.import_products('[{"code":"BMS-NEW-1","name":"Imported cable","price":320}]'::jsonb, false, 'partial.csv');
  select count(*) into after_count from public.products where shop_id = '00000000-0000-4000-8000-000000000001';
  if after_count <> before_count then raise exception 'A PARTIAL IMPORT DELETED SOMETHING: % -> %', before_count, after_count; end if;
  raise notice 'ok: a one-row export leaves the rest of the catalogue alone';
end $$;

-- A dry run writes nothing but reports the same counts.
do $$
declare r jsonb; before_count int; after_count int;
begin
  select count(*) into before_count from public.products where shop_id = '00000000-0000-4000-8000-000000000001';
  r := public.import_products('[{"code":"DRY-1","name":"Never saved","price":100}]'::jsonb, true, 'dry.csv');
  select count(*) into after_count from public.products where shop_id = '00000000-0000-4000-8000-000000000001';
  if (r->>'added')::int <> 1 then raise exception 'DRY RUN DID NOT REPORT: %', r; end if;
  if after_count <> before_count then raise exception 'DRY RUN WROTE SOMETHING'; end if;
  raise notice 'ok: a dry run reports 1 add and writes nothing';
end $$;

-- Rows that cannot be imported are counted, not fatal: one bad line must not stop 600
-- good ones.
do $$
declare r jsonb;
begin
  r := public.import_products('[{"code":"","name":"No code"},{"code":"OK-1","name":"Fine","price":10},{"code":"NO-NAME","name":""}]'::jsonb, false, 'messy.csv');
  if (r->>'skipped')::int <> 2 then raise exception 'BAD ROWS NOT COUNTED: %', r; end if;
  if (r->>'added')::int <> 1 then raise exception 'GOOD ROW NOT IMPORTED: %', r; end if;
  raise notice 'ok: two unusable rows are skipped and the good one still goes in';
end $$;

-- One audit entry per run, with the counts in it.
select pg_temp.check((select count(*) from public.audit_log where action = 'import_run') = 4, 'one audit entry per real import run');
select pg_temp.check((select count(*) from public.audit_log where action = 'import_dry_run') = 1, 'and a dry run is logged as a dry run');
select pg_temp.check(
  (select (details->>'added')::int from public.audit_log
   where action = 'import_run' and details->>'file' = 'bms-products.csv' order by created_at limit 1) = 2,
  'and the entry carries the counts, not 600 separate lines');

-- ---- Opening stock ----
do $$
declare r jsonb;
begin
  r := public.import_opening_stock('00000000-0000-4000-8000-0000000000b1',
        '[{"code":"BMS-NEW-1","qty":25},{"code":"BMS-NEW-2","qty":0},{"code":"NOT-A-PRODUCT","qty":5}]'::jsonb,
        false, 'bms-stock.csv');
  if (r->>'set')::int <> 1 then raise exception 'WRONG SET COUNT: %', r; end if;
  if (r->>'missing')::int <> 1 then raise exception 'UNKNOWN CODE NOT FLAGGED: %', r; end if;
  raise notice 'ok: opening stock set for 1, and the unknown code counted as missing';
end $$;
select pg_temp.check(
  (select qty from public.branch_stock bs join public.products p on p.id = bs.product_id
   where p.code = 'BMS-NEW-1' and bs.branch_id = :'BRANCH_A') = 25,
  'the shelf figure is what the report said');
select pg_temp.check(
  (select count(*) from public.stock_movements sm join public.products p on p.id = sm.product_id
   where p.code = 'BMS-NEW-1' and sm.note = 'Opening stock from import') = 1,
  'and the history says where it came from');

-- Re-running the stock report SETS rather than adds, so the shelf does not double.
do $$
declare r jsonb; q int;
begin
  r := public.import_opening_stock('00000000-0000-4000-8000-0000000000b1',
        '[{"code":"BMS-NEW-1","qty":25}]'::jsonb, false, 'bms-stock.csv');
  select bs.qty into q from public.branch_stock bs join public.products p on p.id = bs.product_id
    where p.code = 'BMS-NEW-1' and bs.branch_id = '00000000-0000-4000-8000-0000000000b1';
  if q <> 25 then raise exception 'RE-IMPORTED STOCK DOUBLED: %', q; end if;
  if (r->>'unchanged')::int <> 1 then raise exception 'UNCHANGED NOT REPORTED: %', r; end if;
  raise notice 'ok: re-running the stock report leaves 25 on the shelf, not 50';
end $$;

-- Opening stock goes into the branch it was imported for, not into every branch.
select pg_temp.check(
  coalesce((select qty from public.branch_stock bs join public.products p on p.id = bs.product_id
            where p.code = 'BMS-NEW-1' and bs.branch_id = :'BRANCH_B'), 0) = 0,
  'and the other branch got none of it');

-- ---- Serials ----
do $$
declare r jsonb;
begin
  r := public.import_serials('00000000-0000-4000-8000-0000000000b1',
        '[{"code":"SAM-980-500","serial":"IMPORTED-001"},{"code":"SAM-980-500","serial":"S64DNX0T41907"},{"code":"NOPE","serial":"X"}]'::jsonb,
        false, 'bms-serials.csv');
  if (r->>'added')::int <> 1 then raise exception 'WRONG SERIAL ADD COUNT: %', r; end if;
  if (r->>'already_there')::int <> 1 then raise exception 'EXISTING SERIAL NOT RECOGNISED: %', r; end if;
  if (r->>'missing')::int <> 1 then raise exception 'UNKNOWN PRODUCT NOT COUNTED: %', r; end if;
  raise notice 'ok: 1 serial added, 1 already there, 1 for an unknown product';
end $$;

-- A serial that has been SOLD since the export must not come back as available.
select pg_temp.check(
  (select status from public.serials where serial = 'S64DNX0T41822') = 'sold',
  'a serial sold since the export is still sold');
do $$
declare r jsonb;
begin
  r := public.import_serials('00000000-0000-4000-8000-0000000000b1',
        '[{"code":"SAM-980-500","serial":"S64DNX0T41822"}]'::jsonb, false, 'bms-serials.csv');
  if (r->>'added')::int <> 0 then raise exception 'A SOLD SERIAL WAS RE-ADDED: %', r; end if;
  if (select status from public.serials where serial = 'S64DNX0T41822') <> 'sold' then
    raise exception 'RE-IMPORT RESURRECTED A SOLD SERIAL';
  end if;
  raise notice 'ok: re-importing a sold serial leaves it sold, not back on the shelf';
end $$;

-- ---- Customers and suppliers, with their dues as opening balances ----
do $$
declare r jsonb;
begin
  r := public.import_customers('[{"phone":"01555000001","name":"Imported Customer","due":12500},{"phone":"2026-01-01","name":"Cash Customer","due":0},{"phone":"01555000002","name":"No Due","due":0}]'::jsonb,
        false, 'bms-customers.csv');
  if (r->>'added')::int <> 2 then raise exception 'WRONG CUSTOMER ADD COUNT: %', r; end if;
  -- BMS gives every walk-in the same placeholder mobile; importing those would create a
  -- fictional customer per sale.
  if (r->>'skipped')::int <> 1 then raise exception 'PLACEHOLDER PHONE NOT SKIPPED: %', r; end if;
  if (r->>'opening_dues')::int <> 1 then raise exception 'DUE NOT RECORDED: %', r; end if;
  raise notice 'ok: 2 customers in, the fake mobile skipped, 1 opening due recorded';
end $$;
select pg_temp.check(
  (select amount from public.opening_balances ob join public.customers c on c.id = ob.customer_id
   where c.phone = '01555000001') = 12500,
  'the customer''s old due is kept as an opening balance, ready for the accounts');
select pg_temp.check(
  (select count(*) from public.opening_balances where party_kind = 'customer' and amount = 0) = 0,
  'and a customer who owes nothing gets no opening balance at all');

do $$
declare r jsonb;
begin
  r := public.import_suppliers('[{"name":"Smart Technologies BD","phone":"01811999001","due":45000},{"name":"","due":1}]'::jsonb,
        false, 'bms-suppliers.csv');
  if (r->>'added')::int <> 1 then raise exception 'WRONG SUPPLIER COUNT: %', r; end if;
  if (r->>'skipped')::int <> 1 then raise exception 'NAMELESS SUPPLIER NOT SKIPPED: %', r; end if;
  raise notice 'ok: a supplier and its 45,000 due came in; the nameless row was skipped';
end $$;
select pg_temp.check(
  (select amount from public.opening_balances ob join public.suppliers s on s.id = ob.supplier_id
   where s.name = 'Smart Technologies BD') = 45000,
  'what the shop owes a supplier is an opening balance too');

-- Re-importing the dues updates them rather than stacking a second one.
do $$
declare n int;
begin
  perform public.import_customers('[{"phone":"01555000001","name":"Imported Customer","due":9000}]'::jsonb, false, 'again.csv');
  select count(*) into n from public.opening_balances ob join public.customers c on c.id = ob.customer_id
    where c.phone = '01555000001';
  if n <> 1 then raise exception 'DUPLICATE OPENING BALANCE: %', n; end if;
  if (select amount from public.opening_balances ob join public.customers c on c.id = ob.customer_id
      where c.phone = '01555000001') <> 9000 then
    raise exception 'OPENING BALANCE NOT UPDATED';
  end if;
  raise notice 'ok: re-importing a due updates it instead of adding a second one';
end $$;

-- ---- Prices ----
do $$
declare r jsonb;
begin
  r := public.import_prices('00000000-0000-4000-8000-0000000000f2',
        '[{"code":"BMS-NEW-1","price":280,"min_price":260},{"code":"NOPE","price":10}]'::jsonb,
        false, 'bms-prices.csv');
  if (r->>'set')::int <> 1 then raise exception 'WRONG PRICE COUNT: %', r; end if;
  if (r->>'missing')::int <> 1 then raise exception 'UNKNOWN CODE NOT COUNTED: %', r; end if;
  raise notice 'ok: a dealer price imported for 1 product, 1 unknown code counted';
end $$;
select pg_temp.check(
  (public.resolve_price((select id from public.products where code = 'BMS-NEW-1'), :'BRANCH_A', '00000000-0000-4000-8000-0000000000f2')->>'price')::numeric = 280,
  'and the dealer list really has it');

-- ---- Column mappings are remembered per shop ----
select public.save_import_mapping('products', '{"code":"Product Code","name":"Model No/Caption"}');
select pg_temp.check(
  (select mapping->>'name' from public.import_mappings where shop_id = :'SHOP' and kind = 'products') = 'Model No/Caption',
  'the shop''s column mapping is remembered, so the next import is one click');

-- ---- Importing is owner/manager work; a cashier cannot ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error($q$select public.import_products('[{"code":"X","name":"X"}]'::jsonb)$q$, 'NOT_ALLOWED');
select pg_temp.expect_error($q$select public.import_customers('[{"phone":"01555000009"}]'::jsonb)$q$, 'NOT_ALLOWED');
select pg_temp.expect_error(format($q$select public.import_opening_stock('%s', '[{"code":"BMS-NEW-1","qty":1}]'::jsonb)$q$, :'BRANCH_A'), 'NOT_ALLOWED');
-- And a cashier cannot read what customers owe.
select pg_temp.check((select count(*) from public.opening_balances) = 0, 'a cashier cannot see what anyone owes');
select pg_temp.check((select count(*) from public.import_runs) = 0, 'nor the import history');


-- ===========================================================================
-- 16. STOCK IN AND CORRECTIONS (P5)
-- ===========================================================================
-- The done-when: receive 5 SSDs on credit by scanning serials, the supplier's due
-- goes up, sell one, return one to the supplier, and the history shows all of it.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

-- A name nothing else in this file uses, so the fixed id is definitely the one that
-- lands (the P4 import tests already created "Smart Technologies BD").
insert into public.suppliers (id, shop_id, name, phone) values
  ('00000000-0000-4000-8000-0000000000d1', :'SHOP', 'P5 Parts Supplier', '01811999011');
insert into public.suppliers (id, shop_id, name, is_cash_only) values
  ('00000000-0000-4000-8000-0000000000d2', :'SHOP', 'P5 One-off seller', true);

\set SUPPLIER '00000000-0000-4000-8000-0000000000d1'
\set CASH_SUPPLIER '00000000-0000-4000-8000-0000000000d2'
\set SSD '00000000-0000-4000-8000-0000000000a8'

-- What the SSD cost, and what is on the shelf, before any of this.
select pg_temp.check((select cost from public.product_costs where product_id = :'SSD') is null, 'the SSD has no cost recorded yet');

-- ---- Receive 5 SSDs on credit, scanning their serials ----
do $$
declare r jsonb;
begin
  r := public.receive_goods(
    '00000000-0000-4000-8000-0000000000b1',
    jsonb_build_array(jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-0000000000a8',
      'unit_cost', 6000,
      'serials', jsonb_build_array('NEWSSD-0001','NEWSSD-0002','NEWSSD-0003','NEWSSD-0004','NEWSSD-0005'))),
    '00000000-0000-4000-8000-0000000000d1', 'SI-9981', public.dhaka_today(), true);
  if (r->>'total')::numeric <> 30000 then raise exception 'WRONG GRN TOTAL: %', r->>'total'; end if;
  if (r->>'supplier_due')::numeric <> 30000 then raise exception 'SUPPLIER DUE DID NOT GO UP: %', r; end if;
  if (r->>'grn_no') not like 'GRN-MB-%' then raise exception 'WRONG GRN NUMBER: %', r->>'grn_no'; end if;
  raise notice 'ok: 5 SSDs received on credit, 30,000 owed to the supplier';
end $$;

select pg_temp.check((select count(*) from public.serials where serial like 'NEWSSD-%' and status = 'in_stock') = 5, 'the 5 scanned serials are in stock');
select pg_temp.check(
  (select qty from public.branch_stock where product_id = :'SSD' and location_id = :'LOC_A') = 7,
  'and the shelf went from 2 to 7');
select pg_temp.check(public.supplier_balance(:'SUPPLIER') = 30000, 'the supplier is owed 30,000');
select pg_temp.check((select count(*) from public.serials where serial = 'NEWSSD-0001' and grn_id is not null) = 1, 'each serial remembers which delivery it came in on');

-- ---- Weighted average cost ----
-- 2 on the shelf at no recorded cost, then 5 at 6,000, so the average is 6,000.
select pg_temp.check((select cost from public.product_costs where product_id = :'SSD') = 6000, 'the first receipt simply sets the cost');

-- Now 5 more at 6,400. 8 were on hand across the shop (2 at Branch A after the earlier
-- sale, 1 at Branch B, plus the 5 just received), so:
--   (8 x 6,000 + 5 x 6,400) / 13 = 6,153.85
do $$
declare r jsonb; c numeric;
begin
  r := public.receive_goods(
    '00000000-0000-4000-8000-0000000000b1',
    jsonb_build_array(jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-0000000000a8',
      'unit_cost', 6400,
      'serials', jsonb_build_array('NEWSSD-0006','NEWSSD-0007','NEWSSD-0008','NEWSSD-0009','NEWSSD-0010'))),
    '00000000-0000-4000-8000-0000000000d1', 'SI-9982', public.dhaka_today(), false);
  select cost into c from public.product_costs where product_id = '00000000-0000-4000-8000-0000000000a8';
  if c <> 6153.85 then raise exception 'WRONG AVERAGE COST: % (expected 6153.85)', c; end if;
  raise notice 'ok: 8 on hand at 6,000 plus 5 at 6,400 averages to 6,153.85';
end $$;

-- A cash purchase does not add to the due.
select pg_temp.check(public.supplier_balance(:'SUPPLIER') = 30000, 'a cash purchase did not add to what is owed');

-- Extra costs are spread BY VALUE, not evenly: a laptop carries more of the delivery
-- charge than an adapter.
do $$
declare r jsonb; laptop numeric; adapter numeric;
begin
  r := public.receive_goods(
    '00000000-0000-4000-8000-0000000000b1',
    jsonb_build_array(
      jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a3', 'qty', 10, 'unit_cost', 200),
      jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a6', 'qty', 2, 'unit_cost', 900)),
    '00000000-0000-4000-8000-0000000000d1', 'SI-9983', public.dhaka_today(), false,
    0, 380);  -- 380 of transport across 2,000 + 1,800
  -- The adapters are 2,000 of 3,800, so they take 200 of the 380: 2,200 / 10 = 220.
  select landed_cost into adapter from public.grn_items gi
    where gi.grn_id = (r->>'id')::uuid and gi.product_id = '00000000-0000-4000-8000-0000000000a3';
  -- The cooling pads are 1,800 of 3,800, so 180: 1,980 / 2 = 990.
  select landed_cost into laptop from public.grn_items gi
    where gi.grn_id = (r->>'id')::uuid and gi.product_id = '00000000-0000-4000-8000-0000000000a6';
  if adapter <> 220 then raise exception 'WRONG ADAPTER LANDED COST: %', adapter; end if;
  if laptop <> 990 then raise exception 'WRONG COOLING PAD LANDED COST: %', laptop; end if;
  raise notice 'ok: 380 of transport splits by value into 20 and 90 a unit, not evenly';
end $$;

-- ---- Receive now, price later ----
-- Earlier tests have moved the mouse stock around, so this checks the CHANGE rather
-- than an absolute figure.
do $$
declare r jsonb; before_qty int; after_qty int;
begin
  select qty into before_qty from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000a4'
      and location_id = '00000000-0000-4000-8000-0000000000e1';
  r := public.receive_goods(
    '00000000-0000-4000-8000-0000000000b1',
    jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a4', 'qty', 6)),
    '00000000-0000-4000-8000-0000000000d1', null, null, false);
  if not (r->>'cost_missing')::boolean then raise exception 'COST NOT FLAGGED AS MISSING: %', r; end if;
  select qty into after_qty from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000a4'
      and location_id = '00000000-0000-4000-8000-0000000000e1';
  if after_qty <> before_qty + 6 then
    raise exception 'GOODS NOT ON THE SHELF: % -> %', before_qty, after_qty;
  end if;
  raise notice 'ok: goods received with no invoice are flagged "cost missing" and still on the shelf';
end $$;

-- Filling the cost in later clears the flag and moves the average.
do $$
declare r jsonb; item uuid;
begin
  select gi.id into item from public.grn_items gi
    join public.grns g on g.id = gi.grn_id
    where g.cost_missing and gi.unit_cost is null limit 1;
  r := public.amend_grn_cost(item, 300);
  if (r->>'cost_missing')::boolean then raise exception 'FLAG NOT CLEARED: %', r; end if;
  if (r->>'to')::numeric <> 300 then raise exception 'COST NOT SET: %', r; end if;
  raise notice 'ok: filling the cost in later clears the flag and recalculates the average';
end $$;
select pg_temp.check((select count(*) from public.audit_log where action = 'grn_cost_amended') = 1, 'and the amendment is logged');
select pg_temp.expect_error($q$select public.amend_grn_cost(gen_random_uuid(), 100)$q$, 'GRN_LINE_NOT_FOUND');

-- ---- A duplicate or malformed serial is refused BEFORE anything is saved ----
select pg_temp.expect_error(format($q$select public.receive_goods('%s',
  jsonb_build_array(jsonb_build_object('product_id', '%s', 'unit_cost', 6000,
    'serials', jsonb_build_array('DUP-1','DUP-1'))))$q$, :'BRANCH_A', :'SSD'), 'DUPLICATE_SERIAL_IN_LINE');
select pg_temp.expect_error(format($q$select public.receive_goods('%s',
  jsonb_build_array(jsonb_build_object('product_id', '%s', 'unit_cost', 6000,
    'serials', jsonb_build_array('NEWSSD-0001'))))$q$, :'BRANCH_A', :'SSD'), 'SERIAL_ALREADY_KNOWN');

-- Digit check: a product can say how long its serials are.
select public.save_setting_row('units', null, '{"name":"check"}');
update public.products set serial_length = 13 where id = :'SSD';
select pg_temp.expect_error(format($q$select public.receive_goods('%s',
  jsonb_build_array(jsonb_build_object('product_id', '%s', 'unit_cost', 6000,
    'serials', jsonb_build_array('TOOSHORT'))))$q$, :'BRANCH_A', :'SSD'), 'SERIAL_WRONG_LENGTH');
update public.products set serial_length = null where id = :'SSD';

-- Credit needs a supplier, and a cash-only supplier cannot be given credit.
select pg_temp.expect_error(format($q$select public.receive_goods('%s',
  jsonb_build_array(jsonb_build_object('product_id', '%s', 'qty', 1, 'unit_cost', 1)),
  null, null, null, true)$q$, :'BRANCH_A', '00000000-0000-4000-8000-0000000000a4'), 'CREDIT_NEEDS_SUPPLIER');
select pg_temp.expect_error(format($q$select public.receive_goods('%s',
  jsonb_build_array(jsonb_build_object('product_id', '%s', 'qty', 1, 'unit_cost', 1)),
  '%s', null, null, true)$q$, :'BRANCH_A', '00000000-0000-4000-8000-0000000000a4', :'CASH_SUPPLIER'), 'CASH_SUPPLIER_NO_CREDIT');

-- A service has no stock, so it cannot be received.
select pg_temp.expect_error(format($q$select public.receive_goods('%s',
  jsonb_build_array(jsonb_build_object('product_id', '%s', 'qty', 1, 'unit_cost', 1)))$q$,
  :'BRANCH_A', :'SERVICE'), 'NOT_A_STOCK_ITEM');

-- ---- Paying the supplier from the receive screen ----
do $$
declare r jsonb;
begin
  r := public.receive_goods(
    '00000000-0000-4000-8000-0000000000b1',
    jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a2', 'qty', 10, 'unit_cost', 300)),
    '00000000-0000-4000-8000-0000000000d1', 'SI-9984', public.dhaka_today(), true,
    0, 0, 0, 0, null, null, null,
    2000, 'bkash', 'TRX99887');
  -- 30,000 already owed, plus 3,000 now, less the 2,000 just paid.
  if (r->>'supplier_due')::numeric <> 31000 then raise exception 'WRONG DUE AFTER PART PAYMENT: %', r; end if;
  raise notice 'ok: a part payment taken on the receive screen leaves 31,000 owed';
end $$;
select pg_temp.check((select count(*) from public.supplier_payments where reference = 'TRX99887') = 1, 'the payment is recorded against the delivery');

-- ---- Sell one of the SSDs ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
do $$
declare r jsonb; sid uuid;
begin
  select id into sid from public.serials where serial = 'NEWSSD-0001';
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1',
        jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a8',
                                             'serial_ids', jsonb_build_array(sid))),
        'cash', 0, null, null, 7000);
  if (r->'items'->0->>'serials') not like '%NEWSSD-0001%' then raise exception 'WRONG SERIAL SOLD: %', r->'items'; end if;
  raise notice 'ok: one of the received SSDs is sold, by its serial';
end $$;
select pg_temp.check((select status from public.serials where serial = 'NEWSSD-0001') = 'sold', 'that serial is now sold');

-- ---- Return one to the supplier ----
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
do $$
declare r jsonb; sid uuid; before numeric;
begin
  before := public.supplier_balance('00000000-0000-4000-8000-0000000000d1');
  select id into sid from public.serials where serial = 'NEWSSD-0002';
  r := public.return_to_supplier('00000000-0000-4000-8000-0000000000b1',
        jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a8',
                                             'serials', jsonb_build_array(sid))),
        '00000000-0000-4000-8000-0000000000d1', 'Dead on arrival');
  -- Returned at the average cost, which is what reduces the due.
  if (r->>'supplier_due')::numeric >= before then raise exception 'DUE DID NOT GO DOWN: % -> %', before, r->>'supplier_due'; end if;
  if (r->>'return_no') not like 'RET-MB-%' then raise exception 'WRONG RETURN NUMBER: %', r->>'return_no'; end if;
  raise notice 'ok: one SSD returned to the supplier, and the due went down';
end $$;
select pg_temp.check((select status from public.serials where serial = 'NEWSSD-0002') = 'returned', 'the returned serial is marked returned');
select pg_temp.check(
  (select qty from public.branch_stock where product_id = :'SSD' and location_id = :'LOC_A') = 10,
  'and it came off the shelf: 12 received less 1 sold less 1 returned');

-- A serial that was already sold cannot be returned to the supplier.
select pg_temp.expect_error(format($q$select public.return_to_supplier('%s',
  jsonb_build_array(jsonb_build_object('product_id', '%s',
    'serials', jsonb_build_array((select id from public.serials where serial = 'NEWSSD-0001')))),
  '%s')$q$, :'BRANCH_A', :'SSD', :'SUPPLIER'), 'SERIAL_NOT_AVAILABLE');

-- ---- The history shows all of it ----
do $$
declare h jsonb; reasons text;
begin
  h := public.stock_history('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a8', 50);
  select string_agg(distinct x->>'reason', ',') into reasons from jsonb_array_elements(h) x;
  if reasons not like '%purchase%' then raise exception 'NO PURCHASE IN HISTORY: %', reasons; end if;
  if reasons not like '%sale%' then raise exception 'NO SALE IN HISTORY: %', reasons; end if;
  if reasons not like '%return_to_supplier%' then raise exception 'NO RETURN IN HISTORY: %', reasons; end if;
  raise notice 'ok: the history shows the purchase, the sale and the return';
end $$;
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.stock_history(:'BRANCH_A', :'SSD', 50)) x
   where x->>'who' is not null) > 0,
  'and who did each of them');

-- ---- Stock corrections ----
do $$
declare r jsonb;
begin
  r := public.correct_stock('00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000a2', -2, 'damaged', 'Crushed in the box');
  if (r->>'to')::integer <> (r->>'from')::integer - 2 then raise exception 'WRONG CORRECTION: %', r; end if;
  raise notice 'ok: 2 damaged cables taken off the shelf, with a reason';
end $$;
select pg_temp.check(
  (select count(*) from public.stock_movements where reason_detail = 'damaged') = 1,
  'and the reason is on the movement, so damage can be told from theft');
select pg_temp.expect_error(format($q$select public.correct_stock('%s', '%s', -1, 'because')$q$, :'BRANCH_A', '00000000-0000-4000-8000-0000000000a2'), 'BAD_STOCK_REASON');
select pg_temp.expect_error(format($q$select public.correct_stock('%s', '%s', -1, 'other')$q$, :'BRANCH_A', '00000000-0000-4000-8000-0000000000a2'), 'REASON_NOTE_REQUIRED');
select pg_temp.expect_error(format($q$select public.correct_stock('%s', '%s', -99999, 'lost')$q$, :'BRANCH_A', '00000000-0000-4000-8000-0000000000a2'), 'WOULD_GO_NEGATIVE');
select pg_temp.expect_error(format($q$select public.correct_stock('%s', '%s', 0, 'lost')$q$, :'BRANCH_A', '00000000-0000-4000-8000-0000000000a2'), 'NOTHING_TO_CORRECT');

-- A serial item is corrected by naming its serials, not by typing a number.
select pg_temp.expect_error(format($q$select public.correct_stock('%s', '%s', -1, 'damaged')$q$, :'BRANCH_A', :'SSD'), 'SERIAL_COUNT_MISMATCH');
do $$
declare r jsonb; sid uuid;
begin
  select id into sid from public.serials where serial = 'NEWSSD-0003';
  r := public.correct_stock('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a8',
        -1, 'damaged', 'Bent connector', jsonb_build_array(sid));
  raise notice 'ok: a damaged SSD is written off by its serial';
end $$;
select pg_temp.check((select status from public.serials where serial = 'NEWSSD-0003') = 'rma', 'the written-off serial is out of stock');

-- ---- Stock count ----
do $$
declare r jsonb;
begin
  -- A dry run first, so the differences can be looked at before anything moves.
  -- The keyboard is counted at exactly what the system says, so it should come back as
  -- "already right" rather than as a correction.
  r := public.apply_stock_count('00000000-0000-4000-8000-0000000000b1',
        jsonb_build_array(
          jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a4', 'counted', 1),
          jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a5', 'counted',
            (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a5'
               and location_id = '00000000-0000-4000-8000-0000000000e1'))),
        null, 'Monthly count', null, true);
  if (r->>'corrected')::int <> 1 then raise exception 'WRONG DRY RUN COUNT: %', r; end if;
  if (r->>'already_right')::int <> 1 then raise exception 'MATCHING LINE NOT REPORTED: %', r; end if;
  raise notice 'ok: a count dry run finds one difference and one that already matches';
end $$;
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a4' and location_id = :'LOC_A') > 1,
  'and the dry run changed nothing');

do $$
declare r jsonb;
begin
  r := public.apply_stock_count('00000000-0000-4000-8000-0000000000b1',
        jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a4', 'counted', 1)),
        null, 'Monthly count', null, false);
  if (r->>'corrected')::int <> 1 then raise exception 'COUNT NOT APPLIED: %', r; end if;
  raise notice 'ok: applying the count fixes the shelf figure';
end $$;
select pg_temp.check(
  (select qty from public.branch_stock where product_id = '00000000-0000-4000-8000-0000000000a4' and location_id = :'LOC_A') = 1,
  'the shelf now says what was counted');
select pg_temp.check(
  (select count(*) from public.stock_movements where reason = 'count' and reason_detail = 'lost') = 1,
  'and the 2 that were missing are recorded as missing, not silently removed');

-- ---- Who may do any of this ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error(format($q$select public.receive_goods('%s', jsonb_build_array(jsonb_build_object('product_id','%s','qty',1,'unit_cost',1)))$q$, :'BRANCH_A', '00000000-0000-4000-8000-0000000000a4'), 'NOT_ALLOWED:receive_stock');
select pg_temp.expect_error(format($q$select public.correct_stock('%s', '%s', -1, 'damaged')$q$, :'BRANCH_A', '00000000-0000-4000-8000-0000000000a2'), 'NOT_ALLOWED:adjust_stock');
select pg_temp.expect_error(format($q$select public.return_to_supplier('%s', jsonb_build_array(jsonb_build_object('product_id','%s','qty',1)))$q$, :'BRANCH_A', '00000000-0000-4000-8000-0000000000a2'), 'NOT_ALLOWED:adjust_stock');
select pg_temp.expect_error(format($q$select public.stock_history('%s')$q$, :'BRANCH_A'), 'NOT_ALLOWED:view_reports');

-- And a cashier cannot read what the shop pays for anything.
select pg_temp.check((select count(*) from public.grns) = 0, 'a cashier sees no deliveries');
select pg_temp.check((select count(*) from public.grn_items) = 0, 'nor what anything cost');
select pg_temp.check((select count(*) from public.supplier_payments) = 0, 'nor what has been paid out');
select pg_temp.check((select count(*) from public.supplier_returns) = 0, 'nor what was sent back');

reset role;
\echo ALL DATABASE CHECKS PASSED
