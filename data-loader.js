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
      return [];
    }
    try {
      const data = await window.supaGetProducts();
      if (Array.isArray(data)) return data.map(_normalize);
      console.error('[data-loader] Supabase вернул не массив товаров:', data);
      return [];
    } catch (e) {
      console.error('[data-loader] ошибка загрузки товаров:', e);
      return [];
    }
  }

  // Возвращает Promise с массивом товаров. Конкурентные вызовы получают
  // один и тот же выполняющийся запрос (без дублирования сетевых обращений).
  window.getProducts = function () {
    if (_products) return Promise.resolve(_products);
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = _fetch().then(function (list) {
      _products = list;
      _loadingPromise = null;
      try { window.dispatchEvent(new Event('kleverProductsLoaded')); } catch (e) {}
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

  // Запускаем загрузку сразу при подключении скрипта — к моменту рендера
  // данные уже в пути (или готовы).
  window.getProducts();
})();
