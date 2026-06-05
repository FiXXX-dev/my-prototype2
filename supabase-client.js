// ===== Clever × Supabase integration =====
// Drop-in client wrapper for orders.
// PASTE YOUR PROJECT CREDENTIALS BELOW (replacing the placeholders).
// Until both placeholders are replaced, every helper returns null/ok:false
// and the calling code transparently falls back to localStorage.
//
// Required SQL schema (run in Supabase SQL editor):
//   create table public.orders (
//     id              uuid primary key default gen_random_uuid(),
//     num             bigint not null,
//     created_at      timestamptz not null default now(),
//     customer_name   text,
//     customer_phone  text,
//     customer_email  text,
//     company         text,
//     items           jsonb default '[]'::jsonb,
//     subtotal        numeric,
//     delivery_cost   numeric,
//     total_price     numeric,
//     delivery_method text,
//     delivery_address text,
//     payment_method  text,
//     invoice_company text,
//     invoice_inn     text,
//     comment         text,
//     status          text default 'new',
//     language        text default 'ru',
//     user_id         uuid references auth.users(id) on delete set null
//   );
//   alter table public.orders enable row level security;
//   -- (RLS policies — adjust to your auth model; for demo: full access)
//   create policy "open" on public.orders for all using (true) with check (true);

const SUPABASE_URL = 'https://fquhoxxcucgesxrexsjn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZxdWhveHhjdWNnZXN4cmV4c2puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzM5MDYsImV4cCI6MjA5NTQ0OTkwNn0.z09KuaZ1ybuURb46iWl9Ef-HT2gbecw8Wjw3oFJl9wI';

(function(){
  function isConfigured(){
    return typeof SUPABASE_URL === 'string'
        && SUPABASE_URL.indexOf('ВСТАВЬ') < 0
        && SUPABASE_URL.startsWith('http')
        && typeof SUPABASE_ANON_KEY === 'string'
        && SUPABASE_ANON_KEY.indexOf('ВСТАВЬ') < 0
        && SUPABASE_ANON_KEY.length > 20;
  }

  let _client = null;
  function getClient(){
    if (_client) return _client;
    if (!isConfigured()) return null;
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      console.warn('[supabase] CDN not loaded yet');
      return null;
    }
    _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    // Экспортируем живой клиент для отладки из консоли (window.supabaseClient).
    // ВНИМАНИЕ: window.supabase — это SDK-библиотека (createClient и т.п.),
    // а window.supabaseClient — уже созданный экземпляр клиента БД.
    try { window.supabaseClient = _client; } catch (e) {}
    return _client;
  }

  // Обрыв зависшего fetch с понятной причиной. Некоторые браузеры не
  // поддерживают abort(reason) — тогда обычный abort() (message будет родной).
  function _abort(ctrl) {
    try { ctrl.abort(new Error('Сервер не ответил вовремя (медленный интернет). Повторите попытку.')); }
    catch (e) { try { ctrl.abort(); } catch (e2) {} }
  }

  // ─── _pgGet: простой GET без CORS preflight ──────────────────────────────
  // Supabase JS SDK добавляет заголовки apikey / Authorization / x-client-info,
  // из-за которых браузер отправляет OPTIONS preflight. В сетях с DPI (ТСПУ РФ)
  // preflight к *.supabase.co блокируется → ERR_CONNECTION_RESET.
  // Решение: apikey передаём query-параметром (так же, как в адресной строке),
  // без кастомных заголовков — preflight не нужен, запрос «простой».
  async function _pgGet(table, qp) {
    if (!isConfigured()) return null;
    const url = new URL(SUPABASE_URL + '/rest/v1/' + table);
    url.searchParams.set('apikey', SUPABASE_ANON_KEY);
    Object.entries(qp || {}).forEach(([k, v]) => url.searchParams.append(k, v));
    // Таймаут: если соединение зависло (DPI/медленная сеть), обрываем и даём
    // слою выше повторить, а не ждём минутами OS-таймаут TCP. На мобильных и
    // throttled-сетях запросы к *.supabase.co идут медленно — берём 25с.
    const ctrl = new AbortController();
    const timer = setTimeout(() => _abort(ctrl), 25000);
    try {
      const resp = await fetch(url.toString(), { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      if (!resp.ok) throw Object.assign(new Error('HTTP ' + resp.status), { status: resp.status });
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // POST/PATCH/DELETE для RPC и записей — plain fetch (без SDK-заголовков).
  // extraHeaders позволяет добавить, напр., Prefer: return=representation.
  async function _pgPost(path, body, method, extraHeaders) {
    if (!isConfigured()) return null;
    const url = new URL(SUPABASE_URL + '/rest/v1/' + path);
    url.searchParams.set('apikey', SUPABASE_ANON_KEY);
    const ctrl = new AbortController();
    const timer = setTimeout(() => _abort(ctrl), 30000);
    try {
      const resp = await fetch(url.toString(), {
        method: method || 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', Accept: 'application/json', apikey: SUPABASE_ANON_KEY },
          extraHeaders || {}
        ),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const m = err.message || err.hint || err.details || ('Ошибка сервера (код ' + resp.status + ')');
        throw Object.assign(new Error(m), { status: resp.status, supaError: err });
      }
      return resp.status === 204 ? null : await resp.json().catch(() => null);
    } finally { clearTimeout(timer); }
  }

  // _pgPost с повтором — на DPI/медленных сетях первый POST часто обрывается.
  async function _pgPostRetry(path, body, method, extraHeaders, tries) {
    const max = tries || 4;
    let lastErr = null;
    for (let i = 0; i < max; i++) {
      if (i) await new Promise(r => setTimeout(r, i * 1000));
      try { return await _pgPost(path, body, method, extraHeaders); }
      catch (e) {
        lastErr = e;
        // Ошибки уровня БД (а не сети) повторять бессмысленно — пробрасываем сразу.
        if (e && e.status && e.status >= 400 && e.status < 500) throw e;
      }
    }
    throw lastErr || new Error('request failed');
  }

  // ─── Универсальные write-хелперы (plain fetch + retry, без SDK-заголовков) ──
  // Переносят надёжность fix'а заказов на все операции записи в админке:
  // лёгкий запрос (нет Authorization/x-client-info) + повтор при обрыве (DPI).
  // filter — это «сырая» query-строка PostgREST, напр. 'id=eq.5' или 'num=eq.7'.

  function _writeErr(e) { return { ok: false, error: (e && e.supaError) || e }; }

  async function _pgInsert(table, rows) {
    try {
      const data = await _pgPostRetry(table, Array.isArray(rows) ? rows : [rows], 'POST',
        { Prefer: 'return=representation' });
      return { ok: true, data: Array.isArray(data) ? data[0] : data, all: data || [] };
    } catch (e) { return _writeErr(e); }
  }

  async function _pgUpsert(table, rows, onConflict) {
    const path = table + (onConflict ? ('?on_conflict=' + encodeURIComponent(onConflict)) : '');
    try {
      const data = await _pgPostRetry(path, Array.isArray(rows) ? rows : [rows], 'POST',
        { Prefer: 'resolution=merge-duplicates,return=representation' });
      return { ok: true, data: Array.isArray(data) ? data[0] : data, all: data || [] };
    } catch (e) { return _writeErr(e); }
  }

  // Upsert, перебирающий несколько вариантов on_conflict, пока один не совпадёт
  // с реальным уникальным ограничением таблицы. Нужен, т.к. PK таблицы
  // subcategories может быть как `id`, так и составной `(category_id,id)`.
  async function _pgUpsertAny(table, rows, conflictTargets) {
    let last = null;
    for (let i = 0; i < conflictTargets.length; i++) {
      const r = await _pgUpsert(table, rows, conflictTargets[i]);
      if (r.ok) return r;
      last = r;
      const msg = '' + (r.error && (r.error.message || r.error.hint || r.error.details) || '');
      // Переходим к следующему варианту только если дело именно в ON CONFLICT.
      if (!/ON CONFLICT|unique or exclusion/i.test(msg)) return r;
    }
    return last || { ok:false, error:{ message:'upsert failed' } };
  }

  async function _pgUpdate(table, filter, fields) {
    try {
      const data = await _pgPostRetry(table + '?' + filter, fields, 'PATCH',
        { Prefer: 'return=representation' });
      return { ok: true, data: Array.isArray(data) ? data[0] : data, all: data || [] };
    } catch (e) { return _writeErr(e); }
  }

  async function _pgDelete(table, filter, returnRep) {
    try {
      const data = await _pgPostRetry(table + '?' + filter, undefined, 'DELETE',
        returnRep ? { Prefer: 'return=representation' } : undefined);
      return { ok: true, all: Array.isArray(data) ? data : [] };
    } catch (e) { return _writeErr(e); }
  }

  // _pgGet с повтором: на сетях с DPI первая попытка иногда обрывается даже
  // у «простого» запроса. Делаем до 3 попыток с задержкой 0/0.8/1.6с.
  async function _pgGetRetry(table, qp, tries) {
    const max = tries || 4;
    let lastErr = null;
    for (let i = 0; i < max; i++) {
      if (i) await new Promise(r => setTimeout(r, i * 1000));
      try { return await _pgGet(table, qp); }
      catch (e) {
        lastErr = e;
        // Ответ сервера с кодом 4xx (кроме сетевых обрывов) повторять не нужно.
        if (e && e.status && e.status >= 400 && e.status < 500) throw e;
      }
    }
    throw lastErr || new Error('request failed');
  }

  // Запрашивает обновление статических JSON на github.io через Supabase RPC
  // (хранит GitHub-токен внутри БД — в браузерный код не попадает).
  // Требует: create function public.request_catalog_sync() + grant execute to anon.
  window.supaRequestSync = async function () {
    try {
      await _pgPost('rpc/request_catalog_sync', {});
      console.log('[supabase] catalog sync triggered');
    } catch (e) {
      console.warn('[supabase] sync request failed (not critical)', e && e.message);
    }
  };

  // Быстрая диагностика: await window.supaPing()
  window.supaPing = async function(){
    if (!isConfigured()) return { ok:false, error:'не настроен' };
    try {
      const data = await _pgGet('products', { select: 'sku', limit: '1' });
      return { ok:true, count: Array.isArray(data) ? data.length : 0 };
    } catch(e) {
      return { ok:false, error: (e && e.message) || String(e),
               hint:'ERR_CONNECTION_RESET → DPI блокирует CORS preflight к supabase.co' };
    }
  };

  // ===== Orders =====

  // Insert order. The "row" object below is built from a flexible payload so
  // it works against minimal schemas. We try once with the rich payload; on
  // Postgres "column X does not exist" error (PGRST204 / 42703 / undefined
  // column message) we automatically retry with the minimal set of columns
  // that match the user's documented schema:
  //   customer_name, customer_phone, items, total_price, language
  // That guarantees the insert lands even if your table is bare-minimal,
  // and uses the extra columns automatically if they exist.
  window.supaInsertOrder = async function(order){
    if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
    let language = 'ru';
    try { language = localStorage.getItem('klever_lang') || 'ru'; } catch(e){}

    // Columns that must always be present — never stripped.
    const REQUIRED = new Set(['customer_name','customer_phone','items','total_price']);

    function isMissingColumnError(error){
      const msg = (error?.message || '') + ' ' + (error?.details || '');
      return /column .* does not exist/i.test(msg)
          || /Could not find/i.test(msg)
          || error?.code === '42703'
          || error?.code === 'PGRST204';
    }

    // Extract the offending column name from a missing-column error so we can
    // strip only THAT column and retry — this preserves delivery_method,
    // payment_method, delivery_address, etc. as long as they exist in the schema.
    function missingColName(error){
      const msg = error?.message || '';
      const m = msg.match(/column ["'`]?(\w+)["'`]? (?:of relation|does not exist)/i)
             || msg.match(/Could not find .*?["'`](\w+)["'`]/i)
             || msg.match(/["'`](\w+)["'`] is not present in the table/i);
      return m ? m[1] : null;
    }

    const fullRow = {
      customer_name: order.name || '',
      customer_phone: order.phone || '',
      items: order.items || [],
      total_price: order.total != null ? Number(order.total) : 0,
      language: language,
      comment: order.comment || '',
      num: order.num,
      status: order.status || 'new',
      customer_email: order.email || '',
      company: order.company || '',
      subtotal: order.subtotal != null ? Number(order.subtotal) : null,
      delivery_cost: order.delivery != null ? Number(order.delivery) : null,
      delivery_method: order.method || 'courier',
      delivery_address: order.address || '',
      delivery_date: order.deliveryDate || null,
      delivery_time: order.deliveryTime || null,
      payment_method: order.payment || 'cash',
      invoice_company: order.invoiceCompany || null,
      invoice_inn: order.invoiceInn || null,
      user_id: order.userId || null,
    };

    // Recursively retry, removing the offending column on each missing-column error.
    // Uses plain-fetch _pgPostRetry (NO CORS preflight) so the insert lands even on
    // DPI/ТСПУ networks that block the SDK's OPTIONS request ("Failed to fetch").
    async function tryInsert(row) {
      try {
        const data = await _pgPostRetry('orders', [row], 'POST', { Prefer: 'return=representation' });
        return { ok: true, data: Array.isArray(data) ? data[0] : data };
      } catch (e) {
        const error = (e && e.supaError) || e || {};
        if (!isMissingColumnError(error)) {
          console.error('[supabase] insert error', error);
          return { ok: false, error };
        }
        const col = missingColName(error);
        if (!col || REQUIRED.has(col)) {
          console.error('[supabase] cannot strip required column or unknown col', error);
          return { ok: false, error };
        }
        const stripped = { ...row };
        delete stripped[col];
        console.warn(`[supabase] column "${col}" missing — retrying without it`);
        return tryInsert(stripped);
      }
    }

    try {
      return await tryInsert(fullRow);
    } catch (e) {
      console.error('[supabase] insert exception', e);
      return { ok: false, error: e };
    }
  };

  // Returns orders mapped to the legacy admin shape so existing renderers work.
  window.supaListOrders = async function(){
    if (!isConfigured()) return null;
    try {
      const data = await _pgGetRetry('orders', { select: '*', order: 'created_at.desc' });
      if (!Array.isArray(data)) return null;
      return data.map(r => ({
        // Display id: prefer the supplied "num" column, fall back to the
        // Supabase row id so admin never shows "#undefined". This also makes
        // bare-minimal schemas (only id+5 fields) display nicely as #1, #2…
        num: r.num != null ? r.num : r.id,
        id: r.id,
        date: r.created_at ? new Date(r.created_at).toLocaleDateString('ru-RU') : '',
        status: r.status || 'new',
        items: Array.isArray(r.items) ? r.items : [],
        subtotal: r.subtotal,
        delivery: r.delivery_cost,
        total: r.total_price != null ? Number(r.total_price) : 0,
        method: r.delivery_method,
        address: r.delivery_address || '',
        deliveryDate: r.delivery_date || '',
        deliveryTime: r.delivery_time || '',
        phone: r.customer_phone || '',
        name: r.customer_name || '',
        company: r.company || '',
        email: r.customer_email || '',
        comment: r.comment || '',
        payment: r.payment_method,
        invoiceCompany: r.invoice_company || '',
        invoiceInn: r.invoice_inn || '',
        language: r.language,
        _supaId: r.id,
      }));
    } catch (e) {
      console.error('[supabase] list exception', e);
      return null;
    }
  };

  // Update by num if the column exists; otherwise retry by id (PK).
  // Also retries by id when num exists but no row matched (e.g. the order
  // was inserted without a num value and the admin is holding the UUID).
  window.supaUpdateOrder = async function(numOrId, fields){
    if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
    function missing(error){
      const m = (error?.message||'') + ' ' + (error?.details||'');
      return /column .* does not exist/i.test(m) || /Could not find/i.test(m)
          || error?.code === '42703' || error?.code === 'PGRST204';
    }
    // Update by num first; retry by id if num column missing OR 0 rows matched.
    let r = await _pgUpdate('orders', 'num=eq.' + encodeURIComponent(numOrId), fields);
    if ((!r.ok && missing(r.error)) || (r.ok && (!r.all || r.all.length === 0))) {
      r = await _pgUpdate('orders', 'id=eq.' + encodeURIComponent(numOrId), fields);
    }
    if (!r.ok) console.error('[supabase] update error', r.error);
    return r.ok ? { ok: true, data: r.all } : { ok: false, error: r.error };
  };

  window.supaDeleteOrder = async function(numOrId){
    if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
    function missing(error){
      const m = (error?.message||'') + ' ' + (error?.details||'');
      return /column .* does not exist/i.test(m) || /Could not find/i.test(m)
          || error?.code === '42703' || error?.code === 'PGRST204';
    }
    // return=representation lets us know whether a row was actually deleted.
    let r = await _pgDelete('orders', 'num=eq.' + encodeURIComponent(numOrId), true);
    if ((!r.ok && missing(r.error)) || (r.ok && (!r.all || r.all.length === 0))) {
      r = await _pgDelete('orders', 'id=eq.' + encodeURIComponent(numOrId), true);
    }
    if (!r.ok) console.error('[supabase] delete error', r.error);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };

  window.supaDeleteAllOrders = async function(){
    if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
    // neq on an always-set column avoids PostgREST's no-WHERE-clause guard.
    const r = await _pgDelete('orders', 'id=neq.00000000-0000-0000-0000-000000000000');
    if (!r.ok) console.error('[supabase] delete-all error', r.error);
    return r;
  };

  // Returns orders for a specific user (for account history page).
  // opts = { phone, email } — matched alongside user_id in a single OR query.
  // Phone is matched with ilike+* so +7/8/no-code formats all hit.
  // ВАЖНО: читаем через _pgGet (простой GET, без CORS preflight) — иначе на
  // сетях с DPI (ТСПУ РФ) запрос периодически рвётся и «Личный кабинет» то
  // грузит данные, то нет на разных устройствах.
  window.supaListOrdersByUser = async function(userId, opts){
    if (!isConfigured()) return null;
    const mapRow = r => ({
      num: r.num != null ? r.num : r.id,
      id: r.id,
      date: r.created_at ? new Date(r.created_at).toLocaleDateString('ru-RU') : '',
      status: r.status || 'new',
      items: Array.isArray(r.items) ? r.items : [],
      subtotal: r.subtotal,
      delivery: r.delivery_cost,
      total: r.total_price != null ? Number(r.total_price) : 0,
      method: r.delivery_method,
      address: r.delivery_address || '',
      deliveryDate: r.delivery_date || '',
      deliveryTime: r.delivery_time || '',
      phone: r.customer_phone || '',
      name: r.customer_name || '',
      company: r.company || '',
      email: r.customer_email || '',
      comment: r.comment || '',
      payment: r.payment_method,
      invoiceCompany: r.invoice_company || '',
      invoiceInn: r.invoice_inn || '',
      language: r.language,
      _supaId: r.id,
    });
    // Normalize phone to last 10 digits so +7/8/no-code all match via ilike.
    const phone = ((opts && opts.phone) || '').replace(/\D/g, '').slice(-10);
    const email = ((opts && opts.email) || '').toLowerCase().trim();

    // PostgREST использует * как wildcard в ilike (в URL), а не %.
    function buildOr(withUserId) {
      const f = [];
      if (withUserId && userId) f.push(`user_id.eq.${userId}`);
      if (phone) f.push(`customer_phone.ilike.*${phone}*`);
      if (email) f.push(`customer_email.ilike.*${email}*`);
      return f;
    }

    async function fetchWith(withUserId) {
      const filters = buildOr(withUserId);
      if (!filters.length) return [];
      return _pgGetRetry('orders', { select: '*', or: '(' + filters.join(',') + ')', order: 'created_at.desc' });
    }

    try {
      let data;
      try {
        data = await fetchWith(true);
      } catch (e) {
        // Если колонки user_id нет в старой схеме (400) — повторяем без неё.
        if (e && e.status === 400 && userId) data = await fetchWith(false);
        else throw e;
      }
      // Deduplicate (OR may return duplicates if multiple filters hit one row).
      const seen = new Set();
      const rows = [];
      for (const r of (Array.isArray(data) ? data : [])) {
        if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
      }
      return rows.map(mapRow);
    } catch (e) {
      console.error('[supabase] list orders by user', e);
      return null;
    }
  };

  // Optional realtime subscription for admin (returns an unsubscribable channel).
  window.supaSubscribeOrders = function(onChange){
    const sb = getClient();
    if (!sb) return null;
    try {
      const ch = sb.channel('clever-orders')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' },
            payload => { if (typeof onChange === 'function') onChange(payload); })
        .subscribe();
      return ch;
    } catch (e) {
      console.warn('[supabase] realtime subscribe failed', e);
      return null;
    }
  };

  // ===== Auth =====
  window.supaSignUp = async function(email, password, meta){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: meta || {} } });
      if (error) return { ok:false, error };
      return { ok:true, user: data.user, session: data.session };
    } catch(e) { return { ok:false, error:e }; }
  };

  window.supaSignIn = async function(email, password){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return { ok:false, error };
      return { ok:true, user: data.user, session: data.session };
    } catch(e) { return { ok:false, error:e }; }
  };

  window.supaSignOut = async function(){
    // ВАЖНО: scope:'local' — выход без сетевого запроса к серверу. Глобальный
    // signOut() шлёт POST на /auth/v1/logout, который на DPI/ТСПУ-сетях рвётся,
    // и сессия остаётся в localStorage → пользователь «не может выйти».
    const sb = getClient();
    let ok = false;
    if (sb) {
      try { const { error } = await sb.auth.signOut({ scope: 'local' }); ok = !error; }
      catch(e) {}
    }
    // Подчищаем токен Supabase из localStorage напрямую — на случай, если SDK
    // по какой-то причине его не удалил (тогда boot снова бы залогинил).
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^sb-.*-auth-token/.test(k)) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch(e) {}
    return { ok: true };
  };

  window.supaGetCurrentUser = async function(){
    const sb = getClient(); if (!sb) return null;
    try {
      // getSession() читает токен из localStorage мгновенно (без сетевого
      // запроса), в отличие от getUser(), который всегда валидирует токен на
      // /auth/v1/user — это убирает один сетевой round-trip на старте ЛК.
      // session.user содержит user_metadata, как и getUser().
      const { data, error } = await sb.auth.getSession();
      if (error) return null;
      if (data && data.session && data.session.user) return data.session.user;
      // Фолбэк на getUser() — на случай, если сессия в storage частична.
      const r = await sb.auth.getUser();
      return r && r.data && r.data.user ? r.data.user : null;
    } catch(e) { return null; }
  };

  // ===== Cross-browser sync: email-keyed identity =====
  // The app has a hybrid auth model (Supabase-auth users AND local-only users),
  // so favorites/addresses/profile are keyed by a stable identifier derived from
  // the current user in localStorage rather than auth.uid(). This lets the same
  // account sync across browsers/devices as long as we know its email (or phone).
  //
  // Returns { id, email, phone10, key } or null.
  //   key = email (lowercased) if present, else 'tel:<last10digits>', else null.
  function currentUserIdentity(){
    try {
      const id = localStorage.getItem('klever_current_user');
      if (!id) return null;
      const users = JSON.parse(localStorage.getItem('klever_users') || '[]');
      const me = users.find(u => u.id === id) || {};
      const email = (me.email || '').toLowerCase().trim();
      const phone10 = (me.phone || '').replace(/\D/g, '').slice(-10);
      let key = '';
      if (email) key = email;
      else if (phone10.length === 10) key = 'tel:' + phone10;
      return { id, email, phone10, key };
    } catch(e) { return null; }
  }
  // Resolve a user_email key from an explicit value or the current identity.
  function resolveUserKey(explicit){
    if (explicit) {
      const e = String(explicit).toLowerCase().trim();
      return e;
    }
    const idn = currentUserIdentity();
    return idn ? idn.key : '';
  }
  window.kleverCurrentUserKey = function(){ return resolveUserKey(); };

  // ===== favorites (email-keyed, table: public.favorites) =====
  // Rows cache product_name/product_price/product_img so the account page can
  // render the favorites grid WITHOUT depending on localStorage (klever_products_v2),
  // which is empty in a fresh browser.
  //
  // supaGetFavorites([email])      → string[] of product_sku  (for catalog/product hearts)
  // supaGetFavoritesFull([email])  → full rows               (for account favorites grid)
  // supaListFavorites([email])     → alias of supaGetFavorites
  // supaAddFavorite(sku | {sku,name,price,img})
  // supaRemoveFavorite(sku)
  function _isMissingColErr(e){
    const m = (e && (e.message||'')) + ' ' + (e && (e.details||''));
    return /column .* does not exist/i.test(m) || /Could not find/i.test(m)
        || (e && (e.code === '42703' || e.code === 'PGRST204'));
  }

  // Чтения избранного — через _pgGet (без CORS preflight), чтобы DPI не рвал
  // загрузку «Личного кабинета».
  window.supaGetFavorites = async function(email){
    if (!isConfigured()) return null;
    try {
      const key = resolveUserKey(email);
      if (!key) return [];
      const data = await _pgGetRetry('favorites', { select: 'product_sku', user_email: 'eq.' + key });
      return (Array.isArray(data) ? data : []).map(r => r.product_sku);
    } catch(e) { console.error('[supabase] get favorites', e); return null; }
  };
  window.supaListFavorites = window.supaGetFavorites;

  window.supaGetFavoritesFull = async function(email){
    if (!isConfigured()) return null;
    try {
      const key = resolveUserKey(email);
      if (!key) return [];
      const data = await _pgGetRetry('favorites', { select: '*', user_email: 'eq.' + key, order: 'id.desc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get favorites full', e); return null; }
  };

  // Accepts a bare sku string OR a product object { sku, name, price, img }.
  window.supaAddFavorite = async function(skuOrObj){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const key = resolveUserKey();
    if (!key) return { ok:false, reason:'no_identity' };
    const idn = currentUserIdentity();
    const isObj = skuOrObj && typeof skuOrObj === 'object';
    const sku = String(isObj ? skuOrObj.sku : skuOrObj);
    if (!sku) return { ok:false, reason:'no_sku' };
    const full = {
      user_email: key,
      user_phone: (idn && idn.phone10) || null,
      product_sku: sku,
      product_name: isObj ? (skuOrObj.name || null) : null,
      product_price: isObj && skuOrObj.price != null ? Number(skuOrObj.price) : null,
      product_img: isObj ? (skuOrObj.img || null) : null,
    };
    let r = await _pgUpsert('favorites', full, 'user_email,product_sku');
    // If the cache columns don't exist yet (SQL not run), retry with the minimal row.
    if (!r.ok && _isMissingColErr(r.error)) {
      r = await _pgUpsert('favorites',
        { user_email: key, user_phone: full.user_phone, product_sku: sku },
        'user_email,product_sku');
    }
    return r.ok ? { ok:true } : { ok:false, error:r.error };
  };

  window.supaRemoveFavorite = async function(sku){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const key = resolveUserKey();
    if (!key || sku == null) return { ok:false, reason:'no_identity' };
    return _pgDelete('favorites',
      'user_email=eq.' + encodeURIComponent(key) + '&product_sku=eq.' + encodeURIComponent(String(sku)));
  };

  // ===== addresses (email-keyed, table: public.user_addresses) =====
  // Чтение — через _pgGet (без CORS preflight), чтобы адреса грузились
  // стабильно на всех устройствах/сетях.
  window.supaListAddressesByEmail = async function(email){
    if (!isConfigured()) return null;
    try {
      const key = resolveUserKey(email);
      if (!key) return [];
      const data = await _pgGetRetry('user_addresses', { select: '*', user_email: 'eq.' + key, order: 'is_default.desc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] list addresses by email', e); return null; }
  };

  // addr = { label, address, is_default, email? }
  window.supaSaveAddress = async function(addr){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const key = resolveUserKey(addr && addr.email);
    if (!key) return { ok:false, reason:'no_identity' };
    if (addr.is_default) {
      await _pgUpdate('user_addresses', 'user_email=eq.' + encodeURIComponent(key), { is_default: false });
    }
    const r = await _pgInsert('user_addresses',
      { user_email: key, label: addr.label, address: addr.address, is_default: !!addr.is_default });
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  window.supaUpdateAddressById = async function(id, addr){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const key = resolveUserKey(addr && addr.email);
    if (addr.is_default && key) {
      await _pgUpdate('user_addresses', 'user_email=eq.' + encodeURIComponent(key), { is_default: false });
    }
    const r = await _pgUpdate('user_addresses', 'id=eq.' + encodeURIComponent(id),
      { label: addr.label, address: addr.address, is_default: !!addr.is_default });
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  window.supaDeleteAddressById = async function(id){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('user_addresses', 'id=eq.' + encodeURIComponent(id));
  };

  // ===== profile (table: public.user_profiles, keyed by user_id text) =====
  // Чтение — через _pgGet (без CORS preflight): имя/телефон профиля должны
  // подтягиваться на любом устройстве, а не «иногда».
  window.supaGetProfile = async function(userId){
    if (!isConfigured()) return null;
    try {
      const data = await _pgGetRetry('user_profiles', { select: '*', user_id: 'eq.' + String(userId), limit: '1' });
      return (Array.isArray(data) && data.length) ? data[0] : null;
    } catch(e) { console.error('[supabase] get profile', e); return null; }
  };

  // p = { user_id, email, phone, first_name, last_name, middle_name, user_type, company, inn }
  window.supaUpsertProfile = async function(p){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    if (!p || !p.user_id) return { ok:false, reason:'no_user_id' };
    const row = {
      user_id: String(p.user_id),
      email: p.email || null,
      phone: p.phone || null,
      first_name: p.first_name || null,
      last_name: p.last_name || null,
      middle_name: p.middle_name || null,
      user_type: p.user_type || 'individual',
      company: p.company || null,
      inn: p.inn || null,
      updated_at: new Date().toISOString(),
    };
    const r = await _pgUpsert('user_profiles', row, 'user_id');
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  // Subscribe to auth state changes (login/logout) — pages can re-render on transitions.
  window.supaOnAuthChange = function(cb){
    const sb = getClient(); if (!sb) return null;
    try { return sb.auth.onAuthStateChange((event, session) => cb && cb(event, session)); }
    catch(e) { return null; }
  };

  // ===== banners (table: public.banners) =====
  window.supaGetBanners = async function(){
    try {
      const data = await _pgGet('banners', { select:'*', 'is_active':'eq.true', order:'sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get banners', e); return null; }
  };

  window.supaGetAllBanners = async function(){
    try {
      const data = await _pgGet('banners', { select:'*', order:'sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get all banners', e); return null; }
  };

  window.supaUpsertBanner = async function(banner){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const fields = Object.assign({}, banner);
    delete fields.created_at;
    let r;
    if (banner.id) {
      const id = fields.id; delete fields.id;
      r = await _pgUpdate('banners', 'id=eq.' + encodeURIComponent(id), fields);
    } else {
      delete fields.id;
      r = await _pgInsert('banners', fields);
    }
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  window.supaDeleteBanner = async function(id){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('banners', 'id=eq.' + encodeURIComponent(id));
  };

  window.supaInsertDefaultBanners = async function(){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const defaults = [
      { title:'Бесплатная доставка по СПб', subtitle:'На следующий рабочий день при заказе до 18:00', bg_color:'#2ECC71', text_color:'#ffffff', link_url:'delivery.html', link_text:'Подробнее', is_active:true, sort_order:0 },
      { title:'Скидки для постоянных клиентов', subtitle:'Индивидуальные условия для HoReCa', bg_color:'#FF6B35', text_color:'#ffffff', link_url:'wholesale.html', link_text:'Узнать условия', is_active:true, sort_order:1 },
      { title:'Более 2000 наименований', subtitle:'Всё для ресторанов, кафе и отелей', bg_color:'#0f1a14', text_color:'#ffffff', link_url:'catalog.html', link_text:'Смотреть каталог', is_active:true, sort_order:2 },
    ];
    const r = await _pgInsert('banners', defaults);
    return r.ok ? { ok:true } : { ok:false, error:r.error };
  };

  // ===== news / новости (table: public.news) =====
  window.supaGetNews = async function(){
    try {
      const data = await _pgGet('news', { select:'*', 'is_active':'eq.true', order:'sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get news', e); return null; }
  };

  window.supaGetAllNews = async function(){
    try {
      const data = await _pgGet('news', { select:'*', order:'sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get all news', e); return null; }
  };

  window.supaUpsertNews = async function(item){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const fields = Object.assign({}, item);
    delete fields.created_at;
    let r;
    if (item.id) {
      const id = fields.id; delete fields.id;
      r = await _pgUpdate('news', 'id=eq.' + encodeURIComponent(id), fields);
    } else {
      delete fields.id;
      r = await _pgInsert('news', fields);
    }
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  window.supaDeleteNews = async function(id){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('news', 'id=eq.' + encodeURIComponent(id));
  };

  // ===== settings / настройки (table: public.settings, singleton row id=1) =====
  window.supaGetSettings = async function(){
    try {
      const data = await _pgGet('settings', { select:'*', limit:'1' });
      return Array.isArray(data) && data.length ? data[0] : {};
    } catch(e) { console.error('[supabase] get settings', e); return null; }
  };

  window.supaUpsertSettings = async function(s){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const row = Object.assign({ id: 1 }, s);
    delete row.updated_at;
    const r = await _pgUpsert('settings', row, 'id');
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  // ===== promotions / акции (table: public.promotions) =====
  window.supaGetPromotions = async function(){
    try {
      const data = await _pgGet('promotions', { select:'*', 'is_active':'eq.true', order:'sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get promotions', e); return null; }
  };

  window.supaGetAllPromotions = async function(){
    try {
      const data = await _pgGet('promotions', { select:'*', order:'sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get all promotions', e); return null; }
  };

  window.supaUpsertPromotion = async function(promo){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const fields = Object.assign({}, promo);
    delete fields.created_at;
    let r;
    if (promo.id) {
      delete fields.id;
      r = await _pgUpdate('promotions', 'id=eq.' + encodeURIComponent(promo.id), fields);
    } else {
      delete fields.id;
      r = await _pgInsert('promotions', fields);
    }
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  window.supaDeletePromotion = async function(id){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('promotions', 'id=eq.' + encodeURIComponent(id));
  };

  window.supaGetHomepageCategories = async function(){
    try {
      const data = await _pgGet('categories', { select:'*', 'show_on_homepage':'eq.true', order:'sort_order.asc,id.asc', limit:'8' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get homepage categories', e); return null; }
  };

  window.supaGetAllCategoriesHP = async function(){
    try {
      const data = await _pgGet('categories', { select:'id,name,show_on_homepage,sort_order,image_url,color,product_count', order:'sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get all categories hp', e); return null; }
  };

  window.supaUpsertCategory = async function(cat){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgUpsert('categories', cat, 'id');
  };

  window.supaDeleteCategory = async function(id){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('categories', 'id=eq.' + encodeURIComponent(String(id)));
  };

  // ===== subcategories (table: public.subcategories, PK (category_id, id)) =====
  // Подкатегории дерева каталога. Привязка товара к подкатегории по-прежнему
  // вычисляется на клиенте (classifyProduct) — здесь хранятся только определения
  // (имя/порядок/картинка), чтобы их можно было редактировать в админке и видеть
  // на всех устройствах.
  window.supaGetSubcategories = async function(){
    try {
      const data = await _pgGet('subcategories', { select:'*', order:'category_id.asc,sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get subcategories', e); return null; }
  };

  window.supaUpsertSubcategory = async function(sub){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    // parent_id НЕ отправляем: привязка под-подкатегории к родителю закодирована
    // прямо в её id ("<parent>~<local>"), поэтому отдельная колонка в БД не нужна
    // и upsert не падает на отсутствующей колонке parent_id.
    const row = {
      category_id: sub.category_id,
      id: sub.id,
      name: sub.name,
      image_url: sub.image_url || null,
      sort_order: sub.sort_order != null ? sub.sort_order : 0,
    };
    // PK таблицы может быть `id` или `(category_id,id)` — пробуем оба.
    return _pgUpsertAny('subcategories', row, ['id', 'category_id,id']);
  };

  window.supaDeleteSubcategory = async function(categoryId, id){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('subcategories',
      'category_id=eq.' + encodeURIComponent(String(categoryId)) + '&id=eq.' + encodeURIComponent(String(id)));
  };

  // Bulk upsert subcategories (used by the admin "sync tree to Supabase" seed).
  window.supaBulkUpsertSubcategories = async function(subs){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const rows = (subs || []).map(s => ({
      category_id: s.category_id,
      id: s.id,
      name: s.name,
      image_url: s.image_url || null,
      sort_order: s.sort_order != null ? s.sort_order : 0,
    }));
    if (!rows.length) return { ok:true };
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await _pgUpsertAny('subcategories', rows.slice(i, i + CHUNK), ['id', 'category_id,id']);
      if (!r.ok) { console.error('[supabase] bulk upsert subcategories', r.error); return { ok:false, error:r.error }; }
    }
    return { ok:true };
  };

  window.supaInsertContact = async function(contact){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const r = await _pgInsert('contacts', { name: contact.name, phone: contact.phone, message: contact.message });
    if (!r.ok) console.error('[supabase] insert contact', r.error);
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  window.supaGetContacts = async function(){
    if (!isConfigured()) return null;
    try {
      const data = await _pgGetRetry('contacts', { select:'*', order:'created_at.desc' });
      return Array.isArray(data) ? data : null;
    } catch(e) { console.error('[supabase] get contacts', e); return null; }
  };

  window.supaDeleteContact = async function(id){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('contacts', 'id=eq.' + encodeURIComponent(id));
  };

  window.supaDeleteAllContacts = async function(){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('contacts', 'id=neq.0');
  };

  // ===== products (table: public.products) =====
  window.supaGetProducts = async function(){
    try {
      const data = await _pgGet('products', { select:'*', order:'sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[supabase] get products exception', e); return null; }
  };

  window.supaGetProductBySku = async function(sku){
    if (!isConfigured()) return null;
    try {
      const data = await _pgGetRetry('products', { select:'*', sku:'eq.' + String(sku), limit:'1' });
      return (Array.isArray(data) && data.length) ? data[0] : null;
    } catch(e) { console.error('[supabase] get product by sku', e); return null; }
  };

  window.supaGetHits = async function(){
    try {
      const data = await _pgGet('products', { select:'*', 'is_hit':'eq.true', order:'sort_order.asc,id.asc' });
      return Array.isArray(data) ? data : [];
    } catch(e) { return null; }
  };

  function _productRow(p){
    return {
      sku: p.sku,
      name: p.name,
      price: Number(p.price) || 0,
      img: p.img || '',
      cat: p.cat || '',
      category_id: p.categoryId || '',
      subcategory: p.subcategory || '',
      badge: p.badge || '',
      is_hit: !!p.isHit,
      description: p.desc || '',
      emoji: p.emoji || '📦',
      is_active: true,
    };
  }

  window.supaUpsertProduct = async function(p){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const r = await _pgUpsert('products', _productRow(p), 'sku');
    if (!r.ok) console.error('[supabase] upsert product', r.error);
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  window.supaDeleteProduct = async function(sku){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('products', 'sku=eq.' + encodeURIComponent(String(sku)));
  };

  window.supaBulkUpsertProducts = async function(products){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const rows = (products || []).map(_productRow);
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await _pgUpsert('products', rows.slice(i, i + CHUNK), 'sku');
      if (!r.ok) { console.error('[supabase] bulk upsert products', r.error); return { ok:false, error:r.error }; }
    }
    return { ok:true };
  };

  // ===== storage: image uploads (bucket: product-images) =====
  // Uploads a File/Blob and returns its public URL. Used by the admin
  // product/category forms so the owner can attach photos without hosting them.
  window.supaUploadImage = async function(file, opts){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      if (!file) return { ok:false, reason:'no_file' };
      const bucket = (opts && opts.bucket) || 'product-images';
      // Build a safe, unique filename: <prefix><timestamp>-<rand>.<ext>
      const extMatch = (file.name || '').match(/\.([a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
      const prefix = (opts && opts.prefix) ? String(opts.prefix).replace(/[^a-z0-9_-]/gi,'') + '-' : '';
      const path = prefix + Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.' + ext;
      const { error } = await sb.storage.from(bucket).upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || 'image/jpeg',
      });
      if (error) { console.error('[supabase] upload image', error); return { ok:false, error }; }
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return { ok:true, url: data && data.publicUrl, path: path };
    } catch(e) { console.error('[supabase] upload image exception', e); return { ok:false, error:e }; }
  };

  window.kleverSupabase = { isConfigured, getClient };
})();
