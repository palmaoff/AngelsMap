/* =====================================================================
   Общие SVG-примитивы графиков — самодельные inline-SVG чарты (без внешних
   библиотек, как и весь остальной клиент карты), общие для js/dashboard.js
   и js/rich-report.js.

   Подключается в index.html сразу после config.js — заведомо раньше обоих
   потребителей. Встроенное: перенос строк подписей (wrapLabel), усечение
   длинных названий (truncate), wide/narrow варианты (hBarChart/
   hBarGroupedChart), защита от «пончика на 100% одной категорией»
   (donutChart).

   Три необязательных расширения сигнатур — по умолчанию не активны
   (rich-report.js не выставляет ни одного, его поведение от них не зависит):
     - columnChart: элемент серии может нести свой el.series[i].color — для
       серий с СЕМАНТИЧЕСКИ разными цветами (например, «Происшествия»/
       «Пострадало»/«Погибло» в дашборде _demo.js); без него — бинарная
       accent/context-раскраска (акцент только у последней серии).
     - columnChart: el.aspect — целевое отношение ширина/высота холста, см.
       саму функцию.
     - hBarChart/hBarList: el.colors (массив) — свой цвет у каждой категории
       (как у соседнего пончика), без него — один сплошной ACCENT.
   ===================================================================== */

const ChartKit = (function () {

  // Акцент/контекст — единственная встроенная схема раскраски серий, когда
  // el.series[i].color не задан (см. columnChart) или сама серия одна (lineChart/
  // hBarGroupedChart): последняя серия — акцент ("текущий период" по конвенции),
  // остальные — фон. Для явно многоцветных данных (dashboard.js) вызывающая
  // сторона передаёт свои цвета — см. шапку модуля.
  const ACCENT = '#2a78d6';
  const CONTEXT = '#97a1b2';
  // Чернила/сетка — общие дизайн-токены графиков (были продублированы байт-в-байт
  // в dashboard.js и rich-report.js). ink — цвет крупного числа в центре пончика
  // (dashboard.js использовал T.ink, rich-report.js — тот же #1b2434 буквально).
  const T = { ink: '#1b2434', ink2: '#6a7688', muted: '#97a1b2', grid: '#e9ecf2', axis: '#d3d9e4', surf: '#ffffff' };
  // Категориальная палитра (несколько категорий одной серии — виды событий, отделы,
  // …) — проверена validate_palette.js (CVD-safe, фиксированный порядок слотов).
  const CAT = ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834'];

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  // Компактное число для тесных подписей (115 622 -> 116К) — для шаблонов
  // плагинов, где полный fmt()-текст (например, у подписей оси рядом с линиями
  // сетки) был бы избыточно широким. Полное число остаётся в data-tip/fmt()-
  // выводе легенды/таблиц — сокращается только там, где явно используется.
  const shortFmt = n => {
    const v = Math.round(n), a = Math.abs(v);
    if (a < 1000) return String(v);
    if (a < 1000000) return Math.round(v / 1000) + 'К';
    return String(Math.round(v / 100000) / 10).replace('.', ',') + 'М';
  };
  const niceMax = v => { if (v <= 0) return 10; const p = 10 ** Math.floor(Math.log10(v)), f = v / p, n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10; return n * p; };
  const flat = (cat) => String(cat).replace(/\n/g, ' ');
  // hBarChart укладывает подпись категории в фиксированный бюджет слева от бара
  // (padL-8, text-anchor="end") — SVG сам не переносит и не сокращает текст,
  // при длинном названии он вылезает за левый край viewBox и обрезается вместо
  // выхода за бар. Полное название всё равно остаётся в data-tip — здесь только
  // то, что рисуется рядом с баром.
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // 🛣/📍-чипы фильтр-строки дашборда получают уже готовую человекочитаемую
  // строку с сервера (join выбранных наименований через запятую на стороне 1С,
  // а не массив/счётчик) — при нескольких выбранных значениях эта строка легко
  // становится длиннее самого дашборда. Наличие запятой — единственный сигнал
  // "выбрано больше одного", доступный клиенту (сервер не отдаёт ни массив, ни
  // count) — единственное значение или пустое/«Все» остаются как есть.
  const chipLabel = value => {
    const v = (value || 'Все').trim();
    return v.includes(',') ? 'Выбранные' : v;
  };

  // Дельта/АППГ форматирование (текущее значение против прошлогоднего периода).
  const dstr = (c, p) => { const d = p ? (c - p) / p * 100 : 0; return { txt: (d <= 0 ? '↓ ' : '↑ ') + Math.abs(d).toFixed(1).replace('.', ',') + '%', good: d <= 0 }; };

  function seriesColor(i, n) {
    return n <= 1 ? ACCENT : (i === n - 1 ? ACCENT : CONTEXT);
  }

  // Общий блок KPI-плитки (число + подпись + дельта к АППГ) для шаблонов дашборда.
  function kpiCard(lab, cur, prev, color) {
    const d = dstr(cur, prev);
    return `<div class="dash-kpi">
      <div style="flex:1;min-width:0"><div class="dash-k-lab"><span class="dash-sw" style="background:${color}"></span>${esc(lab)}</div>
      <div class="dash-k-num tabnum">${fmt(cur)}</div></div>
      <div class="dash-k-side">АППГ ${fmt(prev)}<br><span class="dash-delta ${d.good ? 'is-good' : ''}">${d.txt}</span></div></div>`;
  }

  // Легенда серий (несколько линий/групп столбцов на одном графике) — цветной
  // квадратик + подпись, без значения (значение уже подписано прямо на графике).
  // Для легенды "категория → цвет" со значением рядом см. donutLegend ниже.
  function legend(series) {
    if (!series || series.length < 2) return '';
    return `<div class="ck-legend">${series.map((s, i) =>
      `<span class="ck-legend-item"><span class="ck-swatch" style="background:${s.color || seriesColor(i, series.length)}"></span>${esc(s.name)}</span>`
    ).join('')}</div>`;
  }

  // Разбивает подпись категории на строки под ширину группы: явный "\n" от
  // сервера уважается как есть, иначе переносится по словам при превышении
  // maxChars — длинные названия не обязаны укладываться в одну строку.
  function wrapLabel(cat, maxChars) {
    if (cat.indexOf('\n') !== -1) return cat.split('\n');
    if (cat.length <= maxChars) return [cat];
    const words = cat.split(' ');
    if (words.length < 2) return [cat];
    let line1 = '', i = 0;
    for (; i < words.length; i++) {
      const next = line1 ? line1 + ' ' + words[i] : words[i];
      if (next.length > maxChars && line1) break;
      line1 = next;
    }
    const line2 = words.slice(i).join(' ');
    return line2 ? [line1, line2] : [line1];
  }

  function columnChart(el) {
    const cats = el.categories, series = el.series;
    const n = Math.max(cats.length, 1);
    // Ширина группы (столбец + подпись) считается по контенту, а не фиксированным
    // 560/n — иначе при 7-9 категориях подписи упираются друг в друга ещё до
    // переноса строк. CHAR_W — грубая оценка ширины символа при font-size 11
    // (кириллица+латиница, system-ui); если хотя бы одна подпись переносится на
    // 2 строки, нижнее поле (m.b) увеличивается под всех.
    const CHAR_W = 6.3, MAX_CHARS_PER_LINE = 14;
    const linesByCat = cats.map(cat => wrapLabel(String(cat), MAX_CHARS_PER_LINE));
    const wrapped = linesByCat.some(lines => lines.length > 1);
    const textW = Math.max(...linesByCat.map(lines => Math.max(...lines.map(l => l.length)) * CHAR_W));
    const barsW = series.length * 16 + Math.max(0, series.length - 1) * 2;
    const gxMin = Math.max(64, textW + 14, barsW + 14);
    // t: 10 -> 20 — родного отступа не хватало под всегда видимую подпись значения
    // над самым высоким столбцом: niceMax иногда возвращает ровно фактический
    // максимум (если он сам "круглый"), тогда столбец достаёт до верхней сетки и
    // подпись без запаса обрезалась бы верхним краем viewBox.
    const m = { l: 34, r: 10, t: 20, b: wrapped ? 46 : 34 };
    const ph = 186;
    const H = m.t + ph + m.b;
    // el.aspect (необязательный) — целевое отношение ширина/высота ВСЕГО холста
    // графика, под пропорции той ячейки, в которую его кладёт вызывающая сторона.
    // Без него ширина группы определяется только контентом (gxMin) — исходное
    // поведение, на котором стоит rich-report.js: там график лежит в карточке
    // произвольной ширины, целевых пропорций у неё нет. У дашборда наоборот:
    // ячейка «Динамика по месяцам» — широкая полоса на всю правую колонку
    // (~1007×237 на 1440×900), и текстовая ширина групп давала viewBox 440×240,
    // который .dash-chart svg{width:100%;height:100%} с preserveAspectRatio="meet"
    // вписывал ПО ВЫСОТЕ, оставляя график маленьким прямоугольником по центру
    // полупустой панели (плюс max-width:560px ниже добивал остаток). Растягиваем
    // сами группы, а не картинку: масштаб шрифта/столбцов остаётся 1:1.
    const gx = el.aspect ? Math.max(gxMin, (el.aspect * H - m.l - m.r) / n) : gxMin;
    const pw = gx * n, W = pw + m.l + m.r;
    const max = niceMax(Math.max(0, ...series.flatMap(s => s.values)));
    // Потолок ширины столбца при заданном aspect чуть выше: группа там заведомо
    // широкая, и 22px в ней смотрелись бы неоправданно тонко.
    const bw = Math.min(el.aspect ? 26 : 22, (gx * 0.62) / series.length), gap = (gx - bw * series.length) / 2;
    let s = '';
    for (let t = 0; t <= 4; t++) {
      const y = m.t + ph - ph * t / 4;
      s += `<line x1="${m.l}" y1="${y}" x2="${W - m.r}" y2="${y}" stroke="${T.grid}"/>`;
      s += `<text x="${m.l - 6}" y="${y + 3}" text-anchor="end" font-size="10.5" fill="${T.muted}" class="tabnum">${fmt(Math.round(max * t / 4))}</text>`;
    }
    // Отступ от оси до первой строки подписи не зависит от wrapped — только m.b
    // (и, соответственно, запас снизу под вторую строку) меняется при переносе.
    const labelY0 = m.t + ph + 14;
    cats.forEach((cat, i) => {
      const x0 = m.l + i * gx + gap;
      series.forEach((se, j) => {
        const v = se.values[i] || 0, bh = ph * v / max, x = x0 + j * bw, y = m.t + ph - bh, c = se.color || seriesColor(j, series.length);
        s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(bw - 2, 1).toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="3" fill="${c}" data-tip="${esc(se.name)} · ${esc(flat(cat))}: <b>${fmt(v)}</b>"/>`;
        // Значение всегда видно над столбцом (не только по наведению).
        s += `<text x="${(x + Math.max(bw - 2, 1) / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="${T.ink2}" class="tabnum">${fmt(v)}</text>`;
      });
      linesByCat[i].forEach((line, li) => {
        s += `<text x="${(m.l + i * gx + gx / 2).toFixed(1)}" y="${labelY0 + li * 11}" text-anchor="middle" font-size="11" fill="${T.ink2}">${esc(line)}</text>`;
      });
    });
    s += `<line x1="${m.l}" y1="${m.t + ph}" x2="${W - m.r}" y2="${m.t + ph}" stroke="${T.axis}"/>`;
    // max-width инлайном, а не общим css-правилом — тот рассчитан на фиксированную
    // 560-viewBox и обрежет реально нужную ширину при большом числе категорий,
    // из-за чего шрифт наоборот сожмётся сильнее задуманного. Ниже 560 не
    // уменьшаем — это по-прежнему "родной" минимум для 1:1 масштаба шрифта.
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="max-width:${Math.max(560, W)}px">${s}</svg>`;
  }

  function lineChart(el) {
    // t/b расширены под подписи значений у каждой точки: без запаса верхняя
    // подпись (последняя/акцентная серия, выше точки) и нижняя (остальные серии,
    // ниже точки) обрезались бы/наезжали на подписи категорий.
    const W = 560, H = 220, m = { l: 30, r: 14, t: 18, b: 30 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const cats = el.categories, series = el.series;
    const max = niceMax(Math.max(0, ...series.flatMap(s => s.values)));
    const n = cats.length, stepX = n > 1 ? pw / (n - 1) : 0;
    let s = '';
    for (let t = 0; t <= 4; t++) {
      const y = m.t + ph - ph * t / 4;
      s += `<line x1="${m.l}" y1="${y}" x2="${W - m.r}" y2="${y}" stroke="${T.grid}"/>`;
      s += `<text x="${m.l - 6}" y="${y + 3}" text-anchor="end" font-size="10.5" fill="${T.muted}" class="tabnum">${fmt(Math.round(max * t / 4))}</text>`;
    }
    cats.forEach((cat, i) => {
      if (n > 8 && i % 2 === 1) return;
      s += `<text x="${(m.l + i * stepX).toFixed(1)}" y="${m.t + ph + 20}" text-anchor="middle" font-size="11" fill="${T.ink2}">${esc(cat)}</text>`;
    });
    series.forEach((se, j) => {
      const c = se.color || seriesColor(j, series.length);
      // Последняя серия (акцентная по умолчанию) подписывается над точкой,
      // остальные — под точкой, чтобы при сравнении текущего/предыдущего периода
      // на одной категории подписи не наезжали друг на друга.
      const isLast = j === series.length - 1;
      const pts = se.values.map((v, i) => [m.l + i * stepX, m.t + ph - ph * v / max]);
      const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      s += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      pts.forEach((p, i) => {
        s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="${c}" stroke="${T.surf}" stroke-width="2" data-tip="${esc(se.name)} · ${esc(cats[i])}: <b>${fmt(se.values[i])}</b>"/>`;
        s += `<text x="${p[0].toFixed(1)}" y="${(isLast ? p[1] - 8 : p[1] + 15).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="${T.ink2}" class="tabnum">${fmt(se.values[i])}</text>`;
      });
    });
    s += `<line x1="${m.l}" y1="${m.t + ph}" x2="${W - m.r}" y2="${m.t + ph}" stroke="${T.axis}"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${s}</svg>`;
  }

  /* hBarList — те же данные, что у hBarChart (categories/values/colors), но
     подпись НАД полосой и разметка HTML, а не SVG. Не замена hBarChart, а
     второй примитив рядом с ним: hBarChart остался как был, на нём стоит
     rich-report.js.

     Зачем подпись сверху: в hBarChart название категории делит ширину с самим
     баром — в «узком» режиме на него отведено 150px, и truncate() режет его до
     24 символов («Нарушение правил маневрирования» → «Нарушение правил
     маневрир…»). В двух соседних панелях полос дашборда (.dash-layout)
     расширять этот бюджет некуда: обе стоят в половине правой колонки. Отдельная строка под название снимает вопрос целиком.

     Зачем HTML, а не SVG: SVG-график в .dash-chart вписывается правилом
     `svg{width:100%;height:100%}` при preserveAspectRatio="meet", то есть
     МАСШТАБИРУЕТСЯ под ячейку — вместе с текстом, и с полями, когда пропорция
     ячейки не совпадает с viewBox. А пропорция здесь гуляет очень широко:
     измерено 2.6 на 1440×900 против 4.0 на 1912×897 (обе оси ячейки зависят от
     раскладки .dash-right по-разному). Ни один фиксированный viewBox под это не
     подобрать — при любом выборе на части мониторов подписи оказывались бы
     мельче/крупнее задуманного и с пустыми полями по бокам. Обычные HTML-строки
     этой проблемы не имеют вовсе: полоса тянется по ширине сама, шрифт всегда
     ровно тот, что задан в css. Прецедент в этом же ките — progressElement/
     tableElement, они тоже возвращают HTML. */
  function hBarList(el) {
    const cats = el.categories, values = el.values;
    const total = values.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...values);
    const n = cats.length;
    return `<div class="ck-hbars">${cats.map((cat, i) => {
      const v = values[i] || 0;
      const pct = total > 0 ? Math.round(v / total * 100) : 0;
      const c = el.colors ? el.colors[i % el.colors.length] : ACCENT;
      const label = fmt(v) + (total > 0 && n > 1 ? ' · ' + pct + '%' : '');
      return `<div class="ck-hbar">
        <div class="ck-hbar__top"><span class="ck-hbar__name">${esc(flat(cat))}</span><span class="ck-hbar__val tabnum">${esc(label)}</span></div>
        <div class="ck-hbar__track"><div class="ck-hbar__fill" style="width:${(v / max * 100).toFixed(1)}%;background:${c}" data-tip="${esc(flat(cat))}: <b>${fmt(v)}</b>${total > 0 ? ' (' + pct + '%)' : ''}"></div></div>
      </div>`;
    }).join('')}</div>`;
  }

  function hBarChart(el) {
    const cats = el.categories, values = el.values;
    const total = values.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...values);
    // wide: карточка с одним элементом получает всю ширину карточки от auto-fit
    // грида, но обычно капается на 560 — здесь вместо простого растяжения того же
    // viewBox (при котором раздулся бы только шрифт) у графика свой более широкий
    // viewBox с намного большим padL, т.е. реально больше места именно под
    // длинные названия слева, а не просто более крупная картинка.
    const wide = !!el.wide;
    const padL = wide ? 260 : 150, padR = 56, W = wide ? 760 : 560;
    const labelMax = wide ? 42 : 24;
    const n = cats.length, rowH = 26, gap = 6, padT = 4;
    const H = padT * 2 + n * rowH + Math.max(0, n - 1) * gap, pw = W - padL - padR;
    let s = '';
    cats.forEach((cat, i) => {
      const y = padT + i * (rowH + gap), v = values[i] || 0, bw = max > 0 ? pw * v / max : 0;
      const pct = total > 0 ? Math.round(v / total * 100) : 0;
      // el.colors — категориальная раскраска по позиции (каждая строка свой
      // цвет, как у пончика рядом) — если не задано, все строки одним ACCENT
      // (родное поведение rich-report.js).
      const c = el.colors ? el.colors[i % el.colors.length] : ACCENT;
      s += `<text x="${padL - 8}" y="${(y + rowH / 2 + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${T.ink2}">${esc(truncate(flat(cat), labelMax))}</text>`;
      s += `<rect x="${padL}" y="${y}" width="${pw}" height="${rowH}" rx="4" fill="${T.grid}"/>`;
      s += `<rect x="${padL}" y="${y}" width="${Math.max(bw, 1).toFixed(1)}" height="${rowH}" rx="4" fill="${c}" data-tip="${esc(flat(cat))}: <b>${fmt(v)}</b>${total > 0 ? ' (' + pct + '%)' : ''}"/>`;
      const label = fmt(v) + (total > 0 && n > 1 ? ' · ' + pct + '%' : '');
      s += `<text x="${(padL + Math.max(bw, 1) + 8).toFixed(1)}" y="${(y + rowH / 2 + 4).toFixed(1)}" font-size="10.5" fill="${T.ink2}" class="tabnum">${esc(label)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${s}</svg>`;
  }

  // Горизонтальная сгруппированная диаграмма — то же, что hBarChart выше, только
  // 2+ бара на категорию (одна "полоса" на категорию, бары внутри неё стоят друг
  // под другом) и ось значений снизу, а не сверху. Всегда wide (сервер выставляет
  // wide:true) — с несколькими барами на категорию и длинными названиями узкой
  // колонки грида не хватает почти никогда.
  function hBarGroupedChart(el) {
    const cats = el.categories, series = el.series;
    const nSeries = series.length;
    const wide = !!el.wide;
    const padL = wide ? 260 : 150, padR = 56, W = wide ? 760 : 560;
    const labelMax = wide ? 42 : 24;
    const barH = 18, barGap = 3, bandGap = 10, padT = 6;
    const bandH = nSeries * barH + Math.max(0, nSeries - 1) * barGap;
    const n = cats.length;
    const plotH = n * bandH + Math.max(0, n - 1) * bandGap;
    const plotBottom = padT + plotH;
    const H = plotBottom + 26;
    const pw = W - padL - padR;
    const max = niceMax(Math.max(0, ...series.flatMap(s => s.values)));
    let s = '';
    for (let t = 0; t <= 4; t++) {
      const x = padL + pw * t / 4;
      s += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${plotBottom}" stroke="${T.grid}"/>`;
      s += `<text x="${x.toFixed(1)}" y="${plotBottom + 15}" text-anchor="middle" font-size="10.5" fill="${T.muted}" class="tabnum">${fmt(Math.round(max * t / 4))}</text>`;
    }
    cats.forEach((cat, i) => {
      const bandY = padT + i * (bandH + bandGap);
      s += `<text x="${padL - 8}" y="${(bandY + bandH / 2 + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${T.ink2}">${esc(truncate(flat(cat), labelMax))}</text>`;
      series.forEach((se, j) => {
        const v = se.values[i] || 0;
        const bw = max > 0 ? pw * v / max : 0;
        const y = bandY + j * (barH + barGap);
        const c = se.color || seriesColor(j, nSeries);
        s += `<rect x="${padL}" y="${y.toFixed(1)}" width="${pw}" height="${barH}" rx="3" fill="${T.grid}"/>`;
        s += `<rect x="${padL}" y="${y.toFixed(1)}" width="${Math.max(bw, 1).toFixed(1)}" height="${barH}" rx="3" fill="${c}" data-tip="${esc(se.name)} · ${esc(flat(cat))}: <b>${fmt(v)}</b>"/>`;
        s += `<text x="${(padL + Math.max(bw, 1) + 6).toFixed(1)}" y="${(y + barH / 2 + 3.5).toFixed(1)}" font-size="10" fill="${T.ink2}" class="tabnum">${fmt(v)}</text>`;
      });
    });
    s += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${plotBottom}" stroke="${T.axis}"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="max-width:${Math.max(560, W)}px">${s}</svg>`;
  }

  // Пончик (не сектор-на-всю-заливку) для категориального part-to-whole одной
  // серии — items:[label,value][], colors:string[] (по позиции, циклически —
  // как раньше принимал dashboard.js's donut(); rich-report.js's pieChart
  // раньше всегда брал CAT по модулю индекса — вызывающая сторона там теперь
  // просто передаёт ChartKit.CAT явным аргументом, разницы в итоге нет). Число
  // в центре — сумма всех категорий (общий итог).
  const polar = (cx, cy, r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  function donutSeg(cx, cy, rO, rI, a0, a1) {
    const lg = (a1 - a0) > Math.PI ? 1 : 0;
    const [x0, y0] = polar(cx, cy, rO, a0), [x1, y1] = polar(cx, cy, rO, a1);
    const [x2, y2] = polar(cx, cy, rI, a1), [x3, y3] = polar(cx, cy, rI, a0);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${rO} ${rO} 0 ${lg} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A${rI} ${rI} 0 ${lg} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
  }
  function donutChart(items, colors) {
    const total = items.reduce((a, d) => a + d[1], 0);
    const S = 200, cx = S / 2, cy = S / 2, rO = 90, rI = 57;
    let a = 0, s = '';
    if (total <= 0) {
      s += `<circle cx="${cx}" cy="${cy}" r="${(rO + rI) / 2}" fill="none" stroke="${T.grid}" stroke-width="${rO - rI}"/>`;
    } else {
      items.forEach((d, i) => {
        const v = d[1] || 0;
        // Если эта единственная категория — 100% (все остальные 0), a1 совпал бы
        // с a0 ровно на 2π — у SVG "A"-дуги с идентичными начальной и конечной
        // точками (полный оборот) нет видимого сегмента вообще, путь рисуется "в
        // никуда" (проверено на живом кейсе — карточка с одной ненулевой
        // категорией рисовала только число в центре, без кольца). Чуть
        // недокручиваем последний сегмент до полного круга — на глаз неотличимо
        // от 100%, но начальная и конечная точки дуги перестают совпадать
        // буквально.
        const a1 = Math.min(a + 2 * Math.PI * v / total, a + 2 * Math.PI - 1e-4);
        const pct = (v / total * 100).toFixed(1).replace('.', ',');
        s += `<path d="${donutSeg(cx, cy, rO, rI, a, a1)}" fill="${colors[i % colors.length]}" stroke="${T.surf}" stroke-width="2" data-tip="${esc(flat(d[0]))}: <b>${fmt(v)}</b> (${pct}%)"/>`;
        a = a1;
      });
    }
    s += `<text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="31" font-weight="700" fill="${T.ink}" class="tabnum">${fmt(total)}</text>`;
    s += `<text x="${cx}" y="${cy + 17}" text-anchor="middle" font-size="12.5" fill="${T.muted}">всего</text>`;
    return `<svg viewBox="0 0 ${S} ${S}" preserveAspectRatio="xMidYMid meet" style="max-width:200px">${s}</svg>`;
  }

  // Легенда для donutChart (и вообще для любого "категория → цвет + значение")
  // — строки, БЕЗ обёртки-контейнера (в отличие от legend() выше): вызывающая
  // сторона сама решает, во что заворачивать — колонкой рядом с пончиком
  // (dashboard.js's .dash-dleg) или центрированным блоком под ним (rich-report.js's
  // .rr-pie-legend), см. .ck-legend-item в css/styles.css (блокируется до
  // ширины родителя внутри flex-колонки автоматически, без отдельного правила).
  function donutLegend(items, colors) {
    return items.map((d, i) => `<span class="ck-legend-item"><span class="ck-swatch" style="background:${colors[i % colors.length]}"></span><span class="ck-legend-name">${esc(flat(d[0]))}</span><span class="ck-legend-value tabnum">${fmt(d[1] || 0)}</span></span>`).join('');
  }

  function tableElement(el) {
    const head = el.headers.map(h => `<th>${esc(h)}</th>`).join('');
    const body = el.rows.map(row => {
      const isTotal = /итог|всего/i.test(row[0] || '') || /итог|всего/i.test(row[1] || '');
      return `<tr class="${isTotal ? 'rr-total' : ''}">${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`;
    }).join('');
    // wide (потенциально много строк) — без max-height/скролла, см. css .rr-table-wrap--wide.
    const wrapClass = 'report-table-wrap rr-table-wrap' + (el.wide ? ' rr-table-wrap--wide' : '');
    return `<div class="${wrapClass}"><table class="report-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  // Стопка мини-таблиц (каждая своя headers/rows/title) друг под другом внутри
  // одного элемента грида.
  function tableStackElement(el) {
    return el.tables.map(t => `<div class="rr-table-stack-item"><div class="rr-table-stack-head">${esc(t.title)}</div>${tableElement(t)}</div>`).join('');
  }

  function progressElement(el) {
    return `<div class="rr-progress">${el.items.map(it => `
      <div class="rr-progress-item">
        <div class="rr-progress-top"><span>${esc(it.label)}</span><span class="tabnum">${it.pct}%</span></div>
        <div class="rr-progress-track"><div class="rr-progress-fill" style="width:${Math.max(0, Math.min(100, it.pct))}%"></div></div>
        ${it.note ? `<div class="rr-progress-note">${esc(it.note)}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  return {
    esc, fmt, shortFmt, niceMax, truncate, flat, chipLabel, dstr, kpiCard,
    columnChart, lineChart, hBarChart, hBarList, hBarGroupedChart, donutChart, donutLegend, legend,
    tableElement, tableStackElement, progressElement,
    T, CAT
  };
})();

window.ChartKit = ChartKit;
