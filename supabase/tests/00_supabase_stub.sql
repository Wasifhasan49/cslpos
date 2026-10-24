-- Local-only stand-in for the bits Supabase provides (auth schema, roles).
-- Lets the migrations and tests run on plain Postgres. Never run this on Supabase.
--
-- The roles are cluster-wide, not per-database, so they may already exist because
-- another project on this Postgres uses them. Create them only if missing, and never
-- drop them — dropping a shared `anon` either fails (it owns another database's
-- objects) or breaks that other project.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
