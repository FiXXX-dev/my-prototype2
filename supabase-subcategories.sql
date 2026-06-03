-- ============================================================
-- Клевер — таблица подкатегорий (дерево каталога в Supabase)
-- Запустить ОДИН раз в Supabase → SQL Editor.
-- Категории (categories) уже есть; здесь добавляем subcategories.
-- ============================================================

create table if not exists public.subcategories (
  category_id text not null,
  id          text not null,
  name        text not null,
  image_url   text,
  sort_order  int  default 0,
  primary key (category_id, id)
);

alter table public.subcategories enable row level security;

-- Публичное чтение + запись (как у остальных таблиц проекта).
-- При необходимости ужесточите политику записи под свою модель доступа.
drop policy if exists "subcategories read"  on public.subcategories;
drop policy if exists "subcategories write" on public.subcategories;
create policy "subcategories read"  on public.subcategories for select using (true);
create policy "subcategories write" on public.subcategories for all    using (true) with check (true);

-- После выполнения SQL:
-- откройте админку → вкладка «Категории» → кнопка «Синхр. в Supabase»,
-- чтобы залить текущее дерево (категории + подкатегории) в БД.
