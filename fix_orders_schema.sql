-- ============================================================================
-- ПОЛНЫЙ РЕМОНТ ТАБЛИЦЫ ЗАКАЗОВ — запустить ОДИН раз
-- Supabase Dashboard → SQL Editor → New query → вставить весь файл → Run
-- ============================================================================
-- Судя по ошибкам в консоли (column "delivery_cost" missing, column
-- "subtotal" missing, статус 404), в таблице orders нет части колонок,
-- а API Supabase (PostgREST) держит устаревший кэш схемы. Этот скрипт:
--   1) создаёт таблицу orders, если её нет;
--   2) добавляет ВСЕ недостающие колонки;
--   3) настраивает авто-нумерацию заказов (num: 1, 2, 3…);
--   4) включает открытые RLS-политики (как у остальных таблиц);
--   5) принудительно обновляет кэш схемы API (NOTIFY pgrst).
-- Скрипт идемпотентен — повторный запуск безопасен.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.orders (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS num              bigint,
  ADD COLUMN IF NOT EXISTS customer_name    text,
  ADD COLUMN IF NOT EXISTS customer_phone   text,
  ADD COLUMN IF NOT EXISTS customer_email   text,
  ADD COLUMN IF NOT EXISTS company          text,
  ADD COLUMN IF NOT EXISTS items            jsonb   DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS subtotal         numeric,
  ADD COLUMN IF NOT EXISTS delivery_cost    numeric,
  ADD COLUMN IF NOT EXISTS total_price      numeric,
  ADD COLUMN IF NOT EXISTS delivery_method  text    DEFAULT 'courier',
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS delivery_date    text,
  ADD COLUMN IF NOT EXISTS delivery_time    text,
  ADD COLUMN IF NOT EXISTS payment_method   text    DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS invoice_company  text,
  ADD COLUMN IF NOT EXISTS invoice_inn      text,
  ADD COLUMN IF NOT EXISTS comment          text,
  ADD COLUMN IF NOT EXISTS status           text    DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS language         text    DEFAULT 'ru',
  ADD COLUMN IF NOT EXISTS user_id          uuid;

-- ── Авто-нумерация заказов (1, 2, 3…) ───────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.orders_num_seq START WITH 1;

-- Убираем NOT NULL с num, если оно было (сайт не передаёт num — его даёт БД)
DO $$ BEGIN
  ALTER TABLE public.orders ALTER COLUMN num DROP NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$
DECLARE
  v_type text;
  v_max  bigint := 0;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'num';

  -- Продолжаем нумерацию с максимального уже существующего номера
  BEGIN
    EXECUTE 'SELECT coalesce(max(num::bigint), 0) FROM public.orders WHERE num::text ~ ''^[0-9]+$''' INTO v_max;
  EXCEPTION WHEN others THEN v_max := 0; END;
  IF v_max > 0 THEN PERFORM setval('public.orders_num_seq', v_max); END IF;

  IF v_type IN ('bigint', 'integer', 'smallint', 'numeric') THEN
    EXECUTE 'ALTER TABLE public.orders ALTER COLUMN num SET DEFAULT nextval(''public.orders_num_seq'')';
  ELSIF v_type IN ('text', 'character varying') THEN
    EXECUTE 'ALTER TABLE public.orders ALTER COLUMN num SET DEFAULT nextval(''public.orders_num_seq'')::text';
  END IF;
END $$;

-- ── RLS: открытые политики, как у остальных таблиц сайта ────────────────────
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "open" ON public.orders;
CREATE POLICY "open" ON public.orders FOR ALL USING (true) WITH CHECK (true);

-- ── ВАЖНО: обновляем кэш схемы API ──────────────────────────────────────────
-- Без этого Supabase может ещё несколько минут «не видеть» добавленные
-- колонки и продолжать отдавать ошибки 400/404 на вставку заказов.
NOTIFY pgrst, 'reload schema';
