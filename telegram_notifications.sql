-- ============================================================================
-- УВЕДОМЛЕНИЯ ПОКУПАТЕЛЯМ В TELEGRAM ПРИ СМЕНЕ СТАТУСА ЗАКАЗА
-- ============================================================================
--
-- КАК ПОДКЛЮЧИТЬ (один раз, ~10 минут):
--
-- 1. Создайте бота: откройте в Telegram @BotFather → /newbot →
--    придумайте имя (например «Клевер — статус заказа») и username
--    (например klever_orders_bot). BotFather пришлёт ТОКЕН вида
--    1234567890:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-pk
--
-- 2. В этом файле замените ДВА плейсхолдера:
--    - ВСТАВЬ_ТОКЕН_БОТА        → токен из BotFather
--    - ВСТАВЬ_СЛУЧАЙНУЮ_СТРОКУ  → любая случайная строка (латиница/цифры,
--      например: kl3v3r_x91m2qp7). Она защищает вебхук от подделки.
--
-- 3. Запустите ВЕСЬ файл в Supabase: Dashboard → SQL Editor → New query →
--    вставить → Run.
--
-- 4. Включите вебхук: откройте в браузере ссылку (замените ТОКЕН и СТРОКУ
--    на те же значения, что в шаге 2):
--
--    https://api.telegram.org/botВСТАВЬ_ТОКЕН_БОТА/setWebhook?url=https%3A%2F%2Ffquhoxxcucgesxrexsjn.supabase.co%2Frest%2Fv1%2Frpc%2Ftelegram_webhook%3Fapikey%3DeyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZxdWhveHhjdWNnZXN4cmV4c2puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzM5MDYsImV4cCI6MjA5NTQ0OTkwNn0.z09KuaZ1ybuURb46iWl9Ef-HT2gbecw8Wjw3oFJl9wI&secret_token=ВСТАВЬ_СЛУЧАЙНУЮ_СТРОКУ
--
--    Должно ответить: {"ok":true,...,"description":"Webhook was set"}
--
-- 5. В админке сайта: Настройки → «Telegram-бот уведомлений» → введите
--    username бота (klever_orders_bot) → Сохранить.
--
-- ВАЖНО: токен живёт ТОЛЬКО внутри функций БД (security definer).
-- В код сайта и в репозиторий он не попадает.
-- ============================================================================

-- pg_net — отправка HTTP-запросов прямо из Postgres (есть в Supabase)
create extension if not exists pg_net;

-- ── Подписчики: телефон (последние 10 цифр) → Telegram chat_id ─────────────
create table if not exists public.tg_subscribers (
  phone      text primary key,          -- последние 10 цифр номера
  chat_id    bigint not null,
  name       text default '',
  created_at timestamptz not null default now()
);

-- Закрываем таблицу от прямого доступа из браузера: RLS без политик =
-- доступ только у функций security definer (они работают от владельца).
alter table public.tg_subscribers enable row level security;

-- ── Секреты (только внутри БД) ──────────────────────────────────────────────
create or replace function public._tg_token()
returns text language sql security definer set search_path = public
as $$ select 'ВСТАВЬ_ТОКЕН_БОТА'::text $$;

create or replace function public._tg_secret()
returns text language sql security definer set search_path = public
as $$ select 'ВСТАВЬ_СЛУЧАЙНУЮ_СТРОКУ'::text $$;

revoke all on function public._tg_token()  from public, anon, authenticated;
revoke all on function public._tg_secret() from public, anon, authenticated;

-- ── Отправка сообщения в Telegram (асинхронно через pg_net) ────────────────
create or replace function public._tg_send(p_chat bigint, p_text text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform net.http_post(
    url     := 'https://api.telegram.org/bot' || public._tg_token() || '/sendMessage',
    body    := jsonb_build_object('chat_id', p_chat, 'text', p_text),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end $$;

revoke all on function public._tg_send(bigint, text) from public, anon, authenticated;

-- ── Вебхук: Telegram присылает сюда каждое сообщение боту ───────────────────
-- Один безымянный jsonb-параметр => PostgREST передаёт сырое тело запроса.
create or replace function public.telegram_webhook(jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_msg    jsonb;
  v_chat   bigint;
  v_txt    text;
  v_name   text;
  v_phone  text;
begin
  -- Проверяем секретный заголовок: запрос точно от Telegram
  if coalesce((current_setting('request.headers', true))::json
       ->> 'x-telegram-bot-api-secret-token', '') <> public._tg_secret() then
    return '{"ok": false}'::jsonb;
  end if;

  v_msg := $1 -> 'message';
  if v_msg is null then return '{"ok": true}'::jsonb; end if;

  v_chat := (v_msg -> 'chat' ->> 'id')::bigint;
  v_txt  := coalesce(v_msg ->> 'text', '');
  v_name := coalesce(v_msg -> 'from' ->> 'first_name', '');

  if v_txt = '/stop' then
    delete from public.tg_subscribers t where t.chat_id = v_chat;
    perform public._tg_send(v_chat,
      'Уведомления отключены. Чтобы включить снова — отправьте свой номер телефона.');
    return '{"ok": true}'::jsonb;
  end if;

  -- Телефон берём из /start <цифры> (кнопка на сайте) или из обычного
  -- сообщения с номером (если человек написал боту напрямую).
  v_phone := right(regexp_replace(v_txt, '\D', '', 'g'), 10);

  if length(v_phone) = 10 then
    insert into public.tg_subscribers as t (phone, chat_id, name)
      values (v_phone, v_chat, v_name)
      on conflict (phone) do update set chat_id = excluded.chat_id, name = excluded.name;
    perform public._tg_send(v_chat,
      '✅ Готово! Буду присылать вам статус заказов, оформленных на номер +7 '
      || v_phone || '. Отключить уведомления: /stop');
  else
    perform public._tg_send(v_chat,
      'Здравствуйте! Это бот магазина «Клевер» 🍀' || E'\n\n'
      || 'Отправьте номер телефона, который вы указываете при оформлении заказа '
      || '(например: +7 912 345-67-89) — и я буду присылать вам уведомления, '
      || 'когда статус заказа изменится.');
  end if;

  return '{"ok": true}'::jsonb;
end $$;

grant execute on function public.telegram_webhook(jsonb) to anon;

-- ── Триггер: статус заказа изменился → сообщение покупателю ─────────────────
create or replace function public.tg_notify_order_status()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_phone text;
  v_chat  bigint;
  v_num   text;
  v_label text;
begin
  if new.status is not distinct from old.status then return new; end if;

  v_phone := right(regexp_replace(coalesce(new.customer_phone, ''), '\D', '', 'g'), 10);
  if length(v_phone) < 10 then return new; end if;

  select t.chat_id into v_chat from public.tg_subscribers t where t.phone = v_phone;
  if v_chat is null then return new; end if;

  v_num := coalesce(new.num::text, left(new.id::text, 8));
  v_label := case new.status
    when 'new'        then '🕐 принят и обрабатывается'
    when 'assembling' then '📦 собирается на складе'
    when 'courier'    then '🚚 передан курьеру — уже едет к вам'
    when 'ready'      then '✅ готов к выдаче — ждём вас!'
    when 'done'       then '✅ доставлен. Спасибо за покупку! 🍀'
    when 'issued'     then '✅ выдан. Спасибо за покупку! 🍀'
    when 'cancelled'  then '❌ отменён. Если это ошибка — позвоните нам'
    else new.status
  end;

  perform public._tg_send(v_chat, '🍀 Клевер: ваш заказ #' || v_num || ' ' || v_label);
  return new;
end $$;

drop trigger if exists trg_tg_notify_order_status on public.orders;
create trigger trg_tg_notify_order_status
  after update of status on public.orders
  for each row execute function public.tg_notify_order_status();

-- ── Новый заказ от уже подписанного клиента → подтверждение ────────────────
create or replace function public.tg_notify_order_created()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_phone text;
  v_chat  bigint;
  v_num   text;
begin
  v_phone := right(regexp_replace(coalesce(new.customer_phone, ''), '\D', '', 'g'), 10);
  if length(v_phone) < 10 then return new; end if;

  select t.chat_id into v_chat from public.tg_subscribers t where t.phone = v_phone;
  if v_chat is null then return new; end if;

  v_num := coalesce(new.num::text, left(new.id::text, 8));
  perform public._tg_send(v_chat,
    '🍀 Клевер: заказ #' || v_num || ' на сумму '
    || coalesce(new.total_price, 0)::text
    || ' ₽ принят! Сообщу, когда статус изменится.');
  return new;
end $$;

drop trigger if exists trg_tg_notify_order_created on public.orders;
create trigger trg_tg_notify_order_created
  after insert on public.orders
  for each row execute function public.tg_notify_order_created();

-- ── Колонка для username бота в настройках сайта ────────────────────────────
alter table public.settings add column if not exists tg_bot text default '';
