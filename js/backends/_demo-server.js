/* =====================================================================
   Демо-«сервер» — бэкенд внутри браузера для js/backends/_demo.js.

   Отвечает ровно на тот же HTTP-контракт, что реализуют map-api/ настоящих
   1С-баз (/config, /icons, /layers, /layer/{id}, /layer/{id}/settings,
   /object/{layerId}/{objectId}, /heatmap, /dashboard, /dashboard/settings,
   /reports, /report/{id}, /report/{id}/settings) плюс один «собственный»
   эндпоинт плагина (GET /geo/where — его зовёт команда карты «Что здесь?»
   через ctx.getJSON, как accident-analysis зовёт /route/hotspots). Сеть не
   используется: js/api.js видит BackendPlugin.mockApi и отдаёт запрос
   обработчику из ROUTES ниже (см. api.js: mockRequest).

   Файл — это «сторона 1С», а не часть клиента: всё, что здесь, в реальном
   проекте делает сервер (генерирует данные, хранит фильтры пользователя,
   собирает HTML форм и панели «Подробно»). Новому проекту на этом ядре файл
   не нужен — см. шапку _demo.js, «Как начать новый проект».

   Данные синтетические, но детерминированные (свой PRNG с фиксированным
   seed) — при каждой загрузке одна и та же картинка. Город условный, с
   центром в Москве; расстояния в км пересчитываются в градусы грубо (для
   демо точности хватает).

   Фильтры (настройки слоёв/дашборда/отчётов) «сервер» хранит в
   sessionStorage — переживают перезагрузку вкладки, как у настоящей базы
   переживают перезаход, и сбрасываются при закрытии вкладки.

   Каждый слой нарочно упражняет свою ветку ядра (см. таблицу в CLAUDE.md,
   «Демо-режим»): кластеры с цветом по объекту, canvas-точки без кластеров,
   картинки с сервера с поворотом, треки с участками без маршрута и
   воспроизведением, зум-фильтр дорог, вложенные полигоны с дырой и
   эксклавом, полигоны одинарной вложенности, тепловая карта.
   ===================================================================== */

window.DemoServer = (function () {

  // ------------------------------------------------------------ утилиты
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20260928);
  const range = (a, b) => a + rnd() * (b - a);
  const int = (a, b) => Math.floor(range(a, b + 1));
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  // Взвешенный выбор: [[значение, вес], ...]
  function weighted(pairs) {
    const total = pairs.reduce((s, p) => s + p[1], 0);
    let x = rnd() * total;
    for (const [v, w] of pairs) { if ((x -= w) <= 0) return v; }
    return pairs[pairs.length - 1][0];
  }
  function guid() {
    const h = n => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
    return `${h(8)}-${h(4)}-4${h(3)}-${h(4)}-${h(12)}`;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad2 = n => String(n).padStart(2, '0');
  const isoToRu = iso => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '';
  function nowRu() {
    const d = new Date();
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function httpErr(status, text) {
    const e = new Error(text || 'Ошибка');
    e.status = status;
    return e;
  }

  // Геометрия: смещения в км от центра → [lat, lng].
  const CENTER = [55.751244, 37.618423];
  const KM_LAT = 1 / 111.2;
  const KM_LNG = 1 / (111.2 * Math.cos(CENTER[0] * Math.PI / 180));
  const r6 = x => Math.round(x * 1e6) / 1e6;
  function at(xKm, yKm) { return [r6(CENTER[0] + yKm * KM_LAT), r6(CENTER[1] + xKm * KM_LNG)]; }
  // Полярные: угол в градусах от севера по часовой стрелке.
  function polar(rKm, deg) {
    const a = deg * Math.PI / 180;
    return at(rKm * Math.sin(a), rKm * Math.cos(a));
  }
  function toKm(p) { return [(p[1] - CENTER[1]) / KM_LNG, (p[0] - CENTER[0]) / KM_LAT]; }
  function distKm(a, b) {
    const [ax, ay] = toKm(a), [bx, by] = toKm(b);
    return Math.hypot(ax - bx, ay - by);
  }
  function circleRing(centerLatLng, rKm, step = 15) {
    const [cx, cy] = toKm(centerLatLng);
    const ring = [];
    for (let d = 0; d < 360; d += step) {
      const a = d * Math.PI / 180;
      ring.push(at(cx + rKm * Math.sin(a), cy + rKm * Math.cos(a)));
    }
    ring.push(ring[0]);
    return ring;
  }

  const PALETTE = ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834', '#6a3d9a', '#b15928'];

  // ======================================================== территория
  // Граница города — «неровная окружность» R(θ); районы — центральный круг и
  // шесть кольцевых секторов между ним и границей.
  const R_CENTER = 3.5;
  const cityR = deg => { const a = deg * Math.PI / 180; return 15 + 1.6 * Math.sin(3 * a + 0.7) + 0.9 * Math.sin(5 * a + 2.1); };
  const SECTORS = ['Северный', 'Восточный', 'Юго-Восточный', 'Южный', 'Юго-Западный', 'Западный'];
  const SECTOR_START = -30;   // первый сектор — от -30° до 30° (север)

  const districts = [];       // { id, name, dots, population }
  const cityId = 'Районы_' + guid();

  // Центральный
  districts.push({ id: 'Районы_' + guid(), name: 'Центральный', population: 180000,
    dots: [[circleRing(CENTER, R_CENTER, 10)]] });
  SECTORS.forEach((name, i) => {
    const a0 = SECTOR_START + i * 60, a1 = a0 + 60;
    const ring = [];
    for (let d = a0; d <= a1; d += 3) ring.push(polar(cityR(d), d));
    for (let d = a1; d >= a0; d -= 3) ring.push(polar(R_CENTER, d));
    ring.push(ring[0]);
    const parts = [[ring]];
    // Северный — с дырой (лесопарк не входит в район); Южный — из двух частей
    // (эксклав за городом) — проверка MultiPolygon/дыр в сортировке по площади
    // и в конвертере для векторных тайлов (map.js: dotsToGeometry).
    if (name === 'Северный') parts[0].push(circleRing(polar(9, 0), 1.6, 20));
    if (name === 'Южный') parts.push([circleRing(polar(21, 185), 1.8, 20)]);
    districts.push({ id: 'Районы_' + guid(), name, population: int(90000, 260000), dots: parts });
  });

  function districtOf(p) {
    const [x, y] = toKm(p);
    const r = Math.hypot(x, y);
    let deg = Math.atan2(x, y) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    if (r <= R_CENTER) return districts[0];
    if (distKm(p, polar(21, 185)) <= 1.8) return districts.find(d => d.name === 'Южный');
    if (r > cityR(deg)) return null;
    const idx = Math.floor(((deg - SECTOR_START + 360) % 360) / 60);
    return districts[1 + idx];
  }

  const cityRing = [];
  for (let d = 0; d < 360; d += 3) cityRing.push(polar(cityR(d) + 0.35, d));
  cityRing.push(cityRing[0]);

  // Зоны работ — полигоны ОДИНАРНОЙ вложенности ([кольцо][точка]), в отличие от
  // районов ([часть][кольцо][точка]).
  const ZONE_STATUS = [['В работе', '#eda100', null], ['Планируется', '#2a78d6', '6 4'], ['Завершена', '#1baf7a', null]];
  const zones = Array.from({ length: 12 }, (_, i) => {
    const c = polar(range(4, 13), range(0, 360));
    const st = pick(ZONE_STATUS);
    const rk = range(0.45, 0.9);
    return { id: 'Зоны_' + guid(), name: `Зона работ №${i + 1}`, status: st[0], color: st[1], dashArray: st[2],
      dots: circleRing(c, rk, 60), center: c, contractor: pick(['ООО «Дорстрой»', 'АО «Горсвет»', 'МУП «Благоустройство»']) };
  });

  // ============================================================ дороги
  const ROAD_COLOR = { 'Федеральная': '#d7191c', 'Региональная': '#f28e2b', 'Местная': '#8a94a6' };
  const roads = [];
  function addRoad(name, typeRoad, pts) {
    roads.push({ id: 'Дороги_' + guid(), name, typeRoad, dots: pts, lengthKm: pts.reduce((s, p, i) => i ? s + distKm(pts[i - 1], p) : 0, 0) });
  }
  { const pts = []; for (let d = 0; d <= 360; d += 4) pts.push(polar(13.2 + 0.5 * Math.sin(4 * d * Math.PI / 180), d)); addRoad('Кольцевая автодорога', 'Федеральная', pts); }
  { const pts = []; for (let d = 0; d <= 360; d += 6) pts.push(polar(7, d)); addRoad('Второе кольцо', 'Региональная', pts); }
  [0, 45, 90, 135, 180, 225, 270, 315].forEach((deg, i) => {
    const fed = deg === 0 || deg === 180;
    const pts = [];
    for (let r = fed ? 0.4 : R_CENTER; r <= (fed ? 26 : 20); r += 0.8) pts.push(polar(r, deg + 2.5 * Math.sin(r / 2 + i)));
    addRoad(fed ? `Трасса М-${i + 1}` : `Шоссе №${i + 1}`, fed ? 'Федеральная' : 'Региональная', pts);
  });
  for (let i = 0; i < 55; i++) {
    let p = polar(range(1, 12.5), range(0, 360));
    let head = range(0, 360);
    const pts = [p];
    for (let k = int(3, 6); k > 0; k--) {
      head += range(-35, 35);
      const [x, y] = toKm(p), step = range(0.3, 0.6), a = head * Math.PI / 180;
      p = at(x + step * Math.sin(a), y + step * Math.cos(a));
      pts.push(p);
    }
    addRoad(`ул. ${pick(['Садовая', 'Лесная', 'Школьная', 'Заводская', 'Полевая', 'Речная', 'Новая', 'Мира', 'Гагарина', 'Советская'])}, ${i + 1}`, 'Местная', pts);
  }

  // ========================================================= остановки
  const stops = [];
  roads.filter(r => r.typeRoad !== 'Местная').forEach(road => {
    road.dots.forEach((p, i) => {
      if (i % 2 === 0 && distKm(p, CENTER) < 16) {
        stops.push({ id: 'Остановки_' + guid(), name: `Остановка «${road.name}, ${stops.length + 1}»`, dot: [[[p[0], p[1]]]], road: road.name, routes: int(1, 6) });
      }
    });
  });

  // ========================================================= транспорт
  const VEHICLE_TYPES = [['Автобус', '#2a78d6', 30], ['Грузовик', '#eb6834', 15], ['Спецтехника', '#008300', 10], ['Прочее', '#6a7688', 5]];
  const LETTERS = 'АВЕКМНОРСТУХ';
  const plate = () => `${pick(LETTERS)}${int(100, 999)}${pick(LETTERS)}${pick(LETTERS)} ${pick(['77', '97', '177', '199'])}`;
  const vehicles = [];
  VEHICLE_TYPES.forEach(([type, color, n]) => {
    for (let i = 0; i < n; i++) {
      const s = pick(stops).dot[0][0];
      const [x, y] = toKm(s);
      const p = at(x + range(-0.3, 0.3), y + range(-0.3, 0.3));
      const moving = rnd() < 0.7;
      vehicles.push({ id: 'Транспорт_' + guid(), plate: plate(), type, color, pos: p, moving,
        speed: moving ? int(12, 62) : 0, azimuth: int(0, 359),
        // «Прочее» — нарочно картинка, которой нет в /icons: ядро должно
        // откатиться на пиктограмму плагина (pointIconShapes['Транспорт']).
        img: type === 'Прочее' ? 'Неизвестный' : type,
        driver: pick(['Иванов И.И.', 'Петров П.П.', 'Сидоров С.С.', 'Кузнецов К.К.', 'Смирнов А.А.']) });
    }
  });

  // ============================================================= треки
  // Каждый трек — несколько участков ([участок][точка]); стык участков
  // дублирует координату, как у 1С (map.js: trackPoints схлопывает повторы).
  const tracks = vehicles.filter(v => v.type === 'Автобус').slice(0, 6).map((v, i) => {
    let p = polar(range(1, 5), range(0, 360));
    let head = range(0, 360);
    const all = [p];
    for (let k = 0; k < 90; k++) {
      head += range(-25, 25);
      const [x, y] = toKm(p), a = head * Math.PI / 180;
      p = at(x + 0.22 * Math.sin(a), y + 0.22 * Math.cos(a));
      if (distKm(p, CENTER) > 13) head += 180;
      all.push(p);
    }
    const cut1 = 30, cut2 = 60;
    const dots = [all.slice(0, cut1 + 1), all.slice(cut1, cut2 + 1), all.slice(cut2)];
    const s1 = int(10, 20), s2 = int(65, 75);
    const noRouteDots = [all.slice(s1, s1 + int(6, 10)), all.slice(s2, s2 + int(6, 10))];
    return { id: 'Треки_' + guid(), vehicleId: v.id, name: `Трек ${v.plate}`, plate: v.plate, color: PALETTE[i],
      dots, noRouteDots, date: '2026-09-27', from: `0${6 + i}:00`, to: `${12 + i}:30`,
      lengthKm: all.reduce((s, q, k) => k ? s + distKm(all[k - 1], q) : 0, 0) };
  });

  // ======================================================= происшествия
  const INC_TYPES = [['Столкновение', 40], ['Наезд на пешехода', 18], ['Съезд с дороги', 16], ['Наезд на препятствие', 9], ['Опрокидывание', 6], ['Прочее', 11]];
  const SEVERITY = [['Лёгкое', '#1baf7a', 55], ['Среднее', '#eda100', 30], ['Тяжёлое', '#d7191c', 15]];
  const LIGHTING = [['Светлое время', 60], ['Темно, освещение есть', 20], ['Темно, без освещения', 12], ['Сумерки', 8]];
  const SURFACE = [['Сухое', 55], ['Мокрое', 22], ['Снежный накат', 12], ['Гололедица', 11]];
  const HOUR_W = Array.from({ length: 24 }, (_, h) => [h, (h >= 7 && h <= 9) || (h >= 17 && h <= 19) ? 3 : (h >= 0 && h <= 5 ? 0.5 : 1.3)]);
  const localRoads = roads.filter(r => r.typeRoad === 'Местная');

  function genIncidents(year, count, lastIso) {
    const end = new Date(lastIso + 'T00:00:00Z').getTime(), begin = Date.UTC(year, 0, 1);
    const list = [];
    for (let i = 0; i < count; i++) {
      let p, road = null;
      if (rnd() < 0.65) {
        road = rnd() < 0.5 ? pick(roads) : pick(localRoads);
        const v = pick(road.dots);
        const [x, y] = toKm(v);
        p = at(x + range(-0.12, 0.12), y + range(-0.12, 0.12));
      } else {
        p = polar(Math.sqrt(rnd()) * 15.5, range(0, 360));
      }
      const sev = weighted(SEVERITY.map(s => [s, s[2]]));
      const hurt = sev[0] === 'Лёгкое' ? int(0, 1) : sev[0] === 'Среднее' ? int(1, 3) : int(1, 5);
      const dead = sev[0] === 'Тяжёлое' && rnd() < 0.45 ? int(1, 2) : 0;
      const t = new Date(begin + Math.floor(rnd() * ((end - begin) / 86400000 + 1)) * 86400000);
      const hour = weighted(HOUR_W);
      const lighting = hour >= 21 || hour <= 5 ? weighted(LIGHTING.slice(1).map(x => [x[0], x[1]])) : weighted(LIGHTING.map(x => [x[0], x[1]]));
      const d = districtOf(p);
      list.push({
        id: 'Происшествия_' + guid(), pos: p,
        date: t.toISOString().slice(0, 10), time: `${pad2(hour)}:${pad2(int(0, 59))}`,
        type: weighted(INC_TYPES), severity: sev[0], color: sev[1], hurt, dead,
        lighting, surface: weighted(SURFACE),
        roadType: road ? road.typeRoad : 'Местная', roadName: road ? road.name : 'Внутриквартальный проезд',
        districtId: d ? d.id : null, districtName: d ? d.name : 'За городом',
        confirmed: rnd() < 0.85
      });
    }
    return list.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }
  const TODAY = '2026-09-27';
  const incidents = genIncidents(2025, 470, '2025-12-31').concat(genIncidents(2026, 360, TODAY));

  // ========================================================== иконки
  // Картинки «с сервера» (GET /icons) — ключ совпадает с obj.img. Стрелка
  // смотрит вверх, чтобы был виден поворот по azimuth.
  function vehicleIcon(color, glyph) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">`
      + `<path d="M15 1 L20 7 H10 Z" fill="${color}"/>`
      + `<circle cx="15" cy="17" r="11" fill="${color}" stroke="#fff" stroke-width="2"/>`
      + `<text x="15" y="21.5" font-family="Arial" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">${glyph}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  const ICONS = { 'Автобус': vehicleIcon('#2a78d6', 'А'), 'Грузовик': vehicleIcon('#eb6834', 'Г'), 'Спецтехника': vehicleIcon('#008300', 'С') };

  // ============================================= хранилище фильтров
  const STORE_KEY = 'demoServer.settings';
  const DEFAULTS = {
    'layer:Транспорт': { types: VEHICLE_TYPES.map(t => t[0]), onlyMoving: false },
    'layer:Треки': { vehicles: tracks.map(t => t.vehicleId), highlightNoRoute: true },
    'layer:Происшествия': { begin: '2026-01-01', end: TODAY, severity: SEVERITY.map(s => s[0]), types: [],
      withVictims: false, minVictims: null, dayOnly: false, nightOnly: false, onlyConfirmed: false },
    'dashboard': { begin: '2026-01-01', end: TODAY, districts: [], onlyConfirmed: false },
    'report:incidents': { begin: '2026-01-01', end: TODAY, districts: [], types: [], severity: [] },
    'report:districts': { begin: '2026-01-01', end: TODAY, onlyConfirmed: false },
    'report:overview': { begin: '2026-01-01', end: TODAY }
  };
  function loadStore() {
    try { return JSON.parse(sessionStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function getSettings(key) {
    return Object.assign({}, DEFAULTS[key] || {}, loadStore()[key] || {});
  }
  function saveSettings(key, values) {
    const store = loadStore();
    store[key] = Object.assign({}, values || {});
    sessionStorage.setItem(STORE_KEY, JSON.stringify(store));
    return { ok: true };
  }

  // ============================================ разметка форм настроек
  // Те же классы и атрибуты, что собирают РядЧекбокс/РядДата/РядВыбор/... в
  // map-api/ 1С-баз (см. js/settings-form.js — клиент знает только их).
  const F = {
    form: (rows, grid) => `<form class="settings-form${grid ? ' settings-form--grid' : ''}">${rows.join('')}</form>`,
    attrs: (o = {}) => (o.showIf ? ` data-show-if="${esc(o.showIf)}"` : '') ,
    cls: (o = {}) => o.wide ? ' settings-form__row--wide' : '',
    section: title => `<div class="settings-form__section-title">${esc(title)}</div>`,
    date: (name, label, value, o) => `<div class="settings-form__row${F.cls(o)}"${F.attrs(o)}><label class="settings-form__label" for="set_${name}">${esc(label)}</label><input type="date" id="set_${name}" name="${name}" value="${esc(value || '')}"></div>`,
    number: (name, label, value, o) => `<div class="settings-form__row${F.cls(o)}"${F.attrs(o)}><label class="settings-form__label" for="set_${name}">${esc(label)}</label><input type="number" id="set_${name}" name="${name}" value="${value == null ? '' : esc(value)}"></div>`,
    check: (name, label, value, o = {}) => `<div class="settings-form__row settings-form__row--checkbox${F.cls(o)}"${F.attrs(o)}><label class="settings-form__label" for="set_${name}">${esc(label)}</label><input type="checkbox" id="set_${name}" name="${name}"${value ? ' checked' : ''}${o.exclusiveWith ? ` data-exclusive-with="${esc(o.exclusiveWith)}"` : ''}></div>`,
    multi: (name, label, options, selected, o = { wide: true }) => `<div class="settings-form__row${F.cls(o)}"${F.attrs(o)}><label class="settings-form__label" for="set_${name}">${esc(label)}</label><select multiple id="set_${name}" name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}"${(selected || []).includes(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`
  };
  const districtOptions = () => districts.map(d => [d.id, d.name]);

  function layerSettingsForm(id) {
    const s = getSettings('layer:' + id);
    if (id === 'Транспорт') {
      return { layerId: id, title: 'Настройки слоя «Транспорт»', html: F.form([
        F.multi('types', 'Типы транспорта', VEHICLE_TYPES.map(t => [t[0], t[0]]), s.types),
        F.check('onlyMoving', 'Только в движении', s.onlyMoving)
      ]) };
    }
    if (id === 'Треки') {
      return { layerId: id, title: 'Настройки слоя «Треки»', html: F.form([
        F.multi('vehicles', 'Транспортные средства', tracks.map(t => [t.vehicleId, t.plate]), s.vehicles),
        F.check('highlightNoRoute', 'Подсвечивать участки без маршрута', s.highlightNoRoute)
      ]) };
    }
    if (id === 'Происшествия') {
      return { layerId: id, title: 'Настройки слоя «Происшествия»', html: F.form([
        F.section('Период'),
        F.date('begin', 'Дата с', s.begin),
        F.date('end', 'Дата по', s.end),
        F.section('Отбор'),
        F.multi('severity', 'Тяжесть', SEVERITY.map(x => [x[0], x[0]]), s.severity),
        F.multi('types', 'Виды (пусто — все)', INC_TYPES.map(x => [x[0], x[0]]), s.types),
        F.check('withVictims', 'Только с пострадавшими', s.withVictims),
        F.number('minVictims', 'Пострадавших не менее', s.minVictims, { showIf: 'withVictims=true' }),
        // Взаимоисключающая пара — data-exclusive-with (SettingsForm.wireExclusiveCheckboxes).
        F.check('dayOnly', 'Только днём (7:00–20:59)', s.dayOnly, { exclusiveWith: 'nightOnly' }),
        F.check('nightOnly', 'Только ночью (21:00–6:59)', s.nightOnly, { exclusiveWith: 'dayOnly' }),
        F.check('onlyConfirmed', 'Только подтверждённые', s.onlyConfirmed, { wide: true })
      ], true) };
    }
    // У слоя нет settings:true в /layers — клиент сюда не придёт; настоящий
    // сервис ответил бы так же.
    throw httpErr(404, 'У слоя нет настроек');
  }

  // ============================================ фильтрация происшествий
  function filterIncidents(f) {
    return incidents.filter(x => {
      if (f.begin && x.date < f.begin) return false;
      if (f.end && x.date > f.end) return false;
      if (f.severity && f.severity.length && !f.severity.includes(x.severity)) return false;
      if (f.types && f.types.length && !f.types.includes(x.type)) return false;
      if (f.districts && f.districts.length && !f.districts.includes(x.districtId)) return false;
      if (f.withVictims && x.hurt + x.dead < Math.max(1, f.minVictims || 1)) return false;
      const h = Number(x.time.slice(0, 2));
      if (f.dayOnly && !(h >= 7 && h <= 20)) return false;
      if (f.nightOnly && (h >= 7 && h <= 20)) return false;
      if (f.onlyConfirmed && !x.confirmed) return false;
      return true;
    });
  }
  // Тот же период годом раньше (АППГ).
  const shiftYear = (iso, dy) => iso ? (Number(iso.slice(0, 4)) + dy) + iso.slice(4) : iso;

  // ================================================================ /layers
  function layersMeta() {
    const tr = getSettings('layer:Треки');
    const shownTracks = tracks.filter(t => tr.vehicles.includes(t.vehicleId));
    return [
      { id: 'Транспорт', label: 'Транспорт', group: 'Транспорт', type: 'point', color: '#2a78d6', settings: true },
      { id: 'Треки', label: 'Треки за сегодня', group: 'Транспорт', type: 'line', color: '#6a3d9a', settings: true,
        playback: true, highlightNoRoute: !!tr.highlightNoRoute,
        legend: shownTracks.map(t => ({ color: t.color, label: t.plate })) },
      { id: 'Остановки', label: 'Остановки', group: 'Транспорт', type: 'point', color: '#1baf7a', cluster: false },
      { id: 'Происшествия', label: 'Происшествия', group: 'Происшествия', type: 'point', color: '#e34948', settings: true, wideSettings: true },
      { id: 'ТепловаяКарта', label: 'Плотность происшествий', group: 'Происшествия', type: 'heat', color: '#d7191c' },
      { id: 'Дороги', label: 'Дорожная сеть', group: 'Дороги', type: 'line', color: '#f28e2b' },
      { id: 'Зоны', label: 'Зоны работ', group: 'Территория', type: 'polygon', color: '#eda100' },
      { id: 'Районы', label: 'Районы', group: 'Территория', type: 'polygon', color: '#5b6b86' }
    ];
  }

  // =========================================================== /layer/{id}
  // Цвет района — считает «сервер» по плотности происшествий текущего года
  // (как choropleth-раскраска АдминистративныеЕдиницы у accident-analysis).
  function districtColors() {
    const year = incidents.filter(x => x.date >= '2026-01-01');
    const per = districts.map(d => year.filter(x => x.districtId === d.id).length / (d.population / 100000));
    const min = Math.min(...per), max = Math.max(...per);
    const scale = ['#1baf7a', '#9ccc65', '#eda100', '#eb6834', '#d7191c'];
    return districts.map((d, i) => scale[Math.min(4, Math.floor((per[i] - min) / (max - min + 1e-9) * 5))]);
  }

  function layerData(id) {
    if (id === 'Транспорт') {
      const s = getSettings('layer:Транспорт');
      return vehicles
        .filter(v => (s.types || []).includes(v.type) && (!s.onlyMoving || v.moving))
        .map(v => ({ id: v.id, name: `${v.plate} · ${v.type}`, dot: [[[v.pos[0], v.pos[1]]]], img: v.img,
          azimuth: v.moving ? v.azimuth : 0, idCluster: v.color }));
    }
    if (id === 'Треки') {
      const s = getSettings('layer:Треки');
      return tracks.filter(t => s.vehicles.includes(t.vehicleId))
        .map(t => ({ id: t.id, name: t.name, dots: t.dots, color: t.color, noRouteDots: t.noRouteDots }));
    }
    if (id === 'Остановки') return stops.map(s => ({ id: s.id, name: s.name, dot: s.dot }));
    if (id === 'Происшествия') {
      // Точечный слой в форме { key, date: [...] } — как ДТП у accident-analysis
      // (проверка extractFeatures в js/api.js).
      return { key: 'Происшествия', date: filterIncidents(getSettings('layer:Происшествия')).map(x => ({
        id: x.id, name: `${x.type} · ${isoToRu(x.date)}`, dot: [[[x.pos[0], x.pos[1]]]], idCluster: x.color })) };
    }
    if (id === 'Дороги') {
      return roads.map(r => ({ id: r.id, name: `${r.name} (${r.typeRoad.toLowerCase()})`, dots: r.dots,
        color: ROAD_COLOR[r.typeRoad], typeRoad: r.typeRoad }));
    }
    if (id === 'Зоны') {
      return zones.map(z => ({ id: z.id, name: `${z.name} · ${z.status}`, dots: z.dots, color: z.color, dashArray: z.dashArray || undefined }));
    }
    if (id === 'Районы') {
      const colors = districtColors();
      return [{ id: cityId, name: 'Город (граница)', dots: [[cityRing]], color: '#5b6b86', dashArray: '8 6' }]
        .concat(districts.map((d, i) => ({ id: d.id, name: `${d.name} район`, dots: d.dots, color: colors[i] })));
    }
    throw httpErr(404, 'Слой не найден');
  }

  function heatmap() {
    const list = filterIncidents(getSettings('layer:Происшествия'));
    const w = x => 1 + x.hurt + 3 * x.dead;
    const maxCount = Math.max(1, ...list.map(w));
    return list.map(x => ({ lat: x.pos[0], lng: x.pos[1], count: w(x), maxCount }));
  }

  // ======================================================= /object/…
  const row = (k, v) => `<div class="detail__row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
  const rows = pairs => `<dl class="detail__rows">${pairs.map(p => row(p[0], p[1])).join('')}</dl>`;
  const status = (text, kind) => `<div class="detail__status detail__status--${kind}"><span class="dot"></span>${esc(text)}</div>`;
  const table = (headers, body) => `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const fold = (title, inner) => `<details class="detail__fold"><summary>${esc(title)}</summary>${inner}</details>`;
  const km = x => x.toFixed(1).replace('.', ',') + ' км';

  function objectDetails(layerId, objectId) {
    if (layerId === 'Транспорт') {
      const v = vehicles.find(x => x.id === objectId); if (!v) throw httpErr(404);
      const track = tracks.find(t => t.vehicleId === v.id);
      return { id: v.id, type: v.type, title: v.plate, html:
        (v.moving ? status('В движении', 'ok') : status('Стоит', 'warn'))
        + rows([['Госномер', v.plate], ['Тип', v.type], ['Водитель', v.driver], ['Скорость', v.speed + ' км/ч'], ['Курс', v.azimuth + '°'], ['Район', (districtOf(v.pos) || { name: 'За городом' }).name]])
        + (track ? `<div class="detail__section-title">Трек за сегодня</div>` + rows([['Протяжённость', km(track.lengthKm)], ['Время', `${track.from} – ${track.to}`]]) : '') };
    }
    if (layerId === 'Треки') {
      const t = tracks.find(x => x.id === objectId); if (!t) throw httpErr(404);
      return { id: t.id, type: 'Трек', title: t.name, html:
        rows([['Дата', isoToRu(t.date)], ['Время', `${t.from} – ${t.to}`], ['Протяжённость', km(t.lengthKm)], ['Участков', t.dots.length], ['Без маршрута', t.noRouteDots.length + ' фрагм.']])
        + fold('Участки', table(['№', 'Точек', 'Длина'], t.dots.map((seg, i) => [i + 1, seg.length, km(seg.reduce((s, p, k) => k ? s + distKm(seg[k - 1], p) : 0, 0))]))) };
    }
    if (layerId === 'Остановки') {
      const s = stops.find(x => x.id === objectId); if (!s) throw httpErr(404);
      const hours = [7, 9, 12, 15, 18, 21].map(h => [pad2(h) + ':00', int(5, 60), int(5, 60)]);
      return { id: s.id, type: 'Остановка', title: s.name, html:
        rows([['Дорога', s.road], ['Маршрутов', s.routes]])
        + fold('Маршруты', table(['Маршрут', 'Интервал'], Array.from({ length: s.routes }, (_, i) => [`№${10 + i * 7}`, `${int(5, 25)} мин`])))
        + fold('По часам', table(['Час', 'Вошло', 'Вышло'], hours)) };
    }
    if (layerId === 'Происшествия') {
      const x = incidents.find(i => i.id === objectId); if (!x) throw httpErr(404);
      const kind = x.severity === 'Тяжёлое' ? 'err' : x.severity === 'Среднее' ? 'warn' : 'ok';
      return { id: x.id, type: x.type, title: `${x.type}, ${isoToRu(x.date)} ${x.time}`, html:
        status(x.severity + (x.confirmed ? '' : ' · не подтверждено'), kind)
        + rows([['Дата и время', `${isoToRu(x.date)} ${x.time}`], ['Район', x.districtName], ['Дорога', x.roadName], ['Пострадало', x.hurt], ['Погибло', x.dead]])
        + `<div class="detail__section-title">Условия</div>` + rows([['Освещение', x.lighting], ['Покрытие', x.surface], ['Вид дороги', x.roadType]]) };
    }
    if (layerId === 'Дороги') {
      const r = roads.find(x => x.id === objectId); if (!r) throw httpErr(404);
      const n = incidents.filter(x => x.roadName === r.name && x.date >= '2026-01-01').length;
      return { id: r.id, type: 'Дорога', title: r.name, html: rows([['Значение', r.typeRoad], ['Протяжённость', km(r.lengthKm)], ['Происшествий в 2026', n]]) };
    }
    if (layerId === 'Зоны') {
      const z = zones.find(x => x.id === objectId); if (!z) throw httpErr(404);
      const kind = z.status === 'Завершена' ? 'ok' : z.status === 'В работе' ? 'warn' : 'ok';
      return { id: z.id, type: 'Зона работ', title: z.name, html: status(z.status, kind) + rows([['Подрядчик', z.contractor], ['Район', (districtOf(z.center) || { name: 'За городом' }).name]]) };
    }
    if (layerId === 'Районы') {
      if (objectId === cityId) return { id: cityId, type: 'Граница', title: 'Город', html: rows([['Районов', districts.length], ['Население', districts.reduce((s, d) => s + d.population, 0).toLocaleString('ru-RU')]]) };
      const d = districts.find(x => x.id === objectId); if (!d) throw httpErr(404);
      const cur = incidents.filter(x => x.districtId === d.id && x.date >= '2026-01-01');
      const prev = incidents.filter(x => x.districtId === d.id && x.date >= '2025-01-01' && x.date <= shiftYear(TODAY, -1));
      return { id: d.id, type: 'Район', title: `${d.name} район`, html:
        rows([['Население', d.population.toLocaleString('ru-RU')], ['Частей', d.dots.length], ['Происшествий в 2026', cur.length], ['АППГ', prev.length], ['Пострадало', cur.reduce((s, x) => s + x.hurt, 0)]]) };
    }
    throw httpErr(404, 'Слой не найден');
  }

  // ============================================================ /dashboard
  const MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  function countBy(list, key, order) {
    const m = new Map((order || []).map(k => [k, 0]));
    list.forEach(x => m.set(x[key], (m.get(x[key]) || 0) + 1));
    return Array.from(m, ([name, value]) => ({ name, value }));
  }
  function monthKeys(begin, end) {
    const keys = [];
    let y = Number(begin.slice(0, 4)), m = Number(begin.slice(5, 7));
    const ey = Number(end.slice(0, 4)), em = Number(end.slice(5, 7));
    while (y < ey || (y === ey && m <= em)) { keys.push(`${y}-${pad2(m)}`); if (++m > 12) { m = 1; y++; } }
    return keys;
  }

  function dashboard() {
    const s = getSettings('dashboard');
    const f = { begin: s.begin, end: s.end, districts: s.districts, onlyConfirmed: s.onlyConfirmed };
    const cur = filterIncidents(f);
    const prev = filterIncidents(Object.assign({}, f, { begin: shiftYear(s.begin, -1), end: shiftYear(s.end, -1) }));
    const sum = (list, k) => list.reduce((a, x) => a + x[k], 0);
    const keys = monthKeys(s.begin || '2026-01-01', s.end || TODAY);
    const multiYear = keys.length && keys[0].slice(0, 4) !== keys[keys.length - 1].slice(0, 4);
    const inMonth = k => cur.filter(x => x.date.slice(0, 7) === k);
    const selected = districts.filter(d => (s.districts || []).includes(d.id)).map(d => d.name);
    return {
      id: 'demo',
      title: 'Происшествия',
      period: { begin: isoToRu(s.begin), end: isoToRu(s.end) },
      appg: Number((s.begin || '2026').slice(0, 4)) - 1,
      districts: selected.join(', ') || 'Все',
      onlyConfirmed: !!s.onlyConfirmed,
      generatedAt: nowRu(),
      data: {
        kpi: {
          inc:  { cur: cur.length, prev: prev.length },
          hurt: { cur: sum(cur, 'hurt'), prev: sum(prev, 'hurt') },
          dead: { cur: sum(cur, 'dead'), prev: sum(prev, 'dead') }
        },
        dyn: {
          m: keys.map(k => MONTHS[Number(k.slice(5)) - 1] + (multiYear ? ' ' + k.slice(2, 4) : '')),
          inc: keys.map(k => inMonth(k).length),
          hurt: keys.map(k => sum(inMonth(k), 'hurt')),
          dead: keys.map(k => sum(inMonth(k), 'dead'))
        },
        types: countBy(cur, 'type', INC_TYPES.map(t => t[0])).sort((a, b) => b.value - a.value),
        severity: countBy(cur, 'severity', SEVERITY.map(x => x[0])),
        lighting: countBy(cur, 'lighting', LIGHTING.map(x => x[0])),
        surface: countBy(cur, 'surface', SURFACE.map(x => x[0])),
        roads: countBy(cur, 'roadType', Object.keys(ROAD_COLOR)),
        districts: districts.map(d => {
          const l = cur.filter(x => x.districtId === d.id);
          return { id: d.id, name: d.name, inc: l.length, hurt: sum(l, 'hurt') };
        }).concat([{ id: '', name: 'За городом', inc: cur.filter(x => !x.districtId).length, hurt: sum(cur.filter(x => !x.districtId), 'hurt') }])
      }
    };
  }

  function dashboardSettingsForm() {
    const s = getSettings('dashboard');
    return { title: 'Фильтры дашборда', html: F.form([
      F.date('begin', 'Период с', s.begin),
      F.date('end', 'Период по', s.end),
      F.multi('districts', 'Районы (пусто — все)', districtOptions(), s.districts),
      F.check('onlyConfirmed', 'Только подтверждённые', s.onlyConfirmed)
    ]) };
  }

  // ============================================================== /reports
  const REPORTS = [
    { id: 'incidents', name: 'Реестр происшествий', meta: 'Таблица · даты, числа, флаги' },
    { id: 'districts', name: 'Сводка по районам', meta: 'Таблица с итогом' },
    { id: 'overview', name: 'Аналитическая справка', meta: 'Карточный отчёт (rich)' }
  ];

  function envelope(id, title, s) {
    return { id, title, generatedAt: nowRu(), period: { begin: isoToRu(s.begin), end: isoToRu(s.end) } };
  }

  function report(id) {
    const s = getSettings('report:' + id);
    if (id === 'incidents') {
      const list = filterIncidents(s);
      const columns = [
        { key: 'date', label: 'Дата' }, { key: 'time', label: 'Время' }, { key: 'district', label: 'Район' },
        { key: 'road', label: 'Дорога' }, { key: 'type', label: 'Вид' }, { key: 'severity', label: 'Тяжесть' },
        { key: 'hurt', label: 'Пострадало' }, { key: 'dead', label: 'Погибло' }, { key: 'confirmed', label: 'Подтверждено' }
      ];
      const rowsOut = list.slice().reverse().map(x => ({ date: isoToRu(x.date), time: x.time, district: x.districtName,
        road: x.roadName, type: x.type, severity: x.severity, hurt: x.hurt, dead: x.dead, confirmed: x.confirmed }));
      return Object.assign(envelope(id, 'Реестр происшествий', s), { kind: 'table', columns, rows: rowsOut, rowCount: rowsOut.length });
    }
    if (id === 'districts') {
      const list = filterIncidents(s);
      const line = (name, l, pop) => ({ district: name, inc: l.length, hurt: l.reduce((a, x) => a + x.hurt, 0),
        dead: l.reduce((a, x) => a + x.dead, 0), per100k: pop ? Math.round(l.length / pop * 100000 * 10) / 10 : '' });
      const rowsOut = districts.map(d => line(d.name, list.filter(x => x.districtId === d.id), d.population));
      rowsOut.push(line('За городом', list.filter(x => !x.districtId), 0));
      rowsOut.push(line('Итого', list, districts.reduce((a, d) => a + d.population, 0)));
      return Object.assign(envelope(id, 'Сводка по районам', s), { kind: 'table',
        columns: [{ key: 'district', label: 'Район' }, { key: 'inc', label: 'Происшествий' }, { key: 'hurt', label: 'Пострадало' },
          { key: 'dead', label: 'Погибло' }, { key: 'per100k', label: 'На 100 тыс. жителей' }],
        rows: rowsOut, rowCount: rowsOut.length });
    }
    if (id === 'overview') return overview(s);
    throw httpErr(404, 'Отчёт не найден');
  }

  // Карточный отчёт — по одному элементу каждого типа, который понимает
  // js/rich-report.js (table/table-stack/column/line/hbar/hbar-grouped/pie/
  // progress/list).
  function overview(s) {
    const cur = filterIncidents(s);
    const prev = filterIncidents({ begin: shiftYear(s.begin, -1), end: shiftYear(s.end, -1) });
    const keys = monthKeys(s.begin || '2026-01-01', s.end || TODAY);
    const byMonth = (list, k, prop) => list.filter(x => x.date.slice(5, 7) === k.slice(5, 7)).reduce((a, x) => a + (prop ? x[prop] : 1), 0);
    const types = countBy(cur, 'type', INC_TYPES.map(t => t[0]));
    const dist = districts.map(d => ({ name: d.name, l: cur.filter(x => x.districtId === d.id) }));
    const sum = (l, k) => l.reduce((a, x) => a + x[k], 0);
    const y = (s.begin || '2026').slice(0, 4);
    return Object.assign(envelope('overview', 'Аналитическая справка', s), {
      kind: 'rich',
      sections: [
        { title: 'Общая картина', cards: [
          { title: 'Динамика', notes: [`Сравнение с тем же периодом ${Number(y) - 1} года.`], elements: [
            { type: 'column', title: 'Происшествия по месяцам', categories: keys.map(k => MONTHS[Number(k.slice(5)) - 1]),
              series: [{ name: String(Number(y) - 1), values: keys.map(k => byMonth(prev, k)) }, { name: y, values: keys.map(k => byMonth(cur, k)) }] },
            { type: 'line', title: 'Пострадавшие по месяцам', categories: keys.map(k => MONTHS[Number(k.slice(5)) - 1]),
              series: [{ name: String(Number(y) - 1), values: keys.map(k => byMonth(prev, k, 'hurt')) }, { name: y, values: keys.map(k => byMonth(cur, k, 'hurt')) }] }
          ] },
          { title: 'Структура', notes: [], elements: [
            { type: 'pie', title: 'Виды происшествий', categories: types.map(t => t.name), values: types.map(t => t.value) },
            { type: 'hbar', title: 'Время суток', categories: ['Ночь (0–6)', 'Утро (7–11)', 'День (12–16)', 'Вечер (17–20)', 'Поздний вечер (21–23)'],
              values: [[0, 6], [7, 11], [12, 16], [17, 20], [21, 23]].map(([a, b]) => cur.filter(x => { const h = Number(x.time.slice(0, 2)); return h >= a && h <= b; }).length),
              note: 'Утренний и вечерний пики — часы наибольшей загрузки дорог.' }
          ] }
        ] },
        { title: 'Районы', cards: [
          { title: 'Происшествия и пострадавшие', notes: [], elements: [
            { type: 'hbar-grouped', categories: dist.map(d => d.name), series: [
              { name: 'Происшествия', values: dist.map(d => d.l.length) }, { name: 'Пострадавшие', values: dist.map(d => sum(d.l, 'hurt')) }] },
            { type: 'table', headers: ['Район', 'Происшествий', 'Пострадало', 'Погибло'],
              rows: dist.map(d => [d.name, String(d.l.length), String(sum(d.l, 'hurt')), String(sum(d.l, 'dead'))])
                .concat([['Итого', String(cur.length), String(sum(cur, 'hurt')), String(sum(cur, 'dead'))]]) }
          ] },
          { title: 'Выполнение плана профилактики', notes: ['Условные цифры — демонстрация элемента progress.'], elements: [
            { type: 'progress', items: dist.slice(0, 5).map(d => ({ label: d.name, pct: 40 + (d.l.length * 7) % 60, note: `${d.l.length} происшествий за период` })) }
          ] }
        ] },
        { title: 'Детализация', cards: [
          { title: 'Условия', notes: [], elements: [
            { type: 'table-stack', tables: [
              { title: 'Освещение', headers: ['Условие', 'Кол-во'], rows: countBy(cur, 'lighting', LIGHTING.map(x => x[0])).map(x => [x.name, String(x.value)]) },
              { title: 'Покрытие', headers: ['Условие', 'Кол-во'], rows: countBy(cur, 'surface', SURFACE.map(x => x[0])).map(x => [x.name, String(x.value)]) }
            ] },
            { type: 'list', title: 'Выводы', items: [
              `Всего за период: ${cur.length} происшествий (${prev.length} годом ранее).`,
              `Больше всего — «${types.slice().sort((a, b) => b.value - a.value)[0].name}».`,
              'Текст выводов формирует сервер; клиент только выводит список.'
            ] }
          ] }
        ] }
      ]
    });
  }

  function reportSettingsForm(id) {
    const s = getSettings('report:' + id);
    const period = [F.date('begin', 'Период с', s.begin), F.date('end', 'Период по', s.end)];
    if (id === 'incidents') {
      return { title: 'Настройки отчёта «Реестр происшествий»', html: F.form(period.concat([
        F.multi('districts', 'Районы (пусто — все)', districtOptions(), s.districts),
        F.multi('types', 'Виды (пусто — все)', INC_TYPES.map(x => [x[0], x[0]]), s.types),
        F.multi('severity', 'Тяжесть (пусто — все)', SEVERITY.map(x => [x[0], x[0]]), s.severity)
      ])) };
    }
    if (id === 'districts') {
      return { title: 'Настройки отчёта «Сводка по районам»', html: F.form(period.concat([F.check('onlyConfirmed', 'Только подтверждённые', s.onlyConfirmed)])) };
    }
    if (id === 'overview') return { title: 'Настройки отчёта «Аналитическая справка»', html: F.form(period) };
    throw httpErr(404, 'Отчёт не найден');
  }

  // =========================================================== /geo/where
  // Эндпоинт, которого нет в общем контракте, — «свой» у плагина (команда
  // карты «Что здесь?», _demo.js), вызывается через ctx.getJSON.
  function geoWhere(q) {
    const p = [Number(q.lat), Number(q.lng)];
    if (!isFinite(p[0]) || !isFinite(p[1])) throw httpErr(400, 'Нужны lat и lng');
    const d = districtOf(p);
    let near = null, nearD = Infinity;
    stops.forEach(s => { const k = distKm(p, s.dot[0][0]); if (k < nearD) { nearD = k; near = s; } });
    const around = incidents.filter(x => x.date >= '2026-01-01' && distKm(p, x.pos) <= 0.5);
    return { district: d ? d.name : 'За городом', toCenterKm: Math.round(distKm(p, CENTER) * 10) / 10,
      nearestStop: near ? { name: near.name, distM: Math.round(nearD * 1000) } : null,
      incidents500m: around.length, hurt500m: around.reduce((a, x) => a + x.hurt, 0) };
  }

  // ================================================================ ROUTES
  const ROUTES = {
    'GET config':                     () => ({ center: CENTER, zoom: 11 }),
    'GET icons':                      () => ICONS,
    'GET layers':                     () => layersMeta(),
    'GET layer/:id':                  ({ params }) => layerData(params.id),
    'GET layer/:id/settings':         ({ params }) => layerSettingsForm(params.id),
    'POST layer/:id/settings':        ({ params, body }) => saveSettings('layer:' + params.id, body && body.values),
    'GET heatmap':                    () => heatmap(),
    'GET object/:layerId/:objectId':  ({ params }) => objectDetails(params.layerId, params.objectId),
    'GET dashboard':                  () => dashboard(),
    'GET dashboard/settings':         () => dashboardSettingsForm(),
    'POST dashboard/settings':        ({ body }) => saveSettings('dashboard', body && body.values),
    'GET reports':                    () => REPORTS,
    'GET report/:id':                 ({ params }) => report(params.id),
    'GET report/:id/settings':        ({ params }) => reportSettingsForm(params.id),
    'POST report/:id/settings':       ({ params, body }) => saveSettings('report:' + params.id, body && body.values),
    'GET geo/where':                  ({ query }) => geoWhere(query)
  };

  return { routes: ROUTES, center: CENTER };
})();
