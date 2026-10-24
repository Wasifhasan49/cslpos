-- P2 — the setup lists BMS spreads across ~20 screens under Primary Setup, as one
-- Settings area, plus permissions, VAT, feature switches and document numbering.
--
-- Two ideas run through this:
--
-- 1. A NEW SHOP MUST WORK WITH NOTHING CONFIGURED. Every list here is seeded with
--    sensible defaults by seed_shop_defaults(), which shop:init calls. A small shop
--    never opens Settings; it still gets units, payment methods and warranty terms.
--
-- 2. OFF BY DEFAULT. VAT, price lists, credit sales, purchase orders, transfers,
--    accounts and SMS are feature switches. Off means the menu item is gone, so a
--    one-branch cable shop is not looking at a trial balance.

-- ---------------------------------------------------------------------------
-- Shop details
-- ---------------------------------------------------------------------------

alter table public.shops
  add column email            text,
  add column logo_url         text,
  -- BIN is the VAT registration number in Bangladesh; shops that aren't registered
  -- leave it empty and never turn VAT on.
  add column bin_vat          text,
  add column receipt_footer   text,
  add column currency         text not null default 'BDT' check (currency ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------------------
-- Feature switches
-- ---------------------------------------------------------------------------

create table public.shop_features (
  shop_id     uuid not null references public.shops(id) on delete cascade,
  feature     text not null check (feature in (
    'vat', 'multi_location', 'price_lists', 'credit_sales', 'purchase_orders',
    'transfers', 'accounts', 'sms', 'extra_charges', 'hs_codes',
    'managers_see_dashboard', 'managers_see_accounts', 'managers_see_settings'
  )),
  enabled     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (shop_id, feature)
);

create or replace function public.feature_on(p_feature text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from public.shop_features
                   where shop_id = (select public.current_shop_id()) and feature = p_feature), false);
$$;

-- ---------------------------------------------------------------------------
-- Units of measure
-- ---------------------------------------------------------------------------

create table public.units (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  name            text not null,
  -- Cable sold by the metre needs 2.5; a mouse does not.
  allow_decimals  boolean not null default false,
  sort            integer not null default 0,
  active          boolean not null default true,
  unique (shop_id, name)
);

-- ---------------------------------------------------------------------------
-- Tax
-- ---------------------------------------------------------------------------

create table public.vat_rates (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null,
  pct         numeric(5,2) not null check (pct >= 0 and pct <= 100),
  -- Inclusive: the shelf price already contains the VAT (the normal case in Bangladesh
  -- retail). Exclusive: VAT is added on top at the till.
  inclusive   boolean not null default true,
  is_default  boolean not null default false,
  active      boolean not null default true,
  unique (shop_id, name)
);
create unique index vat_rates_one_default on public.vat_rates(shop_id) where is_default;

-- Advance Income Tax, withheld on some purchases. Stored as a shop-level rate because
-- that is how BMS treats it; purchases (P6) will use it.
alter table public.shops add column ait_pct numeric(5,2) not null default 0 check (ait_pct >= 0 and ait_pct <= 100);

create table public.hs_codes (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  code         text not null,
  description  text,
  vat_rate_id  uuid references public.vat_rates(id) on delete set null,
  active       boolean not null default true,
  unique (shop_id, code)
);

-- ---------------------------------------------------------------------------
-- Extra charges and discount reasons
-- ---------------------------------------------------------------------------

create table public.extra_charges (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null,
  kind        text not null check (kind in ('fixed', 'percent')),
  value       numeric(12,2) not null check (value >= 0),
  taxable     boolean not null default false,
  active      boolean not null default true,
  unique (shop_id, name)
);

-- Why a discount was given, so the owner's report says "Eid offer" rather than just
-- "10%". This is the reporting half of the discount-limit control.
create table public.discount_types (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null,
  active      boolean not null default true,
  unique (shop_id, name)
);
alter table public.sales add column discount_type_id uuid references public.discount_types(id);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

create table public.payment_methods (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  -- `key` is what complete_sale() stores on the sale, so it is fixed vocabulary;
  -- `label` is what staff see and can be renamed.
  key         text not null check (key in ('cash', 'bkash', 'nagad', 'rocket', 'card', 'bank', 'cheque', 'due')),
  label       text not null,
  enabled     boolean not null default true,
  -- A reference (transaction id, cheque number, last 4 digits) is required for
  -- everything except cash, which is why the counter asks for one.
  needs_ref   boolean not null default true,
  sort        integer not null default 0,
  unique (shop_id, key)
);

create table public.card_types (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null,
  -- What the card company takes. The shop needs it to know what actually arrives.
  charge_pct  numeric(5,2) not null default 0 check (charge_pct >= 0 and charge_pct <= 100),
  active      boolean not null default true,
  unique (shop_id, name)
);

-- Where the money lands. P13's accounts post to these.
create table public.bank_accounts (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('bank', 'wallet', 'cash_drawer')),
  account_no   text,
  bank_name    text,
  branch_name  text,
  active       boolean not null default true,
  unique (shop_id, name)
);

-- ---------------------------------------------------------------------------
-- Warranty terms
-- ---------------------------------------------------------------------------

create table public.warranty_terms (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  name          text not null,
  months        integer not null check (months >= 0),
  -- Printed on the receipt, so the customer knows what the warranty actually covers.
  -- BMS prints "1 Year" and nothing else, which is why claims are arguments.
  receipt_text  text,
  active        boolean not null default true,
  unique (shop_id, name)
);

-- ---------------------------------------------------------------------------
-- Transaction categories (BMS "Transaction Category")
-- ---------------------------------------------------------------------------
-- Owner-defined labels for splitting reports: "Corporate", "Online", "Walk-in",
-- "Service". A simple tagged list, applied to whichever document types the shop wants.

create table public.transaction_categories (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null,
  applies_to  text[] not null default '{sale,purchase,expense}',
  active      boolean not null default true,
  unique (shop_id, name)
);
alter table public.sales add column transaction_category_id uuid references public.transaction_categories(id);

-- ---------------------------------------------------------------------------
-- Products pick up their setup lists (P3 fills in the screens)
-- ---------------------------------------------------------------------------

alter table public.products
  add column unit_id           uuid references public.units(id),
  add column vat_rate_id       uuid references public.vat_rates(id),
  add column hs_code_id        uuid references public.hs_codes(id),
  add column warranty_term_id  uuid references public.warranty_terms(id);

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
-- Roles decide the shape of the app; permissions decide what a person may actually do.
-- BMS has six separate screens for this; here it is one list with role defaults and
-- per-person overrides. The functions check these, not the menu.

create table public.permission_keys (
  key          text primary key,
  label        text not null,
  -- Grouped so the settings screen is readable rather than a list of 20 switches.
  area         text not null,
  -- Some permissions carry a number, like the discount limit.
  has_limit    boolean not null default false,
  sort         integer not null default 0
);

insert into public.permission_keys (key, label, area, has_limit, sort) values
  ('sell',             'Sell at the counter',            'counter',  false, 10),
  ('give_discount',    'Give a discount',                'counter',  true,  20),
  ('change_price',     'Change a price within the band', 'counter',  false, 30),
  ('see_cost',         'See cost prices',                'counter',  false, 40),
  ('void_sale',        'Void a sale',                    'counter',  false, 50),
  ('return_sale',      'Take a return',                  'counter',  false, 60),
  ('reprint',          'Print a receipt again',          'counter',  false, 70),
  ('approve',          'Approve what others need signed off', 'counter', false, 80),
  ('receive_stock',    'Receive stock',                  'stock',    false, 110),
  ('adjust_stock',     'Adjust or write off stock',      'stock',    false, 120),
  ('transfer_stock',   'Transfer stock between branches','stock',    false, 130),
  ('view_reports',     'See reports',                    'reports',  false, 210),
  ('export_reports',   'Print or export reports',        'reports',  false, 220),
  ('view_accounts',    'See the accounts',               'accounts', false, 310),
  ('print_cheques',    'Print cheques',                  'accounts', false, 320),
  ('edit_settings',    'Change settings',                'admin',    false, 410),
  ('manage_staff',     'Add staff and change what they can do', 'admin', false, 420);

-- Defaults per role, per shop, so an owner can change them without affecting anyone else.
create table public.role_permissions (
  shop_id    uuid not null references public.shops(id) on delete cascade,
  role       text not null check (role in ('owner', 'manager', 'cashier')),
  perm       text not null references public.permission_keys(key),
  allowed    boolean not null default false,
  num_limit  numeric(12,2),
  primary key (shop_id, role, perm)
);

-- Per-person override. Null `allowed` is not stored: a row means "this person differs
-- from their role", which is also what makes the audit trail readable.
create table public.staff_permissions (
  staff_id   uuid not null references public.staff(id) on delete cascade,
  perm       text not null references public.permission_keys(key),
  allowed    boolean not null,
  num_limit  numeric(12,2),
  primary key (staff_id, perm)
);

/**
 * May the signed-in person do this?
 *
 * Owners always can: a shop whose owner has locked themselves out of their own
 * settings has no way back in without the service-role key.
 */
create or replace function public.has_permission(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  with me as (
    select id, shop_id, role from public.staff where user_id = auth.uid() and active limit 1
  )
  select case
    when (select role from me) = 'owner' then true
    else coalesce(
      (select sp.allowed from public.staff_permissions sp
        where sp.staff_id = (select id from me) and sp.perm = p_perm),
      (select rp.allowed from public.role_permissions rp
        where rp.shop_id = (select shop_id from me) and rp.role = (select role from me) and rp.perm = p_perm),
      false)
  end;
$$;

/** The number attached to a permission, e.g. the discount limit. */
create or replace function public.permission_limit(p_perm text) returns numeric
language sql stable security definer set search_path = public as $$
  with me as (
    select id, shop_id, role, discount_limit_pct from public.staff
    where user_id = auth.uid() and active limit 1
  )
  select coalesce(
    (select sp.num_limit from public.staff_permissions sp
      where sp.staff_id = (select id from me) and sp.perm = p_perm and sp.num_limit is not null),
    (select rp.num_limit from public.role_permissions rp
      where rp.shop_id = (select shop_id from me) and rp.role = (select role from me)
        and rp.perm = p_perm and rp.num_limit is not null),
    -- staff.discount_limit_pct stays the per-person discount limit, so nothing that
    -- already relies on it changes meaning.
    case when p_perm = 'give_discount' then (select discount_limit_pct from me) end,
    0);
$$;

create or replace function public.set_role_permission(
  p_role text, p_perm text, p_allowed boolean, p_limit numeric default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_before boolean;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  if p_role not in ('owner', 'manager', 'cashier') then raise exception 'BAD_ROLE:%', p_role; end if;
  if not exists (select 1 from public.permission_keys where key = p_perm) then
    raise exception 'BAD_PERMISSION:%', p_perm;
  end if;

  select allowed into v_before from public.role_permissions
    where shop_id = v_me.shop_id and role = p_role and perm = p_perm;

  insert into public.role_permissions (shop_id, role, perm, allowed, num_limit)
  values (v_me.shop_id, p_role, p_perm, p_allowed, p_limit)
  on conflict (shop_id, role, perm) do update set allowed = excluded.allowed, num_limit = excluded.num_limit;

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id, 'permission_changed', 'role_permission',
          jsonb_build_object('role', p_role, 'perm', p_perm, 'from', v_before, 'to', p_allowed, 'limit', p_limit));
end; $$;

create or replace function public.set_staff_permission(
  p_staff_id uuid, p_perm text, p_allowed boolean default null, p_limit numeric default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_target public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  select * into v_target from public.staff where id = p_staff_id and shop_id = v_me.shop_id;
  if not found then raise exception 'STAFF_NOT_FOUND'; end if;
  if not exists (select 1 from public.permission_keys where key = p_perm) then
    raise exception 'BAD_PERMISSION:%', p_perm;
  end if;

  if p_allowed is null then
    -- Back to whatever their role says.
    delete from public.staff_permissions where staff_id = p_staff_id and perm = p_perm;
  else
    insert into public.staff_permissions (staff_id, perm, allowed, num_limit)
    values (p_staff_id, p_perm, p_allowed, p_limit)
    on conflict (staff_id, perm) do update set allowed = excluded.allowed, num_limit = excluded.num_limit;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'permission_changed', 'staff', p_staff_id,
          jsonb_build_object('name', v_target.name, 'perm', p_perm, 'to', p_allowed, 'limit', p_limit));
end; $$;

-- ---------------------------------------------------------------------------
-- Document numbering, per branch and per document type
-- ---------------------------------------------------------------------------

create table public.document_sequences (
  shop_id      uuid not null references public.shops(id) on delete cascade,
  branch_id    uuid not null references public.branches(id) on delete cascade,
  doc_type     text not null check (doc_type in (
    'invoice', 'return', 'quote', 'order', 'challan', 'grn', 'po', 'requisition',
    'transfer', 'adjustment', 'receipt', 'payment', 'voucher', 'cheque'
  )),
  prefix       text not null default '',
  next_number  integer not null default 1 check (next_number > 0),
  primary key (shop_id, branch_id, doc_type)
);

/**
 * Hand out the next number for a document, inside the caller's transaction.
 *
 * Invoices still use branches.next_invoice so nothing that works today changes; every
 * other document type numbers from here.
 */
create or replace function public.next_document_number(p_branch_id uuid, p_doc_type text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_shop    uuid := (select public.current_shop_id());
  v_branch  public.branches;
  v_seq     public.document_sequences;
begin
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  select * into v_branch from public.branches where id = p_branch_id;

  insert into public.document_sequences (shop_id, branch_id, doc_type)
  values (v_shop, p_branch_id, p_doc_type)
  on conflict (shop_id, branch_id, doc_type) do nothing;

  -- for update: two tills asking at once must not get the same number.
  select * into v_seq from public.document_sequences
    where shop_id = v_shop and branch_id = p_branch_id and doc_type = p_doc_type for update;

  update public.document_sequences set next_number = next_number + 1
    where shop_id = v_shop and branch_id = p_branch_id and doc_type = p_doc_type;

  return coalesce(nullif(v_seq.prefix, ''), upper(substr(p_doc_type, 1, 3))) || '-' || v_branch.code
         || '-' || to_char(public.dhaka_today(), 'YYYY') || lpad(v_seq.next_number::text, 6, '0');
end; $$;

/** Only forward, and logged: an owner may skip ahead to match a paper book, never back. */
create or replace function public.set_document_next_number(
  p_branch_id uuid, p_doc_type text, p_next integer, p_prefix text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_current integer;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;
  if not exists (select 1 from public.branches where id = p_branch_id and shop_id = v_me.shop_id) then
    raise exception 'BRANCH_NOT_FOUND';
  end if;
  if p_next is null or p_next < 1 then raise exception 'BAD_DOCUMENT_NUMBER'; end if;

  if p_doc_type = 'invoice' then
    select next_invoice into v_current from public.branches where id = p_branch_id;
    if p_next < v_current then raise exception 'NUMBER_GOES_BACKWARDS:%', v_current; end if;
    update public.branches set next_invoice = p_next where id = p_branch_id;
  else
    insert into public.document_sequences (shop_id, branch_id, doc_type)
    values (v_me.shop_id, p_branch_id, p_doc_type) on conflict do nothing;
    select next_number into v_current from public.document_sequences
      where shop_id = v_me.shop_id and branch_id = p_branch_id and doc_type = p_doc_type;
    if p_next < v_current then raise exception 'NUMBER_GOES_BACKWARDS:%', v_current; end if;
    update public.document_sequences
      set next_number = p_next, prefix = coalesce(p_prefix, prefix)
      where shop_id = v_me.shop_id and branch_id = p_branch_id and doc_type = p_doc_type;
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'document_number_changed', 'document_sequence',
          jsonb_build_object('doc_type', p_doc_type, 'from', v_current, 'to', p_next));
end; $$;

-- ---------------------------------------------------------------------------
-- One saver for the simple lists
-- ---------------------------------------------------------------------------
-- Thirteen near-identical CRUD functions would be thirteen places to forget the owner
-- check or the audit row, so the simple lists share one.

create or replace function public.save_setting_row(
  p_table  text,
  p_id     uuid,
  p_values jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.staff;
  v_cols   text[];
  v_sets   text[] := '{}';
  v_key    text;
  v_sql    text;
  v_row    jsonb;
  v_before jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('edit_settings') then raise exception 'NOT_ALLOWED:edit_settings'; end if;

  -- An allow-list, not a pattern: p_table reaches a format() call, so anything not
  -- named here must never get through.
  if p_table not in ('units', 'vat_rates', 'hs_codes', 'extra_charges', 'discount_types',
                     'payment_methods', 'card_types', 'bank_accounts', 'warranty_terms',
                     'transaction_categories') then
    raise exception 'BAD_SETTING_TABLE:%', p_table;
  end if;

  select array_agg(column_name::text) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = p_table
    and column_name not in ('id', 'shop_id');

  for v_key in select jsonb_object_keys(p_values) loop
    if not (v_key = any(v_cols)) then raise exception 'BAD_SETTING_FIELD:%', v_key; end if;
    v_sets := v_sets || format('%I = ($1->>%L)::%s', v_key, v_key,
      (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = p_table and column_name = v_key));
  end loop;
  if array_length(v_sets, 1) is null then raise exception 'NOTHING_TO_SAVE'; end if;

  if p_id is null then
    v_sql := format('insert into public.%I (shop_id, %s) select $2, %s returning to_jsonb(public.%I.*)',
      p_table,
      (select string_agg(format('%I', k), ', ') from jsonb_object_keys(p_values) k),
      (select string_agg(format('($1->>%L)::%s', k,
         (select data_type from information_schema.columns
          where table_schema = 'public' and table_name = p_table and column_name = k)), ', ')
       from jsonb_object_keys(p_values) k),
      p_table);
    execute v_sql into v_row using p_values, v_me.shop_id;
  else
    execute format('select to_jsonb(t.*) from public.%I t where t.id = $1 and t.shop_id = $2', p_table)
      into v_before using p_id, v_me.shop_id;
    if v_before is null then raise exception 'SETTING_NOT_FOUND'; end if;
    v_sql := format('update public.%I set %s where id = $2 and shop_id = $3 returning to_jsonb(public.%I.*)',
                    p_table, array_to_string(v_sets, ', '), p_table);
    execute v_sql into v_row using p_values, p_id, v_me.shop_id;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id, case when p_id is null then 'setting_added' else 'setting_changed' end,
          p_table, jsonb_build_object('from', v_before, 'to', v_row));

  return v_row;
end; $$;

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
    ait_pct = coalesce((p_values->>'ait_pct')::numeric, ait_pct)
  where id = v_me.shop_id
  returning to_jsonb(shops.*) into v_row;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'shop_details_changed', 'shop', v_me.shop_id,
          jsonb_build_object('from', v_before - 'id', 'to', v_row - 'id'));
  return v_row;
end; $$;

create or replace function public.set_feature(p_feature text, p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if v_me.role <> 'owner' then raise exception 'NOT_OWNER'; end if;

  insert into public.shop_features (shop_id, feature, enabled)
  values (v_me.shop_id, p_feature, p_enabled)
  on conflict (shop_id, feature) do update set enabled = excluded.enabled, updated_at = now();

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id, 'feature_changed', 'shop_feature',
          jsonb_build_object('feature', p_feature, 'to', p_enabled));
end; $$;

-- ---------------------------------------------------------------------------
-- Defaults for a new shop
-- ---------------------------------------------------------------------------

create or replace function public.seed_shop_defaults(p_shop_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.units (shop_id, name, allow_decimals, sort) values
    (p_shop_id, 'pcs', false, 1), (p_shop_id, 'box', false, 2), (p_shop_id, 'set', false, 3),
    (p_shop_id, 'pair', false, 4), (p_shop_id, 'metre', true, 5), (p_shop_id, 'kg', true, 6)
  on conflict (shop_id, name) do nothing;

  -- Seeded but unused until the VAT switch goes on.
  insert into public.vat_rates (shop_id, name, pct, inclusive, is_default) values
    (p_shop_id, 'VAT 5% (inclusive)', 5, true, true),
    (p_shop_id, 'VAT 7.5% (inclusive)', 7.5, true, false),
    (p_shop_id, 'VAT 15% (inclusive)', 15, true, false),
    (p_shop_id, 'No VAT', 0, true, false)
  on conflict (shop_id, name) do nothing;

  insert into public.payment_methods (shop_id, key, label, enabled, needs_ref, sort) values
    (p_shop_id, 'cash',   'Cash',          true,  false, 1),
    (p_shop_id, 'bkash',  'bKash',         true,  true,  2),
    (p_shop_id, 'nagad',  'Nagad',         true,  true,  3),
    (p_shop_id, 'card',   'Card',          true,  true,  4),
    (p_shop_id, 'rocket', 'Rocket',        false, true,  5),
    (p_shop_id, 'bank',   'Bank transfer', false, true,  6),
    (p_shop_id, 'cheque', 'Cheque',        false, true,  7),
    (p_shop_id, 'due',    'On due (baki)', false, false, 8)
  on conflict (shop_id, key) do nothing;

  insert into public.card_types (shop_id, name, charge_pct) values
    (p_shop_id, 'Visa', 2), (p_shop_id, 'Mastercard', 2), (p_shop_id, 'American Express', 3)
  on conflict (shop_id, name) do nothing;

  insert into public.bank_accounts (shop_id, name, kind) values
    (p_shop_id, 'Counter cash drawer', 'cash_drawer')
  on conflict (shop_id, name) do nothing;

  -- The wording a computer shop actually uses, and the receipt text BMS never prints.
  insert into public.warranty_terms (shop_id, name, months, receipt_text) values
    (p_shop_id, 'No warranty', 0, 'No warranty on this item.'),
    (p_shop_id, '6 months replacement', 6, 'Replacement within 6 months for manufacturing faults. Physical damage and burn marks are not covered.'),
    (p_shop_id, '1 year replacement', 12, 'Replacement within 1 year for manufacturing faults. Physical damage and burn marks are not covered.'),
    (p_shop_id, '1 year service only', 12, 'Service within 1 year. Replacement is not included.'),
    (p_shop_id, '3 years service', 36, 'Service within 3 years. Replacement is not included.')
  on conflict (shop_id, name) do nothing;

  insert into public.discount_types (shop_id, name) values
    (p_shop_id, 'Regular customer'), (p_shop_id, 'Bulk purchase'),
    (p_shop_id, 'Staff discount'), (p_shop_id, 'Festival offer'),
    (p_shop_id, 'Price match')
  on conflict (shop_id, name) do nothing;

  insert into public.extra_charges (shop_id, name, kind, value, taxable) values
    (p_shop_id, 'Delivery', 'fixed', 0, false),
    (p_shop_id, 'Installation', 'fixed', 0, false),
    (p_shop_id, 'Service charge', 'percent', 0, false)
  on conflict (shop_id, name) do nothing;

  insert into public.transaction_categories (shop_id, name) values
    (p_shop_id, 'Walk-in'), (p_shop_id, 'Corporate'), (p_shop_id, 'Online'), (p_shop_id, 'Service')
  on conflict (shop_id, name) do nothing;

  -- Everything advanced is OFF, so a small shop sees a simple app.
  insert into public.shop_features (shop_id, feature, enabled) values
    (p_shop_id, 'vat', false), (p_shop_id, 'multi_location', false),
    (p_shop_id, 'price_lists', false), (p_shop_id, 'credit_sales', false),
    (p_shop_id, 'purchase_orders', false), (p_shop_id, 'transfers', false),
    (p_shop_id, 'accounts', false), (p_shop_id, 'sms', false),
    (p_shop_id, 'extra_charges', false), (p_shop_id, 'hs_codes', false),
    (p_shop_id, 'managers_see_dashboard', false), (p_shop_id, 'managers_see_accounts', false),
    (p_shop_id, 'managers_see_settings', false)
  on conflict (shop_id, feature) do nothing;

  -- Role defaults chosen so the behaviour already tested stays exactly the same:
  -- a cashier sells, a manager runs the shop floor, an owner does everything.
  insert into public.role_permissions (shop_id, role, perm, allowed, num_limit)
  select p_shop_id, r.role, k.key,
    case r.role
      when 'owner' then true
      when 'manager' then k.key in ('sell','give_discount','change_price','see_cost','void_sale',
                                    'return_sale','reprint','approve','receive_stock','adjust_stock',
                                    'transfer_stock','view_reports','export_reports')
      else k.key in ('sell','give_discount','reprint')
    end,
    case when k.key = 'give_discount' then
      case r.role when 'owner' then 100 when 'manager' then 10 else 5 end
    end
  from public.permission_keys k
  cross join (values ('owner'), ('manager'), ('cashier')) as r(role)
  on conflict (shop_id, role, perm) do nothing;

  -- Every branch starts with a sequence for each document type.
  insert into public.document_sequences (shop_id, branch_id, doc_type)
  select p_shop_id, b.id, d.doc_type
  from public.branches b
  cross join (values ('invoice'),('return'),('quote'),('order'),('challan'),('grn'),('po'),
                     ('requisition'),('transfer'),('adjustment'),('receipt'),('payment'),
                     ('voucher'),('cheque')) as d(doc_type)
  where b.shop_id = p_shop_id
  on conflict (shop_id, branch_id, doc_type) do nothing;
end; $$;

-- Every shop that already exists gets the same defaults.
select public.seed_shop_defaults(id) from public.shops;

-- ---------------------------------------------------------------------------
-- VAT at the till
-- ---------------------------------------------------------------------------

alter table public.sales
  add column vat_amount numeric(12,2) not null default 0,
  add column charges_amount numeric(12,2) not null default 0;
alter table public.sale_items
  add column vat_pct numeric(5,2) not null default 0,
  add column vat_amount numeric(12,2) not null default 0,
  add column vat_inclusive boolean not null default true;

/**
 * Work out the VAT on one line.
 *
 * Inclusive (the normal case in Bangladesh retail): the shelf price already contains
 * the VAT, so the tax is line / (100 + pct) * pct and the total does not change.
 * Exclusive: the tax is added on top, so the customer pays more than the shelf price.
 *
 * Rounded to 2 decimals per line, which is what a VAT return expects.
 */
create or replace function public.vat_on(p_line numeric, p_pct numeric, p_inclusive boolean)
returns numeric
language sql immutable as $$
  select case
    when coalesce(p_pct, 0) = 0 then 0
    when p_inclusive then round(p_line * p_pct / (100 + p_pct), 2)
    else round(p_line * p_pct / 100, 2)
  end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security for the setup lists
-- ---------------------------------------------------------------------------
-- Everyone in the shop can READ the lists (the counter needs payment methods, units
-- and VAT rates). Only the functions above can write them.

do $$
declare t text;
begin
  foreach t in array array['shop_features','units','vat_rates','hs_codes','extra_charges',
                           'discount_types','payment_methods','card_types','bank_accounts',
                           'warranty_terms','transaction_categories','document_sequences']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format($f$create policy %I on public.%I for select to authenticated
                      using (shop_id = (select public.current_shop_id()))$f$, t || '_read', t);
  end loop;
end $$;

alter table public.permission_keys    enable row level security;
alter table public.role_permissions   enable row level security;
alter table public.staff_permissions  enable row level security;

-- The list of possible permissions is not secret; what each person has is.
create policy permission_keys_read on public.permission_keys for select to authenticated using (true);
create policy role_permissions_read on public.role_permissions for select to authenticated
  using (shop_id = (select public.current_shop_id()));
-- You can see your own, and a manager can see the team's.
create policy staff_permissions_read on public.staff_permissions for select to authenticated
  using (exists (select 1 from public.staff s
                 where s.id = staff_id and s.shop_id = (select public.current_shop_id())
                   and (s.user_id = auth.uid() or (select public.is_manager()))));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.has_permission(text) from public, anon;
revoke execute on function public.permission_limit(text) from public, anon;
revoke execute on function public.feature_on(text) from public, anon;
revoke execute on function public.vat_on(numeric, numeric, boolean) from public, anon;
revoke execute on function public.save_setting_row(text, uuid, jsonb) from public, anon;
revoke execute on function public.save_shop_details(jsonb) from public, anon;
revoke execute on function public.set_feature(text, boolean) from public, anon;
revoke execute on function public.set_role_permission(text, text, boolean, numeric) from public, anon;
revoke execute on function public.set_staff_permission(uuid, text, boolean, numeric) from public, anon;
revoke execute on function public.next_document_number(uuid, text) from public, anon;
revoke execute on function public.set_document_next_number(uuid, text, integer, text) from public, anon;
-- seed_shop_defaults runs from shop:init with the service-role key, never from a browser.
revoke execute on function public.seed_shop_defaults(uuid) from public, anon, authenticated;

grant execute on function public.has_permission(text) to authenticated;
grant execute on function public.permission_limit(text) to authenticated;
grant execute on function public.feature_on(text) to authenticated;
grant execute on function public.vat_on(numeric, numeric, boolean) to authenticated;
grant execute on function public.save_setting_row(text, uuid, jsonb) to authenticated;
grant execute on function public.save_shop_details(jsonb) to authenticated;
grant execute on function public.set_feature(text, boolean) to authenticated;
grant execute on function public.set_role_permission(text, text, boolean, numeric) to authenticated;
grant execute on function public.set_staff_permission(uuid, text, boolean, numeric) to authenticated;
grant execute on function public.next_document_number(uuid, text) to authenticated;
grant execute on function public.set_document_next_number(uuid, text, integer, text) to authenticated;
