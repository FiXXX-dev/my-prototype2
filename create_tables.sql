-- ============================================================================
-- Clever HoReCa — синхронизация ЛК между браузерами/устройствами
-- ----------------------------------------------------------------------------
-- ВЫПОЛНИ ЭТОТ SQL в Supabase Dashboard → SQL Editor → New query → Run.
-- Все операторы идемпотентны (IF NOT EXISTS), повторный запуск безопасен.
--
-- Создаёт три таблицы:
--   favorites       — избранные товары пользователя (ключ: email/телефон + sku)
--   user_addresses  — сохранённые адреса доставки (ключ: email/телефон)
--   user_profiles   — профиль (имя, контакты, компания) с ключом user_id
--
-- Ключ user_email хранит email пользователя, а для пользователей,
-- зарегистрированных только по телефону — строку вида 'tel:9991234567'
-- (нормализованные последние 10 цифр). Это даёт стабильный ключ
-- независимо от устройства/браузера.
-- ============================================================================

-- ---------- ИЗБРАННОЕ ----------
CREATE TABLE IF NOT EXISTS public.favorites (
  id           bigint generated always as identity primary key,
  user_email   text not null,
  user_phone   text,
  product_sku  text not null,
  created_at   timestamptz not null default timezone('utc'::text, now()),
  UNIQUE (user_email, product_sku)
);
-- Кэш данных товара — добавлено для работы без localStorage в новых браузерах
ALTER TABLE public.favorites ADD COLUMN IF NOT EXISTS product_name  text;
ALTER TABLE public.favorites ADD COLUMN IF NOT EXISTS product_price numeric;
ALTER TABLE public.favorites ADD COLUMN IF NOT EXISTS product_img   text;
CREATE INDEX IF NOT EXISTS favorites_user_email_idx ON public.favorites (user_email);

-- ---------- АДРЕСА ДОСТАВКИ ----------
CREATE TABLE IF NOT EXISTS public.user_addresses (
  id          bigint generated always as identity primary key,
  user_email  text not null,
  label       text not null,
  address     text not null,
  is_default  boolean default false,
  created_at  timestamptz not null default timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS user_addresses_user_email_idx ON public.user_addresses (user_email);

-- ---------- ПРОФИЛЬ ----------
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id           bigint generated always as identity primary key,
  user_id      text unique not null,
  email        text,
  phone        text,
  first_name   text,
  last_name    text,
  middle_name  text,
  user_type    text default 'individual',
  company      text,
  inn          text,
  created_at   timestamptz not null default timezone('utc'::text, now()),
  updated_at   timestamptz not null default timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS user_profiles_email_idx ON public.user_profiles (email);

-- ============================================================================
-- RLS: приложение использует анонимный ключ и собственную (не Supabase-Auth)
-- модель идентификации по email/телефону, поэтому политики открытые —
-- так же, как у таблицы orders. При необходимости ужесточи под свою модель.
-- ============================================================================
ALTER TABLE public.favorites      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "open" ON public.favorites;
CREATE POLICY "open" ON public.favorites      FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "open" ON public.user_addresses;
CREATE POLICY "open" ON public.user_addresses FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "open" ON public.user_profiles;
CREATE POLICY "open" ON public.user_profiles  FOR ALL USING (true) WITH CHECK (true);
