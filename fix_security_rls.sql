-- ============================================================================
-- БЕЗОПАСНОСТЬ: закрываем прямой доступ к заказам, переводим админку на Auth
-- ============================================================================
-- ВАЖНО ПРО ПОРЯДОК ЗАПУСКА:
--   1) Сначала создайте админ-аккаунт в Supabase: Authentication → Users →
--      Add user → email + пароль (например admin@klever.ru). Подтвердите email.
--   2) Узнайте его UUID (в таблице Authentication → Users, колонка UID).
--   3) Влейте новый код сайта в main (ветка claude/intelligent-hamilton-XVgUy).
--   4) Запустите ЭТОТ скрипт, ПОДСТАВИВ uid админа в строку INSERT ниже.
--   После этого старый код (на анонимном ключе) читать заказы уже НЕ сможет —
--   поэтому шаги 3 и 4 делаются вместе.
-- Откат — в самом низу файла (закомментирован).
-- ============================================================================

-- ── 1. Таблица админов ──────────────────────────────────────────────────────
create table if not exists public.admins (
  user_id uuid primary key,
  added_at timestamptz default now()
);
alter table public.admins enable row level security;
-- Никто из клиентов не должен читать/менять список админов напрямую.
revoke all on public.admins from anon, authenticated;

-- ВПИШИТЕ СЮДА UUID вашего админ-аккаунта из Authentication → Users:
insert into public.admins (user_id)
values ('64e76962-3dcd-4f64-a282-b59158f10d1a')
on conflict (user_id) do nothing;

-- ── 2. Хелпер: текущий пользователь — админ? ────────────────────────────────
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
grant execute on function public.is_admin() to anon, authenticated;

-- ── 3. ORDERS: полностью закрываем прямой доступ ────────────────────────────
alter table public.orders enable row level security;

-- Сносим все старые открытые политики.
drop policy if exists "open"            on public.orders;
drop policy if exists "orders_select"   on public.orders;
drop policy if exists "orders_insert"   on public.orders;
drop policy if exists "orders_modify"   on public.orders;
drop policy if exists "orders_delete"   on public.orders;

-- Прямой доступ к таблице — ТОЛЬКО админу. Клиенты ходят через RPC (см. ниже).
create policy "orders_admin_all" on public.orders
  for all using (public.is_admin()) with check (public.is_admin());

-- Анонимам и обычным юзерам прямые права на таблицу не нужны (работают RPC).
revoke all on public.orders from anon, authenticated;

-- ── 4. RPC для клиентских сценариев (SECURITY DEFINER — обходят RLS внутри) ──

-- 4.1 Создать заказ (оформление). Возвращает созданную строку (нужен id = номер).
create or replace function public.rpc_create_order(payload jsonb)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  new_row public.orders;
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
    -- user_id принимаем только если это валидный uuid
    case when payload->>'user_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (payload->>'user_id')::uuid else null end
  )
  returning * into new_row;
  return new_row;
end;
$$;
grant execute on function public.rpc_create_order(jsonb) to anon, authenticated;

-- 4.2 Отследить ОДИН заказ по номеру (id) + телефону. Для order-status.html.
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

-- 4.3 Список заказов клиента по телефону/email. Для личного кабинета.
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

-- ── 5. КАТАЛОГ: чтение публичное, запись только админу ──────────────────────
-- Применяется к каждой существующей таблице (пропускаем отсутствующие).
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
      -- Чтение оставляем анону, запись — только через политику админа.
      execute format('grant select on public.%I to anon, authenticated', t);
      execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- ── 6. Обновляем кэш схемы PostgREST ────────────────────────────────────────
notify pgrst, 'reload schema';

-- ============================================================================
-- ПРИМЕЧАНИЕ: таблицы favorites и user_addresses в этой фазе НЕ трогаем —
-- они остаются доступными анону (Фаза 2). Основной риск (массовая выгрузка и
-- изменение/удаление заказов) этим скриптом закрыт.
-- ============================================================================

-- ============================================================================
-- ОТКАТ (если что-то сломалось) — раскомментируйте и запустите:
-- ----------------------------------------------------------------------------
-- drop policy if exists "orders_admin_all" on public.orders;
-- create policy "open" on public.orders for all using (true) with check (true);
-- grant select, insert, update, delete on public.orders to anon, authenticated;
-- notify pgrst, 'reload schema';
-- ============================================================================
