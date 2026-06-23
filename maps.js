// ===== Яндекс.Карты: подсказки адреса + карта с меткой =====
// Заменяет Nominatim (OpenStreetMap), который резался ТСПУ и плохо работал.
// Яндекс не блокируется в РФ и даёт точные русские адреса.
//
// НАСТРОЙКА: вставьте сюда ваш бесплатный ключ JavaScript API и Геокодера
// (получить: https://developer.tech.yandex.ru/services/ → «JavaScript API
//  и HTTP Геокодер»). Пока ключ пустой — карта и подсказки не активируются,
// поля адреса работают как обычный ручной ввод.
(function () {
  'use strict';

  var YANDEX_API_KEY = '63637aae-9e1d-41c9-ac23-e5fb6f303bf4';

  // По умолчанию центр — Санкт-Петербург.
  var DEFAULT_CENTER = [59.9311, 30.3609];
  var DEFAULT_ZOOM = 11;
  var PIN_ZOOM = 17;

  var _loadPromise = null;

  // Динамически грузим Яндекс.Карты один раз. Возвращает Promise<ymaps>.
  function loadYandex() {
    if (!YANDEX_API_KEY) return Promise.reject(new Error('no-key'));
    if (_loadPromise) return _loadPromise;
    _loadPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://api-maps.yandex.ru/2.1/?apikey=' + encodeURIComponent(YANDEX_API_KEY) + '&lang=ru_RU';
      s.async = true;
      s.onload = function () {
        if (window.ymaps && window.ymaps.ready) {
          window.ymaps.ready(function () { resolve(window.ymaps); });
        } else {
          reject(new Error('ymaps-missing'));
        }
      };
      s.onerror = function () { reject(new Error('load-failed')); };
      document.head.appendChild(s);
    });
    return _loadPromise;
  }

  // Подсказки адреса в поле ввода (как было у Nominatim, но через Яндекс).
  // inputEl — <input>; onPick(addressString, coords|null) — колбэк при выборе.
  function attachSuggest(inputEl, onPick) {
    if (!inputEl) return;
    loadYandex().then(function (ymaps) {
      var suggest = new ymaps.SuggestView(inputEl, { results: 6 });
      suggest.events.add('select', function (e) {
        var value = e.get('item').value;
        inputEl.value = value;
        // Геокодируем выбранную подсказку, чтобы получить координаты для карты.
        ymaps.geocode(value, { results: 1 }).then(function (res) {
          var obj = res.geoObjects.get(0);
          var coords = obj ? obj.geometry.getCoordinates() : null;
          if (typeof onPick === 'function') onPick(value, coords);
        }).catch(function () {
          if (typeof onPick === 'function') onPick(value, null);
        });
      });
    }).catch(function () { /* без ключа/сети — поле остаётся ручным */ });
  }

  // Интерактивная карта с перетаскиваемой меткой.
  // containerEl — div для карты; inputEl — поле адреса (двусторонняя связь).
  // Возвращает объект-контроллер с методом setAddress(str).
  function attachMap(containerEl, inputEl, opts) {
    opts = opts || {};
    var controller = { map: null, placemark: null, ready: false };

    loadYandex().then(function (ymaps) {
      var map = new ymaps.Map(containerEl, {
        center: opts.center || DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        controls: ['zoomControl', 'geolocationControl', 'searchControl'],
      });
      var placemark = new ymaps.Placemark(opts.center || DEFAULT_CENTER, {}, {
        draggable: true,
        preset: 'islands#greenDotIconWithCaption',
      });
      map.geoObjects.add(placemark);
      controller.map = map;
      controller.placemark = placemark;
      controller.ready = true;

      // Обратное геокодирование: координаты → адрес в поле.
      function reverseFill(coords) {
        ymaps.geocode(coords, { results: 1 }).then(function (res) {
          var obj = res.geoObjects.get(0);
          if (!obj) return;
          var addr = obj.getAddressLine();
          placemark.properties.set('iconCaption', addr);
          if (inputEl) inputEl.value = addr;
        }).catch(function () {});
      }

      // Клик по карте — переносим метку и заполняем адрес.
      map.events.add('click', function (e) {
        var coords = e.get('coords');
        placemark.geometry.setCoordinates(coords);
        reverseFill(coords);
      });
      // Перетащили метку — заполняем адрес.
      placemark.events.add('dragend', function () {
        reverseFill(placemark.geometry.getCoordinates());
      });
    }).catch(function () {
      // Без ключа/сети — прячем контейнер карты, оставляем только поле.
      if (containerEl) containerEl.style.display = 'none';
    });

    // Программная установка адреса (из подсказки): двигаем метку и центр.
    controller.setAddress = function (addressStr, coords) {
      if (!controller.ready) return;
      var apply = function (c) {
        controller.placemark.geometry.setCoordinates(c);
        controller.placemark.properties.set('iconCaption', addressStr);
        controller.map.setCenter(c, PIN_ZOOM);
      };
      if (coords) { apply(coords); return; }
      if (window.ymaps) {
        window.ymaps.geocode(addressStr, { results: 1 }).then(function (res) {
          var obj = res.geoObjects.get(0);
          if (obj) apply(obj.geometry.getCoordinates());
        }).catch(function () {});
      }
    };

    return controller;
  }

  // Удобный комбайн: поле + карта, связанные двусторонне.
  // { input, mapContainer } → возвращает контроллер карты.
  function initAddressPicker(opts) {
    opts = opts || {};
    var inputEl = opts.input;
    var mapEl = opts.mapContainer;
    var mapCtl = mapEl ? attachMap(mapEl, inputEl, opts) : null;
    attachSuggest(inputEl, function (addr, coords) {
      if (mapCtl) mapCtl.setAddress(addr, coords);
    });
    return mapCtl;
  }

  window.KleverMaps = {
    isConfigured: function () { return !!YANDEX_API_KEY; },
    load: loadYandex,
    attachSuggest: attachSuggest,
    attachMap: attachMap,
    initAddressPicker: initAddressPicker,
  };
})();
