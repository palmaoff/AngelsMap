/* =====================================================================
   Каркас приложения поверх карты: переключатель экранов Карта / Дашборд /
   Отчёты — плавающий блок по центру сверху (см. .view-switch в
   css/styles.css — та же "пилюльная" конструкция и тот же приём
   позиционирования, что и .map-toolbar внизу), а не сплошной App Bar,
   который отбирал бы высоту у карты.

   Рендерится и инициализируется один раз в auth.js: startApp(), уже после
   MapApp.init() — переключатель и заглушки Дашборда/Отчётов не должны
   быть видны до логина, как и всё остальное содержимое #app.

   Экраны — три полноэкранных .view-контейнера (#viewMap/#viewDashboard/
   #viewReports, см. index.html), между которыми переключаемся простым
   show/hide (.is-active), без роутинг-библиотек. Текущий экран хранится в
   location.hash (#map/#dashboard/#reports), чтобы кнопка "назад" в браузере
   и обновление страницы не сбрасывали выбранный экран.
   ===================================================================== */

const AppShell = (function () {

  const VIEWS = [
    { id: 'map',       label: 'Карта' },
    { id: 'dashboard', label: 'Дашборд' },
    { id: 'reports',   label: 'Отчёты' }
  ];
  const DEFAULT_VIEW = 'map';

  let currentView = null;

  function viewElId(id) {
    return 'view' + id.charAt(0).toUpperCase() + id.slice(1);
  }

  function showView(id) {
    if (!VIEWS.some(v => v.id === id)) id = DEFAULT_VIEW;
    if (id === currentView) return;

    // Уходя с "Карты", останавливаем воспроизведение трека явно — оно
    // работает через slideTo на живом Leaflet-маркере (см. map.js:
    // playTrack/stopTrackPlayback) и продолжило бы тикать в фоне под
    // скрытым (display:none) #viewMap, если его не остановить.
    if (currentView === 'map' && id !== 'map') {
      MapApp.stopTrackPlayback();
    }

    VIEWS.forEach(v => {
      document.getElementById(viewElId(v.id)).classList.toggle('is-active', v.id === id);
    });
    document.querySelectorAll('#viewSwitch .view-switch__btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.view === id);
    });

    // #viewMap только что мог перейти display:none -> видим — Leaflet не
    // сам не замечает такое изменение размеров контейнера (см. map.js:
    // refreshSize).
    if (id === 'map') MapApp.refreshSize();

    // Та же причина, что и у refreshSize() выше, только для дашборда: часть его
    // графиков подгоняется под ФАКТИЧЕСКИЙ размер своей ячейки (см.
    // DashboardApp.refit и хук fit в контракте dashboardTemplates), а под
    // display:none мерить нечего — на момент первой отрисовки экран обычно
    // скрыт, активна карта.
    if (id === 'dashboard') DashboardApp.refit();

    currentView = id;
  }

  function renderSwitch() {
    document.getElementById('app').insertAdjacentHTML('beforeend', `
      <div class="view-switch" id="viewSwitch">
        ${VIEWS.map(v => `<button class="view-switch__btn" data-view="${v.id}">${v.label}</button>`).join('')}
      </div>`);

    document.getElementById('viewSwitch').addEventListener('click', e => {
      const btn = e.target.closest('.view-switch__btn');
      if (btn) location.hash = '#' + btn.dataset.view;
    });
  }

  function init() {
    renderSwitch();
    DashboardApp.init();
    ReportsApp.init();

    window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
    showView(location.hash.slice(1) || DEFAULT_VIEW);
  }

  return { init, showView };
})();
