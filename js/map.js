/* =====================================================================
   Ядро карты. Leaflet + кластеризация + тепловой слой.
   Панель слоёв (слева), панель подробностей (справа), сворачивание.
   Производительность: canvas-рендер, chunked-кластеры, ленивая
   загрузка слоёв, троттлинг.
   ===================================================================== */

const MapApp = (function () {

  let map, gisLayer, osmLayer;
  const layerState = {};      // id -> { meta, group, on }
  let selectedVector = null;  // текущая выделенная линия/полигон (обычный L.polyline/polygon)
  let selectedVG = null;      // { group, fid } — выделенная фича в VectorGrid-слое (см. buildVectorGridGroup)
  let vgTooltip = null;       // общий тултип для VectorGrid-слоёв (у них нет пофигурного bindTooltip)
  const SELECT_COLOR = '#00a8ff';
  // Картинки точечных объектов с сервера (GET /icons, только при BackendPlugin.serverIcons):
  // имя пиктограммы (obj.img) → data-URI. Сервер отдаёт только саму картинку — размер
  // на карте задаёт клиент (SERVER_ICON_SIZE, в пикселях). См. buildPointMarker.
  let serverIcons = {};
  const SERVER_ICON_SIZE = 30;

  // ---- SVG-иконки интерфейса -------------------------------------------
  const SVG = {
    chevronLeft:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    layers:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    info:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    cursor:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 17 2.51-7.39L20 10.09z"/></svg>',
    gear:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    close:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    ruler:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg>'
  };


  // =====================================================================
  //  Инициализация
  // =====================================================================
  async function init() {
    // Координаты центра/зум — с сервера (GET /config, тот же источник, которым
    // при сборке своей страницы пользуется нативная карта 1С), а не из клиентского
    // конфига. BackendPlugin.fallbackCenter/fallbackZoom — только страховка на
    // случай, если сам запрос не удался (см. js/backends/<id>.js).
    // Набор картинок (GET /icons) — параллельно с /config и ДО первого слоя: маркеры
    // строятся синхронно (buildPointMarker), дожидаться картинок там уже негде. Ошибка
    // не фатальна — точки нарисуются запасными пиктограммами плагина.
    const [serverConfig, icons] = await Promise.all([
      MapAPI.getMapConfig().catch(() => null),
      BackendPlugin.serverIcons
        ? MapAPI.getIcons().catch(e => { console.error('[MapApp] не удалось загрузить /icons', e); return null; })
        : null
    ]);
    serverIcons = icons || {};
    const center = (serverConfig && serverConfig.center) || BackendPlugin.fallbackCenter;
    const zoom   = (serverConfig && serverConfig.zoom)   || BackendPlugin.fallbackZoom;

    // preferCanvas/renderer — под тумблером MapConfig.perf.preferCanvas (см.
    // config.js): canvas быстрее на панорамировании плотных векторных слоёв,
    // но при зуме перерисовывает всё полотно растром (тяжёлые дороги/районы
    // дают заметный «хич»); SVG масштабирует векторы трансформом, как нативная
    // карта 1С. По умолчанию теперь SVG — сравниваем плавность зума.
    const useCanvas = MapConfig.perf && MapConfig.perf.preferCanvas;
    const pad = (MapConfig.perf && typeof MapConfig.perf.rendererPadding === 'number')
      ? MapConfig.perf.rendererPadding : 0.5;
    // fadeAnimation — под тумблером MapConfig.perf.fadeAnimation (см. config.js):
    // false отключает кроссфейд тайлов при смене зум-уровня, как у нативной
    // карты 1С (Карта_Map_js вызывает initialization(...) с fadeAnimation=false).
    const fade = !(MapConfig.perf && MapConfig.perf.fadeAnimation === false);
    map = L.map('map', {
      center: center,
      zoom: zoom,
      zoomControl: false,
      attributionControl: false,        // без плашки "Leaflet | © 2ГИС" в углу
      preferCanvas: useCanvas,          // рендер векторных слоёв: canvas vs SVG
      renderer: useCanvas ? L.canvas({ padding: pad }) : L.svg({ padding: pad }),
      fadeAnimation: fade
    });

    // Debug-хук для замеров производительности: доступ к объекту карты из консоли
    // (window.__leafletMap) — включается ТОЛЬКО при ?bench=1 в URL, в обычной
    // работе не создаётся. Нужен, чтобы мерить синхронную стоимость рендера на
    // шаг зума независимо от того, активна вкладка или нет.
    if (/[?&]bench=1/.test(location.search)) window.__leafletMap = map;

    // Подложки — 2ГИС (тот же тайл-сервер, что в нативной карте 1С, см.
    // Карта_Map_js: L.tileLayer('http://tile2.maps.2gis.com/tiles?x={x}&y={y}&z={z}'))
    // и OSM про запас. Переключаются через .basemap-switch (см. buildChrome/setBasemap).
    // updateWhenIdle — под тумблером MapConfig.perf.tilesUpdateWhenIdle (см.
    // config.js): при true тайлы заморожены до конца панорамирования (край
    // пустеет под курсором и подгружается рывком на moveend); при false (теперь
    // по умолчанию) — догружаются во время перетаскивания, как у нативной
    // карты 1С, где эта опция не задана вовсе.
    const tilesIdle = !!(MapConfig.perf && MapConfig.perf.tilesUpdateWhenIdle);
    // updateWhenZooming — под тумблером (см. config.js): false откладывает
    // подгрузку тайлов до конца анимации зума, разгружая её кадры.
    const tilesZoom = !(MapConfig.perf && MapConfig.perf.tilesUpdateWhenZooming === false);
    gisLayer = L.tileLayer('http://tile2.maps.2gis.com/tiles?x={x}&y={y}&z={z}', {
      maxZoom: 18,
      updateWhenIdle: tilesIdle,
      updateWhenZooming: tilesZoom,
      attribution: '© 2ГИС'
    }).addTo(map);
    osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      updateWhenIdle: tilesIdle,
      updateWhenZooming: tilesZoom,
      attribution: '© OpenStreetMap'
    });

    // Свой масштаб вместо L.control.zoom — см. .zoom-group в buildChrome()
    // (единая нижняя панель инструментов слева от переключателя подложки).

    // Пока идёт перетаскивание карты, маркеры/линии проезжают под неподвижным
    // курсором и браузер сам генерирует им mouseover — выглядит как случайное
    // наведение. На время драга отключаем pointer-events у иконок и векторов
    // (см. #map.is-panning в styles.css), чтобы такие события не долетали.
    // Снимаем класс по moveend, а не dragend: у карты включена инерция
    // (по умолчанию в Leaflet), и после отпускания кнопки мыши она ещё
    // едет какое-то время сама — dragend в этот момент уже наступил бы
    // раньше, чем реально прекратилось движение под курсором.
    map.on('dragstart', () => {
      document.getElementById('map').classList.add('is-panning');
      closeAllTooltips();
    });
    map.on('moveend', () => document.getElementById('map').classList.remove('is-panning'));

    // См. CanvasPointGroup выше (buildPointGroup) — все активные canvas-
    // точечные слои возвращаются наверх на добавление ЛЮБОГО другого слоя,
    // а не только своего собственного.
    map.on('layeradd', () => {
      if (suppressBringToFront) return;
      activeCanvasPointGroups.forEach(g => g.bringToFront());
    });

    buildChrome();
    await buildLayerPanel();
    // Без await — прогрев всех слоёв идёт в фоне и не должен задерживать
    // остальной старт приложения (плашку пользователя, переключатель экранов,
    // см. auth.js: startApp()). Слои остаются выключенными, см. prefetchAllLayers.
    prefetchAllLayers();
  }

  // =====================================================================
  //  Каркас панелей
  // =====================================================================
  function buildChrome() {
    // Панель слоёв/подробно, нижний тулбар — внутрь #viewMap (а не #app целиком):
    // это делает их частью экрана "Карта" (см. app-shell.js), которая целиком
    // скрывается/показывается при переключении на Дашборд/Отчёты вместе с ними,
    // не задевая разметку других экранов.
    const app = document.getElementById('viewMap');
    // Модалка настроек — общая для панели слоёв (см. openLayerSettings) и вкладки
    // «Отчёты» (см. reports.js: openReportSettings), а значит должна быть видна
    // независимо от того, какой из трёх .view сейчас активен. Монтируется в #app
    // напрямую, а не внутрь #viewMap — иначе .view:not(.is-active){display:none}
    // (см. css/styles.css) скрывала бы её вместе с картой всякий раз, когда
    // настройки отчёта открывают с вкладки «Отчёты»: класс is-open на
    // #settingsOverlay выставлялся бы исправно, но сам оверлей оставался бы
    // невидимым как потомок скрытого экрана.
    const appRoot = document.getElementById('app');

    // Левая панель — СЛОИ
    app.insertAdjacentHTML('beforeend', `
      <aside class="panel panel--left" id="panelLayers">
        <div class="panel__header">
          <div class="panel__title">Слои карты<small>Отображение данных</small></div>
          <button class="icon-btn" id="collapseLayers" title="Свернуть">${SVG.chevronLeft}</button>
        </div>
        <div class="layer-search"><input type="search" id="layerSearch" placeholder="Поиск слоя…"></div>
        <div class="panel__body" id="layerList"></div>
        <div class="panel__footer" id="panelLayersFooter"></div>
      </aside>`);

    // Правая панель — ПОДРОБНАЯ ИНФОРМАЦИЯ. Кнопки «Показать на карте»/«Закрыть»
    // живут в отдельном .panel__footer (id="detailActions"), а не внутри
    // прокручиваемого #detailBody — по тому же принципу, что и плашка
    // логина/«Выйти» в .panel__footer панели «Слои карты» (см. auth.js:
    // renderUserBadge): footer не скроллится вместе с телом панели (см.
    // .panel { flex-direction:column } / .panel__body { flex:1; overflow-y:auto }
    // в styles.css), поэтому у длинной детальной информации (например, таблица
    // остановок трека) кнопки остаются на фиксированном месте внизу панели,
    // а не уезжают за пределы видимой области при скролле.
    // Свёрнута по умолчанию (is-collapsed) — до выбора объекта показывать
    // нечего (см. emptyDetail()), а открытая пустая панель зря отъедает место
    // на маленьких экранах. Разворачивается сама при выборе объекта
    // (см. selectObject()).
    app.insertAdjacentHTML('beforeend', `
      <aside class="panel panel--right is-collapsed" id="panelDetail">
        <div class="panel__header">
          <button class="icon-btn" id="collapseDetail" title="Свернуть">${SVG.chevronRight}</button>
          <div class="panel__title" style="text-align:right">Подробно<small>Информация об объекте</small></div>
        </div>
        <div class="panel__body" id="detailBody">${emptyDetail()}</div>
        <div class="panel__footer detail__footer" id="detailActions"></div>
      </aside>`);

    // Ярлыки для разворачивания. revealDetail сразу видим (is-visible) — под
    // стать свёрнутому по умолчанию panelDetail выше.
    app.insertAdjacentHTML('beforeend', `
      <button class="reveal-tab reveal-tab--left"  id="revealLayers" title="Слои">${SVG.layers}<span class="reveal-tab__badge" id="layerBadge">0</span></button>
      <button class="reveal-tab reveal-tab--right is-visible" id="revealDetail" title="Подробно">${SVG.info}</button>`);

    // Нижняя панель инструментов — единая строка по центру: масштаб (был
    // L.control.zoom в правом верхнем углу — перенесён сюда и стал
    // горизонтальным), переключатель подложки, линейка (аналог L.control.ruler
    // нативной карты, см. CommonTemplates/Карта_Clusters_Ruler_js — своя
    // реализация здесь, см. toggleRuler(), т.к. вендорный плагин 1С сам по
    // себе не переключает режим измерения по клику, см. комментарий там).
    app.insertAdjacentHTML('beforeend', `
      <div class="map-toolbar" id="mapToolbar">
        <div class="zoom-group" id="zoomGroup">
          <button class="zoom-group__btn" id="zoomOut" title="Уменьшить">−</button>
          <button class="zoom-group__btn" id="zoomIn" title="Увеличить">+</button>
        </div>
        <div class="basemap-switch" id="basemapSwitch">
          <button class="basemap-switch__btn is-active" data-basemap="2gis">2ГИС</button>
          <button class="basemap-switch__btn" data-basemap="osm">OSM</button>
        </div>
        <button class="ruler-btn" id="rulerBtn" title="Линейка">${SVG.ruler}</button>
        ${mapCommandButtonsHtml()}
      </div>`);

    // Модальное окно настроек — по центру экрана, поверх всего; общее для
    // панели слоёв (см. openLayerSettings) и вкладки «Отчёты» (см. reports.js:
    // openReportSettings), см. js/settings-form.js: openSettings/closeSettings/
    // applySettings. Содержимое .modal__body приходит готовым HTML-фрагментом
    // с сервера, как и .detail__html в панели «Подробно».
    appRoot.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="settingsOverlay">
        <div class="modal" id="settingsModal">
          <div class="modal__header">
            <div class="modal__title" id="settingsTitle">Настройки слоя</div>
            <button class="icon-btn" id="settingsClose" title="Закрыть">${SVG.close}</button>
          </div>
          <div class="modal__body" id="settingsBody"></div>
          <div class="modal__footer">
            <span class="modal__error" id="settingsError"></span>
            <button class="btn" id="settingsClear">Очистить</button>
            <button class="btn" id="settingsCancel">Отмена</button>
            <button class="btn btn--primary" id="settingsApply">Применить</button>
          </div>
        </div>
      </div>`);

    // Сворачивание
    wireCollapse('panelLayers', 'collapseLayers', 'revealLayers', 'left');
    wireCollapse('panelDetail', 'collapseDetail', 'revealDetail', 'right');

    // Модалка настроек: закрытие по крестику/«Отмена»/клику по подложке/Esc.
    // Общая для панели слоёв и вкладки «Отчёты» (см. js/settings-form.js:
    // openSettings/closeSettings/applySettings) — привязка кнопок здесь
    // происходит один раз и не знает, чей именно слой/отчёт сейчас открыт.
    document.getElementById('settingsClose').addEventListener('click', SettingsForm.closeSettings);
    document.getElementById('settingsCancel').addEventListener('click', SettingsForm.closeSettings);
    // Закрытие по клику мимо модалки — только если и mousedown, и mouseup
    // пришлись на подложку. Иначе перетаскивание (например, выделение текста
    // или протяжка слайдера/вкладки внутри модалки) с отпусканием курсора уже
    // за пределами .modal рождает click с target=settingsOverlay и закрывает
    // окно, хотя пользователь не намеревался его закрывать.
    let settingsOverlayMouseDownOnSelf = false;
    document.getElementById('settingsOverlay').addEventListener('mousedown', e => {
      settingsOverlayMouseDownOnSelf = e.target.id === 'settingsOverlay';
    });
    document.getElementById('settingsOverlay').addEventListener('click', e => {
      if (e.target.id === 'settingsOverlay' && settingsOverlayMouseDownOnSelf) SettingsForm.closeSettings();
      settingsOverlayMouseDownOnSelf = false;
    });
    document.getElementById('settingsClear').addEventListener('click', SettingsForm.clearSettingsForm);
    document.getElementById('settingsApply').addEventListener('click', SettingsForm.applySettings);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('settingsOverlay').classList.contains('is-open')) {
        SettingsForm.closeSettings();
      }
    });

    // Переключение подложки
    document.getElementById('basemapSwitch').addEventListener('click', e => {
      const btn = e.target.closest('.basemap-switch__btn');
      if (btn) setBasemap(btn.dataset.basemap);
    });

    // Масштаб
    document.getElementById('zoomIn').addEventListener('click', () => map.zoomIn());
    document.getElementById('zoomOut').addEventListener('click', () => map.zoomOut());
    const updateZoomButtons = () => {
      document.getElementById('zoomIn').disabled = map.getZoom() >= map.getMaxZoom();
      document.getElementById('zoomOut').disabled = map.getZoom() <= map.getMinZoom();
    };
    map.on('zoomend', updateZoomButtons);
    updateZoomButtons();

    // Линейка
    document.getElementById('rulerBtn').addEventListener('click', toggleRuler);
    // Команды карты (BackendPlugin.mapCommands, см. "Команды карты" ниже) — кнопки уже
    // сгенерированы в разметку тулбара выше (mapCommandButtonsHtml()), здесь только вешаем
    // обработчик на каждую по её id.
    (BackendPlugin.mapCommands || []).forEach(cmd => {
      document.getElementById(`mapCmd-${cmd.id}`).addEventListener('click', () => toggleMapCommand(cmd));
    });

    // Поиск по слоям
    document.getElementById('layerSearch').addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('#layerList .layer-item').forEach(el => {
        el.style.display = el.dataset.name.includes(q) ? '' : 'none';
      });
      document.querySelectorAll('#layerList .layer-group__label').forEach(el => {
        el.style.display = q ? 'none' : '';
      });
    });
  }

  function wireCollapse(panelId, btnId, revealId, side) {
    const panel  = document.getElementById(panelId);
    const reveal = document.getElementById(revealId);
    const close = () => { panel.classList.add('is-collapsed'); reveal.classList.add('is-visible'); };
    const open  = () => { panel.classList.remove('is-collapsed'); reveal.classList.remove('is-visible'); };
    document.getElementById(btnId).addEventListener('click', close);
    reveal.addEventListener('click', open);
  }

  // =====================================================================
  //  Панель слоёв
  // =====================================================================
  async function buildLayerPanel() {
    const list = document.getElementById('layerList');
    let layers;
    try {
      layers = await MapAPI.getLayers();
    } catch (e) {
      console.error('[MapApp] не удалось загрузить слои', e);
      list.innerHTML = `<div class="layer-error">Не удалось загрузить слои</div>`;
      return;
    }

    const groups = {};
    layers.forEach(l => { (groups[l.group] = groups[l.group] || []).push(l); });

    let html = '';
    Object.keys(groups).forEach(group => {
      html += `<div class="layer-group__label">${group}</div>`;
      groups[group].forEach(l => {
        // cache — последние известные данные слоя за эту сессию (для мгновенного
        // показа при повторном включении, без похода на сервер), см. toggleLayer().
        // Живёт только в памяти, пока не перезагрузили страницу — никакого
        // персистентного хранилища (раньше был IndexedDB, см. git-историю).
        // pending — общий Promise текущего сетевого запроса данных слоя, если он
        // сейчас идёт (см. fetchLayerDataShared) — чтобы прогрев всех слоёв при
        // старте (prefetchAllLayers) и ручное включение тумблера, если они
        // совпали по времени для одного и того же слоя, ждали ОДИН и тот же
        // запрос, а не слали два одинаковых.
        layerState[l.id] = { meta: l, group: null, on: false, token: 0, cache: null, pending: null };
        const swatchCls = l.type === 'line' ? 'layer-item__swatch--line'
                        : l.type === 'polygon' ? 'layer-item__swatch--polygon'
                        : l.type === 'heat' ? 'layer-item__swatch--heat' : '';
        // polygon — цвет часто вычисляется на сервере per-объектно (см. АА-проект,
        // choropleth-раскраска АдминистративныеЕдиницы), l.color здесь только цвет
        // по умолчанию/легенды, поэтому красим не заливку, а рамку.
        const swatchStyle = l.type === 'heat' ? ''
                          : l.type === 'polygon' ? `style="color:${l.color}"`
                          : `style="background:${l.color}"`;
        // Шестерёнка — только у слоёв, для которых сервер прислал settings:true
        // (см. АА-проект CLAUDE.md: большинство слоёв там намеренно без настроек —
        // нативные фильтры слишком сложны для generic HTML-формы).
        const settingsBtn = l.settings
          ? `<button class="layer-item__settings" data-settings title="Настройки слоя «${l.label}»">${SVG.gear}</button>`
          : '';
        html += `
          <div class="layer-item" data-id="${l.id}" data-name="${l.label.toLowerCase()}">
            <span class="layer-item__swatch ${swatchCls}" ${swatchStyle}></span>
            <span class="layer-item__name" title="${l.label}">${l.label}</span>
            <span class="layer-item__count" data-count></span>
            ${settingsBtn}
            <span class="toggle"></span>
          </div>
          <div class="layer-legend" data-legend-for="${l.id}" hidden></div>`;
      });
    });
    list.innerHTML = html;

    // Легенда per-объектной раскраски (сейчас — Треки по ГРЗ): её состав
    // приходит с сервера в meta.legend, а видимость зависит от того, включён ли
    // слой, поэтому наполняем не здесь, а renderLayerLegend'ом — тем же, что
    // вызывается из toggleLayer и после сохранения фильтров слоя.
    Object.keys(layerState).forEach(renderLayerLegend);

    list.querySelectorAll('.layer-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        toggleLayer(id, !layerState[id].on);
      });
      // Шестерёнка открывает настройки слоя и не должна попутно триггерить
      // переключение самого слоя (клик всплывает на .layer-item выше) — есть
      // не у всех слоёв, см. settingsBtn выше.
      const settingsEl = item.querySelector('[data-settings]');
      settingsEl && settingsEl.addEventListener('click', e => {
        e.stopPropagation();
        openLayerSettings(item.dataset.id);
      });
    });
  }

  // Легенда "цвет = объект" под пилюлей слоя. Сейчас её присылает только слой
  // Треки, раскрашенный по ГРЗ (сервер: КартографияВнешнееAPI.ЦветаТрековПоАвтобусам)
  // — цвета считает ИСКЛЮЧИТЕЛЬНО сервер, здесь их не вычисляем и не подменяем,
  // иначе цвет линии и цвет квадратика неизбежно разъедутся.
  // Показываем только у включённого слоя: легенда к невидимым линиям занимает
  // место в панели и вводит в заблуждение.
  // Вызывается из трёх мест: сборка панели, переключение тумблера и
  // onApplied после сохранения фильтров слоя (состав легенды меняется вместе
  // с фильтром по ГРЗ, а DOM панели после старта больше не пересобирается).
  function renderLayerLegend(id) {
    const box = document.querySelector(`.layer-legend[data-legend-for="${id}"]`);
    if (!box) return;
    const st = layerState[id];
    const legend = (st && st.meta && Array.isArray(st.meta.legend)) ? st.meta.legend : [];
    box.textContent = '';
    box.hidden = !(st && st.on && legend.length);
    if (box.hidden) return;
    legend.forEach(entry => {
      const row = document.createElement('span');
      row.className = 'layer-legend__item';
      const swatch = document.createElement('span');
      swatch.className = 'layer-legend__swatch';
      swatch.style.background = entry.color;
      const label = document.createElement('span');
      label.className = 'layer-legend__label';
      // textContent, а не innerHTML: подпись — это ГРЗ из базы, произвольная
      // строка, которой не место в разметке как коду.
      label.textContent = entry.label;
      row.append(swatch, label);
      box.append(row);
    });
  }

  // Прогревает кэш всех слоёв сразу при старте карты — параллельно, в фоне,
  // не блокируя остальную инициализацию (см. вызов в init(): без await).
  // Слои при этом остаются выключенными (st.on не трогаем, st.group не строим
  // и на карту ничего не добавляем) — только st.cache заполняется, чтобы
  // самое первое включение любого слоя пользователем за эту сессию было уже
  // мгновенным, тем же путём, что и обычное повторное включение (см.
  // toggleLayer, ветка "кэш есть"). Каждая пилюля слоя показывает тот же
  // спиннер, что и обычная загрузка (is-loading + :empty, см. css/styles.css),
  // пока её собственный прогрев не закончится — тумблер при этом остаётся
  // выключенным, крутится только пилюля.
  function prefetchAllLayers() {
    return Promise.all(Object.keys(layerState).map(prefetchLayer));
  }

  async function prefetchLayer(id) {
    const st = layerState[id];
    // Уже прогрет (или пользователь уже успел включить его сам, тем же путём —
    // toggleLayer к этому моменту уже мог записать st.cache) — прогревать нечего.
    if (!st || st.cache) return;
    const item = document.querySelector(`.layer-item[data-id="${id}"]`);
    item && item.classList.add('is-loading');
    try {
      if (st.meta.type !== 'heat') await ensureCanvasIconsLoaded(id);
      // fetchLayerDataShared — не fetchLayerDataRaw: если пользователь уже
      // успел включить слой вручную и toggleLayer для него уже идёт (или
      // наоборот, окажется следующим и найдёт наш st.pending), оба используют
      // один и тот же сетевой запрос, а не дублируют его.
      const data = await fetchLayerDataShared(st, id);
      if (st.cache) return;   // toggleLayer тем временем уже сам всё записал
      st.cache = data;
      // Ни setCount(), ни построение st.group: слой остаётся выключенным —
      // цифра в пилюле означает "показано на карте", а тумблер всё ещё выключен,
      // ничего не показано. Пилюля просто гаснет (снятие is-loading в finally
      // ниже) обратно в пустое состояние, без числа. Реальный Leaflet-объект
      // (кластеризация и т.п.) тоже строится лениво, только когда (и если) слой
      // действительно включат — прогрев не должен тратить это на слои, которые
      // могут вообще не понадобиться в этой сессии.
    } catch (e) {
      console.warn('[MapApp] прогрев слоя не удался', id, e);
    } finally {
      item && item.classList.remove('is-loading');
    }
  }

  function updateBadge() {
    const n = Object.values(layerState).filter(s => s.on).length;
    document.getElementById('layerBadge').textContent = n;
  }

  // Принудительно закрывает подсказки всех загруженных слоёв — подчищает
  // те, что успели открыться до начала перетаскивания карты (см. dragstart).
  function closeAllTooltips() {
    Object.values(layerState).forEach(st => {
      if (st.group && st.group.eachLayer) {
        st.group.eachLayer(l => l.closeTooltip && l.closeTooltip());
      }
    });
    hideVGTooltip();   // общий тултип VectorGrid-слоёв (у них нет пофигурных, см. buildVectorGridGroup)
  }

  // Добавляет группу слоя на карту — единственная точка, через которую toggleLayer
  // показывает слой (холодная загрузка, кэш, фоновая пересборка).
  //
  // Слой из BackendPlugin.backgroundLayers — «подложка»: сразу после добавления
  // уходит под все уже показанные векторы. Порт нативной карты 1С:
  // Map_js.downLoudObjekts после каждой загрузки АдминистративныеЕдиницы делает
  // layerGroup.bringToBack(), и места размещения/зоны, лежащие внутри района,
  // остаются кликабельными. Без этого порядок отрисовки в общем рендерере (canvas
  // при preferCanvas, иначе SVG — клик в обоих получает верхний путь) определялся
  // порядком включения: включённые позже районы перекрывали зоны/места
  // размещения, и клик всегда уходил району. Слои, включённые позже, и так
  // ложатся сверху, так что хватает делать это при каждом показе самого
  // слоя-подложки. Список живёт в плагине, а не в /layers: порядок наложения —
  // решение клиента, сервер отдаёт только цвета и картинки.
  function showGroup(st) {
    st.group.addTo(map);
    const back = BackendPlugin.backgroundLayers;
    if (back && back.includes(st.meta.id)) sendGroupToBack(st.group);
  }

  // bringToBack() у FeatureGroup зовёт его у детей по порядку, и последний
  // ребёнок оказывается в самом низу — это перевернуло бы сортировку «крупные
  // раньше, мелкие позже» из buildVectorGroupInner, и мелкие вложенные районы
  // ушли бы под крупные (нативная карта этим грешит). Поэтому идём с конца:
  // внутренний порядок слоя сохраняется, а весь слой целиком оказывается под
  // остальными. VG-слой (vectorTilesPolygons) — GridLayer: опускаем контейнер
  // тайлов в его панели.
  function sendGroupToBack(group) {
    const vg = vgLayerOf(group);
    if (vg) { vg.bringToBack(); return; }
    const layers = [];
    if (group.eachLayer) group.eachLayer(l => layers.push(l));
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i].bringToBack) layers[i].bringToBack();
    }
  }

  // =====================================================================
  //  Включение / выключение слоя
  // =====================================================================
  async function toggleLayer(id, on) {
    const st = layerState[id];
    if (!st || st.on === on) return;
    st.on = on;
    // Токен запроса — инвалидирует любую ещё не завершившуюся загрузку данных
    // этого слоя (см. ниже, почему без этого слой мог "залипать").
    const token = ++st.token;
    const item = document.querySelector(`.layer-item[data-id="${id}"]`);
    item && item.classList.toggle('is-on', on);
    renderLayerLegend(id);   // легенда видна только у включённого слоя

    // Тепловой слой → подложка становится ч/б (аналог подмены на grayscalegis в 1С)
    if (st.meta.type === 'heat') setBasemapGrayscale(on);

    if (!on) {
      if (st.group) map.removeLayer(st.group);
      st.group = null;
      setCount(item, '');           // сброс к виду «слой ещё не загружался»
      // Снимаем сразу, не дожидаясь finally ещё идущего toggleLayer(id, true):
      // тот тоже снимет их сам, когда его запрос наконец разрешится, но это
      // может быть заметно позже — не оставлять же спиннер крутиться на уже
      // выключенном тумблере всё это время.
      item && item.classList.remove('is-loading', 'is-refreshing');
      updateBadge();
      return;
    }

    // Включаем. Если для слоя уже есть кэш (в памяти с этой сессии или в
    // IndexedDB с прошлой) — показываем его сразу без спиннера и сверяем с
    // сервером в фоне (см. ветку if (cached) ниже); если кэша ещё нет нигде —
    // как раньше, блокирующая загрузка со спиннером.
    //
    // Общий для обеих веток race-guard: пока шёл await, слой могли успеть
    // выключить и включить ещё раз (или выключить и оставить выключенным) —
    // тогда st.token уже больше не равен token, взятому в начале этого вызова.
    // Раньше в этот момент код безусловно делал st.group = <новый слой> и
    // st.group.addTo(map) — и при двух гонящихся друг за другом загрузках (что
    // происходит при быстром повторном клике по тумблеру, пока первый запрос
    // ещё не ответил) более ранний вызов мог добавить свой слой на карту, а
    // более поздний — молча затереть ссылку на него в st.group своим
    // собственным объектом. Ссылка на первый (уже добавленный) слой терялась
    // навсегда: снять его с карты было больше нечем — ни включение, ни
    // выключение тумблера больше не видели этот "потерянный" объект. Именно
    // так тепловой слой (или любой другой) мог остаться висеть на карте
    // намертво после выключения — ч/б подложка при этом успевала вернуться в
    // цвет (это делает setBasemapGrayscale выше, синхронно, для актуального
    // вызова), а сам слой — нет. Проверки st.token !== token ниже отбрасывают
    // результат устаревшего запроса вместо того, чтобы отдавать ему право
    // распоряжаться картой.
    item && item.classList.add('is-loading');
    try {
      if (st.meta.type !== 'heat') await ensureCanvasIconsLoaded(id);
      if (st.token !== token) return;

      let cached = st.cache;

      if (cached) {
        // Кэш есть — данные готовы мгновенно, и это как раз проблема: у
        // холодной загрузки (fetch ниже) реальный сетевой round-trip сам по
        // себе даёт браузеру достаточно времени отрисовать анимацию тумблера
        // (transition на .toggle::after, 0.2s) ДО того, как начнётся
        // синхронная сборка группы. При кэше такой естественной паузы нет —
        // is-on выставляется синхронно чуть выше, и построение большого слоя
        // (тысячи объектов, напр. АвтомобильныеДороги) стартует практически в
        // тот же тик, конкурируя с ещё не отыгравшей анимацией за поток.
        // Однократный requestAnimationFrame здесь не помог (см. git-историю) —
        // rAF-колбэк выполняется ДО отрисовки кадра, а не после, и не
        // гарантирует, что браузер успел действительно нарисовать кадр анимации
        // до того, как мы снова займём поток. Ждём фиксированные 250мс (чуть
        // больше длительности самой transition) — грубее, чем ждать реального
        // transitionend, зато без лишней возни с событием на конкретном DOM-узле.
        await new Promise(resolve => setTimeout(resolve, 250));
        if (st.token !== token) return;

        let group;
        try {
          group = buildGroupFor(st, cached);
        } catch (e) {
          // Кэш несовместим с текущим кодом (например, после смены формата
          // данных сервером) — выбрасываем его и уходим на холодный путь ниже.
          console.warn('[MapApp] повреждённый кэш слоя, игнорируем', id, e);
          cached = null;
          st.cache = null;
        }
        if (cached) {
          // Слой на карте показываем сразу из кэша — но пилюля со счётчиком
          // сюда не входит: пока сервер не подтвердил, что кэш ещё актуален,
          // мы не знаем реальное число, поэтому setCount() здесь НЕТ (пилюля
          // остаётся :empty → крутится спиннер, см. css/styles.css). Кладём
          // цифру только в finally ниже, когда сверка так или иначе завершится.
          st.group = group;
          if (st.on) showGroup(st);
          updateBadge();

          // Пилюля могла уже показывать цифру ДО этого включения — например,
          // слой прогрели при старте (prefetchAllLayers), он ещё выключен, но
          // его pill уже не :empty. Без явной очистки :empty::before ниже не
          // сработает и спиннер фоновой сверки не появится — сброс здесь, а не
          // только на toggleLayer(id, false), нужен именно для этого случая.
          setCount(item, '');

          // Фоновая сверка с сервером. Ошибка здесь НЕ должна прятать уже
          // показанный (пусть устаревший) кэш — пользователь и так видит
          // рабочие данные, отключать их из-за сетевого сбоя обновления было
          // бы регрессией, поэтому только логируем.
          item.classList.add('is-refreshing');
          try {
            const fresh = await fetchLayerDataShared(st, id);
            if (st.token !== token) return;
            if (dataChanged(cached, fresh)) {
              const newGroup = buildGroupFor(st, fresh);
              if (st.group) map.removeLayer(st.group);
              st.group = newGroup;
              if (st.on) showGroup(st);
            }
            st.cache = fresh;
          } catch (e) {
            console.warn('[MapApp] фоновое обновление слоя не удалось, оставляем кэш', id, e);
          } finally {
            // Токен мог устареть, пока шёл await (слой успели выключить, а то и
            // включить заново) — та, более новая, toggleLayer уже сама сбросила
            // пилюлю/спиннер этого же DOM-узла (см. ветку if (!on) выше). Без этой
            // проверки finally всё равно писал число в пилюлю уже выключенного
            // слоя, когда фоновая сверка наконец отвечала.
            if (st.token === token) {
              // st.cache — свежие данные при успехе, старый кэш без изменений
              // при ошибке (перезаписывается только в try выше) — годится как
              // число в обоих случаях, спиннер до сих пор ничего не показывал.
              setCount(item, st.cache.length);
              item && item.classList.remove('is-refreshing');
            }
          }
          return;
        }
      }

      // Холодный старт — кэша нет ни в памяти (первое включение слоя за эту сессию).
      // fetchLayerDataShared, а не fetchLayerDataRaw напрямую: если в этот момент
      // ещё идёт фоновый прогрев всех слоёв (prefetchAllLayers) и он уже успел
      // запросить этот же слой, переиспользуем его запрос вместо дублирующего.
      const data = await fetchLayerDataShared(st, id);
      if (st.token !== token) return;
      st.group = buildGroupFor(st, data);
      st.cache = data;
      setCount(item, data.length);
      if (st.on) showGroup(st);
    } catch (e) {
      console.error('Ошибка загрузки слоя', id, e);
      if (st.token === token) {
        st.on = false;
        item && item.classList.remove('is-on');
      }
    } finally {
      item && item.classList.remove('is-loading');
      updateBadge();
    }
  }

  // Сравнение "поменялись ли данные слоя" для фонового обновления кэша —
  // простое сравнение по значению через сериализацию: наборы данных слоя
  // умеренного размера (см. Performance/кластеризацию), а сравнение выполняется
  // не на каждый кадр, а один раз при завершении фонового запроса.
  function dataChanged(oldData, newData) {
    return JSON.stringify(oldData) !== JSON.stringify(newData);
  }

  // Собственно сетевой запрос данных слоя, без кэша — используется и для
  // холодного старта, и для фоновой сверки уже показанного кэша.
  function fetchLayerDataRaw(st, id) {
    return st.meta.type === 'heat' ? MapAPI.getHeatmap() : MapAPI.getLayerData(id);
  }

  // Обёртка над fetchLayerDataRaw с дедупликацией: если для этого слоя уже
  // идёт запрос (st.pending — например, фоновый прогрев всех слоёв при старте,
  // см. prefetchAllLayers), возвращает ТОТ ЖЕ Promise вместо того, чтобы
  // запускать второй параллельный запрос за одними и теми же данными. Нужна
  // именно потому, что прогрев при старте и ручное включение тумблера
  // пользователем могут случайно совпасть по времени для одного слоя —
  // без дедупликации оба пути (prefetchLayer и toggleLayer, холодный путь)
  // синхронно увидели бы пустой st.cache и оба сходили бы на сервер отдельно.
  function fetchLayerDataShared(st, id) {
    if (!st.pending) {
      st.pending = fetchLayerDataRaw(st, id).finally(() => { st.pending = null; });
    }
    return st.pending;
  }

  // Общая точка входа "построить слой карты из данных" — используется и для
  // кэшированных, и для свежих данных, чтобы не дублировать ветвление по типу.
  function buildGroupFor(st, data) {
    return st.meta.type === 'heat' ? buildHeat(data) : buildVectorGroup(st, data);
  }

  function setCount(item, n) {
    const c = item && item.querySelector('[data-count]');
    if (c) c.textContent = n;
  }

  // =====================================================================
  //  Настройки слоя (модальное окно)
  // =====================================================================
  // Разметка формы приходит готовым HTML-фрагментом с сервера (аналогично
  // .detail__html в панели «Подробно» — см. АнгелКартографияВнешнееAPI.
  // ПолучитьНастройкиСлоя), клиент не знает о конкретных полях конкретного
  // слоя. Единственный контракт с сервером — используемые в разметке классы
  // (.settings-form/.settings-form__row/...) и то, что каждый ввод имеет
  // name = имя ключа фильтра и HTML-тип, однозначно говорящий, как читать
  // значение (checkbox/number/select[multiple]/остальное — строка).
  // Открытие идёт через общий контроллер модалки (см. js/settings-form.js:
  // openSettings) — тот же #settingsOverlay делит между собой панель слоёв
  // и вкладка «Отчёты» (см. reports.js: openReportSettings), поэтому сама
  // модалка не знает про layerState и получает только descriptor.
  // Слои с длинной формой фильтров (десятки полей) — не помещаются в стандартную
  // ширину модалки настроек (см. .modal--wide в css/styles.css). Известно заранее на
  // клиенте, не дожидаясь ответа сервера: список id в BackendPlugin.wideSettingsLayers
  // (раньше — захардкоженный здесь набор слоёв accident-analysis) либо флаг
  // wideSettings:true в метаданных слоя из /layers.
  function isWideSettingsLayer(st) {
    return !!(st.meta.wideSettings || (BackendPlugin.wideSettingsLayers || []).includes(st.meta.id));
  }

  function openLayerSettings(id) {
    const st = layerState[id];
    SettingsForm.openSettings({
      title: `Настройки слоя «${st.meta.label}»`,
      wide: isWideSettingsLayer(st),
      load: () => MapAPI.getLayerSettings(id),
      save: values => MapAPI.saveLayerSettings(id, values),
      onApplied: async () => {
        // Настройки изменились — старый кэш данных слоя относится к прежнему
        // фильтру и никогда не должен всплыть при следующем включении, даже
        // если слой сейчас выключен.
        if (layerState[id]) {
          layerState[id].cache = null;
        }
        // /layers читается один раз при старте (см. loadLayers), поэтому
        // сохранённые в фильтрах флаги вроде highlightNoRoute (см.
        // buildVectorGroupInner) в st.meta иначе останутся устаревшими до
        // перезагрузки страницы. Обновляем ТОЛЬКО meta нужного слоя — панель
        // слоёв (порядок, тумблеры, счётчики, состояние групп) не трогаем.
        // Ошибка запроса не фатальна — настройки уже сохранены на сервере,
        // просто логируем и продолжаем передёргивание слоя со старым meta.
        if (layerState[id]) {
          try {
            const freshLayers = await MapAPI.getLayers();
            const freshMeta = freshLayers.find(l => l.id === id);
            if (freshMeta) layerState[id].meta = freshMeta;
          } catch (e) {
            console.error('openLayerSettings: не удалось обновить meta слоя после сохранения настроек', id, e);
          }
          // Состав легенды зависит от фильтра (у Треков — от выбранных ГРЗ),
          // а DOM панели слоёв после старта сам не пересобирается: без этого
          // вызова пользователь увидел бы разноцветные треки при легенде от
          // прежнего фильтра.
          renderLayerLegend(id);
        }
        // Слой уже включён — перечитываем его данные с новыми фильтрами тем же
        // безопасным путём (token-guard в toggleLayer), что и обычный тумблер.
        // Кэш уже очищен выше, поэтому toggleLayer(id, true) пойдёт холодным
        // путём, а не мгновенно покажет данные по старому фильтру.
        if (layerState[id] && layerState[id].on) {
          await toggleLayer(id, false);
          await toggleLayer(id, true);
        }
      }
    });
  }

  /**
   * Обесцвечивание подложки под тепловой слой.
   * В 1С для этого подменяется тайловый слой на L.tileLayer.grayscale;
   * здесь — CSS-фильтр только на слое тайлов (маркеры и heat остаются
   * цветными, тайлы не перезапрашиваются).
   */
  function setBasemapGrayscale(flag) {
    document.getElementById('map').classList.toggle('is-grayscale', flag);
  }

  // Переключение подложки 2ГИС/OSM (см. .basemap-switch в buildChrome).
  function setBasemap(id) {
    const layers = { '2gis': gisLayer, osm: osmLayer };
    const next = layers[id];
    if (!next || map.hasLayer(next)) return;

    Object.values(layers).forEach(l => map.hasLayer(l) && map.removeLayer(l));
    next.addTo(map);

    document.querySelectorAll('.basemap-switch__btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.basemap === id);
    });
  }

  // =====================================================================
  //  Линейка (аналог L.control.ruler нативной карты)
  // =====================================================================
  // Собственная реализация, а не перенос вендорного плагина 1С
  // (CommonTemplates/Карта_Clusters_Ruler_js): у того плагина строка,
  // переключающая режим измерения по клику на кнопку, закомментирована
  // (`// this._choice = !this._choice;`), из-за чего клик по кнопке там
  // ничего не включает. Здесь режим переключается явно.
  const RULER_LINE_STYLE = { color: '#00a8ff', weight: 3, dashArray: '6 4' };
  const RULER_POINT_STYLE = { radius: 4, color: '#00a8ff', weight: 2, fillColor: '#fff', fillOpacity: 1 };

  let rulerActive = false;
  let rulerLayer = null;    // зафиксированные клики (точки + сегменты)
  let rulerTemp = null;     // пунктир + подсказка от последней точки до курсора
  let rulerPoints = [];     // L.LatLng[] зафиксированных точек
  let rulerTotal = 0;       // сумма зафиксированных сегментов, метры

  function toggleRuler() {
    if (rulerActive) { stopRulerActive(); return; }
    rulerActive = true;
    document.getElementById('rulerBtn').classList.add('is-active');
    // Линейка и команды карты (см. ниже) — взаимоисключающие режимы: оба вешают
    // свой постоянный map.on('click', ...) и без этого один клик по карте бил бы
    // сразу в оба обработчика (см. журнал изменений/разбор бага — линейка активна,
    // включили «Построить маршрут», клики одновременно копятся и в линейку, и в
    // маршрут). stopMapCommand() — no-op, если ни одна команда не активна.
    stopMapCommand();
    startRuler();
  }

  // Тот же переход, что и «выключающая» ветка toggleRuler() выше, но вызываемый
  // не по клику на саму кнопку линейки, а когда активацию линейки нужно откатить
  // программно (сейчас — единственный кейс: активировали команду карты поверх
  // работающей линейки, см. startMapCommand()).
  function stopRulerActive() {
    if (!rulerActive) return;
    rulerActive = false;
    document.getElementById('rulerBtn').classList.remove('is-active');
    stopRuler();
  }

  function startRuler() {
    rulerPoints = [];
    rulerTotal = 0;
    rulerLayer = L.layerGroup().addTo(map);
    map.getContainer().style.cursor = 'crosshair';
    map.doubleClickZoom.disable();
    map.on('click', onRulerClick);
    map.on('mousemove', onRulerMove);
    document.addEventListener('keydown', onRulerKeydown);
  }

  function stopRuler() {
    map.off('click', onRulerClick);
    map.off('mousemove', onRulerMove);
    document.removeEventListener('keydown', onRulerKeydown);
    map.doubleClickZoom.enable();
    map.getContainer().style.cursor = '';
    if (rulerLayer) { map.removeLayer(rulerLayer); rulerLayer = null; }
    if (rulerTemp)  { map.removeLayer(rulerTemp);  rulerTemp = null; }
    rulerPoints = [];
    rulerTotal = 0;
  }

  function onRulerKeydown(e) {
    if (e.key === 'Escape') toggleRuler();
  }

  function onRulerClick(e) {
    if (rulerPoints.length > 0) {
      const prev = rulerPoints[rulerPoints.length - 1];
      rulerTotal += haversineMeters(prev, e.latlng);
      L.polyline([prev, e.latlng], RULER_LINE_STYLE).addTo(rulerLayer);
    }
    rulerPoints.push(e.latlng);
    L.circleMarker(e.latlng, RULER_POINT_STYLE).addTo(rulerLayer);
  }

  // Пунктирная линия от последней зафиксированной точки до курсора и
  // подсказка с суммой (зафиксированное + текущий сегмент) — пересоздаются
  // на каждое движение мыши, как и в вендорном плагине.
  function onRulerMove(e) {
    if (!rulerPoints.length) return;
    if (rulerTemp) map.removeLayer(rulerTemp);

    const last = rulerPoints[rulerPoints.length - 1];
    const segment = haversineMeters(last, e.latlng);

    rulerTemp = L.layerGroup();
    L.polyline([last, e.latlng], RULER_LINE_STYLE).addTo(rulerTemp);
    L.marker(e.latlng, { icon: L.divIcon({ className: '', iconSize: [0, 0] }), interactive: false })
      .bindTooltip(formatDistance(rulerTotal + segment),
        { permanent: true, direction: 'top', offset: [0, -8], className: 'map-tip ruler-tip' })
      .addTo(rulerTemp)
      .openTooltip();
    rulerTemp.addTo(map);
  }

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad;
    const dLng = (b.lng - a.lng) * toRad;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function formatDistance(meters) {
    return meters >= 1000 ? (meters / 1000).toFixed(2) + ' км' : Math.round(meters) + ' м';
  }

  // =====================================================================
  //  Команды карты (BackendPlugin.mapCommands) — обобщённый toggle-режим со
  //  сбором точек кликом по карте, по образу линейки чуть выше (toggleRuler/
  //  startRuler/onRulerClick): свой toggle-режим, свой набор зафиксированных
  //  точек, Escape отменяет. Единственная форма команды, которую понимает
  //  ядро сейчас (см. CLAUDE.md, "Backend plugins" — контракт MapCommand);
  //  сегодняшние потребители — «Построить маршрут» и «Добавить ДТП» accident-
  //  analysis (js/backends/accident-analysis.js, поле mapCommands, см. CLAUDE.md,
  //  "Команды карты") — сама фича (OSRM-запрос/таблица очагов/нарисованная линия
  //  маршрута; форма создания ДТП) ядру больше не известна, оно знает только:
  //  сгенерировать кнопку, собрать точки, вызвать cmd.onComplete(points, ctx) и
  //  дать плагину написать результат в детейл-панель через ctx.renderResult.
  //  Бэкенд без поля mapCommands (или с пустым массивом) просто не получает ни
  //  одной доп. кнопки в тулбаре — не нужен отдельный явный false-флаг, как у
  //  supportsReports, симметрично dashboardDemo.
  //
  //  cmd.autoCompleteAtMinPoints (необязательное поле, по умолчанию не задано =
  //  Ложь) — по умолчанию команда требует повторного клика по кнопке тулбара,
  //  даже когда уже набрано minPoints точек (см. toggleMapCommand). «Добавить
  //  ДТП» — первый кейс, которому это неудобно: там ровно одна точка и есть весь
  //  ввод, вынуждать на второй клик незачем. При Истина и достижении minPoints
  //  onCommandClick завершает команду сразу тем же finishMapCommand(), которым
  //  обычно управляет только toggleMapCommand — повторный клик по кнопке
  //  по-прежнему работает как отмена (stopMapCommand), если он всё же случился
  //  раньше авто-финиша.
  // =====================================================================
  const COMMAND_POINT_STYLE = { radius: 5, color: '#000000', weight: 2, fillColor: '#fff', fillOpacity: 1 };

  let activeCommand = null;         // текущий MapCommand (элемент BackendPlugin.mapCommands) или null
  let commandPoints = [];           // L.LatLng[] кликнутых точек текущей команды
  let commandDraftLayer = null;     // маркеры кликнутых точек, пока команда не завершена
  let activeCommandOnClose = null;  // onClose, переданный плагином в ctx.renderResult — см. closeMapCommandDetail

  function mapCommandButtonsHtml() {
    return (BackendPlugin.mapCommands || [])
      .map(cmd => `<button class="ruler-btn" id="mapCmd-${cmd.id}" title="${cmd.title}">${cmd.icon}</button>`)
      .join('');
  }

  function toggleMapCommand(cmd) {
    if (activeCommand === cmd) finishMapCommand();
    else startMapCommand(cmd);
  }

  function startMapCommand(cmd) {
    // Защита на будущее для второй одновременной команды (сейчас недостижимо —
    // команда ровно одна, но дёшево сделать сразу правильно): активация новой
    // команды при уже активной другой сначала останавливает первую.
    if (activeCommand && activeCommand !== cmd) stopMapCommand();
    // См. toggleRuler()/stopRulerActive() выше — линейка и команды карты
    // взаимоисключающие режимы, оба держат свой map.on('click', ...).
    stopRulerActive();
    activeCommand = cmd;
    commandPoints = [];
    commandDraftLayer = L.layerGroup().addTo(map);
    document.getElementById(`mapCmd-${cmd.id}`).classList.add('is-active');
    map.getContainer().style.cursor = 'crosshair';
    map.doubleClickZoom.disable();
    map.on('click', onCommandClick);
    document.addEventListener('keydown', onCommandKeydown);
  }

  function stopMapCommand() {
    if (!activeCommand) return;
    document.getElementById(`mapCmd-${activeCommand.id}`).classList.remove('is-active');
    activeCommand = null;
    map.off('click', onCommandClick);
    document.removeEventListener('keydown', onCommandKeydown);
    map.doubleClickZoom.enable();
    map.getContainer().style.cursor = '';
    if (commandDraftLayer) { map.removeLayer(commandDraftLayer); commandDraftLayer = null; }
    commandPoints = [];
  }

  function onCommandKeydown(e) {
    if (e.key === 'Escape') stopMapCommand();
  }

  // Нумерованная точка-маркер — та же обратная связь, что была у нативной карты
  // маршрута ("Точка №N", см. ОбработкаСобытия_addnewdot в ПостроитьМаршрут).
  // Стиль черновых точек — общий для любой команды (см. CLAUDE.md, единственный
  // сегодняшний потребитель использует ровно то же визуальное решение, что и
  // линейка; заводить под это поле контракта было бы преждевременной общностью).
  function onCommandClick(e) {
    commandPoints.push(e.latlng);
    L.circleMarker(e.latlng, COMMAND_POINT_STYLE)
      .bindTooltip(`Точка №${commandPoints.length}`, { className: 'map-tip' })
      .addTo(commandDraftLayer);
    // autoCompleteAtMinPoints — см. комментарий-заголовок секции выше. Обычный
    // повторный клик по кнопке (toggleMapCommand) остаётся рабочим путём отмены,
    // если пользователь успел кликнуть по ней раньше, чем сработал этот авто-финиш.
    if (activeCommand && activeCommand.autoCompleteAtMinPoints &&
        commandPoints.length >= (activeCommand.minPoints || 2)) {
      finishMapCommand();
    }
  }

  async function finishMapCommand() {
    const cmd = activeCommand;
    const minPoints = cmd.minPoints || 2;
    // Повторный клик по кнопке команды, ещё не набравшей minPoints точек, —
    // это отмена, а не «попробуйте снова»: пользователь явно нажал ту же кнопку,
    // которой включал режим, значит хочет выйти, а не получить подсказку и
    // остаться запертым в нём (единственный путь наружу тогда — Escape, о
    // котором пользователь может не знать). Симметрично тому, как кнопка
    // линейки уже сейчас выключает её в любой момент. minPoints и выше — второй
    // клик завершает команду по-настоящему, см. ниже.
    if (commandPoints.length < minPoints) {
      stopMapCommand();
      return;
    }
    const points = commandPoints.slice();
    stopMapCommand();

    const btn = document.getElementById(`mapCmd-${cmd.id}`);
    btn.disabled = true;
    try {
      await cmd.onComplete(points, buildCommandCtx());
    } finally {
      btn.disabled = false;
    }
  }

  function showHint(text) {
    const tip = L.tooltip({ permanent: true, direction: 'top', className: 'map-tip ruler-tip' })
      .setLatLng(map.getCenter())
      .setContent(text)
      .addTo(map);
    setTimeout(() => map.removeLayer(tip), 2200);
  }

  // Тот же приём, что openLayerSettings()'s onApplied уже делает после
  // сохранения фильтров слоя (см. выше): очистить кэш и, если слой сейчас
  // включён, перевключить его — так карта показывает свежие данные без
  // перезагрузки страницы. Не рефакторим openLayerSettings под общий вызов
  // этого метода — тот путь внутренний для ядра, этот существует специально
  // для потребителей снаружи модуля.
  // Слой, ни разу не запрошенный/не в layerState — молча ничего не делает,
  // обновлять нечего (он и так не показан).
  //
  // 2026-09-22: поднята из buildCommandCtx() в область модуля и добавлена в
  // публичный MapApp — её зовёт дашборд «Чистых дорог» после POST
  // /dashboard/focus (js/backends/clean-roads.js, focusOnMap()), а команд карты
  // (единственный прежний путь к ней, ctx-контракт) у того бэкенда нет вовсе.
  // Сам ctx ниже отдаёт ровно эту же функцию — поведение команд accident-analysis
  // не меняется.
  async function refreshLayer(layerId) {
    const st = layerState[layerId];
    if (!st) return;
    st.cache = null;
    if (st.on) {
      await toggleLayer(layerId, false);
      await toggleLayer(layerId, true);
    }
  }

  // ctx — минимальный набор хуков, чтобы плагин (отдельный script/closure, как и
  // dashboardTemplates' normalize(), см. CLAUDE.md "Dashboard" про DashboardApp.pairs/
  // factorPairs) мог дотянуться до нужных внутренностей map.js/api.js без их
  // дублирования. Собирается один раз, непосредственно перед cmd.onComplete.
  function buildCommandCtx() {
    return {
      map, L,
      apiUrl: MapAPI.apiUrl, getJSON: MapAPI.getJSON, postJSON: MapAPI.postJSON,
      showHint,
      // Панель "Подробно" переиспользуется как есть (тот же #detailBody/#detailActions,
      // что и у обычных объектов слоя, см. selectObject/renderDetail ниже) — команда не
      // является объектом ни одного слоя, поэтому пишем в неё напрямую, а не через
      // MapApp.selectObject (которая ждёт layerId/objectId и ходит за деталями в
      // /object/{layerId}/{objectId}). Контент (bodyHtml/actionsHtml) целиком на
      // совести плагина, как и раньше.
      renderResult(bodyHtml, actionsHtml, onClose) {
        document.getElementById('panelDetail').classList.remove('is-collapsed');
        document.getElementById('revealDetail').classList.remove('is-visible');
        document.getElementById('detailBody').innerHTML = bodyHtml;
        document.getElementById('detailActions').innerHTML = actionsHtml;
        activeCommandOnClose = onClose || null;
      },
      // Та же функция, что и MapApp.refreshLayer — лежит в области модуля (см.
      // её комментарий выше), здесь только прокидывается в ctx-контракт
      // плагина (см. CLAUDE.md, "Команды карты").
      refreshLayer
    };
  }

  function closeMapCommandDetail() {
    if (activeCommandOnClose) { activeCommandOnClose(); activeCommandOnClose = null; }
    MapApp.closeDetail();
  }

  // Площадь одного контура по формуле Гаусса (координаты в градусах — не настоящие
  // м², только относительный размер для сортировки z-order ниже, площади на одной
  // карте искажены проекцией одинаково, так что сравнение между ними корректно).
  function ringArea(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
      sum += p1[1] * p2[0] - p2[1] * p1[0];
    }
    return Math.abs(sum) / 2;
  }

  // dots — [часть][контур][точка] (см. buildVectorGroup) — суммируем площадь внешнего
  // контура КАЖДОЙ части, не только первой. Проверено вживую на «Сахалинская область»
  // (АА-проект, слой АдминистративныеЕдиницы): 6 частей — материк + острова — первая
  // часть в данных оказалась маленьким фрагментом (~0.24), а материковая — 16.9 из
  // общих ~26.7. Считая только первую часть, область (мультиполигон) сортировалась как
  // "мельче" почти всех округов и красилась поверх них — кликался только сам округ
  // Южно-Сахалинск (единственный настолько маленький, чтобы всё равно быть меньше
  // даже этого фрагмента) и сама область, а 17 остальных округов оказывались погребены
  // под ней. Дыры внутри частей по-прежнему не учитываются (не влияют на порядок
  // величины настолько, чтобы сортировку сломать).
  function polygonArea(dots) {
    if (!dots) return 0;
    let total = 0;
    for (const part of dots) {
      if (part && part[0]) total += ringArea(part[0]);
    }
    return total;
  }

  // =====================================================================
  //  Построение слоёв Leaflet
  // =====================================================================
  // Зум-зависимая фильтрация по виду геометрии (см. RoadZoomFilterLayer ниже)
  // — чисто клиентская доработка, её тиры не приходят с сервера ни для одного
  // существующего бэкенда (для accident-analysis, единственного бэкенда с
  // такими тирами сейчас, проверено явно против нативной карты — см.
  // BackendPlugin.zoomTiers в js/backends/accident-analysis.js и CLAUDE.md,
  // "Road zoom filtering"). Раньше был захардкожен один id
  // ("АвтомобильныеДороги") прямо здесь — теперь любой id, присутствующий в
  // BackendPlugin.zoomTiers (обобщено 2026-08-24, см. Задачу 4 плана
  // рефакторинга). Остальные слои (в т.ч. другие линии/полигоны)
  // buildVectorGroup строит как раньше — см. buildVectorGroupInner.
  function buildVectorGroup(st, data) {
    const tiers = BackendPlugin.zoomTiers && BackendPlugin.zoomTiers[st.meta.id];
    if (tiers) return new RoadZoomFilterLayer(st, data, tiers);
    return buildVectorGroupInner(st, data);
  }

  function buildVectorGroupInner(st, data) {
    const meta = st.meta;
    // Кластеризация — только для точечных слоёв, и только если явно не
    // отключена флагом `cluster: false` в метаданных слоя (см. api.js).
    if (meta.type === 'point') {
      // 2026-08-04: рендер точечного слоя выбирается по флагу `cluster` с
      // сервера, а не по тому, есть ли у слоя своя пиктограмма
      // (BackendPlugin.canvasIcons/pointIconShapes) — см. buildPointMarker() ниже, она
      // сама решает canvas-иконка это или обычный L.icon по тому же признаку.
      // `cluster: false` → canvas (buildPointGroup, ниже — единственный
      // оставшийся canvas-путь, без кластеризации, картинка прямо на общем
      // рендерере, дёшево при больших объёмах). Иначе → настоящий
      // L.markerClusterGroup (RealMarkerLayerHandle, ниже) — spiderfy и
      // плавная zoom-анимация, как у this.MarkerGroup нативной карты
      // АА-проекта (см. её раздел ниже за подробным сравнением с
      // CommonTemplates/Map_js).
      if (meta.cluster === false) return buildPointGroup(meta, data);
      return new RealMarkerLayerHandle(meta.id, meta, data);
    }

    // Векторные тайлы (VectorGrid) — под раздельными тумблерами
    // MapConfig.perf.vectorTilesLines/vectorTilesPolygons (см. config.js): геометрия
    // режется на тайлы прямо в браузере (geojson-vt) и рисуется своим тайловым
    // canvas-рендерером — только видимые тайлы, с упрощением по зуму, вместо
    // полного ре-рендера всех L.polyline/L.polygon на каждый zoomend. Точки/
    // кластеры выше не трогаем. Раздельные флаги позволяют, например, оставить
    // тайлы включёнными для линий (дороги) и выключить для полигонов (районы),
    // если «швы» заливки на полигонах мешают, а на линиях — нет.
    const vgFlag = meta.type === 'line' ? 'vectorTilesLines'
                  : meta.type === 'polygon' ? 'vectorTilesPolygons' : null;
    // Слой с воспроизведением трека (isPlaybackLayer, раньше — захардкоженный
    // id 'Треки') — исключение из VG-пути: воспроизведение (см.
    // "Воспроизведение трека" ниже, trackPoints()) читает геометрию через
    // findLayer(layerId, id).getLatLngs(), которому нужен настоящий
    // per-объектный L.polyline — VG-группа не итерируется (findLayer()
    // возвращает null для неё), так что при vectorTilesLines:true кнопки
    // скорости молча ничего не делали (playTrack получал 0 точек и выходил
    // по points.length < 2). На traffic-monitor это единственный line-слой,
    // где это бьёт — на accident-analysis слоя "Треки" нет вовсе.
    if (vgFlag && MapConfig.perf && MapConfig.perf[vgFlag] && !isPlaybackLayer(meta)) {
      return buildVectorGridGroup(st, data);
    }

    // dots — формат 1С (см. Каталог.*.ЗаполнитьСведенияДляКарты): массив
    // участков, каждый — массив точек [lat,lng]. Leaflet понимает такую
    // вложенность нативно что у L.polyline, что у L.polygon (мульти-линия/
    // мульти-полигон одним слоем).
    const group = L.layerGroup();
    // Полигоны — от большего к меньшему: SVG рисует позже добавленные слои
    // ПОВЕРХ более ранних, поэтому при сортировке "сначала крупные" вложенные
    // мелкие единицы (напр. район города внутри города) оказываются сверху и
    // остаются кликабельными, а не перекрыты насквозь родительским контуром.
    // Без сортировки порядок — какой прислал сервер, и клик по мелкой фигуре
    // внутри крупной может вообще не долетать до неё. Нативная 1С-карта решает
    // это по-другому — порядком строк из самого запроса (см. АА-проект,
    // Catalogs/АдминистративныеЕдиницы/Ext/ManagerModule.bsl, УПОРЯДОЧИТЬ ПО
    // ВидыАдминистративныхЕдиниц.Код УБЫВ) — но полагаться, что любой бэкенд
    // всегда предоставит такой порядок, не стоит, сортируем сами на клиенте.
    // Площадь каждого объекта считаем РОВНО ОДИН раз (а не внутри компаратора
    // sort — тот вызывает его на каждое сравнение, O(n log n) раз на один и
    // тот же объект вместо одного): decorate-sort-undecorate. На слоях с
    // детальной геометрией (реальные границы region/округов — тысячи вершин
    // на контур, см. polygonArea) пересчёт площади внутри компаратора сам по
    // себе был заметным синхронным тормозом, независимо от числа объектов.
    const items = meta.type === 'polygon'
      ? data.map(obj => ({ obj, area: polygonArea(obj.dots) }))
            .sort((a, b) => b.area - a.area)
            .map(x => x.obj)
      : data;
    // Один синхронный проход по всем объектам слоя — не разбито на порции по
    // кадрам (было — см. git-историю fillGroupAsync/vertexCount, убрано
    // 2026-08-01 как overkill): вывод ОДНОГО слоя не должен сам по себе быть
    // растянут во времени, растянута только фоновая подгрузка/кэширование
    // между слоями (см. prefetchAllLayers). Основной источник фриза на
    // "тяжёлых" полигонах (АдминистративныеЕдиницы) был не сам этот цикл, а
    // повторный пересчёт площади внутри компаратора sort — уже исправлено
    // decorate-sort-undecorate'ом выше.
    items.forEach(obj => {
      let lyr;
      let noRouteOverlay = null;
      if (meta.type === 'line') {
        lyr = L.polyline(obj.dots, { color: obj.color || meta.color, weight: 4, opacity: 0.85 });
        // Подсветка участков без маршрута (аналог Map.prototype.addPolygon,
        // ветка FigureType === 4, в нативной карте 1С — см. traffic monitor/
        // src/CommonTemplates/Карта_Map_js/Ext/Template.txt): некликабельный
        // оверлей поверх основной линии для точек трека, у которых на сервере
        // не проставлен ТрекиКоординаты.Маршрут. Флаг слоя приходит с сервера
        // (highlightNoRoute в GET /layers) — этот код общий для любого line-
        // слоя, без хардкода 'Треки', но фактически данные с noRouteDots
        // печёт только Каталог.Треки.
        if (meta.highlightNoRoute && Array.isArray(obj.noRouteDots) && obj.noRouteDots.length) {
          const noRouteStyle = { interactive: false, color: 'red', weight: 4, opacity: 1 };
          noRouteOverlay = L.polyline(obj.noRouteDots, noRouteStyle);
          noRouteOverlay._origStyle = { ...noRouteStyle };
          lyr.noRouteLayer = noRouteOverlay;
        }
      } else if (meta.type === 'polygon') {
        // dashArray — из тех же native-данных (1С шлёт его только для отдельных
        // подвидов, напр. АдминистративныеЕдиницы.Вид = РайонГорода, см. АА-проект
        // Catalogs/АдминистративныеЕдиницы/Ext/ManagerModule.bsl), не наша выдумка —
        // сплошная граница по умолчанию, пунктир только когда сервер его прислал.
        lyr = L.polygon(obj.dots, { color: obj.color || meta.color, weight: 2,
                                    fillOpacity: 0.12, dashArray: obj.dashArray || null });
      }
      if (!lyr) return;
      bindObject(lyr, meta.id, obj, meta.type);
      group.addLayer(lyr);
      // Оверлей добавляется В ТУ ЖЕ группу ПОСЛЕ основной линии, чтобы лечь
      // поверх неё (Canvas-рендерер тоже красит по порядку добавления — см.
      // CLAUDE.md, "Polygon z-order"). bindObject() для оверлея намеренно не
      // зовётся — см. комментарий выше про _objId и findLayer().
      if (noRouteOverlay) group.addLayer(noRouteOverlay);
    });
    return group;
  }

  // =====================================================================
  //  Зум-зависимый показ линий/полигонов по виду (обобщённый — любой слой
  //  из BackendPlugin.zoomTiers, было "только АвтомобильныеДороги")
  // =====================================================================
  // Тиры ({minZoom, types}[]) приходят параметром конструктора (см.
  // buildVectorGroup выше), а не читаются из модульной константы — раньше
  // здесь был захардкожен ровно один слой ("АвтомобильныеДороги") с фиксированным
  // порогами прямо в ядре; теперь источник — BackendPlugin.zoomTiers[layerId]
  // (см. js/backends/<id>.js), обобщено 2026-08-24. Для accident-analysis
  // тиры остались теми же (ниже zoom=11 — только Федеральная; 11-12 — +
  // Региональная; с 13 — все виды, в т.ч. Местного значения и любой
  // нераспознанный сервером вид), только переехали в плагин.
  function roadTypesForZoom(tiers, zoom) {
    let types = tiers[0].types;
    for (const tier of tiers) {
      if (zoom >= tier.minZoom) types = tier.types;
    }
    return types;
  }

  // Обёртка над обычным buildVectorGroupInner() (VectorGrid-тайлы или
  // классические L.polyline, в зависимости от MapConfig.perf.vectorTilesLines —
  // фильтр по виду работает одинаково в обоих случаях, т.к. просто отдаёт им
  // ОТФИЛЬТРОВАННЫЙ по видам массив data вместо полного). На zoomend строит
  // видимый набор видов заново, только если сам набор действительно изменился
  // (переход через порог) — обычный зум внутри одного и того же диапазона
  // порогов не трогает вложенный слой вообще. Фильтрует по obj.typeRoad —
  // конкретное поле, по которому фильтрует accident-analysis; общее для любого
  // слоя, попавшего в BackendPlugin.zoomTiers (тиры этого плагина сами решают,
  // какие значения typeRoad туда положить).
  const RoadZoomFilterLayer = L.LayerGroup.extend({
    initialize(st, data, tiers, options) {
      L.LayerGroup.prototype.initialize.call(this, [], options);
      this._st = st;
      this._data = data;
      this._tiers = tiers;
      this._currentKey = undefined;
      this._innerGroup = null;
    },
    onAdd(map) {
      L.LayerGroup.prototype.onAdd.call(this, map);
      map.on('zoomend', this._onZoom, this);
      this._onZoom();
    },
    onRemove(map) {
      map.off('zoomend', this._onZoom, this);
      // НЕ L.LayerGroup.prototype.onRemove — та снимает слои через
      // this.eachLayer(map.removeLayer, map), а eachLayer здесь (см. ниже)
      // переопределён на делегирование в this._innerGroup.eachLayer(), которого
      // у VectorGrid-слоя нет вовсе (см. buildVectorGridGroup). Итог: при
      // vectorTilesLines:true (дефолт) выключение слоя снимало ОБЁРТКУ с карты,
      // но не сам VG-слой внутри — дороги оставались видны после выключения
      // тумблера (найдено вживую на /map, «выключение слоя не убирает
      // автодороги»). this.removeLayer() — тот же inherited-метод, что уже
      // корректно используется в _onZoom() при смене зум-порога (идёт прямо
      // в this._map.removeLayer(), а не через eachLayer) — снимает актуальный
      // this._innerGroup с карты независимо от того, VG он или классический.
      if (this._innerGroup) this.removeLayer(this._innerGroup);
    },
    _onZoom() {
      const map = this._map;
      if (!map) return;
      const types = roadTypesForZoom(this._tiers, map.getZoom());
      const key = types ? types.join(',') : '*';
      if (key === this._currentKey) return; // тот же набор видов — перестраивать нечего
      this._currentKey = key;
      // Снимаем общий VG-тултип ПЕРЕД удалением старого внутреннего слоя —
      // у VectorGrid-фич нет пофигурного bindTooltip, mouseout синтезируется
      // только реальным движением курсора (см. showVGTooltip/hideVGTooltip),
      // а не удалением слоя из-под него. Без этого тултип, открытый над
      // дорогой у самой границы зум-порога, остаётся висеть поверх уже
      // убранной фичи до следующего реального движения мыши (найдено вживую).
      hideVGTooltip();
      if (this._innerGroup) this.removeLayer(this._innerGroup);
      const filtered = types ? this._data.filter(obj => types.includes(obj.typeRoad)) : this._data;
      this._innerGroup = buildVectorGroupInner(this._st, filtered);
      this.addLayer(this._innerGroup);
    },
    // Прозрачно делегируем во вложенный слой — findLayer()/closeAllTooltips()
    // ожидают st.group.eachLayer() по отдельным объектам, а не по единственному
    // слою-обёртке (у VectorGrid-слоя eachLayer нет вовсе — это штатно, см.
    // существующие guard'ы "VG-группа не итерируется" в findLayer()).
    eachLayer(fn, ctx) {
      if (this._innerGroup && this._innerGroup.eachLayer) this._innerGroup.eachLayer(fn, ctx);
      return this;
    }
  });

  // =====================================================================
  //  Векторные тайлы (VectorGrid) — альтернативный рендер линий/полигонов
  // =====================================================================
  // Строит VectorGrid-слой из тех же данных `dots`, что и buildVectorGroup, но
  // с нарезкой на тайлы (geojson-vt) и тайловым canvas-рендерингом. Модель
  // интерактивности у VectorGrid другая (нет пофигурных L.polygon-объектов —
  // события несут feature.properties, а подсветка идёт через setFeatureStyle по
  // id фичи), поэтому здесь же заводим побочные таблицы objId→{fid, bounds},
  // а выбор/центрирование/подсветку/тултип обслуживают VG-ветки в selectObject/
  // centerOn/clearVectorSelection ниже. Признак VG-группы — наличие ._byObjId.

  // Координатная пара 1С — [lat, lng] (два числа).
  function isLatLngPair(a) {
    return Array.isArray(a) && a.length >= 2 && typeof a[0] === 'number' && typeof a[1] === 'number';
  }

  // dots → GeoJSON-геометрия, устойчиво к ГЛУБИНЕ вложенности. Разные слои 1С
  // приходят с разной вложенностью для одного и того же geom-типа: полигоны бывают
  // и одиночные `[контур][точка]` (напр. УчасткиДороги — «Места концентрации»), и
  // мульти `[часть][контур][точка]` (напр. АдминистративныеЕдиницы); линии —
  // `[точка]` или `[сегмент][точка]`. Классический L.polyline/L.polygon это ел
  // молча, а фиксированный конвертер — нет (на более мелкой структуре swap
  // получал число и рождал [undefined,undefined] → падение coordsBounds). Поэтому
  // тип выбираем по фактической глубине, а своп [lat,lng]→[lng,lat] делаем
  // рекурсивно по листовым парам, сохраняя вложенность.
  function deepSwapCoords(a) {
    if (isLatLngPair(a)) return [a[1], a[0]];
    return Array.isArray(a) ? a.map(deepSwapCoords) : a;
  }
  function coordDepth(a) {   // уровней массивов до координатной пары: Polygon=2/MultiPolygon=3, LineString=1/MultiLineString=2
    let d = 0, cur = a;
    while (Array.isArray(cur) && !isLatLngPair(cur)) { cur = cur[0]; d++; if (cur == null) break; }
    return d;
  }
  // Убираем пустые контуры/линии на ЛЮБОМ уровне вложенности. geojson-vt
  // (worker: simplify → `points[0][2] = 1`) падает на пустом массиве точек
  // с «Cannot set properties of undefined (setting '2')»: project() отдаёт
  // пустой projected, а simplify разыменовывает points[0]. Классический
  // L.polyline/L.polygon пустую геометрию ел молча, VectorGrid — нет; на
  // удалённой базе среди автодорог попадаются записи с пустым dots. Возвращаем
  // null, если после чистки не осталось ни одной координатной пары.
  function pruneEmptyCoords(a) {
    if (isLatLngPair(a)) return a;
    if (!Array.isArray(a)) return null;
    const kept = a.map(pruneEmptyCoords).filter(x => x != null);
    return kept.length ? kept : null;
  }
  function dotsToGeometry(dots, isPolygon) {
    const coordinates = pruneEmptyCoords(deepSwapCoords(dots));
    if (coordinates == null) return null;   // пустая геометрия — фичу пропускаем
    const d = coordDepth(coordinates);
    const type = isPolygon ? (d >= 3 ? 'MultiPolygon' : 'Polygon')
                           : (d >= 2 ? 'MultiLineString' : 'LineString');
    return { type, coordinates };
  }

  // Габариты объекта из GeoJSON-координат (для centerOn) — устойчиво к любой
  // глубине и к некорректным/пустым узлам (не падаем на undefined).
  function coordsBounds(coords) {
    const b = L.latLngBounds([]);
    (function walk(a) {
      if (!Array.isArray(a)) return;
      if (isLatLngPair(a)) { b.extend([a[1], a[0]]); return; }  // [lng,lat] → [lat,lng]
      a.forEach(walk);
    })(coords);
    return b;
  }

  // Отдельная панель для VG-слоёв, z=450 — ВЫШЕ overlay-панели (400), где сидит
  // canvas дефолтного рендерера карты (preferCanvas/renderer:L.canvas), и НИЖЕ
  // маркеров (600). Без этого overlay-canvas карты, лежащий поверх VG-тайлов,
  // перехватывал бы DOM-клики и SVG-тайлы VG их не получали бы (найдено вживую).
  function ensureVGPane() {
    if (!map.getPane('vectorTiles')) {
      const p = map.createPane('vectorTiles');
      p.style.zIndex = 450;
    }
    return 'vectorTiles';
  }

  function buildVectorGridGroup(st, data) {
    const meta = st.meta;
    const isPolygon = meta.type === 'polygon';
    // Полигоны — крупные раньше, чтобы мелкие/вложенные оказались ПОЗЖЕ в массиве
    // и, значит, сверху (SVG рисует и хит-тестит последние поверх ранних) — иначе
    // большой полигон (напр. «Сахалинская область») перекрывает районы и клик
    // всегда попадает в него. Тот же приём, что в классическом buildVectorGroup
    // (decorate-sort-undecorate, площадь считаем один раз). Линии не сортируем.
    // polygonArea рассчитан на мульти-структуру [часть][контур]; на одиночном
    // полигоне [контур][точка] (УчасткиДороги) даёт NaN — коэрсим в 0, чтобы sort
    // не ловил NaN (такие слои обычно не вложены, порядок между ними неважен).
    const items = isPolygon
      ? data.filter(o => o.dots).map(o => ({ o, area: polygonArea(o.dots) || 0 }))
            .sort((a, b) => b.area - a.area).map(x => x.o)
      : data.filter(o => o.dots);

    const features = [];
    const byObjId = new Map();     // objId → { fid, bounds }
    items.forEach((obj, i) => {
      const fid = i + 1;           // уникальный числовой id фичи для setFeatureStyle
      const geometry = dotsToGeometry(obj.dots, isPolygon);   // тип по фактической глубине dots
      if (geometry == null) return;   // пустая/битая геометрия — иначе geojson-vt падает в simplify
      features.push({
        type: 'Feature',
        properties: { fid, objId: obj.id, name: obj.name || '', color: obj.color || meta.color, dashArray: obj.dashArray || null },
        geometry
      });
      byObjId.set(obj.id, { fid, bounds: coordsBounds(geometry.coordinates) });
    });

    const styleFn = props => isPolygon
      ? { weight: 2, color: props.color, fill: true, fillColor: props.color, fillOpacity: 0.12, dashArray: props.dashArray || undefined }
      : { weight: 4, color: props.color, opacity: 0.85 };

    const vg = L.vectorGrid.slicer({ type: 'FeatureCollection', features }, {
      // SVG-тайлы (не canvas): VectorGrid's L.canvas.tile НЕ порождает событие
      // click (только hover) — проверено вживую; L.svg.tile даёт нативный DOM-клик
      // по путям. Тайлинг/отсечение по вьюпорту/упрощение по зуму сохраняются.
      rendererFactory: L.svg.tile,
      pane: ensureVGPane(),               // поверх overlay-canvas карты, см. ensureVGPane
      interactive: true,
      getFeatureId: f => f.properties.fid,
      // maxZoom нарезки geojson-vt должен покрывать все зумы карты, иначе на
      // зумах выше него тайлы не генерируются и слой «пропадает».
      maxZoom: map.getMaxZoom(),
      vectorTileLayerStyles: { sliced: styleFn }
    });
    vg._byObjId = byObjId;      // маркер VG-группы + таблица для выбора/центрирования
    vg._isPolygon = isPolygon;

    vg.on('click', e => {
      const p = e.layer && e.layer.properties;
      if (p) selectObject(meta.id, p.objId);
      if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
    });
    vg.on('mouseover', e => {
      const p = e.layer && e.layer.properties;
      if (p && p.name) showVGTooltip(p.name, e.latlng);
    });
    vg.on('mouseout', hideVGTooltip);
    return vg;
  }

  // Настоящий VG-слой внутри g — сам g, если это VectorGrid-группа (несёт
  // ._byObjId), либо, для RoadZoomFilterLayer (см. выше), его текущий
  // this._innerGroup, если ТОТ является VG-группой (vectorTilesLines может
  // быть выключен — тогда обёртка держит классический L.layerGroup, и это
  // не VG вовсе). Раньше isVGGroup() проверял ._byObjId прямо на st.group —
  // для обёрнутого слоя (АвтомобильныеДороги) это всегда было false, даже
  // когда внутренний слой был VectorGrid-ом: клик по дороге не подсвечивался,
  // а «Показать на карте» был no-op (найдено вживую, см. историю задачи).
  function vgLayerOf(g) {
    if (g && g._byObjId) return g;
    if (g && g._innerGroup && g._innerGroup._byObjId) return g._innerGroup;
    return null;
  }
  function isVGGroup(g) { return !!vgLayerOf(g); }

  // Тултип для VectorGrid-слоёв: один общий L.tooltip, позиционируется в точке
  // наведения (у VG нет пофигурного bindTooltip). Класс/смещение — как у обычных
  // векторных тултипов (см. bindObject / css .map-tip).
  function showVGTooltip(text, latlng) {
    if (!vgTooltip) vgTooltip = L.tooltip({ className: 'map-tip', direction: 'left', offset: [-10, -10], opacity: 0.8 });
    vgTooltip.setContent(text).setLatLng(latlng);
    if (!map.hasLayer(vgTooltip)) vgTooltip.addTo(map);
  }
  function hideVGTooltip() { if (vgTooltip && map.hasLayer(vgTooltip)) map.removeLayer(vgTooltip); }

  // Подсветка выбранной фичи в VG-слое (аналог highlightVector для обычных
  // векторов) — через setFeatureStyle по fid; снимается resetFeatureStyle.
  function highlightVGFeature(group, objId, geomType) {
    clearVectorSelection();
    const rec = group._byObjId.get(objId);
    if (!rec) return;
    selectedVG = { group, fid: rec.fid };
    const isPoly = geomType === 'polygon';
    group.setFeatureStyle(rec.fid, {
      color: SELECT_COLOR,
      weight: (isPoly ? 2 : 4) + 3,
      opacity: 1,
      fill: isPoly,
      fillColor: SELECT_COLOR,
      fillOpacity: isPoly ? 0.2 : 0,
      dashArray: undefined
    });
  }

  // Точечный слой без кластеризации (meta.cluster === false, см.
  // buildVectorGroupInner) — единственный оставшийся canvas-путь:
  // buildPointMarker() рисует его маркеры прямо на общем canvas-рендерере
  // (CanvasIconMarker/L.circleMarker — см. её саму), не DOM-узлами.
  //
  // Эти маркеры делят один canvas-рендерer с полигонами/линиями
  // (getCanvasIconRenderer) — слой, включённый ПОСЛЕ них, иначе рисовался бы
  // поверх (общий рендерer красит фигуры в порядке добавления). CanvasPointGroup
  // возвращает свои маркеры наверх сама — один раз сразу после своего
  // добавления, и заново на каждое добавление ЛЮБОГО ДРУГОГО слоя, пока сама
  // на карте (activeCanvasPointGroups + 'layeradd' в init()) — тот же приём,
  // что раньше был у PointClusterManager.bringToFront(), просто не завязанный
  // на один синглтон: активных canvas-точечных слоёв теперь может быть
  // несколько одновременно (Автобусы+Остановки, и т.п.).
  const activeCanvasPointGroups = new Set();
  // Подавляет реакцию 'layeradd' на добавление СОБСТВЕННЫХ маркеров группы —
  // L.LayerGroup.onAdd добавляет их на карту по одному, каждый бы иначе сам
  // вызывал bringToFront() по всем активным canvas-группам — O(n) на маркер,
  // то есть O(n²) на один toggle. bringToFront() после — уже вне подавления.
  let suppressBringToFront = false;

  const CanvasPointGroup = L.LayerGroup.extend({
    onAdd(map) {
      suppressBringToFront = true;
      try {
        L.LayerGroup.prototype.onAdd.call(this, map);
      } finally {
        suppressBringToFront = false;
      }
      activeCanvasPointGroups.add(this);
      this.bringToFront();
    },
    onRemove(map) {
      activeCanvasPointGroups.delete(this);
      L.LayerGroup.prototype.onRemove.call(this, map);
    },
    bringToFront() {
      this.eachLayer(l => l.bringToFront && l.bringToFront());
      return this;
    }
  });

  function buildPointGroup(meta, data) {
    const group = new CanvasPointGroup();
    data.forEach(obj => {
      const marker = buildPointMarker(meta, obj);
      bindObject(marker, meta.id, obj);
      group.addLayer(marker);
    });
    return group;
  }

  // Радиус кластеризации (в пикселях экрана) для настоящего
  // L.markerClusterGroup — см. ensureRealMarkerCluster ниже. ТА ЖЕ формула,
  // что GetRadius() у нативной карты АА-проекта (CommonTemplates/Map_js), где
  // она передаётся как maxClusterRadius в L.MarkerClusterGroup: 225 - zoom*10
  // — чем крупнее зум, тем МЕНЬШЕ радиус (объекты физически ближе друг к
  // другу на экране на крупном зуме, чтобы всё ещё слиться в один кластер).
  // На zoom=0 → 225px, на zoom=18 (обычный maxZoom этого приложения) → 45px.
  // Пол в 20px — страховка: у нативной формулы его нет, но она уходит в
  // отрицательные числа при zoom>22, бессмысленно для радиуса кластеризации.
  function crossLayerClusterRadius(zoom) {
    return Math.max(20, 225 - zoom * 10);
  }

  // pie-chart иконка кластера — доли по ЦВЕТУ ОБЪЕКТА (obj.idCluster —
  // тяжесть/статус внутри слоя; у слоёв без idCluster — meta.color слоя как
  // единственная "доля"), а не по тому, из какого слоя пришла точка. Разметка
  // и CSS-классы (.customCluster/.customChart/.unit/.text) — байт-в-байт из
  // нативной карты АА-проекта (CommonTemplates/Map_js:
  // MarkerGroup.iconCreateFunction, Clusters_Ruler_css/Ext/Template.txt) —
  // намеренно НЕ переименованы и не подстроены, чтобы не потерять точное
  // визуальное соответствие; стили — см. css/styles.css. Принимает готовый
  // массив цветов (не {obj,meta}-объекты) — см. её единственный вызов в
  // ensureRealMarkerCluster ниже.
  function buildClusterPieHtml(colors) {
    const info = new Map(); // color -> count
    colors.forEach(color => info.set(color, (info.get(color) || 0) + 1));
    let offset = 0, circles = '';
    info.forEach((count, color) => {
      const percent = Math.round(count / colors.length * 100);
      circles += `<circle class="unit" r="15.9" cx="50%" cy="50%" stroke="${color}" `
               + `stroke-dasharray="${percent} 100" stroke-dashoffset="${-offset}"></circle>`;
      offset += percent;
    });
    return `<div class="customCluster"><svg class="customChart" width="50" height="50" viewBox="0 0 50 50">${circles}</svg>`
         + `<div class="text">${colors.length}</div></div>`;
  }

  // =====================================================================
  //  Настоящий Leaflet.markercluster — точечные слои БЕЗ canvas-иконки
  // =====================================================================
  // Один общий singleton L.markerClusterGroup для ВСЕ точечные слои с
  // `cluster !== false` (см. buildVectorGroupInner) — независимо от того,
  // есть ли у слоя своя пиктограмма (BackendPlugin.canvasIcons/pointIconShapes) или нет;
  // buildPointMarker() строит для них обычный L.marker + L.icon в обоих
  // случаях (см. её саму — canvas-путь там используется только при
  // meta.cluster === false). Иконка кластера — pie-chart (buildClusterPieHtml
  // выше), доли по цвету объекта; радиус — crossLayerClusterRadius, тот же
  // GetRadius нативной карты АА-проекта (CommonTemplates/Map_js, где она
  // передаётся как maxClusterRadius её единственному this.MarkerGroup).
  //
  // (История: до 2026-08-04 canvas-иконка/`cluster`-флаг решали независимо —
  // POINT_ICON_SHAPES/CANVAS_ICONS-слои всегда шли в отдельный сеточный
  // clustered-canvas менеджер, PointClusterManager, даже когда `cluster` был
  // true; до 2026-08-03 у каждого точечного слоя вообще был свой отдельный
  // кластер. Оба подхода убраны — весь PointClusterManager и его сеточный
  // алгоритм больше не нужны: любой слой с `cluster !== false` идёт сюда,
  // любой с `cluster === false` — на canvas без кластеризации вовсе
  // (buildPointGroup, выше). См. git-историю файла за деталями отменённых
  // подходов, если понадобится.)
  let realMarkerCluster = null;

  function ensureRealMarkerCluster() {
    if (!realMarkerCluster) {
      realMarkerCluster = L.markerClusterGroup({
        maxClusterRadius: crossLayerClusterRadius,
        // По просьбе — плагин по умолчанию анимирует слияние/разлёт кластеров
        // и spiderfy (animate:true); здесь отключено, в отличие от нативной
        // карты АА-проекта (она эту опцию не переопределяет).
        animate: false,
        // Плагин по умолчанию грузит addLayers() синхронно за один проход —
        // на большом кластеризуемом слое (напр. ДТП в несколько тысяч
        // объектов) это блокировало бы поток на весь toggle. true разбивает
        // добавление на чанки по 200 маркеров между кадрами (см. её же
        // addLayers()) — то же, что было у удалённого buildPointCluster()
        // до объединения в один shared-кластер.
        chunkedLoading: true,
        iconCreateFunction(cluster) {
          const colors = cluster.getAllChildMarkers().map(m => m.options.clusterColor);
          return L.divIcon({ className: 'icon', iconSize: L.point(50, 50), html: buildClusterPieHtml(colors) });
        }
      });
      map.addLayer(realMarkerCluster); // единственный на всю сессию
    }
    return realMarkerCluster;
  }

  // Тонкий L.Layer-хэндл на точечный слой (`cluster !== false`) — сам ничего
  // не рисует, только строит свои маркеры и регистрирует/снимает их в общем
  // realMarkerCluster при onAdd/onRemove. Благодаря этому toggleLayer и весь
  // код, что трогает st.group (closeAllTooltips/findLayer — оба зовут
  // st.group.eachLayer), работает без изменений, не зная, что "слой" на
  // самом деле не рисует сам себя. Хранит свои маркеры собственным массивом
  // (не через общий Map по objId) — плагин сам ведёт учёт и
  // кластеризацию/culling внутри addLayers()/removeLayers().
  const RealMarkerLayerHandle = L.Layer.extend({
    initialize(id, meta, data) {
      this._id = id; this._meta = meta; this._data = data; this._markers = null;
    },
    onAdd() {
      const cluster = ensureRealMarkerCluster();
      this._markers = this._data.map(obj => {
        const marker = buildPointMarker(this._meta, obj);
        marker.options.clusterColor = obj.idCluster || obj.color || this._meta.color;
        bindObject(marker, this._id, obj);
        return marker;
      });
      cluster.addLayers(this._markers); // bulk-метод — не addLayer() в цикле, см. "Производительность" про chunkedLoading
    },
    onRemove() {
      if (realMarkerCluster && this._markers) realMarkerCluster.removeLayers(this._markers);
      this._markers = null;
    },
    // Свои маркеры уже отдельным массивом — findLayer() ищет именно в
    // пределах вызвавшего слоя, и это ровно то, что нужно, без какой-либо
    // специальной развязки в closeAllTooltips().
    eachLayer(fn, ctx) {
      if (this._markers) this._markers.forEach(m => fn.call(ctx, m));
      return this;
    }
  });

  // =====================================================================
  //  Canvas-иконки для больших точечных слоёв
  // =====================================================================
  // Вместо DOM-маркера (L.marker + L.divIcon) рисуем картинку прямо на
  // canvas — при сотнях объектов на экране это заметно дешевле (нет DOM-узла
  // на каждую точку, см. README "Производительность"). Визуально — та же
  // картинка, что была бы в divIcon, просто рисуется иначе.
  //
  // Чтобы добавить canvas-иконку для нового точечного слоя:
  //   1. Прописать её в BackendPlugin.canvasIcons (см. js/backends/<id>.js) —
  //      id слоя → { src, width, height, anchorX, anchorY } (anchorX/anchorY —
  //      точка картинки в пикселях от её левого верхнего угла, которая должна
  //      совпадать с гео-точкой; для «капли», как раньше в divIcon, это низ
  //      по центру).
  //   2. Больше ничего в ядре — buildPointMarker() сам подхватит слой из
  //      реестра плагина, картинка предзагрузится один раз при первом
  //      включении слоя (см. ensureCanvasIconsLoaded() в toggleLayer).
  // Сам реестр (было CANVAS_ICONS, локальная константа здесь) переехал в
  // BackendPlugin.canvasIcons 2026-08-24 — ядро больше не знает состав
  // canvas-иконок ни одного конкретного бэкенда.
  // Ограничение: _updatePath здесь рисует ровно одну картинку на объект —
  // если когда-нибудь понадобится наложение (иконка + бейдж/точка статуса,
  // как раньше было у «Автобусы»), этот механизм не подходит без доработки,
  // проще остаться на обычном L.divIcon (см. pointIcon()).
  //
  // ВАЖНО: L.CircleMarker (не Marker) — Leaflet.markercluster умеет
  // кластеризовать только настоящие L.Marker. Поэтому CanvasIconMarker
  // (ниже) используется, только когда слой НЕ кластеризуется
  // (`meta.cluster === false`, см. buildPointMarker) — при `cluster !== false`
  // buildPointMarker строит для этой же картинки обычный L.marker + L.icon
  // вместо CanvasIconMarker, чтобы слой можно было добавить в
  // ensureRealMarkerCluster().
  //
  // ВАЖНО: реализовано через переопределение приватного _updatePath у
  // L.CircleMarker (см. lib/leaflet.js: CircleMarker.prototype._updatePath
  // вызывает renderer._updateCircle(this) — здесь вместо этого рисуем
  // картинку). Это устоявшийся в экосистеме Leaflet-плагинов приём, но не
  // публичный API — при обновлении vendored lib/leaflet.js стоит перепроверить,
  // что сигнатура не изменилась.
  const canvasIconLoading = {}; // src -> Promise<HTMLImageElement>
  const canvasIconReady   = {}; // src -> HTMLImageElement (после загрузки)

  function loadCanvasIcon(src) {
    if (!canvasIconLoading[src]) {
      canvasIconLoading[src] = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => { canvasIconReady[src] = img; resolve(img); };
        img.onerror = reject;
        img.src = src;
      });
    }
    return canvasIconLoading[src];
  }

  // Дожидается загрузки canvas-иконки слоя (если она ему нужна) — вызывать
  // до построения маркеров, чтобы buildPointMarker() не увидел undefined.
  function ensureCanvasIconsLoaded(layerId) {
    const def = BackendPlugin.canvasIcons[layerId];
    return def ? loadCanvasIcon(def.src) : Promise.resolve();
  }

  // dot — формат 1С для точечных слоёв (см. Каталог.*.ЗаполнитьСведенияДляКарты):
  // тройная вложенность [[[lat,lng]]] (как у addPolygon/FigureType 2 в нативной
  // карте — arrayPoint[0][0]), а не плоская пара — отсюда индексация ниже.
  function pointCoords(obj) {
    return obj.dot[0][0];
  }

  // Canvas-иконкам нужен именно canvas-рендерер (их _updatePath рисует картинку
  // в renderer._ctx) — SVG-рендерер такого контекста не даёт вовсе.
  //
  // ИСТОРИЯ ПРАВКИ (2026-08-03, дважды): сначала иконки рисовались в ОБЩИЙ
  // (единственный, преф-canvas) рендерер карты — правильно по кликам, но
  // полигон, чей canvas добавлен в DOM позже (порядок переключения слоёв не
  // гарантирован), визуально перекрывал иконки под собой. "Починили" отдельной
  // панелью 'canvasIcons' на z-index 550 (между overlayPane 400 и markerPane
  // 600) — но каждый L.Canvas это СВОЙ ОТДЕЛЬНЫЙ canvas-элемент СО СВОИМ
  // СОБСТВЕННЫМ click-листенером (см. lib/leaflet.js: Canvas._initContainer —
  // слушает клик на this._container, т.е. именно на своём <canvas>, а не на
  // контейнере карты). Browser-хиттестинг клика достаётся ТОЛЬКО самому
  // верхнему DOM-элементу в точке клика — если "верхний" canvas ничего не
  // нашёл под курсором (клик пришёлся на полигон ПОД ним, не на маркер), клик
  // просто пропадает: он физически не долетает до другого, более низкого
  // canvas-элемента с полигонами, тот его вообще не увидит. Отдельная панель
  // чинила видимость ценой всех кликов по полигонам/линиям, стоило появиться
  // хоть одному включённому точечному слою — баг обнаружен 2026-08-03.
  //
  // Правильное решение — ОБЩИЙ рендерер (map.getRenderer(...) без указания
  // layer.options.pane/renderer возвращает/создаёт ОДИН на всю карту canvas,
  // тот же самый, что использует buildVectorGroup для полигонов/линий): один
  // canvas-элемент, один click-листенер, единый список отрисовки — Leaflet
  // сам корректно хит-тестит клик против ВСЕХ фигур на этом рендерере, в т.ч.
  // полигон, если маркер оказался не точно под курсором. Видимость (маркеры
  // всегда поверх полигонов) обеспечивается уже не панелью, а явным
  // bringToFront() — см. CanvasPointGroup выше (buildPointGroup) и её вызов
  // на каждое собственное добавление и на 'layeradd' любого другого слоя
  // (map.on в init()). Свой отдельный canvas остаётся только для случая,
  // когда MapConfig.perf.preferCanvas выключен (SVG) — тогда общий рендерер
  // карты сам SVG, без ._ctx, куда наш _updatePath рисовать не может.
  let canvasIconRenderer = null;
  function getCanvasIconRenderer() {
    if (canvasIconRenderer) return canvasIconRenderer;
    if (!MapConfig.perf || MapConfig.perf.preferCanvas !== false) {
      // Пробный маркер не добавляется на карту — нужен только чтобы прочитать
      // через него общий рендерер (map.getRenderer читает layer.options.pane/
      // .renderer, у обычного L.circleMarker оба не заданы).
      canvasIconRenderer = map.getRenderer(L.circleMarker([0, 0]));
    } else {
      canvasIconRenderer = L.canvas({ padding: 0.5 });
    }
    return canvasIconRenderer;
  }

  const CanvasIconMarker = L.CircleMarker.extend({
    _updatePath() {
      const renderer = this._renderer;
      const { image, width, height, anchorX, anchorY } = this.options;
      if (!renderer || !renderer._drawing || this._empty() || !image) return;
      renderer._ctx.drawImage(image, this._point.x - anchorX, this._point.y - anchorY, width, height);
    },
    // Точный прямоугольный hit-test картинки вместо круга по умолчанию.
    _containsPoint(p) {
      const { width, height, anchorX, anchorY } = this.options;
      const o = this._point;
      return p.x >= o.x - anchorX && p.x <= o.x - anchorX + width
          && p.y >= o.y - anchorY && p.y <= o.y - anchorY + height;
    },
    // Картинка для BackendPlugin.pointIconShapes догружается асинхронно (см. buildPointMarker) —
    // при первой отрисовке конкретного цвета её ещё может не быть в кэше. Когда
    // подгрузится, ставим и перерисовываем — тот же приём, что и в нативной карте
    // АА-проекта (CommonTemplates/Map_js: CanvasIconMarker.setIcon).
    setImage(img) {
      this.options.image = img;
      this.redraw();
    }
  });

  // =====================================================================
  //  Векторные пиктограммы (SVG-шаблон с #ЦветФона на слой)
  // =====================================================================
  // В отличие от canvasIcons (одна статичная картинка на весь слой), у слоёв
  // из BackendPlugin.pointIconShapes цвет пиктограммы свой у КАЖДОГО объекта
  // (obj.idCluster/obj.color с сервера) — поэтому не одна картинка, а ОДИН
  // SVG-шаблон на слой с плейсхолдером цвета; конкретная перекрашенная
  // картинка собирается на лету здесь, в ядре (getColoredIconSrc ниже —
  // дешёвая строковая замена + data-URI, без сети, кэш по паре (слой, цвет),
  // а не по объекту — цветов на весь слой обычно единицы). Сам реестр шаблонов
  // (было POINT_ICON_SHAPES, локальная константа здесь, конкретно под ДТП/
  // Дислокации/ОбъектыНаКарте accident-analysis) переехал в
  // BackendPlugin.pointIconShapes 2026-08-24 — см. его файл (js/backends/<id>.js)
  // за самими SVG-путями и разбором, почему именно эти формы/цвета выбраны;
  // ядро здесь не знает состав пиктограмм ни одного конкретного бэкенда,
  // только формат записи реестра ({placeholder, width, height, anchorX,
  // anchorY, svg}) и как её применить.
  const coloredIconSrcCache = {}; // "слой|цвет" -> готовая data-URI строка (чистая подстановка, без сети)

  // Перекрашивает SVG-шаблон слоя под конкретный цвет объекта и отдаёт data-URI,
  // готовый для Image.src — с кэшем по (слой, цвет), а не по объекту: разных
  // цветов на слой обычно единицы (градации тяжести/статуса), а не по одному
  // на каждый ДТП/Дислокацию.
  function getColoredIconSrc(layerId, shapeDef, color) {
    const key = layerId + '|' + color;
    let src = coloredIconSrcCache[key];
    if (!src) {
      const svg = shapeDef.svg.split(shapeDef.placeholder).join(color);
      src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      coloredIconSrcCache[key] = src;
    }
    return src;
  }

  // Canvas-иконка только когда слой НЕ кластеризуется (`meta.cluster ===
  // false`) — при кластеризации маркеры обязаны быть настоящими L.marker,
  // чтобы попасть в ensureRealMarkerCluster() (см. её и dispatch в
  // buildVectorGroupInner). Признак один и тот же для всех веток ниже
  // (картинка с сервера/пиктограмма/статичная картинка/обычная точка) — canvas при
  // `cluster === false`, иначе реальный L.marker с той же картинкой/цветом.
  function buildPointMarker(meta, obj) {
    const canvas = meta.cluster === false;

    // Картинка объекта с сервера (GET /icons, см. init) — та же, что берёт нативная
    // карта 1С (Map_js: iconSet[el.img]): грузовик/автобус/уборочная по типу работ у
    // ТС, статус у заявки, вид знака и т.п. Главнее пиктограмм плагина — те остаются
    // запасным вариантом для img, которого в наборе нет. Квадрат SERVER_ICON_SIZE с
    // якорем в центре (как NiconHost в Map_js); azimuth поворачивает картинку, как
    // rotationAngle у нативного маркера.
    const serverSrc = obj.img && serverIcons[obj.img];
    if (serverSrc) {
      const size = SERVER_ICON_SIZE;
      if (!canvas) {
        const az = Number(obj.azimuth);
        const icon = az
          ? L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
              html: `<img src="${serverSrc}" width="${size}" height="${size}" style="display:block;transform:rotate(${az}deg)">` })
          : L.icon({ iconUrl: serverSrc, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
        return L.marker(pointCoords(obj), { icon });
      }
      // canvas-ветка (cluster:false) без поворота — CanvasIconMarker его не умеет;
      // у «Чистых дорог» cluster:false не бывает, так что это только страховка.
      const marker = new CanvasIconMarker(pointCoords(obj), {
        renderer: getCanvasIconRenderer(),
        radius: size / 2,
        image: canvasIconReady[serverSrc],
        width: size, height: size, anchorX: size / 2, anchorY: size / 2
      });
      if (!canvasIconReady[serverSrc]) loadCanvasIcon(serverSrc).then(img => marker.setImage(img));
      return marker;
    }

    const shapeDef = BackendPlugin.pointIconShapes[meta.id];
    if (shapeDef) {
      const color = obj.idCluster || obj.color || meta.color;
      const src = getColoredIconSrc(meta.id, shapeDef, color);
      if (!canvas) {
        // L.icon грузит data-URI сам — отдельная догрузка через
        // loadCanvasIcon()/canvasIconReady (нужна для CanvasIconMarker ниже)
        // здесь не требуется.
        return L.marker(pointCoords(obj), {
          icon: L.icon({ iconUrl: src, iconAnchor: [shapeDef.anchorX, shapeDef.anchorY],
            iconSize: [shapeDef.width, shapeDef.height] })
        });
      }
      const marker = new CanvasIconMarker(pointCoords(obj), {
        renderer: getCanvasIconRenderer(),
        radius: Math.max(shapeDef.width, shapeDef.height) / 2,
        image: canvasIconReady[src],
        width: shapeDef.width, height: shapeDef.height,
        anchorX: shapeDef.anchorX, anchorY: shapeDef.anchorY
      });
      // Этот конкретный цвет мог ещё не встречаться — картинка догружается
      // асинхронно (parse на inline data-URI, без сети, обычно доли мс) и
      // перерисовывается, когда готова; до этого момента маркер просто пуст.
      if (!canvasIconReady[src]) {
        loadCanvasIcon(src).then(img => marker.setImage(img));
      }
      return marker;
    }

    const iconDef = BackendPlugin.canvasIcons[meta.id];
    if (iconDef) {
      if (!canvas) {
        return L.marker(pointCoords(obj), {
          icon: L.icon({ iconUrl: iconDef.src, iconAnchor: [iconDef.anchorX, iconDef.anchorY],
            iconSize: [iconDef.width, iconDef.height] })
        });
      }
      return new CanvasIconMarker(pointCoords(obj), {
        renderer: getCanvasIconRenderer(),
        radius: Math.max(iconDef.width, iconDef.height) / 2, // грубая оценка для отсечения за пределами экрана
        image: canvasIconReady[iconDef.src],
        width: iconDef.width, height: iconDef.height,
        anchorX: iconDef.anchorX, anchorY: iconDef.anchorY
      });
    }

    // Обычная точка без пиктограммы — при кластеризации настоящий L.marker
    // с divIcon-точкой (pointIcon(), как раньше); без кластеризации родной
    // L.circleMarker (канвас-рендер "из коробки", без картинки — не нужен
    // ни CanvasIconMarker, ни отдельная загрузка).
    if (canvas) {
      return L.circleMarker(pointCoords(obj), {
        radius: 6, weight: 2, color: '#fff',
        fillColor: obj.color || meta.color, fillOpacity: 1
      });
    }
    return L.marker(pointCoords(obj), { icon: pointIcon(meta, obj) });
  }

  function buildHeat(data) {
    // maxCount приходит от бэкенда (Безбилетники.ДанныеДляСлоя) — одно и то же
    // значение на всех точках, максимум по вошедшим среди всех отдаваемых
    // остановок, тот же максимум, что использует и нативная карта в 1С.
    const max = Math.max(1, ...data.map(d => d.maxCount || d.count));
    const points = data.map(d => [d.lat, d.lng, d.count / max]);
    return L.heatLayer(points, {
      radius: 26, blur: 20,
      // maxZoom здесь — не "максимальный зум слоя", а зум, НИЖЕ которого
      // Leaflet.heat начинает экспоненциально гасить интенсивность точек
      // (f = 1/2^(maxZoom - zoom), см. map/lib/leaflet-heat.js: _redraw).
      // При maxZoom:17 на обзорном масштабе города (~zoom 9-12) f падает до
      // 1/32..1/256 — очаги гаснут до почти прозрачного цвета, хотя данные
      // те же, что и в 1С. Нативная тепловая карта в 1С использует другой
      // плагин (heatmap.js/HeatmapOverlay, радиус в градусах, без затухания
      // по зуму) — этого эффекта там нет. Ставим maxZoom в 1, чтобы множитель
      // всегда был равен 1 на любом реальном уровне зума, как в 1С.
      maxZoom: 1,
      gradient: { 0.2: '#2b83ba', 0.45: '#abdda4', 0.7: '#fdae61', 1.0: '#d7191c' }
    });
  }

  // Запасной вариант для точечного слоя без записи в BackendPlugin.canvasIcons —
  // обычный L.divIcon с цветной точкой (см. buildPointMarker()).
  function pointIcon(meta, obj) {
    const color = obj.color || meta.color;
    const size = 16;
    return L.divIcon({ className: '', iconSize:[size,size], iconAnchor:[size/2,size/2],
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff"></div>` });
  }

  function bindObject(lyr, layerId, obj, geomType) {
    lyr._objId = obj.id;
    // name — формат 1С (см. Каталог.*.ЗаполнитьСведенияДляКарты): текстовая
    // подсказка объекта на нативной карте тоже строится из этого поля.
    // direction:'left' + offset:[-10,-10] + opacity:0.8 — тот же приём, что и
    // в нативной 1С-карте АнализАварийности (CommonTemplates/Map_js,
    // Map.prototype.addPolygon), подсказка встаёт сбоку от объекта, а не
    // прямо над/в центре него.
    if (obj.name) {
      const tooltipOptions = { className: 'map-tip', direction: 'left', offset: [-10, -10], opacity: 0.8 };
      if (geomType === 'polygon') {
        // Полигоны — подсказка зафиксирована у центра фигуры (без sticky
        // Leaflet сам открывает тултип в getCenter() слоя), а не бежит за
        // курсором по всей площади — иначе на большом полигоне непонятно,
        // к чему она относится.
        lyr.bindTooltip(obj.name, tooltipOptions);
      } else {
        // Линии (маршруты, треки) — подсказка следует за курсором (sticky),
        // а не садится в одну точку всей линии — иначе непонятно, к какому
        // участку она относится. У точечных маркеров курсор и так рядом с
        // объектом (isVector здесь всегда false для них — lyr.getLatLng есть).
        const isVector = !lyr.getLatLng;
        lyr.bindTooltip(obj.name, { ...tooltipOptions, sticky: isVector });
      }
    }
    lyr.on('click', () => selectObject(layerId, obj.id));
  }

  // ---- выделение векторного объекта (аналог SetSelectionStyle в 1С) -----
  // geomType намеренно не bringToFront() для полигонов: buildVectorGroup сортирует
  // полигоны при построении слоя (крупные раньше, мелкие позже → мелкие вложенные
  // административные единицы оказываются сверху и остаются кликабельными, см. её
  // комментарий). bringToFront() для ЛЮБОГО выбранного полигона ломает этот порядок
  // навсегда: как только пользователь кликает по крупной фигуре (после того как уже
  // выбирал вложенную мелкую), крупная встаёт поверх всех и с этого момента навсегда
  // перекрывает мелкую — повторный клик по мелкой снова попадает в крупную. Для линий
  // (маршруты/треки) это не проблема — там нет вложенности одна в другую по смыслу,
  // а видеть выбранный маршрут поверх остальных полезно.
  function highlightVector(lyr, geomType) {
    if (selectedVector === lyr) return;
    clearVectorSelection();
    selectedVector = lyr;
    lyr._origStyle = {
      color:       lyr.options.color,
      weight:      lyr.options.weight,
      opacity:     lyr.options.opacity,
      fillOpacity: lyr.options.fillOpacity,
      dashArray:   lyr.options.dashArray
    };
    lyr.setStyle({
      color:   SELECT_COLOR,
      weight:  (lyr.options.weight || 4) + 3,
      opacity: 1,
      dashArray: null
    });
    if (geomType !== 'polygon' && lyr.bringToFront) lyr.bringToFront();
    // Подсветка участков без маршрута у выбранного трека (аналог
    // SetTrackNoRouteSelectionStyle в нативной карте 1С, Карта_Map_js) —
    // перекрашиваем оверлей и поднимаем его поверх ПОСЛЕ основной линии,
    // иначе утолщённая (weight+3) выделенная линия перекроет его. Толщину
    // оверлея не трогаем — тонкий пурпурный поверх толстой синей как раз и
    // отличает "без маршрута" участки выбранного трека от красных участков
    // соседних треков.
    if (lyr.noRouteLayer) {
      lyr.noRouteLayer.setStyle({ color: '#AA226F', opacity: 1 });
      if (lyr.noRouteLayer.bringToFront) lyr.noRouteLayer.bringToFront();
    }
  }

  function clearVectorSelection() {
    if (selectedVector && selectedVector._origStyle && selectedVector.setStyle) {
      selectedVector.setStyle(selectedVector._origStyle);
    }
    // Защита от отсутствия noRouteLayer: весь трек без разрывов маршрута,
    // опция выключена, либо выделен не трек, а маршрут/полигон.
    if (selectedVector && selectedVector.noRouteLayer && selectedVector.noRouteLayer._origStyle) {
      selectedVector.noRouteLayer.setStyle(selectedVector.noRouteLayer._origStyle);
    }
    selectedVector = null;
    if (selectedVG) {
      try { selectedVG.group.resetFeatureStyle(selectedVG.fid); } catch (e) { /* слой мог быть уже снят */ }
      selectedVG = null;
    }
  }

  // =====================================================================
  //  Воспроизведение трека
  // =====================================================================
  // Анимация маркера "Автобусы" вдоль уже загруженных координат трека — без
  // отдельного похода на сервер: кликнуть по треку и увидеть эти кнопки можно
  // только когда слой "Треки" уже включён, а значит его данные (GET
  // /layer/Треки) уже лежат в layerState — координаты уже в памяти, в самом
  // Leaflet-объекте линии (см. findLayer ниже). Длительность на точку —
  // просто 1000/скорость мс, как и на стороне 1C (Справочники.Треки.
  // ДанныеДляВоспроизведенияТрека), только посчитано на клиенте, а не
  // запрошено с сервера.
  let playbackToken = 0;
  let playbackMarker = null;

  // Какие слои умеют воспроизведение — флаг playback:true в метаданных слоя из
  // /layers (его шлёт, например, clean-roads) либо id в BackendPlugin.trackPlayback.
  // layers. Раньше ядро узнавало такой слой по захардкоженному id 'Треки'.
  function isPlaybackLayer(meta) {
    if (!meta) return false;
    const cfg = BackendPlugin.trackPlayback || {};
    return meta.playback === true || (cfg.layers || []).includes(meta.id);
  }

  // Картинка маркера воспроизведения — BackendPlugin.trackPlayback.icon (та же
  // форма { src, width, height, anchorX, anchorY }, что у canvasIcons). Раньше —
  // захардкоженная canvasIcons['Автобусы']; у плагина без неё (clean-roads) это
  // роняло воспроизведение на iconDef.width. Без картинки — обычный кружок.
  function playbackIconDef() {
    return (BackendPlugin.trackPlayback || {}).icon || null;
  }

  // Точки трека в порядке движения. L.Polyline.getLatLngs() у линии с
  // несколькими "участками" (см. АнгелКартографияВнешнееAPI.ДанныеСлояТреки)
  // возвращает вложенный по участкам массив — сплющиваем в один маршрут.
  // Стык участков дублирует координату (см. РасчетДетальныхДанныхТрековВызовСервера.
  // ФормированиеТрекаИзКоординат: "первая координата участка = предыдущая
  // координата") — соседние повторы схлопываем, чтобы не тратить кадр
  // анимации на слайд длиной в 0 метров.
  function trackPoints(layerId, objId) {
    const target = findLayer(layerId, objId);
    if (!target || !target.getLatLngs) return [];

    const flat = target.getLatLngs().flat(Infinity);
    return flat.filter((p, i) => i === 0 || !p.equals(flat[i - 1]));
  }

  async function playTrack(layerId, objId, speed) {
    stopTrackPlayback();

    const points = trackPoints(layerId, objId);
    if (points.length < 2) return;

    const token = ++playbackToken;
    const duration = 1000 / speed;

    const iconDef = playbackIconDef();
    if (iconDef) {
      try {
        await loadCanvasIcon(iconDef.src);
      } catch (e) {
        console.error('Воспроизведение трека: не удалось загрузить иконку', e);
        return;
      }
    }
    if (playbackToken !== token) return; // успели остановить, пока грузилась иконка

    playbackMarker = (iconDef
      ? new CanvasIconMarker(points[0], {
          renderer: getCanvasIconRenderer(),                   // всегда canvas, см. buildPointMarker
          radius: Math.max(iconDef.width, iconDef.height) / 2,
          image: canvasIconReady[iconDef.src],
          width: iconDef.width, height: iconDef.height,
          anchorX: iconDef.anchorX, anchorY: iconDef.anchorY
        })
      : L.circleMarker(points[0], { radius: 7, weight: 2, color: '#fff', fillColor: SELECT_COLOR, fillOpacity: 1 })
    ).addTo(map);

    setPlaybackUI(true);

    for (const point of points) {
      if (playbackToken !== token) return;
      playbackMarker.slideTo(point, { duration });
      await delay(duration);
    }

    stopTrackPlayback();
  }

  // Останавливает воспроизведение, если оно идёт; иначе no-op. Вызывается и
  // явной кнопкой "Стоп", и при любом переключении выбранного объекта/закрытии
  // панели (см. selectObject/closeDetail) — иначе маркер воспроизведения
  // остался бы "бродить" по карте без управления.
  function stopTrackPlayback() {
    const wasPlaying = playbackMarker !== null;
    playbackToken++; // инвалидирует цикл slideTo в playTrack, даже если он спит в delay()
    if (playbackMarker) {
      playbackMarker.slideCancel();
      map.removeLayer(playbackMarker);
      playbackMarker = null;
    }
    if (wasPlaying) setPlaybackUI(false);
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Переключает вид кнопок в уже отрисованной панели (разметку вставляет
  // renderPlaybackBar) — блокирует кнопки скорости и разблокирует "Стоп" на
  // время воспроизведения, и обратно по его окончании/остановке.
  function setPlaybackUI(playing) {
    const bar = document.querySelector('.detail__playback');
    if (!bar) return;
    bar.classList.toggle('is-playing', playing);
    bar.querySelectorAll('[data-speed]').forEach(btn => btn.disabled = playing);
    const stopBtn = bar.querySelector('[data-stop]');
    if (stopBtn) stopBtn.disabled = !playing;
  }

  // =====================================================================
  //  Выбор объекта → правая панель
  // =====================================================================
  // selectToken — тот же приём, что и st.token у слоёв (см. toggleLayer): клик
  // по объекту B до того, как ответ на клик по объекту A ещё не пришёл, не
  // должен позволить более раннему запросу (A) затереть панель, если он
  // почему-то разрешится позже более позднего (B) — сеть не гарантирует
  // порядок ответов в порядке запросов. Без токена панель могла бы в итоге
  // показать данные не того объекта, что был выбран последним.
  let selectToken = 0;

  async function selectObject(layerId, objectId) {
    stopTrackPlayback();

    const token = ++selectToken;

    // разворачиваем панель подробностей, если свёрнута
    document.getElementById('panelDetail').classList.remove('is-collapsed');
    document.getElementById('revealDetail').classList.remove('is-visible');

    // выделяем линию/полигон (треки, маршруты, административные единицы); для точек
    // снимаем выделение
    const st = layerState[layerId];
    const vgLayer = st && vgLayerOf(st.group);
    if (vgLayer) {
      // VectorGrid-слой: подсветка через setFeatureStyle (пофигурного L.polygon нет)
      highlightVGFeature(vgLayer, objectId, st.meta.type);
    } else {
      const target = findLayer(layerId, objectId);
      if (target && target.setStyle && !target.getLatLng) {
        highlightVector(target, st && st.meta.type);
      } else {
        clearVectorSelection();
      }
    }

    const body = document.getElementById('detailBody');
    body.innerHTML = `<div class="detail-empty"><p>Загрузка…</p></div>`;

    const d = await MapAPI.getObjectDetails(layerId, objectId);
    if (token !== selectToken) return; // пользователь успел выбрать другой объект
    body.innerHTML = renderDetail(layerId, d);
    document.getElementById('detailActions').innerHTML = renderDetailActions(layerId, d.id);
  }

  // Заголовок (тип объекта) и подзаголовок (полное наименование, для копирования) —
  // фиксированная разметка на клиенте. Всё остальное содержимое панели — готовый
  // HTML-фрагмент с сервера (АнгелКартографияВнешнееAPI.ПолучитьДетали, поле html;
  // использует те же классы .detail__row/.detail__rows/.detail__section-title/
  // .detail__status, что и раньше собирались здесь на клиенте — см. map/css/styles.css).
  function renderDetail(layerId, d) {
    return `
      <div class="detail">
        <div class="detail__hero">
          <h3 class="detail__type">${d.type || d.id}</h3>
          <div class="detail__name">${d.title || d.id}</div>
        </div>
        <div class="detail__html">${d.html || '<div class="detail__row"><dd>Нет данных</dd></div>'}</div>
        ${isPlaybackLayer(layerState[layerId] && layerState[layerId].meta) ? renderPlaybackBar(layerId, d.id) : ''}
      </div>`;
  }

  // Кнопки «Показать на карте»/«Закрыть» — рисуются отдельно от renderDetail() и
  // монтируются в #detailActions (см. buildChrome), а не в прокручиваемое тело
  // панели, поэтому всегда остаются на виду независимо от длины детальной
  // информации.
  function renderDetailActions(layerId, objId) {
    return `
      <div class="detail__actions">
        <button class="btn btn--primary" onclick="MapApp.centerOn('${layerId}','${objId}')">Показать на карте</button>
        <button class="btn" onclick="MapApp.closeDetail()">Закрыть</button>
      </div>`;
  }

  // Кнопки воспроизведения — только у слоя с воспроизведением (isPlaybackLayer, см.
  // секцию "Воспроизведение трека" выше). layerId/objId — те же id, что уже
  // используют findLayer/getObjectDetails, просто прокидываются в MapApp.playTrack.
  function renderPlaybackBar(layerId, objId) {
    const speedButtons = [1, 2, 4, 10].map(s =>
      `<button class="btn speed-btn" data-speed="${s}" onclick="MapApp.playTrack('${layerId}', '${objId}', ${s})">${s}×</button>`
    ).join('');
    return `
      <div class="detail__playback">
        ${speedButtons}
        <button class="btn btn--stop" data-stop onclick="MapApp.stopTrackPlayback()" disabled>■ Стоп</button>
      </div>`;
  }

  function emptyDetail() {
    return `<div class="detail-empty">${SVG.cursor}
      <p>Выберите объект на карте,<br>чтобы увидеть подробную информацию</p></div>`;
  }

  // ---- публичные помощники для кнопок ----------------------------------
  function findLayer(layerId, objectId) {
    const st = layerState[layerId];
    if (!st || !st.group || !st.group.eachLayer) return null;  // VG-группа не итерируется — см. centerOn/selectObject
    let target = null;
    st.group.eachLayer(l => { if (!target && l._objId === objectId) target = l; });
    return target;
  }

  function centerOn(layerId, objectId) {
    const st = layerState[layerId];
    const vgLayer = st && vgLayerOf(st.group);
    if (vgLayer) {
      // VectorGrid-слой: габариты берём из побочной таблицы objId→bounds
      const rec = vgLayer._byObjId.get(objectId);
      if (rec && rec.bounds.isValid()) map.fitBounds(rec.bounds, { animate: true, maxZoom: 16 });
      return;
    }
    const target = findLayer(layerId, objectId);
    if (!target) return;
    if (target.getLatLng) {
      map.setView(target.getLatLng(), 16, { animate: true });
    } else if (target.getBounds) {
      map.fitBounds(target.getBounds(), { animate: true, maxZoom: 16 });
    }
  }

  function closeDetail() {
    stopTrackPlayback();
    clearVectorSelection();
    // Инвалидирует ещё не разрешившийся selectObject (см. его selectToken) —
    // без этого поздний ответ на уже закрытую панель мог бы сам себя снова
    // открыть и показать данные объекта, который пользователь уже отменил.
    selectToken++;
    document.getElementById('detailBody').innerHTML = emptyDetail();
    document.getElementById('detailActions').innerHTML = '';
    // Сворачиваем панель, как по кнопке collapseDetail — «Закрыть» означает
    // «убрать с экрана», а не только «очистить содержимое».
    document.getElementById('panelDetail').classList.add('is-collapsed');
    document.getElementById('revealDetail').classList.add('is-visible');
  }

  // Вызывается из app-shell.js после того, как #viewMap снова становится
  // видимым (display:none -> ''). Пока экран "Карта" был скрыт целиком
  // (переключились на Дашборд/Отчёты), Leaflet не отслеживал изменение
  // размеров своего контейнера — без invalidateSize() тайловая раскладка
  // остаётся такой, какой была на момент скрытия, и часть контейнера рисуется
  // пустой.
  function refreshSize() {
    if (map) map.invalidateSize();
  }

  return { init, toggleLayer, centerOn, closeDetail, closeMapCommandDetail, selectObject, playTrack, stopTrackPlayback, refreshSize, refreshLayer };
})();

window.MapApp = MapApp;
