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

  // Подсказки через REST Suggest API Яндекса — не зависит от загрузки JS API.
  // Возвращает Promise<Array<{value, displayName, subtitle}>>.
  function suggestAddresses(query, count) {
    if (!YANDEX_API_KEY || !query || query.length < 2) return Promise.resolve([]);
    // ll=lon,lat — биасим результаты в сторону Санкт-Петербурга.
    var url = 'https://suggest-maps.yandex.ru/v1/suggest'
      + '?apikey=' + encodeURIComponent(YANDEX_API_KEY)
      + '&text=' + encodeURIComponent(query)
      + '&lang=ru_RU&results=' + (count || 6)
      + '&highlight=0&types=geo'
      + '&ll=30.3609,59.9311&spn=10,10';
    return fetch(url, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('suggest-' + r.status);
      return r.json();
    }).then(function (data) {
      return (data.results || []).map(function (item) {
        var formatted = (item.address && item.address.formatted_address) || '';
        var titleText = (item.title && item.title.text) || '';
        var subtitleText = (item.subtitle && item.subtitle.text) || '';
        // Полный адрес: предпочитаем formatted_address, иначе склеиваем title + subtitle.
        var value = formatted || (subtitleText ? titleText + ', ' + subtitleText : titleText);
        return {
          value: value,
          displayName: titleText,
          subtitle: subtitleText,
        };
      });
    });
  }

  // Экранирует HTML для вставки в innerHTML.
  function _esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Создаёт кастомный выпадающий список подсказок под inputEl.
  // onPick(item) вызывается при клике на вариант.
  function _makeSuggestDropdown(inputEl, onPick) {
    if (!inputEl) return;

    var drop = document.createElement('div');
    drop.style.cssText = [
      'position:absolute',
      'z-index:9999',
      'background:#fff',
      'border:1.5px solid #c8e8d4',
      'border-radius:14px',
      'box-shadow:0 8px 32px rgba(0,0,0,.14)',
      'overflow:hidden',
      'max-height:300px',
      'overflow-y:auto',
      'min-width:100%',
      'left:0',
      'top:100%',
      'margin-top:4px',
      'display:none',
    ].join(';');

    // Оборачиваем родителя в relative если он static.
    var parent = inputEl.parentElement;
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    parent.appendChild(drop);

    function hide() { drop.style.display = 'none'; }

    function show(items) {
      if (!items || items.length === 0) { hide(); return; }
      drop.innerHTML = items.map(function (it, i) {
        return '<div data-idx="' + i + '" style="'
          + 'padding:12px 16px;cursor:pointer;'
          + 'border-bottom:1px solid #f2f7f4;'
          + 'font-size:14px;line-height:1.4;'
          + 'transition:background .1s;'
          + '">'
          + '<div style="font-weight:600;color:#1a2e22;">' + _esc(it.displayName) + '</div>'
          + (it.subtitle ? '<div style="font-size:12px;color:#7a9e86;margin-top:2px;">' + _esc(it.subtitle) + '</div>' : '')
          + '</div>';
      }).join('');
      Array.prototype.forEach.call(drop.querySelectorAll('[data-idx]'), function (el) {
        el.addEventListener('mousedown', function (e) {
          e.preventDefault();
          var idx = parseInt(el.getAttribute('data-idx'), 10);
          onPick(items[idx]);
          hide();
        });
        el.addEventListener('mouseover', function () { el.style.background = '#f1fbf5'; });
        el.addEventListener('mouseout', function () { el.style.background = ''; });
      });
      drop.style.display = 'block';
    }

    var timer = null;
    var lastQ = '';
    inputEl.addEventListener('input', function () {
      var q = inputEl.value.trim();
      if (q === lastQ) return;
      lastQ = q;
      clearTimeout(timer);
      if (q.length < 3) { hide(); return; }
      timer = setTimeout(function () {
        suggestAddresses(q, 6).then(show).catch(function () { hide(); });
      }, 350);
    });
    inputEl.addEventListener('blur', function () {
      setTimeout(hide, 200);
    });
    inputEl.addEventListener('focus', function () {
      if (drop.style.display === 'block') return;
      var q = inputEl.value.trim();
      if (q.length >= 3) {
        suggestAddresses(q, 6).then(show).catch(function () {});
      }
    });
  }

  // Подсказки адреса в поле ввода.
  // inputEl — <input>; onPick(addressString, coords|null) — колбэк при выборе.
  function attachSuggest(inputEl, onPick) {
    if (!inputEl) return;
    _makeSuggestDropdown(inputEl, function (item) {
      inputEl.value = item.value;
      // Геокодируем выбранный адрес → получаем координаты для карты.
      loadYandex().then(function (ymaps) {
        return ymaps.geocode(item.value, { results: 1 });
      }).then(function (res) {
        var obj = res.geoObjects.get(0);
        var coords = obj ? obj.geometry.getCoordinates() : null;
        if (typeof onPick === 'function') onPick(item.value, coords);
      }).catch(function () {
        if (typeof onPick === 'function') onPick(item.value, null);
      });
    });
  }

  // Интерактивная карта с перетаскиваемой меткой.
  // containerEl — div для карты; inputEl — поле адреса (двусторонняя связь).
  // Возвращает объект-контроллер с методом setAddress(str, coords).
  function attachMap(containerEl, inputEl, opts) {
    opts = opts || {};
    var controller = { map: null, placemark: null, ready: false };

    loadYandex().then(function (ymaps) {
      var map = new ymaps.Map(containerEl, {
        center: opts.center || DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        controls: ['zoomControl', 'geolocationControl'],
      });

      // Яркая красная метка — хорошо заметна на любом фоне карты.
      var placemark = new ymaps.Placemark(opts.center || DEFAULT_CENTER, {
        iconCaption: 'Переместите метку точнее',
      }, {
        draggable: true,
        preset: 'islands#redCircleDotIconWithCaption',
        iconCaptionMaxWidth: '240',
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
    suggest: suggestAddresses,
    attachSuggest: attachSuggest,
    attachMap: attachMap,
    initAddressPicker: initAddressPicker,
  };
})();
