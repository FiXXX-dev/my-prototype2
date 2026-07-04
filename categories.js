// ===== Clever — hierarchical category structure =====
// Data lives in localStorage.klever_categories. Each category has:
//   id, name, icon (matches an .icon-* class), img (URL or ""),
//   order, subcategories[].
// Each subcategory: id, name, img, order.
//
// This file also provides helpers used by catalog.html, product.html,
// checkout, admin and the data migration that distributes existing
// products into subcategories on first load.

const KLEVER_CATEGORIES_KEY = 'klever_categories';
const KLEVER_PRODUCTS_KEY = 'klever_products_v2';

const DEFAULT_CATEGORIES = [
  {
    id: 'disposable', name: 'Одноразовая посуда', icon: 'takeaway', img: '', order: 1,
    subcategories: [
      { id: 'cups', name: 'Стаканы', img: '', order: 1 },
      { id: 'eco', name: 'Эко-посуда', img: '', order: 2 },
      { id: 'containers-rect', name: 'Контейнеры прямоугольные', img: '', order: 3 },
      { id: 'containers-round', name: 'Контейнеры круглые', img: '', order: 4 },
      { id: 'clamshell', name: 'Контейнеры-ракушки', img: '', order: 5 },
      { id: 'fastfood', name: 'Упаковка для фастфуда', img: '', order: 6 },
      { id: 'lunchbox', name: 'Ланч-боксы', img: '', order: 7 },
      { id: 'pizza', name: 'Коробки для пиццы', img: '', order: 8 },
      { id: 'sauce', name: 'Соусники', img: '', order: 9 },
      { id: 'plates', name: 'Тарелки, миски', img: '', order: 10 },
      { id: 'cutlery', name: 'Столовые приборы', img: '', order: 11 },
      { id: 'sushi', name: 'Для суши и лапши', img: '', order: 12 },
      { id: 'bottles', name: 'Бутылки ПЭТ', img: '', order: 13 },
      { id: 'trays', name: 'Лотки', img: '', order: 14 },
      { id: 'bakery', name: 'Для кондитерских изделий', img: '', order: 15 },
    ],
  },
  {
    id: 'chemistry', name: 'Бытовая химия', icon: 'spray', img: '', order: 2,
    subcategories: [
      { id: 'dishwashing', name: 'Для мытья посуды', img: '', order: 1 },
      { id: 'floor', name: 'Для пола', img: '', order: 2 },
      { id: 'kitchen', name: 'Для кухни', img: '', order: 3 },
      { id: 'bathroom', name: 'Для санузла', img: '', order: 4 },
      { id: 'laundry', name: 'Стирка', img: '', order: 5 },
      { id: 'soap', name: 'Мыло и антисептики', img: '', order: 6 },
      { id: 'freshener', name: 'Освежители воздуха', img: '', order: 7 },
    ],
  },
  {
    id: 'paper', name: 'Бумажная продукция', icon: 'paper-roll', img: '', order: 3,
    subcategories: [
      { id: 'toilet', name: 'Туалетная бумага', img: '', order: 1 },
      { id: 'towels', name: 'Бумажные полотенца', img: '', order: 2 },
      { id: 'napkins', name: 'Салфетки', img: '', order: 3 },
      { id: 'dispenser', name: 'Для диспенсеров', img: '', order: 4 },
    ],
  },
  {
    id: 'protection', name: 'Средства защиты', icon: 'shield', img: '', order: 4,
    subcategories: [
      { id: 'gloves-nitrile', name: 'Перчатки нитриловые', img: '', order: 1 },
      { id: 'gloves-latex', name: 'Перчатки латексные', img: '', order: 2 },
      { id: 'gloves-household', name: 'Перчатки хозяйственные', img: '', order: 3 },
      { id: 'masks', name: 'Маски и респираторы', img: '', order: 4 },
      { id: 'clothing', name: 'Одежда одноразовая', img: '', order: 5 },
    ],
  },
  {
    id: 'packaging', name: 'Упаковка', icon: 'box', img: '', order: 5,
    subcategories: [
      { id: 'bags', name: 'Пакеты-майки', img: '', order: 1 },
      { id: 'film', name: 'Плёнки и стрейч', img: '', order: 2 },
      { id: 'kraft', name: 'Крафт-пакеты', img: '', order: 3 },
      { id: 'vacuum', name: 'Вакуумные пакеты', img: '', order: 4 },
      { id: 'ziplock', name: 'Zip-lock пакеты', img: '', order: 5 },
    ],
  },
  {
    id: 'household', name: 'Хозтовары', icon: 'broom', img: '', order: 6,
    subcategories: [
      { id: 'trash', name: 'Мешки для мусора', img: '', order: 1 },
      { id: 'foil', name: 'Фольга и плёнка пищевая', img: '', order: 2 },
      { id: 'cleaning', name: 'Тряпки и губки', img: '', order: 3 },
      { id: 'tools', name: 'Инвентарь для уборки', img: '', order: 4 },
    ],
  },
  {
    id: 'stationery', name: 'Канцелярия', icon: 'paperclip', img: '', order: 7,
    subcategories: [],
  },
];

// Cosmetic gradient palette for category cards when no img is set.
const KLEVER_CATEGORY_GRADIENTS = {
  disposable: ['#ffe9a8', '#ffd166'],
  chemistry:  ['#b8d8ff', '#7ab8ff'],
  paper:      ['#c8f5dc', '#7ee0a8'],
  protection: ['#ffd0d0', '#ff9a9a'],
  packaging:  ['#ddb8ff', '#b889e8'],
  household:  ['#b8f0e4', '#6dd6c2'],
  stationery: ['#ffd8a8', '#ffae5c'],
};

// Map legacy product.cat string -> new category id.
const KLEVER_LEGACY_CAT_TO_ID = {
  'Одноразовая посуда': 'disposable',
  'Бытовая химия': 'chemistry',
  'Бумажная продукция': 'paper',
  'Средства защиты': 'protection',
  'Упаковка': 'packaging',
  'Хозтовары': 'household',
  'Канцелярия': 'stationery',
};

// ---------- category tree source ----------
// Единый источник дерева категорий — Supabase (через data-loader.js,
// window.getCategoryTreeSync). Пока оно не загрузилось (или Supabase
// недоступен) — мягкий откат на localStorage, затем на DEFAULT_CATEGORIES.
// Так ничего не ломается до того, как БД наполнена.
function getCategories() {
  try {
    if (typeof window !== 'undefined' && typeof window.getCategoryTreeSync === 'function') {
      const tree = window.getCategoryTreeSync();
      if (Array.isArray(tree) && tree.length) return tree;
    }
  } catch (e) {}
  try {
    const raw = localStorage.getItem(KLEVER_CATEGORIES_KEY);
    if (!raw) {
      localStorage.setItem(KLEVER_CATEGORIES_KEY, JSON.stringify(DEFAULT_CATEGORIES));
      return DEFAULT_CATEGORIES;
    }
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : DEFAULT_CATEGORIES;
  } catch (e) { return DEFAULT_CATEGORIES; }
}
function setCategories(arr) {
  localStorage.setItem(KLEVER_CATEGORIES_KEY, JSON.stringify(arr));
}
function getCategoryById(id) {
  return getCategories().find(c => c.id === id) || null;
}
function getCategoryByLegacyName(name) {
  const id = KLEVER_LEGACY_CAT_TO_ID[name];
  return id ? getCategoryById(id) : null;
}
// Ищет подкатегорию по id среди уровня-2 и их детей (уровень-3).
function getSubcategoryById(catId, subId) {
  const c = getCategoryById(catId);
  if (!c) return null;
  for (const s of (c.subcategories || [])) {
    if (s.id === subId) return s;
    for (const k of (s.children || [])) {
      if (k.id === subId) return k;
    }
  }
  return null;
}
// Дочерние под-подкатегории (уровень-3) данной подкатегории уровня-2.
function getSubChildren(catId, subId) {
  const s = getSubcategoryById(catId, subId);
  return (s && Array.isArray(s.children)) ? s.children : [];
}
// id родительской подкатегории уровня-2 для под-подкатегории уровня-3 (или null).
function getSubParentId(catId, subId) {
  const c = getCategoryById(catId);
  if (!c) return null;
  for (const s of (c.subcategories || [])) {
    for (const k of (s.children || [])) {
      if (k.id === subId) return s.id;
    }
  }
  return null;
}

// Sort categories by order, subcategories (и их детей) by order.
function sortedCategories() {
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
  return getCategories().slice().sort(byOrder).map(c => ({
    ...c,
    subcategories: (c.subcategories || []).slice().sort(byOrder).map(s => ({
      ...s,
      children: (s.children || []).slice().sort(byOrder),
    })),
  }));
}

// Count products per category / subcategory.
// Источник — товары из Supabase, загруженные data-loader.js в память
// (window.getProductsSync). Никакого localStorage.
function _liveProducts() {
  if (typeof window === 'undefined') return [];
  // Клиентские страницы: товары из data-loader (products.json) в памяти.
  if (typeof window.getProductsSync === 'function') {
    const live = window.getProductsSync() || [];
    if (live.length) return live;
  }
  // Админка: data-loader не подключён — берём её собственный источник товаров.
  if (typeof window.getProducts === 'function') {
    try { return window.getProducts() || []; } catch (e) {}
  }
  return [];
}
function productCountByCategory() {
  const products = _liveProducts();
  const counts = {};
  for (const p of products) {
    const id = p.categoryId || KLEVER_LEGACY_CAT_TO_ID[p.cat] || null;
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}
function productCountBySubcategory(catId) {
  const products = _liveProducts();
  const counts = {};
  for (const p of products) {
    const id = p.categoryId || KLEVER_LEGACY_CAT_TO_ID[p.cat] || null;
    if (id !== catId) continue;
    if (p.subcategory) counts[p.subcategory] = (counts[p.subcategory] || 0) + 1;
  }
  return counts;
}
// Суммарное число товаров узла: собственные + всех его детей (уровень-3).
function subcategoryRollupCount(node, directCounts) {
  if (!node) return 0;
  let n = directCounts[node.id] || 0;
  for (const k of (node.children || [])) n += directCounts[k.id] || 0;
  return n;
}

// ---------- product → subcategory auto-classification ----------
// Pattern list: ordered, first match wins. Patterns are case-insensitive
// regex strings against product.name.
const KLEVER_SUBCATEGORY_PATTERNS = {
  // Disposable
  'disposable.cups':            ['стакан', 'стак\\. ', 'cup', 'чашк.*коф', 'стопк.*одноразов', 'бокал'],
  'disposable.eco':             ['эко', 'крафт.*стакан', 'крафт.*тарел', 'бумажн.*стакан', 'бумажн.*тарел', 'кукуруз', 'контейнер бумажн'],
  'disposable.containers-rect': ['контейнер.*прям', 'прямоугол.*контейнер', 'контейнер ПР', 'судок.*прям', 'контейнер.*с крышкой', 'контейнер.*для салат', 'контейнер.*\\d+.секц', 'контейнер.*для суп', 'контейнер.*плоск', 'контейнер.*с разделит', 'контейнер.*салатник'],
  'disposable.containers-round':['контейнер.*кругл', 'кругл.*контейнер', 'контейнер кр', 'судок.*кругл'],
  'disposable.clamshell':       ['ракушк', 'clamshell', 'контейнер.*шарни'],
  'disposable.fastfood':        ['бургер', 'хот.?дог', 'fast.?food', 'fastfood', 'наггетс', 'фри', 'контейнер.*морепрод'],
  'disposable.lunchbox':        ['ланч', 'lunch.?box'],
  'disposable.pizza':           ['пицц'],
  'disposable.sauce':           ['соусн', 'соус.*контейнер'],
  'disposable.plates':          ['тарелк', 'миск'],
  'disposable.cutlery':         ['ложк', 'вилк', 'нож одноразов', 'нож пластик', 'нож.*premium', 'дерев.*нож', 'столов.*прибор', 'шпажк', 'шампур', 'трубочк', 'соломк', 'размешив', 'зубочистк', 'палочк.*коф', 'палочк.*канап', 'зонтик.*кокт', 'шейкер'],
  'disposable.sushi':           ['суш', 'лапш', 'роллов', 'wok', 'вок\\b', 'подставк.*ролл'],
  'disposable.bottles':         ['бутылк', 'пэт ', 'пэт\\b', 'дозатор.*бутылк'],
  'disposable.trays':           ['лоток', 'поднос'],
  'disposable.bakery':          ['кондитер', 'для торт', 'тортниц', 'капкейк', 'капсул.*кекс', 'маффин', 'пирожн'],
  // Chemistry
  'chemistry.dishwashing':      ['для посуд', 'fairy', 'pril', 'aos', 'миф', 'gala'],
  'chemistry.floor':            ['для пол', 'mr\\. proper', 'proper.*пол'],
  'chemistry.kitchen':          ['жироудал', 'для плит', 'для кухн', 'духов', 'пемолюкс', 'help', 'cif', 'азелит', 'чистящ.*порошок', 'чистящ.*средств'],
  'chemistry.bathroom':         ['санокс', 'санит', 'унитаз', 'ванн', 'для туал', 'для сантехн', 'плесен', 'известк', 'rail', 'белизн', 'domestos', 'крот', 'tiret', 'sanita', 'антиржав', 'засор', 'для прочистки', 'stop'],
  'chemistry.laundry':          ['стирк', 'стиральн', 'порошок.*стиральн', 'ять', 'tide', 'persil', 'ariel', 'synergetic', 'калгон'],
  'chemistry.soap':             ['мыло', 'антисепт', 'руки.*обраб'],
  'chemistry.freshener':        ['освежит', 'glade', 'воздух'],
  // Paper
  'paper.toilet':               ['туалет.*бумаг', 'бумаг.*туалет', 'tu\\b', 'tu '],
  'paper.towels':               ['полотенц.*бумаж', 'бумажн.*полотенц', 'kitchen.*roll', 'полотенц.*рулон', 'рулонн.*полотенц'],
  'paper.napkins':              ['салфет'],
  'paper.dispenser':            ['диспенсер', 'z-сложен', 'z\\-сложен', 'wepa', 'V-сложен', 'v\\-сложен'],
  // Protection
  'protection.gloves-nitrile':  ['нитрилов'],
  'protection.gloves-latex':    ['латексн'],
  'protection.gloves-household':['хозяйствен.*перчатк', 'перчатк.*хоз', 'перчатк.*винил', 'перчатк.*пвх', 'перчатк.*рабоч', 'перчатк.*уборк', 'перчатк.*х/б', 'перчатк.*hdpe', 'перчатк.*одноразов'],
  'protection.masks':           ['маск', 'респират', 'пилотк.*мед', 'очки.*защит'],
  'protection.clothing':        ['халат', 'шапочк', 'бахил', 'нарукавн', 'фартук'],
  // Packaging
  'packaging.bags':              ['пакет.*майк', 'майк\\b', 'фасовочн.*пакет', 'пакет.*фасовочн', 'шпагат'],
  'packaging.film':              ['стрейч', 'плёнк.*упак', 'пленк.*упак', 'плёнка.*стрейч', 'пузырьк.*плёнк', 'пузырьк.*пленк', 'скотч', 'лента.*упак', 'стикер.*маркир'],
  'packaging.kraft':             ['крафт.*пакет', 'крафт.*мешок', 'пакет.*крафт', 'крафт.*с ручк', 'кондитер.*мешок'],
  'packaging.vacuum':            ['вакуум'],
  'packaging.ziplock':           ['zip', 'зип.?лок', 'зип лок', 'слайдер', 'пакет.*с замк'],
  // Household
  'household.trash':             ['мусорн.*мешок', 'мешок.*мусор', 'мешок.*для мусор', 'мешк.*для мусор', 'мешок.*с завязк', 'мешк.*с завязк', 'мешки.*\\d+ л'],
  'household.foil':              ['фольг', 'пищев.*плёнк', 'пищев.*пленк'],
  'household.cleaning':          ['тряпк', 'губк', 'микрофибр', 'мочалк', 'вафельн.*полотн', 'салфетк.*микро', 'салфетк.*уборк', 'салфетк.*универсал'],
  'household.tools':             ['ёршик', 'ершик', 'швабр', 'веник', 'совок', 'ведр'],
};

function classifyProduct(name, catId) {
  const lname = (name || '').toLowerCase();
  for (const [key, pats] of Object.entries(KLEVER_SUBCATEGORY_PATTERNS)) {
    const [cid, sid] = key.split('.');
    if (cid !== catId) continue;
    for (const pat of pats) {
      try {
        if (new RegExp(pat, 'i').test(lname)) return sid;
      } catch (e) {}
    }
  }
  return null;
}

// One-time migration: walk products and attach categoryId + subcategory.
// Idempotent — only fills missing values, never overwrites manually set ones.
function migrateProductsToSubcategories() {
  let products = null;
  try { products = JSON.parse(localStorage.getItem(KLEVER_PRODUCTS_KEY)); } catch (e) { return 0; }
  if (!Array.isArray(products) || !products.length) return 0;
  let changed = 0;
  for (const p of products) {
    if (!p.categoryId) {
      const id = KLEVER_LEGACY_CAT_TO_ID[p.cat];
      if (id) { p.categoryId = id; changed++; }
    }
    if (!p.subcategory && p.categoryId) {
      const sub = classifyProduct(p.name, p.categoryId);
      if (sub) { p.subcategory = sub; changed++; }
    }
  }
  if (changed) localStorage.setItem(KLEVER_PRODUCTS_KEY, JSON.stringify(products));
  return changed;
}

// Auto-run idempotent migration so existing products get categoryId/subcategory.
// Deferred to DOMContentLoaded so page-specific seeding (catalog/product/admin)
// has finished writing klever_products_v2 first.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  function _kleverRunCategoryBootstrap() {
    try {
      if (!localStorage.getItem(KLEVER_CATEGORIES_KEY)) {
        localStorage.setItem(KLEVER_CATEGORIES_KEY, JSON.stringify(DEFAULT_CATEGORIES));
      }
      migrateProductsToSubcategories();
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _kleverRunCategoryBootstrap);
  } else {
    _kleverRunCategoryBootstrap();
  }
  // Also run shortly after — catches lazy product seeds done in DOMContentLoaded handlers.
  setTimeout(_kleverRunCategoryBootstrap, 600);
}

if (typeof window !== 'undefined') {
  window.KLEVER_CATEGORIES_KEY = KLEVER_CATEGORIES_KEY;
  window.KLEVER_PRODUCTS_KEY = KLEVER_PRODUCTS_KEY;
  window.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;
  window.KLEVER_CATEGORY_GRADIENTS = KLEVER_CATEGORY_GRADIENTS;
  window.KLEVER_LEGACY_CAT_TO_ID = KLEVER_LEGACY_CAT_TO_ID;
  window.getCategories = getCategories;
  window.setCategories = setCategories;
  window.getCategoryById = getCategoryById;
  window.getCategoryByLegacyName = getCategoryByLegacyName;
  window.getSubcategoryById = getSubcategoryById;
  window.getSubChildren = getSubChildren;
  window.getSubParentId = getSubParentId;
  window.sortedCategories = sortedCategories;
  window.productCountByCategory = productCountByCategory;
  window.productCountBySubcategory = productCountBySubcategory;
  window.subcategoryRollupCount = subcategoryRollupCount;
  window.classifyProduct = classifyProduct;
  window.migrateProductsToSubcategories = migrateProductsToSubcategories;
}

// ===== Поиск: ранжирование результатов по релевантности =====
// Используется каталогом, живым поиском (оверлей) и админкой.

// Нормализация строки для поиска: нижний регистр, ё == е.
function kleverSearchNorm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').trim();
}

// Оценка релевантности названия для запроса. Запрос может быть из нескольких
// слов — каждое обязано встречаться в названии, иначе 0 («не подходит»).
// За каждое слово запроса: 3 — название начинается с него, 2 — какое-то слово
// названия начинается с него, 1 — найдено в середине слова. Итог — сумма.
function kleverSearchScore(name, query) {
  const n = kleverSearchNorm(name);
  const words = kleverSearchNorm(query).split(/\s+/).filter(Boolean);
  if (!words.length || !n) return 0;
  const nameWords = n.split(/\s+/);
  let score = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (n.indexOf(w) === -1) return 0;
    if (n.indexOf(w) === 0) score += 3;
    else if (nameWords.some(function (nw) { return nw.indexOf(w) === 0; })) score += 2;
    else score += 1;
  }
  return score;
}

// Сопоставление товара с запросом: по названию (score > 0) или по артикулу.
// Точное совпадение артикула — всегда первое (score 1e9).
function kleverSearchMatch(p, query) {
  const q = kleverSearchNorm(query);
  if (!q) return { match: true, score: 0, exactSku: false };
  const sku = kleverSearchNorm(p && p.sku);
  const exactSku = sku !== '' && sku === q;
  const skuHit = sku !== '' && sku.indexOf(q) !== -1;
  const nameScore = kleverSearchScore(p && p.name, q);
  return {
    match: exactSku || skuHit || nameScore > 0,
    score: exactSku ? 1e9 : nameScore,
    exactSku: exactSku,
  };
}

// Сортирует МАССИВ товаров по релевантности запросу (по убыванию score,
// внутри одинакового score — по алфавиту). Мутирует и возвращает массив.
function kleverSortByRelevance(items, query, scoreOf) {
  const get = scoreOf || function (p) { return kleverSearchMatch(p, query).score; };
  const cache = new Map();
  items.forEach(function (p) { cache.set(p, get(p)); });
  items.sort(function (a, b) {
    const d = cache.get(b) - cache.get(a);
    if (d) return d;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
  });
  return items;
}

if (typeof window !== 'undefined') {
  window.kleverSearchNorm = kleverSearchNorm;
  window.kleverSearchScore = kleverSearchScore;
  window.kleverSearchMatch = kleverSearchMatch;
  window.kleverSortByRelevance = kleverSortByRelevance;
}
