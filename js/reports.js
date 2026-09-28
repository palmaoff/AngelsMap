/* =====================================================================
   Экран "Отчёты" — «Список ДТП» и «Места концентрации сводный» (map-api,
   ААКартографияВнешнееAPI: ПолучитьОтчеты/ПолучитьДанныеОтчета/
   ПолучитьНастройкиОтчета/СохранитьНастройкиОтчета). Список отчётов, их
   колонки и данные приходят с сервера — клиент не хардкодит ни состав
   отчётов, ни их поля, только рисует то, что получил (та же идея, что и
   getLayers() у слоёв: сервер — источник истины).

   Настройки (фильтры) отчёта используют ту же общую модалку
   #settingsOverlay, что и панель слоёв — см. js/settings-form.js:
   openSettings/closeSettings/applySettings, js/map.js: openLayerSettings
   (тот же паттерн descriptor {title, load, save, onApplied}).
   ===================================================================== */

const ReportsApp = (function () {

  const SVG_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  const SVG_CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const SVG_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';

  let reports = [];   // [{id, name, meta}], с сервера, см. init()
  let activeId = null;
  // Токен последнего запроса данных отчёта — тот же приём, что и у
  // MapApp.selectObject (см. map.js: selectToken): клик по отчёту B до
  // того, как ответ на отчёт A ещё не пришёл, не должен позволить более
  // раннему запросу затереть панель, если он разрешится позже.
  let loadToken = 0;
  // Последний успешно загруженный отчёт — то, что ReportExport.run() (см.
  // js/export.js) выгружает в XLSX/PDF: "выгружается то, что уже на
  // экране", без повторного запроса /report/{id}. lastBodyHtml — тело без
  // шапки предпросмотра и без .aa-tip (печатная ветка экспорта печатает
  // ровно его, не перерисовывая отчёт заново).
  let lastData = null;
  let lastBodyHtml = '';

  function render() {
    const el = document.getElementById('viewReports');
    el.innerHTML = `
      <div class="reports">
        <div class="reports__list" id="reportsListPanel">
          <div class="reports__list-inner">
            <div class="reports__list-header">
              <div class="reports__list-title">Отчёты</div>
              <button class="icon-btn" id="collapseReports" title="Свернуть">${SVG_CHEVRON_LEFT}</button>
            </div>
            <div id="reportsList"><div class="detail-empty"><p>Загрузка…</p></div></div>
          </div>
        </div>
        <div class="reports__preview" id="reportsPreview"></div>
        <button class="reveal-tab reveal-tab--left" id="revealReports" title="Отчёты">${SVG_LIST}</button>
      </div>`;

    document.getElementById('reportsList').addEventListener('click', e => {
      const settingsBtn = e.target.closest('[data-report-settings]');
      if (settingsBtn) {
        e.stopPropagation();
        openReportSettings(settingsBtn.dataset.reportSettings);
        return;
      }
      const item = e.target.closest('.report-item');
      if (item) selectReport(item.dataset.id);
    });

    // Кнопки ⟳/XLSX/PDF в шапке предпросмотра (см. renderHeader) — сама шапка
    // каждый раз перерисовывается заново внутри selectReport(), поэтому
    // слушатель, как и у #reportsList выше, вешаем один раз делегированно на
    // стабильный #reportsPreview, а не на сами кнопки.
    document.getElementById('reportsPreview').addEventListener('click', e => {
      if (e.target.closest('[data-report-refresh]') && activeId) {
        selectReport(activeId);
        return;
      }
      const exportBtn = e.target.closest('[data-report-export]');
      if (exportBtn && !exportBtn.disabled) runExport(exportBtn.dataset.reportExport);
    });

    bindTooltip();
    wireCollapse();
    renderEmptyPreview();
  }

  // Подсказки графиков rich-отчётов (см. js/rich-report.js — рисует значения
  // через data-tip, как и графики дашборда) — тот же приём, что и
  // DashboardApp.bindTooltip: один делегированный слушатель на стабильный
  // #reportsPreview (selectReport меняет только его innerHTML, включая
  // #reportsTip, поэтому tip ищем внутри обработчика каждый раз).
  function bindTooltip() {
    const preview = document.getElementById('reportsPreview');
    preview.addEventListener('mousemove', e => {
      const tip = document.getElementById('reportsTip');
      if (!tip) return;
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t) {
        tip.innerHTML = t.getAttribute('data-tip');
        tip.style.opacity = '1';
        tip.style.left = e.clientX + 'px';
        tip.style.top = e.clientY + 'px';
      } else {
        tip.style.opacity = '0';
      }
    });
    preview.addEventListener('mouseleave', () => {
      const tip = document.getElementById('reportsTip');
      if (tip) tip.style.opacity = '0';
    });
  }

  // Сворачивание списка отчётов — тот же приём (панель + reveal-таб), что и
  // у панелей «Слои»/«Подробно» на экране карты, см. js/map.js: wireCollapse.
  // Отдельная копия, а не общий хелпер: тот живёт внутри MapApp-замыкания и
  // завязан на разметку карты (position:absolute панели), не экспортируется.
  function wireCollapse() {
    const panel = document.getElementById('reportsListPanel');
    const reveal = document.getElementById('revealReports');
    document.getElementById('collapseReports').addEventListener('click', () => slidePanel(panel, reveal, true));
    reveal.addEventListener('click', () => slidePanel(panel, reveal, false));
  }

  // Раньше сворачивание/разворачивание анимировало flex-basis .reports__list
  // напрямую (см. css) — а значит .reports__preview на каждом кадре получал
  // новую ширину, и с открытым отчётом браузер каждый кадр заново
  // перекладывал и перерисовывал .report-table-wrap целиком (это отдельный
  // скроллящийся композитный слой — перерисовывается весь, не только
  // видимая часть). Понижение стоимости самой раскладки колонок
  // (table-layout:fixed) не помогло: перерисовка от алгоритма раскладки не
  // зависит, только от того, что геометрия вообще меняется на каждом кадре
  // — и это тем дороже, чем больше строк в отчёте, отсюда "рваная" анимация
  // именно на больших отчётах.
  //
  // Вместо этого список на время анимации выходит из flex-потока
  // (.reports__list--sliding, см. css) и едет только transform'ом — тот же
  // приём, что у .panel--left/--right на карте: ~240мс чистого композитинга,
  // независимо от объёма отчёта. По transitionend список возвращается в
  // обычный flex-поток в уже верном состоянии — геометрия там же, где её
  // оставил transform, поэтому видимого скачка нет.
  //
  // Один пересчёт .reports__preview (а значит, и всей таблицы отчёта) при
  // этом всё равно неизбежен — вопрос лишь в том, в каком кадре он случится.
  // Изначально он приходился на тот же кадр, в котором вешается --sliding:
  // список выходил из потока, превью тут же получало финальную ширину, и
  // браузер синхронно перекладывал таблицу (у неё table-layout:auto, т.е.
  // измерение min/max-content по всем ячейкам — см. .report-table в css) ещё
  // до первого кадра анимации. Отсюда была заметная пауза между кликом и
  // началом движения, тем длиннее, чем больше строк в отчёте.
  //
  // Поэтому на время анимации в поток, на место списка, вставляется распорка
  // (.reports__list-spacer) шириной ровно с ту, что панель занимала в потоке
  // ДО клика: 300px при сворачивании, 0 при разворачивании. Геометрия
  // .reports__preview за всю анимацию не меняется ни разу — стартовый кадр
  // стоит нулевого лэйаута, движение начинается сразу же. Распорка убирается
  // в том же transitionend-обработчике, где список возвращается в поток, под
  // уже стоящим там transition:none — тот самый единственный пересчёт
  // таблицы происходит там, после анимации, а не на её старте.
  function slidePanel(panel, reveal, collapsing) {
    const alreadyAnimating = panel.classList.contains('reports__list--sliding');
    if (panel._reportsSlideEnd) {
      panel.removeEventListener('transitionend', panel._reportsSlideEnd);
      panel.removeEventListener('transitioncancel', panel._reportsSlideEnd);
      panel._reportsSlideEnd = null;
    }
    if (!alreadyAnimating) {
      const inner = panel.querySelector('.reports__list-inner');
      // Ширина, которую панель занимает в потоке прямо сейчас (0, если она
      // свёрнута) — она же ширина распорки. Читается до смены классов: после
      // --sliding панель уже absolute, и её места в потоке больше нет.
      const flowWidth = panel.getBoundingClientRect().width;
      panel.style.width = inner.getBoundingClientRect().width + 'px';
      const spacer = document.createElement('div');
      spacer.className = 'reports__list-spacer';
      spacer.style.width = flowWidth + 'px';
      panel.insertAdjacentElement('afterend', spacer);
      panel._reportsSpacer = spacer;
      panel.classList.remove('is-collapsed');
      panel.classList.add('reports__list--sliding');
      if (!collapsing) {
        // Стартуем из состояния "уже свёрнут" — фиксируем стартовую точку
        // (за экраном, невидимо) без анимации, чтобы включить transition
        // только со следующего кадра и не дёрнуть панель в момент появления.
        panel.classList.add('reports__list--off');
        void panel.offsetWidth;
      }
    }
    // Повторный клик посреди анимации (alreadyAnimating) распорку не трогает
    // специально: она держит ровно ту геометрию превью, которая сейчас на
    // экране, а конечное состояние вернувшегося обратно списка с ней как раз
    // совпадает — то есть и в этом случае пересчёт в transitionend выйдет
    // нулевым, а не лишним.
    panel.classList.toggle('reports__list--off', collapsing);
    reveal.classList.toggle('is-visible', collapsing);

    const onEnd = e => {
      if (e.propertyName && e.propertyName !== 'transform') return;
      panel.removeEventListener('transitionend', onEnd);
      panel.removeEventListener('transitioncancel', onEnd);
      panel._reportsSlideEnd = null;
      // Пока список был вне flex-потока (position:absolute его игнорирует),
      // его базовый flex-basis:300px (см. .reports__list) физически не
      // менялся — просто не действовал. Переключая здесь is-collapsed
      // (flex-basis:0) без этой страховки, браузер увидел бы это как
      // настоящее изменение значения и запустил бы ещё один, уже старый
      // flex-basis-transition поверх только что доехавшего transform —
      // список видимо разворачивался бы и сворачивался второй раз.
      // transition:none на один кадр гасит его; кадром позже снимаем, чтобы
      // следующее сворачивание/разворачивание анимировалось как обычно.
      // Под этим же transition:none снимается и распорка — её удаление и
      // есть тот единственный момент, когда .reports__preview меняет ширину.
      panel.style.transition = 'none';
      panel.classList.remove('reports__list--sliding', 'reports__list--off');
      panel.style.width = '';
      if (panel._reportsSpacer) {
        panel._reportsSpacer.remove();
        panel._reportsSpacer = null;
      }
      panel.classList.toggle('is-collapsed', collapsing);
      void panel.offsetWidth;
      panel.style.transition = '';
    };
    panel._reportsSlideEnd = onEnd;
    panel.addEventListener('transitionend', onEnd);
    panel.addEventListener('transitioncancel', onEnd);
  }

  function renderList() {
    const list = document.getElementById('reportsList');
    list.innerHTML = reports.map(r => `
      <div class="report-item" data-id="${escapeHtml(r.id)}">
        <div class="report-item__text">
          <span class="report-item__name">${escapeHtml(r.name)}</span>
          <span class="report-item__meta">${escapeHtml(r.meta)}</span>
        </div>
        <button class="report-item__settings" data-report-settings="${escapeHtml(r.id)}"
          title="Настройки отчёта «${escapeHtml(r.name)}»">${SVG_GEAR}</button>
      </div>`).join('');
  }

  function renderEmptyPreview() {
    document.getElementById('reportsPreview').innerHTML =
      `<div class="reports__preview-empty">Выберите отчёт слева</div>`;
  }

  async function selectReport(id) {
    activeId = id;
    document.querySelectorAll('#reportsList .report-item').forEach(el => {
      el.classList.toggle('is-active', el.dataset.id === id);
    });

    const preview = document.getElementById('reportsPreview');
    preview.innerHTML = `<div class="detail-empty"><p>Загрузка…</p></div>`;

    const token = ++loadToken;
    try {
      const data = await MapAPI.getReport(id);
      if (token !== loadToken) return; // пользователь успел выбрать другой отчёт
      lastData = data;
      lastBodyHtml = renderBody(data);
      preview.innerHTML = renderHeader(data) + lastBodyHtml + `<div class="aa-tip" id="reportsTip"></div>`;
    } catch (e) {
      console.error('[ReportsApp] не удалось загрузить отчёт', id, e);
      if (token === loadToken) {
        lastData = null;
        lastBodyHtml = '';
        preview.innerHTML = `<div class="reports__preview-empty">Не удалось загрузить отчёт</div>`;
      }
    }
  }

  // Кнопки выгрузки нужны, только когда в отчёте реально есть что выгружать —
  // без этого пользователь получил бы XLSX/PDF с одной шапкой и пустым телом.
  // "Есть данные" определяется так же, как отдельные renderX-функции ниже
  // решают, показывать таблицу/карточки или заглушку "нет данных": для
  // kind="rich" — хотя бы одна секция с карточками, иначе (в т.ч. для
  // kind="table"/отсутствия kind, и для любого незнакомого ядру kind, который
  // рисуется тем же REPORT_RENDERERS.table-фоллбэком, см. dispatch ниже) —
  // непустой rows.
  function hasReportData(data) {
    if (data.kind === 'rich') {
      return Array.isArray(data.sections) && data.sections.some(s => Array.isArray(s.cards) && s.cards.length);
    }
    return Array.isArray(data.rows) && data.rows.length > 0;
  }

  // Реестр рендереров отчёта по data.kind — "table" и "rich" встроены в ядро
  // (renderTable/RichReport — общие для любого бэкенда, kind="table" ещё и
  // дефолт, если сервер вовсе не прислал kind, см. dispatch ниже), сверх них
  // берётся BackendPlugin.reportRenderers (см. контракт плагина) — для
  // kind'ов, специфичных конкретному бэкенду, которых ядро не знает. У
  // accident-analysis (единственный бэкенд на сегодня) reportRenderers пуст —
  // ей хватает table/rich.
  const REPORT_RENDERERS = Object.assign({
    table: data => renderTable(data.columns, data.rows),
    rich: data => RichReport.render(data)
  }, BackendPlugin.reportRenderers || {});

  // kind="rich" (см. map-api, ААКартографияВнешнееAPI, #Область
  // ОтчетАварийностьКарточный) — карточный отчёт с таблицами/графиками вперемешку;
  // kind="table" (или отсутствует, оба встроенных в ядро отчёта его не отдают) —
  // плоская { columns, rows } таблица. Шапка общая для всех kind'ов: "N стр."
  // показываем только у построчных отчётов (table и его дефолт при отсутствии
  // kind) — третий (плагинный) kind по умолчанию НЕ обязан быть построчным,
  // поэтому условие явное ("table или нет kind"), а не "всё, что не rich".
  //
  // Разнесены на renderHeader/renderBody (а не одна renderReport(), как было
  // раньше), потому что js/export.js (ReportExport.run, см. его шапку) печатает
  // ТЕЛО отчёта как есть, без шапки предпросмотра и без #reportsTip — ему нужен
  // именно результат renderBody(), отдельно от renderHeader(), а не общая строка.
  function renderHeader(data) {
    const meta = [`${escapeHtml(data.period.begin)} — ${escapeHtml(data.period.end)}`];
    if (data.kind === 'table' || !data.kind) meta.push(`${data.rowCount} стр.`);
    meta.push(`обновлено ${escapeHtml(data.generatedAt)}`);

    // Кнопок экспорта вовсе нет, если в отчёте нечего выгружать (см.
    // hasReportData) — пустая строка, а не disabled-кнопки: тот же принцип,
    // что и с гером у слоя без settings:true (см. CLAUDE.md, "Interface").
    const exportBtns = hasReportData(data) ? ReportExport.headerButtonsHtml() : '';

    return `
      <div class="report-preview__header">
        <div>
          <div class="report-preview__title">${escapeHtml(data.title)}</div>
          <div class="report-preview__meta">${meta.join(' · ')}</div>
        </div>
        <div class="report-preview__actions">
          ${exportBtns}
          <button type="button" class="icon-btn report-preview__refresh" data-report-refresh title="Обновить">⟳</button>
        </div>
      </div>`;
  }

  function renderBody(data) {
    const render = REPORT_RENDERERS[data.kind] || REPORT_RENDERERS.table;
    return render(data);
  }

  // Блокирует обе кнопки экспорта на время генерации файла ("Готовим файл…" —
  // не только у нажатой, у обеих, см. CLAUDE.md) и восстанавливает их исходную
  // разметку (иконка + подпись) по завершении, успешном или нет. Ошибка —
  // console.error + короткое сообщение прямо в кнопках (не рушит остальной
  // экран отчёта, там уже есть рабочие данные).
  async function runExport(format) {
    if (!lastData || !activeId) return;
    const buttons = Array.from(document.querySelectorAll('#reportsPreview [data-report-export]'));
    const originals = buttons.map(b => b.innerHTML);
    buttons.forEach(b => { b.disabled = true; b.innerHTML = '<span>Готовим файл…</span>'; });
    try {
      await ReportExport.run(format, {
        reportId: activeId,
        reportName: (reports.find(r => r.id === activeId) || {}).name || lastData.title,
        data: lastData,
        bodyHtml: lastBodyHtml,
        loadSettingsHtml: () => MapAPI.getReportSettings(activeId).then(r => r.html)
      });
    } catch (e) {
      console.error('[ReportsApp] не удалось выгрузить отчёт', format, e);
      buttons.forEach(b => { b.innerHTML = '<span>Не удалось</span>'; });
      await new Promise(resolve => setTimeout(resolve, 2000));
    } finally {
      buttons.forEach((b, i) => { b.disabled = false; b.innerHTML = originals[i]; });
    }
  }

  function renderTable(columns, rows) {
    if (!rows || !rows.length) {
      return `<div class="reports__preview-empty">Нет данных за выбранный период</div>`;
    }
    const head = columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
    const body = rows.map(row => {
      const cells = columns.map(c => `<td>${formatCell(row[c.key])}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<div class="report-table-wrap"><table class="report-table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  function formatCell(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
    return escapeHtml(String(value));
  }

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
  }

  // Настройки (фильтры) отчёта — общая модалка с панелью слоёв, см. шапку
  // файла. onApplied перечитывает уже открытый отчёт с новыми фильтрами,
  // если пользователь применил настройки именно для него (а не для другого,
  // сейчас не открытого отчёта — тогда перечитывать нечего, подтянется
  // само при следующем клике по нему).
  function openReportSettings(id) {
    const meta = reports.find(r => r.id === id);
    SettingsForm.openSettings({
      title: `Настройки отчёта «${meta ? meta.name : id}»`,
      load: () => MapAPI.getReportSettings(id),
      save: values => MapAPI.saveReportSettings(id, values),
      onApplied: async () => {
        if (activeId === id) await selectReport(id);
      }
    });
  }

  async function init() {
    render();
    // Раздел целиком отсутствует у этого бэкенда (см. контракт BackendPlugin,
    // supportsReports) — не делаем сетевой запрос вовсе. Отдельное состояние
    // от сетевой ошибки ниже (catch) — то "запрос не удался", это "запроса и
    // не будет", оба должны остаться различимы.
    if (BackendPlugin.supportsReports === false) {
      document.getElementById('reportsList').innerHTML =
        `<div class="detail-empty"><p>Раздел недоступен для этого проекта</p></div>`;
      return;
    }
    try {
      reports = await MapAPI.getReports();
    } catch (e) {
      console.error('[ReportsApp] не удалось загрузить список отчётов', e);
      document.getElementById('reportsList').innerHTML =
        `<div class="layer-error">Не удалось загрузить список отчётов</div>`;
      return;
    }
    renderList();
  }

  return { init };
})();
