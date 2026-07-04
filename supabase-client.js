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

  // Токен авторизованного админа. Если задан — запросы к БД идут под его
  // сессией (RLS даёт полный доступ). Устанавливается ТОЛЬКО в админ-панели
  // после входа через Supabase Auth. На клиентских страницах остаётся null,
  // поэтому те запросы — анонимные (и без CORS-preflight, важно на DPI).
  let _authToken = null;
  function setAuthToken(t){ _authToken = t || null; }

  let _client = null;
  function getClient(){
    if (_client) return _client;
    if (!isConfigured()) return null;
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      console.warn('[supabase] CDN not loaded yet');
      return null;
    }
    _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // detectSessionInUrl — SDK сам подхватит токены из #hash после перехода
        // по ссылке подтверждения email и сохранит сессию (иначе «тёмный экран»).
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
        flowType: 'implicit',   // ссылка подтверждения возвращает #access_token
      },
    });
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => _abort(ctrl), 25000);
    try {
      const headers = { Accept: 'application/json' };
      if (_authToken) headers.Authorization = 'Bearer ' + _authToken;
      const resp = await fetch(url.toString(), { headers, signal: ctrl.signal });
      if (!resp.ok) throw Object.assign(new Error('HTTP ' + resp.status), { status: resp.status });
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Возвращает точное число строк через Prefer: count=exact + Content-Range.
  // Используется только в админке (уже идёт Authorization → preflight не страшен).
  async function _pgGetCount(table, qp) {
    if (!isConfigured()) return -1;
    const url = new URL(SUPABASE_URL + '/rest/v1/' + table);
    url.searchParams.set('apikey', SUPABASE_ANON_KEY);
    url.searchParams.set('limit', '1');
    Object.entries(qp || {}).forEach(([k, v]) => url.searchParams.append(k, v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => _abort(ctrl), 15000);
    try {
      const headers = { Accept: 'application/json', Prefer: 'count=exact' };
      if (_authToken) headers.Authorization = 'Bearer ' + _authToken;
      const resp = await fetch(url.toString(), { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return -1;
      // Content-Range: 0-0/3247  или  */<total>
      const cr = resp.headers.get('Content-Range') || '';
      const m = cr.match(/\/(\d+)$/);
      return m ? parseInt(m[1], 10) : -1;
    } catch(e) {
      clearTimeout(timer);
      return -1;
    }
  }

  // POST/PATCH/DELETE для RPC и записей — plain fetch (без SDK-заголовков).
  // extraHeaders позволяет добавить, напр., Prefer: return=representation.
  async function _pgPost(path, body, method, extraHeaders) {
    if (!isConfigured()) return null;
    const url = new URL(SUPABASE_URL + '/rest/v1/' + path);
    url.searchParams.set('apikey', SUPABASE_ANON_KEY);
    const ctrl = new AbortController();
    const timer = setTimeout(() => _abort(ctrl), 10000);
    try {
      const baseHeaders = { 'Content-Type': 'application/json', Accept: 'application/json', apikey: SUPABASE_ANON_KEY };
      // Админ: добавляем его токен → запись/правка/удаление проходят по RLS.
      if (_authToken) baseHeaders.Authorization = 'Bearer ' + _authToken;
      const resp = await fetch(url.toString(), {
        method: method || 'POST',
        headers: Object.assign(baseHeaders, extraHeaders || {}),
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
    const max = tries || 3;
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

  // ─── Auth POST: plain fetch + retry к /auth/v1 (устойчиво к DPI/ТСПУ) ───────
  // SDK-метод signInWithPassword шлёт HTTP/2-запрос, который на сетях с DPI
  // (ТСПУ РФ) часто рвётся ещё до ответа (net::ERR_HTTP2_PING_FAILED) и НЕ
  // повторяется — пользователь видит «ошибку входа», хотя пароль верный.
  // Здесь — тот же приём, что и для заказов: лёгкий fetch + повторы при обрыве.
  async function _authPost(path, body, qp){
    if (!isConfigured()) return null;
    const url = new URL(SUPABASE_URL + '/auth/v1/' + path);
    url.searchParams.set('apikey', SUPABASE_ANON_KEY);
    Object.entries(qp || {}).forEach(([k, v]) => url.searchParams.append(k, v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => _abort(ctrl), 15000);
    try {
      const resp = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const m = json.error_description || json.msg || json.message
                || ('Ошибка сервера (код ' + resp.status + ')');
        throw Object.assign(new Error(m), {
          status: resp.status,
          code: json.error_code || json.error || json.code || '',
          supaError: json,
        });
      }
      return json;
    } finally { clearTimeout(timer); }
  }

  async function _authPostRetry(path, body, qp, tries){
    const max = tries || 3;
    let lastErr = null;
    for (let i = 0; i < max; i++) {
      if (i) await new Promise(r => setTimeout(r, i * 1000));
      try { return await _authPost(path, body, qp); }
      catch (e) {
        lastErr = e;
        // Ответ сервера 4xx (неверный пароль, email не подтверждён и т.п.)
        // повторять бессмысленно — пробрасываем сразу. Повторяем только обрывы.
        if (e && e.status && e.status >= 400 && e.status < 500) throw e;
      }
    }
    throw lastErr || new Error('auth request failed');
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

    const _isUuid = v => typeof v === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

    // Заказ создаётся через защищённую функцию rpc_create_order (SECURITY
    // DEFINER): прямого доступа к таблице orders у анонима нет (RLS), поэтому
    // нельзя ни выгрузить, ни изменить чужие заказы. Функция возвращает
    // созданную строку — из неё берём id (= номер заказа).
    // Используем _pgPostRetry (plain fetch + повторы) — устойчиво к обрывам DPI.
    const payload = {
      customer_name: order.name || '',
      customer_phone: order.phone || '',
      customer_email: order.email || '',
      company: order.company || '',
      items: order.items || [],
      subtotal: order.subtotal != null ? Number(order.subtotal) : null,
      delivery_cost: order.delivery != null ? Number(order.delivery) : null,
      total_price: order.total != null ? Number(order.total) : 0,
      delivery_method: order.method || 'courier',
      delivery_address: order.address || '',
      delivery_date: order.deliveryDate || null,
      delivery_time: order.deliveryTime || null,
      payment_method: order.payment || 'cash',
      invoice_company: order.invoiceCompany || null,
      invoice_inn: order.invoiceInn || null,
      comment: order.comment || '',
      language: language,
      status: order.status || 'new',
      user_id: _isUuid(order.userId) ? order.userId : null,
    };

    try {
      const data = await _pgPostRetry('rpc/rpc_create_order', { payload }, 'POST',
        { Prefer: 'return=representation' }, 5);
      // rpc_create_order возвращает одну строку orders (объект); на всякий
      // случай поддержим и массив.
      const row = Array.isArray(data) ? data[0] : data;
      if (row && row.id != null) return { ok: true, data: row };
      console.error('[supabase] rpc_create_order вернул пустой результат:', JSON.stringify(data));
      return { ok: false, error: { message: 'empty rpc result' } };
    } catch (e) {
      const error = (e && e.supaError) || e || {};
      console.error('[order] rpc_create_order failed — HTTP', e && e.status,
        '| code:', error.code, '| message:', error.message || error,
        '| Если функции нет — запустите fix_security_rls.sql в Supabase.');
      return { ok: false, error };
    }
  };

  // Returns orders mapped to the legacy admin shape so existing renderers work.
  window.supaListOrders = async function(){
    if (!isConfigured()) return null;
    try {
      const data = await _pgGetRetry('orders', { select: '*', order: 'created_at.desc' });
      if (!Array.isArray(data)) return null;
      return data.map(r => ({
        // Номер заказа — это id (автоинкремент). Поле num устарело.
        num: r.id,
        id: r.id,
        date: r.created_at ? new Date(r.created_at).toLocaleString('ru-RU', {
          day:'2-digit', month:'2-digit', year:'numeric',
          hour:'2-digit', minute:'2-digit'
        }) : '',
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
        userId: r.user_id || null,
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
    // id — это bigint (int8), а не uuid. Фильтр id=gt.0 покрывает все строки
    // и одновременно удовлетворяет защите PostgREST «DELETE без WHERE запрещён».
    const r = await _pgDelete('orders', 'id=gt.0');
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
      num: r.id,
      id: r.id,
      date: r.created_at ? new Date(r.created_at).toLocaleString('ru-RU', {
        day:'2-digit', month:'2-digit', year:'numeric',
        hour:'2-digit', minute:'2-digit'
      }) : '',
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
    // Телефон → последние 10 цифр; email → нижний регистр.
    const phone = ((opts && opts.phone) || '').replace(/\D/g, '').slice(-10);
    const email = ((opts && opts.email) || '').toLowerCase().trim();
    if (!phone && !email) return [];

    // Список заказов идёт через защищённую функцию rpc_my_orders: прямого
    // доступа к таблице orders у клиента нет (RLS), а функция возвращает только
    // заказы с совпавшим телефоном/email — выгрузить всю базу нельзя.
    try {
      const data = await _pgPostRetry('rpc/rpc_my_orders',
        { p_phone: phone || null, p_email: email || null }, 'POST', {}, 3);
      const rows = Array.isArray(data) ? data : [];
      // Дедупликация на всякий случай (совпасть могли и телефон, и email).
      const seen = new Set();
      const out = [];
      for (const r of rows) { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } }
      return out.map(mapRow);
    } catch (e) {
      const error = (e && e.supaError) || e || {};
      console.error('[supabase] rpc_my_orders failed — HTTP', e && e.status,
        '| message:', error.message || error);
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
  // Сетевой ли это сбой (обрыв/таймаут), а не ответ сервера «неверные данные»?
  // Нужно, чтобы UI не показывал «неверный пароль» при проблемах со связью.
  function _isNetworkErr(e){
    if (!e) return false;
    if (e.status && e.status >= 400 && e.status < 500) return false; // явный ответ сервера
    const m = (e.message || '') + ' ' + (e.name || '');
    return !e.status || e.status >= 500
        || /timeout|fetch|network|aborted|failed|соедин|сети|ответил|вовремя/i.test(m);
  }

  window.supaSignUp = async function(email, password, meta, redirectTo){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    try {
      // Регистрация через /auth/v1/signup напрямую (plain fetch + повторы) —
      // не рвётся на DPI, в отличие от SDK-метода signUp.
      const qp = {};
      // redirect_to нужен только если в дашборде ВКЛючено подтверждение email.
      if (redirectTo) qp.redirect_to = redirectTo;
      const data = await _authPostRetry('signup', { email, password, data: meta || {} }, qp);
      // Если подтверждение email выключено — ответ содержит сессию: сразу
      // гидрируем её в SDK, чтобы пользователь оказался залогинен.
      const sb = getClient();
      if (sb && data && data.access_token) {
        try { await sb.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token }); } catch(e){}
      }
      // При включённом подтверждении gotrue возвращает сам объект user (без сессии).
      const user = data && (data.user || (data.id ? data : null));
      return { ok:true, user, session: data && data.access_token ? data : null };
    } catch(e) { return { ok:false, error:e, network: _isNetworkErr(e) }; }
  };

  window.supaSignIn = async function(email, password){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    try {
      // Вход через /auth/v1/token?grant_type=password напрямую (plain fetch +
      // повторы). Это устраняет net::ERR_HTTP2_PING_FAILED на ТСПУ-сетях.
      const data = await _authPostRetry('token', { email, password }, { grant_type: 'password' });
      // Гидрируем сессию в SDK → работает getSession()/autoRefresh на всех страницах.
      const sb = getClient();
      if (sb && data && data.access_token) {
        try { await sb.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token }); } catch(e){}
      }
      return { ok:true, user: data && data.user, session: data };
    } catch(e) {
      return { ok:false, error:e, network: _isNetworkErr(e) };
    }
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

  window.supaUpdatePassword = async function(newPassword){
    const sb = getClient();
    if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const { data, error } = await sb.auth.updateUser({ password: newPassword });
      if (error) return { ok:false, error, network: _isNetworkErr(error) };
      return { ok:true, user: data && data.user };
    } catch(e) {
      return { ok:false, error:e, network: _isNetworkErr(e) };
    }
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
    // Локальные аккаунты (телефон/пароль) имеют id вида "u1780688605663" — не UUID.
    // Записывать их в user_profiles нельзя: создаётся «фантомный» пользователь в
    // таблице и в счётчике пользователей в админке.
    const _isUuid = v => typeof v === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    if (!_isUuid(p.user_id)) return { ok:false, reason:'not_uuid' };
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

  // Список всех профилей (для админки — счётчик «Зарегистрированных клиентов»).
  // Плоский GET без preflight; возвращает массив строк user_profiles или null.
  window.supaListProfiles = async function(){
    if (!isConfigured()) return null;
    try {
      const data = await _pgGetRetry('user_profiles', { select: '*', order: 'id.asc' });
      return Array.isArray(data) ? data : null;
    } catch(e) { console.error('[supabase] list profiles', e); return null; }
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

  // Server-side pagination + search for admin products table.
  // Uses SECURITY DEFINER RPCs — bypasses RLS, sees all 3663+ rows.
  window.supaGetProductsPage = async function(opts){
    const search  = (opts && opts.search)  || '';
    const catName = (opts && opts.catName) || '';
    const page    = (opts && opts.page)    || 1;
    const perPage = (opts && opts.perPage) || 50;
    const offset  = (page - 1) * perPage;

    try {
      const dataBody  = { p_search: search, p_cat: catName, p_limit: perPage, p_offset: offset };
      const countBody = { p_search: search, p_cat: catName };

      const [items, total] = await Promise.all([
        _pgPostRetry('rpc/rpc_admin_products', dataBody),
        _pgPostRetry('rpc/rpc_admin_products_count', countBody),
      ]);

      return {
        ok: true,
        items: Array.isArray(items) ? items : [],
        total: (typeof total === 'number' || typeof total === 'string') ? Number(total) : 0,
      };
    } catch(e) {
      console.error('[supabase] supaGetProductsPage', e);
      return { ok: false, items: [], total: 0 };
    }
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
    const row = {
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
      // Наличие: 'in' (в наличии) | 'order' (под заказ) | 'out' (нет).
      availability: p.availability || 'in',
      // Старая цена: если > 0 и > price — показывается зачёркнутой на карточке.
      old_price: Number(p.old_price) || 0,
      is_active: true,
    };
    return row;
  }

  // true, если ошибка — про отсутствующую колонку (схема ещё не обновлена).
  function _isMissingColErr(error){
    const m = ((error && error.message) || '') + ' ' + ((error && error.details) || '');
    return /column .* does not exist/i.test(m) || /Could not find/i.test(m)
        || (error && (error.code === '42703' || error.code === 'PGRST204'));
  }

  window.supaUpsertProduct = async function(p){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const row = _productRow(p);
    let r = await _pgUpsert('products', row, 'sku');
    // Если неизвестная колонка (схема ещё не обновлена) — убираем новые поля и повторяем.
    if (!r.ok && _isMissingColErr(r.error)) {
      if ('old_price' in row) delete row.old_price;
      if ('availability' in row) delete row.availability;
      r = await _pgUpsert('products', row, 'sku');
    }
    if (!r.ok) console.error('[supabase] upsert product', r.error);
    return r.ok ? { ok:true, data: r.data } : { ok:false, error:r.error };
  };

  window.supaDeleteProduct = async function(sku){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    return _pgDelete('products', 'sku=eq.' + encodeURIComponent(String(sku)));
  };

  // Массовое удаление по массиву артикулов. Бьём на части, чтобы не упереться
  // в лимит длины URL у фильтра in.(...).
  window.supaDeleteProducts = async function(skus){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const list = (skus || []).map(s => String(s)).filter(Boolean);
    if (!list.length) return { ok:true };
    const CHUNK = 50;
    for (let i = 0; i < list.length; i += CHUNK) {
      // PostgREST in.(): значения через запятую, каждое — в кавычках на случай
      // запятых/спецсимволов в артикуле.
      const inList = list.slice(i, i + CHUNK)
        .map(s => '"' + s.replace(/"/g, '\\"') + '"').join(',');
      const r = await _pgDelete('products', 'sku=in.(' + encodeURIComponent(inList) + ')');
      if (!r.ok) { console.error('[supabase] bulk delete products', r.error); return r; }
    }
    return { ok:true };
  };

  // Удаляет ВСЕ товары (режим «заменить все» при CSV-импорте).
  // PostgREST требует фильтр у DELETE — используем всегда-истинный sku=neq.__none__.
  window.supaDeleteAllProducts = async function(){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const r = await _pgDelete('products', 'sku=neq.' + encodeURIComponent('__none__'));
    if (!r.ok) console.error('[supabase] delete all products', r.error);
    return r;
  };

  // onProgress(done, total) — опциональный колбэк для отображения прогресса.
  window.supaBulkUpsertProducts = async function(products, onProgress){
    if (!isConfigured()) return { ok:false, reason:'unconfigured' };
    const rows = (products || []).map(_productRow);
    const CHUNK = 50;
    let stripNew = false;   // станет true, если схема не знает новых колонок
    const stripNewCols = arr => arr.map(r => { const c = {...r}; delete c.availability; delete c.old_price; return c; });
    for (let i = 0; i < rows.length; i += CHUNK) {
      let chunk = rows.slice(i, i + CHUNK);
      if (stripNew) chunk = stripNewCols(chunk);
      let r = await _pgUpsert('products', chunk, 'sku');
      if (!r.ok && _isMissingColErr(r.error)) {
        stripNew = true;
        r = await _pgUpsert('products', stripNewCols(chunk), 'sku');
      }
      if (!r.ok) { console.error('[supabase] bulk upsert products', r.error); return { ok:false, error:r.error }; }
      if (typeof onProgress === 'function') {
        try { onProgress(Math.min(i + CHUNK, rows.length), rows.length); } catch(e) {}
      }
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

  // ===== Админ-авторизация (Supabase Auth) =====
  const _ADMIN_CACHE_KEY = 'klever_admin_uid_v1';

  function _readStoredSession() {
    try {
      const ref = (SUPABASE_URL.match(/https?:\/\/([^.]+)\.supabase\.co/) || [])[1] || '';
      const raw = ref ? localStorage.getItem('sb-' + ref + '-auth-token') : null;
      if (!raw) return null;
      const s = JSON.parse(raw);
      return (s && s.access_token) ? s : null;
    } catch(e) { return null; }
  }

  // Возвращает { checked, isAdmin }. checked=false если была сетевая ошибка.
  async function _checkIsAdminSafe() {
    try {
      const data = await _pgPostRetry('rpc/is_admin', {});
      return { checked: true, isAdmin: data === true };
    } catch(e) {
      const isAuthErr = e && e.status && (e.status === 401 || e.status === 403);
      return { checked: isAuthErr, isAdmin: false };
    }
  }

  window.supaAdminSignIn = async function(email, password){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const r = await window.supaSignIn(email, password);
      if (!r.ok || !r.session || !r.session.access_token) {
        return { ok:false, error: r.error, network: r.network };
      }
      setAuthToken(r.session.access_token);
      const admin = await _checkIsAdmin();
      if (!admin) { setAuthToken(null); try { await sb.auth.signOut(); } catch(e){} return { ok:false, reason:'not_admin' }; }
      const uid = r.session.user && r.session.user.id;
      if (uid) localStorage.setItem(_ADMIN_CACHE_KEY, uid);
      _bindTokenRefresh();
      return { ok:true, isAdmin:true };
    } catch(e){ return { ok:false, error:e }; }
  };

  // Восстановление сессии: если токен в localStorage — показываем панель сразу.
  // is_admin() проверяем фоново; выкидываем только при явном отказе сервера,
  // а не при сетевой ошибке (DPI может зарезать запрос).
  window.supaAdminRestore = async function(){
    const sb = getClient(); if (!sb) return { ok:false };
    try {
      let session = _readStoredSession();
      if (!session) return { ok:false };

      // Токен истёк — рефрешим через DPI-устойчивый _authPostRetry.
      if (session.expires_at && session.expires_at < Date.now() / 1000 + 30) {
        if (!session.refresh_token) return { ok:false };
        try {
          const refreshed = await _authPostRetry('token',
            { refresh_token: session.refresh_token },
            { grant_type: 'refresh_token' }
          );
          if (!refreshed || !refreshed.access_token) return { ok:false };
          try { await sb.auth.setSession({ access_token: refreshed.access_token, refresh_token: refreshed.refresh_token }); } catch(e){}
          session = refreshed;
        } catch(e) { return { ok:false }; }
      }

      const token = session.access_token;
      const uid   = session.user && session.user.id;
      setAuthToken(token);
      _bindTokenRefresh();

      // Фоновая проверка — не блокирует UI. Выкидываем только если сервер
      // явно ответил «не админ»; сетевую ошибку игнорируем.
      _checkIsAdminSafe().then(result => {
        if (result.checked && !result.isAdmin) {
          localStorage.removeItem(_ADMIN_CACHE_KEY);
          setAuthToken(null);
          location.reload();
        } else if (result.isAdmin && uid) {
          localStorage.setItem(_ADMIN_CACHE_KEY, uid);
        }
      }).catch(() => {});

      return { ok:true, isAdmin:true };
    } catch(e){ return { ok:false }; }
  };

  window.supaAdminSignOut = async function(){
    const sb = getClient();
    localStorage.removeItem(_ADMIN_CACHE_KEY);
    setAuthToken(null);
    try { if (sb) await sb.auth.signOut(); } catch(e){}
  };

  // Подхватываем обновлённый токен (SDK сам рефрешит сессию раз в ~час).
  let _tokenBound = false;
  function _bindTokenRefresh(){
    if (_tokenBound) return;
    const sb = getClient(); if (!sb) return;
    try {
      sb.auth.onAuthStateChange((_event, session) => {
        setAuthToken(session && session.access_token ? session.access_token : null);
      });
      _tokenBound = true;
    } catch(e){}
  }

  // Проверяем через RPC is_admin(), что текущая сессия принадлежит админу.
  async function _checkIsAdmin(){
    try {
      // Через устойчивый _pgPost (несёт Authorization админа), а не SDK rpc —
      // надёжнее на DPI и без CORS-preflight.
      const data = await _pgPostRetry('rpc/is_admin', {});
      return data === true;
    } catch(e){ return false; }
  }

  window.kleverSupabase = { isConfigured, getClient, setAuthToken };
})();
