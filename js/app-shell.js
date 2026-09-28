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

  // Кнопка загрузки реестра страхования (см. js/insurance-import.js) — не
  // экран, а модалка поверх текущего, поэтому не входит в VIEWS/showView, но
  // рисуется в той же пилюле .view-switch, рядом с переключателями экранов
  // (не отдельный плавающий элемент).
  const SVG_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';

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
        <span class="view-switch__divider"></span>
        ${(window.BackendPlugin && BackendPlugin.supportsInsuranceImport)
          ? `<button class="view-switch__action" id="btnInsuranceImport" title="Загрузить реестр страхования">${SVG_UPLOAD}</button>`
          : ''}
      </div>`);

    document.getElementById('viewSwitch').addEventListener('click', e => {
      if (e.target.closest('#btnInsuranceImport')) { InsuranceImport.open(); return; }
      const btn = e.target.closest('.view-switch__btn');
      if (btn) location.hash = '#' + btn.dataset.view;
    });
  }

  function init() {
    renderSwitch();
    DashboardApp.init();
    ReportsApp.init();
    if (window.BackendPlugin && BackendPlugin.supportsInsuranceImport) InsuranceImport.init();
    // DtpCreateForm — в отличие от InsuranceImport, не за отдельным supports-
    // флагом: его модалка нужна только если подключённый BackendPlugin.mapCommands
    // содержит команду, которая её открывает (сегодня — createDtpCommand,
    // accident-analysis), но само по себе мгновенное монтирование пустого DOM-
    // каркаса безусловно дешевле лишнего флага контракта ради одной проверки —
    // см. CLAUDE.md, "Создание ДТП по клику".
    DtpCreateForm.init();

    window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
    showView(location.hash.slice(1) || DEFAULT_VIEW);
  }

  return { init, showView };
})();
