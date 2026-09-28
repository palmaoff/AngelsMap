/* =====================================================================
   Плагин бэкенда «Ангел: Чистые дороги» (конфигурация СодержаниеДорог,
   ../clean roads, расширение map-api → HTTPServices/MapAPI +
   CommonModules/ААКартографияВнешнееAPI) — реализация window.BackendPlugin.

   Бэкенд реализует картовую часть контракта, отчёты и дашборд — /config,
   /icons, /layers, /layer/{id}, /layer/{id}/settings (GET+POST),
   /object/{layerId}/{objectId}, /reports, /report/{id},
   /report/{id}/settings (GET+POST), /dashboard, /dashboard/settings (GET+POST),
   /dashboard/focus (POST). Ни /action, ни /heatmap, ни /import/* там нет вовсе
   — отсюда отсутствие mapCommands и supportsInsuranceImport.

   Дашборд (2026-09-22) — порт рабочего стола 1С (Отчет.РабочийСтол) во
   внешнюю карту; серверная половина лежит в #Область Дашборд того же
   ААКартографияВнешнееAPI. Шаблон — в разделе «Дашборд» ниже.

   Слои (ААКартографияВнешнееAPI.ПолучитьСлои, порядок фиксирован сервером, все 13):
     ТранспортныеСредства     point    Транспорт
     Треки                    line     Транспорт   (воспроизведение трека —
                                                    ядро включает его по id 'Треки')
     ЗоныВыполненияРабот      polygon  Работы
     АвтомобильныеДороги      line     УДС
     Заявки                   point    Работы
     АдминистративныеЕдиницы  polygon  Территория
     Маршруты                 line     Транспорт
     МестаРазмещения          point    Работы
     Мосты                    point    УДС
     Остановки                point    УДС
     ПешеходныеПереходы       point    УДС
     Светофоры                point    УДС
     ДорожныеЗнаки            point    УДС

   Подключается в index.html СРАЗУ ПОСЛЕ settings-form.js и ДО map.js.
   ===================================================================== */
window.BackendPlugin = (function () {

  // --- слои: статичные растровые иконки ---------------------------------
  // Пусто (не undefined — map.js: buildPointMarker() читает реестр напрямую,
  // по BackendPlugin.canvasIcons[meta.id]): готовых картинок под точечные
  // слои этой базы в js/icons/ нет (там только автобус/остановка
  // traffic-monitor'а и резервные НачалоТрека/КонецТрека), а все восемь
  // точечных слоёв здесь и так приходят с цветом (на объект или на слой) —
  // им подходит pointIconShapes ниже.
  // Если появится PNG/SVG-файл на слой — прописать его сюда
  // ({src, width, height, anchorX, anchorY}) и убрать слой из pointIconShapes.
  const canvasIcons = {};

  // --- слои: подложки ---------------------------------------------------
  // Полигонные слои, которые ядро при каждом показе опускает под все остальные
  // векторы (map.js: showGroup/sendGroupToBack) — как нативная карта опускает
  // АдминистративныеЕдиницы (Map_js.downLoudObjekts → layerGroup.bringToBack()).
  // Иначе район, включённый после зон выполнения работ или мест размещения,
  // перекрывает их и забирает клик.
  const backgroundLayers = ['АдминистративныеЕдиницы'];

  // --- слои: картинки объектов с сервера -------------------------------
  // true — ядро при старте берёт GET /icons (map-api, ААКартографияВнешнееAPI.
  // ПолучитьИконки): те же картинки из БиблиотекиКартинок 1С и
  // Справочник.ВидыДорожныхЗнаков.Иконка, что нативная карта получает через
  // setIcons, с ключом по полю img объекта ("ТипВыполняемыхРабот<Тип>",
  // "ЗаявкаВРаботе"/"ЗаявкаВыполнена"/"ЗаявкаПросрочена", "МостыСОтметками",
  // "ДорожныеЗнаки<Код вида>"…). Точка рисуется этой картинкой (map.js:
  // buildPointMarker), так что маркеры совпадают с картой 1С один в один.
  const serverIcons = true;

  // --- слои: векторные пиктограммы точечных слоёв -----------------------
  // ЗАПАСНОЙ вариант: работает только для объекта, чьего img нет в наборе
  // /icons (или если сам /icons не загрузился). До 2026-09-28 был основным —
  // из-за него иконки внешней карты и не совпадали с 1С (кружок цвета
  // кластера с обобщённым глифом вместо картинки 1С; у заявок пропадал
  // статус).
  // Один SVG-шаблон на слой с плейсхолдером цвета (#ЦветФона); конкретную
  // перекрашенную картинку собирает ядро (map.js: getColoredIconSrc), цвет —
  // obj.idCluster || obj.color || meta.color (см. buildPointMarker). Базовая
  // «подложка» — тот же круг 40x40, что у accident-analysis (см. его
  // pointIconShapes); различаются только глифы — по одному на слой.
  //
  // idCluster сервер шлёт у всех точечных слоёв — константа на слой, та же,
  // что в нативной форме (Кластер в ДанныеСлоя*): ТС #3C2D84, Заявки
  // #00FF00, Мосты #4918B0, Остановки #2930E3, ПешеходныеПереходы #22AEDB,
  // Светофоры #27CCBC, ДорожныеЗнаки #FFAA00. По нему же красятся секторы
  // кластеров — как в 1С.
  const pointIconShapes = {
    'ТранспортныеСредства': {
      placeholder: '#ЦветФона',
      width: 30, height: 30, anchorX: 15, anchorY: 15,
      // Грузовик (Material local_shipping, 24x24, сдвинут в центр круга) —
      // обобщённая иконка на весь парк: разбивки по типу работ здесь нет,
      // см. про поле img выше.
      svg: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
         + '<path d="M0 20C0 8.95431 8.95431 0 20 0C31.0457 0 40 8.95431 40 20C40 31.0457 31.0457 40 20 40C8.95431 40 0 31.0457 0 20Z" fill="#ЦветФона"/>'
         + '<g transform="translate(8,8)"><path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" fill="black"/></g>'
         + '</svg>'
    },
    'Заявки': {
      placeholder: '#ЦветФона',
      width: 28, height: 28, anchorX: 14, anchorY: 14,
      // Планшет с заявкой (Material assignment) — документ, а не транспорт.
      svg: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
         + '<path d="M0 20C0 8.95431 8.95431 0 20 0C31.0457 0 40 8.95431 40 20C40 31.0457 31.0457 40 20 40C8.95431 40 0 31.0457 0 20Z" fill="#ЦветФона"/>'
         + '<g transform="translate(8,8)"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" fill="black"/></g>'
         + '</svg>'
    },
    'МестаРазмещения': {
      placeholder: '#ЦветФона',
      width: 28, height: 28, anchorX: 14, anchorY: 14,
      // Склад (Material warehouse) — точки хранения запасов, у карточки остатки номенклатуры.
      svg: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
         + '<path d="M0 20C0 8.95431 8.95431 0 20 0C31.0457 0 40 8.95431 40 20C40 31.0457 31.0457 40 20 40C8.95431 40 0 31.0457 0 20Z" fill="#ЦветФона"/>'
         + '<g transform="translate(8,8)"><path d="M22 21V7L12 3L2 7v14h5v-9h10v9h5zm-11-2H9v2h2v-2zm2-3h-2v2h2v-2zm2 3h-2v2h2v-2z" fill="black"/></g>'
         + '</svg>'
    },
    'Мосты': {
      placeholder: '#ЦветФона',
      width: 28, height: 28, anchorX: 14, anchorY: 14,
      // Material foundation (арочная опора на двух пилонах) — у классического набора
      // Material Icons нет отдельного глифа «мост», это ближайший по смыслу.
      svg: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
         + '<path d="M0 20C0 8.95431 8.95431 0 20 0C31.0457 0 40 8.95431 40 20C40 31.0457 31.0457 40 20 40C8.95431 40 0 31.0457 0 20Z" fill="#ЦветФона"/>'
         + '<g transform="translate(8,8)"><path d="M19 12h3L12 3L2 12h3v3H3v2h2v3h2v-3h4v3h2v-3h4v3h2v-3h2v-2h-2v-3zM7 15v-4.81l4-3.6V15H7zm6 0V6.59l4 3.6V15h-4z" fill="black"/></g>'
         + '</svg>'
    },
    'Остановки': {
      placeholder: '#ЦветФона',
      width: 28, height: 28, anchorX: 14, anchorY: 14,
      // Автобус (Material directions_bus) — остановка общественного транспорта.
      svg: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
         + '<path d="M0 20C0 8.95431 8.95431 0 20 0C31.0457 0 40 8.95431 40 20C40 31.0457 31.0457 40 20 40C8.95431 40 0 31.0457 0 20Z" fill="#ЦветФона"/>'
         + '<g transform="translate(8,8)"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5s1.5.67 1.5 1.5s-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z" fill="black"/></g>'
         + '</svg>'
    },
    'ПешеходныеПереходы': {
      placeholder: '#ЦветФона',
      width: 28, height: 28, anchorX: 14, anchorY: 14,
      // Пешеход (Material directions_walk).
      svg: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
         + '<path d="M0 20C0 8.95431 8.95431 0 20 0C31.0457 0 40 8.95431 40 20C40 31.0457 31.0457 40 20 40C8.95431 40 0 31.0457 0 20Z" fill="#ЦветФона"/>'
         + '<g transform="translate(8,8)"><path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2s-2 .9-2 2s.9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8l2.1 2v6h2v-7.5l-2.1-2l.6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1c-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7" fill="black"/></g>'
         + '</svg>'
    },
    'Светофоры': {
      placeholder: '#ЦветФона',
      width: 28, height: 28, anchorX: 14, anchorY: 14,
      // Корпус светофора (Material traffic).
      svg: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
         + '<path d="M0 20C0 8.95431 8.95431 0 20 0C31.0457 0 40 8.95431 40 20C40 31.0457 31.0457 40 20 40C8.95431 40 0 31.0457 0 20Z" fill="#ЦветФона"/>'
         + '<g transform="translate(8,8)"><path d="M20 10h-3V8.86c1.72-.45 3-2 3-3.86h-3V4c0-.55-.45-1-1-1H8c-.55 0-1 .45-1 1v1H4c0 1.86 1.28 3.41 3 3.86V10H4c0 1.86 1.28 3.41 3 3.86V15H4c0 1.86 1.28 3.41 3 3.86V20c0 .55.45 1 1 1h8c.55 0 1-.45 1-1v-1.14c1.72-.45 3-2 3-3.86h-3v-1.14c1.72-.45 3-2 3-3.86zm-8 9a2 2 0 1 1-.001-3.999A2 2 0 0 1 12 19zm0-5a2 2 0 1 1-.001-3.999A2 2 0 0 1 12 14zm0-5a2 2 0 0 1-2-2c0-1.11.89-2 2-2a2 2 0 1 1 0 4z" fill="black"/></g>'
         + '</svg>'
    },
    'ДорожныеЗнаки': {
      placeholder: '#ЦветФона',
      width: 28, height: 28, anchorX: 14, anchorY: 14,
      // Предупреждающий треугольник (Material warning) — один глиф на весь слой,
      // разбивки по видам знаков нет (см. футер файла, п.«img»).
      svg: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">'
         + '<path d="M0 20C0 8.95431 8.95431 0 20 0C31.0457 0 40 8.95431 40 20C40 31.0457 31.0457 40 20 40C8.95431 40 0 31.0457 0 20Z" fill="#ЦветФона"/>'
         + '<g transform="translate(8,8)"><path d="M1 21h22L12 2L1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" fill="black"/></g>'
         + '</svg>'
    }
  };

  // --- слои: зум-зависимая фильтрация -----------------------------------
  // Пусто, и это не «не дошли руки»: фильтр ядра (map.js: RoadZoomFilterLayer)
  // отбирает объекты по полю obj.typeRoad, а «Чистые дороги» его не отдают —
  // Catalogs.АвтомобильныеДороги.ЗаполнитьСведенияДляКарты кладёт в JSON
  // только {id, name, dots, toolTip, color}, а вид автодороги использует лишь
  // для выбора цвета линии (зелёная федеральная / синяя региональная / жёлтая
  // местного значения). Включать тиры здесь имеет смысл только вместе с
  // правкой на сервере, добавляющей typeRoad в СведенияДляКарты.
  const zoomTiers = {};

  /* =====================================================================
     ДАШБОРД

     Шаблон для DashboardApp: контракт dashboardTemplates[id] =
     { normalize(payload) -> D, render(D, meta) -> html, fit? } (см.
     js/dashboard.js). Ключ реестра — 'clean-roads', он же BackendPlugin.id,
     он же payload.id с сервера.

     fit() объявлен ради одного места — списка контрактов: сколько строк
     влезает в остаток экрана, средствами CSS не узнать (высота строки зависит
     от шрифта и масштаба браузера, а высота карточки — от всего, что над ней),
     поэтому не поместившиеся строки прячутся после измерения в DOM — см.
     fitContracts. Остальная раскладка — обычный CSS-грид и ничего не мерит.

     dashboardDemo тоже нет: пока ответ не пришёл, ядро рисует скелетон
     загрузки (js/dashboard.js: skeletonHtml — ветка «плагин без демо-данных»),
     а не выдуманные цифры.

     Разметка — по дизайн-канвасу (артборды Main/Mobile/States). Мобильная
     раскладка получается ТЕМИ ЖЕ узлами через медиазапросы в css/styles.css
     (.cd-* , @media max-width:720px), второго набора HTML здесь нет — иначе
     два источника правды разошлись бы на первой же правке.
     ===================================================================== */

  const { esc } = ChartKit;

  // Всё форматирование чисел — на клиенте: сервер шлёт сырые значения
  // (vehicleStats.total, mileageKm, contracts.rows[].sum), проценты и ширины
  // полос считаются здесь же из них.
  const NF = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const NF_EXACT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const NF_MONEY = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Сколько строк адм. единиц/контрактов видно на 390px до «Показать ещё».
  // На десктопе класс .is-extra ни на что не влияет — урезание живёт целиком
  // в медиазапросе (см. макет Mobile: первые 3 + разворот на месте).
  const MOBILE_LIMIT = 3;

  const pctOf = (part, whole) => whole ? Math.round(part / whole * 100) : 0;

  // Подрядчик, у которого на линии меньше трети парка — в макете такая строка
  // («2 / 8») и число, и полоса красные. Порог свой, в данных признака нет.
  const LOW_PCT = 35;

  // "2026-09-01" + "2026-09-30" -> "01.09 — 30.09.2026" (год один раз, если он
  // общий у обеих дат). Режем строку по позициям символов, а не через
  // new Date(): сервер шлёт локальную дату без зоны, и Date сдвинул бы её на
  // часовой пояс браузера — 1-е число уехало бы на 31-е предыдущего месяца.
  function periodLabel(p) {
    if (!p || !p.begin || !p.end) return '';
    const cut = s => ({ y: String(s).slice(0, 4), m: String(s).slice(5, 7), d: String(s).slice(8, 10) });
    const a = cut(p.begin), b = cut(p.end);
    return a.y === b.y ? `${a.d}.${a.m} — ${b.d}.${b.m}.${b.y}`
                       : `${a.d}.${a.m}.${a.y} — ${b.d}.${b.m}.${b.y}`;
  }

  // "2026-09-22T12:40:17" -> "12:40" (чип «Обновлено …»). Та же причина не
  // звать Date, что и в periodLabel.
  const timeLabel = s => (typeof s === 'string' && s.length >= 16) ? s.slice(11, 16) : '';

  // Родовые слова адм. единиц: в колонке шириной в пару сантиметров они
  // одинаковы у всех строк и вытесняют собственно название («Городской округ
  // Северный» -> «Северный»). Полная строка остаётся в data-tip.
  const GENERIC_UNIT = /(городской округ|муниципальный округ|муниципальный район|городское поселение|сельское поселение)/ig;

  // "Городской округ Северный; Центральный муниципальный округ" -> «Северный, +1».
  // Сервер отдаёт уже склеенную строку (contracts.rows[].adminUnits/workTypes) —
  // отдельных массивов в контракте нет, поэтому режем её здесь.
  function shortList(str, stripGeneric) {
    const full = String(str || '').trim();
    if (!full) return { text: '—', full: '' };
    const parts = full.split(';').map(s => s.trim()).filter(Boolean);
    let head = parts[0];
    if (stripGeneric) head = head.replace(GENERIC_UNIT, '').replace(/\s{2,}/g, ' ').trim() || parts[0];
    const rest = parts.length - 1;
    return { text: rest > 0 ? `${head}, +${rest}` : head, full };
  }

  // Красная плашка у даты окончания: контракт заканчивается не позже конца
  // выбранного периода (в макете так помечен ГК-097 с 30.09.2026 при периоде
  // по 30.09.2026). Признака «истекает» в JSON нет — считаем сами; endDate
  // приходит готовой строкой ДД.ММ.ГГГГ, period.end — ISO.
  function isExpiring(endDate, periodEnd) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(endDate || ''));
    return !!(m && periodEnd && `${m[3]}-${m[2]}-${m[1]}` <= String(periodEnd));
  }

  function normalize(payload) {
    const vs = payload.vehicleStats || {};
    const total = vs.total || 0, day = vs.day || 0, hour = vs.hour || 0;

    const contractors = (payload.byContractor || []).map(c => ({
      id: c.id || '', name: c.name || '',
      online: c.online || 0, total: c.total || 0,
      pct: pctOf(c.online || 0, c.total || 0)
    }));
    const onlineSum = contractors.reduce((s, c) => s + c.online, 0);

    const units = (payload.byAdminUnit || []).map(u => {
      const kdm = u.kdm || {}, truck = u.truck || {};
      return {
        // Пустой id — валидная строка «В процессе определения» (ТС, которому
        // ещё не определили адм. единицу). Показываем как есть, но кликом на
        // карту не ведём: сервер такой запрос примет и снимет отбор, а строка,
        // снимающая отбор, читается как баг (см. инструкцию, Работа 3 п.3).
        id: u.id || '', name: u.name || '',
        kdmTotal: kdm.total || 0, kdmMoving: kdm.moving || 0,
        truckTotal: truck.total || 0, truckMoving: truck.moving || 0,
        online: u.online || 0
      };
    });
    const unitsTotal = units.reduce((t, u) => ({
      kdmTotal: t.kdmTotal + u.kdmTotal, kdmMoving: t.kdmMoving + u.kdmMoving,
      truckTotal: t.truckTotal + u.truckTotal, truckMoving: t.truckMoving + u.truckMoving,
      online: t.online + u.online
    }), { kdmTotal: 0, kdmMoving: 0, truckTotal: 0, truckMoving: 0, online: 0 });

    const period = payload.period || {};
    const contracts = payload.contracts || {};
    const rows = (contracts.rows || []).map(r => ({
      id: r.id || '', number: r.number || '',
      contractorName: r.contractorName || '',
      admin: shortList(r.adminUnits, true),
      work: shortList(r.workTypes, false),
      endDate: r.endDate || '',
      expiring: isExpiring(r.endDate, period.end),
      sum: r.sum || 0
    }));

    const scope = payload.contractorScope || {};
    return {
      vehicles: { total, day, hour, dayPct: pctOf(day, total) },
      mileageKm: payload.mileageKm || 0,
      workZonesKm: payload.workZonesKm || 0,
      contractors,
      // «Итого на линии 41 из 69» — сумма по колонке, а не vehicleStats.day:
      // это итог именно той таблицы, что над ним.
      contractorsTotal: { online: onlineSum, total, pct: pctOf(onlineSum, total) },
      units, unitsTotal,
      // totalSum — итог сервера по ВСЕМ строкам, не по видимым; поэтому список
      // контрактов нигде не обрезаем (кроме разворачиваемого мобильного
      // урезания), иначе «Итого» перестанет сходиться с видимым.
      contracts: { rows, totalSum: contracts.totalSum || 0 },
      scope: { active: scope.active === true, name: scope.name || '' },
      // Пусто — только когда пусты ВСЕ четыре признака сразу: один пустой блок
      // (например, нет активных контрактов) — это нормальные данные, а не
      // «данных нет».
      empty: total === 0 && contractors.length === 0 && units.length === 0 && rows.length === 0,
      meta: {
        title: 'Содержание дорог',
        period: periodLabel(period),
        generatedAt: timeLabel(payload.generatedAt)
      }
    };
  }

  // ------------------------------------------------------------- иконки
  // Стиль общий с остальными плагинами: viewBox 24x24, stroke=currentColor,
  // скруглённые концы (см. accident-analysis.js mapCommands / traffic-monitor.js).
  const I_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const I_SLIDERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
  const I_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>';
  const I_TRUCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16V6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10"/><path d="M15 9h3.6a1 1 0 0 1 .8.4l2.2 2.9a1 1 0 0 1 .4.6V16"/><circle cx="7.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/><path d="M9.5 17.5h6"/></svg>';
  const I_DAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h3v3H8z"/></svg>';
  const I_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg>';
  const I_CHART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 4 5-7 4 3"/></svg>';
  const I_ZONES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l6-3 6 3 4-2v12l-4 2-6-3-6 3z"/><path d="M10 4v14M16 7v14"/></svg>';
  const I_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.8-7 9-4.1-1.2-7-4.8-7-9V6z"/><path d="M9.5 12l1.8 1.8 3.4-3.6"/></svg>';

  // ------------------------------------------------------- строка фильтров
  // Отдельных чипов по измерениям («Подрядчики», «Адм. единицы», «Транспорт»,
  // «Виды работ», «Ещё фильтры»), как в макете, здесь НЕТ — вместо них одна
  // кнопка-шестерёнка. Причина: все они всё равно открывали одну и ту же
  // общую модалку (богатой панели из артборда Filters в клиенте нет по
  // решению в инструкции), то есть пять кнопок делали ровно одно действие и
  // занимали половину строки. Заодно снимается вопрос со счётчиками из
  // макета («Подрядчики: 5», «Виды работ: 12»): /dashboard отдаёт только
  // сводку, а что выбрано у пользователя в фильтрах — нет вовсе, так что
  // подписать чипы верными числами было нечем.
  //
  // Чип периода остаётся и открывает ту же модалку: он не столько кнопка,
  // сколько показание — за какой период посчитан экран.
  // Обработчики settings/refresh — в ядре (js/dashboard.js).
  function filterRow(D) {
    return `<div class="cd-flt">
      <span class="cd-flt__label">Период данных</span>
      <button type="button" class="cd-chip cd-chip--period" data-dash-act="settings">${I_CAL}${esc(D.meta.period || 'не задан')}</button>
      <button type="button" class="aa-flt-btn cd-flt__settings" data-dash-act="settings" title="Фильтры дашборда">${I_SLIDERS}</button>
      <span class="aa-flt-upd cd-flt__upd"><span class="cd-flt__upd-word">Обновлено </span><b class="aa-flt-upd-val">${esc(D.meta.generatedAt || '—')}</b><span class="aa-flt-spin"></span></span>
      <button type="button" class="aa-flt-btn cd-flt__refresh" data-dash-act="refresh" title="Обновить данные">${I_REFRESH}</button>
    </div>`;
  }

  // Плашка «вход подрядчиком» — при contractorScope.active. Карточку «ТС на
  // линии по подрядчикам» при этом НЕ убираем (в ней будет одна строка плюс
  // «Итого»): убрать её — сломать и сетку, и сравнимость с рабочим столом 1С.
  function scopeBanner(D) {
    if (!D.scope.active) return '';
    return `<div class="cd-scope">${I_SHIELD}<p><b>${esc(D.scope.name)}</b> — показатели и таблицы ограничены собственным парком и контрактами.</p></div>`;
  }

  // ------------------------------------------------------------- метрики
  // Паттерн .pt-kpi (иконка 38px + значение + подпись), общий с дашбордом
  // «Пассажиропоток»; третья строка-пояснение из макета — своя, .cd-kpi__sub.
  function kpiCard(icon, value, unit, label, sub, subMod) {
    return `<div class="pt-kpi">
      <span class="pt-kpi__icon">${icon}</span>
      <div class="pt-kpi__body">
        <div class="pt-kpi__value">${value}${unit ? `<span class="cd-kpi__unit">${esc(unit)}</span>` : ''}</div>
        <div class="pt-kpi__label">${esc(label)}</div>
        <div class="cd-kpi__sub${subMod ? ' ' + subMod : ''}">${sub}</div>
      </div>
    </div>`;
  }

  function kpis(D) {
    const v = D.vehicles;
    return `<div class="pt-kpis cd-kpis">
      ${kpiCard(I_TRUCK, NF.format(v.total), '', 'Всего ТС', 'в парке подрядчиков')}
      ${kpiCard(I_DAY, NF.format(v.day), '', 'За сутки', `выходили на линию · ${v.dayPct}%`)}
      ${kpiCard(I_CLOCK, NF.format(v.hour), '', 'За час', 'передают координаты', 'cd-kpi__sub--ok')}
      ${kpiCard(I_CHART, `<span data-tip="Точное значение: <b>${esc(NF_EXACT.format(D.mileageKm))}</b> км">${NF.format(D.mileageKm)}</span>`, 'км', 'Пробеги', 'за выбранный период')}
      ${kpiCard(I_ZONES, `<span data-tip="Точное значение: <b>${esc(NF_EXACT.format(D.workZonesKm))}</b> км">${NF.format(D.workZonesKm)}</span>`, 'км', 'Зоны выполнения работ', 'под действующими ГК')}
    </div>`;
  }

  // ---------------------------------------------------------- подрядчики
  // Полосы — общие .ck-hbar/.ck-hbar__track/.ck-hbar__fill из js/chart-kit.js
  // (там же, почему они HTML, а не SVG). Ширина заливки = online/total, то
  // есть доля парка ЭТОГО подрядчика, а не доля от максимума в списке:
  // подпись рядом читается как «18 из 24», и полоса должна значить то же.
  function contractorsPanel(D) {
    const t = D.contractorsTotal;
    const rows = D.contractors.map(c => {
      const low = c.pct < LOW_PCT;
      const act = c.id
        ? ` data-dash-act="focus" data-contractor-id="${esc(c.id)}" tabindex="0" role="button" title="Показать транспорт подрядчика на карте"`
        : '';
      return `<div class="cd-hrow${c.id ? ' is-clickable' : ''}"${act}>
        <div class="ck-hbar">
          <div class="ck-hbar__top">
            <span class="ck-hbar__name">${esc(c.name)}</span>
            <span class="ck-hbar__val aa-tab${low ? ' cd-low' : ''}">${NF.format(c.online)} / ${NF.format(c.total)}</span>
          </div>
          <div class="ck-hbar__track"><div class="ck-hbar__fill${low ? ' cd-low-fill' : ''}" style="width:${c.pct}%"></div></div>
        </div>
      </div>`;
    }).join('');

    return `<section class="aa-panel cd-panel">
      <h3>Транспорт на линии · подрядчики<span class="cd-panel__aside">на линии / всего</span></h3>
      <p class="cd-panel__sub">за последние 24 часа</p>
      <div class="cd-hrows">${rows || '<p class="cd-panel__sub">Нет данных по подрядчикам за период.</p>'}</div>
      <div class="cd-foot">
        <span>Итого на линии</span>
        <span class="cd-foot__val aa-tab">${NF.format(t.online)} <span class="cd-foot__dim">из ${NF.format(t.total)} · ${t.pct}%</span></span>
      </div>
    </section>`;
  }

  // ------------------------------------------------------- адм. единицы
  // Двухуровневая шапка (КДМ всего/в движении, Грузовые всего/в движении, На
  // линии) — настоящая таблица с colspan/rowspan, на 390px тот же <tr>
  // превращается медиазапросом в карточку с плитками (см. Mobile-артборд и
  // .cd-au-table в css/styles.css): data-l на ячейках — подписи плиток,
  // на десктопе они не показываются, там подписи в шапке.
  function unitsPanel(D) {
    const t = D.unitsTotal;
    const rows = D.units.map((u, i) => {
      const act = u.id
        ? ` data-dash-act="focus" data-unit-id="${esc(u.id)}" tabindex="0" role="button" title="Показать транспорт адм. единицы на карте"`
        : '';
      return `<tr class="${u.id ? 'is-clickable' : ''}${i >= MOBILE_LIMIT ? ' is-extra' : ''}"${act}>
        <td class="cd-au__name" title="${esc(u.name)}">${esc(u.name)}</td>
        <td class="aa-tab" data-l="КДМ · всего">${NF.format(u.kdmTotal)}</td>
        <td class="aa-tab cd-mv" data-l="КДМ · в движении">${NF.format(u.kdmMoving)}</td>
        <td class="aa-tab" data-l="Грузовые · всего">${NF.format(u.truckTotal)}</td>
        <td class="aa-tab cd-mv" data-l="Грузовые · в движении">${NF.format(u.truckMoving)}</td>
        <td class="aa-tab cd-au__on" data-l="На линии">${NF.format(u.online)}</td>
      </tr>`;
    }).join('');

    const hidden = Math.max(0, D.units.length - MOBILE_LIMIT);
    const more = hidden
      ? `<button type="button" class="cd-more" data-dash-act="more" data-more-label="Показать ещё ${hidden}" data-less-label="Свернуть">Показать ещё ${hidden}</button>`
      : '';

    return `<section class="aa-panel cd-panel cd-panel--units">
      <h3>Транспорт на линии · административные единицы</h3>
      <p class="cd-panel__sub">за последние 24 часа</p>
      <div class="cd-table-wrap">
        <table class="cd-table cd-au-table">
          <thead>
            <tr>
              <th rowspan="2" class="cd-au__name">Административная единица</th>
              <th colspan="2" class="cd-th-group">КДМ</th>
              <th colspan="2" class="cd-th-group">Грузовые</th>
              <th rowspan="2" class="cd-au__on">На линии</th>
            </tr>
            <tr><th>всего</th><th>в движении</th><th>всего</th><th>в движении</th></tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="6" class="cd-panel__sub">Нет данных по административным единицам за период.</td></tr>'}
            <tr class="cd-total-row">
              <td class="cd-au__name">Итого</td>
              <td class="aa-tab" data-l="КДМ · всего">${NF.format(t.kdmTotal)}</td>
              <td class="aa-tab cd-mv" data-l="КДМ · в движении">${NF.format(t.kdmMoving)}</td>
              <td class="aa-tab" data-l="Грузовые · всего">${NF.format(t.truckTotal)}</td>
              <td class="aa-tab cd-mv" data-l="Грузовые · в движении">${NF.format(t.truckMoving)}</td>
              <td class="aa-tab cd-au__on" data-l="На линии">${NF.format(t.online)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      ${more}
    </section>`;
  }

  // ------------------------------------------------------------ контракты
  // Строки НЕ кликабельны (курсор не меняем, hover-подсветки нет): карточки
  // контракта во внешней карте не существует, вести отсюда некуда — как и
  // кнопки «Открыть список» из макета (формы Справочник.Контракты здесь нет).
  // На десктопе видно не больше DESKTOP_LIMIT (5) строк, остальные доступны
  // прокруткой внутри карточки: высоту области ровно под пять строк выставляет
  // fitContracts по факту измерения в DOM. Строки при этом НЕ прячутся (раньше
  // список резался по высоте экрана классом .is-cut), поэтому «Итого» сервера
  // по всем строкам сходится с видимым и подпись «показано X из N» в подвале
  // больше не нужна.
  function contractsPanel(D) {
    const rows = D.contracts.rows.map((r, i) => `
      <tr class="${i >= MOBILE_LIMIT ? 'is-extra' : ''}">
        <td class="cd-ct__num">${esc(r.number)}</td>
        <td class="cd-ct__org" title="${esc(r.contractorName)}">${esc(r.contractorName)}</td>
        <td class="cd-ct__units cd-dim"${r.admin.full ? ` data-tip="${esc(r.admin.full)}"` : ''}>${esc(r.admin.text)}</td>
        <td class="cd-ct__work cd-dim"${r.work.full ? ` data-tip="${esc(r.work.full)}"` : ''}>${esc(r.work.text)}</td>
        <td class="cd-ct__end">${r.expiring ? `<span class="cd-badge-warn">${esc(r.endDate)}</span>` : esc(r.endDate)}</td>
        <td class="cd-ct__sum aa-tab">${esc(NF_MONEY.format(r.sum))}</td>
      </tr>`).join('');

    const hidden = Math.max(0, D.contracts.rows.length - MOBILE_LIMIT);
    const more = hidden
      ? `<button type="button" class="cd-more" data-dash-act="more" data-more-label="Все контракты" data-less-label="Свернуть">Все контракты</button>`
      : '';

    return `<section class="aa-panel cd-panel cd-panel--contracts">
      <h3>Активные контракты<span class="cd-count">${NF.format(D.contracts.rows.length)}</span></h3>
      <div class="cd-table-wrap cd-table-wrap--scroll">
        <table class="cd-table cd-ct-table">
          <thead>
            <tr>
              <th class="cd-ct__num">Номер</th>
              <th class="cd-ct__org">Подрядчик</th>
              <th class="cd-ct__units">Адм. единицы</th>
              <th class="cd-ct__work">Виды работ</th>
              <th class="cd-ct__end">Окончание</th>
              <th class="cd-ct__sum">Сумма, ₽</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6" class="cd-panel__sub">Активных контрактов за период нет.</td></tr>'}</tbody>
        </table>
      </div>
      ${more}
      <div class="cd-foot">
        <span>Итого по активным контрактам</span>
        <span class="cd-foot__val aa-tab">${esc(NF_MONEY.format(D.contracts.totalSum))} ₽</span>
      </div>
    </section>`;
  }

  // ----------------------------------------------------------- «нет данных»
  // Строку фильтров оставляем над карточкой: причина пустоты чаще всего в них,
  // и уводить пользователя от единственного органа управления незачем.
  function emptyPanel() {
    return `<section class="cd-empty">
      <span class="cd-empty__ico">${I_ZONES}</span>
      <h3>За выбранный период данных нет</h3>
      <p>Транспорт не выходил на линию либо фильтры отсекли все записи. Попробуйте расширить период или снять фильтры по подрядчикам и видам работ.</p>
      <div class="cd-empty__acts">
        <button type="button" class="cd-btn" data-dash-act="reset-filters">Сбросить фильтры</button>
        <button type="button" class="cd-btn cd-btn--primary" data-dash-act="last-7-days">Период: последние 7 дней</button>
      </div>
    </section>`;
  }

  function render(D) {
    if (D.empty) {
      return `<div class="cd-dash">${filterRow(D)}${scopeBanner(D)}${emptyPanel()}</div>`;
    }
    return `<div class="cd-dash">
      ${filterRow(D)}
      ${scopeBanner(D)}
      ${kpis(D)}
      <div class="cd-mid">${contractorsPanel(D)}${unitsPanel(D)}</div>
      ${contractsPanel(D)}
    </div>`;
  }

  // --------------------------------------------- подгонка списка контрактов
  // Хук fit() ядра (js/dashboard.js: refit) — зовётся после отрисовки, при
  // входе на вкладку «Дашборд» и по resize окна, то есть ровно тогда, когда
  // доступная высота могла измениться.
  //
  // Задача: на десктопе карточка контрактов показывает не больше пяти строк, а
  // длинный список прокручивается внутри неё. Высоту пяти строк константой в
  // CSS не задать (шрифт, масштаб браузера, перенос в ячейке), поэтому меряем
  // нижнюю границу пятой строки в DOM и ставим её как max-height прокручиваемой
  // области. Ниже пяти строк max-height не ставится вовсе — карточка тогда
  // просто по содержимому (.cd-panel--contracts flex: 0 1 auto).
  //
  // Строки НЕ прячутся: весь список достижим прокруткой, поэтому подписи
  // «показано X из N» рядом с «Итого» (она же жила в .cd-cut) больше нет.
  const NARROW = window.matchMedia('(max-width: 720px)');

  // Сколько строк контрактов видно на десктопе до прокрутки.
  const DESKTOP_LIMIT = 5;

  function fitContracts(root) {
    const panel = root && root.querySelector('.cd-panel--contracts');
    if (!panel) return;                       // экран «нет данных» или ошибка
    const wrap = panel.querySelector('.cd-table-wrap--scroll');
    const tbody = panel.querySelector('.cd-ct-table tbody');
    if (!wrap || !tbody) return;

    wrap.style.maxHeight = '';                // меряем от неограниченной высоты

    // Строка-заглушка «Активных контрактов за период нет» строкой списка не
    // считается — ограничивать там нечего.
    const rows = Array.prototype.filter.call(tbody.children,
      tr => !tr.querySelector('.cd-panel__sub'));

    // На 390px урезанием заведует медиазапрос (первые 3 + .cd-more), мерить
    // нечего: там прокручивается вся страница, а не карточка. Развёрнутое
    // состояние (.is-expanded) — тоже только мобильное.
    if (!rows.length || NARROW.matches || panel.classList.contains('is-expanded')) return;
    if (rows.length <= DESKTOP_LIMIT) return; // влезают все — ограничивать нечего

    wrap.scrollTop = 0;                       // иначе rect'ы поедут на величину прокрутки
    // В высоту попадает и «залипшая» шапка таблицы — она внутри той же области.
    const top = wrap.getBoundingClientRect().top;
    wrap.style.maxHeight =
      Math.ceil(rows[DESKTOP_LIMIT - 1].getBoundingClientRect().bottom - top) + 'px';
  }

  // ------------------------------------------------------------- действия
  // Клики раздаёт ядро через BackendPlugin.dashboardActions (см. bindControls
  // в js/dashboard.js) — делегированный слушатель на #viewDashboard там один,
  // второй такой же из плагина был бы дублированием.

  // Клик по строке подрядчика/адм. единицы: отбор пишется на сервере, затем
  // переключаемся на карту и перезапрашиваем слой ТС.
  //
  // Почему POST /dashboard/focus, а не MapAPI.saveLayerSettings: тот пишет
  // форму фильтров слоя ЦЕЛИКОМ и обнулил бы непереданные поля — клик по
  // подрядчику молча стёр бы пользователю отбор по ГРЗ, типу ТС и прочему.
  // /dashboard/focus делает merge ровно одного ключа (см. js/api.js).
  async function focusOnMap(el) {
    const contractorId = el.dataset.contractorId || '';
    const adminUnitId = el.dataset.unitId || '';
    if (!contractorId && !adminUnitId) return;   // строка без id кликабельной не рисуется
    el.classList.add('is-busy');
    try {
      await MapAPI.focusDashboard(contractorId ? { contractorId } : { adminUnitId });
      AppShell.showView('map');
      // Поднята в публичный MapApp специально ради этого вызова (см. js/map.js):
      // прежде она жила только в ctx команд карты, а команд у этого бэкенда нет.
      await MapApp.refreshLayer('ТранспортныеСредства');
    } catch (e) {
      console.warn('Дашборд: не удалось перевести карту в срез строки.', e);
    } finally {
      el.classList.remove('is-busy');
    }
  }

  // Поля формы фильтров дашборда 1С (ААКартографияВнешнееAPI.
  // ПолучитьНастройкиДашборда/СохранитьНастройкиДашборда). Пустые значения
  // всех шести — это и есть «сбросить фильтры»: отдельного эндпоинта сброса на
  // сервере нет, пустой отбор он трактует как «все».
  const EMPTY_FILTERS = {
    'ПериодС': '', 'ПериодПо': '',
    'Подрядчики': [], 'АдминистративныеЕдиницы': [],
    'ТранспортныеСредства': [], 'ТипыВыполняемыхРабот': []
  };

  // Формат — ГГГГ-ММ-ДД, ровно то, что отдаёт <input type="date"> в обычном
  // пути сохранения через SettingsForm (сервер разбирает дату по позициям
  // символов, см. там же). Собираем по локальным полям Date, а не через
  // toISOString(): тот отдаёт UTC и вечером сдвинул бы дату на сутки вперёд.
  function last7Days() {
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const to = new Date(), from = new Date();
    from.setDate(from.getDate() - 6);   // 7 дней ВКЛЮЧАЯ сегодняшний
    return Object.assign({}, EMPTY_FILTERS, { 'ПериодС': iso(from), 'ПериодПо': iso(to) });
  }

  async function applyFilters(values, btn, reload) {
    btn.classList.add('is-busy');
    try {
      await MapAPI.saveDashboardSettings(values);
      reload();
    } catch (e) {
      console.warn('Дашборд: не удалось сохранить фильтры.', e);
    } finally {
      btn.classList.remove('is-busy');
    }
  }

  const dashboardActions = {
    focus: ctx => focusOnMap(ctx.el),

    // «Все контракты» / «Показать ещё N» — разворот НА МЕСТЕ (никуда не ведёт:
    // отдельного списка контрактов в клиенте нет). Кнопка одна и только
    // мобильная (.cd-more видна лишь в медиазапросе): на десктопе урезания по
    // числу строк нет, лишние строки доступны прокруткой (см. fitContracts).
    more: ctx => {
      const panel = ctx.el.closest('.cd-panel');
      const open = panel.classList.toggle('is-expanded');
      ctx.el.textContent = open ? ctx.el.dataset.lessLabel : ctx.el.dataset.moreLabel;
      fitContracts(document.getElementById('viewDashboard'));
    },

    'reset-filters': ctx => applyFilters(EMPTY_FILTERS, ctx.el, ctx.reload),
    'last-7-days': ctx => applyFilters(last7Days(), ctx.el, ctx.reload)
  };

  return {
    id: 'clean-roads',

    // ВАЖНО: подставить реальное имя публикации 1С при деплое. RootURL
    // HTTP-сервиса расширения — 'map-api', отсюда хвост /hs/map-api/.
    // Root-relative путь работает, только пока карта опубликована на том же
    // origin, что и база (см. README, «Запуск»); иначе — абсолютный URL плюс
    // CORS на стороне 1С (ДобавитьCORSЗаголовки в HTTPServices/MapAPI уже
    // есть, как и OPTIONS на каждом шаблоне URL).
    baseUrl: '/CleanRoads/hs/map-api/',

    // Страховка на случай, если GET /config не отработал (сеть легла до
    // первого рендера). Реальные центр/зум приходят оттуда —
    // ААКартографияВнешнееAPI.ПолучитьНастройкиКарты, которая учитывает
    // административный центр пользователя. Значения ниже — системный дефолт
    // самой базы (Екатеринбург), тот же, на который откатывается
    // РаботаСГеоОбъектамиСервер.ПолучитьНастройкиРедактораКарты.
    fallbackCenter: [56.877, 60.626],
    fallbackZoom: 13,

    // Дашборд есть с 2026-09-22 (порт рабочего стола 1С, /dashboard +
    // /dashboard/settings + /dashboard/focus). Отчётов два, оба kind:"table".
    supportsDashboard: true,
    supportsReports: true,

    serverIcons,
    backgroundLayers,
    canvasIcons,
    pointIconShapes,
    zoomTiers,

    // Ключ реестра обязан совпадать и с BackendPlugin.id, и с payload.id из
    // ответа сервера — по нему ядро выбирает шаблон (см. js/dashboard.js).
    // fit — ограничение списка контрактов пятью строками (см. fitContracts),
    // остальная раскладка чисто CSS-ная. dashboardDemo нет — до ответа сервера
    // ядро рисует скелетон загрузки, а не выдуманные цифры.
    dashboardTemplates: { 'clean-roads': { normalize, render, fit: fitContracts } },

    // Клики по разметке шаблона — см. раздел «Дашборд» выше.
    dashboardActions,

    // Оба отчёта («Оценка работы транспортного средства», «Контроль
    // приоритетности выполнения работ») сервер отдаёт как kind:"table" —
    // хватает встроенного в ядро табличного рендерера.
    reportRenderers: {}

    // mapCommands: опущен — POST /action на этом бэкенде не реализован,
    //   нативных кнопок-аналогов «Построить маршрут»/«Добавить ДТП» здесь
    //   нет; в нижнем тулбаре останется только линейка.
    // supportsInsuranceImport: опущен (falsy) — /import/* только у
    //   accident-analysis.
  };
})();

/* ---------------------------------------------------------------------
   Известные расхождения с сервером на момент написания плагина
   (ничего из этого клиент починить не может — правка нужна в ../clean roads):

   1. Поля refresh (период автообновления ТС, секунды) и playback (флаг у
      слоя «Треки») сервер в /layers шлёт, а ядро их не читает: автообновления
      слоя в клиенте нет вообще, а кнопки воспроизведения рисуются по
      хардкоду layerId === 'Треки' (js/map.js: renderDetail). Совпало по имени
      слоя — работает, но не через флаг.

   2. Флаг cluster сервер не шлёт ни у одного слоя, и ядро трактует его
      отсутствие как «кластеризовать». Значит, все точечные слои идут через
      markercluster, а маркеры строятся настоящими L.marker с data-URI-иконкой
      из pointIconShapes (не canvas-веткой — см. buildPointMarker). Это
      рабочий путь; если понадобится canvas (тысячи точек), сервер должен
      начать отдавать cluster:false у слоя.

   3. Видимость слоёв завязана на функциональные опции 1С, и сервер намеренно
      строже нативной Картографии: ААКартографияВнешнееAPI.ПолучитьСлои
      проверяет 11 из 13 опций «Используются<Слой>» (все, кроме Треки и
      Заявки — у них подходящей опции нет вовсе) и просто не кладёт слой в
      ответ, если опция выключена, тогда как нативная форма Картография
      проверяет только 4 (ДорожныеЗнаки/Остановки/ПешеходныеПереходы/
      Светофоры) и остальные слои показывает безусловно. Поэтому базы
      легитимно могут расходиться — если жалуются «слоя нет на внешней карте,
      а в 1С есть», смотреть функциональную опцию в 1С, а не клиент: здесь
      чинить нечего.
   --------------------------------------------------------------------- */
