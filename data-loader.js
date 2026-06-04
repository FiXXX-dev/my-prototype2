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
  console.log('%c[Clever] data-loader v4 — instant cache + background refresh', 'color:#2ECC71;font-weight:bold');
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
    });
  }

  async function _fetch() {
    if (typeof window.supaGetProducts !== 'function') {
      console.error('[data-loader] supaGetProducts недоступен — проверьте порядок подключения скриптов');
      return null; // null = ошибка, не кэшировать
    }
    try {
      const data = await window.supaGetProducts();
      if (Array.isArray(data)) return data.filter(p => p.is_active !== false).map(_normalize);
      console.error('[data-loader] Supabase вернул не массив товаров:', data);
      return null; // null = ошибка, не кэшировать
    } catch (e) {
      console.error('[data-loader] ошибка загрузки товаров:', e);
      return null; // null = ошибка, не кэшировать
    }
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

  async function _buildTree() {
    let supaCats = null, supaSubs = null;
    try {
      if (typeof window.supaGetAllCategoriesHP === 'function') supaCats = await window.supaGetAllCategoriesHP();
    } catch (e) { console.error('[data-loader] categories fetch failed', e); }
    try {
      if (typeof window.supaGetSubcategories === 'function') supaSubs = await window.supaGetSubcategories();
    } catch (e) { console.error('[data-loader] subcategories fetch failed', e); }

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
    // у которых в БД есть хотя бы одна строка.
    if (Array.isArray(supaSubs) && supaSubs.length) {
      const grouped = {};
      supaSubs.forEach(function (s) {
        (grouped[s.category_id] = grouped[s.category_id] || []).push({
          id: s.id, name: s.name, img: s.image_url || '', order: s.sort_order != null ? s.sort_order : 0,
        });
      });
      Object.keys(grouped).forEach(function (catId) {
        if (byId[catId]) byId[catId].subcategories = grouped[catId];
      });
    }

    // Сортируем категории и подкатегории по order.
    tree.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    tree.forEach(function (c) {
      c.subcategories = (c.subcategories || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
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

  // Запускаем загрузку сразу при подключении скрипта — к моменту рендера
  // данные уже в пути (или готовы).
  window.getProducts();
  window.getCategoryTree();
})();
