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

  window.supaInsertOrder = async function(order){
    const sb = getClient();
    if (!sb) return { ok: false, reason: 'unconfigured' };
    let language = 'ru';
    try { language = localStorage.getItem('klever_lang') || 'ru'; } catch(e){}
    const row = {
      num: order.num,
      customer_name: order.name || '',
      customer_phone: order.phone || '',
      customer_email: order.email || '',
      company: order.company || '',
      items: order.items || [],
      subtotal: order.subtotal != null ? order.subtotal : null,
      delivery_cost: order.delivery != null ? order.delivery : null,
      total_price: order.total != null ? order.total : 0,
      delivery_method: order.method || 'courier',
      delivery_address: order.address || '',
      payment_method: order.payment || 'cash',
      invoice_company: order.invoiceCompany || null,
      invoice_inn: order.invoiceInn || null,
      comment: order.comment || '',
      status: order.status || 'new',
      language: language,
    };
    try {
      const { data, error } = await sb.from('orders').insert([row]).select();
      if (error) { console.error('[supabase] insert error', error); return { ok: false, error }; }
      return { ok: true, data: data && data[0] };
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
        num: r.num,
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

  window.supaUpdateOrder = async function(num, fields){
    const sb = getClient();
    if (!sb) return { ok: false, reason: 'unconfigured' };
    try {
      const { data, error } = await sb.from('orders').update(fields).eq('num', num).select();
      if (error) { console.error('[supabase] update error', error); return { ok: false, error }; }
      return { ok: true, data };
    } catch (e) {
      console.error('[supabase] update exception', e);
      return { ok: false, error: e };
    }
  };

  window.supaDeleteOrder = async function(num){
    const sb = getClient();
    if (!sb) return { ok: false, reason: 'unconfigured' };
    try {
      const { error } = await sb.from('orders').delete().eq('num', num);
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

  window.kleverSupabase = { isConfigured, getClient };
})();
