-- ============================================================================
-- ИТОГОВЫЙ РЕМОНТ НОМЕРОВ ЗАКАЗОВ — запустить в Supabase SQL Editor
-- ============================================================================
-- Предыдущие скрипты устанавливали DEFAULT через сложные DO-блоки,
-- которые молча завершались без ошибки, но DEFAULT так и не ставили.
-- Этот скрипт действует напрямую, без вложенных блоков.
-- ============================================================================

-- 1. Создаём последовательность
CREATE SEQUENCE IF NOT EXISTS public.orders_num_seq START WITH 1;

-- 2. Убираем NOT NULL если есть
ALTER TABLE public.orders ALTER COLUMN num DROP NOT NULL;

-- 3. Ставим DEFAULT (для колонки bigint — самый распространённый случай)
ALTER TABLE public.orders
  ALTER COLUMN num SET DEFAULT nextval('public.orders_num_seq'::regclass);

-- 4. Заполняем порядковыми номерами все заказы, у которых num = null
UPDATE public.orders
  SET num = nextval('public.orders_num_seq'::regclass)
WHERE num IS NULL;

-- 5. Обновляем кэш схемы API (убирает ошибку 404)
NOTIFY pgrst, 'reload schema';
