/* =====================================================================
   Выгрузка отчётов (вкладка «Отчёты», js/reports.js) в XLSX и в PDF.

   Модуль целиком клиентский — сервер не участвует ни в сборке книги, ни в
   печатном документе (ни строки на стороне 1С). Причина: клиентский JSON
   отчёта (columns/rows либо sections/cards) уже унифицирован между базами,
   а серверные экспортные модули в разных проектах на этой кодовой базе
   (accident analysis / traffic monitor / …) неизбежно разойдутся и придётся
   синхронизировать руками — экспорт поверх уже готового JSON этой проблемы
   не имеет.

   Один файл, а не три (ядро/xlsx/печать раздельно) — единица переноса в
   другой проект на этой кодовой базе должна быть «один файл + один тег
   <script>», без сопутствующих css/print-*.css и т.п.

   Два формата — принципиально разные стратегии, не варианты одного рендера:
     - XLSX собирается через SheetJS (лениво подгружаемый lib/xlsx.full.min.js,
       см. loadSheetJs ниже) из ПРОМЕЖУТОЧНОЙ МОДЕЛИ ДОКУМЕНТА (см. "Модель
       документа для XLSX"), а не из исходного JSON отчёта напрямую — Excel
       это формат данных, поэтому графики rich-отчёта (этап 2) в этой модели
       разворачиваются в обычные таблицы чисел, а не остаются картинкой.
     - PDF получается печатью браузера через скрытый <iframe> с автономным
       документом (свой <!doctype html>, свой печатный CSS строкой прямо
       здесь) — сознательно НЕ печатью текущей страницы конкретной вкладки:
       страница целиком (шапка приложения, панель списка отчётов, боковые
       кнопки) в печать попадать не должна, а любая печать через саму
       страницу тянула бы за собой её обычный css/styles.css, от которого
       печатный вид должен быть полностью изолирован (временно сломанный
       экранный стиль не должен ломать PDF, см. CLAUDE.md). В PDF отчёт
       выглядит так же, как на экране — печатается ровно тот HTML, что уже
       нарисован в предпросмотре (ctx.bodyHtml, см. ниже), карточный рендер
       заново не строится.

   Точки расширения — симметрично рендерингу отчётов (js/reports.js:
   REPORT_RENDERERS): BackendPlugin.exportProfile (см. profile() ниже) и
   BackendPlugin.reportExporters (см. exporters() ниже), оба читаются ЛЕНИВО,
   внутри вызова, а не при разборе этого файла — index.html подключает
   export.js до backends/<id>.js, полагаться на обратный порядок тегов
   нельзя, а меняющийся дважды за сессию (переключение бэкенда — ручная
   правка index.html и перезагрузка, см. CLAUDE.md) BackendPlugin в любом
   случае должен читаться заново на каждый клик, а не один раз при загрузке
   скрипта. Незнакомый kind отчёта или type элемента внутри rich-отчёта не
   считается ошибкой — молча пропускается (см. tableToSheets/exportXlsx).
   ===================================================================== */

const ReportExport = (function () {

  // ------------------------------------------------------------- профиль/реестр
  function profile() {
    return (window.BackendPlugin && BackendPlugin.exportProfile) || {};
  }

  // Встроенный экспортёр есть пока только для kind="table" — kind="rich"
  // добавляется этапом 2 (нормализация всех типов элементов rich-отчёта в
  // листы). До тех пор rich (и любой третий, незнакомый ядру kind) просто не
  // находится в реестре — exportXlsx на этот случай уже сейчас пишет пустой
  // лист с одной только шапкой документа (см. exportXlsx), а не падает и не
  // выдаёт мусор; когда этап 2 добавит сюда "rich", его xlsx-содержимое
  // появится без изменений в остальном модуле.
  const BUILTIN_EXPORTERS = {
    table: { toSheets: tableToSheets }
  };

  function exporters() {
    return Object.assign({}, BUILTIN_EXPORTERS, (window.BackendPlugin && BackendPlugin.reportExporters) || {});
  }

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
  }

  // ------------------------------------------------------------- шапка документа
  // Общая для обоих форматов часть (см. CLAUDE.md, "Экспорт отчётов"): органи-
  // зация (необязательна, из exportProfile), название отчёта, период, строка
  // отбора (см. buildFilterLine ниже), дата формирования. Возвращается как
  // структура {org,title,period,filter,generated}, а не готовая строка/HTML —
  // XLSX и PDF показывают эти же пять фактов по-разному (плоский список строк
  // в книге против заголовка с визуальной иерархией в печатном документе).
  function collectHeaderParts(ctx, filterLine) {
    const p = profile();
    const period = ctx.data.period;
    return {
      org: p.orgTitle || '',
      title: ctx.data.title || ctx.reportName || '',
      period: period && (period.begin || period.end) ? `${period.begin || ''} — ${period.end || ''}` : '',
      filter: filterLine || '',
      generated: ctx.data.generatedAt ? `Сформирован: ${ctx.data.generatedAt}` : ''
    };
  }

  function headerPartsToLines(parts) {
    return [parts.org, parts.title, parts.period, parts.filter, parts.generated].filter(Boolean);
  }

  function headerPartsToHtml(parts) {
    const rows = [];
    if (parts.org) rows.push(`<div class="exp-h__org">${escapeHtml(parts.org)}</div>`);
    rows.push(`<div class="exp-h__title">${escapeHtml(parts.title)}</div>`);
    [parts.period, parts.filter, parts.generated].filter(Boolean).forEach(line => {
      rows.push(`<div class="exp-h__line">${escapeHtml(line)}</div>`);
    });
    return `<div class="exp-header">${rows.join('')}</div>`;
  }

  // ------------------------------------------------------------- строка отбора
  // Порядок источников (см. CLAUDE.md):
  //  1. Сервер уже прислал готовую строку в data.filterSummary — задел на
  //     будущее, сегодня её не шлёт ни одна база, но если появится — она
  //     важнее разбора формы.
  //  2. Иначе разбираем HTML формы настроек отчёта (тот же фрагмент, что
  //     показывает шестерёнка, см. js/settings-form.js/MapAPI.getReportSettings)
  //     через DOMParser — той же логикой, что и SettingsForm.applySettingsDependencies
  //     (data-show-if), но однократным проходом по статичному документу, а не
  //     живым слушателем change: значения на нём никто не меняет, это чтение,
  //     не форма.
  //  3. Запрос не удался / форма не разобралась / нет ни одного заполненного
  //     поля — строку просто не печатаем. Весь разбор — в try/catch: ошибка
  //     здесь не должна сорвать выгрузку целиком.
  function isRowVisible(doc, row) {
    const showIf = row.getAttribute('data-show-if');
    if (!showIf) return true;
    const [name, expected] = showIf.split('=');
    const field = doc.querySelector(`[name="${name}"]`);
    if (!field) return true;
    const value = field.type === 'checkbox' ? String(field.checked) : field.value;
    return value === expected;
  }

  function fieldDisplayValue(row) {
    const field = row.querySelector('[name]');
    if (!field) return null;
    if (field.type === 'checkbox') {
      return field.checked ? 'да' : null;
    }
    if (field.tagName === 'SELECT') {
      const opts = Array.from(field.selectedOptions || []);
      const text = opts.map(o => o.textContent.trim()).filter(Boolean).join(', ');
      return text || null;
    }
    const value = (field.value || '').trim();
    return value || null;
  }

  async function buildFilterLine(ctx) {
    if (ctx.data && ctx.data.filterSummary) return String(ctx.data.filterSummary);
    try {
      const html = await ctx.loadSettingsHtml();
      if (!html) return '';
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const parts = [];
      doc.querySelectorAll('.settings-form__row').forEach(row => {
        if (!isRowVisible(doc, row)) return;
        const labelEl = row.querySelector('.settings-form__label');
        const label = labelEl ? labelEl.textContent.trim() : '';
        const value = fieldDisplayValue(row);
        if (label && value) parts.push(`${label} — ${value}`);
      });
      return parts.length ? `Отбор: ${parts.join('; ')}` : '';
    } catch (e) {
      console.error('[ReportExport] не удалось построить строку отбора, выгрузка продолжится без неё', e);
      return '';
    }
  }

  // ------------------------------------------------------------- имя файла
  // "<data.title>_<period.begin>-<period.end>.<ext>" по умолчанию, кириллица
  // сохраняется как есть — переносим на диск/в буфер отправки только те
  // символы, что реально запрещены в имени файла на целевых ОС.
  function sanitizeFileNamePart(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/_+/g, '_')
      .trim();
  }

  function defaultFileName(ctx) {
    const title = ctx.data.title || ctx.reportName || 'Отчёт';
    const period = ctx.data.period;
    const periodPart = period && (period.begin || period.end) ? `_${period.begin || ''}-${period.end || ''}` : '';
    return sanitizeFileNamePart(`${title}${periodPart}`).slice(0, 150);
  }

  function fileNameBase(ctx) {
    const p = profile();
    if (typeof p.fileName === 'function') {
      try {
        const name = p.fileName(ctx);
        if (name) return sanitizeFileNamePart(name).slice(0, 150);
      } catch (e) {
        console.error('[ReportExport] exportProfile.fileName упал, используем имя по умолчанию', e);
      }
    }
    return defaultFileName(ctx);
  }

  // ==============================================================================
  //  XLSX-ветка
  // ==============================================================================

  // ---------------------------------------------------------- типы ячеек
  // Значение-число из JSON -> числовая ячейка (иначе Excel не просуммирует
  // колонку). Булево -> "Да"/"Нет" тем же правилом, что formatCell в
  // reports.js. Строка -> текстовая, кроме случая, когда она ЦЕЛИКОМ (полное
  // совпадение регулярным выражением, без лишних символов вокруг) выглядит
  // как дд.мм.гггг или гггг-мм-дд — тогда пишем настоящую дату Excel, чтобы
  // колонка сортировалась/фильтровалась как даты, а не как текст. Необяза-
  // тельное серверное поле колонки type ("date"|"number"|"string") важнее
  // этой эвристики, если оно есть (сегодня его не шлёт ни одна база — задел
  // на случай, когда сервер знает тип точнее, чем можно угадать по строке).
  const DATE_RE_DMY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
  const DATE_RE_YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

  function parseDate(str) {
    let d, m, y;
    const dmy = DATE_RE_DMY.exec(str);
    const ymd = dmy ? null : DATE_RE_YMD.exec(str);
    if (dmy) { d = +dmy[1]; m = +dmy[2]; y = +dmy[3]; }
    else if (ymd) { y = +ymd[1]; m = +ymd[2]; d = +ymd[3]; }
    else return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    // Date.UTC сам "переносит" 31 февраля на март — проверяем, что введённые
    // компоненты пережили нормализацию без изменений, иначе это не дата.
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return date;
  }

  function formatDateDMY(date) {
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${date.getUTCFullYear()}`;
  }

  function cellForValue(value, columnType) {
    if (value === null || value === undefined || value === '') return '';
    if (columnType === 'number') {
      const n = Number(value);
      return Number.isNaN(n) ? String(value) : n;
    }
    if (columnType === 'string') return String(value);
    if (columnType === 'date') {
      return parseDate(String(value)) || String(value);
    }
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
    const str = String(value);
    return parseDate(str) || str;
  }

  // ---------------------------------------------------------- модель документа
  // Отчёт любого вида приводится к промежуточной модели { sheets: [ { name,
  // blocks: [...] } ] } — она, а не исходный JSON отчёта, попадает в книгу
  // (см. sheetFromModel ниже). kind="table" — всегда один лист с одним
  // блоком-таблицей; kind="rich" (этап 2) даст лист на секцию и несколько
  // блоков на лист (заголовок карточки, затем её элементы) — форма модели
  // уже рассчитана на это (block.type: 'table' | 'text'), хотя пока эту
  // модель строит только tableToSheets.
  function tableToSheets(data) {
    const columns = data.columns || [];
    const rows = data.rows || [];
    return [{
      name: 'Отчёт',
      blocks: [{
        type: 'table',
        title: null,
        headers: columns.map(c => c.label),
        rows: rows.map(row => columns.map(c => cellForValue(row[c.key], c.type)))
      }]
    }];
  }

  // ---------------------------------------------------------- сборка листа
  // headerLines непустой ТОЛЬКО у первого листа книги (см. exportXlsx) —
  // шапка документа печатается один раз на весь экспорт, а не на каждом
  // листе многостраничного (rich) отчёта.
  function buildSheetAOA(headerLines, sheet) {
    const aoa = [];
    const bold = []; // [row, col] — заголовки блоков/карточек и шапки таблиц

    headerLines.forEach(line => aoa.push([line]));
    if (headerLines.length) aoa.push([]);

    (sheet.blocks || []).forEach((block, i) => {
      if (i > 0) aoa.push([]); // пустая строка между блоками
      if (block.title) {
        bold.push([aoa.length, 0]);
        aoa.push([block.title]);
      }
      if (block.type === 'table') {
        const headerRow = aoa.length;
        aoa.push((block.headers || []).slice());
        (block.headers || []).forEach((_, c) => bold.push([headerRow, c]));
        (block.rows || []).forEach(row => aoa.push(row.slice()));
      } else if (block.type === 'text') {
        (block.items || []).forEach(item => aoa.push([item]));
      }
      // незнакомый block.type молча пропускается (см. шапку файла)
    });

    return { aoa, bold };
  }

  // Ширина колонки — по максимальной длине содержимого среди всех строк
  // листа (включая шапку документа — тем же самым "потолком", ей это не
  // вредит), с потолком ~60 символов, чтобы одна длинная строка не растянула
  // колонку на пол-экрана.
  function computeColWidths(aoa) {
    const widths = [];
    aoa.forEach(row => {
      row.forEach((cell, c) => {
        const text = cell instanceof Date ? formatDateDMY(cell) : String(cell == null ? '' : cell);
        const len = Math.min(60, text.length);
        widths[c] = Math.max(widths[c] || 8, len);
      });
    });
    return widths.map(w => ({ wch: w + 2 }));
  }

  function sheetFromModel(headerLines, sheet, XLSX) {
    const { aoa, bold } = buildSheetAOA(headerLines, sheet);
    const ws = XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [['']], { cellDates: true });
    bold.forEach(([r, c]) => {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cell = ws[ref];
      if (cell) cell.s = { font: { bold: true } };
    });
    // aoa_to_sheet(..., {cellDates:true}) сам распознаёт JS Date в массиве и
    // проставляет t:'d', но без числового формата (по умолчанию ISO) — явно
    // задаём привычный dd.mm.yyyy тем же проходом.
    Object.keys(ws).forEach(ref => {
      if (ref[0] === '!') return;
      const cell = ws[ref];
      if (cell && cell.t === 'd') cell.z = 'dd.mm.yyyy';
    });
    ws['!cols'] = computeColWidths(aoa);
    return ws;
  }

  // Имя листа Excel не может содержать : \ / ? * [ ], ограничено 31 символом,
  // и не может повторяться в одной книге — санитизация + суффикс на дубли.
  // Для kind="table" не задействуется (имя листа фиксированное "Отчёт", в
  // книге всегда один лист), но нужна уже сейчас: используется тем же кодом,
  // что этап 2 будет вызывать для листов-секций rich-отчёта, без переделки.
  function sanitizeSheetName(name, used) {
    let n = String(name || '').replace(/[:\\/?*[\]]/g, '').trim();
    if (!n) n = 'Лист';
    n = n.slice(0, 31);
    if (!used.has(n)) { used.add(n); return n; }
    let i = 2, unique;
    do {
      const suffix = ` (${i++})`;
      unique = n.slice(0, 31 - suffix.length) + suffix;
    } while (used.has(unique));
    used.add(unique);
    return unique;
  }

  // ---------------------------------------------------------- ленивый SheetJS
  // Библиотека грузится по первому клику "Выгрузить в XLSX" в любом отчёте за
  // сессию, а не тегом в index.html — большинство сессий отчёт вообще не
  // выгружает. Промис кэшируется, чтобы повторные клики (в этом же или другом
  // отчёте) не подгружали её повторно.
  let sheetJsPromise = null;
  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (sheetJsPromise) return sheetJsPromise;
    const src = profile().sheetJsUrl || 'lib/xlsx.full.min.js';
    sheetJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => {
        sheetJsPromise = null; // повторный клик пусть попробует ещё раз, а не застревает на провалившемся промисе
        reject(new Error(`Не удалось загрузить библиотеку SheetJS (${src})`));
      };
      document.head.appendChild(script);
    });
    return sheetJsPromise;
  }

  async function exportXlsx(ctx) {
    const XLSX = await loadSheetJs();
    const filterLine = await buildFilterLine(ctx);
    const headerLines = headerPartsToLines(collectHeaderParts(ctx, filterLine));

    const kind = ctx.data.kind || 'table';
    const exporter = exporters()[kind];
    // Незнакомый kind (в т.ч. "rich" до этапа 2) — не ошибка: лист с одной
    // только шапкой документа, без блоков (см. шапку файла).
    const sheetsModel = exporter ? exporter.toSheets(ctx.data) : [{ name: 'Отчёт', blocks: [] }];

    const wb = XLSX.utils.book_new();
    const usedNames = new Set();
    (sheetsModel.length ? sheetsModel : [{ name: 'Отчёт', blocks: [] }]).forEach((sheet, i) => {
      const ws = sheetFromModel(i === 0 ? headerLines : [], sheet, XLSX);
      XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(sheet.name, usedNames));
    });

    XLSX.writeFile(wb, `${fileNameBase(ctx)}.xlsx`, { cellStyles: true });
  }

  // ==============================================================================
  //  Печатная ветка (PDF)
  // ==============================================================================

  // Печатный CSS — свой, не css/styles.css (см. шапку файла, "изоляция —
  // именно то, что делает модуль переносимым"). Правила для .report-table
  // здесь — адаптированная копия из css/styles.css (без .report-table-wrap
  // скролла, с повтором шапки таблицы на каждой печатной странице); .rr-*/
  // .ck-* (карточные rich-отчёты) добавляются этапом 2 — до тех пор печать
  // rich-отчёта покажет ctx.bodyHtml без специальной подгонки под печать.
  //
  // @page сознательно НЕ указывает size (книжная/альбомная) — ориентацию
  // выбирает сам пользователь в диалоге печати. Раньше здесь было "landscape
  // при columns.length > 7", но это ломалось именно там, где чаще всего и
  // нужно: печатный документ уже свёрстан браузером под одну ориентацию (ту,
  // что задал @page), а если пользователь (или принтер по умолчанию) в
  // диалоге печати всё равно выставляет другую — некоторые драйверы вывода
  // (в частности "Microsoft Print to PDF", в отличие от встроенного PDF-
  // движка Chromium/Edge) не перевёрстывают уже готовый документ под неё, а
  // просто поворачивают готовые страницы на 90°, чтобы влезть в другой лист —
  // получался повёрнутый набок текст вместо переверстки. Без принудительного
  // size пользователь сам выбирает ориентацию в диалоге ДО рендера страниц,
  // и книжная/альбомная верстается правильно в любом случае.
  function printCss() {
    return `
      @page { margin: 14mm 12mm; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 0; font: 10pt/1.4 "Segoe UI", Arial, sans-serif; color: #1b2434; }
      .exp-header { margin-bottom: 12pt; }
      .exp-h__org { font-size: 9pt; color: #6b7280; margin-bottom: 2pt; }
      .exp-h__title { font-size: 15pt; font-weight: 700; margin-bottom: 4pt; }
      .exp-h__line { font-size: 9pt; color: #4b5563; }
      /* Подсказки графиков и любые кнопки в печать не идут — на экране это
         интерактивные элементы без печатного смысла. */
      .aa-tip, button, .icon-btn, .report-preview__refresh, .report-preview__actions,
      .report-export-btn { display: none !important; }
      .report-table-wrap { border: none; overflow: visible !important; }
      table.report-table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
      /* Перенос длинного текста в ячейке — парная правка к отказу от
         white-space: nowrap в css/styles.css (см. там же комментарий к
         .report-table). Экранные min-width/max-width сюда сознательно НЕ
         переносятся: на бумаге нет горизонтального скролла, ширина страницы
         фиксирована, и пол в 70px на колонку просто вытолкнул бы широкую
         таблицу за край листа вместо переноса. Остаётся только break-word —
         он удерживает внутри ячейки длинные «слова» без пробелов (VIN, номер
         постановления), которые иначе вылезли бы за её границу. */
      .report-table th, .report-table td { padding: 4pt 6pt; border: 1px solid #d0d4dc; text-align: left; vertical-align: top; overflow-wrap: break-word; }
      .report-table thead { display: table-header-group; } /* шапка таблицы повторяется на каждой странице */
      .report-table thead th { background: #eef1f7; font-weight: 700; }
      .report-table tbody tr:nth-child(even) { background: #f7f8fb; }
    `;
  }

  function buildPrintDocument(parts, bodyHtml) {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
      `<style>${printCss()}</style></head><body>` +
      headerPartsToHtml(parts) + bodyHtml + `</body></html>`;
  }

  // Скрытый iframe создаётся один раз за сессию и переиспользуется на каждый
  // клик "Выгрузить в PDF" (в т.ч. для разных отчётов) — не пересоздаём его
  // на каждый экспорт. После print() его НЕЛЬЗЯ трогать сразу же — в части
  // браузеров запись нового документа в тот же iframe прямо во время ещё
  // идущего диалога печати обрывает саму печать, поэтому очистка отложена на
  // событие afterprint, со страховочным таймаутом на случай, если оно не
  // придёт (пользователь закрыл диалог печати способом, который его не
  // генерирует, — такое встречается в отдельных браузерах).
  let printFrame = null;
  function getPrintFrame() {
    if (!printFrame) {
      printFrame = document.createElement('iframe');
      printFrame.style.cssText = 'position:fixed; left:0; top:0; width:0; height:0; border:0; visibility:hidden;';
      document.body.appendChild(printFrame);
    }
    return printFrame;
  }
  function resetPrintFrame() {
    if (!printFrame) return;
    try {
      printFrame.contentWindow.document.open();
      printFrame.contentWindow.document.write('');
      printFrame.contentWindow.document.close();
    } catch (e) { /* iframe мог быть уже удалён из DOM извне — не критично */ }
  }

  async function exportPdf(ctx) {
    const filterLine = await buildFilterLine(ctx);
    const parts = collectHeaderParts(ctx, filterLine);

    const kind = ctx.data.kind || 'table';
    const exporter = exporters()[kind];
    // toPrintHtml — необязательный метод экспортёра (см. контракт reportExporters
    // в CLAUDE.md); по умолчанию печатаем ровно то, что уже нарисовано на
    // экране (ctx.bodyHtml) — так печать не зависит от того, зарегистрирован
    // ли экспортёр для этого kind вообще (незнакомый kind печатается так же).
    const bodyHtml = (exporter && typeof exporter.toPrintHtml === 'function')
      ? exporter.toPrintHtml(ctx.data)
      : ctx.bodyHtml;

    const doc = buildPrintDocument(parts, bodyHtml);

    const frame = getPrintFrame();
    const win = frame.contentWindow;
    win.document.open();
    win.document.write(doc);
    win.document.close();

    win.focus();
    win.print();

    const cleanup = () => resetPrintFrame();
    win.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(cleanup, 60000);
  }

  // ==============================================================================
  //  Публичный интерфейс
  // ==============================================================================

  const SVG_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><line x1="4" y1="21" x2="20" y2="21"/></svg>';
  const FORMAT_LABEL = { xlsx: 'XLSX', pdf: 'PDF' };

  // exportProfile.formats — необязательный список форматов для этого бэкенда
  // (по умолчанию оба); кнопка формата, которого в списке нет, не рисуется
  // вовсе, а не рисуется disabled — то же "поле отсутствует -> фичи нет",
  // что у mapCommands/dashboardDemo (см. CLAUDE.md, "Backend plugins").
  function headerButtonsHtml() {
    const formats = profile().formats || ['xlsx', 'pdf'];
    return ['xlsx', 'pdf']
      .filter(f => formats.includes(f))
      .map(f => `<button type="button" class="report-export-btn" data-report-export="${f}" title="Выгрузить в ${FORMAT_LABEL[f]}">${SVG_DOWNLOAD}<span>${FORMAT_LABEL[f]}</span></button>`)
      .join('');
  }

  async function run(format, ctx) {
    if (format === 'xlsx') return exportXlsx(ctx);
    if (format === 'pdf') return exportPdf(ctx);
    throw new Error(`ReportExport.run: неизвестный формат "${format}"`);
  }

  return { headerButtonsHtml, run };
})();

window.ReportExport = ReportExport;
