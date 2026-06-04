-- ============================================================================
-- Clever — настройка таблиц «Новости» и «Настройки» в Supabase
-- Запустите этот SQL один раз в Supabase → SQL editor.
-- После выполнения новости и настройки (включая пункты самовывоза) будут
-- храниться в базе и автоматически попадать на сайт через GitHub Action
-- (news.json / settings.json), как это уже сделано для акций и товаров.
-- ============================================================================

-- ─── НОВОСТИ (public.news) ──────────────────────────────────────────────────
create table if not exists public.news (
  id          bigint generated always as identity primary key,
  title       text not null default '',
  text        text not null default '',
  color       text not null default 'green',   -- green | orange | blue
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- На случай, если таблица уже была создана без каких-то колонок:
alter table public.news add column if not exists title      text    not null default '';
alter table public.news add column if not exists text       text    not null default '';
alter table public.news add column if not exists color      text    not null default 'green';
alter table public.news add column if not exists is_active  boolean not null default true;
alter table public.news add column if not exists sort_order integer not null default 0;
alter table public.news add column if not exists created_at timestamptz not null default now();

alter table public.news enable row level security;
drop policy if exists "news_open" on public.news;
create policy "news_open" on public.news for all using (true) with check (true);

-- ─── НАСТРОЙКИ (public.settings, одна строка id = 1) ────────────────────────
create table if not exists public.settings (
  id               integer primary key default 1,
  phone1           text,
  phone2           text,
  email            text,
  address          text,
  min_order        integer default 5000,
  free_delivery    integer default 0,
  delivery_cost    integer default 0,
  whatsapp         text,
  telegram         text,
  max_link         text,
  pickup_locations jsonb   default '[]'::jsonb,   -- [{id,name,address,hours}, ...]
  updated_at       timestamptz default now()
);

alter table public.settings add column if not exists phone1           text;
alter table public.settings add column if not exists phone2           text;
alter table public.settings add column if not exists email            text;
alter table public.settings add column if not exists address          text;
alter table public.settings add column if not exists min_order        integer default 5000;
alter table public.settings add column if not exists free_delivery    integer default 0;
alter table public.settings add column if not exists delivery_cost    integer default 0;
alter table public.settings add column if not exists whatsapp         text;
alter table public.settings add column if not exists telegram         text;
alter table public.settings add column if not exists max_link         text;
alter table public.settings add column if not exists pickup_locations jsonb default '[]'::jsonb;
alter table public.settings add column if not exists updated_at       timestamptz default now();

alter table public.settings enable row level security;
drop policy if exists "settings_open" on public.settings;
create policy "settings_open" on public.settings for all using (true) with check (true);

-- Создаём строку настроек по умолчанию (id = 1), если её ещё нет.
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- Обновляем кэш схемы PostgREST, чтобы новые таблицы/колонки сразу были видны.
notify pgrst, 'reload schema';
