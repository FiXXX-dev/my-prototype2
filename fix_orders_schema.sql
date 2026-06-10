-- ============================================================================
-- ИСПРАВЛЕНИЕ: авто-нумерация заказов
-- ============================================================================
-- Проблема: колонка num была объявлена NOT NULL без значения по умолчанию.
-- При оформлении заказа сайт не передаёт num (он должен назначаться БД),
-- Postgres отклонял вставку → заказ не появлялся ни в админке, ни в ЛК.
--
-- Запустите один раз: Supabase Dashboard → SQL Editor → New query → Run.
-- ============================================================================

-- 1. Создаём последовательность для порядковых номеров заказов (1, 2, 3…)
CREATE SEQUENCE IF NOT EXISTS public.orders_num_seq START WITH 1;

-- 2. Убираем ограничение NOT NULL (если есть) — DO-блок не падает, если уже nullable
DO $$
BEGIN
  ALTER TABLE public.orders ALTER COLUMN num DROP NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

-- 3. Устанавливаем DEFAULT из последовательности с учётом типа колонки
DO $$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'orders'
    AND column_name  = 'num';

  IF v_type IN ('bigint', 'integer', 'int8', 'int4', 'numeric') THEN
    EXECUTE 'ALTER TABLE public.orders ALTER COLUMN num SET DEFAULT nextval(''public.orders_num_seq'')';
  ELSIF v_type IN ('text', 'character varying', 'varchar') THEN
    EXECUTE 'ALTER TABLE public.orders ALTER COLUMN num SET DEFAULT (nextval(''public.orders_num_seq'')::text)';
  END IF;
END $$;
