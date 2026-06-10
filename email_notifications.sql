-- ============================================================================
-- EMAIL-УВЕДОМЛЕНИЯ ПОКУПАТЕЛЯМ О СТАТУСЕ ЗАКАЗА
-- ============================================================================
--
-- Как это работает: когда вы меняете статус заказа в админке, база Supabase
-- сама отправляет покупателю письмо на email, указанный в заказе. Письма
-- уходят через российский сервис NotiSend (notisend.ru) — бесплатный тариф
-- подходит для старта.
--
-- КАК ПОДКЛЮЧИТЬ (один раз, ~10 минут):
--
-- 1. Зарегистрируйтесь на https://notisend.ru (бесплатно).
--
-- 2. Подтвердите адрес отправителя: в кабинете NotiSend →
--    «Настройки» → «Адреса отправителей» → добавьте ваш email
--    (например nurmuhamedovsa@gmail.com) → подтвердите по письму.
--    Письма покупателям будут приходить «от» этого адреса.
--
-- 3. Получите API-токен: в кабинете NotiSend → «Настройки» → «API» →
--    скопируйте токен.
--
-- 4. В ЭТОМ файле замените два плейсхолдера:
--    - ВСТАВЬ_ТОКЕН_NOTISEND  → токен из шага 3
--    - ВСТАВЬ_EMAIL_ОТПРАВИТЕЛЯ → подтверждённый адрес из шага 2
--
-- 5. Запустите весь файл в Supabase: Dashboard → SQL Editor → New query →
--    вставить → Run.
--
-- 6. Проверка: создайте тестовый заказ со своим email, смените ему статус
--    в админке — письмо должно прийти в течение минуты.
--
-- ВАЖНО: токен живёт ТОЛЬКО внутри функций БД (security definer).
-- В код сайта и в репозиторий он не попадает.
-- ============================================================================

-- pg_net — отправка HTTP-запросов прямо из Postgres (есть в Supabase)
create extension if not exists pg_net;

-- ── Уборка: удаляем объекты Telegram-варианта, если он был установлен ──────
drop trigger  if exists trg_tg_notify_order_status  on public.orders;
drop trigger  if exists trg_tg_notify_order_created on public.orders;
drop function if exists public.tg_notify_order_status();
drop function if exists public.tg_notify_order_created();
drop function if exists public.telegram_webhook(jsonb);
drop function if exists public._tg_send(bigint, text);
drop function if exists public._tg_token();
drop function if exists public._tg_secret();
drop table    if exists public.tg_subscribers;
alter table public.settings drop column if exists tg_bot;

-- ── Секреты (только внутри БД) ──────────────────────────────────────────────
create or replace function public._email_token()
returns text language sql security definer set search_path = public
as $$ select 'ВСТАВЬ_ТОКЕН_NOTISEND'::text $$;

create or replace function public._email_sender()
returns text language sql security definer set search_path = public
as $$ select 'nurmuhamedovsa@gmail.com'::text $$;

revoke all on function public._email_token()  from public, anon, authenticated;
revoke all on function public._email_sender() from public, anon, authenticated;

-- ── Отправка письма через NotiSend (асинхронно, через pg_net) ───────────────
create or replace function public._email_send(p_to text, p_subject text, p_html text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform net.http_post(
    url     := 'https://api.notisend.ru/v1/email/messages',
    body    := jsonb_build_object(
      'from_email', public._email_sender(),
      'from_name',  'Клевер',
      'to',         p_to,
      'subject',    p_subject,
      'html',       p_html
    ),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || public._email_token()
    )
  );
end $$;

revoke all on function public._email_send(text, text, text) from public, anon, authenticated;

-- ── Шаблон письма в фирменном стиле ─────────────────────────────────────────
create or replace function public._email_order_html(
  p_num text, p_title text, p_body text
)
returns text language sql immutable
as $$
  select '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f2f7f4;font-family:Arial,Helvetica,sans-serif;">'
    || '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f7f4;padding:24px 12px;"><tr><td align="center">'
    || '<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;">'
    || '<tr><td style="background:#0f1a14;padding:20px 28px;">'
    ||   '<span style="font-size:20px;font-weight:bold;color:#ffffff;">🍀 <span style="color:#C8F135;">Клевер</span></span>'
    || '</td></tr>'
    || '<tr><td style="padding:28px;">'
    ||   '<div style="font-size:13px;color:#8aaa94;margin-bottom:6px;">Заказ #' || p_num || '</div>'
    ||   '<div style="font-size:20px;font-weight:bold;color:#1a2e22;margin-bottom:14px;">' || p_title || '</div>'
    ||   '<div style="font-size:14px;color:#3a5a44;line-height:1.6;margin-bottom:22px;">' || p_body || '</div>'
    ||   '<a href="https://fixxx-dev.github.io/my-prototype2/order-status.html?num=' || p_num || '" '
    ||     'style="display:inline-block;background:#2ECC71;color:#0f1a14;text-decoration:none;font-weight:bold;'
    ||     'font-size:14px;padding:12px 26px;border-radius:30px;">Проверить заказ →</a>'
    || '</td></tr>'
    || '<tr><td style="padding:18px 28px;border-top:1px solid #e8f4ec;font-size:12px;color:#8aaa94;line-height:1.6;">'
    ||   'Вопросы? Звоните: 8 (812) 922-86-77<br>«Клевер» — хозтовары и бытовая химия, Санкт-Петербург'
    || '</td></tr>'
    || '</table></td></tr></table></body></html>'
$$;

-- ── Триггер: статус заказа изменился → письмо покупателю ────────────────────
create or replace function public.email_notify_order_status()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_num   text;
  v_title text;
  v_body  text;
begin
  if new.status is not distinct from old.status then return new; end if;
  if coalesce(new.customer_email, '') !~ '@' then return new; end if;

  v_num := coalesce(new.num::text, left(new.id::text, 8));

  select t.title, t.body into v_title, v_body from (values
    ('new',        'Заказ принят в обработку 🕐', 'Мы получили ваш заказ и скоро начнём его собирать.'),
    ('assembling', 'Заказ собирается 📦',         'Ваш заказ уже собирают на складе. Сообщим, когда он будет готов.'),
    ('courier',    'Заказ передан курьеру 🚚',    'Ваш заказ передан курьеру и уже едет к вам.'),
    ('ready',      'Заказ готов к выдаче ✅',     'Ваш заказ собран и ждёт вас в пункте выдачи. Ждём вас!'),
    ('done',       'Заказ доставлен ✅',          'Ваш заказ доставлен. Спасибо за покупку — будем рады видеть вас снова!'),
    ('issued',     'Заказ выдан ✅',              'Ваш заказ выдан. Спасибо за покупку — будем рады видеть вас снова!'),
    ('cancelled',  'Заказ отменён ❌',            'Ваш заказ отменён. Если это ошибка — позвоните нам: 8 (812) 922-86-77.')
  ) as t(status, title, body)
  where t.status = new.status;

  if v_title is null then return new; end if;

  perform public._email_send(
    new.customer_email,
    'Клевер: заказ #' || v_num || ' — ' || v_title,
    public._email_order_html(v_num, v_title, v_body)
  );
  return new;
end $$;

drop trigger if exists trg_email_notify_order_status on public.orders;
create trigger trg_email_notify_order_status
  after update of status on public.orders
  for each row execute function public.email_notify_order_status();

-- ── Новый заказ → подтверждение на почту ────────────────────────────────────
create or replace function public.email_notify_order_created()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_num text;
begin
  if coalesce(new.customer_email, '') !~ '@' then return new; end if;
  v_num := coalesce(new.num::text, left(new.id::text, 8));

  perform public._email_send(
    new.customer_email,
    'Клевер: заказ #' || v_num || ' принят 🍀',
    public._email_order_html(
      v_num,
      'Спасибо за заказ!',
      'Мы получили ваш заказ на сумму <strong>' || coalesce(new.total_price, 0)::text
        || ' ₽</strong> и свяжемся с вами в течение 30 минут для подтверждения.<br><br>'
        || 'Когда статус заказа изменится — пришлём письмо.'
    )
  );
  return new;
end $$;

drop trigger if exists trg_email_notify_order_created on public.orders;
create trigger trg_email_notify_order_created
  after insert on public.orders
  for each row execute function public.email_notify_order_created();
