-- ============================================================================
-- ПОЛНЫЙ РЕМОНТ ТАБЛИЦЫ ЗАКАЗОВ — запустить в Supabase SQL Editor
-- ============================================================================

-- 1. Убираем NOT NULL если стоит
ALTER TABLE public.orders ALTER COLUMN num DROP NOT NULL;

-- 2. Заполняем num значением id у заказов, где num пустой
UPDATE public.orders SET num = id WHERE num IS NULL;

-- 3. Создаём последовательность и выставляем её на текущий максимум
CREATE SEQUENCE IF NOT EXISTS public.orders_num_seq;
SELECT setval('public.orders_num_seq', (SELECT COALESCE(MAX(num), 0) FROM public.orders));

-- 4. Автозаполнение num для новых заказов
ALTER TABLE public.orders
  ALTER COLUMN num SET DEFAULT nextval('public.orders_num_seq'::regclass);

-- 5. Открываем доступ для роли anon (без этого POST возвращает 404/403)
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO anon;
GRANT USAGE ON SEQUENCE public.orders_num_seq TO anon;

-- 6. Открываем RLS-политику
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "open" ON public.orders;
CREATE POLICY "open" ON public.orders FOR ALL USING (true) WITH CHECK (true);

-- 7. Обновляем кэш схемы PostgREST
NOTIFY pgrst, 'reload schema';
