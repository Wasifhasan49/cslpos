-- P13 — Accounts 1: ledger, auto-posting, vouchers, cheques
--
-- DOUBLE ENTRY, IN PLAIN WORDS
-- Every taka is written down twice: once as where it came FROM and once as where it
-- went TO. The two sides are called a debit and a credit, and for any one event they
-- must add up to the same number. Sell a 500-taka cable for cash: cash in hand goes up
-- 500 (a debit) and sales income goes up 500 (a credit). Pay 200 for tea: expenses go up
-- 200 (debit), cash in hand goes down 200 (credit). The point is not ceremony — it is
-- that if the two sides ever disagree, something has been recorded wrong, and the
-- software can say so instead of quietly producing a wrong total.
--
-- WHAT IS DIFFERENT HERE FROM BMS
-- In BMS somebody types the entries. Here every everyday entry POSTS ITSELF, from the
-- document that caused it, in the same transaction as the document. There is no path
-- where a sale happens and the books do not know. The only things anyone types are the
-- entries the shop genuinely has to decide: a journal, a contra, an expense.
--
-- ENTRIES ARE NEVER EDITED
-- A correction is a REVERSING entry: a second entry with the sides swapped, pointing at
-- the first. Editing the past is how books stop matching the documents they came from,
-- and it is the single thing an auditor looks for.
--
-- COGS COMES FROM sale_item_costs
-- The cost of goods sold uses the same captured per-line cost the dashboard's profit
-- uses (P12). If the books and the dashboard disagreed about profit, the owner would
-- have no way to tell which was lying.

-- ---------------------------------------------------------------------------
-- The chart of accounts
-- ---------------------------------------------------------------------------

create table public.account_groups (
  id      uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name    text not null,
  -- The five natures every chart of accounts is built from. Which side of an entry
  -- increases a balance depends on this and nothing else.
  nature  text not null check (nature in ('asset', 'liability', 'equity', 'income', 'expense')),
  sort    integer not null default 0,
  unique (shop_id, name)
);

create table public.accounts (
  id        uuid primary key default gen_random_uuid(),
  shop_id   uuid not null references public.shops(id) on delete cascade,
  group_id  uuid not null references public.account_groups(id) on delete restrict,
  code      text not null,
  name      text not null,
  -- Cash in hand is per branch: one drawer per place, and the done-when is that this
  -- balance matches what was counted. Everything else is shop-wide.
  branch_id uuid references public.branches(id) on delete cascade,
  -- Which real-world thing this account IS, so auto-posting can find it without
  -- matching on names.
  role      text check (role is null or role in (
              'cash_in_hand', 'bank', 'wallet', 'receivable', 'payable', 'inventory',
              'vat_payable', 'sales', 'sales_return', 'cogs', 'discount_given',
              'purchase_return', 'stock_loss', 'stock_gain', 'inter_branch',
              'card_charge', 'opening_equity', 'rounding')),
  -- A bank or wallet account on the books IS one of the shop's bank_accounts rows.
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  active    boolean not null default true,
  created_at timestamptz not null default now(),
  unique (shop_id, code)
);
create index accounts_role_idx on public.accounts(shop_id, role);
create index accounts_branch_idx on public.accounts(branch_id);

-- ---------------------------------------------------------------------------
-- The journal
-- ---------------------------------------------------------------------------

create table public.journal_entries (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  branch_id  uuid not null references public.branches(id),
  entry_no   text not null,
  entry_date date not null default public.dhaka_today(),
  narration  text,
  -- Which document caused it. 'manual' is the only kind a person types.
  source_kind text not null check (source_kind in (
    'sale', 'sale_return', 'sale_void', 'customer_payment', 'supplier_payment',
    'grn', 'supplier_return', 'stock_adjust', 'transfer', 'cash_movement',
    'opening_balance', 'voucher', 'cheque', 'fund_transfer', 'reversal', 'manual')),
  source_id  uuid,
  -- A shop can make vouchers wait for a manager (BMS "Voucher Posting"). Auto-posted
  -- entries are always posted: the money has already moved.
  status     text not null default 'posted'
             check (status in ('posted', 'awaiting_approval', 'cancelled')),
  -- An inter-branch entry only reaches the other branch's books once they accept it
  -- (BMS "Inter BR. Journal Authentication").
  other_branch_id uuid references public.branches(id),
  accepted_at timestamptz,
  accepted_by uuid references public.staff(id),
  reverses_id uuid references public.journal_entries(id) on delete set null,
  staff_id   uuid not null references public.staff(id),
  approved_by uuid references public.staff(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (shop_id, entry_no)
);
create index journal_entries_date_idx on public.journal_entries(shop_id, entry_date desc);
create index journal_entries_branch_idx on public.journal_entries(branch_id, entry_date desc);
create index journal_entries_source_idx on public.journal_entries(source_kind, source_id);

create table public.journal_lines (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references public.journal_entries(id) on delete cascade,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  branch_id  uuid not null references public.branches(id),
  debit      numeric(14,2) not null default 0 check (debit >= 0),
  credit     numeric(14,2) not null default 0 check (credit >= 0),
  -- The sub-ledger: WHOSE receivable, WHOSE payable, WHICH bank account. BMS makes
  -- every party its own account; keeping them as references means a shop with 2,000
  -- customers has one receivables account rather than 2,000 of them.
  customer_id uuid references public.customers(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  note       text,
  -- One side or the other, never both and never neither.
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);
create index journal_lines_entry_idx on public.journal_lines(entry_id);
create index journal_lines_account_idx on public.journal_lines(account_id);
create index journal_lines_customer_idx on public.journal_lines(customer_id);
create index journal_lines_supplier_idx on public.journal_lines(supplier_id);

/**
 * Nothing out of balance may commit.
 *
 * A deferred constraint trigger, because the lines are inserted after the header: the
 * check has to happen at COMMIT, when the entry is whole. This is the one guarantee the
 * whole module rests on, so it is a database constraint rather than a convention.
 */
create or replace function public.journal_must_balance() returns trigger
language plpgsql as $$
declare v_debit numeric(14,2); v_credit numeric(14,2); v_no text;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_debit, v_credit
  from public.journal_lines where entry_id = coalesce(new.id, old.id);

  -- A cancelled entry may legitimately have no lines.
  if v_debit = 0 and v_credit = 0 then return null; end if;
  if v_debit <> v_credit then
    select entry_no into v_no from public.journal_entries where id = coalesce(new.id, old.id);
    raise exception 'ENTRY_DOES_NOT_BALANCE:% (debits %, credits %)',
      coalesce(v_no, '?'), v_debit, v_credit;
  end if;
  return null;
end; $$;

create constraint trigger journal_entries_balance
  after insert or update on public.journal_entries
  deferrable initially deferred
  for each row execute function public.journal_must_balance();

/** The same check when lines are added or changed after the header exists. */
create or replace function public.journal_lines_balance() returns trigger
language plpgsql as $$
declare v_debit numeric(14,2); v_credit numeric(14,2); v_entry uuid;
begin
  v_entry := coalesce(new.entry_id, old.entry_id);
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_debit, v_credit
  from public.journal_lines where entry_id = v_entry;
  if v_debit = 0 and v_credit = 0 then return null; end if;
  if v_debit <> v_credit then
    raise exception 'ENTRY_DOES_NOT_BALANCE:% (debits %, credits %)',
      (select entry_no from public.journal_entries where id = v_entry), v_debit, v_credit;
  end if;
  return null;
end; $$;

create constraint trigger journal_lines_balance
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function public.journal_lines_balance();

-- Per-user account access (BMS "User Wise Ledger Fixing"): an owner can keep one
-- manager out of the salary account without keeping them out of the books.
create table public.staff_accounts (
  staff_id   uuid not null references public.staff(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  allowed    boolean not null default false,
  primary key (staff_id, account_id)
);

/** May this person see this account? Owners always; others unless told otherwise. */
create or replace function public.can_see_account(p_account_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when (select role from public.staff where user_id = auth.uid() and active) = 'owner' then true
    else coalesce((select sa.allowed from public.staff_accounts sa
                   join public.staff s on s.id = sa.staff_id
                   where s.user_id = auth.uid() and sa.account_id = p_account_id), true)
  end;
$$;

-- ---------------------------------------------------------------------------
-- The standard chart for a Bangladeshi trading shop
-- ---------------------------------------------------------------------------

/**
 * Seed a chart a computer shop in Dhaka can actually use on day one.
 *
 * Cash in hand is created per branch, because the done-when of this whole prompt is that
 * a branch's cash ledger equals what that branch counted.
 */
create or replace function public.seed_accounts(p_shop_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g record; v_branch record; v_assets uuid;
begin
  insert into public.account_groups (shop_id, name, nature, sort) values
    (p_shop_id, 'Current assets',      'asset',     1),
    (p_shop_id, 'Fixed assets',        'asset',     2),
    (p_shop_id, 'Current liabilities', 'liability', 3),
    (p_shop_id, 'Capital',             'equity',    4),
    (p_shop_id, 'Income',              'income',    5),
    (p_shop_id, 'Direct costs',        'expense',   6),
    (p_shop_id, 'Overheads',           'expense',   7)
  on conflict (shop_id, name) do nothing;

  select id into v_assets from public.account_groups
    where shop_id = p_shop_id and name = 'Current assets';

  for g in
    select * from (values
      ('1100', 'Bank accounts',          'Current assets',      'bank'),
      ('1150', 'Mobile wallets',         'Current assets',      'wallet'),
      ('1200', 'Money owed by customers','Current assets',      'receivable'),
      ('1300', 'Stock on hand',          'Current assets',      'inventory'),
      ('1900', 'Between branches',       'Current assets',      'inter_branch'),
      ('2100', 'Money owed to suppliers','Current liabilities', 'payable'),
      ('2200', 'VAT payable',            'Current liabilities', 'vat_payable'),
      ('3000', 'Owner''s capital',       'Capital',             'opening_equity'),
      ('4000', 'Sales',                  'Income',              'sales'),
      ('4100', 'Sales returns',          'Income',              'sales_return'),
      ('4200', 'Discounts given',        'Income',              'discount_given'),
      ('5000', 'Cost of goods sold',     'Direct costs',        'cogs'),
      ('5100', 'Purchase returns',       'Direct costs',        'purchase_return'),
      ('5200', 'Stock written off',      'Direct costs',        'stock_loss'),
      ('5300', 'Stock found',            'Direct costs',        'stock_gain'),
      ('5400', 'Card charges',           'Direct costs',        'card_charge'),
      ('6000', 'Rent',                   'Overheads',           null),
      ('6100', 'Electricity',            'Overheads',           null),
      ('6200', 'Staff salaries',         'Overheads',           null),
      ('6300', 'Transport',              'Overheads',           null),
      ('6400', 'Tea and snacks',         'Overheads',           null),
      ('6500', 'Repairs',                'Overheads',           null),
      ('6900', 'Other expenses',         'Overheads',           null),
      ('9000', 'Rounding',               'Overheads',           'rounding')
    ) as t(code, name, grp, role)
  loop
    insert into public.accounts (shop_id, group_id, code, name, role)
    select p_shop_id, ag.id, g.code, g.name, g.role
    from public.account_groups ag
    where ag.shop_id = p_shop_id and ag.name = g.grp
    on conflict (shop_id, code) do nothing;
  end loop;

  -- One cash drawer per branch, numbered 1001, 1002, …
  for v_branch in
    select b.*, row_number() over (order by b.created_at, b.code) as n
    from public.branches b where b.shop_id = p_shop_id
  loop
    insert into public.accounts (shop_id, group_id, code, name, branch_id, role)
    values (p_shop_id, v_assets, '10' || lpad((v_branch.n)::text, 2, '0'),
            'Cash in hand — ' || v_branch.name, v_branch.id, 'cash_in_hand')
    on conflict (shop_id, code) do nothing;
  end loop;
end; $$;

select public.seed_accounts(id) from public.shops;

/** Every branch added from now on gets its own cash drawer on the books. */
create or replace function public.add_branch_cash_account() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_group uuid; v_n integer;
begin
  select id into v_group from public.account_groups
    where shop_id = new.shop_id and name = 'Current assets';
  if v_group is null then return new; end if;
  select count(*) + 1 into v_n from public.accounts
    where shop_id = new.shop_id and role = 'cash_in_hand';
  insert into public.accounts (shop_id, group_id, code, name, branch_id, role)
  values (new.shop_id, v_group, '10' || lpad(v_n::text, 2, '0'),
          'Cash in hand — ' || new.name, new.id, 'cash_in_hand')
  on conflict (shop_id, code) do nothing;
  return new;
end; $$;

create trigger branches_add_cash_account
  after insert on public.branches
  for each row execute function public.add_branch_cash_account();

-- ---------------------------------------------------------------------------
-- The one way an entry is made
-- ---------------------------------------------------------------------------

/** Find an account by the job it does, for this branch where that matters. */
create or replace function public.account_for(
  p_shop_id uuid, p_role text, p_branch_id uuid default null
) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.accounts
  where shop_id = p_shop_id and role = p_role and active
    and (branch_id is null or branch_id = p_branch_id)
  order by (branch_id = p_branch_id) desc nulls last
  limit 1;
$$;

/**
 * Write one journal entry.
 *
 * Every posting in this file goes through here, so there is one place that numbers an
 * entry, one place that writes the lines, and one place to look when an entry is wrong.
 * The balance is guaranteed by the deferred constraint, not by this function trusting
 * its caller.
 */
create or replace function public.post_entry(
  p_shop_id   uuid,
  p_branch_id uuid,
  p_date      date,
  p_narration text,
  p_lines     jsonb,     -- [{ account_id | role, debit | credit, customer_id?, supplier_id?, bank_account_id?, note? }]
  p_source_kind text,
  p_source_id uuid default null,
  p_staff_id  uuid default null,
  p_status    text default 'posted',
  p_other_branch_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid;
  v_no    text;
  v_line  jsonb;
  v_acct  uuid;
  v_staff uuid := p_staff_id;
begin
  if v_staff is null then
    select id into v_staff from public.staff where user_id = auth.uid() and active;
  end if;
  if v_staff is null then raise exception 'NOT_STAFF'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'NOTHING_TO_POST'; end if;

  v_no := public.next_document_number(p_branch_id, 'voucher');
  insert into public.journal_entries (shop_id, branch_id, entry_no, entry_date, narration,
                                      source_kind, source_id, status, staff_id,
                                      other_branch_id)
  values (p_shop_id, p_branch_id, v_no, coalesce(p_date, public.dhaka_today()), p_narration,
          p_source_kind, p_source_id, p_status, v_staff, p_other_branch_id)
  returning id into v_id;

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    v_acct := coalesce((v_line->>'account_id')::uuid,
                       public.account_for(p_shop_id, v_line->>'role',
                                          coalesce((v_line->>'branch_id')::uuid, p_branch_id)));
    if v_acct is null then
      raise exception 'NO_ACCOUNT_FOR:%', coalesce(v_line->>'role', 'that line');
    end if;
    -- A zero line is not an error, it is just nothing: skip it rather than tripping the
    -- "one side or the other" check on a sale that happened to have no VAT.
    if coalesce((v_line->>'debit')::numeric, 0) = 0
       and coalesce((v_line->>'credit')::numeric, 0) = 0 then
      continue;
    end if;
    insert into public.journal_lines (entry_id, shop_id, account_id, branch_id, debit, credit,
                                      customer_id, supplier_id, bank_account_id, note)
    values (v_id, p_shop_id, v_acct,
            coalesce((v_line->>'branch_id')::uuid, p_branch_id),
            round(coalesce((v_line->>'debit')::numeric, 0), 2),
            round(coalesce((v_line->>'credit')::numeric, 0), 2),
            (v_line->>'customer_id')::uuid, (v_line->>'supplier_id')::uuid,
            (v_line->>'bank_account_id')::uuid, v_line->>'note');
  end loop;

  return v_id;
end; $$;

/** Which account a payment method lands in. */
create or replace function public.account_for_method(
  p_shop_id uuid, p_method text, p_branch_id uuid
) returns uuid
language sql stable security definer set search_path = public as $$
  select case p_method
    when 'cash' then public.account_for(p_shop_id, 'cash_in_hand', p_branch_id)
    when 'bkash' then public.account_for(p_shop_id, 'wallet', p_branch_id)
    when 'nagad' then public.account_for(p_shop_id, 'wallet', p_branch_id)
    when 'rocket' then public.account_for(p_shop_id, 'wallet', p_branch_id)
    -- Card and cheque money arrives in a bank, not in the drawer.
    else public.account_for(p_shop_id, 'bank', p_branch_id)
  end;
$$;

-- ---------------------------------------------------------------------------
-- Auto-posting: the books keep themselves
-- ---------------------------------------------------------------------------

/**
 * A completed sale.
 *
 * What the customer paid goes into cash/bank/wallet, what they owe goes to receivables,
 * the goods come off stock and land in cost of goods sold, VAT the shop collected goes
 * to VAT payable, and the discount is recorded as given away rather than as never earned.
 *
 * Fires on UPDATE of total rather than INSERT, because complete_sale() inserts the row
 * with zeros and fills the figures in afterwards — at insert time there is nothing to
 * post. The same reason the approval trigger (P9) works that way.
 */
create or replace function public.post_sale() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_lines jsonb := '[]'::jsonb;
  v_cogs  numeric(14,2);
  v_paid  numeric(14,2);
  v_goods numeric(14,2);
begin
  if not public.feature_on('accounts') then return new; end if;
  if new.status <> 'completed' then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'sale' and source_id = new.id) then
    return new;
  end if;

  v_paid := greatest(coalesce(new.paid_amount, new.total), 0);
  -- What the goods themselves earned, before VAT and charges: that is what "sales" means.
  v_goods := new.total - coalesce(new.vat_amount, 0) - coalesce(new.charges_amount, 0)
             - coalesce(new.card_charge, 0) - coalesce(new.emi_charge, 0);

  -- Money in, by however it arrived.
  if v_paid > 0 then
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.account_for_method(new.shop_id, new.payment_method, new.branch_id),
      'debit', v_paid, 'note', 'Paid on ' || new.invoice_no);
  end if;
  -- And what is still owed, against that customer.
  if coalesce(new.due_amount, 0) > 0 then
    v_lines := v_lines || jsonb_build_object(
      'role', 'receivable', 'debit', new.due_amount,
      'customer_id', new.customer_id, 'note', 'On due from ' || new.invoice_no);
  end if;
  -- The discount is money the shop chose to give away, not income it never had.
  if coalesce(new.discount_amount, 0) > 0 then
    v_lines := v_lines || jsonb_build_object(
      'role', 'discount_given', 'debit', new.discount_amount,
      'note', 'Discount on ' || new.invoice_no);
  end if;

  v_lines := v_lines || jsonb_build_object(
    'role', 'sales', 'credit', v_goods + coalesce(new.discount_amount, 0),
    'note', new.invoice_no);
  if coalesce(new.vat_amount, 0) > 0 then
    v_lines := v_lines || jsonb_build_object(
      'role', 'vat_payable', 'credit', new.vat_amount, 'note', 'VAT on ' || new.invoice_no);
  end if;
  if coalesce(new.charges_amount, 0) + coalesce(new.card_charge, 0)
     + coalesce(new.emi_charge, 0) > 0 then
    v_lines := v_lines || jsonb_build_object(
      'role', 'sales', 'credit', coalesce(new.charges_amount, 0) + coalesce(new.card_charge, 0)
                                 + coalesce(new.emi_charge, 0),
      'note', 'Charges on ' || new.invoice_no);
  end if;

  perform public.post_entry(new.shop_id, new.branch_id,
    (new.created_at at time zone 'Asia/Dhaka')::date,
    'Sale ' || new.invoice_no, v_lines, 'sale', new.id, new.staff_id);

  -- The goods leaving the shelf is its own event: stock down, cost of sales up. It uses
  -- the SAME captured cost the dashboard's profit uses, so the two cannot disagree.
  select coalesce(sum(c.unit_cost * i.qty), 0) into v_cogs
  from public.sale_items i
  join public.sale_item_costs c on c.sale_item_id = i.id
  where i.sale_id = new.id;

  if v_cogs > 0 then
    perform public.post_entry(new.shop_id, new.branch_id,
      (new.created_at at time zone 'Asia/Dhaka')::date,
      'Cost of goods on ' || new.invoice_no,
      jsonb_build_array(
        jsonb_build_object('role', 'cogs', 'debit', v_cogs),
        jsonb_build_object('role', 'inventory', 'credit', v_cogs)),
      'sale', new.id, new.staff_id);
  end if;

  return new;
end; $$;

create trigger sales_post_to_accounts
  after update of total on public.sales
  for each row when (new.status = 'completed' and new.total > 0)
  execute function public.post_sale();

/** Money taken off a customer's due. */
create or replace function public.post_customer_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.feature_on('accounts') then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'customer_payment' and source_id = new.id) then
    return new;
  end if;
  perform public.post_entry(new.shop_id, new.branch_id,
    (new.created_at at time zone 'Asia/Dhaka')::date,
    'Received on ' || new.receipt_no,
    jsonb_build_array(
      jsonb_build_object('account_id',
        coalesce(public.account_for_method(new.shop_id, new.method, new.branch_id)),
        'debit', new.amount, 'bank_account_id', new.account_id),
      jsonb_build_object('role', 'receivable', 'credit', new.amount,
                         'customer_id', new.customer_id)),
    'customer_payment', new.id, new.staff_id);
  return new;
end; $$;

create trigger customer_payments_post
  -- `or update` so the back-fill can re-run this posting; the already-posted
  -- guard above is what makes re-running it harmless.
  after insert or update on public.customer_payments
  for each row execute function public.post_customer_payment();

/** Money paid to a supplier. */
create or replace function public.post_supplier_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Paid in cash it came out of the till, exactly like a cash purchase, and P8's count
  -- has to expect it gone. `expected_cash()` already sums the drawer's movements, so one
  -- row there is all it takes — and this runs whether or not the shop keeps accounts.
  if new.method = 'cash' and not exists (
       select 1 from public.cash_movements
       where source_kind = 'supplier_payment' and source_id = new.id) then
    insert into public.cash_movements (shop_id, branch_id, shift_id, direction, amount,
                                       reason, note, staff_id, source_kind, source_id)
    values (new.shop_id, new.branch_id,
            (select id from public.shifts where branch_id = new.branch_id
               and closed_at is null order by opened_at desc limit 1),
            'out', new.amount, 'other',
            'Paid ' || coalesce((select name from public.suppliers where id = new.supplier_id),
                                'a supplier'),
            new.staff_id, 'supplier_payment', new.id);
  end if;

  if not public.feature_on('accounts') then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'supplier_payment' and source_id = new.id) then
    return new;
  end if;
  perform public.post_entry(new.shop_id, new.branch_id, new.paid_on,
    'Paid to supplier',
    jsonb_build_array(
      jsonb_build_object('role', 'payable', 'debit', new.amount,
                         'supplier_id', new.supplier_id),
      jsonb_build_object('account_id',
        public.account_for_method(new.shop_id, new.method, new.branch_id),
        'credit', new.amount)),
    'supplier_payment', new.id, new.staff_id);
  return new;
end; $$;

create trigger supplier_payments_post
  -- `or update` so the back-fill can re-run this posting; the already-posted
  -- guard above is what makes re-running it harmless.
  after insert or update on public.supplier_payments
  for each row execute function public.post_supplier_payment();

-- A purchase paid for on the spot comes out of the till, so the till has to know about
-- it: otherwise the books say the cash went and the drawer still expects it, and the
-- cashier is short by the price of the delivery at closing time. The movement carries
-- the document it came from, and `post_cash_movement` leaves those alone — the GRN's own
-- entry already records the cash side, and posting it twice would halve the drawer.
alter table public.cash_movements
  add column source_kind text,
  add column source_id   uuid;

/** Goods arriving: stock up, and either cash down or a supplier owed. */
create or replace function public.post_grn() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_lines jsonb;
begin
  if coalesce(new.total, 0) = 0 then return new; end if;

  -- Paid on the spot: take it out of the open drawer, so the count at closing time
  -- expects the money to be gone. This happens whether or not the shop keeps accounts —
  -- the drawer is short either way. It posts nothing of its own (see above).
  if not new.is_credit and not exists (
       select 1 from public.cash_movements
       where source_kind = 'grn' and source_id = new.id) then
    insert into public.cash_movements (shop_id, branch_id, shift_id, direction, amount,
                                       reason, note, staff_id, source_kind, source_id)
    values (new.shop_id, new.branch_id,
            (select id from public.shifts where branch_id = new.branch_id
               and closed_at is null order by opened_at desc limit 1),
            'out', new.total, 'other', 'Paid for ' || new.grn_no, new.staff_id,
            'grn', new.id);
  end if;

  if not public.feature_on('accounts') then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'grn' and source_id = new.id) then
    return new;
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('role', 'inventory', 'debit', new.total, 'note', new.grn_no));
  if new.is_credit then
    v_lines := v_lines || jsonb_build_object('role', 'payable', 'credit', new.total,
                                             'supplier_id', new.supplier_id);
  else
    v_lines := v_lines || jsonb_build_object(
      'role', 'cash_in_hand', 'credit', new.total, 'note', 'Paid for ' || new.grn_no);
  end if;

  perform public.post_entry(new.shop_id, new.branch_id,
    (new.created_at at time zone 'Asia/Dhaka')::date,
    'Goods received ' || new.grn_no, v_lines, 'grn', new.id, new.staff_id);
  return new;
end; $$;

-- Named for what it does now: the drawer part runs even with the accounts feature off.
create trigger grns_post
  after update of total on public.grns
  for each row when (new.total > 0)
  execute function public.post_grn();

/** Goods going back to a supplier. */
create or replace function public.post_supplier_return() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.feature_on('accounts') then return new; end if;
  if coalesce(new.total, 0) = 0 then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'supplier_return' and source_id = new.id) then
    return new;
  end if;
  perform public.post_entry(new.shop_id, new.branch_id,
    (new.created_at at time zone 'Asia/Dhaka')::date,
    'Returned to supplier ' || new.return_no,
    jsonb_build_array(
      jsonb_build_object('role', 'payable', 'debit', new.total,
                         'supplier_id', new.supplier_id),
      jsonb_build_object('role', 'inventory', 'credit', new.total, 'note', new.return_no)),
    'supplier_return', new.id, new.staff_id);
  return new;
end; $$;

create trigger supplier_returns_post
  after update of total on public.supplier_returns
  for each row when (new.total > 0)
  execute function public.post_supplier_return();

/** A customer bringing something back. */
create or replace function public.post_sale_return() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_lines jsonb; v_cogs numeric(14,2);
begin
  if not public.feature_on('accounts') then return new; end if;
  if coalesce(new.total, 0) = 0 then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'sale_return' and source_id = new.id) then
    return new;
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('role', 'sales_return', 'debit', new.total, 'note', new.return_no));
  if new.refund_method in ('reduce_due', 'store_credit') then
    -- Nothing left the drawer: the customer simply owes less.
    v_lines := v_lines || jsonb_build_object('role', 'receivable', 'credit', new.total,
                                             'customer_id', new.customer_id);
  else
    v_lines := v_lines || jsonb_build_object(
      'account_id', public.account_for_method(new.shop_id, new.refund_method, new.branch_id),
      'credit', new.total, 'note', 'Refunded on ' || new.return_no);
  end if;

  perform public.post_entry(new.shop_id, new.branch_id,
    (new.created_at at time zone 'Asia/Dhaka')::date,
    'Return ' || new.return_no, v_lines, 'sale_return', new.id, new.staff_id);

  -- Sound goods go back on the shelf, so stock goes up and cost of sales comes back
  -- down. Faulty ones do not: they never reach a shelf (P9).
  select coalesce(sum(c.unit_cost * ri.qty), 0) into v_cogs
  from public.sale_return_items ri
  join public.sale_item_costs c on c.sale_item_id = ri.sale_item_id
  where ri.return_id = new.id and not ri.is_faulty;

  if v_cogs > 0 then
    perform public.post_entry(new.shop_id, new.branch_id,
      (new.created_at at time zone 'Asia/Dhaka')::date,
      'Stock back from ' || new.return_no,
      jsonb_build_array(
        jsonb_build_object('role', 'inventory', 'debit', v_cogs),
        jsonb_build_object('role', 'cogs', 'credit', v_cogs)),
      'sale_return', new.id, new.staff_id);
  end if;
  return new;
end; $$;

create trigger sale_returns_post
  after update of total on public.sale_returns
  for each row when (new.total > 0)
  execute function public.post_sale_return();

/** Cash leaving or entering the drawer for something other than a sale. */
create or replace function public.post_cash_movement() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_expense uuid; v_cash uuid;
begin
  if not public.feature_on('accounts') then return new; end if;
  -- A movement that belongs to another document (a cash purchase, say) is only here so
  -- the drawer adds up; that document's own entry has already recorded the money.
  if new.source_kind is not null then return new; end if;
  if exists (select 1 from public.journal_entries
             where source_kind = 'cash_movement' and source_id = new.id) then
    return new;
  end if;
  v_cash := public.account_for(new.shop_id, 'cash_in_hand', new.branch_id);

  -- An expense goes to the account the shop named for it, when it has one; otherwise to
  -- Other expenses, which is honest rather than silently miscategorised.
  select a.id into v_expense from public.accounts a
  join public.transaction_categories tc on tc.id = new.category_id
  where a.shop_id = new.shop_id and a.active and lower(a.name) = lower(tc.name);
  if v_expense is null then
    select id into v_expense from public.accounts
      where shop_id = new.shop_id and code = '6900';
  end if;

  if new.direction = 'out' then
    perform public.post_entry(new.shop_id, new.branch_id,
      (new.created_at at time zone 'Asia/Dhaka')::date,
      coalesce(new.note, 'Cash out'),
      jsonb_build_array(
        jsonb_build_object('account_id',
          case when new.reason = 'bank_deposit' then public.account_for(new.shop_id, 'bank', new.branch_id)
               when new.reason = 'owner_took' then public.account_for(new.shop_id, 'opening_equity', new.branch_id)
               else v_expense end,
          'debit', new.amount),
        jsonb_build_object('account_id', v_cash, 'credit', new.amount)),
      'cash_movement', new.id, new.staff_id);
  else
    perform public.post_entry(new.shop_id, new.branch_id,
      (new.created_at at time zone 'Asia/Dhaka')::date,
      coalesce(new.note, 'Cash in'),
      jsonb_build_array(
        jsonb_build_object('account_id', v_cash, 'debit', new.amount),
        jsonb_build_object('account_id',
          case when new.reason = 'owner_put_in' then public.account_for(new.shop_id, 'opening_equity', new.branch_id)
               else public.account_for(new.shop_id, 'bank', new.branch_id) end,
          'credit', new.amount)),
      'cash_movement', new.id, new.staff_id);
  end if;
  return new;
end; $$;

create trigger cash_movements_post
  -- `or update` so the back-fill can re-run this posting; the already-posted
  -- guard above is what makes re-running it harmless.
  after insert or update on public.cash_movements
  for each row execute function public.post_cash_movement();

-- ---------------------------------------------------------------------------
-- The entries a person actually types
-- ---------------------------------------------------------------------------

alter table public.shops
  -- BMS "Voucher Posting": a shop can make typed vouchers wait for a manager.
  add column voucher_approval boolean not null default false;

alter table public.journal_entries
  -- An inter-branch entry is either money ('fund') or a bill one branch paid for another
  -- ('cost'), and which one it is decides what the receiving branch is charged when they
  -- accept it.
  add column inter_kind       text check (inter_kind is null or inter_kind in ('fund', 'cost')),
  add column inter_account_id uuid references public.accounts(id);

/**
 * A voucher: the four kinds BMS has, as one function.
 *
 *  receipt  — money came in from somewhere other than a sale
 *  payment  — money went out for something other than a purchase
 *  contra   — money moved between the shop's own pockets (cash ↔ bank)
 *  journal  — anything else, with the lines typed out
 *
 * They are all the same thing underneath: a balanced entry. Separate menus for each,
 * as BMS has, is four screens for one idea.
 */
create or replace function public.save_voucher(
  p_kind      text,
  p_branch_id uuid,
  p_date      date,
  p_narration text,
  -- receipt/payment/contra: the two accounts and the amount.
  p_amount    numeric default null,
  p_from_account uuid default null,
  p_to_account   uuid default null,
  p_customer_id  uuid default null,
  p_supplier_id  uuid default null,
  -- journal: the lines, typed.
  p_lines     jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_shop  public.shops;
  v_id    uuid;
  v_lines jsonb;
  v_status text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('accounts') then raise exception 'FEATURE_OFF:accounts'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_kind not in ('receipt', 'payment', 'contra', 'journal') then
    raise exception 'BAD_VOUCHER_KIND:%', p_kind;
  end if;
  select * into v_shop from public.shops where id = v_me.shop_id;

  if p_kind = 'journal' then
    if p_lines is null or jsonb_array_length(p_lines) < 2 then
      raise exception 'JOURNAL_NEEDS_TWO_LINES';
    end if;
    v_lines := p_lines;
  else
    if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_PAYMENT_AMOUNT'; end if;
    if p_from_account is null or p_to_account is null then raise exception 'VOUCHER_NEEDS_TWO_ACCOUNTS'; end if;
    if p_from_account = p_to_account then raise exception 'VOUCHER_SAME_ACCOUNT'; end if;
    -- Money leaves the "from" account and arrives in the "to" account. Which of those
    -- is a debit depends on nothing but that.
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', p_to_account, 'debit', p_amount,
                         'customer_id', p_customer_id, 'supplier_id', p_supplier_id),
      jsonb_build_object('account_id', p_from_account, 'credit', p_amount,
                         'customer_id', p_customer_id, 'supplier_id', p_supplier_id));
  end if;

  -- A typed voucher can be made to wait; an auto-posted entry never is, because the
  -- money has already moved.
  v_status := case when v_shop.voucher_approval and not public.is_manager()
                   then 'awaiting_approval' else 'posted' end;

  v_id := public.post_entry(v_me.shop_id, p_branch_id, p_date,
    coalesce(p_narration, initcap(p_kind) || ' voucher'), v_lines, 'voucher', null,
    v_me.id, v_status);

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'voucher_' || p_kind, 'journal_entry', v_id,
          jsonb_build_object('narration', p_narration, 'amount', p_amount,
                             'status', v_status));

  return jsonb_build_object(
    'id', v_id, 'kind', p_kind, 'status', v_status,
    'entry_no', (select entry_no from public.journal_entries where id = v_id));
end; $$;

/** A manager posts or cancels a waiting voucher. */
create or replace function public.approve_voucher(
  p_entry_id uuid, p_approve boolean, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_entry public.journal_entries;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('approve') then raise exception 'NOT_ALLOWED:approve'; end if;
  select * into v_entry from public.journal_entries
    where id = p_entry_id and shop_id = v_me.shop_id;
  if not found then raise exception 'ENTRY_NOT_FOUND'; end if;
  if v_entry.status <> 'awaiting_approval' then
    raise exception 'NOT_AWAITING_APPROVAL:%', v_entry.status;
  end if;
  if not p_approve and coalesce(btrim(coalesce(p_reason, '')), '') = '' then
    raise exception 'CANCEL_REASON_REQUIRED';
  end if;

  update public.journal_entries set
    status = case when p_approve then 'posted' else 'cancelled' end,
    approved_by = v_me.id, approved_at = now(),
    narration = case when p_approve then narration
                     else coalesce(narration || ' · ', '') || 'Cancelled: ' || p_reason end
  where id = p_entry_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_entry.branch_id, v_me.id,
          case when p_approve then 'voucher_approved' else 'voucher_cancelled' end,
          'journal_entry', p_entry_id,
          jsonb_build_object('entry_no', v_entry.entry_no, 'reason', p_reason));

  return jsonb_build_object('entry_no', v_entry.entry_no,
                            'status', case when p_approve then 'posted' else 'cancelled' end);
end; $$;

/**
 * Undo an entry by writing its mirror image.
 *
 * The original stays exactly as it was. Editing the past is how books stop matching the
 * documents they came from, and it is the first thing an auditor looks for.
 */
create or replace function public.reverse_entry(p_entry_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_entry public.journal_entries; v_lines jsonb; v_new uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  if not public.is_manager() then raise exception 'NOT_MANAGER'; end if;
  if coalesce(btrim(coalesce(p_reason, '')), '') = '' then raise exception 'REASON_REQUIRED'; end if;

  select * into v_entry from public.journal_entries
    where id = p_entry_id and shop_id = v_me.shop_id;
  if not found then raise exception 'ENTRY_NOT_FOUND'; end if;
  if v_entry.status <> 'posted' then raise exception 'ENTRY_NOT_POSTED:%', v_entry.status; end if;
  if exists (select 1 from public.journal_entries where reverses_id = p_entry_id) then
    raise exception 'ALREADY_REVERSED';
  end if;

  -- The same lines with the sides swapped, which is what "undo" means in double entry.
  select jsonb_agg(jsonb_build_object(
           'account_id', l.account_id, 'branch_id', l.branch_id,
           'debit', l.credit, 'credit', l.debit,
           'customer_id', l.customer_id, 'supplier_id', l.supplier_id,
           'bank_account_id', l.bank_account_id,
           'note', 'Reversal of ' || v_entry.entry_no))
    into v_lines
  from public.journal_lines l where l.entry_id = p_entry_id;

  v_new := public.post_entry(v_me.shop_id, v_entry.branch_id, public.dhaka_today(),
    'Reversal of ' || v_entry.entry_no || ': ' || p_reason,
    v_lines, 'reversal', p_entry_id, v_me.id);

  update public.journal_entries set reverses_id = p_entry_id where id = v_new;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_entry.branch_id, v_me.id, 'entry_reversed', 'journal_entry', p_entry_id,
          jsonb_build_object('entry_no', v_entry.entry_no, 'reason', p_reason,
                             'reversal_no', (select entry_no from public.journal_entries where id = v_new)));

  return jsonb_build_object('reversed', v_entry.entry_no,
                            'entry_no', (select entry_no from public.journal_entries where id = v_new));
end; $$;

-- ---------------------------------------------------------------------------
-- Between branches
-- ---------------------------------------------------------------------------

/**
 * One branch pays for another, or sends it money.
 *
 * The sending branch's side posts at once — their cash really has gone. The receiving
 * branch's side waits until they ACCEPT it (BMS "Inter BR. Journal Authentication"),
 * because a branch should not find money or a cost in its books that it never agreed to.
 */
create or replace function public.inter_branch_entry(
  p_from_branch uuid,
  p_to_branch   uuid,
  p_amount      numeric,
  p_narration   text,
  -- 'fund' moves money; 'cost' is one branch paying an expense for another.
  p_kind        text default 'fund',
  -- Where the money left from on the sending side (their drawer, by default).
  p_from_account uuid default null,
  -- For a 'cost', the account the RECEIVING branch should be charged — the courier bill,
  -- the electricity. Without it an expense one branch paid for another would land in the
  -- other branch's cash book as if they had been handed the money.
  p_to_account   uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_id uuid; v_from uuid; v_to uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('accounts') then raise exception 'FEATURE_OFF:accounts'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  if not public.can_use_branch(p_from_branch) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_from_branch = p_to_branch then raise exception 'SAME_BRANCH'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_PAYMENT_AMOUNT'; end if;
  if p_kind not in ('fund', 'cost') then raise exception 'BAD_VOUCHER_KIND:%', p_kind; end if;
  if not exists (select 1 from public.branches
                 where id = p_to_branch and shop_id = v_me.shop_id and active) then
    raise exception 'BRANCH_NOT_FOUND';
  end if;

  v_from := coalesce(p_from_account,
                     public.account_for(v_me.shop_id, 'cash_in_hand', p_from_branch));
  -- The sender's side is always the same whichever kind it is: money out, and the other
  -- branch owing it. What differs is what the OTHER branch is charged when they accept.
  v_to := public.account_for(v_me.shop_id, 'inter_branch', p_from_branch);

  -- The sending side, now: their money has left.
  v_id := public.post_entry(v_me.shop_id, p_from_branch, public.dhaka_today(),
    coalesce(p_narration, 'Sent to another branch'),
    jsonb_build_array(
      jsonb_build_object('account_id', v_to, 'debit', p_amount,
                         'note', 'Owed by the other branch'),
      jsonb_build_object('account_id', v_from, 'credit', p_amount)),
    'fund_transfer', null, v_me.id, 'posted', p_to_branch);

  update public.journal_entries set inter_kind = p_kind, inter_account_id = p_to_account
    where id = v_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_from_branch, v_me.id, 'inter_branch_sent', 'journal_entry', v_id,
          jsonb_build_object('to', (select name from public.branches where id = p_to_branch),
                             'amount', p_amount, 'kind', p_kind));

  return jsonb_build_object('id', v_id, 'amount', p_amount,
                            'entry_no', (select entry_no from public.journal_entries where id = v_id),
                            'waiting_on', (select name from public.branches where id = p_to_branch));
end; $$;

/** The receiving branch agrees, and only then does it reach their books. */
create or replace function public.accept_inter_branch(p_entry_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_entry public.journal_entries; v_amount numeric(14,2); v_new uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;

  select * into v_entry from public.journal_entries
    where id = p_entry_id and shop_id = v_me.shop_id;
  if not found then raise exception 'ENTRY_NOT_FOUND'; end if;
  if v_entry.other_branch_id is null then raise exception 'NOT_INTER_BRANCH'; end if;
  if v_entry.accepted_at is not null then raise exception 'ALREADY_ACCEPTED'; end if;
  -- Only the branch being sent to can agree to it.
  if not public.can_use_branch(v_entry.other_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;

  select coalesce(sum(debit), 0) into v_amount from public.journal_lines
    where entry_id = p_entry_id;

  -- Money sent is money received; a cost paid on their behalf is their expense, not
  -- cash they can count. The sender said which it was.
  v_new := public.post_entry(v_me.shop_id, v_entry.other_branch_id, public.dhaka_today(),
    'Received from ' || (select name from public.branches where id = v_entry.branch_id),
    jsonb_build_array(
      jsonb_build_object('account_id',
        coalesce(v_entry.inter_account_id,
                 public.account_for(v_me.shop_id, 'cash_in_hand', v_entry.other_branch_id)),
        'debit', v_amount, 'branch_id', v_entry.other_branch_id),
      jsonb_build_object('role', 'inter_branch', 'credit', v_amount,
                         'note', 'Settled with ' || v_entry.entry_no)),
    'fund_transfer', p_entry_id, v_me.id);

  update public.journal_entries set accepted_at = now(), accepted_by = v_me.id
    where id = p_entry_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_entry.other_branch_id, v_me.id, 'inter_branch_accepted',
          'journal_entry', p_entry_id,
          jsonb_build_object('entry_no', v_entry.entry_no, 'amount', v_amount));

  return jsonb_build_object('accepted', v_entry.entry_no, 'amount', v_amount,
                            'entry_no', (select entry_no from public.journal_entries where id = v_new));
end; $$;

-- ---------------------------------------------------------------------------
-- Cheques
-- ---------------------------------------------------------------------------

create table public.cheque_books (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  prefix          text,
  first_number    integer not null check (first_number > 0),
  last_number     integer not null check (last_number > 0),
  next_number     integer not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  check (last_number >= first_number)
);

create table public.cheques (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  branch_id       uuid not null references public.branches(id),
  -- Issued: we wrote it. Received: somebody gave us one.
  direction       text not null check (direction in ('issued', 'received')),
  cheque_no       text not null,
  book_id         uuid references public.cheque_books(id) on delete set null,
  bank_account_id uuid references public.bank_accounts(id),
  -- The bank it is drawn on, for a cheque somebody handed us.
  drawn_on        text,
  payee           text,
  customer_id     uuid references public.customers(id) on delete set null,
  supplier_id     uuid references public.suppliers(id) on delete set null,
  amount          numeric(14,2) not null check (amount > 0),
  cheque_date     date not null,
  status          text not null default 'issued'
                  check (status in ('issued', 'cleared', 'bounced', 'cancelled')),
  cleared_at      timestamptz,
  bounced_reason  text,
  -- The entry this cheque caused, so bouncing it can reverse exactly that.
  entry_id        uuid references public.journal_entries(id) on delete set null,
  note            text,
  staff_id        uuid not null references public.staff(id),
  created_at      timestamptz not null default now(),
  unique (shop_id, direction, cheque_no)
);
create index cheques_status_idx on public.cheques(shop_id, status);
create index cheques_date_idx on public.cheques(shop_id, cheque_date);

/** Set up a cheque book for one bank account. */
create or replace function public.save_cheque_book(
  p_bank_account_id uuid, p_first integer, p_last integer, p_prefix text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row public.cheque_books;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  if coalesce(p_last, 0) < coalesce(p_first, 0) or coalesce(p_first, 0) <= 0 then
    raise exception 'BAD_CHEQUE_RANGE';
  end if;
  if not exists (select 1 from public.bank_accounts
                 where id = p_bank_account_id and shop_id = v_me.shop_id) then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  insert into public.cheque_books (shop_id, bank_account_id, prefix, first_number,
                                   last_number, next_number)
  values (v_me.shop_id, p_bank_account_id, nullif(btrim(coalesce(p_prefix, '')), ''),
          p_first, p_last, p_first)
  returning * into v_row;
  return to_jsonb(v_row);
end; $$;

/**
 * Write a cheque, or record one somebody gave us.
 *
 * A cheque is a promise, not money: it posts to the party's account now and only moves
 * the bank balance when it CLEARS. Treating it as cash on the day it is written is how
 * a bank balance ends up wrong for a fortnight.
 */
create or replace function public.save_cheque(
  p_branch_id   uuid,
  p_direction   text,
  p_amount      numeric,
  p_cheque_date date,
  p_cheque_no   text default null,
  p_book_id     uuid default null,
  p_bank_account_id uuid default null,
  p_payee       text default null,
  p_customer_id uuid default null,
  p_supplier_id uuid default null,
  p_drawn_on    text default null,
  p_note        text default null,
  -- A payment already recorded through P6/P10 that THIS cheque is how it was paid.
  -- The cheque then takes that payment's entry as its own rather than posting a second
  -- one, which is what makes bouncing it reverse the right entry instead of inventing a
  -- mirror of it. Paying a supplier by cheque posts once, not twice.
  p_supplier_payment_id uuid default null,
  p_customer_payment_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me   public.staff;
  v_no   text := nullif(btrim(coalesce(p_cheque_no, '')), '');
  v_book public.cheque_books;
  v_id   uuid;
  v_entry uuid;
  v_bank uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('accounts') then raise exception 'FEATURE_OFF:accounts'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if p_direction not in ('issued', 'received') then raise exception 'BAD_CHEQUE_DIRECTION:%', p_direction; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_PAYMENT_AMOUNT'; end if;
  if p_direction = 'issued' and p_supplier_id is null and coalesce(btrim(coalesce(p_payee, '')), '') = '' then
    raise exception 'CHEQUE_NEEDS_PAYEE';
  end if;

  -- A cheque we write comes off a book, so the leaf numbers follow the real chequebook.
  if p_direction = 'issued' and v_no is null then
    if p_book_id is null then raise exception 'CHEQUE_NEEDS_NUMBER'; end if;
    select * into v_book from public.cheque_books
      where id = p_book_id and shop_id = v_me.shop_id and active for update;
    if not found then raise exception 'CHEQUE_BOOK_NOT_FOUND'; end if;
    if v_book.next_number > v_book.last_number then raise exception 'CHEQUE_BOOK_FINISHED'; end if;
    v_no := coalesce(v_book.prefix, '') || v_book.next_number::text;
    update public.cheque_books set next_number = next_number + 1 where id = p_book_id;
  end if;
  if v_no is null then raise exception 'CHEQUE_NEEDS_NUMBER'; end if;

  v_bank := coalesce(p_bank_account_id, v_book.bank_account_id);

  insert into public.cheques (shop_id, branch_id, direction, cheque_no, book_id,
                              bank_account_id, drawn_on, payee, customer_id, supplier_id,
                              amount, cheque_date, note, staff_id)
  values (v_me.shop_id, p_branch_id, p_direction, v_no, p_book_id, v_bank,
          p_drawn_on, p_payee, p_customer_id, p_supplier_id, p_amount, p_cheque_date,
          p_note, v_me.id)
  returning id into v_id;

  -- The promise, posted against the party. The bank moves on clearing, not now.
  if p_supplier_payment_id is not null or p_customer_payment_id is not null then
    select id into v_entry from public.journal_entries
      where shop_id = v_me.shop_id and status = 'posted'
        and source_kind = case when p_supplier_payment_id is not null
                               then 'supplier_payment' else 'customer_payment' end
        and source_id = coalesce(p_supplier_payment_id, p_customer_payment_id);
  elsif p_direction = 'issued' and p_supplier_id is not null then
    v_entry := public.post_entry(v_me.shop_id, p_branch_id, p_cheque_date,
      'Cheque ' || v_no || ' to supplier',
      jsonb_build_array(
        jsonb_build_object('role', 'payable', 'debit', p_amount, 'supplier_id', p_supplier_id),
        jsonb_build_object('role', 'bank', 'credit', p_amount, 'bank_account_id', v_bank,
                           'note', 'Cheque ' || v_no)),
      'cheque', v_id, v_me.id);
  elsif p_direction = 'received' and p_customer_id is not null then
    v_entry := public.post_entry(v_me.shop_id, p_branch_id, p_cheque_date,
      'Cheque ' || v_no || ' from customer',
      jsonb_build_array(
        jsonb_build_object('role', 'bank', 'debit', p_amount, 'bank_account_id', v_bank,
                           'note', 'Cheque ' || v_no),
        jsonb_build_object('role', 'receivable', 'credit', p_amount, 'customer_id', p_customer_id)),
      'cheque', v_id, v_me.id);
  end if;

  if v_entry is not null then
    update public.cheques set entry_id = v_entry where id = v_id;
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'cheque_' || p_direction, 'cheque', v_id,
          jsonb_build_object('cheque_no', v_no, 'amount', p_amount, 'date', p_cheque_date,
                             'payee', p_payee));

  return jsonb_build_object('id', v_id, 'cheque_no', v_no, 'amount', p_amount,
                            'status', 'issued');
end; $$;

/**
 * What happened to a cheque.
 *
 * A bounced cheque REVERSES its own entry: the money never arrived, so the books must
 * stop saying it did, and the customer goes back to owing it. That is the whole reason
 * the entry id is kept on the cheque.
 */
create or replace function public.set_cheque_status(
  p_cheque_id uuid, p_status text, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_cq public.cheques;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  select * into v_cq from public.cheques where id = p_cheque_id and shop_id = v_me.shop_id for update;
  if not found then raise exception 'CHEQUE_NOT_FOUND'; end if;
  if v_cq.status <> 'issued' then raise exception 'CHEQUE_ALREADY_SETTLED:%', v_cq.status; end if;
  if p_status not in ('cleared', 'bounced', 'cancelled') then
    raise exception 'BAD_CHEQUE_STATUS:%', p_status;
  end if;
  if p_status = 'bounced' and coalesce(btrim(coalesce(p_reason, '')), '') = '' then
    raise exception 'BOUNCE_REASON_REQUIRED';
  end if;

  update public.cheques set
    status = p_status,
    cleared_at = case when p_status = 'cleared' then now() end,
    bounced_reason = case when p_status = 'bounced' then p_reason end
  where id = p_cheque_id;

  if p_status in ('bounced', 'cancelled') and v_cq.entry_id is not null then
    perform public.reverse_entry(v_cq.entry_id,
      case when p_status = 'bounced' then 'Cheque ' || v_cq.cheque_no || ' bounced: ' || p_reason
           else 'Cheque ' || v_cq.cheque_no || ' cancelled' end);
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_cq.branch_id, v_me.id, 'cheque_' || p_status, 'cheque', p_cheque_id,
          jsonb_build_object('cheque_no', v_cq.cheque_no, 'amount', v_cq.amount,
                             'reason', p_reason,
                             'customer', (select coalesce(name_text, phone) from public.customers
                                          where id = v_cq.customer_id),
                             'supplier', (select name from public.suppliers where id = v_cq.supplier_id)));

  return jsonb_build_object('cheque_no', v_cq.cheque_no, 'status', p_status,
                            'reversed', p_status in ('bounced', 'cancelled'));
end; $$;

-- ---------------------------------------------------------------------------
-- Reading the books
-- ---------------------------------------------------------------------------

/**
 * The trial balance: every account's balance, with the two columns that must match.
 *
 * If total debits and total credits ever differ, something is wrong and this is where it
 * shows. That is the whole job of the report.
 */
create or replace function public.trial_balance(
  p_branch_id uuid default null, p_from date default null, p_to date default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_out jsonb; v_rows jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;

  select coalesce(jsonb_agg(x order by x->>'code'), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
      'account_id', a.id, 'code', a.code, 'name', a.name,
      'group', g.name, 'nature', g.nature,
      'branch', (select name from public.branches where id = a.branch_id),
      'debit', coalesce(sum(l.debit), 0),
      'credit', coalesce(sum(l.credit), 0),
      -- Assets and expenses are "up" on the debit side; everything else on the credit.
      'balance', case when g.nature in ('asset', 'expense')
                      then coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0)
                      else coalesce(sum(l.credit), 0) - coalesce(sum(l.debit), 0) end
    ) as x
    from public.accounts a
    join public.account_groups g on g.id = a.group_id
    left join public.journal_lines l on l.account_id = a.id
      and exists (select 1 from public.journal_entries e
                  where e.id = l.entry_id and e.status = 'posted'
                    and (p_from is null or e.entry_date >= p_from)
                    and (p_to is null or e.entry_date <= p_to)
                    and (p_branch_id is null or e.branch_id = p_branch_id))
    where a.shop_id = v_me.shop_id
      and public.can_see_account(a.id)
    group by a.id, a.code, a.name, g.name, g.nature, a.branch_id
    having coalesce(sum(l.debit), 0) <> 0 or coalesce(sum(l.credit), 0) <> 0
  ) q;

  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'branch', (select name from public.branches where id = p_branch_id),
    'accounts', v_rows,
    'total_debit', (select coalesce(sum((x->>'debit')::numeric), 0)
                    from jsonb_array_elements(v_rows) x),
    'total_credit', (select coalesce(sum((x->>'credit')::numeric), 0)
                     from jsonb_array_elements(v_rows) x)
  ) into v_out;
  -- The two columns are reported, not asserted: if they ever differ the owner needs to
  -- SEE that, not get an error with no figures in it.
  return v_out || jsonb_build_object(
    'balanced', (v_out->>'total_debit')::numeric = (v_out->>'total_credit')::numeric);
end; $$;

/** One account's entries, oldest first, with a running balance. */
create or replace function public.account_ledger(
  p_account_id uuid, p_from date default null, p_to date default null,
  p_branch_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_nature text; v_out jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  if not public.can_see_account(p_account_id) then raise exception 'ACCOUNT_NOT_ALLOWED'; end if;

  select g.nature into v_nature from public.accounts a
    join public.account_groups g on g.id = a.group_id
    where a.id = p_account_id and a.shop_id = v_me.shop_id;
  if v_nature is null then raise exception 'ACCOUNT_NOT_FOUND'; end if;

  select jsonb_build_object(
    'account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name,
                                          'nature', v_nature,
                                          'branch', (select name from public.branches where id = a.branch_id))
                from public.accounts a where a.id = p_account_id),
    'opening', coalesce((
      select case when v_nature in ('asset', 'expense')
                  then sum(l.debit) - sum(l.credit) else sum(l.credit) - sum(l.debit) end
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      where l.account_id = p_account_id and e.status = 'posted'
        and p_from is not null and e.entry_date < p_from
        and (p_branch_id is null or e.branch_id = p_branch_id)), 0),
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'entry_id', e.id, 'entry_no', e.entry_no, 'date', e.entry_date,
        'narration', e.narration, 'source_kind', e.source_kind, 'source_id', e.source_id,
        'branch', b.name,
        'debit', l.debit, 'credit', l.credit, 'note', l.note,
        'party', coalesce((select coalesce(c.name_text, c.phone) from public.customers c
                           where c.id = l.customer_id),
                          (select s.name from public.suppliers s where s.id = l.supplier_id)),
        'who', st.name) order by e.entry_date, e.created_at), '[]'::jsonb)
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      join public.branches b on b.id = l.branch_id
      join public.staff st on st.id = e.staff_id
      where l.account_id = p_account_id and e.status = 'posted'
        and (p_from is null or e.entry_date >= p_from)
        and (p_to is null or e.entry_date <= p_to)
        and (p_branch_id is null or e.branch_id = p_branch_id))
  ) into v_out;
  return v_out;
end; $$;

/** The chart itself, for the pickers. */
create or replace function public.chart_of_accounts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'code', a.code, 'name', a.name, 'role', a.role,
      'group', g.name, 'nature', g.nature, 'active', a.active,
      'branch_id', a.branch_id,
      'branch', (select name from public.branches where id = a.branch_id))
      order by a.code), '[]'::jsonb)
    from public.accounts a
    join public.account_groups g on g.id = a.group_id
    where a.shop_id = v_me.shop_id and public.can_see_account(a.id));
end; $$;

/** Add an account of the shop's own. */
create or replace function public.save_account(p_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row public.accounts;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;

  if p_id is null then
    if coalesce(btrim(p_values->>'name'), '') = '' then raise exception 'NAME_REQUIRED'; end if;
    if coalesce(btrim(p_values->>'code'), '') = '' then raise exception 'ACCOUNT_CODE_REQUIRED'; end if;
    insert into public.accounts (shop_id, group_id, code, name, branch_id, bank_account_id)
    values (v_me.shop_id, (p_values->>'group_id')::uuid, btrim(p_values->>'code'),
            btrim(p_values->>'name'), (p_values->>'branch_id')::uuid,
            (p_values->>'bank_account_id')::uuid)
    returning * into v_row;
  else
    update public.accounts set
      name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
      code = coalesce(nullif(btrim(p_values->>'code'), ''), code),
      group_id = coalesce((p_values->>'group_id')::uuid, group_id),
      bank_account_id = case when p_values ? 'bank_account_id'
                             then (p_values->>'bank_account_id')::uuid else bank_account_id end,
      active = coalesce((p_values->>'active')::boolean, active)
    where id = p_id and shop_id = v_me.shop_id
    returning * into v_row;
    if v_row.id is null then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id,
          case when p_id is null then 'account_added' else 'account_changed' end,
          'account', v_row.id, jsonb_build_object('code', v_row.code, 'name', v_row.name));
  return to_jsonb(v_row);
end; $$;

-- ---------------------------------------------------------------------------
-- Printing a cheque
-- ---------------------------------------------------------------------------

create table public.cheque_layouts (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  -- Every bank's leaf puts the boxes somewhere slightly different, so the positions are
  -- data the shop measures once per bank, in millimetres from the top-left of the leaf.
  leaf_width_mm   numeric(6,1) not null default 203.0,
  leaf_height_mm  numeric(6,1) not null default 92.0,
  date_x          numeric(6,1) not null default 150.0,
  date_y          numeric(6,1) not null default 14.0,
  payee_x         numeric(6,1) not null default 25.0,
  payee_y         numeric(6,1) not null default 30.0,
  words1_x        numeric(6,1) not null default 25.0,
  words1_y        numeric(6,1) not null default 42.0,
  words2_x        numeric(6,1) not null default 18.0,
  words2_y        numeric(6,1) not null default 50.0,
  figures_x       numeric(6,1) not null default 155.0,
  figures_y       numeric(6,1) not null default 50.0,
  font_pt         integer not null default 11,
  created_at      timestamptz not null default now(),
  unique (shop_id, bank_account_id)
);

/** Under a hundred, in words. The building block the rest of it uses. */
create or replace function public.words_under_100(n integer) returns text
language plpgsql immutable set search_path = public as $$
declare
  v_ones text[] := array['One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  v_tens text[] := array['Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
begin
  if n <= 0 then return ''; end if;
  if n < 20 then return v_ones[n]; end if;
  return btrim(v_tens[n / 10 - 1] || case when n % 10 > 0 then ' ' || v_ones[n % 10] else '' end);
end; $$;

/** Under a thousand, in words. */
create or replace function public.words_under_1000(n integer) returns text
language plpgsql immutable set search_path = public as $$
declare
  v_ones text[] := array['One','Two','Three','Four','Five','Six','Seven','Eight','Nine'];
begin
  if n <= 0 then return ''; end if;
  if n < 100 then return public.words_under_100(n); end if;
  return btrim(v_ones[n / 100] || ' Hundred'
         || case when n % 100 > 0 then ' ' || public.words_under_100(n % 100) else '' end);
end; $$;

/**
 * An amount in words, the way a Bangladeshi cheque is written: crore, lakh, thousand.
 *
 * A cheque with no words on it is not a cheque — the words are what a bank honours when
 * the figures have been tampered with, which is the whole reason both are printed.
 */
create or replace function public.taka_in_words(p_amount numeric) returns text
language plpgsql immutable set search_path = public as $$
declare
  v_whole bigint := floor(abs(coalesce(p_amount, 0)))::bigint;
  v_paisa integer := round((abs(coalesce(p_amount, 0)) - floor(abs(coalesce(p_amount, 0)))) * 100)::integer;
  v_out text := '';
begin
  if v_whole = 0 and v_paisa = 0 then return 'Zero Taka Only'; end if;
  -- Crore, lakh, thousand, hundred: the South Asian grouping, not millions.
  if v_whole / 10000000 > 0 then
    v_out := v_out || public.words_under_1000((v_whole / 10000000)::integer) || ' Crore ';
    v_whole := v_whole % 10000000;
  end if;
  if v_whole / 100000 > 0 then
    v_out := v_out || public.words_under_100((v_whole / 100000)::integer) || ' Lakh ';
    v_whole := v_whole % 100000;
  end if;
  if v_whole / 1000 > 0 then
    v_out := v_out || public.words_under_100((v_whole / 1000)::integer) || ' Thousand ';
    v_whole := v_whole % 1000;
  end if;
  if v_whole > 0 then
    v_out := v_out || public.words_under_1000(v_whole::integer) || ' ';
  end if;
  v_out := btrim(v_out) || ' Taka';
  if v_paisa > 0 then
    v_out := v_out || ' and ' || public.words_under_100(v_paisa) || ' Paisa';
  end if;
  return btrim(v_out) || ' Only';
end; $$;

/** The column defaults, as an object, for a bank whose leaf nobody has measured yet. */
create or replace function public.default_cheque_layout() returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'bank_account_id', null, 'leaf_width_mm', 203.0, 'leaf_height_mm', 92.0,
    'date_x', 150.0, 'date_y', 14.0, 'payee_x', 25.0, 'payee_y', 30.0,
    'words1_x', 25.0, 'words1_y', 42.0, 'words2_x', 18.0, 'words2_y', 50.0,
    'figures_x', 155.0, 'figures_y', 50.0, 'font_pt', 11);
$$;

/**
 * Everything needed to print one cheque onto the bank's own leaf.
 *
 * Separate permission from seeing the accounts: reading the ledger is looking, printing
 * a cheque is signing the shop's money away.
 */
create or replace function public.cheque_print(p_cheque_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_cq public.cheques; v_layout public.cheque_layouts; v_payee text;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('print_cheques') then raise exception 'NOT_ALLOWED:print_cheques'; end if;
  select * into v_cq from public.cheques where id = p_cheque_id and shop_id = v_me.shop_id;
  if not found then raise exception 'CHEQUE_NOT_FOUND'; end if;
  if v_cq.direction <> 'issued' then raise exception 'ONLY_ISSUED_CHEQUES_PRINT'; end if;

  -- No measured layout for this bank yet: print on the column defaults rather than
  -- refuse, because a shop that cannot print until it has measured will write the cheque
  -- by hand instead. Looking at a cheque is not a change, so nothing is saved here.
  select * into v_layout from public.cheque_layouts
    where shop_id = v_me.shop_id and bank_account_id = v_cq.bank_account_id;
  if not found then
    v_layout := null;
  end if;

  v_payee := coalesce(nullif(btrim(coalesce(v_cq.payee, '')), ''),
                      (select name from public.suppliers where id = v_cq.supplier_id),
                      (select coalesce(name_text, phone) from public.customers where id = v_cq.customer_id));

  return jsonb_build_object(
    'cheque_no', v_cq.cheque_no,
    'date', v_cq.cheque_date,
    'payee', v_payee,
    'amount', v_cq.amount,
    'amount_words', public.taka_in_words(v_cq.amount),
    'bank', (select name from public.bank_accounts where id = v_cq.bank_account_id),
    'measured', v_layout.id is not null,
    'layout', coalesce(to_jsonb(v_layout) - 'id' - 'shop_id' - 'created_at',
                       public.default_cheque_layout()));
end; $$;

/** Measure a bank's leaf once; print straight after that. */
create or replace function public.save_cheque_layout(
  p_bank_account_id uuid, p_values jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row public.cheque_layouts;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;

  insert into public.cheque_layouts (shop_id, bank_account_id)
  values (v_me.shop_id, p_bank_account_id)
  on conflict (shop_id, bank_account_id) do nothing;

  update public.cheque_layouts set
    leaf_width_mm = coalesce((p_values->>'leaf_width_mm')::numeric, leaf_width_mm),
    leaf_height_mm = coalesce((p_values->>'leaf_height_mm')::numeric, leaf_height_mm),
    date_x = coalesce((p_values->>'date_x')::numeric, date_x),
    date_y = coalesce((p_values->>'date_y')::numeric, date_y),
    payee_x = coalesce((p_values->>'payee_x')::numeric, payee_x),
    payee_y = coalesce((p_values->>'payee_y')::numeric, payee_y),
    words1_x = coalesce((p_values->>'words1_x')::numeric, words1_x),
    words1_y = coalesce((p_values->>'words1_y')::numeric, words1_y),
    words2_x = coalesce((p_values->>'words2_x')::numeric, words2_x),
    words2_y = coalesce((p_values->>'words2_y')::numeric, words2_y),
    figures_x = coalesce((p_values->>'figures_x')::numeric, figures_x),
    figures_y = coalesce((p_values->>'figures_y')::numeric, figures_y),
    font_pt = coalesce((p_values->>'font_pt')::integer, font_pt)
  where shop_id = v_me.shop_id and bank_account_id = p_bank_account_id
  returning * into v_row;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'cheque_layout_saved', 'cheque_layout', v_row.id, p_values);
  return to_jsonb(v_row);
end; $$;

/** The cheque book: what is out there, and what happened to it. */
create or replace function public.cheque_list(
  p_direction text default null, p_status text default null,
  p_from date default null, p_to date default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'direction', c.direction, 'cheque_no', c.cheque_no,
      'amount', c.amount, 'cheque_date', c.cheque_date, 'status', c.status,
      'payee', coalesce(nullif(btrim(coalesce(c.payee, '')), ''), s.name, cu.name_text, cu.phone),
      'drawn_on', c.drawn_on,
      'bank', ba.name,
      'branch', b.name,
      'customer_id', c.customer_id, 'supplier_id', c.supplier_id,
      'bounced_reason', c.bounced_reason, 'cleared_at', c.cleared_at,
      'note', c.note, 'who', st.name,
      -- A cheque dated in the past that is still 'issued' needs chasing.
      'overdue', c.status = 'issued' and c.cheque_date < public.dhaka_today())
      order by c.cheque_date desc, c.created_at desc), '[]'::jsonb)
    from public.cheques c
    left join public.suppliers s on s.id = c.supplier_id
    left join public.customers cu on cu.id = c.customer_id
    left join public.bank_accounts ba on ba.id = c.bank_account_id
    join public.branches b on b.id = c.branch_id
    join public.staff st on st.id = c.staff_id
    where c.shop_id = v_me.shop_id
      and (p_direction is null or c.direction = p_direction)
      and (p_status is null or c.status = p_status)
      and (p_from is null or c.cheque_date >= p_from)
      and (p_to is null or c.cheque_date <= p_to));
end; $$;

/** The cheque books themselves, with how many leaves are left. */
create or replace function public.cheque_book_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', cb.id, 'bank_account_id', cb.bank_account_id, 'bank', ba.name,
      'prefix', cb.prefix, 'first_number', cb.first_number, 'last_number', cb.last_number,
      'next_number', cb.next_number, 'active', cb.active,
      'left', greatest(cb.last_number - cb.next_number + 1, 0))
      order by ba.name, cb.first_number), '[]'::jsonb)
    from public.cheque_books cb
    join public.bank_accounts ba on ba.id = cb.bank_account_id
    where cb.shop_id = v_me.shop_id);
end; $$;

-- ---------------------------------------------------------------------------
-- Expenses, in one screen's worth of typing
-- ---------------------------------------------------------------------------

/**
 * Record a shop expense.
 *
 * Paid in cash it is drawer money, so it goes through P8's `cash_movement()` and the
 * drawer stays right at closing time. Paid by bank, wallet or cheque it never touched
 * the drawer, so it posts straight to the books — putting it through the till would
 * make the cashier short by the amount of the electricity bill.
 */
create or replace function public.record_expense(
  p_branch_id   uuid,
  p_category_id uuid,
  p_amount      numeric,
  p_method      text default 'cash',
  p_note        text default null,
  p_supplier_id uuid default null,
  p_date        date default null,
  p_bank_account_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.staff;
  v_expense uuid;
  v_paid uuid;
  v_cat text;
  v_entry uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_PAYMENT_AMOUNT'; end if;
  if p_category_id is null then raise exception 'EXPENSE_CATEGORY_REQUIRED'; end if;
  select name into v_cat from public.transaction_categories
    where id = p_category_id and shop_id = v_me.shop_id;
  if v_cat is null then raise exception 'CATEGORY_NOT_FOUND'; end if;

  -- Cash out of the drawer is the drawer's business, and P8 already owns that rule.
  if p_method = 'cash' then
    return public.cash_movement(p_branch_id, 'out', p_amount, 'expense', p_category_id,
                                coalesce(p_note, v_cat));
  end if;

  if not public.feature_on('accounts') then raise exception 'FEATURE_OFF:accounts'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;

  select a.id into v_expense from public.accounts a
    where a.shop_id = v_me.shop_id and a.active and lower(a.name) = lower(v_cat);
  if v_expense is null then
    select id into v_expense from public.accounts
      where shop_id = v_me.shop_id and code = '6900';
  end if;
  if v_expense is null then raise exception 'NO_ACCOUNT_FOR:expense'; end if;

  v_paid := case when p_bank_account_id is not null
                 then (select id from public.accounts
                       where shop_id = v_me.shop_id and bank_account_id = p_bank_account_id
                         and active limit 1)
            end;
  v_paid := coalesce(v_paid, public.account_for_method(v_me.shop_id, p_method, p_branch_id));
  if v_paid is null then raise exception 'NO_ACCOUNT_FOR:%', p_method; end if;

  v_entry := public.post_entry(v_me.shop_id, p_branch_id,
    coalesce(p_date, public.dhaka_today()),
    v_cat || case when p_note is not null then ' — ' || p_note else '' end,
    jsonb_build_array(
      jsonb_build_object('account_id', v_expense, 'debit', p_amount,
                         'supplier_id', p_supplier_id),
      jsonb_build_object('account_id', v_paid, 'credit', p_amount,
                         'bank_account_id', p_bank_account_id)),
    'expense', null, v_me.id);

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'expense_recorded', 'journal_entry', v_entry,
          jsonb_build_object('category', v_cat, 'amount', p_amount, 'method', p_method));

  return jsonb_build_object('entry_id', v_entry, 'amount', p_amount, 'category', v_cat,
                            'method', p_method);
end; $$;

/** What the shop spent, by category, for the owner's eye. */
create or replace function public.expense_summary(
  p_from date default null, p_to date default null, p_branch_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_from date; v_to date;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  v_from := coalesce(p_from, date_trunc('month', public.dhaka_today())::date);
  v_to := coalesce(p_to, public.dhaka_today());

  return (
    select jsonb_build_object(
      'from', v_from, 'to', v_to,
      'total', coalesce(sum(l.debit) - sum(l.credit), 0),
      'by_category', coalesce(jsonb_agg(distinct jsonb_build_object(
        'account_id', a.id, 'name', a.name)) filter (where a.id is not null), '[]'::jsonb))
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id and e.status = 'posted'
    join public.accounts a on a.id = l.account_id
    join public.account_groups g on g.id = a.group_id and g.nature = 'expense'
    where l.shop_id = v_me.shop_id
      and e.entry_date between v_from and v_to
      and (p_branch_id is null or e.branch_id = p_branch_id));
end; $$;

-- ---------------------------------------------------------------------------
-- Looking at the money
-- ---------------------------------------------------------------------------

/** What is in each bank account and wallet right now. */
create or replace function public.money_balances(p_branch_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'account_id', a.id, 'code', a.code, 'name', a.name, 'role', a.role,
      'branch', (select name from public.branches where id = a.branch_id),
      'bank_account_id', a.bank_account_id,
      'balance', coalesce((
        select sum(l.debit) - sum(l.credit) from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id and e.status = 'posted'
        where l.account_id = a.id
          and (p_branch_id is null or e.branch_id = p_branch_id)), 0),
      -- Cheques we have written that the bank has not taken yet: the statement will not
      -- match the ledger until they clear, and this is the difference.
      'uncleared_out', coalesce((
        select sum(c.amount) from public.cheques c
        where c.bank_account_id = a.bank_account_id and c.direction = 'issued'
          and c.status = 'issued'), 0),
      'uncleared_in', coalesce((
        select sum(c.amount) from public.cheques c
        where c.bank_account_id = a.bank_account_id and c.direction = 'received'
          and c.status = 'issued'), 0))
      order by a.code), '[]'::jsonb)
    from public.accounts a
    where a.shop_id = v_me.shop_id and a.active
      and a.role in ('cash_in_hand', 'bank', 'wallet')
      and public.can_see_account(a.id)
      and (p_branch_id is null or a.branch_id is null or a.branch_id = p_branch_id));
end; $$;

/** The entries themselves, newest first, for the voucher list. */
create or replace function public.voucher_list(
  p_from date default null, p_to date default null, p_branch_id uuid default null,
  p_status text default null, p_source text default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_from date; v_to date;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('view_accounts') then raise exception 'NOT_ALLOWED:view_accounts'; end if;
  v_from := coalesce(p_from, public.dhaka_today() - 30);
  v_to := coalesce(p_to, public.dhaka_today());

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'entry_no', e.entry_no, 'date', e.entry_date,
      'narration', e.narration, 'source_kind', e.source_kind, 'source_id', e.source_id,
      'status', e.status, 'branch', b.name, 'branch_id', e.branch_id,
      'other_branch', (select name from public.branches where id = e.other_branch_id),
      'accepted_at', e.accepted_at,
      'reverses_id', e.reverses_id,
      'who', st.name,
      'amount', (select coalesce(sum(l.debit), 0) from public.journal_lines l
                 where l.entry_id = e.id),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                  'account', a.name, 'code', a.code,
                  'debit', l.debit, 'credit', l.credit, 'note', l.note,
                  'party', coalesce((select coalesce(c.name_text, c.phone) from public.customers c
                                     where c.id = l.customer_id),
                                    (select s.name from public.suppliers s where s.id = l.supplier_id)))
                  order by l.debit desc), '[]'::jsonb)
                from public.journal_lines l
                join public.accounts a on a.id = l.account_id
                where l.entry_id = e.id))
      order by e.entry_date desc, e.created_at desc), '[]'::jsonb)
    from public.journal_entries e
    join public.branches b on b.id = e.branch_id
    join public.staff st on st.id = e.staff_id
    where e.shop_id = v_me.shop_id
      and e.entry_date between v_from and v_to
      and (p_branch_id is null or e.branch_id = p_branch_id or e.other_branch_id = p_branch_id)
      and (p_status is null or e.status = p_status)
      and (p_source is null or e.source_kind = p_source));
end; $$;

-- ---------------------------------------------------------------------------
-- Turning the books on in a shop that has been trading
-- ---------------------------------------------------------------------------

/**
 * Write the entries for everything that happened before the accounts switch went on.
 *
 * It does NOT keep a second copy of the posting rules: it touches each document so the
 * same trigger that would have posted it at the time runs now. The already-posted guard
 * in every one of those triggers is what makes this safe to run twice — which matters,
 * because a shop with two years of sales will time out the first time and the owner will
 * press the button again.
 */
create or replace function public.backfill_accounts(p_from date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.staff;
  v_from date := coalesce(p_from, '2000-01-01'::date);
  v_sales int; v_grns int; v_srets int; v_rets int; v_cpay int; v_spay int; v_cash int;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  if not public.feature_on('accounts') then raise exception 'FEATURE_OFF:accounts'; end if;

  -- Oldest first, so the ledger reads in the order things actually happened.
  with t as (
    update public.sales s set total = total
    where s.shop_id = v_me.shop_id and s.status = 'completed' and s.total > 0
      and (s.created_at at time zone 'Asia/Dhaka')::date >= v_from
      and not exists (select 1 from public.journal_entries e
                      where e.source_kind = 'sale' and e.source_id = s.id)
    returning 1) select count(*) into v_sales from t;

  with t as (
    update public.grns g set total = total
    where g.shop_id = v_me.shop_id and g.total > 0
      and (g.created_at at time zone 'Asia/Dhaka')::date >= v_from
      and not exists (select 1 from public.journal_entries e
                      where e.source_kind = 'grn' and e.source_id = g.id)
    returning 1) select count(*) into v_grns from t;

  with t as (
    update public.supplier_returns r set total = total
    where r.shop_id = v_me.shop_id and r.total > 0
      and (r.created_at at time zone 'Asia/Dhaka')::date >= v_from
      and not exists (select 1 from public.journal_entries e
                      where e.source_kind = 'supplier_return' and e.source_id = r.id)
    returning 1) select count(*) into v_srets from t;

  with t as (
    update public.sale_returns r set total = total
    where r.shop_id = v_me.shop_id and r.total > 0
      and (r.created_at at time zone 'Asia/Dhaka')::date >= v_from
      and not exists (select 1 from public.journal_entries e
                      where e.source_kind = 'sale_return' and e.source_id = r.id)
    returning 1) select count(*) into v_rets from t;

  with t as (
    update public.customer_payments p set amount = amount
    where p.shop_id = v_me.shop_id
      and (p.created_at at time zone 'Asia/Dhaka')::date >= v_from
      and not exists (select 1 from public.journal_entries e
                      where e.source_kind = 'customer_payment' and e.source_id = p.id)
    returning 1) select count(*) into v_cpay from t;

  with t as (
    update public.supplier_payments p set amount = amount
    where p.shop_id = v_me.shop_id
      and (p.created_at at time zone 'Asia/Dhaka')::date >= v_from
      and not exists (select 1 from public.journal_entries e
                      where e.source_kind = 'supplier_payment' and e.source_id = p.id)
    returning 1) select count(*) into v_spay from t;

  with t as (
    update public.cash_movements m set amount = amount
    where m.shop_id = v_me.shop_id
      and (m.created_at at time zone 'Asia/Dhaka')::date >= v_from
      and not exists (select 1 from public.journal_entries e
                      where e.source_kind = 'cash_movement' and e.source_id = m.id)
    returning 1) select count(*) into v_cash from t;

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id, 'accounts_backfilled', 'journal_entry',
          jsonb_build_object('from', v_from, 'sales', v_sales, 'grns', v_grns,
                             'supplier_returns', v_srets, 'sale_returns', v_rets,
                             'customer_payments', v_cpay, 'supplier_payments', v_spay,
                             'cash_movements', v_cash));

  return jsonb_build_object('from', v_from, 'sales', v_sales, 'grns', v_grns,
                            'supplier_returns', v_srets, 'sale_returns', v_rets,
                            'customer_payments', v_cpay, 'supplier_payments', v_spay,
                            'cash_movements', v_cash);
end; $$;

/** A new shop gets the chart with everything else. */
create or replace function public.add_shop_accounts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_accounts(new.id);
  return new;
end; $$;

create trigger shops_seed_accounts
  after insert on public.shops
  for each row execute function public.add_shop_accounts();

-- ---------------------------------------------------------------------------
-- Who may read the books
-- ---------------------------------------------------------------------------

-- A cashier has no business in the journal: it holds the shop's costs, its margins and
-- every supplier price. So these tables are readable only with the accounts permission,
-- and writable through the functions above and nothing else. There are deliberately NO
-- insert/update/delete policies: the functions are security definer and bypass RLS,
-- which is how the balance and the numbering stay the only way in.
alter table public.account_groups   enable row level security;
alter table public.accounts         enable row level security;
alter table public.journal_entries  enable row level security;
alter table public.journal_lines    enable row level security;
alter table public.staff_accounts   enable row level security;
alter table public.cheque_books     enable row level security;
alter table public.cheques          enable row level security;
alter table public.cheque_layouts   enable row level security;

create policy account_groups_read on public.account_groups for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.has_permission('view_accounts')));
create policy accounts_read on public.accounts for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.has_permission('view_accounts'))
         and public.can_see_account(id));
create policy journal_entries_read on public.journal_entries for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.has_permission('view_accounts'))
         and public.can_use_branch(branch_id));
create policy journal_lines_read on public.journal_lines for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.has_permission('view_accounts'))
         and public.can_see_account(account_id));
create policy staff_accounts_read on public.staff_accounts for select to authenticated
  using (exists (select 1 from public.accounts a
                 where a.id = account_id and a.shop_id = (select public.current_shop_id()))
         and (select public.has_permission('view_accounts')));
create policy cheque_books_read on public.cheque_books for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.has_permission('view_accounts')));
create policy cheques_read on public.cheques for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.has_permission('view_accounts')));
create policy cheque_layouts_read on public.cheque_layouts for select to authenticated
  using (shop_id = (select public.current_shop_id()) and (select public.has_permission('view_accounts')));

grant select on public.account_groups, public.accounts, public.journal_entries,
                public.journal_lines, public.staff_accounts, public.cheque_books,
                public.cheques, public.cheque_layouts to authenticated;

-- The chart and the reports are read through functions, so the permission check lives in
-- one place for both the tables and the screens.
grant execute on function public.chart_of_accounts() to authenticated;
grant execute on function public.trial_balance(uuid, date, date) to authenticated;
grant execute on function public.account_ledger(uuid, date, date, uuid) to authenticated;
grant execute on function public.voucher_list(date, date, uuid, text, text) to authenticated;
grant execute on function public.money_balances(uuid) to authenticated;
grant execute on function public.expense_summary(date, date, uuid) to authenticated;
grant execute on function public.cheque_list(text, text, date, date) to authenticated;
grant execute on function public.cheque_book_list() to authenticated;
grant execute on function public.cheque_print(uuid) to authenticated;
grant execute on function public.save_voucher(text, uuid, date, text, numeric, uuid, uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.approve_voucher(uuid, boolean, text) to authenticated;
grant execute on function public.reverse_entry(uuid, text) to authenticated;
grant execute on function public.inter_branch_entry(uuid, uuid, numeric, text, text, uuid, uuid) to authenticated;
grant execute on function public.accept_inter_branch(uuid) to authenticated;
grant execute on function public.save_cheque(uuid, text, numeric, date, text, uuid, uuid, text, uuid, uuid, text, text, uuid, uuid) to authenticated;
grant execute on function public.save_cheque_book(uuid, integer, integer, text) to authenticated;
grant execute on function public.set_cheque_status(uuid, text, text) to authenticated;
grant execute on function public.save_cheque_layout(uuid, jsonb) to authenticated;
grant execute on function public.record_expense(uuid, uuid, numeric, text, text, uuid, date, uuid) to authenticated;
grant execute on function public.save_account(uuid, jsonb) to authenticated;
grant execute on function public.backfill_accounts(date) to authenticated;
grant execute on function public.taka_in_words(numeric) to authenticated;

-- `post_entry` is the one way an entry is written, and it is not one of them: it trusts
-- its caller completely, so only the functions above may call it.
revoke all on function public.post_entry(uuid, uuid, date, text, jsonb, text, uuid, uuid, text, uuid) from authenticated;
revoke all on function public.seed_accounts(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- The shop setting that turns two-step vouchers on
-- ---------------------------------------------------------------------------

-- Redefined, not patched: a saver that does not know about a column is a setting the
-- owner can switch on screen and never actually change (the same slip P10a and P11 hit).
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
    logo_url = coalesce(p_values->>'logo_url', logo_url),
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
    voucher_approval = coalesce((p_values->>'voucher_approval')::boolean, voucher_approval)
  where id = v_me.shop_id
  returning to_jsonb(shops.*) into v_row;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'shop_details_changed', 'shop', v_me.shop_id,
          jsonb_build_object('from', v_before - 'id', 'to', v_row - 'id'));
  return v_row;
end; $$;
