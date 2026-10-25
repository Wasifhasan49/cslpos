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
-- `ok is not true` rather than `not ok`: a check whose expression came out NULL — an
-- empty subselect compared against a value, say — must FAIL. `not null` is null, so the
-- old form let those through silently, which is the worst kind of passing test.
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is null then raise exception 'CHECK WAS NULL (nothing to compare): %', what; end if;
  if not ok then raise exception 'CHECK FAILED: %', what; end if;
  raise notice 'ok: %', what;
end; $$;

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

-- A cashier cannot sell without an open drawer (P8), so the first thing Ovi does is the
-- first thing a real cashier does: open the till.
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 1000)$q$, :'BRANCH_A'), 'NO_OPEN_SHIFT');
select pg_temp.check(
  (public.open_shift(:'BRANCH_A', 2000)->>'opening_cash')::numeric = 2000,
  'the cashier opens the drawer with 2,000');

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
-- A drawer belongs to one branch, so working at a second branch means opening its till.
select pg_temp.expect_error(format($q$select public.complete_sale('%s', '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 550)$q$, :'BRANCH_B'), 'NO_OPEN_SHIFT');
select public.open_shift(:'BRANCH_B', 500);
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


-- ===========================================================================
-- 17. PURCHASE PAPERWORK AND SUPPLIER DUES (P6)
-- ===========================================================================
-- The done-when: a branch requests 10 keyboards, the owner approves, a PO goes to
-- the supplier, 6 arrive then 4 arrive, stock and the due update each time, and
-- paying half leaves the rest aged correctly.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

-- All of this is behind a feature switch; a small shop keeps receiving directly.
select pg_temp.expect_error(format($q$select public.save_requisition('%s', '[{"product_id":"%s","qty":10}]')$q$, :'BRANCH_A', :'KEYBOARD'), 'FEATURE_OFF:purchase_orders');
select public.set_feature('purchase_orders', true);

insert into public.suppliers (id, shop_id, name, phone) values
  ('00000000-0000-4000-8000-0000000000d3', :'SHOP', 'P6 Keyboard Wholesaler', '01811999021');
\set SUP6 '00000000-0000-4000-8000-0000000000d3'

-- ---- A branch asks for 10 keyboards ----
-- Asked for by the CASHIER, so the owner approving it is a real second pair of eyes.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
create table pg_temp.p6 (k text primary key, v uuid);
do $$
declare r jsonb;
begin
  r := public.save_requisition('00000000-0000-4000-8000-0000000000b1',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":10}]',
        public.dhaka_today() + 7, 'Running low on keyboards', null, true);
  if (r->>'status') <> 'submitted' then raise exception 'NOT SUBMITTED: %', r; end if;
  if (r->>'req_no') not like 'REQ-MB-%' then raise exception 'WRONG REQ NUMBER: %', r->>'req_no'; end if;
  insert into pg_temp.p6 values ('req', (r->>'id')::uuid);
  raise notice 'ok: the branch asked for 10 keyboards';
end $$;

-- You cannot approve your own request.
select pg_temp.expect_error($q$select public.decide_requisition((select v from pg_temp.p6 where k='req'), true)$q$, 'NOT_ALLOWED:approve');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (public.decide_requisition((select v from pg_temp.p6 where k='req'), true, 'Go ahead')->>'status') = 'approved',
  'the owner approves it');
select pg_temp.check((select count(*) from public.audit_log where action = 'requisition_approved') = 1, 'and the approval is logged');
-- Deciding twice is not a thing.
select pg_temp.expect_error($q$select public.decide_requisition((select v from pg_temp.p6 where k='req'), true)$q$, 'REQUISITION_NOT_SUBMITTED');

-- ---- A purchase order goes to the supplier ----
do $$
declare r jsonb;
begin
  r := public.save_purchase_order('00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000d3',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":10,"unit_price":600}]',
        30, 0, 0, 0, 'From the branch request',
        null, array[(select v from pg_temp.p6 where k='req')]);
  if (r->>'total')::numeric <> 6000 then raise exception 'WRONG PO TOTAL: %', r; end if;
  if (r->>'po_no') not like 'PO-MB-%' then raise exception 'WRONG PO NUMBER: %', r->>'po_no'; end if;
  insert into pg_temp.p6 values ('po', (r->>'id')::uuid);
  raise notice 'ok: a 6,000 purchase order raised from the request';
end $$;
select pg_temp.check(
  (select status from public.requisitions where id = (select v from pg_temp.p6 where k='req')) = 'ordered',
  'and the request is marked ordered, so the branch can see what happened to it');

-- Nothing can be received until it has actually been sent.
select pg_temp.expect_error($q$select public.receive_against_po((select v from pg_temp.p6 where k='po'),
  jsonb_build_array(jsonb_build_object('po_item_id',
    (select id from public.purchase_order_items where po_id = (select v from pg_temp.p6 where k='po')), 'qty', 1)))$q$,
  'PO_NOT_RECEIVABLE');
select pg_temp.check((public.set_po_status((select v from pg_temp.p6 where k='po'), 'send')->>'status') = 'sent', 'the order is sent to the supplier');

-- ---- 6 arrive ----
do $$
declare r jsonb; item uuid; before_stock int;
begin
  select id into item from public.purchase_order_items where po_id = (select v from pg_temp.p6 where k='po');
  select qty into before_stock from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000a5'
      and location_id = '00000000-0000-4000-8000-0000000000e1';
  r := public.receive_against_po((select v from pg_temp.p6 where k='po'),
        jsonb_build_array(jsonb_build_object('po_item_id', item, 'qty', 6)),
        'WS-5501', public.dhaka_today(), true);
  if (r->>'po_status') <> 'partly_received' then raise exception 'NOT PARTLY RECEIVED: %', r->>'po_status'; end if;
  if (r->>'total')::numeric <> 3600 then raise exception 'WRONG DELIVERY TOTAL: %', r->>'total'; end if;
  if (r->>'supplier_due')::numeric <> 3600 then raise exception 'DUE DID NOT GO UP: %', r; end if;
  if (select qty from public.branch_stock
      where product_id = '00000000-0000-4000-8000-0000000000a5'
        and location_id = '00000000-0000-4000-8000-0000000000e1') <> before_stock + 6 then
    raise exception 'STOCK DID NOT GO UP BY 6';
  end if;
  raise notice 'ok: 6 of the 10 arrived — stock and the due both moved';
end $$;
select pg_temp.check(
  (select qty - received_qty from public.purchase_order_items
   where po_id = (select v from pg_temp.p6 where k='po')) = 4,
  'and the order says 4 are still pending');

-- More than was ordered is a conversation with the supplier, not a quiet accept.
select pg_temp.expect_error($q$select public.receive_against_po((select v from pg_temp.p6 where k='po'),
  jsonb_build_array(jsonb_build_object('po_item_id',
    (select id from public.purchase_order_items where po_id = (select v from pg_temp.p6 where k='po')), 'qty', 99)))$q$,
  'MORE_THAN_ORDERED');

-- Once something has arrived, cancelling would hide a real delivery.
select pg_temp.expect_error($q$select public.set_po_status((select v from pg_temp.p6 where k='po'), 'cancel', 'changed my mind')$q$, 'PO_PARTLY_RECEIVED');

-- ---- The other 4 arrive ----
do $$
declare r jsonb; item uuid;
begin
  select id into item from public.purchase_order_items where po_id = (select v from pg_temp.p6 where k='po');
  r := public.receive_against_po((select v from pg_temp.p6 where k='po'),
        jsonb_build_array(jsonb_build_object('po_item_id', item, 'qty', 4)),
        'WS-5502', public.dhaka_today(), true);
  if (r->>'po_status') <> 'received' then raise exception 'ORDER NOT CLOSED OFF: %', r->>'po_status'; end if;
  if (r->>'supplier_due')::numeric <> 6000 then raise exception 'WRONG DUE AFTER SECOND DELIVERY: %', r; end if;
  raise notice 'ok: the last 4 arrived, the order is complete, 6,000 owed';
end $$;
-- And nothing more can come against it.
select pg_temp.expect_error($q$select public.receive_against_po((select v from pg_temp.p6 where k='po'),
  jsonb_build_array(jsonb_build_object('po_item_id',
    (select id from public.purchase_order_items where po_id = (select v from pg_temp.p6 where k='po')), 'qty', 1)))$q$,
  'PO_NOT_RECEIVABLE');

-- The agreed price is the point of an order, so paying something else is logged.
do $$
declare r jsonb; po2 uuid; item uuid;
begin
  r := public.save_purchase_order('00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000d3',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":2,"unit_price":600}]', 30);
  po2 := (r->>'id')::uuid;
  perform public.set_po_status(po2, 'send');
  select id into item from public.purchase_order_items where po_id = po2;
  -- The invoice came in at 650, not the agreed 600.
  r := public.receive_against_po(po2, jsonb_build_array(
        jsonb_build_object('po_item_id', item, 'qty', 2, 'unit_cost', 650)), 'WS-5503');
  raise notice 'ok: an invoice above the agreed price goes through for a manager';
end $$;
select pg_temp.check(
  (select (details->>'agreed')::numeric from public.audit_log
   where action = 'po_price_overridden' limit 1) = 600,
  'and the override is logged with the agreed price and the invoiced one');

-- ---- Orders over the shop's limit wait for the owner ----
-- Set through the saver, because shops has no direct UPDATE policy — which is also
-- what stops a manager raising their own approval limit.
select public.save_shop_details('{"po_approval_limit": 5000}');
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
do $$
declare r jsonb;
begin
  r := public.save_purchase_order('00000000-0000-4000-8000-0000000000b2',
        '00000000-0000-4000-8000-0000000000d3',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":20,"unit_price":600}]', 30);
  if (r->>'status') <> 'awaiting_approval' then raise exception 'BIG ORDER NOT HELD: %', r; end if;
  if not (r->>'needs_approval')::boolean then raise exception 'APPROVAL NOT FLAGGED: %', r; end if;
  insert into pg_temp.p6 values ('bigpo', (r->>'id')::uuid);
  raise notice 'ok: a 12,000 order from a manager waits for the owner';
end $$;
-- A manager cannot approve their own big order, and cannot send it either.
select pg_temp.expect_error($q$select public.set_po_status((select v from pg_temp.p6 where k='bigpo'), 'approve')$q$, 'NOT_OWNER');
select pg_temp.expect_error($q$select public.set_po_status((select v from pg_temp.p6 where k='bigpo'), 'send')$q$, 'PO_NOT_DRAFT');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check((public.set_po_status((select v from pg_temp.p6 where k='bigpo'), 'approve')->>'status') = 'sent', 'the owner approves it and it goes out');
select pg_temp.check((select count(*) from public.audit_log where action = 'po_approve') = 1, 'and the approval is logged');

-- A small order from the same manager does not wait.
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
do $$
declare r jsonb;
begin
  r := public.save_purchase_order('00000000-0000-4000-8000-0000000000b2',
        '00000000-0000-4000-8000-0000000000d3',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1,"unit_price":600}]', 30);
  if (r->>'status') <> 'draft' then raise exception 'SMALL ORDER HELD UP: %', r; end if;
  insert into pg_temp.p6 values ('smallpo', (r->>'id')::uuid);
  raise notice 'ok: a 600 order from the same manager goes straight to draft';
end $$;

-- Cancelling needs a reason, and is logged.
select pg_temp.expect_error($q$select public.set_po_status((select v from pg_temp.p6 where k='smallpo'), 'cancel')$q$, 'CANCEL_REASON_REQUIRED');
select pg_temp.check(
  (public.set_po_status((select v from pg_temp.p6 where k='smallpo'), 'cancel', 'Found them cheaper elsewhere')->>'status') = 'cancelled',
  'a cancel with a reason works');
select pg_temp.check(
  (select details->>'reason' from public.audit_log where action = 'po_cancel' limit 1) = 'Found them cheaper elsewhere',
  'and the reason is on the record');
select pg_temp.expect_error($q$select public.set_po_status((select v from pg_temp.p6 where k='smallpo'), 'cancel', 'again')$q$, 'PO_ALREADY_FINISHED');
select pg_temp.expect_error($q$select public.set_po_status((select v from pg_temp.p6 where k='bigpo'), 'juggle')$q$, 'BAD_PO_ACTION');

-- ---- Pay half, and see the rest aged ----
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(public.supplier_balance(:'SUP6') = 7300, 'the wholesaler is owed 7,300 (6,000 + 1,300)');
do $$
declare r jsonb;
begin
  r := public.pay_supplier('00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000d3', 3650, 'bank', 'CHQ-7781');
  if (r->>'balance')::numeric <> 3650 then raise exception 'WRONG BALANCE AFTER HALF PAYMENT: %', r; end if;
  -- Everything was bought today, so what is left sits in the newest bucket.
  if (r->'aging'->>'days_0_30')::numeric <> 3650 then raise exception 'WRONG AGING: %', r->'aging'; end if;
  if (r->'aging'->>'days_60_plus')::numeric <> 0 then raise exception 'SOMETHING AGED WRONGLY: %', r->'aging'; end if;
  raise notice 'ok: paying half leaves 3,650, all of it under 30 days old';
end $$;
select pg_temp.expect_error(format($q$select public.pay_supplier('%s', '%s', 0, 'cash')$q$, :'BRANCH_A', :'SUP6'), 'BAD_PAYMENT_AMOUNT');
select pg_temp.expect_error(format($q$select public.pay_supplier('%s', '%s', 100, 'cash', null, null, gen_random_uuid())$q$, :'BRANCH_A', :'SUP6'), 'ACCOUNT_NOT_FOUND');

-- Older debt ages into the right bucket, and payments are applied oldest first.
-- A shop that typed its catalogue in by hand still has to record what it already owed,
-- and `opening_balances` has no write policy, so it can only come through the function.
select pg_temp.check(
  (public.set_opening_balance('supplier', :'SUP6', 2000, public.dhaka_today() - 90, 'Old debt')
   ->>'amount')::numeric = 2000,
  'an owner can record what the shop already owed a supplier');
select pg_temp.check(
  (public.set_opening_balance('supplier', :'SUP6', 2000, public.dhaka_today() - 90, 'Old debt')
   ->>'amount')::numeric = 2000
  and (select count(*) from public.opening_balances where supplier_id = :'SUP6') = 1,
  'and recording it again changes the figure instead of adding a second one');
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'opening_balance_set') >= 1,
  'and the opening balance is logged');
select pg_temp.expect_error(
  format($q$select public.set_opening_balance('supplier', '%s', 100, public.dhaka_today() + 5)$q$, :'SUP6'),
  'OPENING_DATE_IN_FUTURE');
select pg_temp.expect_error(
  format($q$select public.set_opening_balance('supplier', '%s', 100)$q$, gen_random_uuid()),
  'SUPPLIER_NOT_FOUND');
do $$
declare a jsonb;
begin
  a := public.supplier_aging('00000000-0000-4000-8000-0000000000d3');
  -- 2,000 from 90 days ago, 7,300 from today, 3,650 paid. Oldest first, so the whole
  -- 2,000 is cleared and 1,650 comes off today's.
  if (a->>'days_60_plus')::numeric <> 0 then raise exception 'OLD DEBT NOT CLEARED FIRST: %', a; end if;
  if (a->>'days_0_30')::numeric <> 5650 then raise exception 'WRONG RECENT BUCKET: %', a; end if;
  raise notice 'ok: the payment cleared the 90-day debt first, leaving 5,650 recent';
end $$;

-- The ledger shows everything that moved the balance.
do $$
declare l jsonb; kinds text;
begin
  l := public.supplier_ledger('00000000-0000-4000-8000-0000000000d3');
  select string_agg(distinct x->>'kind', ',') into kinds from jsonb_array_elements(l) x;
  if kinds not like '%purchase%' then raise exception 'NO PURCHASES IN LEDGER: %', kinds; end if;
  if kinds not like '%payment%' then raise exception 'NO PAYMENTS IN LEDGER: %', kinds; end if;
  if kinds not like '%opening%' then raise exception 'NO OPENING BALANCE IN LEDGER: %', kinds; end if;
  raise notice 'ok: the ledger shows the opening balance, the purchases and the payment';
end $$;

-- ---- Reorder suggestions ----
do $$
declare r jsonb;
begin
  r := public.reorder_suggestions('00000000-0000-4000-8000-0000000000b1', 30);
  if jsonb_typeof(r) <> 'array' then raise exception 'NO SUGGESTIONS: %', r; end if;
  raise notice 'ok: reorder suggestions came back as a list';
end $$;
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.reorder_suggestions(:'BRANCH_A', 30)) x
   where (x->>'stock')::int > (x->>'reorder_level')::int) = 0,
  'and only things at or below their re-order level are on it');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.reorder_suggestions(:'BRANCH_A', 30)) x
   where (x->>'suggest_qty')::int < 1) = 0,
  'and every suggestion is for at least one');

-- ---- Who may do what ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error(format($q$select public.save_purchase_order('%s', '%s', '[{"product_id":"%s","qty":1,"unit_price":1}]')$q$, :'BRANCH_A', :'SUP6', :'KEYBOARD'), 'NOT_ALLOWED');
select pg_temp.expect_error(format($q$select public.pay_supplier('%s', '%s', 100, 'cash')$q$, :'BRANCH_A', :'SUP6'), 'NOT_ALLOWED');
select pg_temp.expect_error(format($q$select public.supplier_ledger('%s')$q$, :'SUP6'), 'NOT_ALLOWED');
select pg_temp.expect_error(format($q$select public.reorder_suggestions('%s')$q$, :'BRANCH_A'), 'NOT_ALLOWED');
select pg_temp.expect_error(format($q$select public.set_opening_balance('supplier', '%s', 100)$q$, :'SUP6'), 'NOT_OWNER');
-- A cashier sees requests (they may have made one) but not what anything costs.
select pg_temp.check((select count(*) from public.requisitions) >= 1, 'a cashier can see the requests at their branch');
select pg_temp.check((select count(*) from public.purchase_orders) = 0, 'but not the orders, because those carry prices');
select pg_temp.check((select count(*) from public.purchase_order_items) = 0, 'nor the agreed prices on them');

-- ===========================================================================
-- 18. BRANCH TRANSFERS (P7)
-- ===========================================================================
-- The done-when: Branch A sends 2 laptops by serial, they show as in transit,
-- Branch B receives one and marks one damaged, and stock and serial locations
-- are right everywhere.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
\set LAPTOP '00000000-0000-4000-8000-0000000000aa'

-- Off until the shop turns it on, like everything advanced.
select pg_temp.expect_error(format($q$select public.send_transfer('%s', '%s', '[{"product_id":"%s","qty":1}]')$q$, :'BRANCH_A', :'BRANCH_B', :'KEYBOARD'), 'FEATURE_OFF:transfers');
select public.set_feature('transfers', true);

create table pg_temp.p7 (k text primary key, v uuid);

-- ---- Routes: nothing set means anywhere, one route means only that route ----
select pg_temp.check(public.can_transfer(:'BRANCH_A', :'BRANCH_B'),
  'with no routes set, any branch can send to any other');
select pg_temp.check(public.can_transfer(:'BRANCH_A', :'BRANCH_A') = false,
  'but never to itself');
select pg_temp.check(
  (public.save_transfer_route(:'BRANCH_B', :'BRANCH_A', true)->>'allowed')::boolean,
  'the owner opens Branch B → Branch A');
select pg_temp.check(public.can_transfer(:'BRANCH_A', :'BRANCH_B') = false,
  'and now the other direction is closed, because the list has become the rule');
select pg_temp.expect_error(format($q$select public.send_transfer('%s', '%s', '[{"product_id":"%s","qty":1}]')$q$, :'BRANCH_A', :'BRANCH_B', :'KEYBOARD'), 'TRANSFER_NOT_ALLOWED');
-- Open the way we actually want to send, and check the route is logged.
select public.save_transfer_route(:'BRANCH_A', :'BRANCH_B', true);
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'transfer_route_opened') = 2,
  'and both routes are logged');
select pg_temp.expect_error(format($q$select public.save_transfer_route('%s', '%s', true)$q$, :'BRANCH_A', :'BRANCH_A'), 'SAME_BRANCH');

-- ---- Branch A sends 2 laptops, by serial ----
-- Note what is on the shelf first, so the test reads as a change rather than a figure.
do $$
declare s1 uuid; s2 uuid; before_a integer; r jsonb;
begin
  select coalesce(sum(qty), 0) into before_a from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000aa'
      and location_id = '00000000-0000-4000-8000-0000000000e1';
  insert into pg_temp.p7 values ('before_a', null);
  -- Stash the figure in a table of its own, since pg_temp.p7 holds uuids.
  create table pg_temp.p7n (k text primary key, v integer);
  insert into pg_temp.p7n values ('before_a', before_a);

  select id into s1 from public.serials
    where product_id = '00000000-0000-4000-8000-0000000000aa' and status = 'in_stock'
      and location_id = '00000000-0000-4000-8000-0000000000e1' order by serial limit 1;
  select id into s2 from public.serials
    where product_id = '00000000-0000-4000-8000-0000000000aa' and status = 'in_stock'
      and location_id = '00000000-0000-4000-8000-0000000000e1' and id <> s1 order by serial limit 1;
  if s1 is null or s2 is null then raise exception 'NOT ENOUGH LAPTOPS TO SEND'; end if;
  insert into pg_temp.p7 values ('s1', s1), ('s2', s2);

  r := public.send_transfer('00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000b2',
        jsonb_build_array(jsonb_build_object(
          'product_id', '00000000-0000-4000-8000-0000000000aa',
          'serials', jsonb_build_array(s1, s2))),
        'Branch B is short of laptops');
  if (r->>'status') <> 'in_transit' then raise exception 'NOT IN TRANSIT: %', r; end if;
  if (r->>'transfer_no') not like 'TRA-MB-%' then raise exception 'WRONG NUMBER: %', r->>'transfer_no'; end if;
  insert into pg_temp.p7 values ('tr', (r->>'id')::uuid);
  raise notice 'ok: Branch A put 2 laptops on the road as %', r->>'transfer_no';
end $$;

-- A serial item must be sent by serial; "two of them" is not receivable honestly.
select pg_temp.expect_error(format($q$select public.send_transfer('%s', '%s', '[{"product_id":"%s","qty":2}]')$q$, :'BRANCH_A', :'BRANCH_B', :'LAPTOP'), 'SERIAL_REQUIRED');
select pg_temp.expect_error(format($q$select public.send_transfer('%s', '%s', '[]')$q$, :'BRANCH_A', :'BRANCH_B'), 'NOTHING_TO_SEND');
select pg_temp.expect_error(format($q$select public.send_transfer('%s', '%s', '[{"product_id":"%s","qty":1}]')$q$, :'BRANCH_A', :'BRANCH_A', :'KEYBOARD'), 'SAME_BRANCH');
select pg_temp.expect_error(format($q$select public.send_transfer('%s', '%s', '[{"product_id":"%s","qty":99999}]')$q$, :'BRANCH_A', :'BRANCH_B', :'KEYBOARD'), 'OUT_OF_STOCK');

-- ---- While the van is on the road ----
select pg_temp.check(
  (select coalesce(sum(qty), 0) from public.branch_stock
   where product_id = :'LAPTOP' and location_id = :'LOC_A')
  = (select v - 2 from pg_temp.p7n where k = 'before_a'),
  'the two laptops are off Branch A''s shelf straight away');
select pg_temp.check(
  (select count(*) from public.serials where id in (select v from pg_temp.p7 where k in ('s1','s2'))
   and status = 'in_transit') = 2,
  'and both serials say they are on the road');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.branch_products(:'BRANCH_A')) x
   where x->>'id' = :'LAPTOP' and jsonb_array_length(x->'serials') >= 0) = 1
  and (select jsonb_array_length(x->'serials') from jsonb_array_elements(public.branch_products(:'BRANCH_A')) x
       where x->>'id' = :'LAPTOP')
      = (select count(*) from public.serials where product_id = :'LAPTOP' and status = 'in_stock'
         and location_id = :'LOC_A'),
  'and nobody at either end can pick them for a sale');
select pg_temp.check(
  (select coalesce(sum(qty), 0) from public.branch_stock
   where product_id = :'LAPTOP' and location_id = :'LOC_B') = 0,
  'they have not arrived yet, so Branch B has none');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.in_transit()) x
   where x->>'transfer_no' like 'TRA-MB-%') = 1,
  'the transfer shows on the in-transit list with how long it has been out');
select pg_temp.check(
  (select (x->>'days_out')::int from jsonb_array_elements(public.in_transit()) x limit 1) = 0,
  'and it went out today');

-- The sending branch cannot sign for its own delivery.
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error($q$select public.receive_transfer((select v from pg_temp.p7 where k='tr'), '[]')$q$, 'NOT_ALLOWED');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

-- ---- Branch B receives one and marks one damaged ----
do $$
declare item uuid; s1 uuid; s2 uuid; r jsonb;
begin
  select v into s1 from pg_temp.p7 where k = 's1';
  select v into s2 from pg_temp.p7 where k = 's2';
  select id into item from public.transfer_items
    where transfer_id = (select v from pg_temp.p7 where k = 'tr');

  r := public.receive_transfer((select v from pg_temp.p7 where k = 'tr'),
        jsonb_build_array(jsonb_build_object(
          'item_id', item,
          'serials_ok', jsonb_build_array(s1),
          'serials_damaged', jsonb_build_array(s2),
          'note', 'Second one had a cracked lid')),
        'Checked against the slip');
  if (r->>'status') <> 'received' then raise exception 'SHOULD BE RECEIVED IN FULL: %', r; end if;
  raise notice 'ok: Branch B took one sound laptop and one damaged one';
end $$;

select pg_temp.check(
  (select status from public.serials where id = (select v from pg_temp.p7 where k='s1')) = 'in_stock'
  and (select location_id from public.serials where id = (select v from pg_temp.p7 where k='s1')) = :'LOC_B',
  'the sound laptop is on Branch B''s shelf, with its serial moved there');
select pg_temp.check(
  (select status from public.serials where id = (select v from pg_temp.p7 where k='s2')) = 'rma',
  'and the damaged one is in RMA, not on sale');
select pg_temp.check(
  (select coalesce(sum(qty), 0) from public.branch_stock
   where product_id = :'LAPTOP' and location_id = :'LOC_B') = 1,
  'so Branch B has exactly one sellable laptop');
select pg_temp.check(
  (select jsonb_array_length(x->'serials') from jsonb_array_elements(public.branch_products(:'BRANCH_B')) x
   where x->>'id' = :'LAPTOP') = 1,
  'and the counter at Branch B offers that one serial');
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'transfer_received') = 1,
  'the receipt is logged');
select pg_temp.check(
  (select count(*) from public.stock_movements
   where reason = 'adjust_out' and reason_detail = 'damaged'
     and note like 'TRA-MB-%arrived damaged') = 1,
  'and the damage is recorded where it was found');
select pg_temp.check(
  (select count(*) from public.in_transit()) = 0
  or jsonb_array_length(public.in_transit()) = 0,
  'nothing is on the road any more');

-- ---- A shortage leaves the transfer disputed until a manager decides ----
do $$
declare r jsonb; item uuid;
begin
  r := public.send_transfer('00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000b2',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":4}]',
        'Keyboards');
  insert into pg_temp.p7 values ('tr2', (r->>'id')::uuid);

  select id into item from public.transfer_items where transfer_id = (r->>'id')::uuid;
  insert into pg_temp.p7 values ('tr2item', item);

  -- Only 3 of the 4 arrived.
  r := public.receive_transfer((select v from pg_temp.p7 where k='tr2'),
        jsonb_build_array(jsonb_build_object('item_id', item, 'ok_qty', 3)));
  if (r->>'status') <> 'disputed' then raise exception 'SHORTAGE NOT DISPUTED: %', r; end if;
  raise notice 'ok: one keyboard short, so the transfer is disputed';
end $$;
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'transfer_disputed') = 1,
  'and the dispute is logged, not quietly absorbed');
select pg_temp.check(
  (select (x->>'short')::int from jsonb_array_elements(
     (select details->'lines' from public.audit_log where action = 'transfer_disputed')) x) = 1,
  'with how many went missing');
-- The missing one belongs to nobody until it is settled.
select pg_temp.check(
  (select coalesce(sum(qty), 0) from public.branch_stock
   where product_id = :'KEYBOARD' and location_id = :'LOC_B') = 3,
  'Branch B only has the three that turned up');
select pg_temp.expect_error($q$select public.resolve_transfer((select v from pg_temp.p7 where k='tr2'), 'returned', '')$q$, 'RESOLUTION_NOTE_REQUIRED');
select pg_temp.expect_error($q$select public.resolve_transfer((select v from pg_temp.p7 where k='tr2'), 'eaten', 'by a dog')$q$, 'BAD_RESOLUTION');
select pg_temp.check(
  (public.resolve_transfer((select v from pg_temp.p7 where k='tr2'), 'written_off',
                           'Never found. Driver questioned.')->>'cost_of_shortage')::numeric >= 0,
  'a manager writes the missing keyboard off, at cost');
select pg_temp.check(
  (select count(*) from public.stock_movements
   where reason_detail = 'lost' and note like 'TRA-MB-%lost in transit') = 1,
  'and the loss is recorded against the branch it left');
select pg_temp.check(
  (select status from public.transfers where id = (select v from pg_temp.p7 where k='tr2')) = 'received',
  'the transfer is settled');
select pg_temp.expect_error($q$select public.resolve_transfer((select v from pg_temp.p7 where k='tr2'), 'returned', 'again')$q$, 'TRANSFER_NOT_DISPUTED');

-- ---- A transfer that never left can be called off ----
do $$
declare r jsonb; before_qty integer;
begin
  select coalesce(sum(qty), 0) into before_qty from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000a5'
      and location_id = '00000000-0000-4000-8000-0000000000e1';
  r := public.send_transfer('00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000b2',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":2}]');
  perform public.cancel_transfer((r->>'id')::uuid, 'Van broke down, goods never left');
  if (select coalesce(sum(qty), 0) from public.branch_stock
      where product_id = '00000000-0000-4000-8000-0000000000a5'
        and location_id = '00000000-0000-4000-8000-0000000000e1') <> before_qty then
    raise exception 'CANCELLING DID NOT PUT THE STOCK BACK';
  end if;
  raise notice 'ok: calling a transfer off puts every unit back on the sender''s shelf';
end $$;
select pg_temp.expect_error(format($q$select public.cancel_transfer((select id from public.transfers where status = 'cancelled' limit 1), 'again')$q$), 'TRANSFER_NOT_IN_TRANSIT');

-- ---- Moving between locations inside one branch ----
-- stock_locations has no insert policy, so it goes through the one saver.
create table pg_temp.p7loc (k text primary key, v uuid);
insert into pg_temp.p7loc
  select 'warehouse', (public.save_stock_location(:'BRANCH_A', 'Warehouse')->>'id')::uuid;
do $$
declare before_floor integer; wh uuid;
begin
  select v into wh from pg_temp.p7loc where k = 'warehouse';
  select coalesce(qty, 0) into before_floor from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000a5'
      and location_id = '00000000-0000-4000-8000-0000000000e1';
  perform public.move_within_branch('00000000-0000-4000-8000-0000000000b1',
    '00000000-0000-4000-8000-0000000000e1', wh,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":3}]');
  if (select qty from public.branch_stock
      where product_id = '00000000-0000-4000-8000-0000000000a5'
        and location_id = wh) <> 3 then
    raise exception 'STOCK DID NOT REACH THE WAREHOUSE';
  end if;
  if (select qty from public.branch_stock
      where product_id = '00000000-0000-4000-8000-0000000000a5'
        and location_id = '00000000-0000-4000-8000-0000000000e1') <> before_floor - 3 then
    raise exception 'STOCK DID NOT LEAVE THE SHOP FLOOR';
  end if;
  raise notice 'ok: 3 keyboards moved from the shop floor to the warehouse';
end $$;
-- The branch total is unchanged: the goods have not left the building.
select pg_temp.check(
  (select (x->>'stock')::int from jsonb_array_elements(public.branch_products(:'BRANCH_A')) x
   where x->>'id' = :'KEYBOARD')
  = (select sum(qty)::int from public.branch_stock
     where product_id = :'KEYBOARD' and branch_id = :'BRANCH_A'),
  'and the branch still has the same number in total');
select pg_temp.expect_error(format($q$select public.move_within_branch('%s', '%s', '%s', '[{"product_id":"%s","qty":1}]')$q$, :'BRANCH_A', :'LOC_A', :'LOC_A', :'KEYBOARD'), 'SAME_LOCATION');
select pg_temp.expect_error(format($q$select public.move_within_branch('%s', '%s', '%s', '[{"product_id":"%s","qty":1}]')$q$, :'BRANCH_A', :'LOC_A', :'LOC_B', :'KEYBOARD'), 'LOCATION_NOT_FOUND');

-- ---- One branch asks another ----
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
do $$
declare r jsonb;
begin
  -- Rafi works at Branch B, so he asks Branch A for stock FOR Branch B.
  r := public.save_transfer_request('00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000b2',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":5}]',
        'We are out of keyboards');
  if (r->>'req_no') not like 'TRQ-SB-%' then raise exception 'WRONG REQUEST NUMBER: %', r->>'req_no'; end if;
  insert into pg_temp.p7 values ('req', (r->>'id')::uuid);
  raise notice 'ok: Branch B asked Branch A for 5 keyboards as %', r->>'req_no';
end $$;
-- The branch that has to hand the goods over is the one that decides, and Rafi
-- cannot work at Branch A.
select pg_temp.expect_error($q$select public.decide_transfer_request((select v from pg_temp.p7 where k='req'), true)$q$, 'BRANCH_NOT_ALLOWED');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select pg_temp.check(
  (public.decide_transfer_request((select v from pg_temp.p7 where k='req'), true, 'Sending today')->>'status') = 'approved',
  'Branch A agrees to send them');
select pg_temp.expect_error($q$select public.decide_transfer_request((select v from pg_temp.p7 where k='req'), true)$q$, 'REQUEST_ALREADY_DECIDED');
do $$
declare r jsonb;
begin
  r := public.send_transfer('00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000b2',
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":5}]',
        null, null, null, (select v from pg_temp.p7 where k='req'));
  if (select status from public.transfer_requests where id = (select v from pg_temp.p7 where k='req')) <> 'sent' then
    raise exception 'REQUEST NOT MARKED SENT';
  end if;
  insert into pg_temp.p7 values ('tr3', (r->>'id')::uuid);
  raise notice 'ok: sending against the request closes the ask';
end $$;

-- ---- Who may do what ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error(format($q$select public.send_transfer('%s', '%s', '[{"product_id":"%s","qty":1}]')$q$, :'BRANCH_A', :'BRANCH_B', :'KEYBOARD'), 'NOT_ALLOWED:transfer_stock');
select pg_temp.expect_error(format($q$select public.move_within_branch('%s', '%s', '%s', '[{"product_id":"%s","qty":1}]')$q$, :'BRANCH_A', :'LOC_A', (select v from pg_temp.p7loc where k='warehouse'), :'KEYBOARD'), 'NOT_ALLOWED:transfer_stock');
select pg_temp.expect_error($q$select public.in_transit()$q$, 'NOT_ALLOWED:view_reports');
select pg_temp.expect_error(format($q$select public.save_transfer_route('%s', '%s', false)$q$, :'BRANCH_A', :'BRANCH_B'), 'NOT_OWNER');
-- A cashier at Branch A sees Branch A's transfers, and nothing from branches they
-- do not work at.
select pg_temp.check(
  (select count(*) from public.transfers
   where from_branch_id <> :'BRANCH_A' and to_branch_id <> :'BRANCH_A') = 0,
  'a cashier sees only the transfers their own branch sent or was sent');

-- ===========================================================================
-- 19. SHIFTS AND THE CASH CHECK (P8)
-- ===========================================================================
-- The done-when: open with 2,000, sell 1,000 cash, take 200 out for tea, close
-- with 2,700 counted, and the owner sees "short 100" for that branch.
--
-- A fresh branch is used so the arithmetic is exactly the figures above and does
-- not depend on everything the earlier sections sold.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
create table pg_temp.p8 (k text primary key, v uuid);
insert into pg_temp.p8
  select 'branch', (public.save_branch(null, 'Cash check branch', 'CC')->>'id')::uuid;
insert into pg_temp.p8
  select 'cashier', (select id from public.staff where name = 'Ovi');
-- Put some splitters on that branch's shelf: at 500 each, two of them is exactly the
-- 1,000 cash sale the done-when describes.
do $$
declare b uuid; loc uuid;
begin
  select v into b from pg_temp.p8 where k = 'branch';
  select public.default_location(b) into loc;
  insert into pg_temp.p8 values ('loc', loc);
  perform public.receive_goods(b,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":10,"unit_cost":300}]');
end $$;
select public.set_staff_branches(
  (select v from pg_temp.p8 where k = 'cashier'),
  array[:'BRANCH_A', :'BRANCH_B', (select v from pg_temp.p8 where k = 'branch')]::uuid[]);
-- The bulk-price section earlier put the splitter at 520. Put it back to 500 so the
-- drawer arithmetic below is the done-when's figures and not an accident of test order.
select public.set_prices('00000000-0000-4000-8000-0000000000a1',
  (select id from public.price_lists where shop_id = :'SHOP' and is_default), 500);

-- ---- The cashier opens the drawer with 2,000 ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.check(
  (public.current_shift((select v from pg_temp.p8 where k='branch'))->>'open')::boolean = false,
  'no drawer is open at the new branch yet');
select pg_temp.check(
  (public.current_shift((select v from pg_temp.p8 where k='branch'))->>'may_sell_without_shift')::boolean = false,
  'and a cashier may not sell without one');
do $$
declare r jsonb;
begin
  r := public.open_shift((select v from pg_temp.p8 where k='branch'), 2000);
  insert into pg_temp.p8 values ('shift', (r->>'shift_id')::uuid);
  raise notice 'ok: the drawer is open with 2,000';
end $$;
select pg_temp.expect_error($q$select public.open_shift((select v from pg_temp.p8 where k='branch'), 500)$q$, 'SHIFT_ALREADY_OPEN');
select pg_temp.expect_error($q$select public.open_shift((select v from pg_temp.p8 where k='branch'), -5)$q$, 'BAD_CASH_AMOUNT');
select pg_temp.check(
  (public.current_shift((select v from pg_temp.p8 where k='branch'))->>'opening_cash')::numeric = 2000,
  'and the till can see what it was opened with');

-- ---- Sell 1,000 in cash ----
-- 2 splitters at the price the owner set, 500 each. The customer hands over 1,000.
do $$
declare r jsonb; b uuid;
begin
  select v into b from pg_temp.p8 where k = 'branch';
  r := public.complete_sale(b,
        '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":2}]',
        'cash', 0, null, null, 1000);
  if (r->>'total')::numeric <> 1000 then raise exception 'WRONG TOTAL: %', r; end if;
  raise notice 'ok: sold 1,000 in cash on the open drawer';
end $$;
select pg_temp.check(
  (select shift_id from public.sales where id = (
     select id from public.sales where branch_id = (select v from pg_temp.p8 where k='branch')
     order by created_at desc limit 1))
  = (select v from pg_temp.p8 where k='shift'),
  'and the sale is tied to the drawer it was rung up on');

-- ---- 200 out for tea ----
select pg_temp.expect_error($q$select public.cash_movement((select v from pg_temp.p8 where k='branch'), 'out', 200, 'expense')$q$, 'EXPENSE_CATEGORY_REQUIRED');
select pg_temp.expect_error($q$select public.cash_movement((select v from pg_temp.p8 where k='branch'), 'out', 0, 'other', null, 'nothing')$q$, 'BAD_CASH_AMOUNT');
select pg_temp.expect_error($q$select public.cash_movement((select v from pg_temp.p8 where k='branch'), 'sideways', 200, 'other', null, 'x')$q$, 'BAD_CASH_DIRECTION');
select pg_temp.expect_error($q$select public.cash_movement((select v from pg_temp.p8 where k='branch'), 'out', 200, 'other')$q$, 'REASON_NOTE_REQUIRED');
select pg_temp.check(
  (public.cash_movement((select v from pg_temp.p8 where k='branch'), 'out', 200, 'expense',
                        (select id from public.transaction_categories
                         where name = 'Tea and snacks' and shop_id = :'SHOP'),
                        'Tea for the shop')->>'amount')::numeric = 200,
  'the cashier takes 200 out for tea, against an expense category');
-- Whether it was logged is checked further down, as the owner: a cashier cannot read
-- the audit log at all, which is itself one of the rules.

-- A cashier must not be able to work out what the drawer should hold.
select pg_temp.expect_error($q$select public.expected_cash((select v from pg_temp.p8 where k='shift'))$q$, 'permission denied');
select pg_temp.expect_error($q$select public.shift_list((select v from pg_temp.p8 where k='branch'))$q$, 'NOT_ALLOWED:view_reports');

-- ---- Close with 2,700 counted ----
-- Expected: 2,000 opening + 1,000 cash sale − 200 tea = 2,800. Counted 2,700, so 100
-- is missing.
do $$
declare r jsonb;
begin
  r := public.close_shift((select v from pg_temp.p8 where k='shift'), 2700,
        'Counted twice', '{"1000": 2, "500": 1, "100": 2}');
  -- The cashier is told it is closed and nothing else: showing the expected figure
  -- would turn counting into copying.
  if (r ? 'expected') then raise exception 'CASHIER WAS SHOWN THE EXPECTED CASH: %', r; end if;
  if (r ? 'difference') then raise exception 'CASHIER WAS SHOWN THE DIFFERENCE: %', r; end if;
  if not (r->>'closed')::boolean then raise exception 'NOT CLOSED: %', r; end if;
  raise notice 'ok: the cashier closes the drawer and is told only that it is closed';
end $$;
select pg_temp.expect_error($q$select public.close_shift((select v from pg_temp.p8 where k='shift'), 100)$q$, 'SHIFT_ALREADY_CLOSED');

-- ---- What the owner sees ----
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
do $$
declare s jsonb;
begin
  select x into s from jsonb_array_elements(
    public.shift_list((select v from pg_temp.p8 where k='branch'))) x
    where (x->>'id')::uuid = (select v from pg_temp.p8 where k='shift');
  if s is null then raise exception 'SHIFT NOT IN THE LIST'; end if;
  if (s->>'expected_cash')::numeric <> 2800 then raise exception 'WRONG EXPECTED: %', s; end if;
  if (s->>'counted_cash')::numeric <> 2700 then raise exception 'WRONG COUNTED: %', s; end if;
  if (s->>'difference')::numeric <> -100 then raise exception 'WRONG DIFFERENCE: %', s; end if;
  if not (s->>'over_limit')::boolean then raise exception 'SHORT BY 100 NOT FLAGGED: %', s; end if;
  if (s->'by_method'->>'cash')::numeric <> 1000 then raise exception 'WRONG CASH TOTAL: %', s->'by_method'; end if;
  if (s->>'cash_out')::numeric <> 200 then raise exception 'TEA MONEY MISSING: %', s; end if;
  if (s->'note_counts'->>'1000')::int <> 2 then raise exception 'NOTE COUNTS LOST: %', s; end if;
  raise notice 'ok: the owner sees expected 2,800, counted 2,700, short 100, flagged';
end $$;
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'cash_out') = 1,
  'the cash-out was logged, which only the owner can see');
-- The cash-out shows with its reason and who took it, because "200 missing" and
-- "Ovi took 200 for tea" are different facts.
select pg_temp.check(
  (select (m->>'category') from jsonb_array_elements(
     (select x->'movements' from jsonb_array_elements(
        public.shift_list((select v from pg_temp.p8 where k='branch'))) x
      where (x->>'id')::uuid = (select v from pg_temp.p8 where k='shift'))) m) = 'Tea and snacks',
  'and the tea money is there with its category and who took it');

-- ---- The shop decides how far out is too far ----
select public.save_shop_details('{"cash_short_limit": 500}');
select pg_temp.check(
  (select (x->>'over_limit')::boolean from jsonb_array_elements(
     public.shift_list((select v from pg_temp.p8 where k='branch'))) x
   where (x->>'id')::uuid = (select v from pg_temp.p8 where k='shift')) = false,
  'with the limit raised to 500, being 100 out is no longer flagged');
select public.save_shop_details('{"cash_short_limit": 50}');

-- ---- An owner may sell without opening a drawer ----
select pg_temp.check(
  (public.current_shift((select v from pg_temp.p8 where k='branch'))->>'may_sell_without_shift')::boolean,
  'an owner may sell without a drawer');
select pg_temp.check(
  (public.complete_sale((select v from pg_temp.p8 where k='branch'),
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]',
    'cash', 0, null, null, 500) ? 'invoice_no'),
  'and really can, because locking the owner out of their own till at 9pm is worse');
select pg_temp.check(
  (select shift_id from public.sales
   where branch_id = (select v from pg_temp.p8 where k='branch')
   order by created_at desc limit 1) is null,
  'that sale belongs to no drawer, which is why the owner is warned on screen');

-- ---- Opening is one tap next time ----
select pg_temp.check(
  (public.current_shift((select v from pg_temp.p8 where k='branch'))->>'last_close')::numeric = 2700,
  'the next person to open sees what the last close counted');

-- ===========================================================================
-- 20. SALES HISTORY, VOID AND RETURNS (P9)
-- ===========================================================================
-- The done-when: find an SSD sale by serial at another branch, return it as
-- faulty, the serial becomes 'rma' at the branch where it was handed in, and the
-- owner sees it in the audit log.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
create table pg_temp.p9 (k text primary key, v uuid);
create table pg_temp.p9n (k text primary key, v numeric);

-- ---- The partial-return rule, with a discount and exclusive VAT on it ----
-- Two keyboards at 850 and two mice at 450 = 2,600, less 10% = 2,340. Returning one
-- keyboard must give back 850 - 10% = 765, not 850.
select public.set_feature('vat', false);
-- Pin the two prices, so the arithmetic below is the arithmetic in the comment and not
-- whatever the bulk-price section earlier left behind.
select public.set_prices('00000000-0000-4000-8000-0000000000a5',
  (select id from public.price_lists where shop_id = :'SHOP' and is_default), 850);
select public.set_prices('00000000-0000-4000-8000-0000000000a4',
  (select id from public.price_lists where shop_id = :'SHOP' and is_default), 450);
do $$
declare r jsonb; sale uuid; item uuid;
begin
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":5,"unit_cost":500},
      {"product_id":"00000000-0000-4000-8000-0000000000a4","qty":5,"unit_cost":250}]');
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":2},
          {"product_id":"00000000-0000-4000-8000-0000000000a4","qty":2}]',
        'cash', 10, null, null, 5000);
  sale := (r->>'id')::uuid;
  insert into pg_temp.p9 values ('sale1', sale);
  insert into pg_temp.p9n values ('sale1_total', (r->>'total')::numeric);
  raise notice 'ok: sold 2 keyboards and 2 mice with 10%% off, total %', r->>'total';
end $$;
select pg_temp.check(
  (select v from pg_temp.p9n where k = 'sale1_total') = 2340,
  'the sale came to 2,340 after 10% off 2,600');
-- One keyboard back: 850 less its share of the discount.
select pg_temp.check(
  public.refund_for(
    (select id from public.sale_items where sale_id = (select v from pg_temp.p9 where k='sale1')
     and name like 'Logitech K120%'), 1) = 765,
  'returning one keyboard refunds 765, not the 850 on the shelf');
select pg_temp.check(
  public.refund_for(
    (select id from public.sale_items where sale_id = (select v from pg_temp.p9 where k='sale1')
     and name like 'Logitech K120%'), 2) = 1530,
  'and both of them refund 1,530');

-- ---- Exclusive VAT is added back, inclusive VAT is not added twice ----
select public.set_feature('vat', true);
-- The setup lists have no insert policy either, so a new rate goes through the saver.
select public.save_setting_row('vat_rates', null,
  '{"name": "VAT 10% (exclusive)", "pct": 10, "inclusive": false}');
do $$
declare rate uuid; r jsonb; keyboard uuid := '00000000-0000-4000-8000-0000000000a5';
begin
  select id into rate from public.vat_rates where name = 'VAT 10% (exclusive)';
  perform public.upsert_product(keyboard, jsonb_build_object('vat_rate_id', rate));
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    format('[{"product_id":"%s","qty":4,"unit_cost":500}]', keyboard)::jsonb);
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
        format('[{"product_id":"%s","qty":2}]', keyboard)::jsonb, 'cash', 10, null, null, 5000);
  insert into pg_temp.p9 values ('vatsale', (r->>'id')::uuid);
  -- 2 x 850 = 1,700, less 10% = 1,530, plus 10% VAT = 1,683.
  if (r->>'total')::numeric <> 1683 then raise exception 'WRONG VAT TOTAL: %', r; end if;
  raise notice 'ok: 1,530 after discount plus 10%% VAT on top = 1,683';
end $$;
select pg_temp.check(
  public.refund_for(
    (select id from public.sale_items where sale_id = (select v from pg_temp.p9 where k='vatsale')), 1)
  = 841.50,
  'returning one gives back 765 plus the 76.50 VAT that was charged on top');
select public.set_feature('vat', false);

-- ---- Finding a sale ----
-- A serial SSD sale at Branch A, looked for from Branch B by its serial.
do $$
declare r jsonb; ser uuid;
begin
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a8","qty":1,"unit_cost":5800,
       "serials":["SSDP9RETURN01"]}]');
  select id into ser from public.serials where serial = 'SSDP9RETURN01';
  insert into pg_temp.p9 values ('ssd_serial', ser);
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
        jsonb_build_array(jsonb_build_object(
          'product_id', '00000000-0000-4000-8000-0000000000a8', 'qty', 1,
          'serial_ids', jsonb_build_array(ser))),
        'cash', 0, null, '01711000111', 7000);
  insert into pg_temp.p9 values ('ssd_sale', (r->>'id')::uuid);
  raise notice 'ok: sold the SSD at Branch A as %', r->>'invoice_no';
end $$;
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.sale_history(null, 'SSDP9RETURN01')) x) = 1,
  'the sale is found by the serial on it');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.sale_history(null, '01711000111')) x) >= 1,
  'and by the customer''s phone');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.sale_history(null, 'Samsung 980')) x) >= 1,
  'and by the product name');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.sale_history(null, 'NOTHINGLIKETHIS')) x) = 0,
  'and not by something that was never sold');
select pg_temp.check(
  (public.sale_detail((select v from pg_temp.p9 where k='ssd_sale'))->>'invoice_no') like 'DEMO-MB-%',
  'the detail view opens for the reprint');

-- ---- Return it as faulty, at the OTHER branch ----
insert into pg_temp.p9n
  select 'ssd_at_b_before', coalesce(sum(qty), 0) from public.branch_stock
  where product_id = '00000000-0000-4000-8000-0000000000a8' and branch_id = :'BRANCH_B';
do $$
declare r jsonb; item uuid;
begin
  select id into item from public.sale_items
    where sale_id = (select v from pg_temp.p9 where k='ssd_sale');
  r := public.return_sale(
        (select v from pg_temp.p9 where k='ssd_sale'),
        '00000000-0000-4000-8000-0000000000b2'::uuid,
        jsonb_build_array(jsonb_build_object(
          'sale_item_id', item, 'is_faulty', true,
          'serial_ids', jsonb_build_array((select v from pg_temp.p9 where k='ssd_serial')))),
        'cash', 'Dead on arrival', null, null, 'Sundarban Courier', 'SC-99120');
  if (r->>'return_no') not like 'RET-SB-%' then raise exception 'WRONG RETURN NUMBER: %', r->>'return_no'; end if;
  insert into pg_temp.p9n values ('ssd_refund', (r->>'total')::numeric);
  raise notice 'ok: taken back at Branch B as %, refunded %', r->>'return_no', r->>'total';
end $$;
select pg_temp.check(
  (select v from pg_temp.p9n where k='ssd_refund') = 6200,
  'the full 6,200 went back, because there was no discount on it');
select pg_temp.check(
  (select status from public.serials where id = (select v from pg_temp.p9 where k='ssd_serial')) = 'rma',
  'the faulty serial is in RMA, not back on a shelf');
select pg_temp.check(
  (select l.branch_id from public.serials s join public.stock_locations l on l.id = s.location_id
   where s.id = (select v from pg_temp.p9 where k='ssd_serial')) = '00000000-0000-4000-8000-0000000000b2'::uuid,
  'and it sits at Branch B, where the customer handed it in');
select pg_temp.check(
  (select coalesce(sum(qty), 0) from public.branch_stock
   where product_id = '00000000-0000-4000-8000-0000000000a8' and branch_id = :'BRANCH_B')
  = (select v from pg_temp.p9n where k = 'ssd_at_b_before'),
  'nothing sellable was added at Branch B: a faulty unit is not stock');
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'sale_returned'
   and details->>'courier' = 'Sundarban Courier') = 1,
  'and the owner sees it in the audit log, with the courier it came back by');
select pg_temp.check(
  (select jsonb_array_length(public.sale_detail((select v from pg_temp.p9 where k='ssd_sale'))->'returns')) = 1,
  'the sale now shows the return against it');

-- ---- Nothing goes back twice ----
-- The same serial, a second time. A serial item cannot be returned without saying
-- which unit, so that is checked first, and then that it has not already gone back.
select pg_temp.expect_error(
  format($q$select public.return_sale('%s', '%s',
    jsonb_build_array(jsonb_build_object('sale_item_id',
      (select id from public.sale_items where sale_id = '%s'), 'qty', 1)), 'cash')$q$,
    (select v from pg_temp.p9 where k='ssd_sale'), :'BRANCH_B',
    (select v from pg_temp.p9 where k='ssd_sale')),
  'SERIAL_REQUIRED');
select pg_temp.expect_error(
  format($q$select public.return_sale('%s', '%s',
    jsonb_build_array(jsonb_build_object('sale_item_id',
      (select id from public.sale_items where sale_id = '%s'),
      'serial_ids', jsonb_build_array('%s'))), 'cash')$q$,
    (select v from pg_temp.p9 where k='ssd_sale'), :'BRANCH_B',
    (select v from pg_temp.p9 where k='ssd_sale'),
    (select v from pg_temp.p9 where k='ssd_serial')),
  'MORE_THAN_SOLD');
select pg_temp.expect_error(
  format($q$select public.return_sale('%s', '%s', '[]', 'cash')$q$,
    (select v from pg_temp.p9 where k='ssd_sale'), :'BRANCH_B'), 'NOTHING_RETURNED');
select pg_temp.expect_error(
  format($q$select public.return_sale('%s', '%s',
    jsonb_build_array(jsonb_build_object('sale_item_id',
      (select id from public.sale_items where sale_id = '%s'), 'qty', 1)), 'bitcoin')$q$,
    (select v from pg_temp.p9 where k='ssd_sale'), :'BRANCH_B',
    (select v from pg_temp.p9 where k='ssd_sale')),
  'BAD_REFUND_METHOD');

-- ---- A good item goes back on the shelf, a faulty one does not ----
do $$
declare r jsonb; item uuid; before_qty integer;
begin
  select id into item from public.sale_items
    where sale_id = (select v from pg_temp.p9 where k='sale1') and name like 'Logitech M90%';
  select coalesce(sum(qty), 0) into before_qty from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000a4' and branch_id = '00000000-0000-4000-8000-0000000000b1'::uuid;
  r := public.return_sale((select v from pg_temp.p9 where k='sale1'), '00000000-0000-4000-8000-0000000000b1'::uuid,
        jsonb_build_array(jsonb_build_object('sale_item_id', item, 'qty', 1)),
        'cash', 'Changed their mind');
  if (r->>'total')::numeric <> 405 then raise exception 'WRONG MOUSE REFUND: %', r; end if;
  if (select coalesce(sum(qty), 0) from public.branch_stock
      where product_id = '00000000-0000-4000-8000-0000000000a4' and branch_id = '00000000-0000-4000-8000-0000000000b1'::uuid)
     <> before_qty + 1 then
    raise exception 'THE MOUSE DID NOT GO BACK ON THE SHELF';
  end if;
  raise notice 'ok: a working mouse refunds 405 (450 less 10%%) and goes back on the shelf';
end $$;
select pg_temp.check(
  (select (x->>'returned')::int from jsonb_array_elements(
     public.sale_history(:'BRANCH_A', (select invoice_no from public.sales
                                       where id = (select v from pg_temp.p9 where k='sale1')))) x) = 1,
  'and the sale is marked in the list as partly returned, so it is not refunded twice');

-- ---- Extra charges come back only on a whole-sale return ----
select pg_temp.check(
  (select charges_back from public.sale_returns
   where sale_id = (select v from pg_temp.p9 where k='sale1')) = 0,
  'a partial return pays back no delivery charge: the van still drove');

-- ---- Void: same day, with a reason ----
do $$
declare r jsonb; before_qty integer;
begin
  select coalesce(sum(qty), 0) into before_qty from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000a1' and branch_id = '00000000-0000-4000-8000-0000000000b1'::uuid;
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
        '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 1000);
  insert into pg_temp.p9 values ('voidme', (r->>'id')::uuid);
  perform public.void_sale((r->>'id')::uuid, 'Rang up twice by mistake', null, 'cash');
  if (select coalesce(sum(qty), 0) from public.branch_stock
      where product_id = '00000000-0000-4000-8000-0000000000a1' and branch_id = '00000000-0000-4000-8000-0000000000b1'::uuid)
     <> before_qty then
    raise exception 'VOIDING DID NOT PUT THE STOCK BACK';
  end if;
  raise notice 'ok: a void puts the stock back exactly where it was';
end $$;
select pg_temp.check(
  (select status from public.sales where id = (select v from pg_temp.p9 where k='voidme')) = 'void',
  'the sale is marked void');
select pg_temp.check(
  (select count(*) from public.sales where id = (select v from pg_temp.p9 where k='voidme')) = 1,
  'and the invoice number stays burnt, so the sequence has no hole to explain');
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'sale_voided') = 1,
  'and it is logged with the reason');
select pg_temp.expect_error($q$select public.void_sale((select v from pg_temp.p9 where k='voidme'), 'again')$q$, 'SALE_ALREADY_VOID');
select pg_temp.expect_error($q$select public.void_sale((select v from pg_temp.p9 where k='sale1'), '')$q$, 'VOID_REASON_REQUIRED');
-- A sale with a return against it must not also be voided: the goods would come back twice.
select pg_temp.expect_error($q$select public.void_sale((select v from pg_temp.p9 where k='sale1'), 'undo the lot')$q$, 'SALE_PARTLY_RETURNED');

-- ---- Returning a voided sale is refused ----
select pg_temp.expect_error(
  format($q$select public.return_sale('%s', '%s',
    jsonb_build_array(jsonb_build_object('sale_item_id',
      (select id from public.sale_items where sale_id = '%s'), 'qty', 1)), 'cash')$q$,
    (select v from pg_temp.p9 where k='voidme'), :'BRANCH_A',
    (select v from pg_temp.p9 where k='voidme')),
  'SALE_IS_VOID');

-- ---- Store credit is recorded, not promised ----
-- A walk-in with no phone number cannot be given store credit: there would be nobody to
-- give it back to, and the shop would be out of pocket with no record of who is owed.
select pg_temp.expect_error(
  format($q$select public.return_sale('%s', '%s',
    jsonb_build_array(jsonb_build_object('sale_item_id',
      (select id from public.sale_items where sale_id = '%s' and name like 'Logitech K120%%'),
      'qty', 1)), 'store_credit')$q$,
    (select v from pg_temp.p9 where k='sale1'), :'BRANCH_A',
    (select v from pg_temp.p9 where k='sale1')),
  'CREDIT_NEEDS_CUSTOMER');
do $$
declare r jsonb; item uuid;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
        '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":1}]',
        'cash', 0, null, '01711000222', 500);
  select id into item from public.sale_items where sale_id = (r->>'id')::uuid;
  r := public.return_sale((r->>'id')::uuid, '00000000-0000-4000-8000-0000000000b1'::uuid,
        jsonb_build_array(jsonb_build_object('sale_item_id', item, 'qty', 1)),
        'store_credit', 'Wants to swap it later');
  if (r->>'total')::numeric <> 450 then raise exception 'WRONG CREDIT: %', r; end if;
  raise notice 'ok: 450 given back to a known customer as store credit';
end $$;
select pg_temp.check(
  (select amount from public.customer_credits
   join public.customers c on c.id = customer_credits.customer_id
   where c.phone = '01711000222') = 450,
  'and it is written down against that customer, not just promised');

-- ---- A shop can make big sales wait for approval ----
select public.save_shop_details('{"sale_approval_limit": 1000}');
do $$
declare r jsonb;
begin
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":2}]', 'cash', 0, null, null, 5000);
  insert into pg_temp.p9 values ('bigsale', (r->>'id')::uuid);
  if (select approval_status from public.sales where id = (r->>'id')::uuid) <> 'awaiting_approval' then
    raise exception 'BIG SALE NOT HELD';
  end if;
  raise notice 'ok: a sale over the shop''s limit waits for approval';
end $$;
-- The goods still went out of the door; what waits is the posting.
select pg_temp.check(
  (select status from public.sales where id = (select v from pg_temp.p9 where k='bigsale')) = 'completed',
  'the sale itself is completed: the customer walked out with the goods');
select pg_temp.check(
  (public.set_sale_approval('sale', (select v from pg_temp.p9 where k='bigsale'), 'approve')
   ->>'approval_status') = 'approved',
  'and a manager approves it on the document itself');
select pg_temp.expect_error($q$select public.set_sale_approval('sale', (select v from pg_temp.p9 where k='bigsale'), 'approve')$q$, 'NOT_AWAITING_APPROVAL');
select pg_temp.expect_error($q$select public.set_sale_approval('sale', (select v from pg_temp.p9 where k='bigsale'), 'eat')$q$, 'BAD_APPROVAL_ACTION');
select public.save_shop_details('{"sale_approval_limit": 0}');

-- ---- A cash refund comes out of the drawer ----
-- expected_cash() is not callable from outside the functions, so the figure is read
-- the way the owner reads it: off the drawer screen.
do $$
declare sh uuid; drawer numeric; r jsonb; item uuid;
  branch uuid := '00000000-0000-4000-8000-0000000000b1';
begin
  sh := (public.open_shift(branch, 1000)->>'shift_id')::uuid;
  r := public.complete_sale(branch,
        '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]', 'cash', 0, null, null, 500);
  select (x->>'expected_cash')::numeric into drawer
    from jsonb_array_elements(public.shift_list(branch)) x where (x->>'id')::uuid = sh;
  if drawer <> 1500 then raise exception 'DRAWER SHOULD HOLD 1,500 AFTER A 500 SALE: %', drawer; end if;

  select id into item from public.sale_items where sale_id = (r->>'id')::uuid;
  perform public.return_sale((r->>'id')::uuid, branch,
    jsonb_build_array(jsonb_build_object('sale_item_id', item, 'qty', 1)), 'cash', 'Wrong item');

  select (x->>'expected_cash')::numeric into drawer
    from jsonb_array_elements(public.shift_list(branch)) x where (x->>'id')::uuid = sh;
  if drawer <> 1000 then
    raise exception 'THE REFUND DID NOT COME OUT OF THE DRAWER: %', drawer;
  end if;
  raise notice 'ok: a 500 cash refund takes 500 back out of the expected drawer';
end $$;

-- ---- Who may do what ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
-- A cashier sees their own sales today at their own branch, and nothing else — asking
-- for somebody else's is not refused, it is simply narrowed.
select pg_temp.check(
  (select count(*) from jsonb_array_elements(
     public.sale_history(null, null, null, null,
       (select id from public.staff where name = 'Owner'))) x
   where x->>'staff' <> 'Ovi') = 0,
  'a cashier asking for the owner''s sales gets only their own');
select pg_temp.expect_error($q$select public.void_sale((select v from pg_temp.p9 where k='sale1'), 'nope')$q$, 'NOT_ALLOWED:void_sale');
select pg_temp.expect_error($q$select public.set_sale_approval('sale', (select v from pg_temp.p9 where k='sale1'), 'approve')$q$, 'NOT_ALLOWED:approve');
select pg_temp.check((select count(*) from public.customer_credits) = 0,
  'and a cashier cannot see what any customer is owed');

-- ===========================================================================
-- 21. CREDIT SALES AND CUSTOMERS (P10)
-- ===========================================================================
-- The done-when: a corporate customer with a 50,000 limit buys a 72,000 laptop,
-- pays 30,000 now and 42,000 on due (with a PIN for the limit), pays 20,000 next
-- week, and the due list shows 22,000 aged correctly.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
create table pg_temp.p10 (k text primary key, v uuid);
create table pg_temp.p10n (k text primary key, v numeric);

-- Selling on due is behind a feature switch, like everything else a small shop does
-- not need.
select public.set_feature('credit_sales', false);

-- ---- A corporate group, and a customer in it ----
do $$
declare g jsonb; c jsonb;
begin
  g := public.save_customer_group(null, jsonb_build_object(
        'name', 'Corporate', 'credit_allowed', true, 'credit_limit', 50000,
        'payment_days', 30, 'discount_pct', 0));
  insert into pg_temp.p10 values ('group', (g->>'id')::uuid);

  c := public.save_customer(null, jsonb_build_object(
        'phone', '01911000777', 'name', 'Shopno Enterprise',
        'company', 'Shopno Enterprise Ltd', 'bin_vat', '004123456-0101',
        'group_id', (g->>'id')::uuid,
        'credit_allowed', true, 'credit_limit', 50000, 'payment_days', 30));
  insert into pg_temp.p10 values ('cust', (c->>'id')::uuid);
  raise notice 'ok: a corporate customer with a 50,000 limit and 30 days to pay';
end $$;
select pg_temp.check(
  (public.customer_by_phone('01911000777')->>'credit_limit')::numeric = 50000,
  'the counter learns the limit from the phone number');
select pg_temp.check(
  (public.customer_by_phone('01911000777')->>'credit_left')::numeric = 50000,
  'and how much of it is still free');
select pg_temp.check(
  (public.customer_by_phone('01911000777')->>'owed')::numeric = 0,
  'they owe nothing yet');

-- ---- A laptop on the shelf to sell, priced at 72,000 ----
select public.set_prices('00000000-0000-4000-8000-0000000000aa',
  (select id from public.price_lists where shop_id = :'SHOP' and is_default), 72000);
do $$
begin
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000aa","qty":1,"unit_cost":66000,
       "serials":["P10LAPTOP0001"]}]');
end $$;

-- ---- Nothing goes on due until the shop turns credit on ----
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    jsonb_build_array(jsonb_build_object('product_id','00000000-0000-4000-8000-0000000000aa','qty',1,
      'serial_ids', jsonb_build_array((select id from public.serials where serial = 'P10LAPTOP0001')))),
    'cash', 0, null, '01911000777', 30000, p_due_amount => 42000)$q$, :'BRANCH_A'),
  'FEATURE_OFF:credit_sales');
select public.set_feature('credit_sales', true);

-- ---- A debt has to have somebody's name on it ----
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]',
    'due', 0, null, null, null)$q$, :'BRANCH_A'),
  'DUE_NEEDS_CUSTOMER');
-- And that somebody has to be allowed credit.
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]',
    'due', 0, null, '01799000111', null)$q$, :'BRANCH_A'),
  'CUSTOMER_HAS_NO_CREDIT');

-- ---- 30,000 now, 42,000 on due — which is over the 50,000 limit? No: it is under ----
-- 42,000 of a 50,000 limit is fine. The PIN case is tested right after.
do $$
declare r jsonb; ser uuid;
begin
  select id into ser from public.serials where serial = 'P10LAPTOP0001';
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
        jsonb_build_array(jsonb_build_object(
          'product_id', '00000000-0000-4000-8000-0000000000aa', 'qty', 1,
          'serial_ids', jsonb_build_array(ser))),
        'cash', 0, null, '01911000777', 30000, p_due_amount => 42000);
  if (r->>'total')::numeric <> 72000 then raise exception 'WRONG TOTAL: %', r; end if;
  if (r->>'paid_amount')::numeric <> 30000 then raise exception 'WRONG PAID: %', r; end if;
  if (r->>'due_amount')::numeric <> 42000 then raise exception 'WRONG DUE: %', r; end if;
  if (r->>'change_given')::numeric <> 0 then raise exception 'CHANGE FROM A SPLIT PAYMENT: %', r; end if;
  insert into pg_temp.p10 values ('sale', (r->>'id')::uuid);
  raise notice 'ok: 72,000 laptop, 30,000 handed over, 42,000 on the slate';
end $$;
select pg_temp.check(
  public.customer_due((select v from pg_temp.p10 where k='cust')) = 42000,
  'the customer owes 42,000');
select pg_temp.check(
  (public.customer_by_phone('01911000777')->>'credit_left')::numeric = 8000,
  'and has 8,000 of their limit left');

-- ---- The limit is checked on what they will owe AFTER the next sale ----
-- They have 8,000 of headroom left. Ten keyboards at 850 is 8,500, which is over it —
-- and only over it because of what they ALREADY owe, which is the whole point.
select public.set_prices('00000000-0000-4000-8000-0000000000a5',
  (select id from public.price_lists where shop_id = :'SHOP' and is_default), 850);
do $$
begin
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":20,"unit_cost":500}]');
end $$;
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":10}]',
    'due', 0, null, '01911000777', null)$q$, :'BRANCH_A'),
  'OVER_CREDIT_LIMIT');
-- One keyboard is well inside the headroom, so it goes through with no approval at all.
select pg_temp.check(
  (public.complete_sale(:'BRANCH_A',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]',
    'due', 0, null, '01911000777', null)->>'due_amount')::numeric = 850,
  'and a small one inside the limit needs nobody''s permission');

-- With a manager's PIN the big one goes through, and the override is logged.
do $$
declare appr uuid; r jsonb;
begin
  -- The owner approves with their own PIN, the same approval a big discount uses.
  appr := (public.verify_manager_pin(
            (select id from public.staff where name = 'Owner'), '4821')->>'approval_id')::uuid;
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
        '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":10}]',
        'due', 0, appr, '01911000777', null);
  if (r->>'due_amount')::numeric <> 8500 then raise exception 'WRONG DUE: %', r; end if;
  raise notice 'ok: over the limit, a manager''s PIN lets 8,500 through';
end $$;
select pg_temp.check(
  (select count(*) from public.audit_log where action = 'credit_limit_overridden') = 1,
  'and the override is logged with the limit, what was already owed and the new due');
select pg_temp.check(
  (select (details->>'already_owed')::numeric from public.audit_log
   where action = 'credit_limit_overridden') = 42850,
  'naming what they already owed, which is the figure that matters');

-- ---- Pay 20,000 ----
do $$
declare r jsonb;
begin
  r := public.collect_payment('00000000-0000-4000-8000-0000000000b1'::uuid,
        (select v from pg_temp.p10 where k='cust'), 20000, 'bank', 'CHQ-40021');
  if (r->>'receipt_no') not like 'REC-MB-%' then raise exception 'WRONG RECEIPT NUMBER: %', r->>'receipt_no'; end if;
  if (r->>'was_owed')::numeric <> 51350 then raise exception 'WRONG BALANCE BEFORE: %', r; end if;
  if (r->>'owed')::numeric <> 31350 then raise exception 'WRONG BALANCE AFTER: %', r; end if;
  raise notice 'ok: 20,000 collected on receipt %, leaving %', r->>'receipt_no', r->>'owed';
end $$;
select pg_temp.expect_error(
  format($q$select public.collect_payment('%s', '%s', 0, 'cash')$q$,
    :'BRANCH_A', (select v from pg_temp.p10 where k='cust')), 'BAD_PAYMENT_AMOUNT');
select pg_temp.expect_error(
  format($q$select public.collect_payment('%s', '%s', 100, 'barter')$q$,
    :'BRANCH_A', (select v from pg_temp.p10 where k='cust')), 'BAD_PAYMENT_METHOD');
select pg_temp.expect_error(
  format($q$select public.collect_payment('%s', '%s', 100, 'cash', null, null, gen_random_uuid())$q$,
    :'BRANCH_A', (select v from pg_temp.p10 where k='cust')), 'ACCOUNT_NOT_FOUND');

-- ---- The due list, aged ----
do $$
declare row jsonb;
begin
  select x into row from jsonb_array_elements(public.due_list()) x
    where (x->>'customer_id')::uuid = (select v from pg_temp.p10 where k='cust');
  if row is null then raise exception 'CUSTOMER NOT IN THE DUE LIST'; end if;
  if (row->>'owed')::numeric <> 31350 then raise exception 'WRONG OWED: %', row; end if;
  -- Everything was sold today, so it is all in the newest bucket and none of it is
  -- overdue: they have 30 days.
  if (row->'aging'->>'days_0_30')::numeric <> 31350 then raise exception 'WRONG BUCKET: %', row->'aging'; end if;
  if (row->'aging'->>'overdue')::numeric <> 0 then raise exception 'WRONGLY OVERDUE: %', row->'aging'; end if;
  if (row->>'payment_days')::int <> 30 then raise exception 'WRONG TERMS: %', row; end if;
  raise notice 'ok: the due list shows 31,350 owed, none of it overdue on 30-day terms';
end $$;

-- An older debt lands in the right bucket and counts as overdue past the terms.
select pg_temp.check(
  (public.set_opening_balance('customer', (select v from pg_temp.p10 where k='cust'),
                              5000, public.dhaka_today() - 90, 'Owed when we moved across')
   ->>'amount')::numeric = 5000,
  'an owner can record what a customer already owed');
do $$
declare a jsonb;
begin
  a := public.customer_aging((select v from pg_temp.p10 where k='cust'));
  -- 5,000 from 90 days ago, 51,350 from today, 20,000 paid. Oldest first clears the
  -- 5,000 and takes 15,000 off today's, leaving 36,350.
  if (a->>'days_60_plus')::numeric <> 0 then raise exception 'OLD DEBT NOT CLEARED FIRST: %', a; end if;
  if (a->>'days_0_30')::numeric <> 36350 then raise exception 'WRONG RECENT BUCKET: %', a; end if;
  raise notice 'ok: the 90-day debt is cleared first, as the customer would assume';
end $$;

-- ---- The statement ----
do $$
declare st jsonb; kinds text;
begin
  st := public.customer_statement((select v from pg_temp.p10 where k='cust'));
  select string_agg(distinct e->>'kind', ',') into kinds
    from jsonb_array_elements(st->'entries') e;
  if kinds not like '%sale%' then raise exception 'NO SALES ON THE STATEMENT: %', kinds; end if;
  if kinds not like '%payment%' then raise exception 'NO PAYMENTS ON THE STATEMENT: %', kinds; end if;
  if kinds not like '%opening%' then raise exception 'NO OPENING BALANCE: %', kinds; end if;
  if (st->>'total_spent')::numeric < 72000 then raise exception 'WRONG TOTAL SPENT: %', st->>'total_spent'; end if;
  -- The laptop is serial tracked, so the customer owns a traceable machine.
  if jsonb_array_length(st->'owns') < 1 then raise exception 'NO SERIALS OWNED: %', st->'owns'; end if;
  if not (st->'owns'->0->>'in_warranty')::boolean then raise exception 'LAPTOP NOT IN WARRANTY: %', st->'owns'; end if;
  raise notice 'ok: the statement shows the sale, the payment, the opening balance and the laptop they own';
end $$;

-- ---- A group can carry the price list, so a dealer is one field ----
do $$
declare g jsonb; c jsonb;
begin
  g := public.save_customer_group(null, jsonb_build_object(
        'name', 'Dealer',
        'price_list_id', (select id from public.price_lists where name = 'Dealer'),
        'discount_pct', 2));
  c := public.save_customer(null, jsonb_build_object(
        'phone', '01911000888', 'name', 'Corner Shop', 'group_id', (g->>'id')::uuid));
  raise notice 'ok: a dealer set up by picking the group, with no prices typed in';
end $$;
select pg_temp.check(
  (public.customer_by_phone('01911000888')->>'price_list_name') = 'Dealer',
  'and the counter picks up the dealer price list from the group');
select pg_temp.check(
  (public.customer_by_phone('01911000888')->>'discount_pct')::numeric = 2,
  'and the group''s standing discount');

-- ---- A cash collection goes through the drawer ----
do $$
declare sh uuid; drawer numeric; before numeric;
  branch uuid := '00000000-0000-4000-8000-0000000000b1';
begin
  -- P9 left a drawer open at this branch, which is the realistic case anyway: money is
  -- collected during the day, not on a fresh till.
  sh := (public.current_shift(branch)->>'shift_id')::uuid;
  if sh is null then sh := (public.open_shift(branch, 0)->>'shift_id')::uuid; end if;
  select (x->>'expected_cash')::numeric into before
    from jsonb_array_elements(public.shift_list(branch)) x where (x->>'id')::uuid = sh;
  perform public.collect_payment(branch, (select v from pg_temp.p10 where k='cust'),
    1000, 'cash');
  select (x->>'expected_cash')::numeric into drawer
    from jsonb_array_elements(public.shift_list(branch)) x where (x->>'id')::uuid = sh;
  if drawer <> before + 1000 then
    raise exception 'THE COLLECTION DID NOT REACH THE DRAWER: % then %', before, drawer;
  end if;
  raise notice 'ok: 1,000 collected in cash is 1,000 more in the drawer';
end $$;

-- ---- Who may do what ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
-- A cashier may add a walk-in's name and take a payment; they may not set credit.
select pg_temp.check(
  (public.save_customer(null, '{"phone": "01911000999", "name": "Walk-in Rahim"}')->>'phone') = '01911000999',
  'a cashier can put a name to a walk-in, which is how the list gets built');
select pg_temp.expect_error($q$select public.save_customer(null, '{"phone": "01911000100", "credit_limit": 500000}')$q$, 'NOT_MANAGER');
select pg_temp.expect_error(
  format($q$select public.save_customer('%s', '{"credit_allowed": true}')$q$,
    (select v from pg_temp.p10 where k='cust')), 'NOT_MANAGER');
select pg_temp.expect_error($q$select public.due_list()$q$, 'NOT_ALLOWED:view_reports');
select pg_temp.expect_error(
  format($q$select public.customer_statement('%s')$q$,
    (select v from pg_temp.p10 where k='cust')), 'NOT_ALLOWED:view_reports');
select pg_temp.expect_error(
  format($q$select public.customer_aging('%s')$q$,
    (select v from pg_temp.p10 where k='cust')), 'NOT_ALLOWED:view_reports');
-- But a cashier CAN see what one customer owes, because they may be taking the money.
select pg_temp.check(
  public.customer_due((select v from pg_temp.p10 where k='cust')) > 0,
  'a cashier can see what the customer in front of them owes');

-- ===========================================================================
-- 22. THE FULL COUNTER (P10a)
-- ===========================================================================
-- The done-when: a simple cash sale still works untouched, AND a 72,000 laptop
-- goes out on 12-month EMI by card with the bank charge added, an old laptop
-- taken in exchange for 15,000, with Attention and BIN filled in.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
create table pg_temp.p10a (k text primary key, v uuid);

-- ---- The simple sale is untouched ----
-- Everything new is optional, so the four-argument call still works exactly as before.
select pg_temp.check(
  (public.complete_sale(:'BRANCH_A',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]',
    'cash', 0, null, null, 500)->>'total')::numeric = 500,
  'the simple cash sale still goes through with nothing extra said');

-- ---- The shop sets up EMI and its own extra fields ----
select pg_temp.check(
  (public.save_emi_plan(null, '{"bank":"City Bank","months":12,"charge_pct":4,"min_amount":10000}')
   ->>'months')::int = 12,
  'the owner types in the bank''s 12-month EMI plan');
select public.save_emi_plan(null, '{"bank":"City Bank","months":24,"charge_pct":8,"min_amount":25000}');
select pg_temp.expect_error($q$select public.save_emi_plan(null, '{"months": 6}')$q$, 'EMI_BANK_REQUIRED');
select public.save_setting_row('sale_fields', null, '{"name":"PO number","show_on_invoice":true}');
select public.save_setting_row('card_types', null, '{"name":"Visa Platinum","charge_pct":2.5}');

-- EMI is off until the owner allows it, per product or per category.
select pg_temp.check(
  public.emi_allowed('00000000-0000-4000-8000-0000000000aa') = false,
  'EMI is off on every product until the owner says otherwise');
select public.save_setting_row('card_types', (select id from public.card_types where name = 'Visa Platinum'), '{"charge_pct":2.5}');

-- ---- A 72,000 laptop on EMI, by card, with an exchange ----
select public.save_shop_details('{"card_charge_mode": "add"}');
do $$
declare r jsonb; ser uuid; cat uuid;
begin
  -- Allow EMI on the Laptops category, which is how a shop would actually do it.
  select category_id into cat from public.products
    where id = '00000000-0000-4000-8000-0000000000aa';
  update public.categories set emi_allowed = true where id = cat;

  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000aa","qty":1,"unit_cost":66000,
       "serials":["P10ALAPTOP001"]}]');
  select id into ser from public.serials where serial = 'P10ALAPTOP001';

  r := public.complete_sale(
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    jsonb_build_array(jsonb_build_object(
      'product_id', '00000000-0000-4000-8000-0000000000aa', 'qty', 1,
      'serial_ids', jsonb_build_array(ser))),
    'card', 0, null, '01911000777', null, '4119',
    p_extras => jsonb_build_object(
      'attention', 'Mr Faruk, Accounts',
      'customer_bin', '004123456-0101',
      'customer_address', 'Motijheel, Dhaka',
      'narration', 'Laptop for the new accountant',
      'extra_fields', jsonb_build_object('PO number', 'PO-4471'),
      'card', jsonb_build_object(
        'type_id', (select id from public.card_types where name = 'Visa Platinum'),
        'bank', 'City Bank', 'last4', '4119'),
      'emi', jsonb_build_object('months', 12, 'bank', 'City Bank'),
      'exchange', jsonb_build_object(
        'description', 'Old HP Pavilion, 2019, working', 'serial', 'OLDHP2019X',
        'value', 15000)));
  insert into pg_temp.p10a values ('sale', (r->>'id')::uuid);

  -- 72,000 + 2.5% card (1,800) + 4% EMI (2,880) = 76,680, less 15,000 exchange = 61,680.
  if (r->>'card_charge')::numeric <> 1800 then raise exception 'WRONG CARD CHARGE: %', r->>'card_charge'; end if;
  if (r->>'emi_charge')::numeric <> 2880 then raise exception 'WRONG EMI CHARGE: %', r->>'emi_charge'; end if;
  if (r->>'exchange_value')::numeric <> 15000 then raise exception 'WRONG EXCHANGE: %', r->>'exchange_value'; end if;
  if (r->>'total')::numeric <> 61680 then raise exception 'WRONG TOTAL: %', r->>'total'; end if;
  if (r->>'attention') <> 'Mr Faruk, Accounts' then raise exception 'ATTENTION LOST: %', r; end if;
  if (r->>'customer_bin') <> '004123456-0101' then raise exception 'BIN LOST: %', r; end if;
  if (r->'extra_fields'->>'PO number') <> 'PO-4471' then raise exception 'PO NUMBER LOST: %', r->'extra_fields'; end if;
  if (r->>'emi_months')::int <> 12 then raise exception 'EMI MONTHS LOST: %', r; end if;
  raise notice 'ok: 72,000 laptop, +1,800 card, +2,880 EMI, −15,000 exchange = 61,680';
end $$;
select pg_temp.check(
  (select attention from public.sales where id = (select v from pg_temp.p10a where k='sale'))
    = 'Mr Faruk, Accounts',
  'the sale itself carries who it is addressed to');
select pg_temp.check(
  (select card_last4 from public.sales where id = (select v from pg_temp.p10a where k='sale')) = '4119',
  'and the last four digits of the card');
select pg_temp.check(
  (select description from public.sale_exchanges
   where sale_id = (select v from pg_temp.p10a where k='sale')) = 'Old HP Pavilion, 2019, working',
  'and the old laptop that was taken in, described');
select pg_temp.check(
  (select sold_by from public.sales where id = (select v from pg_temp.p10a where k='sale'))
    = (select id from public.staff where name = 'Owner'),
  'and who sold it, which defaults to whoever rang it up');

-- ---- The rules the screen must not be able to talk its way past ----
-- A bank will not run EMI on a 500-taka adapter, and the plan says so.
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]',
    'card', 0, null, null, null, '4119',
    p_extras => '{"emi": {"months": 12, "bank": "City Bank"}}')$q$, :'BRANCH_A'),
  'EMI_BELOW_MINIMUM');
-- And over the minimum it is still refused on a product the owner has not allowed.
do $$
begin
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":40,"unit_cost":300}]');
end $$;
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":30}]',
    'card', 0, null, null, null, '4119',
    p_extras => '{"emi": {"months": 12, "bank": "City Bank"}}')$q$, :'BRANCH_A'),
  'EMI_NOT_ALLOWED');
-- A tenure the bank does not run. Cables are allowed on EMI from here on, so the only
-- thing left to refuse is the tenure itself.
do $$
declare cat uuid;
begin
  select category_id into cat from public.products
    where id = '00000000-0000-4000-8000-0000000000a1';
  update public.categories set emi_allowed = true where id = cat;
end $$;
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":30}]',
    'card', 0, null, null, null, '4119',
    p_extras => '{"emi": {"months": 9, "bank": "City Bank"}}')$q$, :'BRANCH_A'),
  'NO_EMI_PLAN');
-- An extra field the shop never defined.
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]',
    'cash', 0, null, null, 500,
    p_extras => '{"extra_fields": {"Invented Field": "x"}}')$q$, :'BRANCH_A'),
  'UNKNOWN_SALE_FIELD');
-- An exchange worth more than the sale is a purchase in disguise.
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]',
    'cash', 0, null, null, 500,
    p_extras => '{"exchange": {"description": "Old laptop", "value": 50000}}')$q$, :'BRANCH_A'),
  'EXCHANGE_OVER_TOTAL');
-- An exchange with no description is a number nobody can check.
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]',
    'cash', 0, null, null, 500,
    p_extras => '{"exchange": {"value": 100}}')$q$, :'BRANCH_A'),
  'EXCHANGE_NEEDS_DESCRIPTION');
-- A split that does not add up leaves the drawer wrong at closing time.
select pg_temp.expect_error(
  format($q$select public.complete_sale('%s',
    '[{"product_id":"00000000-0000-4000-8000-0000000000a1","qty":1}]',
    'cash', 0, null, null, 500,
    p_extras => '{"payments": [{"method": "cash", "amount": 300}]}')$q$, :'BRANCH_A'),
  'SPLIT_DOES_NOT_ADD_UP');

-- ---- Split payment across methods ----
select public.set_prices('00000000-0000-4000-8000-0000000000a6',
  (select id from public.price_lists where shop_id = :'SHOP' and is_default), 1200);
do $$
declare r jsonb;
begin
  -- A 1,200 cooling pad: 700 cash, 500 by bKash.
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a6","qty":1,"unit_cost":900}]');
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a6","qty":1}]',
    'cash', 0, null, null, 700,
    p_extras => jsonb_build_object('payments', jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount', 700),
      jsonb_build_object('method', 'bkash', 'amount', 500, 'reference', 'TRX99001'))));
  if (r->>'change_given')::numeric <> 0 then raise exception 'CHANGE ON AN EXACT SPLIT: %', r; end if;
  if jsonb_array_length(r->'payments') <> 2 then raise exception 'SPLIT NOT RECORDED: %', r->'payments'; end if;
  raise notice 'ok: 1,200 paid as 700 cash and 500 bKash, both recorded';
end $$;
select pg_temp.check(
  (select sum(amount) from public.sale_payments
   where sale_id = (select id from public.sales order by created_at desc limit 1)) = 1200,
  'and the two parts add up to what was paid');

-- ---- An exchange can go back on the shelf as a used unit ----
do $$
declare r jsonb; before_qty integer;
begin
  select coalesce(sum(qty), 0) into before_qty from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000a9'
      and branch_id = '00000000-0000-4000-8000-0000000000b1';
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1,"unit_cost":500}]');
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]',
    'cash', 0, null, null, 1000,
    p_extras => jsonb_build_object('exchange', jsonb_build_object(
      'description', 'Used TP-Link router, works', 'serial', 'USEDROUTER01',
      'value', 300, 'product_id', '00000000-0000-4000-8000-0000000000a9',
      'add_to_stock', true)));
  if (select coalesce(sum(qty), 0) from public.branch_stock
      where product_id = '00000000-0000-4000-8000-0000000000a9'
        and branch_id = '00000000-0000-4000-8000-0000000000b1') <> before_qty + 1 then
    raise exception 'THE USED ROUTER DID NOT REACH THE SHELF';
  end if;
  raise notice 'ok: the old router went on the shelf as a used unit with its serial';
end $$;
select pg_temp.check(
  (select status from public.serials where serial = 'USEDROUTER01') = 'in_stock',
  'and its serial is sellable');
select pg_temp.check(
  (select count(*) from public.stock_movements
   where note like '%taken in exchange') = 1,
  'and the stock movement says where it came from');

-- ---- Price help, without handing over the shop's cost ----
do $$
declare h jsonb;
begin
  h := public.price_help('00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000b1',
        (select id from public.customers where phone = '01911000777'));
  if (h->>'last_price') is null then raise exception 'NO LAST PRICE: %', h; end if;
  if not (h ? 'here') then raise exception 'NO STOCK FIGURE: %', h; end if;
  if h ? 'cost' then raise exception 'PRICE HELP LEAKED THE COST: %', h; end if;
  raise notice 'ok: the counter can see the last price and the stock, and not the cost';
end $$;
select pg_temp.check(
  (public.price_help('00000000-0000-4000-8000-0000000000aa', :'BRANCH_A')->>'emi_allowed')::boolean,
  'and that this laptop can go on EMI');
select pg_temp.check(
  jsonb_array_length(public.price_help('00000000-0000-4000-8000-0000000000aa', :'BRANCH_A')->'emi_plans') = 2,
  'with the two plans the bank runs');
select pg_temp.check(
  jsonb_array_length(public.price_help('00000000-0000-4000-8000-0000000000ab', :'BRANCH_A')->'emi_plans') = 0,
  'and no plans at all on something EMI is not allowed on');

-- ---- The shop decides who pays the card company ----
select public.save_shop_details('{"card_charge_mode": "absorb"}');
do $$
declare r jsonb;
begin
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1,"unit_cost":500}]');
  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a5","qty":1}]',
    'card', 0, null, null, null, '4119',
    p_extras => jsonb_build_object('card', jsonb_build_object(
      'type_id', (select id from public.card_types where name = 'Visa Platinum'),
      'last4', '4119')));
  if (r->>'card_charge')::numeric <> 0 then
    raise exception 'THE SHOP ABSORBS THE CHARGE, SO THE CUSTOMER MUST NOT PAY IT: %', r;
  end if;
  if (r->>'total')::numeric <> 850 then raise exception 'WRONG TOTAL: %', r; end if;
  raise notice 'ok: with the charge absorbed, the customer pays the shelf price';
end $$;

-- ---- Who may do what ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error($q$select public.save_emi_plan(null, '{"bank":"X","months":3}')$q$, 'NOT_ALLOWED:edit_settings');
-- A cashier can use the price help: it exists so they can sell without guessing.
select pg_temp.check(
  public.price_help('00000000-0000-4000-8000-0000000000a1', :'BRANCH_A') ? 'here',
  'a cashier can see the price help, because that is who it is for');

-- ===========================================================================
-- 23. WARRANTY LOOKUP AND CLAIMS (P11)
-- ===========================================================================
-- The done-when: look up an SSD by serial, open a claim, send it to the
-- supplier, get a replacement back, deliver it, and the NEW serial carries the
-- REMAINING warranty of the old one.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
create table pg_temp.p11 (k text primary key, v uuid);

-- ---- Sell an SSD with a serial, so there is something to claim against ----
do $$
declare ser uuid; r jsonb;
begin
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a8","qty":2,"unit_cost":5800,
       "serials":["P11SSD000001","P11SSD000002"]}]');
  select id into ser from public.serials where serial = 'P11SSD000001';
  insert into pg_temp.p11 values ('ser', ser);
  insert into pg_temp.p11 values ('swap', (select id from public.serials where serial = 'P11SSD000002'));

  r := public.complete_sale('00000000-0000-4000-8000-0000000000b1'::uuid,
        jsonb_build_array(jsonb_build_object(
          'product_id', '00000000-0000-4000-8000-0000000000a8', 'qty', 1,
          'serial_ids', jsonb_build_array(ser))),
        'cash', 0, null, '01911000777', 7000);
  insert into pg_temp.p11 values ('sale', (r->>'id')::uuid);
  raise notice 'ok: SSD sold with serial P11SSD000001, five years of cover';
end $$;

-- ---- One box: serial, invoice or phone ----
do $$
declare hit jsonb;
begin
  select x into hit from jsonb_array_elements(public.warranty_lookup('P11SSD000001')) x limit 1;
  if hit is null then raise exception 'SERIAL LOOKUP FOUND NOTHING'; end if;
  if not (hit->>'in_warranty')::boolean then raise exception 'SHOULD BE IN WARRANTY: %', hit; end if;
  if (hit->>'product') not like 'Samsung 980%' then raise exception 'WRONG PRODUCT: %', hit; end if;
  if (hit->>'branch') <> 'Main branch' then raise exception 'WRONG BRANCH: %', hit; end if;
  if (hit->>'sold_by') is null then raise exception 'NOBODY SOLD IT: %', hit; end if;
  -- "8 months left" is what a customer asks; the shop has a date.
  if (hit->>'days_left')::int <= 0 then raise exception 'NO DAYS LEFT: %', hit; end if;
  insert into pg_temp.p11 values ('found', null) on conflict do nothing;
  raise notice 'ok: looked up by serial — % in warranty, % days left',
    hit->>'product', hit->>'days_left';
end $$;
select pg_temp.check(
  jsonb_array_length(public.warranty_lookup(
    (select invoice_no from public.sales where id = (select v from pg_temp.p11 where k='sale')))) >= 1,
  'and the same thing is found by its invoice number');
select pg_temp.check(
  jsonb_array_length(public.warranty_lookup('01911000777')) >= 1,
  'and by the customer''s phone');
select pg_temp.expect_error($q$select public.warranty_lookup('   ')$q$, 'NOTHING_TO_LOOK_UP');

-- ---- Something sold before the shop switched over ----
select pg_temp.check(
  (public.save_manual_warranty(
    '{"serial":"OLDBMS00001","item_text":"Dell laptop sold under BMS",
      "customer_phone":"01911000777","sold_on":"2026-01-10","warranty_until":"2027-01-10"}')
   ->>'serial') = 'OLDBMS00001',
  'a manager can record a warranty for something sold before the switch');
select pg_temp.check(
  (select (x->>'in_warranty')::boolean from jsonb_array_elements(
     public.warranty_lookup('OLDBMS00001')) x) ,
  'and it comes up in the same one box, in warranty');
select pg_temp.expect_error($q$select public.save_manual_warranty('{"serial":"X1"}')$q$, 'ITEM_REQUIRED');

-- ---- Open a claim ----
do $$
declare r jsonb;
begin
  r := public.open_claim(
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    'Not detected by the laptop at all',
    (select v from pg_temp.p11 where k='ser'),
    null, null,
    (select id from public.problem_types where name = 'Not detected'),
    array['Box', 'Thermal pad'],
    null, '01911000777', 'Shopno Enterprise');
  if (r->>'claim_no') not like 'CLA-MB-%' then raise exception 'WRONG CLAIM NUMBER: %', r->>'claim_no'; end if;
  if not (r->>'in_warranty')::boolean then raise exception 'CLAIM NOT IN WARRANTY: %', r; end if;
  insert into pg_temp.p11 values ('claim', (r->>'id')::uuid);
  raise notice 'ok: claim % opened, in warranty until %', r->>'claim_no', r->>'warranty_until';
end $$;
-- The unit is in the shop's hands and belongs to someone else: not stock, not sold.
select pg_temp.check(
  (select status from public.serials where id = (select v from pg_temp.p11 where k='ser')) = 'rma',
  'the unit sits in RMA: it is neither stock nor the customer''s while we have it');
select pg_temp.check(
  (select count(*) from public.claim_events
   where claim_id = (select v from pg_temp.p11 where k='claim')) = 1,
  'and taking it in is the first timed, attributed event');
-- Two claims on the same laptop is two people chasing the same supplier.
select pg_temp.expect_error(
  format($q$select public.open_claim('%s', 'Same fault again', '%s')$q$,
    :'BRANCH_A', (select v from pg_temp.p11 where k='ser')),
  'CLAIM_ALREADY_OPEN');
select pg_temp.expect_error(
  format($q$select public.open_claim('%s', '   ', '%s')$q$,
    :'BRANCH_A', (select v from pg_temp.p11 where k='ser')),
  'PROBLEM_REQUIRED');
select pg_temp.expect_error(format($q$select public.open_claim('%s', 'A fault')$q$, :'BRANCH_A'), 'ITEM_REQUIRED');

-- ---- Diagnose it, then send it to the supplier ----
select pg_temp.check(
  (public.set_claim_status((select v from pg_temp.p11 where k='claim'), 'diagnosed',
                           'Controller board dead, not repairable here')->>'status') = 'diagnosed',
  'the technician diagnoses it');
-- "With the supplier" has to say which supplier, or it means nothing.
select pg_temp.expect_error(
  format($q$select public.set_claim_status('%s', 'with_supplier')$q$,
    (select v from pg_temp.p11 where k='claim')), 'CLAIM_NEEDS_SUPPLIER');
do $$
declare r jsonb;
begin
  r := public.set_claim_status((select v from pg_temp.p11 where k='claim'), 'with_supplier',
        'Sent with the week''s RMA batch',
        (select id from public.suppliers where name = 'Smart Technologies BD'));
  raise notice 'ok: sent to the supplier';
end $$;
select pg_temp.check(
  (select status from public.serials where id = (select v from pg_temp.p11 where k='ser')) = 'with_supplier',
  'and the serial says it is out with them, not sitting on our shelf');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.supplier_rma_list()) x
   where x->>'serial' = 'P11SSD000001') = 1,
  'so the supplier RMA list knows what is with whom');
select pg_temp.check(
  (select (x->>'days_out')::int from jsonb_array_elements(public.supplier_rma_list()) x
   where x->>'serial' = 'P11SSD000001') = 0,
  'and since when');

-- ---- A replacement comes back and is handed over ----
select pg_temp.check(
  (public.set_claim_status((select v from pg_temp.p11 where k='claim'), 'back_from_supplier',
                           'They sent a replacement unit')->>'status') = 'back_from_supplier',
  'the supplier sends one back');
select pg_temp.check(
  (public.set_claim_status((select v from pg_temp.p11 where k='claim'), 'ready',
                           'Tested, works')->>'status') = 'ready',
  'it is tested and ready for collection');
do $$
declare r jsonb; old_until date; new_until date;
begin
  select warranty_until into old_until from public.warranty_claims
    where id = (select v from pg_temp.p11 where k='claim');
  r := public.set_claim_status((select v from pg_temp.p11 where k='claim'), 'delivered',
        'Swapped for a new unit', null, (select v from pg_temp.p11 where k='swap'));
  if (r->>'replacement_serial') <> 'P11SSD000002' then
    raise exception 'WRONG REPLACEMENT: %', r;
  end if;
  raise notice 'ok: handed over as a swap, with the remaining cover to %', old_until;
end $$;
-- THE RULE: the replacement carries what was LEFT of the original cover, not a fresh term.
select pg_temp.check(
  (select (x->>'warranty_until')::date from jsonb_array_elements(
     public.warranty_lookup('P11SSD000002')) x limit 1)
  = (select warranty_until from public.warranty_claims
     where id = (select v from pg_temp.p11 where k='claim')),
  'and the new serial carries the REMAINING warranty of the one it replaced');
select pg_temp.check(
  (select status from public.serials where id = (select v from pg_temp.p11 where k='swap')) = 'sold',
  'the replacement is the customer''s now');
select pg_temp.check(
  (select status from public.serials where id = (select v from pg_temp.p11 where k='ser')) = 'rma',
  'and the dead one stays the shop''s problem, not back on a shelf');
select pg_temp.check(
  (select count(*) from public.stock_movements
   where note like 'CLA-MB-%warranty replacement') = 1,
  'the replacement leaving the shelf is recorded, because it physically did');
select pg_temp.check(
  (select count(*) from public.claim_events
   where claim_id = (select v from pg_temp.p11 where k='claim')) = 6,
  'and every step is in the claim''s own history');
select pg_temp.expect_error(
  format($q$select public.set_claim_status('%s', 'ready')$q$,
    (select v from pg_temp.p11 where k='claim')), 'CLAIM_ALREADY_CLOSED');

-- ---- An in-house repair takes parts out of stock ----
do $$
declare r jsonb; claim uuid; before_qty integer;
begin
  perform public.receive_goods('00000000-0000-4000-8000-0000000000b1'::uuid,
    '[{"product_id":"00000000-0000-4000-8000-0000000000a4","qty":3,"unit_cost":250}]');
  select coalesce(sum(qty), 0) into before_qty from public.branch_stock
    where product_id = '00000000-0000-4000-8000-0000000000a4'
      and branch_id = '00000000-0000-4000-8000-0000000000b1';

  r := public.open_claim('00000000-0000-4000-8000-0000000000b1'::uuid,
        'Mouse buttons sticking', null, '00000000-0000-4000-8000-0000000000a4',
        null, null, null, null, '01711000111', 'Walk-in');
  claim := (r->>'id')::uuid;
  insert into pg_temp.p11 values ('repair', claim);

  perform public.use_claim_part(claim, '00000000-0000-4000-8000-0000000000a4', 1);
  if (select coalesce(sum(qty), 0) from public.branch_stock
      where product_id = '00000000-0000-4000-8000-0000000000a4'
        and branch_id = '00000000-0000-4000-8000-0000000000b1') <> before_qty - 1 then
    raise exception 'THE PART DID NOT COME OUT OF STOCK';
  end if;
  raise notice 'ok: a part used in an in-house repair comes out of stock';
end $$;
select pg_temp.check(
  (select count(*) from public.stock_movements
   where reason_detail = 'internal_use' and note like '%part used in repair') = 1,
  'and the movement says it went into a repair, not out of the door');
select pg_temp.check(
  (select (x->>'in_warranty')::boolean from jsonb_array_elements(
     public.claim_list(null, null, null, null, 'CLA')) x
   where (x->>'id')::uuid = (select v from pg_temp.p11 where k='repair')) = false,
  'a claim on something with no sale behind it is recorded as out of warranty');

-- ---- The lists a service counter works from ----
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.claim_list(null, 'open')) x) >= 1,
  'the open claims are a list of their own');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.claim_list(null, 'delivered')) x) = 1,
  'and so are the finished ones');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.claim_list(null, null, null, 9999)) x) = 0,
  'and "waiting over 9,999 days" is empty, as it should be');
select pg_temp.check(
  (select jsonb_array_length(x->'events') from jsonb_array_elements(public.claim_list()) x
   where (x->>'id')::uuid = (select v from pg_temp.p11 where k='claim')) = 6,
  'each claim carries its own timed history');
select pg_temp.check(
  (select (x->'accessories'->>0) from jsonb_array_elements(public.claim_list()) x
   where (x->>'id')::uuid = (select v from pg_temp.p11 where k='claim')) = 'Box',
  'and what came in with it, so a missing charger has an answer');

-- ---- A shop can make claim steps wait for a manager ----
select public.save_shop_details('{"claim_approval": true}');
do $$
declare r jsonb;
begin
  r := public.open_claim('00000000-0000-4000-8000-0000000000b1'::uuid,
        'Screen flickering', null, '00000000-0000-4000-8000-0000000000aa',
        null, null, null, null, '01911000777', 'Shopno');
  if (r->>'needs_approval')::boolean is not true then raise exception 'NOT HELD: %', r; end if;
  insert into pg_temp.p11 values ('held', (r->>'id')::uuid);
  raise notice 'ok: with the setting on, a new claim waits for a manager';
end $$;
select pg_temp.expect_error(
  format($q$select public.set_claim_status('%s', 'diagnosed')$q$,
    (select v from pg_temp.p11 where k='held')), 'CLAIM_NOT_APPROVED');
select pg_temp.check(
  (public.approve_claim((select v from pg_temp.p11 where k='held'), true)->>'approval_status') = 'approved',
  'a manager approves it and the claim can move');
select pg_temp.check(
  (public.set_claim_status((select v from pg_temp.p11 where k='held'), 'diagnosed')->>'status') = 'diagnosed',
  'which it then does');
select public.save_shop_details('{"claim_approval": false}');

-- ---- Rejecting needs a reason ----
select pg_temp.expect_error(
  format($q$select public.set_claim_status('%s', 'rejected')$q$,
    (select v from pg_temp.p11 where k='held')), 'REJECT_REASON_REQUIRED');
select pg_temp.check(
  (public.set_claim_status((select v from pg_temp.p11 where k='held'), 'rejected',
                           'Physical damage, not covered')->>'status') = 'rejected',
  'and with one, the claim closes as rejected');

-- ---- Who may do what ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
-- A cashier takes claims in and can answer "where is my laptop?" — that is the job.
select pg_temp.check(
  jsonb_array_length(public.warranty_lookup('P11SSD000002')) >= 1,
  'a cashier can look a warranty up, because that is who the customer asks');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.claim_list()) x) >= 1,
  'and can see the claims at their branch');
select pg_temp.expect_error($q$select public.save_manual_warranty('{"serial":"X","item_text":"Y"}')$q$, 'NOT_MANAGER');
select pg_temp.expect_error($q$select public.supplier_rma_list()$q$, 'NOT_ALLOWED:view_reports');
select pg_temp.expect_error($q$select public.save_problem_type(null, 'Invented fault')$q$, 'NOT_MANAGER');

-- ===========================================================================
-- 24. OWNER DASHBOARD (P12)
-- ===========================================================================
-- The done-when: today's sales and profit for all branches, switch to one
-- branch, and tap "Profit" to see the sales behind it.
--
-- The thing that has to be right is the PROFIT: it uses the cost as it stood on
-- the day of the sale, not today's cost. Everything else is arithmetic on top.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
create table pg_temp.p12 (k text primary key, v uuid);

-- ---- Buy at 300, sell at 500: 200 of profit ----
-- A brand-new product, so the weighted average cost starts from this delivery and the
-- figures are the figures in the comment rather than whatever the earlier sections left.
do $$
declare r jsonb; prod uuid; branch uuid := '00000000-0000-4000-8000-0000000000b1';
begin
  prod := (public.upsert_product(null, '{"code":"P12-WIDGET","name":"P12 Test Widget",
                                         "price":500,"is_serial":false}')->>'id')::uuid;
  insert into pg_temp.p12 values ('prod', prod);
  perform public.set_prices(prod,
    (select id from public.price_lists where shop_id = '00000000-0000-4000-8000-000000000001'
     and is_default), 500);
  perform public.receive_goods(branch,
    format('[{"product_id":"%s","qty":10,"unit_cost":300}]', prod)::jsonb);
  r := public.complete_sale(branch,
    format('[{"product_id":"%s","qty":2}]', prod)::jsonb,
    'cash', 0, null, null, 1000);
  insert into pg_temp.p12 values ('sale', (r->>'id')::uuid);
  raise notice 'ok: 2 widgets bought at 300, sold at 500';
end $$;
select pg_temp.check(
  (select unit_cost from public.sale_item_costs sc
   join public.sale_items i on i.id = sc.sale_item_id
   where i.sale_id = (select v from pg_temp.p12 where k='sale')) = 300,
  'the cost at the time of sale is captured on the line');

-- ---- The cost MOVING afterwards must not change what today earned ----
-- This is the whole reason the cost is captured rather than looked up.
do $$
declare before_profit numeric; after_profit numeric;
  branch uuid := '00000000-0000-4000-8000-0000000000b1';
begin
  before_profit := (public.dashboard(branch)->'today'->>'profit')::numeric;
  -- The next delivery costs far more, which moves the average cost right up.
  perform public.receive_goods(branch,
    format('[{"product_id":"%s","qty":10,"unit_cost":450}]',
           (select v from pg_temp.p12 where k='prod'))::jsonb);
  after_profit := (public.dashboard(branch)->'today'->>'profit')::numeric;
  if after_profit <> before_profit then
    raise exception 'A LATER DELIVERY CHANGED AN EARLIER SALE''S PROFIT: % then %',
      before_profit, after_profit;
  end if;
  raise notice 'ok: a later, dearer delivery leaves today''s profit exactly where it was';
end $$;

-- ---- The headline numbers ----
do $$
declare d jsonb; branch uuid := '00000000-0000-4000-8000-0000000000b1';
begin
  d := public.dashboard(branch);
  if (d->'today'->>'sale_count')::int < 1 then raise exception 'NO SALES TODAY: %', d->'today'; end if;
  if (d->'today'->>'sales')::numeric <= 0 then raise exception 'NO TAKINGS: %', d->'today'; end if;
  if (d->'today'->>'average_sale')::numeric <> round((d->'today'->>'sales')::numeric
                                                     / (d->'today'->>'sale_count')::int, 2) then
    raise exception 'AVERAGE DOES NOT DIVIDE: %', d->'today';
  end if;
  -- Yesterday and the same day last week are different questions; both are answered.
  if not (d ? 'before') or not (d ? 'week_before') then
    raise exception 'NO COMPARISONS: %', d;
  end if;
  if (d->'before'->>'from')::date <> public.dhaka_today() - 1 then
    raise exception 'WRONG COMPARISON WINDOW: %', d->'before';
  end if;
  if (d->'week_before'->>'from')::date <> public.dhaka_today() - 7 then
    raise exception 'WRONG WEEK WINDOW: %', d->'week_before';
  end if;
  raise notice 'ok: today %, profit %, % sales, average %',
    d->'today'->>'sales', d->'today'->>'profit',
    d->'today'->>'sale_count', d->'today'->>'average_sale';
end $$;

-- ---- All branches, then one branch ----
select pg_temp.check(
  jsonb_array_length(public.dashboard()->'branches') >= 2,
  'with no branch chosen, every branch is listed on its own');
select pg_temp.check(
  (public.dashboard()->'today'->>'sales')::numeric
  >= (public.dashboard(:'BRANCH_A')->'today'->>'sales')::numeric,
  'and the whole business is at least what one branch did');
select pg_temp.check(
  (public.dashboard(:'BRANCH_A')->>'branch') = 'Main branch',
  'picking a branch says which one you are looking at');
select pg_temp.expect_error($q$select public.dashboard(gen_random_uuid())$q$, 'BRANCH_NOT_ALLOWED');
select pg_temp.expect_error(
  format($q$select public.dashboard(null, '%s', '%s')$q$,
    public.dhaka_today(), public.dhaka_today() - 5), 'BAD_DATE_RANGE');

-- ---- Tapping Profit shows the sales behind it ----
do $$
declare rows jsonb; total numeric; branch uuid := '00000000-0000-4000-8000-0000000000b1';
begin
  rows := public.dashboard_detail('profit', branch);
  if jsonb_array_length(rows) < 1 then raise exception 'NOTHING BEHIND THE PROFIT: %', rows; end if;
  select coalesce(sum((x->>'profit')::numeric), 0) into total
    from jsonb_array_elements(rows) x;
  -- The sum of what the individual sales earned IS the headline profit. If those two
  -- disagree, one of them is lying and an owner cannot tell which.
  if total <> (public.dashboard(branch)->'today'->>'profit')::numeric then
    raise exception 'THE DETAIL DOES NOT ADD UP TO THE HEADLINE: % vs %',
      total, (public.dashboard(branch)->'today'->>'profit')::numeric;
  end if;
  raise notice 'ok: the sales behind Profit add up to the Profit figure exactly';
end $$;
select pg_temp.expect_error($q$select public.dashboard_detail('vibes')$q$, 'BAD_DETAIL_KIND');

-- ---- An uncosted line counts as no profit, and says so ----
do $$
declare d jsonb; r jsonb; branch uuid := '00000000-0000-4000-8000-0000000000b1';
begin
  -- Received with no cost on the invoice yet — the "receive now, price later" case (P5).
  perform public.receive_goods(branch,
    '[{"product_id":"00000000-0000-4000-8000-0000000000ab","qty":2}]');
  perform public.set_prices('00000000-0000-4000-8000-0000000000ab',
    (select id from public.price_lists where shop_id = '00000000-0000-4000-8000-000000000001'
     and is_default), 1050);
  r := public.complete_sale(branch,
    '[{"product_id":"00000000-0000-4000-8000-0000000000ab","qty":1}]',
    'cash', 0, null, null, 1100);
  d := public.dashboard(branch);
  if (d->'today'->>'lines_without_cost')::int < 1 then
    raise exception 'AN UNCOSTED LINE WAS NOT FLAGGED: %', d->'today';
  end if;
  raise notice 'ok: a line with no cost counts as no profit and the dashboard says how many';
end $$;

-- ---- The lists ----
select pg_temp.check(
  jsonb_array_length(public.dashboard(:'BRANCH_A')->'best_by_qty') >= 1,
  'the best sellers by quantity are there');
select pg_temp.check(
  jsonb_array_length(public.dashboard(:'BRANCH_A')->'staff') >= 1,
  'and sales per person');
select pg_temp.check(
  (public.dashboard(:'BRANCH_A')->'by_method') ? 'cash',
  'and the split by payment method');
select pg_temp.check(
  jsonb_typeof(public.dashboard(:'BRANCH_A')->'busy_hours') = 'array',
  'and when the shop is busy');
select pg_temp.check(
  (public.dashboard(:'BRANCH_A')->'summary'->>'cash_sales')::numeric > 0,
  'the BMS-style summary row has the cash sales in it');
select pg_temp.check(
  (public.dashboard(:'BRANCH_A')->'summary'->>'credit_sales')::numeric >= 0,
  'and the credit sales');
select pg_temp.check(
  (public.dashboard()->'owed'->>'by_customers')::numeric > 0,
  'and what customers owe shows at the top level');
select pg_temp.check(
  jsonb_typeof(public.dashboard(:'BRANCH_A')->'low_stock') = 'array',
  'low stock is a list');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.dashboard(:'BRANCH_A')->'low_stock') x
   where (x->>'stock')::int > (x->>'reorder_level')::int) = 0,
  'and only has things at or below their re-order level');
select pg_temp.check(
  jsonb_typeof(public.dashboard()->'dusty_stock') = 'array',
  'and so is the money sitting on a shelf');

-- ---- The watch list ----
select pg_temp.check(
  jsonb_array_length(public.dashboard()->'watch') >= 1,
  'the watch list has the things an owner would want to have been told about');
select pg_temp.check(
  (select count(*) from jsonb_array_elements(public.dashboard()->'watch') x
   where x->>'action' in ('discount_approved', 'price_overridden', 'sale_voided',
                          'sale_returned', 'price_set', 'bulk_price_change',
                          'credit_limit_overridden', 'transfer_disputed',
                          'po_price_overridden', 'stock_corrected', 'shift_closed',
                          'cash_out', 'opening_balance_set')) =
  jsonb_array_length(public.dashboard()->'watch'),
  'and nothing else: it is a watch list, not the whole log');

-- ---- Cost stays out of the counter's hands ----
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select pg_temp.expect_error($q$select public.dashboard()$q$, 'NOT_ALLOWED:view_reports');
select pg_temp.expect_error($q$select public.dashboard_detail('profit')$q$, 'NOT_ALLOWED:view_reports');
select pg_temp.check(
  (select count(*) from public.sale_item_costs) = 0,
  'and a cashier cannot read a single captured cost, which is the point of the separate table');

reset role;
\echo ALL DATABASE CHECKS PASSED
