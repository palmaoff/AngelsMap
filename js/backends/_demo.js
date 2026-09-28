/* =====================================================================
   Демонстрационный (синтетический) бэкенд-плагин — не привязан ни к одной
   реальной 1С-базе. Единственная цель: проверить, что window.BackendPlugin
   действительно является точкой расширения, а не воображаемым контрактом —
   переключение на этот плагин должно реально поменять поведение ядра
   (иконки слоёв, зум-тиры, шаблон дашборда, доступность вкладки «Отчёты»),
   а переключение обратно на js/backends/accident-analysis.js должно вернуть
   всё как было, без остаточного состояния от этого плагина где-либо в ядре.

   Значения ниже НАРОЧНО отличаются от accident-analysis.js по каждому полю
   контракта — если после переключения хоть одно из мест ядра, читающих
   BackendPlugin, продолжает показывать старое (accident-analysis) поведение,
   это явный сигнал, что то место читает не из BackendPlugin, а откуда-то
   ещё (закешировало/захардкодило). supportsReports: false — единственный
   плагин, где этот флаг не true: у accident-analysis он всегда true, так что
   ветка "раздел недоступен" (см. js/reports.js: init()) иначе никогда не
   упражняется вручную.

   НЕ подключается по умолчанию — см. index.html, тег закомментирован рядом
   с боевым accident-analysis.js. Переключение — раскомментировать один тег,
   закомментировать другой, перезагрузить страницу (?bench=1 для доступа к
   window.__leafletMap и обхода недоступности сети — см. CLAUDE.md,
   "Measurement caveat"). Согласно принятому решению (см. план рефакторинга,
   раздел 0) — без рантайм-детекта бэкенда, переключение всегда ручное.
   ===================================================================== */

window.BackendPlugin = (function () {

  // Тривиальный шаблон дашборда — просто печатает нормализованные данные как
  // есть, без вёрстки. render()/normalize() — минимальная пара, достаточная
  // для проверки того, что реестр TEMPLATES (js/dashboard.js) действительно
  // строится из BackendPlugin.dashboardTemplates, а не хардкодит
  // 'accident-analysis' нигде в ядре.
  function renderDemo(D, meta) {
    return `<div style="padding:24px;font-family:monospace;white-space:pre-wrap">`
      + `<h2 style="margin:0 0 12px">${ChartKit.esc(meta.title)}</h2>`
      + ChartKit.esc(JSON.stringify(D, null, 2))
      + `</div>`;
  }
  function normalizeDemo(payload) {
    return { echo: payload, meta: { title: 'Demo-дашборд · ' + (payload && payload.id) } };
  }

  return {
    id: 'demo',

    // Заведомо другой путь и другая точка на карте, чем у accident-analysis
    // (Сахалин) — Москва, просто для наглядного контраста на скриншоте.
    baseUrl: '/demo/hs/map-api/',
    fallbackCenter: [55.751244, 37.618423],
    fallbackZoom: 10,

    supportsDashboard: true,
    supportsReports: false,   // единственный способ вручную упражнять "раздел недоступен" у Отчётов

    // mapCommands (BackendPlugin.mapCommands, см. CLAUDE.md "Backend plugins"/
    // "Маршрут с очагами аварийности") НАРОЧНО не задан здесь — само отсутствие
    // поля уже даёт категорическое расхождение с accident-analysis (есть кнопка
    // маршрута в тулбаре / нет её вовсе), тот же приём, что и у supportsReports
    // выше (true у accident-analysis, false только здесь, чтобы вручную
    // упражнять ветку "недоступно"). Заводить ради единообразия ещё и фейковую
    // demo-команду избыточно — mapCommands и так по факту optional-поле с
    // содержательным дефолтом "ничего не показывать", как dashboardDemo.

    // Другой слой, другая картинка (один из зарезервированных, но нигде не
    // подключённых иконок — js/icons/НачалоТрека.svg, см. CLAUDE.md "Структура":
    // "НачалоТрека.svg / КонецТрека.svg зарезервированы, не подключены ни к
    // одному слою" — здесь наконец находят применение, без нового файла).
    canvasIcons: {
      'ТестовыйСлой': { src: 'js/icons/НачалоТрека.svg', width: 24, height: 24, anchorX: 12, anchorY: 12 }
    },

    // Другой слой, другая форма (простой круг вместо пиктограмм ДТП/камеры/капли).
    pointIconShapes: {
      'ТестовыйСлой2': {
        placeholder: '#ЦветФона',
        width: 20, height: 20, anchorX: 10, anchorY: 10,
        svg: '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">'
           + '<circle cx="10" cy="10" r="9" fill="#ЦветФона" stroke="#fff" stroke-width="2"/></svg>'
      }
    },

    // Другой слой ("ТестовыеЛинии" вместо "АвтомобильныеДороги") и другие
    // пороги (0/8, а не 0/11/13) — обобщённость zoomTiers (Задача 4) проверяется
    // именно тем, что здесь ключ словаря — совсем другой id.
    zoomTiers: {
      'ТестовыеЛинии': [
        { minZoom: 0, types: ['A'] },
        { minZoom: 8, types: null }
      ]
    },

    // meta.title обязателен по неявному контракту шаблона (см. render(D, meta)
    // выше и accident-analysis.js: DEMO.meta) — ловится живьём (см. CLAUDE.md,
    // "backends/_demo.js"): без meta paint() падал с "Cannot read properties
    // of undefined (reading 'title')".
    dashboardDemo: { note: 'Демо-данные demo-плагина, не accident-analysis', values: [1, 2, 3], meta: { title: 'Demo · демо-данные' } },
    dashboardTemplates: { demo: { normalize: normalizeDemo, render: renderDemo } },

    reportRenderers: {}
  };
})();
