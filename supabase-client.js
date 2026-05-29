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
    return _client;
  }

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
    const sb = getClient();
    if (!sb) return { ok: false, reason: 'unconfigured' };
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
    async function tryInsert(row) {
      let { data, error } = await sb.from('orders').insert([row]).select();
      if (!error) return { ok: true, data: data && data[0] };
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

    try {
      return await tryInsert(fullRow);
    } catch (e) {
      console.error('[supabase] insert exception', e);
      return { ok: false, error: e };
    }
  };

  // Returns orders mapped to the legacy admin shape so existing renderers work.
  window.supaListOrders = async function(){
    const sb = getClient();
    if (!sb) return null;
    try {
      const { data, error } = await sb.from('orders').select('*').order('created_at', { ascending: false });
      if (error) { console.error('[supabase] list error', error); return null; }
      return (data || []).map(r => ({
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
    const sb = getClient();
    if (!sb) return { ok: false, reason: 'unconfigured' };
    function missing(error){
      const m = (error?.message||'') + ' ' + (error?.details||'');
      return /column .* does not exist/i.test(m) || /Could not find/i.test(m)
          || error?.code === '42703' || error?.code === 'PGRST204';
    }
    try {
      let { data, error } = await sb.from('orders').update(fields).eq('num', numOrId).select();
      // Retry by id when: num column missing (error) OR num matched 0 rows (data empty).
      if ((error && missing(error)) || (!error && (!data || data.length === 0))) {
        ({ data, error } = await sb.from('orders').update(fields).eq('id', numOrId).select());
      }
      if (error) { console.error('[supabase] update error', error); return { ok: false, error }; }
      return { ok: true, data };
    } catch (e) {
      console.error('[supabase] update exception', e);
      return { ok: false, error: e };
    }
  };

  window.supaDeleteOrder = async function(numOrId){
    const sb = getClient();
    if (!sb) return { ok: false, reason: 'unconfigured' };
    function missing(error){
      const m = (error?.message||'') + ' ' + (error?.details||'');
      return /column .* does not exist/i.test(m) || /Could not find/i.test(m)
          || error?.code === '42703' || error?.code === 'PGRST204';
    }
    try {
      // Use .select() so we know whether any row was actually deleted.
      let { data, error } = await sb.from('orders').delete().eq('num', numOrId).select();
      // Retry by id when: num column missing (error) OR num matched 0 rows.
      if ((error && missing(error)) || (!error && (!data || data.length === 0))) {
        ({ data, error } = await sb.from('orders').delete().eq('id', numOrId).select());
      }
      if (error) { console.error('[supabase] delete error', error); return { ok: false, error }; }
      return { ok: true };
    } catch (e) {
      console.error('[supabase] delete exception', e);
      return { ok: false, error: e };
    }
  };

  window.supaDeleteAllOrders = async function(){
    const sb = getClient();
    if (!sb) return { ok: false, reason: 'unconfigured' };
    try {
      // Delete all orders — neq on a column that's always set ensures no-WHERE-clause error.
      const { error } = await sb.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (error) { console.error('[supabase] delete-all error', error); return { ok: false, error }; }
      return { ok: true };
    } catch (e) {
      console.error('[supabase] delete-all exception', e);
      return { ok: false, error: e };
    }
  };

  // Returns orders for a specific user (for account history page).
  // opts = { phone, email } — used as fallback when user_id column is absent
  // or when orders were placed without being linked to a user_id.
  window.supaListOrdersByUser = async function(userId, opts){
    const sb = getClient();
    if (!sb) return null;
    const isMissingCol = e => e && (
      /column .* does not exist/i.test((e.message||'') + ' ' + (e.details||'')) ||
      e.code === '42703' || e.code === 'PGRST204'
    );
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
    try {
      // Primary: query by user_id
      let rows = [];
      if (userId) {
        const { data: d1, error: e1 } = await sb.from('orders').select('*')
          .eq('user_id', userId).order('created_at', { ascending: false });
        if (!e1) { rows = d1 || []; }
        else if (!isMissingCol(e1)) { console.error('[supabase] list orders by user', e1); return null; }
        // if column missing, fall through to phone/email fallback
      }
      // Fallback / supplement: by phone and/or email.
      // Catches orders placed before user_id existed or as a guest.
      if (rows.length === 0 && opts) {
        const { phone, email } = opts;
        const queries = [];
        if (phone) queries.push(sb.from('orders').select('*').eq('customer_phone', phone).order('created_at', { ascending: false }));
        if (email) queries.push(sb.from('orders').select('*').eq('customer_email', email).order('created_at', { ascending: false }));
        if (queries.length > 0) {
          const results = await Promise.all(queries);
          const seen = new Set();
          for (const { data: d } of results) {
            if (!Array.isArray(d)) continue;
            for (const r of d) { if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); } }
          }
          rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        }
      }
      return rows.map(mapRow);
    } catch (e) {
      console.error('[supabase] list orders by user exception', e);
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
  // Required SQL for profile data (optional, see customer_addresses below):
  //   create table public.customer_addresses (
  //     id uuid primary key default gen_random_uuid(),
  //     user_id uuid references auth.users(id) on delete cascade,
  //     name text, address text, is_default boolean default false,
  //     created_at timestamptz default now()
  //   );
  //   alter table public.customer_addresses enable row level security;
  //   create policy "own_addresses" on public.customer_addresses for all
  //     using (auth.uid() = user_id) with check (auth.uid() = user_id);
  //
  //   create table public.customer_favorites (
  //     user_id uuid references auth.users(id) on delete cascade,
  //     product_id text,
  //     created_at timestamptz default now(),
  //     primary key (user_id, product_id)
  //   );
  //   alter table public.customer_favorites enable row level security;
  //   create policy "own_favs" on public.customer_favorites for all
  //     using (auth.uid() = user_id) with check (auth.uid() = user_id);

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
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try { const { error } = await sb.auth.signOut(); return error ? { ok:false, error } : { ok:true }; }
    catch(e) { return { ok:false, error:e }; }
  };

  window.supaGetCurrentUser = async function(){
    const sb = getClient(); if (!sb) return null;
    try {
      const { data, error } = await sb.auth.getUser();
      if (error) return null;
      return data && data.user ? data.user : null;
    } catch(e) { return null; }
  };

  // ===== customer_addresses =====
  window.supaListAddresses = async function(){
    const sb = getClient(); if (!sb) return null;
    try {
      const u = await window.supaGetCurrentUser(); if (!u) return [];
      const { data, error } = await sb.from('customer_addresses').select('*').eq('user_id', u.id).order('is_default', { ascending: false });
      if (error) { console.error('[supabase] list addresses', error); return null; }
      return data || [];
    } catch(e) { return null; }
  };

  window.supaInsertAddress = async function(row){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const u = await window.supaGetCurrentUser(); if (!u) return { ok:false, reason:'not_signed_in' };
      if (row.is_default) {
        // Clear previous defaults
        await sb.from('customer_addresses').update({ is_default: false }).eq('user_id', u.id);
      }
      const { data, error } = await sb.from('customer_addresses').insert([{ ...row, user_id: u.id }]).select();
      if (error) return { ok:false, error };
      return { ok:true, data: data && data[0] };
    } catch(e) { return { ok:false, error:e }; }
  };

  window.supaUpdateAddress = async function(id, row){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const u = await window.supaGetCurrentUser(); if (!u) return { ok:false, reason:'not_signed_in' };
      if (row.is_default) {
        await sb.from('customer_addresses').update({ is_default: false }).eq('user_id', u.id);
      }
      const { data, error } = await sb.from('customer_addresses').update(row).eq('id', id).select();
      if (error) return { ok:false, error };
      return { ok:true, data: data && data[0] };
    } catch(e) { return { ok:false, error:e }; }
  };

  window.supaDeleteAddress = async function(id){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const { error } = await sb.from('customer_addresses').delete().eq('id', id);
      return error ? { ok:false, error } : { ok:true };
    } catch(e) { return { ok:false, error:e }; }
  };

  window.supaSetDefaultAddress = async function(id){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const u = await window.supaGetCurrentUser(); if (!u) return { ok:false, reason:'not_signed_in' };
      await sb.from('customer_addresses').update({ is_default: false }).eq('user_id', u.id);
      const { error } = await sb.from('customer_addresses').update({ is_default: true }).eq('id', id);
      return error ? { ok:false, error } : { ok:true };
    } catch(e) { return { ok:false, error:e }; }
  };

  // ===== customer_favorites =====
  window.supaListFavorites = async function(){
    const sb = getClient(); if (!sb) return null;
    try {
      const u = await window.supaGetCurrentUser(); if (!u) return [];
      const { data, error } = await sb.from('customer_favorites').select('product_id').eq('user_id', u.id);
      if (error) { console.error('[supabase] list favorites', error); return null; }
      return (data || []).map(r => r.product_id);
    } catch(e) { return null; }
  };

  window.supaAddFavorite = async function(productSku){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const u = await window.supaGetCurrentUser(); if (!u) return { ok:false, reason:'not_signed_in' };
      const { error } = await sb.from('customer_favorites').upsert({ user_id: u.id, product_id: productSku });
      return error ? { ok:false, error } : { ok:true };
    } catch(e) { return { ok:false, error:e }; }
  };

  window.supaRemoveFavorite = async function(productSku){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const u = await window.supaGetCurrentUser(); if (!u) return { ok:false, reason:'not_signed_in' };
      const { error } = await sb.from('customer_favorites').delete().match({ user_id: u.id, product_id: productSku });
      return error ? { ok:false, error } : { ok:true };
    } catch(e) { return { ok:false, error:e }; }
  };

  // Subscribe to auth state changes (login/logout) — pages can re-render on transitions.
  window.supaOnAuthChange = function(cb){
    const sb = getClient(); if (!sb) return null;
    try { return sb.auth.onAuthStateChange((event, session) => cb && cb(event, session)); }
    catch(e) { return null; }
  };

  window.kleverSupabase = { isConfigured, getClient };
})();
