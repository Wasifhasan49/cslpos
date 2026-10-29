-- P14b — HR: employees, attendance and salary
--
-- WHAT THIS IS FOR
-- BMS has a whole HR module (Department, Profession, Designation, Position, Employee
-- Information) and shows Attendance / Late / Absent on its dashboard. A shop with four
-- staff does not need any of it, so it is behind the "HR" switch and off by default.
--
-- THE TWO DECISIONS WORTH KNOWING
--
-- 1. AN EMPLOYEE IS NOT A LOGIN. A cashier has a `staff` row because they sign in; a
--    delivery boy, a technician and a cleaner have no login at all and still need to be
--    paid and marked present. So `employees` is its own table with an OPTIONAL link to
--    a staff row. Making the login the employee would mean inventing a login for
--    everybody the shop employs, and logins are what the whole permission system hangs
--    off — handing one to somebody who will never use it is how shops end up with
--    shared passwords.
--
-- 2. CHECKING IN IS GUARDED BY A BRANCH PIN, NOT BY THE DEVICE. The prompt offered
--    "the branch's own computers, or a branch PIN". This is a web app: there is no
--    device registry, and the honest options were the network it came from or a code
--    kept at the branch. An IP check breaks the morning the shop's router is replaced
--    or the internet fails over to a phone, and when it breaks it locks everybody out
--    of their own attendance — the one thing they must not be locked out of. So the
--    branch keeps a short code, the person types it, and the attendance row records
--    which branch accepted it. A manager can also mark somebody present, because a code
--    everybody knows is not proof of anything and pretending otherwise is worse than
--    admitting it. What this gives the shop is a record that was made AT THE BRANCH on
--    the day, which is what attendance is for; it is not, and cannot be, proof of
--    presence.
--
-- SALARY IS OWNER-ONLY, separately from the rest of HR. A shop can let a manager keep
-- attendance and the staff list without showing them what anybody earns.

alter table public.shop_features drop constraint shop_features_feature_check;
alter table public.shop_features add constraint shop_features_feature_check
  check (feature in (
    'vat', 'multi_location', 'price_lists', 'credit_sales', 'purchase_orders',
    'transfers', 'accounts', 'sms', 'extra_charges', 'hs_codes',
    'managers_see_dashboard', 'managers_see_accounts', 'managers_see_settings',
    'sales_documents',
    -- New in P14b. 'hr_extra_fields' turns on the religion and nationality fields BMS
    -- has: off unless a shop actually wants to record them.
    'hr', 'hr_extra_fields'
  ));

insert into public.permission_keys (key, label, area, has_limit, sort) values
  ('manage_hr',  'See and change staff records',  'admin', false, 430),
  ('see_salary', 'See and set what people earn',  'admin', false, 440)
on conflict (key) do nothing;

-- Nobody but the owner by default. A shop that wants its manager keeping attendance
-- turns `manage_hr` on for them; salary stays with the owner unless they say otherwise.
insert into public.role_permissions (shop_id, role, perm, allowed)
select s.id, r.role, p.perm, r.role = 'owner'
from public.shops s
cross join (values ('owner'), ('manager'), ('cashier')) as r(role)
cross join (values ('manage_hr'), ('see_salary')) as p(perm)
on conflict (shop_id, role, perm) do nothing;

-- ---------------------------------------------------------------------------
-- The setup lists
-- ---------------------------------------------------------------------------

create table public.departments (
  id      uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name    text not null,
  sort    integer not null default 0,
  active  boolean not null default true,
  unique (shop_id, name)
);

create table public.designations (
  id      uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name    text not null,
  sort    integer not null default 0,
  active  boolean not null default true,
  unique (shop_id, name)
);

-- BMS keeps "position" and "designation" apart: the designation is the job title on the
-- card, the position is where it sits in the hierarchy. Most shops will use one.
create table public.positions (
  id      uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name    text not null,
  sort    integer not null default 0,
  active  boolean not null default true,
  unique (shop_id, name)
);

create table public.professions (
  id      uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name    text not null,
  sort    integer not null default 0,
  active  boolean not null default true,
  unique (shop_id, name)
);

create table public.leave_types (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null,
  -- Days a year. 0 means "as many as the owner allows", which is how most small shops
  -- actually work.
  days_a_year integer not null default 0 check (days_a_year >= 0),
  -- Unpaid leave still comes off the salary; paid leave does not.
  is_paid     boolean not null default true,
  sort        integer not null default 0,
  active      boolean not null default true,
  unique (shop_id, name)
);

create table public.holidays (
  id       uuid primary key default gen_random_uuid(),
  shop_id  uuid not null references public.shops(id) on delete cascade,
  on_date  date not null,
  name     text not null,
  -- A shop can close one branch for a local holiday.
  branch_id uuid references public.branches(id) on delete cascade,
  unique (shop_id, on_date, branch_id)
);
create index holidays_date_idx on public.holidays(shop_id, on_date);

-- ---------------------------------------------------------------------------
-- The people
-- ---------------------------------------------------------------------------

create table public.employees (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  branch_id      uuid references public.branches(id) on delete set null,
  code           text,
  name           text not null,
  phone          text,
  photo_url      text,
  address        text,
  district_id    integer references public.districts(id),
  upazila_id     integer references public.upazilas(id),
  nid            text,
  date_of_birth  date,
  joined_on      date not null default public.dhaka_today(),
  department_id  uuid references public.departments(id) on delete set null,
  designation_id uuid references public.designations(id) on delete set null,
  position_id    uuid references public.positions(id) on delete set null,
  profession_id  uuid references public.professions(id) on delete set null,
  emergency_name  text,
  emergency_phone text,
  -- BMS records these. Optional, and hidden unless the shop turns the extra fields on:
  -- a field nobody needs is a field somebody has to tab through.
  religion       text,
  nationality    text,
  -- The login, if this person has one. Most employees do not.
  staff_id       uuid references public.staff(id) on delete set null,
  active         boolean not null default true,
  left_on        date,
  note           text,
  created_at     timestamptz not null default now(),
  unique (shop_id, code)
);
create index employees_branch_idx on public.employees(branch_id) where active;
create unique index employees_one_per_login on public.employees(staff_id)
  where staff_id is not null;

create table public.employee_documents (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  name        text not null,
  file_url    text not null,
  uploaded_at timestamptz not null default now()
);

/** What somebody earns, and what comes off it. Owner's business only. */
create table public.salary_terms (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  basic       numeric(12,2) not null default 0 check (basic >= 0),
  -- { "House rent": 3000, "Transport": 1000 } — every shop names these differently.
  allowances  jsonb not null default '{}'::jsonb,
  deductions  jsonb not null default '{}'::jsonb,
  -- Paid per day worked rather than per month: common for delivery and casual staff.
  daily_rate  numeric(12,2) not null default 0 check (daily_rate >= 0),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------

-- When the branch opens, and how much grace there is before somebody is late.
alter table public.branches
  add column opens_at time not null default '10:00',
  add column closes_at time not null default '20:00',
  add column grace_minutes integer not null default 15 check (grace_minutes >= 0),
  -- The code the branch keeps for checking in. Null means this branch does not take
  -- check-ins from the app at all, and a manager marks attendance instead.
  add column attendance_pin text;

create table public.attendance (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  -- WHERE the check-in was accepted. The point of the branch code is that this is true.
  branch_id   uuid not null references public.branches(id),
  on_date     date not null,
  in_at       timestamptz,
  out_at      timestamptz,
  status      text not null default 'present'
              check (status in ('present', 'late', 'absent', 'leave', 'holiday', 'half_day')),
  -- How it got here: the person typed the branch code, or a manager said so. Printed on
  -- the report, because the two are not the same kind of evidence.
  source      text not null default 'self' check (source in ('self', 'manager')),
  minutes_late integer not null default 0,
  note        text,
  marked_by   uuid references public.staff(id),
  created_at  timestamptz not null default now(),
  unique (employee_id, on_date)
);
create index attendance_day_idx on public.attendance(shop_id, on_date);
create index attendance_branch_day_idx on public.attendance(branch_id, on_date);

create table public.leave_requests (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id),
  from_date   date not null,
  to_date     date not null,
  days        numeric(4,1) not null check (days > 0),
  reason      text,
  status      text not null default 'asked'
              check (status in ('asked', 'approved', 'refused', 'cancelled')),
  decided_by  uuid references public.staff(id),
  decided_at  timestamptz,
  decision_note text,
  asked_by    uuid references public.staff(id),
  created_at  timestamptz not null default now(),
  check (to_date >= from_date)
);
create index leave_requests_employee_idx on public.leave_requests(employee_id, from_date desc);

-- ---------------------------------------------------------------------------
-- Salary
-- ---------------------------------------------------------------------------

/** Money lent to somebody, to come off their salary. */
create table public.salary_advances (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid references public.branches(id) on delete set null,
  employee_id uuid not null references public.employees(id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  method      text not null default 'cash',
  taken_on    date not null default public.dhaka_today(),
  note        text,
  -- Which month's sheet took it back off. Null means still outstanding.
  settled_month date,
  shift_id    uuid references public.shifts(id) on delete set null,
  staff_id    uuid not null references public.staff(id),
  created_at  timestamptz not null default now()
);
create index salary_advances_open_idx on public.salary_advances(shop_id)
  where settled_month is null;

create table public.salary_sheets (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  branch_id   uuid references public.branches(id) on delete set null,
  -- Always the first of the month.
  for_month   date not null,
  status      text not null default 'draft' check (status in ('draft', 'paid')),
  total_net   numeric(12,2) not null default 0,
  paid_on     date,
  method      text,
  note        text,
  staff_id    uuid not null references public.staff(id),
  created_at  timestamptz not null default now(),
  unique (shop_id, for_month, branch_id)
);

create table public.salary_lines (
  id          uuid primary key default gen_random_uuid(),
  sheet_id    uuid not null references public.salary_sheets(id) on delete cascade,
  shop_id     uuid not null references public.shops(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  basic       numeric(12,2) not null default 0,
  allowances  numeric(12,2) not null default 0,
  -- Worked out, and shown: an employee who sees "deductions 1,200" and cannot find out
  -- why does not trust the slip.
  absent_days numeric(4,1) not null default 0,
  absence_cut numeric(12,2) not null default 0,
  advance_cut numeric(12,2) not null default 0,
  other_cut   numeric(12,2) not null default 0,
  net         numeric(12,2) not null default 0,
  days_worked numeric(4,1) not null default 0,
  days_in_month integer not null default 30,
  note        text,
  unique (sheet_id, employee_id)
);
create index salary_lines_employee_idx on public.salary_lines(employee_id);

-- ---------------------------------------------------------------------------
-- The functions
-- ---------------------------------------------------------------------------

-- The four HR lists join the config-driven settings editor, so adding "Department" to
-- Settings is a spec in src/lib/settings-schema.ts rather than a screen.
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
                     'transaction_categories', 'sale_fields',
                     -- P14b.
                     'departments', 'designations', 'positions', 'professions',
                     'leave_types') then
    raise exception 'BAD_SETTING_TABLE:%', p_table;
  end if;
  -- The HR lists are HR's business, not everybody who may edit settings.
  if p_table in ('departments', 'designations', 'positions', 'professions', 'leave_types')
     and not public.has_permission('manage_hr') then
    raise exception 'NOT_ALLOWED:manage_hr';
  end if;

  select array_agg(column_name::text) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = p_table
    and column_name not in ('id', 'shop_id');

  for v_key in select jsonb_object_keys(p_values) loop
    if not v_key = any(v_cols) then raise exception 'BAD_SETTING_FIELD:%', v_key; end if;
    v_sets := v_sets || format('%I = %L', v_key, p_values->>v_key);
  end loop;
  if array_length(v_sets, 1) is null then raise exception 'NOTHING_TO_SAVE'; end if;

  if p_id is null then
    v_sql := format('insert into public.%I (shop_id, %s) values (%L, %s) returning to_jsonb(%I.*)',
      p_table,
      (select string_agg(format('%I', k), ', ') from jsonb_object_keys(p_values) k),
      v_me.shop_id,
      (select string_agg(format('%L', p_values->>k), ', ') from jsonb_object_keys(p_values) k),
      p_table);
    execute v_sql into v_row;
  else
    execute format('select to_jsonb(t.*) from public.%I t where t.id = %L and t.shop_id = %L',
                   p_table, p_id, v_me.shop_id) into v_before;
    if v_before is null then raise exception 'SETTING_NOT_FOUND'; end if;
    v_sql := format('update public.%I set %s where id = %L and shop_id = %L returning to_jsonb(%I.*)',
                    p_table, array_to_string(v_sets, ', '), p_id, v_me.shop_id, p_table);
    execute v_sql into v_row;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, details)
  values (v_me.shop_id, v_me.id, 'setting_saved', p_table,
          jsonb_build_object('from', v_before, 'to', v_row));
  return v_row;
end; $$;

/** The HR screens are not for everybody. */
create or replace function public.hr_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select public.feature_on('hr') and public.has_permission('manage_hr');
$$;

/**
 * When a branch opens, how much grace it gives, and the code it keeps for check-ins.
 *
 * Clearing the code turns check-ins off for that branch, and a manager marks attendance
 * instead — which is the right answer for a branch where nobody has a phone to hand.
 */
create or replace function public.save_attendance_settings(
  p_branch_id uuid, p_values jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_row jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.hr_allowed() then raise exception 'NOT_ALLOWED:manage_hr'; end if;
  if not public.can_use_branch(p_branch_id) then raise exception 'BRANCH_NOT_ALLOWED'; end if;
  -- Four digits, like a PIN. Long enough not to be guessed on the first try, short
  -- enough to be typed on a phone every morning.
  if p_values ? 'attendance_pin' and nullif(p_values->>'attendance_pin', '') is not null
     and p_values->>'attendance_pin' !~ '^[0-9]{4,8}$' then
    raise exception 'BAD_BRANCH_PIN';
  end if;

  update public.branches set
    opens_at = coalesce((p_values->>'opens_at')::time, opens_at),
    closes_at = coalesce((p_values->>'closes_at')::time, closes_at),
    grace_minutes = coalesce((p_values->>'grace_minutes')::integer, grace_minutes),
    attendance_pin = case when p_values ? 'attendance_pin'
                          then nullif(p_values->>'attendance_pin', '') else attendance_pin end
  where id = p_branch_id and shop_id = v_me.shop_id
  returning to_jsonb(branches.*) into v_row;
  if v_row is null then raise exception 'BRANCH_NOT_FOUND'; end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, p_branch_id, v_me.id, 'attendance_settings_changed', 'branch',
          p_branch_id, jsonb_build_object('opens_at', v_row->>'opens_at',
                                          'grace_minutes', v_row->>'grace_minutes',
                                          'takes_check_ins', (v_row->>'attendance_pin') is not null));
  return jsonb_build_object('branch_id', p_branch_id, 'opens_at', v_row->>'opens_at',
                            'grace_minutes', v_row->>'grace_minutes',
                            'takes_check_ins', (v_row->>'attendance_pin') is not null);
end; $$;

/** Add or change an employee. */
create or replace function public.save_employee(p_id uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_id uuid := p_id; v_before jsonb; v_row jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('hr') then raise exception 'FEATURE_OFF:hr'; end if;
  if not public.has_permission('manage_hr') then raise exception 'NOT_ALLOWED:manage_hr'; end if;
  if coalesce(trim(p_values->>'name'), '') = '' then raise exception 'NAME_REQUIRED'; end if;
  if p_values->>'branch_id' is not null
     and not public.can_use_branch((p_values->>'branch_id')::uuid) then
    raise exception 'BRANCH_NOT_ALLOWED';
  end if;

  if v_id is null then
    insert into public.employees (
      shop_id, branch_id, code, name, phone, photo_url, address, district_id, upazila_id,
      nid, date_of_birth, joined_on, department_id, designation_id, position_id,
      profession_id, emergency_name, emergency_phone, religion, nationality, staff_id, note)
    values (v_me.shop_id, (p_values->>'branch_id')::uuid,
            nullif(trim(p_values->>'code'), ''), trim(p_values->>'name'),
            p_values->>'phone', p_values->>'photo_url', p_values->>'address',
            (p_values->>'district_id')::integer, (p_values->>'upazila_id')::integer,
            p_values->>'nid', (p_values->>'date_of_birth')::date,
            coalesce((p_values->>'joined_on')::date, public.dhaka_today()),
            (p_values->>'department_id')::uuid, (p_values->>'designation_id')::uuid,
            (p_values->>'position_id')::uuid, (p_values->>'profession_id')::uuid,
            p_values->>'emergency_name', p_values->>'emergency_phone',
            p_values->>'religion', p_values->>'nationality',
            (p_values->>'staff_id')::uuid, p_values->>'note')
    returning id, to_jsonb(employees.*) into v_id, v_row;
  else
    select to_jsonb(e.*) into v_before from public.employees e
      where e.id = v_id and e.shop_id = v_me.shop_id;
    if v_before is null then raise exception 'EMPLOYEE_NOT_FOUND'; end if;
    update public.employees set
      branch_id = coalesce((p_values->>'branch_id')::uuid, branch_id),
      code = coalesce(nullif(trim(p_values->>'code'), ''), code),
      name = coalesce(nullif(trim(p_values->>'name'), ''), name),
      phone = coalesce(p_values->>'phone', phone),
      photo_url = coalesce(p_values->>'photo_url', photo_url),
      address = coalesce(p_values->>'address', address),
      district_id = coalesce((p_values->>'district_id')::integer, district_id),
      upazila_id = coalesce((p_values->>'upazila_id')::integer, upazila_id),
      nid = coalesce(p_values->>'nid', nid),
      date_of_birth = coalesce((p_values->>'date_of_birth')::date, date_of_birth),
      joined_on = coalesce((p_values->>'joined_on')::date, joined_on),
      department_id = coalesce((p_values->>'department_id')::uuid, department_id),
      designation_id = coalesce((p_values->>'designation_id')::uuid, designation_id),
      position_id = coalesce((p_values->>'position_id')::uuid, position_id),
      profession_id = coalesce((p_values->>'profession_id')::uuid, profession_id),
      emergency_name = coalesce(p_values->>'emergency_name', emergency_name),
      emergency_phone = coalesce(p_values->>'emergency_phone', emergency_phone),
      religion = coalesce(p_values->>'religion', religion),
      nationality = coalesce(p_values->>'nationality', nationality),
      staff_id = case when p_values ? 'staff_id' then (p_values->>'staff_id')::uuid else staff_id end,
      note = coalesce(p_values->>'note', note),
      -- Somebody who has left keeps their record: the attendance and the salary slips
      -- they were paid are part of the shop's books.
      active = coalesce((p_values->>'active')::boolean, active),
      left_on = case when coalesce((p_values->>'active')::boolean, active) then null
                     else coalesce((p_values->>'left_on')::date, left_on, public.dhaka_today()) end
    where id = v_id and shop_id = v_me.shop_id
    returning to_jsonb(employees.*) into v_row;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'employee_saved', 'employee', v_id,
          jsonb_build_object('from', v_before, 'to', v_row - 'photo_url'));
  return v_row;
end; $$;

/** What somebody earns. A separate function, because it is a separate permission. */
create or replace function public.save_salary_terms(p_employee_id uuid, p_values jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_before jsonb; v_row jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('see_salary') then raise exception 'NOT_ALLOWED:see_salary'; end if;
  if not exists (select 1 from public.employees
                 where id = p_employee_id and shop_id = v_me.shop_id) then
    raise exception 'EMPLOYEE_NOT_FOUND';
  end if;

  select to_jsonb(t.*) into v_before from public.salary_terms t where t.employee_id = p_employee_id;
  insert into public.salary_terms (employee_id, shop_id, basic, allowances, deductions, daily_rate)
  values (p_employee_id, v_me.shop_id,
          coalesce((p_values->>'basic')::numeric, 0),
          coalesce(p_values->'allowances', '{}'::jsonb),
          coalesce(p_values->'deductions', '{}'::jsonb),
          coalesce((p_values->>'daily_rate')::numeric, 0))
  on conflict (employee_id) do update set
    basic = excluded.basic, allowances = excluded.allowances,
    deductions = excluded.deductions, daily_rate = excluded.daily_rate,
    updated_at = now()
  returning to_jsonb(salary_terms.*) into v_row;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id, 'salary_terms_changed', 'employee', p_employee_id,
          jsonb_build_object('from', v_before, 'to', v_row));
  return v_row;
end; $$;

/**
 * "I'm in."
 *
 * The branch's code is what makes this a record made AT THE BRANCH. It is not proof of
 * presence — a code everybody knows cannot be — and the row says `self` so a report can
 * tell it apart from a manager's word.
 *
 * Late is worked out from the branch's own opening time and grace period, in Dhaka time,
 * because that is what being late means.
 */
create or replace function public.check_in(
  p_branch_id uuid, p_pin text, p_employee_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_emp   public.employees;
  v_branch public.branches;
  v_now   timestamptz := now();
  v_local time;
  v_late  integer := 0;
  v_status text;
  v_today date := public.dhaka_today();
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('hr') then raise exception 'FEATURE_OFF:hr'; end if;
  select * into v_branch from public.branches
    where id = p_branch_id and shop_id = v_me.shop_id;
  if not found then raise exception 'BRANCH_NOT_FOUND'; end if;

  -- Whose attendance: your own by default. Marking somebody else needs the permission,
  -- and lands as a manager's record rather than as theirs.
  if p_employee_id is null then
    select * into v_emp from public.employees
      where staff_id = v_me.id and shop_id = v_me.shop_id and active;
    if not found then raise exception 'NOT_AN_EMPLOYEE'; end if;
  else
    if not public.has_permission('manage_hr') then raise exception 'NOT_ALLOWED:manage_hr'; end if;
    select * into v_emp from public.employees
      where id = p_employee_id and shop_id = v_me.shop_id and active;
    if not found then raise exception 'EMPLOYEE_NOT_FOUND'; end if;
  end if;

  if p_employee_id is null then
    if v_branch.attendance_pin is null then raise exception 'BRANCH_TAKES_NO_CHECK_INS'; end if;
    if coalesce(p_pin, '') <> v_branch.attendance_pin then raise exception 'BAD_BRANCH_PIN'; end if;
  end if;

  v_local := (v_now at time zone 'Asia/Dhaka')::time;
  if v_local > (v_branch.opens_at + make_interval(mins => v_branch.grace_minutes)) then
    v_late := ceil(extract(epoch from (v_local - v_branch.opens_at)) / 60)::integer;
    v_status := 'late';
  else
    v_status := 'present';
  end if;
  -- A day the shop is closed is not a day anybody was late for.
  if exists (select 1 from public.holidays h
             where h.shop_id = v_me.shop_id and h.on_date = v_today
               and (h.branch_id is null or h.branch_id = p_branch_id)) then
    v_status := 'holiday';
    v_late := 0;
  end if;

  insert into public.attendance (shop_id, employee_id, branch_id, on_date, in_at, status,
                                 source, minutes_late, marked_by)
  values (v_me.shop_id, v_emp.id, p_branch_id, v_today, v_now, v_status,
          case when p_employee_id is null then 'self' else 'manager' end,
          v_late, v_me.id)
  on conflict (employee_id, on_date) do update set
    -- Checking in twice does not move the first time: the first one is the record.
    in_at = coalesce(public.attendance.in_at, excluded.in_at),
    status = case when public.attendance.in_at is null then excluded.status
                  else public.attendance.status end,
    minutes_late = case when public.attendance.in_at is null then excluded.minutes_late
                        else public.attendance.minutes_late end;

  return jsonb_build_object(
    'employee', v_emp.name, 'branch', v_branch.name, 'date', v_today,
    'status', v_status, 'minutes_late', v_late,
    'opens_at', v_branch.opens_at, 'grace_minutes', v_branch.grace_minutes);
end; $$;

/** "I'm off." Records the time; nothing depends on it except the hours report. */
create or replace function public.check_out(p_branch_id uuid, p_employee_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_emp uuid; v_today date := public.dhaka_today();
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if p_employee_id is null then
    select id into v_emp from public.employees
      where staff_id = v_me.id and shop_id = v_me.shop_id and active;
    if v_emp is null then raise exception 'NOT_AN_EMPLOYEE'; end if;
  else
    if not public.has_permission('manage_hr') then raise exception 'NOT_ALLOWED:manage_hr'; end if;
    v_emp := p_employee_id;
  end if;

  update public.attendance set out_at = now()
    where employee_id = v_emp and on_date = v_today and shop_id = v_me.shop_id;
  if not found then raise exception 'NO_CHECK_IN_TODAY'; end if;
  return jsonb_build_object('date', v_today, 'out_at', now());
end; $$;

/** A manager marking somebody present, absent, on leave or half a day. */
create or replace function public.mark_attendance(
  p_employee_id uuid, p_date date, p_status text, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_emp public.employees;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.hr_allowed() then raise exception 'NOT_ALLOWED:manage_hr'; end if;
  if p_status not in ('present', 'late', 'absent', 'leave', 'holiday', 'half_day') then
    raise exception 'BAD_ATTENDANCE_STATUS:%', p_status;
  end if;
  select * into v_emp from public.employees
    where id = p_employee_id and shop_id = v_me.shop_id;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND'; end if;
  if p_date > public.dhaka_today() then raise exception 'DATE_IN_FUTURE'; end if;

  insert into public.attendance (shop_id, employee_id, branch_id, on_date, status, source,
                                 note, marked_by)
  values (v_me.shop_id, p_employee_id,
          coalesce(v_emp.branch_id, (select id from public.branches
                                     where shop_id = v_me.shop_id order by created_at limit 1)),
          p_date, p_status, 'manager', p_note, v_me.id)
  on conflict (employee_id, on_date) do update set
    status = excluded.status, source = 'manager', note = excluded.note,
    marked_by = excluded.marked_by;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_emp.branch_id, v_me.id, 'attendance_marked', 'employee',
          p_employee_id, jsonb_build_object('date', p_date, 'status', p_status, 'note', p_note));

  return jsonb_build_object('employee', v_emp.name, 'date', p_date, 'status', p_status);
end; $$;

/** Asking for leave, and deciding on it. */
create or replace function public.save_leave_request(
  p_employee_id uuid, p_leave_type_id uuid, p_from date, p_to date,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_emp public.employees; v_days numeric(4,1); v_id uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('hr') then raise exception 'FEATURE_OFF:hr'; end if;
  select * into v_emp from public.employees
    where id = p_employee_id and shop_id = v_me.shop_id and active;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND'; end if;
  -- Your own, or anybody's if you keep the staff records.
  if v_emp.staff_id is distinct from v_me.id and not public.has_permission('manage_hr') then
    raise exception 'NOT_ALLOWED:manage_hr';
  end if;
  if p_to < p_from then raise exception 'BAD_DATE_RANGE'; end if;

  v_days := (p_to - p_from) + 1;
  insert into public.leave_requests (shop_id, employee_id, leave_type_id, from_date, to_date,
                                     days, reason, asked_by)
  values (v_me.shop_id, p_employee_id, p_leave_type_id, p_from, p_to, v_days, p_reason, v_me.id)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'days', v_days, 'status', 'asked');
end; $$;

/**
 * Approving leave writes the attendance for those days.
 *
 * Otherwise the salary sheet would dock somebody for days the owner agreed to — the
 * approval has to reach the thing that counts the days, or it is just a note.
 */
create or replace function public.decide_leave(
  p_id uuid, p_approve boolean, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_req public.leave_requests; v_emp public.employees; v_day date;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.hr_allowed() then raise exception 'NOT_ALLOWED:manage_hr'; end if;
  select * into v_req from public.leave_requests where id = p_id and shop_id = v_me.shop_id;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if v_req.status <> 'asked' then raise exception 'REQUEST_ALREADY_DECIDED'; end if;
  select * into v_emp from public.employees where id = v_req.employee_id;
  -- Nobody approves their own leave.
  if v_emp.staff_id is not distinct from v_me.id then raise exception 'NO_SELF_APPROVAL'; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception 'REASON_REQUIRED'; end if;

  update public.leave_requests set
    status = case when p_approve then 'approved' else 'refused' end,
    decided_by = v_me.id, decided_at = now(), decision_note = p_note
  where id = p_id;

  if p_approve then
    v_day := v_req.from_date;
    while v_day <= v_req.to_date loop
      insert into public.attendance (shop_id, employee_id, branch_id, on_date, status,
                                     source, note, marked_by)
      values (v_me.shop_id, v_req.employee_id,
              coalesce(v_emp.branch_id, (select id from public.branches
                                         where shop_id = v_me.shop_id order by created_at limit 1)),
              v_day, 'leave', 'manager',
              (select name from public.leave_types where id = v_req.leave_type_id), v_me.id)
      on conflict (employee_id, on_date) do update set status = 'leave', source = 'manager';
      v_day := v_day + 1;
    end loop;
  end if;

  insert into public.audit_log (shop_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_me.id,
          case when p_approve then 'leave_approved' else 'leave_refused' end,
          'employee', v_req.employee_id,
          jsonb_build_object('from', v_req.from_date, 'to', v_req.to_date, 'note', p_note));

  return jsonb_build_object('id', p_id, 'status',
                            case when p_approve then 'approved' else 'refused' end);
end; $$;

/** Money lent against a salary. Cash goes through the open drawer, like any cash out. */
create or replace function public.record_salary_advance(
  p_employee_id uuid, p_amount numeric, p_method text default 'cash',
  p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me public.staff; v_emp public.employees; v_id uuid; v_shift uuid;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('see_salary') then raise exception 'NOT_ALLOWED:see_salary'; end if;
  select * into v_emp from public.employees
    where id = p_employee_id and shop_id = v_me.shop_id and active;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_PAYMENT_AMOUNT'; end if;

  if p_method = 'cash' and v_emp.branch_id is not null then
    select id into v_shift from public.shifts
      where branch_id = v_emp.branch_id and closed_at is null
      order by opened_at desc limit 1;
  end if;

  insert into public.salary_advances (shop_id, branch_id, employee_id, amount, method,
                                      note, shift_id, staff_id)
  values (v_me.shop_id, v_emp.branch_id, p_employee_id, p_amount, p_method, p_note,
          v_shift, v_me.id)
  returning id into v_id;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_emp.branch_id, v_me.id, 'salary_advance', 'employee',
          p_employee_id, jsonb_build_object('amount', p_amount, 'method', p_method));

  return jsonb_build_object('id', v_id, 'amount', p_amount);
end; $$;

/**
 * The month's salary sheet.
 *
 * Worked out from the attendance that is actually there: basic plus allowances, less a
 * day's pay for each day absent, less any advance still outstanding. Every figure is
 * kept on the line, not just the net — an employee who sees "deductions 1,200" and
 * cannot find out why does not trust the slip, and a shop that cannot explain a
 * deduction has an argument on its hands every month.
 *
 * A DAY'S PAY is the month's salary divided by the days in THAT month, not a flat 30:
 * February would otherwise pay 30 days for 28, and docking somebody for a day in
 * February would cost them more than a day in March.
 *
 * Safe to run again: it rebuilds a draft sheet from scratch. A sheet that has been paid
 * is closed.
 */
create or replace function public.build_salary_sheet(
  p_month date, p_branch_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_month date := date_trunc('month', p_month)::date;
  v_days  integer := extract(day from (v_month + interval '1 month - 1 day'))::integer;
  v_sheet uuid;
  v_emp   record;
  v_terms public.salary_terms;
  v_allow numeric(12,2);
  v_absent numeric(4,1);
  v_worked numeric(4,1);
  v_per_day numeric(12,2);
  v_cut   numeric(12,2);
  v_adv   numeric(12,2);
  v_net   numeric(12,2);
  v_total numeric(12,2) := 0;
  v_n     integer := 0;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('see_salary') then raise exception 'NOT_ALLOWED:see_salary'; end if;
  if v_month > date_trunc('month', public.dhaka_today())::date then
    raise exception 'MONTH_NOT_FINISHED';
  end if;

  select id into v_sheet from public.salary_sheets
    where shop_id = v_me.shop_id and for_month = v_month
      and branch_id is not distinct from p_branch_id;
  if v_sheet is not null then
    if (select status from public.salary_sheets where id = v_sheet) = 'paid' then
      raise exception 'SHEET_ALREADY_PAID';
    end if;
    delete from public.salary_lines where sheet_id = v_sheet;
  else
    insert into public.salary_sheets (shop_id, branch_id, for_month, staff_id)
    values (v_me.shop_id, p_branch_id, v_month, v_me.id)
    returning id into v_sheet;
  end if;

  for v_emp in
    select e.* from public.employees e
    where e.shop_id = v_me.shop_id
      and (p_branch_id is null or e.branch_id = p_branch_id)
      -- Somebody who left mid-month is still owed for the days they worked.
      and e.joined_on <= (v_month + interval '1 month - 1 day')::date
      and (e.active or e.left_on >= v_month)
    order by e.name
  loop
    select * into v_terms from public.salary_terms where employee_id = v_emp.id;
    if v_terms.employee_id is null then continue; end if;

    select coalesce(sum((value)::numeric), 0) into v_allow
      from jsonb_each_text(coalesce(v_terms.allowances, '{}'::jsonb));

    -- Days nobody recorded are not days absent: a shop that forgot to mark attendance
    -- has not thereby stopped paying anybody. Only a row that SAYS absent counts.
    select
      coalesce(sum(case when a.status = 'absent' then 1
                        when a.status = 'half_day' then 0.5 else 0 end), 0),
      coalesce(sum(case when a.status in ('present', 'late') then 1
                        when a.status = 'half_day' then 0.5 else 0 end), 0)
      into v_absent, v_worked
    from public.attendance a
    where a.employee_id = v_emp.id
      and a.on_date between v_month and (v_month + interval '1 month - 1 day')::date;

    -- Paid by the day, or by the month.
    if v_terms.daily_rate > 0 then
      v_net := round(v_terms.daily_rate * v_worked, 2);
      v_per_day := v_terms.daily_rate;
      v_cut := 0;
    else
      v_per_day := round((v_terms.basic + v_allow) / v_days, 2);
      v_cut := round(v_per_day * v_absent, 2);
      v_net := round(v_terms.basic + v_allow - v_cut, 2);
    end if;

    select coalesce(sum(amount), 0) into v_adv from public.salary_advances
      where employee_id = v_emp.id and settled_month is null
        and taken_on <= (v_month + interval '1 month - 1 day')::date;
    -- Never take back more than the salary: the rest waits for next month, or the shop
    -- is lending somebody money and then not paying them at all.
    v_adv := least(v_adv, greatest(v_net, 0));
    v_net := round(v_net - v_adv, 2);

    insert into public.salary_lines (sheet_id, shop_id, employee_id, basic, allowances,
                                     absent_days, absence_cut, advance_cut, net,
                                     days_worked, days_in_month)
    values (v_sheet, v_me.shop_id, v_emp.id, v_terms.basic, v_allow, v_absent, v_cut,
            v_adv, v_net, v_worked, v_days);
    v_total := v_total + v_net;
    v_n := v_n + 1;
  end loop;

  update public.salary_sheets set total_net = v_total where id = v_sheet;
  return jsonb_build_object('id', v_sheet, 'month', v_month, 'employees', v_n,
                            'total', v_total, 'days_in_month', v_days);
end; $$;

/**
 * Paying the sheet.
 *
 * Posts the salary to the books as an expense (P13), takes the cash out of the drawer if
 * that is how it was paid, and marks the advances it took back as settled — so next
 * month does not deduct them all over again.
 */
create or replace function public.pay_salary_sheet(
  p_sheet_id uuid, p_method text default 'cash', p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me    public.staff;
  v_sheet public.salary_sheets;
  v_total numeric(12,2);
  v_branch uuid;
  v_shift uuid;
  v_lines jsonb;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('see_salary') then raise exception 'NOT_ALLOWED:see_salary'; end if;
  select * into v_sheet from public.salary_sheets
    where id = p_sheet_id and shop_id = v_me.shop_id;
  if not found then raise exception 'SHEET_NOT_FOUND'; end if;
  if v_sheet.status = 'paid' then raise exception 'SHEET_ALREADY_PAID'; end if;

  select coalesce(sum(net), 0) into v_total from public.salary_lines where sheet_id = p_sheet_id;
  if v_total <= 0 then raise exception 'NOTHING_TO_PAY'; end if;

  v_branch := coalesce(v_sheet.branch_id,
                       (select id from public.branches where shop_id = v_me.shop_id
                        order by created_at limit 1));

  update public.salary_sheets set status = 'paid', paid_on = public.dhaka_today(),
                                  method = p_method, note = p_note, total_net = v_total
    where id = p_sheet_id;

  -- The advances this sheet took back are settled now.
  update public.salary_advances set settled_month = v_sheet.for_month
    where settled_month is null
      and employee_id in (select employee_id from public.salary_lines
                          where sheet_id = p_sheet_id and advance_cut > 0);

  -- Cash paid out leaves the drawer, whether or not the shop keeps books.
  if p_method = 'cash' then
    select id into v_shift from public.shifts
      where branch_id = v_branch and closed_at is null order by opened_at desc limit 1;
    insert into public.cash_movements (shop_id, branch_id, shift_id, direction, amount,
                                       reason, note, staff_id, source_kind, source_id)
    values (v_me.shop_id, v_branch, v_shift, 'out', v_total, 'other',
            'Salary for ' || to_char(v_sheet.for_month, 'FMMonth YYYY'), v_me.id,
            'salary', p_sheet_id);
  end if;

  if public.feature_on('accounts') then
    -- Salaries are a running cost of the month they are FOR, not of the day they were
    -- handed over; dated the end of that month, which is what a profit figure per month
    -- needs.
    perform public.post_entry(v_me.shop_id, v_branch,
      least((v_sheet.for_month + interval '1 month - 1 day')::date, public.dhaka_today()),
      'Salary for ' || to_char(v_sheet.for_month, 'FMMonth YYYY'),
      jsonb_build_array(
        jsonb_build_object('account_id', public.salary_account(v_me.shop_id),
                           'debit', v_total),
        jsonb_build_object('account_id',
                           public.account_for_method(v_me.shop_id, p_method, v_branch),
                           'credit', v_total)),
      'voucher', p_sheet_id, v_me.id);
  end if;

  insert into public.audit_log (shop_id, branch_id, staff_id, action, entity, entity_id, details)
  values (v_me.shop_id, v_branch, v_me.id, 'salary_paid', 'salary_sheet', p_sheet_id,
          jsonb_build_object('month', v_sheet.for_month, 'total', v_total, 'method', p_method));

  return jsonb_build_object('id', p_sheet_id, 'total', v_total, 'method', p_method);
end; $$;

/** The account salaries go to. Named rather than guessed at, with a fallback. */
create or replace function public.salary_account(p_shop_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.accounts where shop_id = p_shop_id and code = '6200' and active),
    (select a.id from public.accounts a
     join public.account_groups g on g.id = a.group_id
     where a.shop_id = p_shop_id and g.nature = 'expense' and a.active
     order by a.code limit 1));
$$;

-- The drawer movement a salary causes carries `source_kind = 'salary'`, and P13's
-- cash-movement posting already leaves anything with a source alone — the document's own
-- entry recorded the cash side, and posting it twice would halve the drawer. Nothing to
-- change here; this note is so nobody goes looking for the missing trigger.

-- ---------------------------------------------------------------------------
-- The lists
-- ---------------------------------------------------------------------------

/** The staff list. Salary figures only for somebody allowed to see them. */
create or replace function public.employee_list(
  p_branch_id uuid default null, p_active boolean default true, p_query text default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_pay boolean;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.hr_allowed() then raise exception 'NOT_ALLOWED:manage_hr'; end if;
  v_pay := public.has_permission('see_salary');

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'code', e.code, 'name', e.name, 'phone', e.phone,
      'photo_url', e.photo_url, 'address', e.address, 'nid', e.nid,
      'date_of_birth', e.date_of_birth, 'joined_on', e.joined_on,
      'branch', b.name, 'branch_id', e.branch_id,
      'department', d.name, 'department_id', e.department_id,
      'designation', g.name, 'designation_id', e.designation_id,
      'position', ps.name, 'position_id', e.position_id,
      'profession', pf.name, 'profession_id', e.profession_id,
      'emergency_name', e.emergency_name, 'emergency_phone', e.emergency_phone,
      'religion', e.religion, 'nationality', e.nationality,
      'staff_id', e.staff_id, 'login', st.name,
      'active', e.active, 'left_on', e.left_on, 'note', e.note,
      -- Not sent at all unless this login may see pay, the same way cost prices work.
      'basic', case when v_pay then t.basic end,
      'allowances', case when v_pay then t.allowances end,
      'daily_rate', case when v_pay then t.daily_rate end,
      'advance_outstanding', case when v_pay then coalesce((
        select sum(sa.amount) from public.salary_advances sa
        where sa.employee_id = e.id and sa.settled_month is null), 0) end,
      'today', (select a.status from public.attendance a
                where a.employee_id = e.id and a.on_date = public.dhaka_today()))
      order by e.name), '[]'::jsonb)
    from public.employees e
    left join public.branches b on b.id = e.branch_id
    left join public.departments d on d.id = e.department_id
    left join public.designations g on g.id = e.designation_id
    left join public.positions ps on ps.id = e.position_id
    left join public.professions pf on pf.id = e.profession_id
    left join public.staff st on st.id = e.staff_id
    left join public.salary_terms t on t.employee_id = e.id
    where e.shop_id = v_me.shop_id
      and (p_branch_id is null or e.branch_id = p_branch_id)
      and (p_active is null or e.active = p_active)
      and (p_query is null or e.name ilike '%' || p_query || '%'
           or e.phone ilike '%' || p_query || '%' or e.code ilike '%' || p_query || '%'));
end; $$;

/** A day's attendance, branch by branch: BMS's Attendance / Late / Absent. */
create or replace function public.attendance_day(
  p_date date default null, p_branch_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_date date := coalesce(p_date, public.dhaka_today());
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.hr_allowed() then raise exception 'NOT_ALLOWED:manage_hr'; end if;

  return jsonb_build_object(
    'date', v_date,
    'holiday', (select h.name from public.holidays h
                where h.shop_id = v_me.shop_id and h.on_date = v_date
                  and (h.branch_id is null or h.branch_id = p_branch_id) limit 1),
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'employee_id', e.id, 'name', e.name, 'branch', b.name, 'branch_id', e.branch_id,
        'designation', g.name,
        -- Nobody marked and nobody checked in is NOT recorded as absent here: a shop
        -- that forgot is a shop that forgot, and guessing would put a deduction on
        -- somebody's salary that nobody decided.
        'status', coalesce(a.status, 'not recorded'),
        'in_at', a.in_at, 'out_at', a.out_at,
        'minutes_late', coalesce(a.minutes_late, 0),
        'source', a.source, 'note', a.note,
        'marked_by', (select st.name from public.staff st where st.id = a.marked_by))
        order by e.name), '[]'::jsonb)
      from public.employees e
      left join public.branches b on b.id = e.branch_id
      left join public.designations g on g.id = e.designation_id
      left join public.attendance a on a.employee_id = e.id and a.on_date = v_date
      where e.shop_id = v_me.shop_id and e.active
        and (p_branch_id is null or e.branch_id = p_branch_id)),
    'counts', (
      select jsonb_build_object(
        'present', count(*) filter (where a.status = 'present'),
        'late', count(*) filter (where a.status = 'late'),
        'absent', count(*) filter (where a.status = 'absent'),
        'leave', count(*) filter (where a.status = 'leave'),
        'not_recorded', count(*) filter (where a.status is null),
        'people', count(*))
      from public.employees e
      left join public.attendance a on a.employee_id = e.id and a.on_date = v_date
      where e.shop_id = v_me.shop_id and e.active
        and (p_branch_id is null or e.branch_id = p_branch_id)));
end; $$;

/** Leave asked for, and what happened to it. */
create or replace function public.leave_list(
  p_status text default null, p_employee_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.hr_allowed() then raise exception 'NOT_ALLOWED:manage_hr'; end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'employee', e.name, 'employee_id', r.employee_id,
      'kind', lt.name, 'is_paid', lt.is_paid,
      'from_date', r.from_date, 'to_date', r.to_date, 'days', r.days,
      'reason', r.reason, 'status', r.status, 'note', r.decision_note,
      'decided_by', (select st.name from public.staff st where st.id = r.decided_by),
      -- How much of this year's allowance is already gone.
      'taken_this_year', (select coalesce(sum(r2.days), 0) from public.leave_requests r2
                          where r2.employee_id = r.employee_id
                            and r2.leave_type_id = r.leave_type_id
                            and r2.status = 'approved'
                            and date_part('year', r2.from_date) = date_part('year', r.from_date)),
      'days_a_year', lt.days_a_year)
      order by r.from_date desc), '[]'::jsonb)
    from public.leave_requests r
    join public.employees e on e.id = r.employee_id
    join public.leave_types lt on lt.id = r.leave_type_id
    where r.shop_id = v_me.shop_id
      and (p_status is null or r.status = p_status)
      and (p_employee_id is null or r.employee_id = p_employee_id));
end; $$;

/** A salary sheet with its lines, for the screen and for the slips. */
create or replace function public.salary_sheet(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('see_salary') then raise exception 'NOT_ALLOWED:see_salary'; end if;

  return (
    select jsonb_build_object(
      'id', s.id, 'month', s.for_month, 'status', s.status, 'total', s.total_net,
      'branch', b.name, 'branch_id', s.branch_id, 'paid_on', s.paid_on,
      'method', s.method, 'note', s.note, 'who', st.name,
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', l.id, 'employee_id', l.employee_id, 'employee', e.name,
          'designation', (select d.name from public.designations d where d.id = e.designation_id),
          'basic', l.basic, 'allowances', l.allowances,
          'absent_days', l.absent_days, 'absence_cut', l.absence_cut,
          'advance_cut', l.advance_cut, 'other_cut', l.other_cut,
          'days_worked', l.days_worked, 'days_in_month', l.days_in_month,
          'net', l.net) order by e.name), '[]'::jsonb)
        from public.salary_lines l join public.employees e on e.id = l.employee_id
        where l.sheet_id = s.id))
    from public.salary_sheets s
    left join public.branches b on b.id = s.branch_id
    join public.staff st on st.id = s.staff_id
    where s.id = p_id and s.shop_id = v_me.shop_id);
end; $$;

/** Which months have a sheet. */
create or replace function public.salary_sheet_list(p_branch_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff;
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.has_permission('see_salary') then raise exception 'NOT_ALLOWED:see_salary'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'month', s.for_month, 'status', s.status, 'total', s.total_net,
      'branch', b.name, 'branch_id', s.branch_id, 'paid_on', s.paid_on,
      'people', (select count(*) from public.salary_lines l where l.sheet_id = s.id))
      order by s.for_month desc), '[]'::jsonb)
    from public.salary_sheets s
    left join public.branches b on b.id = s.branch_id
    where s.shop_id = v_me.shop_id
      and (p_branch_id is null or s.branch_id is not distinct from p_branch_id));
end; $$;

-- ---------------------------------------------------------------------------
-- The reports
-- ---------------------------------------------------------------------------

create or replace view public.v_rep_attendance as
select
  a.shop_id, a.branch_id, b.name as branch,
  a.on_date as d, to_char(a.on_date, 'YYYY-MM') as month,
  e.id as employee_id, e.name as employee, coalesce(e.code, '—') as code,
  coalesce(d.name, '—') as department,
  coalesce(g.name, '—') as designation,
  initcap(replace(a.status, '_', ' ')) as status,
  a.minutes_late,
  case when a.source = 'self' then 'Checked in' else 'Marked by a manager' end as recorded,
  to_char(a.in_at at time zone 'Asia/Dhaka', 'HH24:MI') as in_at,
  to_char(a.out_at at time zone 'Asia/Dhaka', 'HH24:MI') as out_at,
  case when a.status in ('present', 'late') then 1
       when a.status = 'half_day' then 0.5 else 0 end as days_worked,
  case when a.status = 'absent' then 1
       when a.status = 'half_day' then 0.5 else 0 end as days_absent,
  case when a.status = 'leave' then 1 else 0 end as days_leave,
  coalesce(a.note, '—') as note
from public.attendance a
join public.employees e on e.id = a.employee_id
join public.branches b on b.id = a.branch_id
left join public.departments d on d.id = e.department_id
left join public.designations g on g.id = e.designation_id;

create or replace view public.v_rep_salary as
select
  l.shop_id, s.branch_id, coalesce(b.name, 'Whole shop') as branch,
  s.for_month as d, to_char(s.for_month, 'YYYY-MM') as month,
  s.status as sheet_status, s.paid_on,
  e.id as employee_id, e.name as employee, coalesce(e.code, '—') as code,
  coalesce(dp.name, '—') as department,
  coalesce(g.name, '—') as designation,
  l.basic, l.allowances, l.absent_days, l.absence_cut, l.advance_cut, l.other_cut,
  l.days_worked, l.days_in_month, l.net
from public.salary_lines l
join public.salary_sheets s on s.id = l.sheet_id
join public.employees e on e.id = l.employee_id
left join public.branches b on b.id = s.branch_id
left join public.departments dp on dp.id = e.department_id
left join public.designations g on g.id = e.designation_id;

insert into public.rep_datasets (dataset, source, params, date_field, amount_field,
                                 qty_field, cost_field, profit_field) values
  ('attendance', 'public.v_rep_attendance', '{}', 'd', null, 'days_worked', null, null),
  ('salary',     'public.v_rep_salary',     '{}', 'd', 'net', null, null, null);

do $$
declare r record; v_cols text[];
begin
  for r in select * from public.rep_datasets where cols = '{}' loop
    select array_agg(a.attname::text) into v_cols from pg_attribute a
    where a.attrelid = r.source::regclass and a.attnum > 0 and not a.attisdropped;
    if v_cols is null then raise exception 'NO COLUMNS FOUND FOR DATASET %', r.dataset; end if;
    update public.rep_datasets set cols = v_cols where dataset = r.dataset;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The dashboard's attendance line
-- ---------------------------------------------------------------------------
--
-- BMS shows Attendance / Late / Absent on its own dashboard, so the owner's dashboard
-- (P12) gets the same figures — as an EXTRA call rather than inside dashboard(), which
-- is already one round trip carrying everything else. A shop with the HR switch off
-- never asks for it.

create or replace function public.attendance_today(p_branch_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me public.staff; v_today date := public.dhaka_today();
begin
  select * into v_me from public.staff where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_STAFF'; end if;
  if not public.feature_on('hr') then return jsonb_build_object('on', false); end if;
  if not public.has_permission('manage_hr') then return jsonb_build_object('on', false); end if;

  return jsonb_build_object('on', true, 'date', v_today,
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'branch', b.name, 'branch_id', b.id,
        'people', (select count(*) from public.employees e
                   where e.branch_id = b.id and e.active),
        'present', (select count(*) from public.attendance a
                    join public.employees e on e.id = a.employee_id
                    where e.branch_id = b.id and a.on_date = v_today and a.status = 'present'),
        'late', (select count(*) from public.attendance a
                 join public.employees e on e.id = a.employee_id
                 where e.branch_id = b.id and a.on_date = v_today and a.status = 'late'),
        'absent', (select count(*) from public.attendance a
                   join public.employees e on e.id = a.employee_id
                   where e.branch_id = b.id and a.on_date = v_today and a.status = 'absent'),
        'on_leave', (select count(*) from public.attendance a
                     join public.employees e on e.id = a.employee_id
                     where e.branch_id = b.id and a.on_date = v_today and a.status = 'leave'),
        -- Said plainly, because it is the figure that needs chasing before any of the
        -- others mean anything.
        'not_recorded', (select count(*) from public.employees e
                         where e.branch_id = b.id and e.active
                           and not exists (select 1 from public.attendance a
                                           where a.employee_id = e.id and a.on_date = v_today)))
        order by b.name), '[]'::jsonb)
      from public.branches b
      where b.shop_id = v_me.shop_id and b.active
        and public.can_use_branch(b.id)
        and (p_branch_id is null or b.id = p_branch_id)));
end; $$;

-- ---------------------------------------------------------------------------
-- Who may read what
-- ---------------------------------------------------------------------------
--
-- HR data is not the shop floor's business: a cashier has no reason to read anybody's
-- NID, address or salary. The setup lists are readable by anyone who may see settings,
-- because they are just words; everything about a PERSON needs `manage_hr`, and
-- everything about MONEY needs `see_salary` on top.

alter table public.departments       enable row level security;
alter table public.designations      enable row level security;
alter table public.positions         enable row level security;
alter table public.professions       enable row level security;
alter table public.leave_types       enable row level security;
alter table public.holidays          enable row level security;
alter table public.employees         enable row level security;
alter table public.employee_documents enable row level security;
alter table public.salary_terms      enable row level security;
alter table public.attendance        enable row level security;
alter table public.leave_requests    enable row level security;
alter table public.salary_advances   enable row level security;
alter table public.salary_sheets     enable row level security;
alter table public.salary_lines      enable row level security;

create policy departments_read on public.departments for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy designations_read on public.designations for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy positions_read on public.positions for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy professions_read on public.professions for select to authenticated
  using (shop_id = (select public.current_shop_id()));
create policy leave_types_read on public.leave_types for select to authenticated
  using (shop_id = (select public.current_shop_id()));
-- Everybody may see when the shop is shut.
create policy holidays_read on public.holidays for select to authenticated
  using (shop_id = (select public.current_shop_id()));

create policy employees_read on public.employees for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('manage_hr')));
create policy employee_documents_read on public.employee_documents for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('manage_hr')));
create policy attendance_read on public.attendance for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('manage_hr')));
create policy leave_requests_read on public.leave_requests for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('manage_hr')));
-- What anybody earns is the owner's business alone, unless they say otherwise.
create policy salary_terms_read on public.salary_terms for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('see_salary')));
create policy salary_advances_read on public.salary_advances for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('see_salary')));
create policy salary_sheets_read on public.salary_sheets for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('see_salary')));
create policy salary_lines_read on public.salary_lines for select to authenticated
  using (shop_id = (select public.current_shop_id())
         and (select public.has_permission('see_salary')));

grant select on public.departments, public.designations, public.positions,
                public.professions, public.leave_types, public.holidays,
                public.employees, public.employee_documents, public.attendance,
                public.leave_requests, public.salary_terms, public.salary_advances,
                public.salary_sheets, public.salary_lines to authenticated;

grant execute on function public.save_employee(uuid, jsonb) to authenticated;
grant execute on function public.save_salary_terms(uuid, jsonb) to authenticated;
grant execute on function public.check_in(uuid, text, uuid) to authenticated;
grant execute on function public.check_out(uuid, uuid) to authenticated;
grant execute on function public.mark_attendance(uuid, date, text, text) to authenticated;
grant execute on function public.save_leave_request(uuid, uuid, date, date, text) to authenticated;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;
grant execute on function public.record_salary_advance(uuid, numeric, text, text) to authenticated;
grant execute on function public.build_salary_sheet(date, uuid) to authenticated;
grant execute on function public.pay_salary_sheet(uuid, text, text) to authenticated;
grant execute on function public.employee_list(uuid, boolean, text) to authenticated;
grant execute on function public.attendance_day(date, uuid) to authenticated;
grant execute on function public.attendance_today(uuid) to authenticated;
grant execute on function public.leave_list(text, uuid) to authenticated;
grant execute on function public.salary_sheet(uuid) to authenticated;
grant execute on function public.salary_sheet_list(uuid) to authenticated;
grant execute on function public.hr_allowed() to authenticated;
grant execute on function public.save_attendance_settings(uuid, jsonb) to authenticated;

revoke all on function public.salary_account(uuid) from authenticated;
