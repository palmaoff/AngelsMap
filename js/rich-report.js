/* =====================================================================
   Карточный отчёт (таблицы + графики вперемешку) — рендерер для отчётов
   с kind="rich" (см. js/reports.js: renderReport). Формат данных (живой
   образец — js/backends/_demo-server.js, отчёт kind:"rich"):

     { sections: [{ title, cards: [{ title, notes, elements: [
         { type:"table", headers, rows, title? } |
         { type:"table-stack", tables:[{title, headers, rows}] } |
         { type:"column"|"line", title, categories, series:[{name,values}] } |
         { type:"hbar", title, categories, values, note? } |
         { type:"hbar-grouped", title, categories, series:[{name,values}] } |
         { type:"pie", title, categories, values } |
         { type:"list", title?, items:[...] } |
         { type:"progress", items:[{label,pct,note?}] }
     ] }] }] }

   Карточка/элемент, для которого на сервере не нашлось данных за период,
   в ответе просто отсутствует — здесь не рисуется ничего "нулевого" вместо
   него, секции/карточки с пустым elements/cards просто не печатаются.

   Стиль сознательно повторяет js/dashboard.js: самодельный inline-SVG
   строками (без внешних библиотек), подсказки через data-tip + один
   делегированный слушатель на стабильный контейнер (см. reports.js:
   bindTooltip) — то же самое `.chart-tip`, что уже использует дашборд, без
   собственных per-элемент DOM-обработчиков. Сами SVG-примитивы (columnChart/
   hBarChart/donutChart/…) — в js/chart-kit.js, общие с dashboard.js (см. его
   шапку про историю слияния, 2026-08-24); этот файл — только дispatch по
   типу элемента (renderElement/renderCard/render) и формы, специфичные
   именно карточным отчётам (table/table-stack/list/progress).

   Здесь сознательно нет переключателя "показать как таблицу" на каждом
   графике и нет тёмной темы — ни того, ни другого нет в остальном
   клиенте карты (см. css/styles.css, единая светлая палитра), значение уже
   читается из data-tip по наведению, как у всех остальных графиков карты.
   ===================================================================== */

const RichReport = (function () {

  const { esc, fmt, flat, legend, columnChart, lineChart, hBarChart, hBarGroupedChart,
          donutChart, donutLegend, tableElement, tableStackElement, progressElement, CAT } = ChartKit;

  function pieItems(el) {
    return el.categories.map((c, i) => [flat(c), el.values[i] || 0]);
  }

  function renderElement(el, forceWide) {
    const title = el.title ? `<div class="rr-block-title">${esc(el.title)}</div>` : '';
    const wideCls = forceWide ? ' rr-block--wide' : '';
    // table "wide" — только снимает скролл (см. tableElement в chart-kit.js), не
    // растягивает блок на всю строку сама по себе: когда таблица делит карточку
    // с диаграммой, обе должны остаться каждая в своей колонке auto-fit грида.
    // Но когда таблица — единственный элемент данных в карточке, renderCard
    // передаёт forceWide=true, иначе таблица занимает одну узкую колонку грида,
    // а остальная ширина карточки пустует.
    if (el.type === 'table') return `<div class="rr-block${wideCls}">${title}${tableElement(el)}</div>`;
    if (el.type === 'table-stack') return `<div class="rr-block rr-table-stack${wideCls}">${tableStackElement(el)}</div>`;
    if (el.type === 'column') return `<div class="rr-block${wideCls}">${title}${legend(el.series)}${columnChart(el)}</div>`;
    if (el.type === 'line') return `<div class="rr-block${wideCls}">${title}${legend(el.series)}${lineChart(el)}</div>`;
    if (el.type === 'hbar') return `<div class="rr-block${el.wide || forceWide ? ' rr-block--wide' : ''}">${title}${hBarChart(el)}${el.note ? `<div class="rr-note">${esc(el.note)}</div>` : ''}</div>`;
    if (el.type === 'hbar-grouped') return `<div class="rr-block${el.wide || forceWide ? ' rr-block--wide' : ''}">${title}${legend(el.series)}${hBarGroupedChart(el)}</div>`;
    if (el.type === 'pie') {
      const items = pieItems(el);
      return `<div class="rr-block rr-pie-block${wideCls}">${title}${donutChart(items, CAT)}<div class="ck-legend rr-pie-legend">${donutLegend(items, CAT)}</div></div>`;
    }
    // Всегда wide (grid-column:1/-1, см. .rr-block--wide в styles.css) - список это
    // прозоподобный текст (профиль отдела, рекомендации), а не компактные данные
    // для соседней колонки грида; рядом с таблицей список должен идти отдельной
    // строкой сверху, а не втискиваться в половину ширины.
    if (el.type === 'list') return `<div class="rr-block rr-block--wide">${title}<ul class="rr-notes">${(el.items || []).map(it => `<li>${esc(it)}</li>`).join('')}</ul></div>`;
    if (el.type === 'progress') return `<div class="rr-block${wideCls}">${progressElement(el)}</div>`;
    return '';
  }

  function renderCard(card) {
    if (!card.elements || !card.elements.length) return '';
    const notes = card.notes && card.notes.length
      ? `<ul class="rr-notes">${card.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
    // "list" элементы (напр. профиль отдела) уже всегда полноширинные сами по себе
    // (см. renderElement) — их не считаем при определении, "одна ли таблица/
    // диаграмма делит карточку". Если из оставшихся элементов данных ровно один,
    // он получает forceWide, иначе auto-fit грид (.rr-card-body) оставляет под
    // ним пустую колонку вместо полной ширины.
    const dataEls = card.elements.filter(el => el.type !== 'list');
    const solo = dataEls.length === 1;
    return `<div class="rr-card">
      <div class="rr-card-head">${esc(card.title)}</div>
      ${notes}
      <div class="rr-card-body">${card.elements.map(el => renderElement(el, solo && el.type !== 'list')).join('')}</div>
    </div>`;
  }

  // data — весь ответ /report/{id} (не только .sections) — на случай, если в будущем
  // понадобится что-то из шапки (period/generatedAt); сейчас шапку рисует reports.js
  // (тот же общий header, что и у plain-табличных отчётов), render() рисует только тело.
  function render(data) {
    const sections = (data.sections || []).map(sec => {
      const cards = (sec.cards || []).map(renderCard).join('');
      if (!cards) return '';
      return `<div class="rr-section">
        ${sec.title ? `<div class="rr-section-title">${esc(sec.title)}</div>` : ''}
        ${cards}
      </div>`;
    }).join('');
    return `<div class="rr-root">${sections || '<div class="reports__preview-empty">Нет данных за выбранный период</div>'}</div>`;
  }

  return { render };
})();
