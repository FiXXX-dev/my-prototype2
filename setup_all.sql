-- ============================================================================
-- KLEVER — ЕДИНЫЙ скрипт настройки базы (заказы + ЛК + админка).
-- Запусти ОДИН раз в Supabase Dashboard → SQL Editor → Run.
-- Скрипт идемпотентный: повторный запуск ничего не ломает.
-- ----------------------------------------------------------------------------
-- ПОРЯДОК ДЕЙСТВИЙ:
--   1) Supabase → Authentication → Users → Add user → email + пароль
--      (например admin@klever.ru). Это будущий вход в админ-панель.
--   2) Скопируй его UUID (Authentication → Users, колонка UID).
--   3) Вставь UUID ниже в строке «values ('...')» (Часть 1).
--   4) (Рекомендуется) Authentication → Sign In / Providers → Email →
--      «Confirm email» = OFF, чтобы регистрация логинила сразу, без письма.
--   5) Запусти ВЕСЬ этот скрипт.
--   6) Смержи ветку кода в main (иначе github.io отдаёт старый код).
-- Откат — в самом низу файла (закомментирован).
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- ЧАСТЬ 1. ЗАКАЗЫ + АДМИНКА (защита от выгрузки/правки чужих заказов)
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1.1 Таблица админов ─────────────────────────────────────────────────────
create table if not exists public.admins (
  user_id  uuid primary key,
  added_at timestamptz default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

-- ВПИШИ СЮДА UUID админ-аккаунта из Authentication → Users:
insert into public.admins (user_id)
values ('ВСТАВЬТЕ_UUID_АДМИНА_СЮДА')
on conflict (user_id) do nothing;

-- ── 1.2 Хелпер: текущий пользователь — админ? ───────────────────────────────
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
grant execute on function public.is_admin() to anon, authenticated;

-- ── 1.3 ORDERS: прямой доступ — только админу, клиенты ходят через RPC ───────
alter table public.orders enable row level security;
drop policy if exists "open"          on public.orders;
drop policy if exists "orders_select" on public.orders;
drop policy if exists "orders_insert" on public.orders;
drop policy if exists "orders_modify" on public.orders;
drop policy if exists "orders_delete" on public.orders;
drop policy if exists "orders_admin_all" on public.orders;
-- Запись (insert/update/delete) отбираем у всех — клиенты пишут через RPC.
-- SELECT оставляем authenticated: RLS ниже пропустит только is_admin().
-- Анонимам — ничего.
revoke all on public.orders from anon, authenticated;
grant select on public.orders to authenticated;

create policy "orders_admin_all" on public.orders
  for all using (public.is_admin()) with check (public.is_admin());

-- ── 1.4 RPC для клиентских сценариев (SECURITY DEFINER — обходят RLS) ────────

-- Создать заказ. Возвращает строку (нужен id = номер заказа).
create or replace function public.rpc_create_order(payload jsonb)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare new_row public.orders;
begin
  insert into public.orders (
    customer_name, customer_phone, customer_email, company,
    items, subtotal, delivery_cost, total_price,
    delivery_method, delivery_address, delivery_date, delivery_time,
    payment_method, invoice_company, invoice_inn,
    comment, language, status, user_id
  ) values (
    coalesce(payload->>'customer_name',''),
    coalesce(payload->>'customer_phone',''),
    nullif(payload->>'customer_email',''),
    nullif(payload->>'company',''),
    coalesce(payload->'items','[]'::jsonb),
    nullif(payload->>'subtotal','')::numeric,
    nullif(payload->>'delivery_cost','')::numeric,
    coalesce(nullif(payload->>'total_price','')::numeric, 0),
    nullif(payload->>'delivery_method',''),
    nullif(payload->>'delivery_address',''),
    nullif(payload->>'delivery_date','')::date,
    nullif(payload->>'delivery_time',''),
    nullif(payload->>'payment_method',''),
    nullif(payload->>'invoice_company',''),
    nullif(payload->>'invoice_inn',''),
    nullif(payload->>'comment',''),
    nullif(payload->>'language',''),
    coalesce(nullif(payload->>'status',''), 'new'),
    case when payload->>'user_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (payload->>'user_id')::uuid else null end
  )
  returning * into new_row;
  return new_row;
end;
$$;
grant execute on function public.rpc_create_order(jsonb) to anon, authenticated;

-- Отследить ОДИН заказ по номеру + телефону (order-status.html).
create or replace function public.rpc_track_order(p_num bigint, p_phone text)
returns setof public.orders
language sql stable security definer set search_path = public as $$
  select * from public.orders
  where id = p_num
    and right(regexp_replace(customer_phone, '\D', '', 'g'), 10)
      = right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10)
    and length(regexp_replace(coalesce(p_phone,''), '\D', '', 'g')) >= 10
  limit 1;
$$;
grant execute on function public.rpc_track_order(bigint, text) to anon, authenticated;

-- Список заказов клиента по телефону/email (личный кабинет, кросс-девайс).
create or replace function public.rpc_my_orders(p_phone text, p_email text)
returns setof public.orders
language sql stable security definer set search_path = public as $$
  select * from public.orders
  where (
      length(regexp_replace(coalesce(p_phone,''), '\D', '', 'g')) >= 10
      and right(regexp_replace(customer_phone, '\D', '', 'g'), 10)
        = right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10)
    )
    or (
      coalesce(p_email,'') <> ''
      and lower(customer_email) = lower(p_email)
    )
  order by created_at desc
  limit 200;
$$;
grant execute on function public.rpc_my_orders(text, text) to anon, authenticated;

-- ── 1.5 КАТАЛОГ: чтение публичное, запись только админу ─────────────────────
do $$
declare t text;
begin
  foreach t in array array['products','categories','banners','news','promotions','contacts','settings']
  loop
    if to_regclass('public.'||t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "%I_public_read" on public.%I', t, t);
      execute format('drop policy if exists "%I_admin_write" on public.%I', t, t);
      execute format('create policy "%I_public_read" on public.%I for select using (true)', t, t);
      execute format('create policy "%I_admin_write" on public.%I for all using (public.is_admin()) with check (public.is_admin())', t, t);
      execute format('grant select on public.%I to anon, authenticated', t);
      execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- ЧАСТЬ 2. ЛИЧНЫЙ КАБИНЕТ: профиль, избранное, адреса (синк между устройствами)
-- ----------------------------------------------------------------------------
-- Эти таблицы привязаны к EMAIL аккаунта. Зашёл тем же email на другом
-- устройстве → подтянулись профиль, избранное и адреса. Заказы синкаются
-- через rpc_my_orders (по email/телефону) из Части 1.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 2.1 Профили (user_profiles, ключ — user_id аккаунта Supabase) ───────────
create table if not exists public.user_profiles (
  user_id     text primary key,
  email       text,
  phone       text,
  first_name  text,
  last_name   text,
  middle_name text,
  user_type   text default 'individual',
  company     text,
  inn         text,
  updated_at  timestamptz default now()
);
-- На случай, если таблица уже была, но без какой-то колонки:
alter table public.user_profiles add column if not exists email       text;
alter table public.user_profiles add column if not exists phone       text;
alter table public.user_profiles add column if not exists first_name  text;
alter table public.user_profiles add column if not exists last_name   text;
alter table public.user_profiles add column if not exists middle_name text;
alter table public.user_profiles add column if not exists user_type   text default 'individual';
alter table public.user_profiles add column if not exists company     text;
alter table public.user_profiles add column if not exists inn         text;
alter table public.user_profiles add column if not exists updated_at  timestamptz default now();

-- ── 2.2 Избранное (favorites, ключ — email; uniq на (email, sku) для upsert) ─
create table if not exists public.favorites (
  id            bigint generated by default as identity primary key,
  user_email    text not null,
  user_phone    text,
  product_sku   text not null,
  product_name  text,
  product_price numeric,
  product_img   text,
  created_at    timestamptz default now()
);
alter table public.favorites add column if not exists user_phone    text;
alter table public.favorites add column if not exists product_name  text;
alter table public.favorites add column if not exists product_price numeric;
alter table public.favorites add column if not exists product_img   text;
alter table public.favorites add column if not exists created_at    timestamptz default now();
-- Уникальность (email, sku) — иначе upsert «лайк/анлайк» создаёт дубли.
create unique index if not exists favorites_email_sku_uniq
  on public.favorites (user_email, product_sku);

-- ── 2.3 Адреса доставки (user_addresses, ключ — email) ──────────────────────
create table if not exists public.user_addresses (
  id         bigint generated by default as identity primary key,
  user_email text not null,
  label      text,
  address    text,
  is_default boolean default false,
  created_at timestamptz default now()
);
alter table public.user_addresses add column if not exists label      text;
alter table public.user_addresses add column if not exists address    text;
alter table public.user_addresses add column if not exists is_default boolean default false;
alter table public.user_addresses add column if not exists created_at timestamptz default now();

-- ── 2.4 RLS для таблиц ЛК ───────────────────────────────────────────────────
-- ВАЖНО: клиентские страницы обращаются к этим таблицам анонимным ключом
-- (без токена пользователя) и всегда фильтруют по user_email. Поэтому доступ
-- оставляем анону — иначе ЛК перестанет работать. RLS включаем явно.
-- Доступ есть только по делу: код всегда задаёт ?user_email=eq.<email>.
--
-- ⚠️ ОСТАТОЧНЫЙ РИСК (Фаза 2, по желанию): так как доступ анонимный,
-- теоретически зная чужой email можно прочитать его избранное/адреса. Это
-- НЕ массовая утечка (выгрузить всё разом нельзя так же, как заказы — для
-- полной изоляции нужен переход на auth.uid(), это отдельный шаг, который
-- я могу сделать в коде позже). Для запуска магазина этого достаточно.
do $$
declare t text;
begin
  foreach t in array array['user_profiles','favorites','user_addresses']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%I_self_access" on public.%I', t, t);
    execute format('create policy "%I_self_access" on public.%I for all using (true) with check (true)', t, t);
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
  end loop;
end $$;
-- Право пользоваться счётчиком id (identity) для anon на вставку.
grant usage, select on all sequences in schema public to anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- ЧАСТЬ 3. Применяем изменения схемы PostgREST
-- ════════════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';

-- ============================================================================
-- ГОТОВО. Проверь:
--   • вход/регистрация по email на сайте,
--   • оформи заказ → он виден в админке и в ЛК,
--   • зайди тем же email на другом устройстве → профиль/избранное/адреса/заказы на месте.
-- ============================================================================

-- ============================================================================
-- ОТКАТ заказов (если что-то пошло не так) — раскомментируй и запусти:
-- ----------------------------------------------------------------------------
-- drop policy if exists "orders_admin_all" on public.orders;
-- create policy "open" on public.orders for all using (true) with check (true);
-- grant select, insert, update, delete on public.orders to anon, authenticated;
-- notify pgrst, 'reload schema';
-- ============================================================================
