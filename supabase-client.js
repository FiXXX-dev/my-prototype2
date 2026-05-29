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
//     language        text default 'ru'
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

    const minimal = {
      customer_name: order.name || '',
      customer_phone: order.phone || '',
      items: order.items || [],
      total_price: order.total != null ? Number(order.total) : 0,
      language: language,
      comment: order.comment || '',
    };
    // Optional fields — if your table has these columns they'll be filled.
    const optional = {
      num: order.num,
      status: order.status || 'new',
      customer_email: order.email || '',
      company: order.company || '',
      subtotal: order.subtotal != null ? Number(order.subtotal) : null,
      delivery_cost: order.delivery != null ? Number(order.delivery) : null,
      delivery_method: order.method || 'courier',
      delivery_address: order.address || '',
      payment_method: order.payment || 'cash',
      invoice_company: order.invoiceCompany || null,
      invoice_inn: order.invoiceInn || null,
    };
    async function insert(row){
      return await sb.from('orders').insert([row]).select();
    }
    function isMissingColumnError(error){
      const msg = (error?.message || '') + ' ' + (error?.details || '');
      return /column .* does not exist/i.test(msg)
          || /Could not find/i.test(msg)
          || error?.code === '42703'
          || error?.code === 'PGRST204';
    }
    try {
      // Phase 1: rich payload
      let { data, error } = await insert({ ...minimal, ...optional });
      if (!error) return { ok: true, data: data && data[0] };
      if (!isMissingColumnError(error)) {
        console.error('[supabase] insert error', error);
        return { ok: false, error };
      }
      // Phase 2: minimal (includes comment so it lands when the column exists)
      console.warn('[supabase] retrying without optional columns:', error.message);
      let r2 = await insert(minimal);
      if (!r2.error) return { ok: true, data: r2.data && r2.data[0], retried: 'minimal' };
      if (!isMissingColumnError(r2.error)) {
        console.error('[supabase] minimal insert error', r2.error);
        return { ok: false, error: r2.error };
      }
      // Phase 3: minimal without comment (bare-bones schema)
      console.warn('[supabase] retrying without comment column:', r2.error.message);
      const { comment, ...minimalNoComment } = minimal;
      const r3 = await insert(minimalNoComment);
      if (r3.error) {
        console.error('[supabase] bare insert also failed', r3.error);
        return { ok: false, error: r3.error };
      }
      return { ok: true, data: r3.data && r3.data[0], retried: 'bare' };
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
      if (error && missing(error)) {
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
      let { error } = await sb.from('orders').delete().eq('num', numOrId);
      if (error && missing(error)) {
        ({ error } = await sb.from('orders').delete().eq('id', numOrId));
      }
      if (error) { console.error('[supabase] delete error', error); return { ok: false, error }; }
      return { ok: true };
    } catch (e) {
      console.error('[supabase] delete exception', e);
      return { ok: false, error: e };
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
