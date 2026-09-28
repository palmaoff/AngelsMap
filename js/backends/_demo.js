/* =====================================================================
   Демо-плагин (window.BackendPlugin) — карта без бэкенда и без входа.

   Два назначения:
   1. Стенд ядра. Все три экрана (Карта/Дашборд/Отчёты) работают на
      синтетических данных из js/backends/_demo-server.js — «сервера» внутри
      браузера. Ядро при этом идёт ровно теми же путями, что и с настоящей
      1С: js/api.js видит mockApi ниже и отдаёт запросы обработчикам вместо
      fetch (см. api.js: mockRequest), дальше — обычные extractFeatures,
      кэш слоёв, спиннеры, токены устаревших ответов, модалки настроек.
      Каждый слой нарочно упражняет свою ветку ядра — см. CLAUDE.md,
      «Демо-режим».
   2. Заготовка нового проекта. Поля ниже — полный контракт плагина с
      рабочими примерами каждого.

   Как начать новый проект на этом ядре:
   1. Скопировать этот файл в js/backends/<id>.js, поменять id/appTitle/
      baseUrl/fallbackCenter.
   2. Убрать mockApi/mockDelay (запросы пойдут на настоящий baseUrl) и тег
      _demo-server.js из index.html; requiresAuth: false убрать, если
      публикация 1С требует входа.
   3. Оставить только нужные поля: слои/иконки/зум-тиры — под свои id из
      /layers; шаблон дашборда — под свой ответ /dashboard (или
      supportsDashboard: false); отчёты (supportsReports); команды карты.
   4. Сервер (map-api/ своей 1С-базы) реализует тот же HTTP-контракт, что
      отвечает _demo-server.js, — его ответы и есть живой образец формата.

   Отладка через URL: ?mockdelay=0 — без искусственной задержки;
   ?mockfail=dashboard,reports — эти разделы отвечают ошибкой 500.
   ===================================================================== */

window.BackendPlugin = (function () {

  // ---------------------------------------------------------------- слои
  // Пиктограммы с цветом КАЖДОГО объекта (obj.idCluster) — SVG-шаблон с
  // плейсхолдером, см. js/map.js: getColoredIconSrc. «Транспорт» здесь —
  // только запасная пиктограмма для img, которого нет в /icons (serverIcons).
  const pointIconShapes = {
    'Происшествия': {
      placeholder: '#ЦветФона',
      width: 26, height: 26, anchorX: 13, anchorY: 13,
      svg: '<svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">'
         + '<circle cx="13" cy="13" r="11.5" fill="#ЦветФона" stroke="#fff" stroke-width="2"/>'
         + '<rect x="11.6" y="6" width="2.8" height="9" rx="1.2" fill="#fff"/>'
         + '<circle cx="13" cy="18.8" r="1.7" fill="#fff"/></svg>'
    },
    'Транспорт': {
      placeholder: '#ЦветФона',
      width: 22, height: 22, anchorX: 11, anchorY: 11,
      svg: '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">'
         + '<rect x="2" y="2" width="18" height="18" rx="4" fill="#ЦветФона" stroke="#fff" stroke-width="2"/>'
         + '<text x="11" y="15.5" font-family="Arial" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">?</text></svg>'
    }
  };

  // Одна статичная картинка на слой; слой cluster:false → рисуется на canvas
  // (CanvasIconMarker), а не DOM-маркерами.
  const canvasIcons = {
    'Остановки': { src: 'js/icons/АвтобуснаяОстановка.svg', width: 18, height: 25, anchorX: 9, anchorY: 25 }
  };

  // Зум-фильтр по obj.typeRoad: на обзорных зумах только федеральные трассы.
  const zoomTiers = {
    'Дороги': [
      { minZoom: 0,  types: ['Федеральная'] },
      { minZoom: 11, types: ['Федеральная', 'Региональная'] },
      { minZoom: 13, types: null }
    ]
  };

  // ------------------------------------------------------------ дашборд
  // Разметка — на тех же классах .aa-*, что и дашборд accident-analysis
  // (css/styles.css), своих стилей не добавляет. D — результат normalize().
  const SER = { inc: '#2a78d6', hurt: '#eda100', dead: '#e34948' };
  const SEV_COLORS = ['#1baf7a', '#eda100', '#d7191c'];

  function dynSeries(D) {
    return [
      { name: 'Происшествия', color: SER.inc, values: D.dyn.inc },
      { name: 'Пострадало', color: SER.hurt, values: D.dyn.hurt },
      { name: 'Погибло', color: SER.dead, values: D.dyn.dead }
    ];
  }

  function normalize(payload) {
    const d = payload.data || {};
    const pairs = DashboardApp.pairs;
    return {
      kpi: d.kpi,
      dyn: d.dyn,
      types: pairs(d.types),
      severity: pairs(d.severity),
      lighting: pairs(d.lighting),
      surface: pairs(d.surface),
      roads: pairs(d.roads),
      districts: d.districts || [],
      meta: {
        title: payload.title || 'Дашборд',
        period: payload.period ? `${payload.period.begin} – ${payload.period.end}` : '',
        appg: payload.appg,
        districts: payload.districts || 'Все',
        onlyConfirmed: payload.onlyConfirmed,
        generatedAt: payload.generatedAt || ''
      }
    };
  }

  function render(D, meta) {
    const { esc, chipLabel, kpiCard, columnChart, hBarList, donutChart, donutLegend, CAT } = ChartKit;
    const dser = dynSeries(D);
    const dynLg = dser.map(s => `<span class="dash-li"><span class="dash-s" style="background:${s.color}"></span>${s.name}</span>`).join('');
    const toBars = (pairs, colors) => ({ categories: pairs.map(p => p[0]), values: pairs.map(p => p[1]), colors });
    const donut = (title, tick, items) => `
      <div class="dash-panel"><h3><span class="dash-tick" style="background:${tick}"></span>${title}</h3>
        <div class="dash-dcell"><div class="dash-chart">${donutChart(items, CAT)}</div><div class="dash-dleg">${donutLegend(items, CAT)}</div></div></div>`;
    // Плитки районов кликабельны — data-dash-act уходит в dashboardActions ниже
    // (переход на карту с выбранным районом).
    const tiles = D.districts.map(d => d.id
      ? `<div class="dash-fac" data-dash-act="show-district" data-id="${esc(d.id)}" style="cursor:pointer" title="Показать на карте">
           <div class="dash-fl">${esc(d.name)}</div><div class="dash-fv tabnum">${d.inc}/${d.hurt}</div><div class="dash-fc">Происшествий/Пострадало</div></div>`
      : `<div class="dash-fac"><div class="dash-fl">${esc(d.name)}</div><div class="dash-fv tabnum">${d.inc}/${d.hurt}</div><div class="dash-fc">Происшествий/Пострадало</div></div>`
    ).join('');

    const flt = [`<span class="dash-flt-title">${esc(meta.title)}</span>`];
    if (meta.period) flt.push(`<span>📅 <b>${esc(meta.period)}</b></span>`);
    if (meta.appg) flt.push(`<span>⟲ АППГ <b>${esc(String(meta.appg))}</b></span>`);
    flt.push(`<span title="${esc(meta.districts)}">📍 Районы: <b>${esc(chipLabel(meta.districts))}</b></span>`);
    if (meta.onlyConfirmed) flt.push(`<span>✓ <b>Только подтверждённые</b></span>`);
    flt.push(`<span class="dash-flt-spacer"></span>`);
    // .dash-flt-upd и data-dash-act="refresh" — точки, в которые ядро ставит
    // спиннер на время загрузки (DashboardApp.setUpdating).
    flt.push(`<span class="dash-flt-upd">обновлено: <b class="dash-flt-upd-val">${meta.generatedAt ? esc(meta.generatedAt) : '—'}</b><span class="dash-flt-spin"></span></span>`);
    flt.push(`<button type="button" class="dash-flt-btn" data-dash-act="settings" title="Фильтры">⚙</button>`);
    flt.push(`<button type="button" class="dash-flt-btn" data-dash-act="refresh" title="Обновить">⟳</button>`);

    return `
      <div class="dash-layout">
        <div class="dash-flt">${flt.join('')}</div>
        <div class="dash-left">
          ${kpiCard('Происшествия', D.kpi.inc.cur, D.kpi.inc.prev, SER.inc)}
          ${kpiCard('Пострадало', D.kpi.hurt.cur, D.kpi.hurt.prev, SER.hurt)}
          ${kpiCard('Погибло', D.kpi.dead.cur, D.kpi.dead.prev, SER.dead)}
          <div class="dash-facwrap">${tiles}</div>
        </div>
        <div class="dash-right">
          <div class="dash-panel" style="grid-area:dyn">
            <h3><span class="dash-tick" style="background:${SER.inc}"></span>Динамика по месяцам<span class="dash-lg">${dynLg}</span></h3>
            <div class="dash-chart demo-dyn-chart">${columnChart({ categories: D.dyn.m, series: dser, aspect: 4.25 })}</div>
          </div>
          <div class="dash-panel" style="grid-area:vid">
            <h3><span class="dash-tick" style="background:${CAT[0]}"></span>Виды происшествий</h3>
            <div class="dash-chart">${hBarList(toBars(D.types, CAT))}</div>
          </div>
          <div class="dash-panel" style="grid-area:nar">
            <h3><span class="dash-tick" style="background:${SEV_COLORS[2]}"></span>Тяжесть последствий</h3>
            <div class="dash-chart">${hBarList(toBars(D.severity, SEV_COLORS))}</div>
          </div>
          <div class="dash-cnd">
            ${donut('Освещение', CAT[3], D.lighting)}
            ${donut('Покрытие', CAT[4], D.surface)}
            ${donut('Вид дороги', CAT[1], D.roads)}
          </div>
        </div>
      </div>`;
  }

  // Необязательный хук fit(root, D): «Динамика» перерисовывается под реальные
  // пропорции своей ячейки (см. CLAUDE.md, «Dashboard», про el.aspect).
  let fitSize = '';
  function fit(root, D) {
    const cell = root.querySelector('.demo-dyn-chart');
    if (!cell) return;
    const w = cell.clientWidth, h = cell.clientHeight;
    if (!w || !h) return;
    const key = w + 'x' + h;
    if (key === fitSize && cell.firstElementChild) return;
    fitSize = key;
    cell.innerHTML = ChartKit.columnChart({ categories: D.dyn.m, series: dynSeries(D), aspect: w / h });
  }

  // Клики по разметке шаблона (ядро раздаёт их по data-dash-act, см.
  // js/dashboard.js: bindControls): плитка района → карта, слой «Районы»
  // включён, район выделен и показан.
  const dashboardActions = {
    async 'show-district'({ el }) {
      const id = el.dataset.id;
      location.hash = '#map';
      await MapApp.toggleLayer('Районы', true);
      await MapApp.selectObject('Районы', id);
      MapApp.centerOn('Районы', id);
    }
  };

  // ------------------------------------------------------ команды карты
  const escH = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const detailRows = pairs => `<dl class="detail__rows">${pairs.map(([k, v]) =>
    `<div class="detail__row"><dt>${escH(k)}</dt><dd>${escH(v)}</dd></div>`).join('')}</dl>`;
  const closeActions = `<div class="detail__actions"><button class="btn" onclick="MapApp.closeMapCommandDetail()">Закрыть</button></div>`;

  // «Что здесь?» — одна точка, завершается сама (autoCompleteAtMinPoints), и
  // ходит в «собственный» эндпоинт плагина GET /geo/where через ctx.getJSON —
  // тот же приём, что /route/hotspots у accident-analysis.
  const whatHereCommand = {
    id: 'what-here',
    title: 'Что здесь?',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    minPoints: 1,
    autoCompleteAtMinPoints: true,
    async onComplete(points, ctx) {
      const p = points[0];
      let info;
      try {
        info = await ctx.getJSON(ctx.apiUrl(`geo/where?lat=${p.lat.toFixed(6)}&lng=${p.lng.toFixed(6)}`));
      } catch (e) {
        ctx.showHint('Не удалось получить сведения о точке');
        return;
      }
      ctx.renderResult(`
        <div class="detail">
          <div class="detail__hero"><h3 class="detail__type">Точка на карте</h3>
            <div class="detail__name">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div></div>
          <div class="detail__html">${detailRows([
            ['Район', info.district],
            ['До центра', info.toCenterKm + ' км'],
            ['Ближайшая остановка', info.nearestStop ? `${info.nearestStop.name}, ${info.nearestStop.distM} м` : '—'],
            ['Происшествий в 500 м (2026)', info.incidents500m],
            ['Пострадало там же', info.hurt500m]
          ])}</div>
        </div>`, closeActions);
    }
  };

  // «Площадь» — несколько точек, завершается повторным кликом по кнопке (без
  // autoCompleteAtMinPoints). Считается целиком на клиенте; нарисованный
  // многоугольник — собственный слой плагина, снимается в onClose.
  let areaLayer = null;
  const areaCommand = {
    id: 'area',
    title: 'Площадь участка (отметьте точки, затем нажмите кнопку ещё раз)',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="4 7 12 3 20 8 18 18 7 20"/></svg>',
    minPoints: 3,
    async onComplete(points, ctx) {
      if (areaLayer) ctx.map.removeLayer(areaLayer);
      areaLayer = ctx.L.polygon(points, { color: '#6a3d9a', weight: 2, fillOpacity: 0.15, interactive: false }).addTo(ctx.map);
      // Равнопромежуточная проекция вокруг центроида — для участков в пределах
      // города погрешность ничтожна.
      const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length * Math.PI / 180;
      const xy = points.map(p => [p.lng * 111.32 * Math.cos(lat0), p.lat * 110.57]);
      let a = 0, per = 0;
      xy.forEach((q, i) => {
        const n = xy[(i + 1) % xy.length];
        a += q[0] * n[1] - n[0] * q[1];
        per += Math.hypot(n[0] - q[0], n[1] - q[1]);
      });
      const km2 = Math.abs(a) / 2;
      ctx.renderResult(`
        <div class="detail">
          <div class="detail__hero"><h3 class="detail__type">Участок</h3><div class="detail__name">${points.length} вершин</div></div>
          <div class="detail__html">${detailRows([
            ['Площадь', km2 >= 1 ? km2.toFixed(2).replace('.', ',') + ' км²' : (km2 * 100).toFixed(1).replace('.', ',') + ' га'],
            ['Периметр', per.toFixed(2).replace('.', ',') + ' км']
          ])}</div>
        </div>`, closeActions, () => { if (areaLayer) { ctx.map.removeLayer(areaLayer); areaLayer = null; } });
    }
  };

  return {
    id: 'demo',
    appTitle: 'Демо · Карта',

    // Вход не нужен (js/auth.js сразу стартует приложение); в подвале панели
    // слоёв вместо логина/«Выйти» — эта подпись.
    requiresAuth: false,
    anonymousLabel: 'Демо-режим · без бэкенда',

    // baseUrl формально нужен (из него строятся пути, которые разбирает мок),
    // но в сеть по нему ничего не уходит, пока задан mockApi.
    baseUrl: '/demo/hs/map-api/',
    mockApi: window.DemoServer && DemoServer.routes,
    mockDelay: [150, 450],

    fallbackCenter: [55.751244, 37.618423],
    fallbackZoom: 11,

    supportsDashboard: true,
    supportsReports: true,

    serverIcons: true,                 // точки «Транспорт» — картинками из GET /icons, с поворотом
    backgroundLayers: ['Районы'],      // районы всегда под зонами работ
    canvasIcons,
    pointIconShapes,
    zoomTiers,
    trackPlayback: {
      layers: ['Треки'],               // сервер и сам шлёт playback:true — список для наглядности
      icon: { src: 'js/icons/Автобус.png', width: 30, height: 30, anchorX: 15, anchorY: 15 }
    },
    // wideSettingsLayers не нужен — «Происшествия» шлют wideSettings:true в /layers.

    // dashboardDemo нарочно нет — первый кадр дашборда показывает скелетон ядра.
    dashboardTemplates: { demo: { normalize, render, fit } },
    dashboardActions,

    reportRenderers: {},
    exportProfile: { orgTitle: 'Демо-организация' },

    mapCommands: [whatHereCommand, areaCommand]
    // supportsInsuranceImport: опущен — загрузка реестра есть только у accident-analysis.
  };
})();
