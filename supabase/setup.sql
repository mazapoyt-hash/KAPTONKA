-- КАРТОНКА v3 — база точок підтримки та потреб.
-- Запусти весь файл у Supabase Dashboard → SQL Editor → New query → Run.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.support_points (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  city text not null,
  address text not null,
  lat double precision not null,
  lng double precision not null,
  description text not null default '',
  services text[] not null default '{}',
  stock jsonb not null default '[]'::jsonb,
  controlled_until timestamptz not null,
  photo_path text not null,
  creator_label text not null default '',
  creator_secret_hash text not null,
  status text not null default 'active',
  absence_report_count integer not null default 0,
  present_confirmation_count integer not null default 0,
  last_confirmed_at timestamptz not null default now(),
  constraint support_points_status_check check (status in ('active', 'hidden', 'closed')),
  constraint support_points_lat_check check (lat between -90 and 90),
  constraint support_points_lng_check check (lng between -180 and 180),
  constraint support_points_stock_check check (jsonb_typeof(stock) = 'array')
);

create table if not exists public.point_absence_reports (
  point_id uuid not null references public.support_points(id) on delete cascade,
  reporter_hash text not null,
  created_at timestamptz not null default now(),
  primary key (point_id, reporter_hash)
);

create table if not exists public.point_presence_confirmations (
  point_id uuid not null references public.support_points(id) on delete cascade,
  reporter_hash text not null,
  created_at timestamptz not null default now(),
  primary key (point_id, reporter_hash)
);

create table if not exists public.help_needs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  city text not null,
  category text not null,
  title text not null,
  description text not null,
  quantity_text text not null default '',
  meeting_place text not null,
  contact text not null,
  controlled_until timestamptz not null,
  creator_label text not null default '',
  creator_secret_hash text not null,
  status text not null default 'open',
  claimed_count integer not null default 0,
  constraint help_needs_status_check check (status in ('open', 'closed', 'hidden'))
);

create table if not exists public.help_need_claims (
  need_id uuid not null references public.help_needs(id) on delete cascade,
  claimant_hash text not null,
  created_at timestamptz not null default now(),
  primary key (need_id, claimant_hash)
);

alter table public.support_points enable row level security;
alter table public.point_absence_reports enable row level security;
alter table public.point_presence_confirmations enable row level security;
alter table public.help_needs enable row level security;
alter table public.help_need_claims enable row level security;

revoke all on public.support_points from anon, authenticated;
revoke all on public.point_absence_reports from anon, authenticated;
revoke all on public.point_presence_confirmations from anon, authenticated;
revoke all on public.help_needs from anon, authenticated;
revoke all on public.help_need_claims from anon, authenticated;

create or replace function public.kartonka_secret_hash(p_value text)
returns text
language sql
immutable
security definer
set search_path = public, extensions
as $$
  select encode(digest(coalesce(p_value, ''), 'sha256'), 'hex');
$$;

create or replace function public.list_support_points()
returns table (
  id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  name text,
  city text,
  address text,
  lat double precision,
  lng double precision,
  description text,
  services text[],
  stock jsonb,
  controlled_until timestamptz,
  photo_path text,
  status text,
  absence_report_count integer,
  present_confirmation_count integer,
  last_confirmed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.created_at, p.updated_at, p.name, p.city, p.address,
    p.lat, p.lng, p.description, p.services, p.stock, p.controlled_until,
    p.photo_path, p.status, p.absence_report_count,
    p.present_confirmation_count, p.last_confirmed_at
  from public.support_points p
  where p.status = 'active'
    and p.controlled_until > now()
  order by p.updated_at desc;
$$;

create or replace function public.create_support_point(
  p_payload jsonb,
  p_secret text,
  p_photo_path text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid := gen_random_uuid();
  v_until timestamptz;
  v_services text[];
  v_stock jsonb;
begin
  if length(coalesce(p_secret, '')) < 40 then
    raise exception 'Недійсний код керування.';
  end if;
  if coalesce(p_photo_path, '') !~ '^points/' then
    raise exception 'Фото точки обов’язкове.';
  end if;

  v_until := (p_payload->>'controlled_until')::timestamptz;
  if v_until <= now() or v_until > now() + interval '14 days' then
    raise exception 'Час роботи має бути в межах наступних 14 днів.';
  end if;

  if jsonb_typeof(coalesce(p_payload->'services', '[]'::jsonb)) <> 'array' then
    raise exception 'Некоректний список послуг.';
  end if;
  v_services := array(select jsonb_array_elements_text(p_payload->'services'));
  if coalesce(array_length(v_services, 1), 0) = 0 then
    raise exception 'Обери хоча б один тип допомоги.';
  end if;

  v_stock := coalesce(p_payload->'stock', '[]'::jsonb);
  if jsonb_typeof(v_stock) <> 'array' or jsonb_array_length(v_stock) = 0 or jsonb_array_length(v_stock) > 20 then
    raise exception 'Додай від 1 до 20 позицій запасів.';
  end if;

  insert into public.support_points (
    id, name, city, address, lat, lng, description, services, stock,
    controlled_until, photo_path, creator_label, creator_secret_hash
  ) values (
    v_id,
    left(trim(p_payload->>'name'), 100),
    left(trim(p_payload->>'city'), 80),
    left(trim(p_payload->>'address'), 180),
    (p_payload->>'lat')::double precision,
    (p_payload->>'lng')::double precision,
    left(coalesce(trim(p_payload->>'description'), ''), 1000),
    v_services,
    v_stock,
    v_until,
    p_photo_path,
    left(coalesce(trim(p_payload->>'creator_label'), ''), 100),
    public.kartonka_secret_hash(p_secret)
  );

  return v_id;
end;
$$;

create or replace function public.get_owned_support_point(p_point_id uuid, p_secret text)
returns setof public.support_points
language sql
stable
security definer
set search_path = public
as $$
  select * from public.support_points
  where id = p_point_id
    and creator_secret_hash = public.kartonka_secret_hash(p_secret)
  limit 1;
$$;

create or replace function public.update_support_point(
  p_point_id uuid,
  p_secret text,
  p_payload jsonb,
  p_photo_path text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_until timestamptz;
  v_services text[];
  v_stock jsonb;
begin
  if not exists (
    select 1 from public.support_points
    where id = p_point_id
      and creator_secret_hash = public.kartonka_secret_hash(p_secret)
  ) then
    raise exception 'Немає доступу до редагування цієї точки.';
  end if;

  v_until := (p_payload->>'controlled_until')::timestamptz;
  if v_until <= now() or v_until > now() + interval '14 days' then
    raise exception 'Час роботи має бути в межах наступних 14 днів.';
  end if;

  v_services := array(select jsonb_array_elements_text(p_payload->'services'));
  v_stock := coalesce(p_payload->'stock', '[]'::jsonb);
  if coalesce(array_length(v_services, 1), 0) = 0 then
    raise exception 'Обери хоча б один тип допомоги.';
  end if;
  if jsonb_typeof(v_stock) <> 'array' or jsonb_array_length(v_stock) = 0 or jsonb_array_length(v_stock) > 20 then
    raise exception 'Додай від 1 до 20 позицій запасів.';
  end if;

  update public.support_points set
    name = left(trim(p_payload->>'name'), 100),
    city = left(trim(p_payload->>'city'), 80),
    address = left(trim(p_payload->>'address'), 180),
    lat = (p_payload->>'lat')::double precision,
    lng = (p_payload->>'lng')::double precision,
    description = left(coalesce(trim(p_payload->>'description'), ''), 1000),
    services = v_services,
    stock = v_stock,
    controlled_until = v_until,
    photo_path = coalesce(nullif(p_photo_path, ''), photo_path),
    creator_label = left(coalesce(trim(p_payload->>'creator_label'), ''), 100),
    status = 'active',
    absence_report_count = 0,
    last_confirmed_at = now(),
    updated_at = now()
  where id = p_point_id;

  delete from public.point_absence_reports where point_id = p_point_id;
  return true;
end;
$$;

create or replace function public.close_support_point(p_point_id uuid, p_secret text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.support_points
  set status = 'closed', controlled_until = least(controlled_until, now()), updated_at = now()
  where id = p_point_id
    and creator_secret_hash = public.kartonka_secret_hash(p_secret);
  if not found then raise exception 'Немає доступу до цієї точки.'; end if;
  return true;
end;
$$;

create or replace function public.report_point_absent(p_point_id uuid, p_reporter_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text := public.kartonka_secret_hash('absence:' || coalesce(p_reporter_key, ''));
  v_count integer;
  v_inserted integer := 0;
  v_hidden boolean := false;
begin
  if length(coalesce(p_reporter_key, '')) < 5 then raise exception 'Не вдалося визначити користувача.'; end if;
  if not exists (select 1 from public.support_points where id = p_point_id and status = 'active') then
    raise exception 'Точка вже неактивна.';
  end if;

  insert into public.point_absence_reports(point_id, reporter_hash)
  values (p_point_id, v_hash)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  select count(*) into v_count from public.point_absence_reports where point_id = p_point_id;
  if v_count >= 20 then
    update public.support_points set status = 'hidden', absence_report_count = v_count where id = p_point_id;
    v_hidden := true;
  else
    update public.support_points set absence_report_count = v_count where id = p_point_id;
  end if;

  return jsonb_build_object('accepted', v_inserted = 1, 'count', v_count, 'hidden', v_hidden);
end;
$$;

create or replace function public.confirm_point_present(p_point_id uuid, p_reporter_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text := public.kartonka_secret_hash('presence:' || coalesce(p_reporter_key, ''));
  v_count integer;
  v_inserted integer := 0;
begin
  if length(coalesce(p_reporter_key, '')) < 5 then raise exception 'Не вдалося визначити користувача.'; end if;
  if not exists (select 1 from public.support_points where id = p_point_id and status = 'active') then
    raise exception 'Точка вже неактивна.';
  end if;

  insert into public.point_presence_confirmations(point_id, reporter_hash)
  values (p_point_id, v_hash)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  select count(*) into v_count from public.point_presence_confirmations where point_id = p_point_id;
  update public.support_points
  set present_confirmation_count = v_count,
      last_confirmed_at = case when v_inserted = 1 then now() else last_confirmed_at end
  where id = p_point_id;

  return jsonb_build_object('accepted', v_inserted = 1, 'count', v_count);
end;
$$;

create or replace function public.list_help_needs()
returns table (
  id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  city text,
  category text,
  title text,
  description text,
  quantity_text text,
  meeting_place text,
  controlled_until timestamptz,
  status text,
  claimed_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.created_at, n.updated_at, n.city, n.category, n.title,
         n.description, n.quantity_text, n.meeting_place, n.controlled_until,
         n.status, n.claimed_count
  from public.help_needs n
  where n.status = 'open' and n.controlled_until > now()
  order by n.updated_at desc;
$$;

create or replace function public.create_help_need(p_payload jsonb, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid := gen_random_uuid();
  v_until timestamptz;
begin
  if length(coalesce(p_secret, '')) < 40 then raise exception 'Недійсний код керування.'; end if;
  v_until := (p_payload->>'controlled_until')::timestamptz;
  if v_until <= now() or v_until > now() + interval '7 days' then
    raise exception 'Потреба має бути актуальною в межах наступних 7 днів.';
  end if;

  insert into public.help_needs (
    id, city, category, title, description, quantity_text, meeting_place,
    contact, controlled_until, creator_label, creator_secret_hash
  ) values (
    v_id,
    left(trim(p_payload->>'city'), 80),
    left(trim(p_payload->>'category'), 40),
    left(trim(p_payload->>'title'), 120),
    left(trim(p_payload->>'description'), 1200),
    left(coalesce(trim(p_payload->>'quantity_text'), ''), 120),
    left(trim(p_payload->>'meeting_place'), 180),
    left(trim(p_payload->>'contact'), 120),
    v_until,
    left(coalesce(trim(p_payload->>'creator_label'), ''), 100),
    public.kartonka_secret_hash(p_secret)
  );
  return v_id;
end;
$$;

create or replace function public.get_owned_help_need(p_need_id uuid, p_secret text)
returns setof public.help_needs
language sql
stable
security definer
set search_path = public
as $$
  select * from public.help_needs
  where id = p_need_id
    and creator_secret_hash = public.kartonka_secret_hash(p_secret)
  limit 1;
$$;

create or replace function public.update_help_need(p_need_id uuid, p_secret text, p_payload jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_until timestamptz;
begin
  if not exists (
    select 1 from public.help_needs
    where id = p_need_id and creator_secret_hash = public.kartonka_secret_hash(p_secret)
  ) then raise exception 'Немає доступу до цієї потреби.'; end if;

  v_until := (p_payload->>'controlled_until')::timestamptz;
  if v_until <= now() or v_until > now() + interval '7 days' then
    raise exception 'Потреба має бути актуальною в межах наступних 7 днів.';
  end if;

  update public.help_needs set
    city = left(trim(p_payload->>'city'), 80),
    category = left(trim(p_payload->>'category'), 40),
    title = left(trim(p_payload->>'title'), 120),
    description = left(trim(p_payload->>'description'), 1200),
    quantity_text = left(coalesce(trim(p_payload->>'quantity_text'), ''), 120),
    meeting_place = left(trim(p_payload->>'meeting_place'), 180),
    contact = left(trim(p_payload->>'contact'), 120),
    controlled_until = v_until,
    creator_label = left(coalesce(trim(p_payload->>'creator_label'), ''), 100),
    status = 'open',
    updated_at = now()
  where id = p_need_id;
  return true;
end;
$$;

create or replace function public.close_help_need(p_need_id uuid, p_secret text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.help_needs
  set status = 'closed', controlled_until = least(controlled_until, now()), updated_at = now()
  where id = p_need_id
    and creator_secret_hash = public.kartonka_secret_hash(p_secret);
  if not found then raise exception 'Немає доступу до цієї потреби.'; end if;
  return true;
end;
$$;

create or replace function public.claim_help_need(p_need_id uuid, p_claimant_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text := public.kartonka_secret_hash('claim:' || coalesce(p_claimant_key, ''));
  v_contact text;
  v_count integer;
  v_inserted integer := 0;
begin
  if length(coalesce(p_claimant_key, '')) < 5 then raise exception 'Не вдалося визначити користувача.'; end if;

  select contact into v_contact from public.help_needs
  where id = p_need_id and status = 'open' and controlled_until > now();
  if not found then raise exception 'Потреба вже неактивна.'; end if;

  insert into public.help_need_claims(need_id, claimant_hash)
  values (p_need_id, v_hash)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  select count(*) into v_count from public.help_need_claims where need_id = p_need_id;
  update public.help_needs set claimed_count = v_count where id = p_need_id;

  return jsonb_build_object('accepted', v_inserted = 1, 'count', v_count, 'contact', v_contact);
end;
$$;

-- Доступ лише через перевірені RPC-функції.
revoke all on function public.kartonka_secret_hash(text) from public;
revoke all on function public.list_support_points() from public;
revoke all on function public.create_support_point(jsonb, text, text) from public;
revoke all on function public.get_owned_support_point(uuid, text) from public;
revoke all on function public.update_support_point(uuid, text, jsonb, text) from public;
revoke all on function public.close_support_point(uuid, text) from public;
revoke all on function public.report_point_absent(uuid, text) from public;
revoke all on function public.confirm_point_present(uuid, text) from public;
revoke all on function public.list_help_needs() from public;
revoke all on function public.create_help_need(jsonb, text) from public;
revoke all on function public.get_owned_help_need(uuid, text) from public;
revoke all on function public.update_help_need(uuid, text, jsonb) from public;
revoke all on function public.close_help_need(uuid, text) from public;
revoke all on function public.claim_help_need(uuid, text) from public;

grant execute on function public.list_support_points() to anon, authenticated;
grant execute on function public.create_support_point(jsonb, text, text) to anon, authenticated;
grant execute on function public.get_owned_support_point(uuid, text) to anon, authenticated;
grant execute on function public.update_support_point(uuid, text, jsonb, text) to anon, authenticated;
grant execute on function public.close_support_point(uuid, text) to anon, authenticated;
grant execute on function public.report_point_absent(uuid, text) to anon, authenticated;
grant execute on function public.confirm_point_present(uuid, text) to anon, authenticated;
grant execute on function public.list_help_needs() to anon, authenticated;
grant execute on function public.create_help_need(jsonb, text) to anon, authenticated;
grant execute on function public.get_owned_help_need(uuid, text) to anon, authenticated;
grant execute on function public.update_help_need(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.close_help_need(uuid, text) to anon, authenticated;
grant execute on function public.claim_help_need(uuid, text) to anon, authenticated;

-- Публічне сховище фотографій із лімітом 5 МБ та лише зображеннями.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'point-photos',
  'point-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "kartonka_point_photo_upload" on storage.objects;
create policy "kartonka_point_photo_upload"
on storage.objects
for insert
to anon, authenticated
with check (
  bucket_id = 'point-photos'
  and (storage.foldername(name))[1] = 'points'
  and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
);
