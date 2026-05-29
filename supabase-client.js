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
  // opts = { phone, email } — matched alongside user_id in a single OR query.
  // Phone is matched with ilike+% so +7/8/no-code formats all hit.
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
      // Normalize phone to last 10 digits so +7/8/no-code all match via ilike
      const phone = ((opts && opts.phone) || '').replace(/\D/g, '').slice(-10);
      const email = ((opts && opts.email) || '').toLowerCase().trim();

      // Build a single OR filter covering all identifiers at once.
      // This fixes the bug where the old code stopped at user_id if ≥1 row was found,
      // missing orders stored with only phone/email.
      const filters = [];
      if (userId) filters.push(`user_id.eq.${userId}`);
      if (phone)  filters.push(`customer_phone.ilike.%${phone}%`);
      if (email)  filters.push(`customer_email.ilike.%${email}%`);

      if (filters.length === 0) return [];

      let { data, error } = await sb.from('orders').select('*')
        .or(filters.join(','))
        .order('created_at', { ascending: false });

      // If user_id column is absent in old schema, retry without it
      if (error && isMissingCol(error)) {
        const fallback = filters.filter(f => !f.startsWith('user_id'));
        if (fallback.length === 0) return [];
        ({ data, error } = await sb.from('orders').select('*')
          .or(fallback.join(','))
          .order('created_at', { ascending: false }));
      }

      if (error) { console.error('[supabase] list orders by user', error); return null; }

      // Deduplicate (OR can theoretically return duplicates if multiple filters hit one row)
      const seen = new Set();
      const rows = [];
      for (const r of (data || [])) {
        if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
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
  // supaGetFavorites([email])           → string[] of product_sku
  // supaListFavorites([email])          → alias of supaGetFavorites
  // supaAddFavorite(sku) | (email, sku) → { ok }
  // supaRemoveFavorite(sku) | (email, sku) → { ok }
  window.supaGetFavorites = async function(email){
    const sb = getClient(); if (!sb) return null;
    try {
      const key = resolveUserKey(email);
      if (!key) return [];
      const { data, error } = await sb.from('favorites').select('product_sku').eq('user_email', key);
      if (error) { console.error('[supabase] get favorites', error); return null; }
      return (data || []).map(r => r.product_sku);
    } catch(e) { console.error('[supabase] get favorites exception', e); return null; }
  };
  window.supaListFavorites = window.supaGetFavorites;

  window.supaAddFavorite = async function(a, b){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      let key, sku;
      if (b !== undefined) { key = resolveUserKey(a); sku = b; }
      else { sku = a; key = resolveUserKey(); }
      if (!key || !sku) return { ok:false, reason:'no_identity' };
      const idn = currentUserIdentity();
      const { error } = await sb.from('favorites')
        .upsert({ user_email: key, user_phone: (idn && idn.phone10) || null, product_sku: sku },
                { onConflict: 'user_email,product_sku' });
      return error ? { ok:false, error } : { ok:true };
    } catch(e) { return { ok:false, error:e }; }
  };

  window.supaRemoveFavorite = async function(a, b){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      let key, sku;
      if (b !== undefined) { key = resolveUserKey(a); sku = b; }
      else { sku = a; key = resolveUserKey(); }
      if (!key || !sku) return { ok:false, reason:'no_identity' };
      const { error } = await sb.from('favorites').delete().match({ user_email: key, product_sku: sku });
      return error ? { ok:false, error } : { ok:true };
    } catch(e) { return { ok:false, error:e }; }
  };

  // ===== addresses (email-keyed, table: public.user_addresses) =====
  window.supaListAddressesByEmail = async function(email){
    const sb = getClient(); if (!sb) return null;
    try {
      const key = resolveUserKey(email);
      if (!key) return [];
      const { data, error } = await sb.from('user_addresses').select('*')
        .eq('user_email', key).order('is_default', { ascending: false }).order('id', { ascending: true });
      if (error) { console.error('[supabase] list addresses by email', error); return null; }
      return data || [];
    } catch(e) { return null; }
  };

  // addr = { label, address, is_default, email? }
  window.supaSaveAddress = async function(addr){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const key = resolveUserKey(addr && addr.email);
      if (!key) return { ok:false, reason:'no_identity' };
      if (addr.is_default) {
        await sb.from('user_addresses').update({ is_default: false }).eq('user_email', key);
      }
      const { data, error } = await sb.from('user_addresses')
        .insert([{ user_email: key, label: addr.label, address: addr.address, is_default: !!addr.is_default }])
        .select();
      if (error) return { ok:false, error };
      return { ok:true, data: data && data[0] };
    } catch(e) { return { ok:false, error:e }; }
  };

  window.supaUpdateAddressById = async function(id, addr){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const key = resolveUserKey(addr && addr.email);
      if (addr.is_default && key) {
        await sb.from('user_addresses').update({ is_default: false }).eq('user_email', key);
      }
      const { data, error } = await sb.from('user_addresses')
        .update({ label: addr.label, address: addr.address, is_default: !!addr.is_default })
        .eq('id', id).select();
      if (error) return { ok:false, error };
      return { ok:true, data: data && data[0] };
    } catch(e) { return { ok:false, error:e }; }
  };

  window.supaDeleteAddressById = async function(id){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
      const { error } = await sb.from('user_addresses').delete().eq('id', id);
      return error ? { ok:false, error } : { ok:true };
    } catch(e) { return { ok:false, error:e }; }
  };

  // ===== profile (table: public.user_profiles, keyed by user_id text) =====
  window.supaGetProfile = async function(userId){
    const sb = getClient(); if (!sb) return null;
    try {
      const { data, error } = await sb.from('user_profiles').select('*').eq('user_id', String(userId)).maybeSingle();
      if (error) { console.error('[supabase] get profile', error); return null; }
      return data || null;
    } catch(e) { return null; }
  };

  // p = { user_id, email, phone, first_name, last_name, middle_name, user_type, company, inn }
  window.supaUpsertProfile = async function(p){
    const sb = getClient(); if (!sb) return { ok:false, reason:'unconfigured' };
    try {
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
      const { data, error } = await sb.from('user_profiles').upsert(row, { onConflict: 'user_id' }).select();
      if (error) return { ok:false, error };
      return { ok:true, data: data && data[0] };
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
