/* =====================================================================
   Экран "Дашборд" — обвязка вокруг шаблона, который отдаёт бэкенд-плагин.

   Данные приходят с бэка: MapAPI.getDashboard() → GET /dashboard. Раскладка/
   оформление конкретного дашборда, нормализация ответа сервера и демо-данные
   для мгновенной первой отрисовки — всё это НЕ здесь, а в window.BackendPlugin
   (js/backends/<id>.js, поле dashboardTemplates/dashboardDemo, см. его
   контракт) — переехало туда 2026-08-24, см. историю в CLAUDE.md, "Ядро и
   плагины под бэкенд". Этот файл (ядро) знает только формат реестра шаблонов
   ({normalize(payload)->D, render(D, meta)->html}) и общую обвязку: спиннер
   загрузки, скелетон на время запроса и карточку ошибки (см. skeletonHtml/
   errorHtml), модалка фильтров (общая с панелью слоёв, см. js/settings-form.js),
   делегированные клики/тултип, состояние "раздел недоступен" — ничего из
   этого не знает про конкретную схему данных какого-либо одного бэкенда.
   Клики по разметке самого шаблона ядро раздаёт плагину через
   BackendPlugin.dashboardActions (см. bindControls).

   TEMPLATES выбирается по payload.id — идентификатору дашборда, который
   отдаёт сервер, тот же id, что и BackendPlugin.id (см. контракт плагина) —
   так во внешней карте можно держать несколько вариантов разметки для разных
   баз без правки этого файла: другой плагин просто регистрирует свой шаблон
   под своим id. Если id незнаком (плагин не зарегистрировал под ним шаблон)
   — заглушка "нет шаблона", а не попытка отрендерить чужой шаблон чужими
   данными (см. paint()).
   ===================================================================== */

const DashboardApp = (function () {

  const { esc } = ChartKit;

  // Ответ сервера отдаёт категориальные блоки как массив { name, value }, факторы —
  // { label, value }; приводим к парам [подпись, значение] — структурная деталь 1С-
  // сериализации, общая для любого бэкенда с той же конвенцией, не специфика одной
  // базы (см. CLAUDE.md, план рефакторинга, задача 1). Экспонированы в возвращаемом
  // объекте ниже — ими пользуется normalize() бэкенд-плагинов (BackendPlugin.
  // dashboardTemplates[id].normalize), которые физически не могут дотянуться до
  // приватных функций этого замыкания иначе (плагин — отдельный файл/scope).
  const pairs = arr => (arr||[]).map(o => Array.isArray(o) ? o : [o.name, o.value]);
  const factorPairs = arr => (arr||[]).map(o => Array.isArray(o) ? o : [o.label, o.value]);

  // Реестр шаблонов дашборда по идентификатору (payload.id) — состав целиком
  // определяет подключённый бэкенд-плагин, ядро само не знает ни одного шаблона.
  const TEMPLATES = Object.assign({}, BackendPlugin.dashboardTemplates || {});

  // Последнее отрисованное состояние — нужно refit() ниже, чтобы повторно
  // позвать tpl.fit() без перерисовки всего экрана и без похода на сервер.
  let lastId = null, lastD = null;
  // Подпись периода из последнего УСПЕШНОГО ответа — единственное, что
  // переживает скелетон/карточку ошибки: скелетон подписан «Считаем показатели
  // за …», и при ⟳/применении фильтров период уже известен. При самом первом
  // заходе пуст — тогда подпись идёт без периода.
  let lastPeriod = '';

  function paint(id, D) {
    const tpl = TEMPLATES[id];
    if (!tpl) {
      // Раньше (один плагин в системе) сюда неявно подставлялся единственный
      // существующий шаблон — с несколькими плагинами это означало бы рендер
      // ЧУЖОГО шаблона чужими данными (несовместимая схема D). Явная заглушка
      // вместо этого — единственный безопасный fallback без полноценного
      // generic-дашборда (см. CLAUDE.md, решение В10 — не в скоупе).
      document.getElementById('viewDashboard').innerHTML =
        `<div class="reports__preview-empty">Нет шаблона дашборда для проекта «${esc(id)}»</div>`;
      return;
    }
    const root = document.getElementById('viewDashboard');
    root.innerHTML = tpl.render(D, D.meta) + '<div class="aa-tip" id="aaTip"></div>';

    lastId = id; lastD = D;
    if (D.meta && D.meta.period) lastPeriod = D.meta.period;
    refit();
  }

  /* -------------------------------------------------- скелетон и ошибка
     Оба состояния — ядро, а не шаблон плагина: разметка у них не зависит ни
     от одной схемы данных (в скелетоне нет данных вовсе, в карточке ошибки —
     только текст исключения), а показывать их надо ровно тогда, когда звать
     шаблон не на чем.

     paint() они НЕ используют намеренно: paint() — путь «есть нормализованные
     данные», он пишет lastId/lastD, и refit() после него позвал бы tpl.fit()
     на разметке, которой шаблон не рисовал. Поэтому пишут в innerHTML сами и
     сбрасывают lastId — так последующий resize/вход на вкладку не пытается
     подогнать несуществующие графики. */

  // Показывается вместо экрана на время запроса — но только у плагинов БЕЗ
  // dashboardDemo. У accident-analysis/traffic-monitor демо-данные есть, они
  // рисуются мгновенно в init() и остаются на экране до прихода ответа: для
  // них скелетон был бы шагом назад (экран уже не пустой), а при ⟳ —
  // морганием готовых цифр. Так что поведение тех двух дашбордов этой правкой
  // не меняется вовсе.
  function skeletonHtml() {
    const kpi = () => `<div class="cd-skel__kpi"><span class="cd-skel__ico"></span>`
      + `<span class="cd-skel__lines"><i class="cd-skel__l1"></i><i class="cd-skel__l2"></i></span></div>`;
    return `<div class="cd-skel">
      <div class="cd-skel__row">${kpi()}${kpi()}${kpi()}</div>
      <div class="cd-skel__bars"><i></i><i></i><i></i></div>
      <div class="cd-skel__note"><span class="cd-skel__spin"></span>Считаем показатели${lastPeriod ? ' за ' + esc(lastPeriod) : ''}…</div>
    </div>`;
  }

  // Заменяет содержимое экрана ЦЕЛИКОМ. Раньше (до 2026-09-22) catch в load()
  // только писал console.warn и оставлял на экране демо-данные плагина —
  // молча показывать выдуманные цифры вместо реальных хуже, чем честно
  // сказать, что данные не получены. Побочный эффект — у accident-analysis
  // упавший первый запрос /dashboard теперь тоже даёт эту карточку, а не его
  // демо-набор; это осознанно (см. инструкцию, «Ошибка загрузки»).
  function errorHtml(e) {
    return `<div class="cd-err">
      <span class="cd-err__ico"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 8v5"></path><path d="M12 16.5h.01"></path><circle cx="12" cy="12" r="9"></circle></svg></span>
      <div class="cd-err__body">
        <h3>Не удалось получить данные дашборда</h3>
        <p>Запрос сводки не выполнен. Проверьте, доступна ли публикация 1С, и повторите.</p>
        <div class="cd-err__acts">
          <button type="button" class="cd-btn cd-btn--primary" data-dash-act="refresh">Повторить</button>
          <button type="button" class="cd-btn" data-dash-act="error-details">Показать подробности</button>
        </div>
        <pre class="cd-err__detail" hidden>${esc(e && (e.stack || e.message) || String(e))}</pre>
      </div>
    </div>`;
  }

  /* Необязательный третий метод шаблона (в дополнение к normalize/render):
     fit(root, D) — доводка того, что нельзя посчитать на этапе сборки строки,
     пока разметки нет в DOM. Нужен ровно одному графику — «Динамике ДТП по
     месяцам»: её SVG вписывается в ячейку правилом svg{width:100%;height:100%}
     при preserveAspectRatio="meet", то есть при несовпадении пропорций ячейки и
     viewBox остаются пустые поля, а пропорция ячейки сильно зависит от
     разрешения (измерено: 4.29 на 1440×900 против 6.32 на 1912×897) — подобрать
     её константой нельзя, только измерить.

     Зовётся из трёх мест, и все три — явные: сразу после paint(), из
     AppShell.showView() при входе на вкладку «Дашборд» (до этого экран лежит
     под display:none и мерить нечего — ровно та же причина, по которой там же
     зовётся MapApp.refreshSize()) и по window.resize. ResizeObserver на
     контейнере тут пробовался и отвергнут: fit() меняет innerHTML внутри
     наблюдаемого узла, и на прокручиваемом контейнере это даёт классический
     цикл «перерисовка → появилась/пропала полоса прокрутки → изменилась ширина
     → перерисовка» (воспроизвелось подвисанием вкладки). */
  function refit() {
    const tpl = lastId && TEMPLATES[lastId];
    if (!tpl || typeof tpl.fit !== 'function') return;
    const root = document.getElementById('viewDashboard');
    if (root) tpl.fit(root, lastD);
  }

  // Слушатели вешаются один раз на стабильный #viewDashboard (paint меняет только его
  // innerHTML, включая #aaTip — поэтому tip ищем внутри обработчика каждый раз).
  function bindTooltip() {
    const view = document.getElementById('viewDashboard');
    view.addEventListener('mousemove', e => {
      const tip = document.getElementById('aaTip');
      if (!tip) return;
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t) { tip.innerHTML = t.getAttribute('data-tip'); tip.style.opacity = '1';
        tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px'; }
      else tip.style.opacity = '0';
    });
    view.addEventListener('mouseleave', () => {
      const tip = document.getElementById('aaTip');
      if (tip) tip.style.opacity = '0';
    });
  }

  // Индикатор "данные обновляются" — спиннер на месте даты в чипе "обновлено: …"
  // (сам чип всегда в разметке шаблона) плюс притушенная/неактивная кнопка ⟳
  // (та же .is-busy, что уже была в css/styles.css, просто раньше ничем не
  // выставлялась). Прямая DOM-правка, а не paint() — paint() при успехе и так
  // полностью пересобирает строку фильтров со свежей датой (снимая is-loading
  // вместе со всей остальной разметкой); при ошибке repaint'а не будет вовсе,
  // поэтому load()'s finally сам снимает состояние явно.
  function setUpdating(loading) {
    const view = document.getElementById('viewDashboard');
    if (!view) return;
    const upd = view.querySelector('.aa-flt-upd');
    if (upd) upd.classList.toggle('is-loading', loading);
    const btn = view.querySelector('[data-dash-act="refresh"]');
    if (btn) btn.classList.toggle('is-busy', loading);
  }

  async function load() {
    const view = document.getElementById('viewDashboard');
    // Плагин без демо-данных (BackendPlugin.dashboardDemo не задан) — рисовать
    // на время запроса нечего, поэтому скелетон; с демо-данными экран уже
    // занят ими и трогать его не надо (см. skeletonHtml про обе ветки).
    if (view && !BackendPlugin.dashboardDemo) { lastId = null; view.innerHTML = skeletonHtml(); }
    setUpdating(true);
    try {
      const payload = await MapAPI.getDashboard();
      const id = payload && payload.id;
      const tpl = TEMPLATES[id];
      // tpl не найден (id, которого плагин не регистрировал) — paint() ниже
      // сам покажет заглушку "нет шаблона"; normalize() тогда звать не на чем.
      const D = tpl ? tpl.normalize(payload) : payload;
      paint(id || BackendPlugin.id, D);
    } catch (e) {
      // Сеть легла / бэк ответил не-2xx (getJSON бросает) — карточка ошибки
      // ВМЕСТО содержимого экрана, включая демо-данные плагина, если они там
      // были (изменение поведения 2026-09-22, см. errorHtml).
      console.warn('Дашборд: не удалось загрузить данные.', e);
      lastId = null; lastD = null;
      if (view) view.innerHTML = errorHtml(e);
    } finally {
      setUpdating(false);
    }
  }

  // ------------------------------------------------------- фильтры (модалка)
  // Общая модалка с панелью слоёв/вкладкой «Отчёты» (SettingsForm.openSettings,
  // см. js/settings-form.js) — до 2026-08-24 у дашборда была своя независимая
  // копия той же модалки/form-walker'а (#dashSettingsOverlay,
  // ensureModal/openSettings/collectValues/enhanceMultiSelects/applyDependencies),
  // заведённая до появления settings-form.js (тогда общий form-walker жил
  // внутри замыкания map.js и не был наружу доступен) — та причина с тех пор
  // снята (SettingsForm — window-эспонированный общий модуль), см. CLAUDE.md,
  // "Settings form module".
  function openDashboardSettings() {
    SettingsForm.openSettings({
      title: 'Фильтры дашборда',
      load: () => MapAPI.getDashboardSettings(),
      save: values => MapAPI.saveDashboardSettings(values),
      onApplied: () => load()
    });
  }

  // Клики по кнопкам фильтр-строки (paint пересобирает innerHTML — вешаем делегированно
  // на стабильный #viewDashboard, один раз).
  function bindControls() {
    document.getElementById('viewDashboard').addEventListener('click', e => {
      const btn = e.target.closest('[data-dash-act]');
      if (!btn) return;
      const act = btn.dataset.dashAct;
      if (act === 'settings') { openDashboardSettings(); return; }
      if (act === 'refresh') { load(); return; }
      // Раскрыть текст исключения в карточке ошибки (см. errorHtml).
      if (act === 'error-details') {
        const pre = btn.closest('.cd-err').querySelector('.cd-err__detail');
        pre.hidden = !pre.hidden;
        btn.textContent = pre.hidden ? 'Показать подробности' : 'Скрыть подробности';
        return;
      }
      // Точка расширения для плагина: BackendPlugin.dashboardActions —
      // { <act>: (ctx) => ... }, ctx = { el, reload }. Нужна потому, что
      // делегированный обработчик живёт здесь, в ядре, а разметка (и смысл
      // кликабельных строк) — целиком в шаблоне плагина: у «Чистых дорог» это
      // переход на карту по строке подрядчика/адм. единицы, разворот урезанных
      // мобильных списков и кнопки состояния «нет данных». Ядру про них знать
      // нечего, а заводить второй слушатель на том же контейнере из плагина —
      // дублировать эту делегацию. Плагины без поля не затрагиваются.
      const actions = BackendPlugin.dashboardActions || {};
      if (typeof actions[act] === 'function') actions[act]({ el: btn, reload: load });
    });
  }

  function init() {
    // Раздел целиком отсутствует у этого бэкенда (см. контракт BackendPlugin,
    // supportsDashboard) — не делаем сетевой запрос вовсе, сразу заглушка.
    // Не путать с сетевой ошибкой (см. load()'s catch) — это разные состояния:
    // здесь известно заранее, что запроса и не будет.
    if (BackendPlugin.supportsDashboard === false) {
      document.getElementById('viewDashboard').innerHTML =
        `<div class="reports__preview-empty">Раздел недоступен для этого проекта</div>`;
      return;
    }
    bindTooltip();                  // один раз на стабильный контейнер
    bindControls();                 // делегированные клики по кнопкам строки фильтров
    // Пересчёт подгоняемых под ячейку графиков при изменении размера окна (см.
    // refit()). Дебаунс — перерисовка SVG на каждый промежуточный кадр ресайза
    // не нужна и заметно дёргается.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refit, 150);
    });
    if (BackendPlugin.dashboardDemo) {
      // Демо-данные есть не у каждого плагина (необязательное поле контракта)
      // — мгновенно рисуем демо, чтобы экран не был пустым, если оно задано.
      paint(BackendPlugin.id, BackendPlugin.dashboardDemo);
    } else {
      // Без демо-данных первый кадр — тот же скелетон, который покажет load()
      // ниже: так экран не успевает мигнуть другой заглушкой.
      document.getElementById('viewDashboard').innerHTML = skeletonHtml();
    }
    load();                         // затем подменяем реальными данными с бэка
  }

  return { init, refit, pairs, factorPairs };
})();
