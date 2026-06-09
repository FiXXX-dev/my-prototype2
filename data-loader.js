// ===== Clever — единый загрузчик данных (Supabase, кэш в памяти) =====
// ЕДИНСТВЕННЫЙ источник товаров для всех клиентских страниц.
// Никакого localStorage и хардкода: товары всегда берутся из таблицы
// public.products в Supabase и кэшируются в памяти на время жизни страницы
// (один запрос на загрузку страницы; при F5 кэш сбрасывается — новый запрос).
//
// Публичный API (window.*):
//   getProducts()            -> Promise<Array> нормализованных товаров (кэш)
//   getProductsSync()        -> Array уже загруженных товаров (или [] до загрузки)
//   invalidateProductsCache()-> сбросить кэш (например, после правок в админке)
//
// Событие window 'kleverProductsLoaded' срабатывает, когда товары загружены —
// синхронные рендеры (поиск, «недавно смотрели», корзина) перерисовываются по нему.
//
// Зависит от:
//   supabase-client.js  (window.supaGetProducts)
//   categories.js       (window.classifyProduct, window.KLEVER_LEGACY_CAT_TO_ID)
// Поэтому подключается ПОСЛЕ них.

(function () {
  console.log('%c[Clever] data-loader v5 — static JSON (github.io) + cache', 'color:#2ECC71;font-weight:bold');
  let _products = null;        // загруженный и нормализованный массив (кэш)
  let _loadingPromise = null;  // текущий запрос, чтобы не дублировать

  // Приводим строку из Supabase к внутренней форме, которую ждут рендеры,
  // и доклассифицируем подкатегорию по названию (как делал categories.js),
  // если поле subcategory в БД пустое.
  function _normalize(p) {
    const cat = p.cat || '';
    const legacyId = (typeof window !== 'undefined' && window.KLEVER_LEGACY_CAT_TO_ID)
      ? window.KLEVER_LEGACY_CAT_TO_ID[cat] : '';
    const categoryId = p.category_id || p.categoryId || legacyId || '';
    let subcategory = p.subcategory || '';
    if (!subcategory && categoryId && typeof window.classifyProduct === 'function') {
      subcategory = window.classifyProduct(p.name, categoryId) || '';
    }
    return Object.assign({}, p, {
      categoryId: categoryId,
      subcategory: subcategory,
      isHit: !!(p.is_hit || p.isHit),
      img: p.img || '',
      badge: p.badge || undefined,
      desc: p.description || p.desc || '',
      emoji: p.emoji || '📦',
      availability: p.availability || 'in',
    });
  }

  // Грузим статический JSON с github.io (быстро). Supabase — только fallback,
  // если файла ещё нет (первый деплой до первого запуска Action).
  async function _getJson(path, supaFn) {
    try {
      const resp = await fetch(path, { cache: 'no-cache' });
      if (resp.ok) { const a = await resp.json(); if (Array.isArray(a)) return a; }
    } catch (e) {}
    if (typeof supaFn === 'function') {
      try { const d = await supaFn(); if (Array.isArray(d)) return d; }
      catch (e) { console.error('[data-loader] supabase fallback failed', e); }
    }
    return null;
  }

  async function _fetch() {
    const raw = await _getJson('products.json', window.supaGetProducts);
    if (!Array.isArray(raw)) return null; // null = ошибка, не кэшировать
    return raw.filter(p => p.is_active !== false).map(_normalize);
  }

  // Три попытки с задержкой 1 с и 2 с: если первый запрос упал (сеть/DPI),
  // второй или третий обычно проходит.
  async function _fetchWithRetry() {
    const delays = [0, 1000, 2000];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
      const result = await _fetch();
      if (result !== null) return result; // успех
    }
    return null; // все попытки провалились — НЕ затираем кэш
  }

  // ── Кэш в localStorage (stale-while-revalidate) ──────────────────────────
  // На медленной/throttled сети первый запрос к Supabase идёт несколько секунд.
  // Чтобы повторные заходы были мгновенными: сохраняем последний успешный
  // список в localStorage, показываем его сразу, а свежие данные тянем в фоне
  // и обновляем экран по событию. Supabase остаётся источником истины —
  // localStorage лишь кэш для скорости.
  const _CACHE_KEY = 'klever_products_cache_v1';
  function _readCache() {
    try { const a = JSON.parse(localStorage.getItem(_CACHE_KEY) || 'null'); return Array.isArray(a) ? a : null; }
    catch (e) { return null; }
  }
  function _writeCache(list) {
    try { localStorage.setItem(_CACHE_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function _fire() { try { window.dispatchEvent(new Event('kleverProductsLoaded')); } catch (e) {} }

  // Фоновое обновление: тихо тянем свежие товары и обновляем экран, если пришли.
  function _refreshInBackground() {
    if (_loadingPromise) return;
    _loadingPromise = _fetchWithRetry().then(function (list) {
      _loadingPromise = null;
      if (Array.isArray(list) && list.length) { _products = list; _writeCache(list); _fire(); }
    });
  }

  // Возвращает Promise с массивом товаров. Конкурентные вызовы получают
  // один и тот же выполняющийся запрос (без дублирования сетевых обращений).
  window.getProducts = function () {
    if (_products !== null) return Promise.resolve(_products);

    // 1) Есть кэш → показываем мгновенно, обновляем в фоне.
    const cached = _readCache();
    if (cached && cached.length) {
      _products = cached;
      _fire();
      _refreshInBackground();
      return Promise.resolve(_products);
    }

    // 2) Кэша нет (первый заход) → ждём сеть.
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = _fetchWithRetry().then(function (list) {
      _loadingPromise = null;
      if (Array.isArray(list) && list.length) { _products = list; _writeCache(list); }
      else _products = [];
      _fire();
      return _products;
    });
    return _loadingPromise;
  };

  // Синхронный доступ к уже загруженному кэшу (для рендеров, которые не могут ждать).
  window.getProductsSync = function () { return _products || []; };

  // Сбросить кэш — следующий getProducts() сделает свежий запрос.
  window.invalidateProductsCache = function () {
    _products = null;
    _loadingPromise = null;
  };

  // ===== Дерево категорий (categories + subcategories из Supabase) =====
  // Источник дерева каталога — Supabase. Строим, накладывая данные из БД на
  // канонический «скелет» window.DEFAULT_CATEGORIES (фиксированные id, иконки,
  // подкатегории по умолчанию). Это делает загрузку устойчивой: даже если
  // таблицы пустые/недоступны — каталог получит валидное дерево.
  let _catTree = null;
  let _catTreeLoading = null;

  function _cloneDefaults() {
    const defs = (typeof window !== 'undefined' && Array.isArray(window.DEFAULT_CATEGORIES))
      ? window.DEFAULT_CATEGORIES : [];
    return defs.map(function (c) {
      return Object.assign({}, c, {
        subcategories: (c.subcategories || []).map(function (s) { return Object.assign({}, s); }),
      });
    });
  }

  // Собирает плоский список строк подкатегорий одной категории в 2-уровневое
  // дерево: корни (parent_id пустой) + их дети (parent_id = id родителя).
  // Глубже 3-го уровня не уходим — внука прикрепляем к ближайшему известному
  // родителю-корню, иначе делаем корнем (защита от «висячих» ссылок).
  // Привязка под-подкатегории к родителю берётся из колонки parent_id ИЛИ
  // (если её нет) кодируется в id через «~»: "<parent>~<local>". Так 3-й уровень
  // работает без отдельной колонки в Supabase.
  function _subParentOf(s) {
    if (s && s.parent_id) return s.parent_id;
    var id = s && s.id ? String(s.id) : '';
    var i = id.indexOf('~');
    return i > 0 ? id.slice(0, i) : null;
  }
  function _nestSubs(rows) {
    var byOrder = function (a, b) { return (a.order || 0) - (b.order || 0); };
    var nodes = {};
    rows.forEach(function (s) {
      nodes[s.id] = {
        id: s.id, name: s.name, img: s.image_url || '',
        order: s.sort_order != null ? s.sort_order : 0,
        parent_id: _subParentOf(s), children: [],
      };
    });
    var roots = [];
    rows.forEach(function (s) {
      var node = nodes[s.id];
      var pid = _subParentOf(s);
      // Прикрепляем к родителю только если родитель сам корневой (3 уровня max).
      if (pid && nodes[pid] && !(nodes[pid].parent_id)) {
        nodes[pid].children.push(node);
      } else {
        node.parent_id = null;
        roots.push(node);
      }
    });
    roots.sort(byOrder);
    roots.forEach(function (r) { r.children.sort(byOrder); });
    return roots;
  }

  async function _buildTree() {
    // Категории и подкатегории — тоже из статических JSON (быстро), Supabase fallback.
    const supaCats = await _getJson('categories.json', window.supaGetAllCategoriesHP);
    const supaSubs = await _getJson('subcategories.json', window.supaGetSubcategories);

    // Если Supabase недоступен/без категорий — пусть getCategories() возьмёт
    // локальный/дефолтный вариант (возвращаем null).
    if (!Array.isArray(supaCats) || !supaCats.length) return null;

    const tree = _cloneDefaults();
    const byId = {};
    tree.forEach(function (c) { byId[c.id] = c; });

    // Накладываем поля категорий из Supabase (имя, картинка, порядок).
    supaCats.forEach(function (r) {
      if (byId[r.id]) {
        if (r.name) byId[r.id].name = r.name;
        if (r.image_url != null) byId[r.id].img = r.image_url || '';
        if (r.sort_order != null) byId[r.id].order = r.sort_order;
      } else {
        const nc = { id: r.id, name: r.name || r.id, icon: 'box', img: r.image_url || '', order: r.sort_order || 0, subcategories: [] };
        byId[r.id] = nc; tree.push(nc);
      }
    });

    // Подкатегории из Supabase замещают дефолтные для тех категорий,
    // у которых в БД есть хотя бы одна строка. Поддерживаем 3-й уровень:
    // строка с parent_id становится дочерней под-подкатегорией (node.children).
    if (Array.isArray(supaSubs) && supaSubs.length) {
      const byCat = {};
      supaSubs.forEach(function (s) {
        (byCat[s.category_id] = byCat[s.category_id] || []).push(s);
      });
      Object.keys(byCat).forEach(function (catId) {
        if (byId[catId]) byId[catId].subcategories = _nestSubs(byCat[catId]);
      });
    }

    // Сортируем категории и подкатегории по order (children тоже).
    tree.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    tree.forEach(function (c) {
      c.subcategories = (c.subcategories || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      c.subcategories.forEach(function (s) {
        s.children = (s.children || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      });
    });
    return tree;
  }

  window.getCategoryTree = function () {
    if (_catTree) return Promise.resolve(_catTree);
    if (_catTreeLoading) return _catTreeLoading;
    _catTreeLoading = _buildTree().then(function (tree) {
      _catTree = tree; // null если Supabase недоступен — используется дефолт в categories.js
      _catTreeLoading = null;
      try { window.dispatchEvent(new Event('kleverCategoriesLoaded')); } catch (e) {}
      return _catTree;
    });
    return _catTreeLoading;
  };

  window.getCategoryTreeSync = function () { return _catTree; };

  window.invalidateCategoryTreeCache = function () {
    _catTree = null;
    _catTreeLoading = null;
  };

  // ===== Акции (promotions из Supabase / статический promotions.json) =====
  // Источник один — Supabase (через статический JSON для скорости). Никакого
  // хардкода: если акций нет — страницы показывают пустое состояние одинаково
  // во всех браузерах. Поле description из БД маппим в desc (его ждут рендеры).
  let _promos = null;
  let _promosLoading = null;

  function _normalizePromo(p) {
    return {
      id: p.id,
      name: p.name || '',
      disc: p.disc || '',
      color: ['green', 'accent', 'lime'].includes(p.color) ? p.color : 'green',
      badge: p.badge || '',
      desc: p.desc || p.description || '',
      valid: p.valid || '',
      sort_order: p.sort_order != null ? p.sort_order : 0,
      is_active: p.is_active,
    };
  }

  window.getPromotions = function () {
    if (_promos) return Promise.resolve(_promos);
    if (_promosLoading) return _promosLoading;
    _promosLoading = _getJson('promotions.json', window.supaGetPromotions).then(function (arr) {
      _promosLoading = null;
      _promos = Array.isArray(arr) ? arr.filter(function (p) { return p.is_active !== false; }).map(_normalizePromo) : [];
      try { window.dispatchEvent(new Event('kleverPromotionsLoaded')); } catch (e) {}
      return _promos;
    });
    return _promosLoading;
  };

  window.getPromotionsSync = function () { return _promos || []; };

  window.invalidatePromotionsCache = function () {
    _promos = null;
    _promosLoading = null;
  };

  // ===== Новости (news из Supabase / статический news.json) =====
  let _news = null;
  let _newsLoading = null;

  function _normalizeNewsItem(n) {
    return {
      id: n.id,
      title: n.title || '',
      text: n.text || '',
      color: ['green', 'orange', 'blue'].includes(n.color) ? n.color : 'green',
      is_active: n.is_active !== false,
      active: n.is_active !== false,
      created: n.created_at ? new Date(n.created_at).getTime() : 0,
      sort_order: n.sort_order != null ? n.sort_order : 0,
    };
  }

  window.getNews = function () {
    if (_news) return Promise.resolve(_news);
    if (_newsLoading) return _newsLoading;
    _newsLoading = _getJson('news.json', window.supaGetNews).then(function (arr) {
      _newsLoading = null;
      _news = Array.isArray(arr) ? arr.filter(function (n) { return n.is_active !== false; }).map(_normalizeNewsItem) : [];
      try { window.dispatchEvent(new Event('kleverNewsLoaded')); } catch (e) {}
      return _news;
    });
    return _newsLoading;
  };

  window.getNewsSync = function () { return _news || []; };

  window.invalidateNewsCache = function () {
    _news = null;
    _newsLoading = null;
  };

  // ===== Настройки (settings из Supabase / статический settings.json) =====
  let _settings = null;
  let _settingsLoading = null;

  // Приводим строку настроек (snake_case из БД ИЛИ legacy camelCase из
  // localStorage) к единой форме, которую читают клиентские страницы.
  function _normalizeSettings(s) {
    s = s || {};
    function pick() { for (let i = 0; i < arguments.length; i++) { if (arguments[i] != null && arguments[i] !== '') return arguments[i]; } return arguments[arguments.length - 1]; }
    let pickups = s.pickup_locations != null ? s.pickup_locations : s.pickupLocations;
    if (typeof pickups === 'string') { try { pickups = JSON.parse(pickups); } catch (e) { pickups = []; } }
    if (!Array.isArray(pickups)) pickups = [];
    const out = {
      phone1: s.phone1 || '',
      phone2: s.phone2 || '',
      email: s.email || '',
      address: s.address || '',
      minOrder: Number(pick(s.min_order, s.minOrder, 0)) || 0,
      freeDelivery: Number(pick(s.free_delivery, s.freeDelivery, 0)) || 0,
      deliveryCost: Number(pick(s.delivery_cost, s.deliveryCost, 0)) || 0,
      pickupLocations: pickups,
    };
    // Мессенджеры включаем только если значение реально задано (включая
    // пустую строку = «скрыть кнопку»). Если поле никогда не сохранялось
    // (null), не добавляем ключ — тогда страница применит свой URL по умолчанию.
    const maxv = s.max_link != null ? s.max_link : s.max;
    if (s.whatsapp != null) out.whatsapp = s.whatsapp;
    if (s.telegram != null) out.telegram = s.telegram;
    if (maxv != null) out.max = maxv;
    return out;
  }

  async function _fetchSettings() {
    // 1. Пробуем Supabase (авторитетный источник)
    if (typeof window.supaGetSettings === 'function') {
      try {
        const d = await window.supaGetSettings();
        if (d && typeof d === 'object' && Object.keys(d).length) return d;
      } catch (e) { console.warn('[data-loader] supabase settings failed, trying json', e); }
    }
    // 2. Fallback: статический settings.json
    try {
      const resp = await fetch('settings.json', { cache: 'no-cache' });
      if (resp.ok) {
        const obj = await resp.json();
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length) return obj;
      }
    } catch (e) {}
    return {};
  }

  // Обновляет общие для всех страниц элементы из настроек: телефон в шапке
  // (.btn-phone). Так номер меняется сайт-wide без правки каждой страницы.
  function _applyGlobalSettingsToDom() {
    if (!_settings) return;
    const phone = (_settings.phone1 || '').trim();
    if (!phone) return;
    const tel = 'tel:+' + phone.replace(/[^\d]/g, '');
    document.querySelectorAll('a.btn-phone').forEach(function (a) {
      // Сохраняем иконку, меняем только href и текст номера.
      const icon = a.querySelector('.icon');
      a.setAttribute('href', tel);
      a.innerHTML = (icon ? icon.outerHTML : '') + ' ' + phone;
    });
  }

  window.getSettings = function () {
    if (_settings) return Promise.resolve(_settings);
    if (_settingsLoading) return _settingsLoading;
    _settingsLoading = _fetchSettings().then(function (obj) {
      _settingsLoading = null;
      _settings = _normalizeSettings(obj);
      try { window.dispatchEvent(new Event('kleverSettingsLoaded')); } catch (e) {}
      try { _applyGlobalSettingsToDom(); } catch (e) {}
      return _settings;
    });
    return _settingsLoading;
  };

  // Если настройки успели загрузиться до готовности DOM — применим повторно.
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      try { _applyGlobalSettingsToDom(); } catch (e) {}
    });
  }

  window.getSettingsSync = function () { return _settings || {}; };

  window.invalidateSettingsCache = function () {
    _settings = null;
    _settingsLoading = null;
  };

  // Запускаем загрузку сразу при подключении скрипта — к моменту рендера
  // данные уже в пути (или готовы).
  window.getProducts();
  window.getCategoryTree();
  window.getPromotions();
  window.getNews();
  window.getSettings();
})();
