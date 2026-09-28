/* =====================================================================
   API-слой карты.

   Весь обмен с 1С сосредоточен здесь: HTTP-сервис публикации 1С, адрес —
   BackendPlugin.baseUrl. Контракт (пути, форма аргументов и ответа) —
   единый для любой базы, которая его реализует; живой образец ответов —
   js/backends/_demo-server.js, описание — CLAUDE.md, «Data source».

   apiUrl/getJSON/postJSON экспортированы наружу (см. низ файла) сверх именованных
   методов ниже — не для общего пользования, а специально для BackendPlugin.mapCommands
   (см. CLAUDE.md, «Команды карты»): у команды карты может быть собственный эндпоинт,
   специфичный ровно одному бэкенду, которому не место в общей таблице методов этого
   файла — так плагин ходит по HTTP сам, без дублирования auth/401-логики.
   ===================================================================== */

const MapAPI = (function () {

  // Настройки — baseUrl/страховочные center/zoom в window.BackendPlugin
  // (js/backends/<id>.js, конкретный бэкенд), рендер-тюнинг в js/config.js
  // (MapConfig, общий для любого бэкенда). api.js отвечает только за обмен
  // с 1С, не за хранение конфигурации.

  // ------------------------------------------------------------- auth
  // Публикация 1С аутентифицирует запросы стандартным HTTP Basic-auth по
  // реальным пользователям информационной базы — благодаря этому сервер сам
  // резолвит ТекущийПользователь(), и все сохранённые фильтры слоёв/отчётов/
  // дашборда читаются/пишутся уже для конкретного залогинившегося пользователя. Заголовок хранится в localStorage —
  // сессия переживает перезагрузку страницы до явного logout() (см. js/auth.js).
  const AUTH_KEY = 'mapAuth';

  function readAuth() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_KEY));
    } catch (e) {
      return null;
    }
  }

  // Basic-auth заголовок должен быть base64 от байтов UTF-8 (логин/пароль
  // могут содержать кириллицу) — обычный btoa(str) кодирует str как
  // latin1/UCS-2 и ломается на не-ASCII символах.
  function basicAuthHeader(login, password) {
    const bytes = new TextEncoder().encode(`${login}:${password}`);
    const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
    return 'Basic ' + btoa(binary);
  }

  // BackendPlugin.requiresAuth === false — публикация анонимная (или бэкенда нет
  // вовсе, см. mockApi ниже): заголовок не шлём, даже если в localStorage осталась
  // сессия от другого бэкенда на том же origin — иначе чужой Basic-auth мог бы
  // получить 401 и зациклить перезагрузку (см. dropAuth и js/auth.js).
  function authRequired() {
    return !(window.BackendPlugin && BackendPlugin.requiresAuth === false);
  }

  function authHeaders() {
    if (!authRequired()) return {};
    const auth = readAuth();
    return auth ? { Authorization: auth.header } : {};
  }

  // Единая точка для любого 401 от сервиса (не только формы входа): сбрасывает
  // сохранённую сессию и оповещает js/auth.js, что нужно снова показать логин.
  function dropAuth() {
    localStorage.removeItem(AUTH_KEY);
    window.dispatchEvent(new CustomEvent('mapapi:unauthorized'));
  }

  // ---------------------------------------------------------------- utils
  // BackendPlugin.baseUrl может быть как с завершающим "/", так и без —
  // склеиваем безопасно. Читается лениво (не при загрузке api.js — оно
  // подключено раньше backends/<id>.js, см. index.html), а внутри apiUrl(),
  // к моменту первого реального вызова которого window.BackendPlugin уже точно
  // назначен.
  function apiUrl(path) {
    return BackendPlugin.baseUrl.replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
  }

  // Сервер отдаёт данные слоя в естественной форме, не сводя её к одной: у части
  // слоёв это готовый массив объектов, у части точечных — объект { key, date: [...] },
  // где сами объекты лежат в .date (так их отдаёт штатное ЗаполнитьСведенияДляКарты). Клиент сам определяет, что пришло, и достаёт из этого
  // плоский массив объектов слоя — то, что дальше ждут map.js (buildVectorGroup,
  // data.length). Массив проходит как есть; всё остальное — пусто.
  function extractFeatures(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.date)) return payload.date;
    return [];
  }

  function httpError(url, r) {
    const err = new Error(`MapAPI: HTTP ${r.status} ${r.statusText} (${url})`);
    err.status = r.status;
    return err;
  }

  // ------------------------------------------------------------- mock
  // Бэкенд внутри браузера: если подключённый плагин задаёт BackendPlugin.mockApi,
  // запросы не уходят в сеть, а разрешаются его обработчиками (сейчас так работает
  // только js/backends/_demo.js). Перехват — на уровне getJSON/postJSON,
  // а не именованных методов ниже: так через заглушку идут и собственные эндпоинты
  // плагина, которые команды карты вызывают через ctx.getJSON/postJSON, а всё ядро
  // (extractFeatures, спиннеры, кэш, токены устаревших ответов) работает ровно тем
  // же кодом, что и с настоящей 1С.
  //
  // mockApi — { 'МЕТОД путь/:параметр': handler }, путь относительно baseUrl.
  // handler({ method, path, params, query, body }) → значение или Promise; чтобы
  // ответить ошибкой, handler бросает Error с полем status. Неизвестный маршрут —
  // 404, как у настоящего сервиса без такого эндпоинта.
  //
  // Задержка ответа — BackendPlugin.mockDelay ([мин, макс] мс, по умолчанию
  // [150, 400]) или ?mockdelay=N в URL; без неё не видно ни спиннеров, ни гонок.
  // ?mockfail=dashboard,reports — ответить 500 на все пути, чей первый сегмент в
  // списке (проверка карточек ошибок без правки кода).
  const pageParams = new URLSearchParams(location.search);
  const mockFail = (pageParams.get('mockfail') || '').split(',').map(s => s.trim()).filter(Boolean);

  function mockRoutes() {
    return window.BackendPlugin && BackendPlugin.mockApi;
  }

  function mockDelayMs() {
    const forced = pageParams.get('mockdelay');
    if (forced !== null && forced !== '' && !isNaN(forced)) return Number(forced);
    const range = (window.BackendPlugin && BackendPlugin.mockDelay) || [150, 400];
    return range[0] + Math.random() * (range[1] - range[0]);
  }

  function mockError(url, status, text) {
    const err = new Error(`MapAPI (mock): HTTP ${status} ${text} (${url})`);
    err.status = status;
    return err;
  }

  function matchRoute(pattern, segments) {
    const parts = pattern.split('/').filter(Boolean);
    if (parts.length !== segments.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = segments[i];
      else if (parts[i] !== segments[i]) return null;
    }
    return params;
  }

  async function mockRequest(method, url, body) {
    const base = BackendPlugin.baseUrl.replace(/\/+$/, '') + '/';
    const rel = url.startsWith(base) ? url.slice(base.length) : url;
    const [pathPart, queryPart] = rel.split('?');
    const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    const query = Object.fromEntries(new URLSearchParams(queryPart || ''));

    await new Promise(resolve => setTimeout(resolve, mockDelayMs()));

    if (mockFail.includes(segments[0])) throw mockError(url, 500, 'Internal Server Error (?mockfail)');

    const routes = mockRoutes();
    for (const key of Object.keys(routes)) {
      const space = key.indexOf(' ');
      if (key.slice(0, space) !== method) continue;
      const params = matchRoute(key.slice(space + 1), segments);
      if (!params) continue;
      let result;
      try {
        result = await routes[key]({ method, path: segments.join('/'), params, query, body });
      } catch (e) {
        if (e && e.status) throw mockError(url, e.status, e.message || '');
        throw e;
      }
      // Через JSON, а не structuredClone — как по сети: undefined-поля пропадают,
      // даты становятся строками, и ядро не может случайно мутировать «базу» мока.
      return result === undefined ? null : JSON.parse(JSON.stringify(result));
    }
    throw mockError(url, 404, 'Not Found');
  }

  // credentials: 'omit' на каждом запросе — иначе браузер (замечено в Chrome)
  // сам показывает нативное окно "Войдите в систему" поверх нашей формы
  // логина при любом 401 + WWW-Authenticate: Basic, даже когда Authorization
  // уже выставлен вручную в заголовках. С 'omit' браузер не пытается сам
  // разруливать аутентификацию — 401 просто долетает до кода как обычный ответ.
  async function getJSON(url) {
    if (mockRoutes()) return mockRequest('GET', url);
    const r = await fetch(url, { headers: authHeaders(), credentials: 'omit' });
    if (r.status === 401) dropAuth();
    if (!r.ok) throw httpError(url, r);
    return r.json();
  }

  async function postJSON(url, body) {
    if (mockRoutes()) return mockRequest('POST', url, body);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      credentials: 'omit',
      body: JSON.stringify(body)
    });
    if (r.status === 401) dropAuth();
    if (!r.ok) throw httpError(url, r);
    return r.json();
  }

  // ======================================================================
  //  Публичный интерфейс
  // ======================================================================
  return {
    /**
     * Проверяет логин/пароль реальным запросом к сервису — отдельного
     * эндпоинта аутентификации нет, публикация и так штатно провалидирует
     * Basic-auth заголовок против пользователей ИБ на первом же вызове.
     * Если сервер его принял — сохраняет сессию в localStorage.
     * Возвращает { ok, status? } (без исключений — форма логина сама решает,
     * что показать пользователю).
     */
    async login(login, password) {
      const header = basicAuthHeader(login, password);
      // Мок без сети: вход с любыми учётными данными, если /layers отвечает.
      // Нужен только плагину с mockApi и requiresAuth !== false — показать форму
      // входа без бэкенда.
      if (mockRoutes()) {
        try { await mockRequest('GET', apiUrl('layers')); } catch (e) { return { ok: false, status: e.status }; }
        localStorage.setItem(AUTH_KEY, JSON.stringify({ login, header }));
        return { ok: true };
      }
      let r;
      try {
        r = await fetch(apiUrl('layers'), { headers: { Authorization: header }, credentials: 'omit' });
      } catch (e) {
        return { ok: false };
      }
      if (!r.ok) {
        return { ok: false, status: r.status };
      }
      localStorage.setItem(AUTH_KEY, JSON.stringify({ login, header }));
      return { ok: true };
    },

    /** Явный выход — сброс сессии без последующего mapapi:unauthorized (см. dropAuth). */
    logout() {
      localStorage.removeItem(AUTH_KEY);
    },

    isAuthenticated() {
      return !!readAuth();
    },

    /** false — вход не нужен (BackendPlugin.requiresAuth === false), см. js/auth.js. */
    isAuthRequired() {
      return authRequired();
    },

    getAuthLogin() {
      const auth = readAuth();
      return auth ? auth.login : '';
    },

    /** Список слоёв (метаданные для панели). GET /layers */
    async getLayers() {
      return getJSON(apiUrl('layers'));
    },

    /**
     * Настройки инициализации карты. GET /config
     * Форма ответа: { center: [широта, долгота], zoom } — источник координат на
     * стороне 1С тот же, что использует нативная карта при сборке своей страницы.
     */
    async getMapConfig() {
      return getJSON(apiUrl('config'));
    },

    /**
     * Картинки точечных объектов. GET /icons
     * Форма ответа: { <имя пиктограммы>: "data:image/...;base64,..." } — ключ совпадает
     * с полем img объекта слоя (см. map.js: buildPointMarker). Эндпоинт есть не у
     * каждого бэкенда — map.js зовёт его только при BackendPlugin.serverIcons.
     */
    async getIcons() {
      return getJSON(apiUrl('icons'));
    },

    /**
     * Данные слоя. GET /layer/{id}?bbox=...
     * Ответ сервера приходит в естественной форме слоя — либо массивом объектов, либо
     * объектом { key, date: [...] } у точечных слоёв (сервер её не сводит, см.
     * extractFeatures выше). extractFeatures определяет форму и
     * возвращает наружу всегда плоский массив объектов слоя, поэтому вызывающий код
     * (map.js) работает с одним контрактом независимо от слоя.
     * Сами объекты — нативный формат карты 1С (см. Каталог.*.ЗаполнитьСведенияДляКарты):
     * линии/полигоны — { id, name, dots, color, dashArray?, toolTip? };
     * точки — { id, name, dot, idCluster, showTooltip, img, azimuth? }.
     * Отдаются как есть, без переформатирования — см. map.js: buildVectorGroup/
     * buildPointMarker/bindObject, которые читают эти поля напрямую.
     */
    async getLayerData(layerId, params = {}) {
      const qs = new URLSearchParams(params).toString();
      const url = apiUrl(`layer/${encodeURIComponent(layerId)}`) + (qs ? `?${qs}` : '');
      return extractFeatures(await getJSON(url));
    },

    /** Тепловой слой (layer.type === 'heat'). GET /heatmap → [{ lat, lng, count, maxCount }] */
    async getHeatmap(params = {}) {
      const qs = new URLSearchParams(params).toString();
      const url = apiUrl('heatmap') + (qs ? `?${qs}` : '');
      return getJSON(url);
    },

    /**
     * Сводка для экрана «Дашборд». GET /dashboard
     * Форма ответа: { id, title, generatedAt, ..., data:{...} } — всё, кроме id,
     * определяет конкретный бэкенд и разбирает normalize() шаблона его плагина
     * (образец — js/backends/_demo-server.js, GET dashboard). Фильтры (период и т.п.)
     * берутся из сохранённых настроек дашборда пользователя на сервере (см.
     * getDashboardSettings/saveDashboardSettings), а не из query-параметров. id —
     * идентификатор шаблона: клиент (js/dashboard.js) по нему выбирает разметку из
     * своего реестра шаблонов, поэтому для разных баз можно хранить несколько вариантов.
     */
    async getDashboard() {
      return getJSON(apiUrl('dashboard'));
    },

    /**
     * Форма фильтров дашборда для модального окна. GET /dashboard/settings
     * Форма ответа: { title, html } — html уже содержит <form class="settings-form">
     * с текущими значениями пользователя (по образцу getLayerSettings).
     */
    async getDashboardSettings() {
      return getJSON(apiUrl('dashboard/settings'));
    },

    /**
     * Сохранить фильтры дашборда. POST /dashboard/settings body: { values: {...} }
     * values собирается generic-обходом полей формы (см. js/dashboard.js).
     */
    async saveDashboardSettings(values) {
      return postJSON(apiUrl('dashboard/settings'), { values });
    },

    /** Подробности объекта для правой панели. GET /object/{layerId}/{objectId} */
    async getObjectDetails(layerId, objectId) {
      const url = apiUrl(`object/${encodeURIComponent(layerId)}/${encodeURIComponent(objectId)}`);
      return getJSON(url);
    },

    /**
     * Настройки (фильтры) слоя для модального окна. GET /layer/{id}/settings
     * Форма ответа: { layerId, title, html } — html уже содержит <form class="settings-form">
     * с текущими значениями текущего пользователя (см. map.js: openLayerSettings).
     */
    async getLayerSettings(layerId) {
      const url = apiUrl(`layer/${encodeURIComponent(layerId)}/settings`);
      return getJSON(url);
    },

    /**
     * Сохранить настройки слоя. POST /layer/{id}/settings body: { values: {...} }
     * values собирается generic-обходом полей формы (см. map.js: collectSettingsValues).
     */
    async saveLayerSettings(layerId, values) {
      const url = apiUrl(`layer/${encodeURIComponent(layerId)}/settings`);
      return postJSON(url, { values });
    },

    /**
     * Действия JS → 1С (клик по объекту, редактирование геометрии, фильтры…).
     * POST /action  body: { action, payload }
     */
    async sendAction(action, payload) {
      return postJSON(apiUrl('action'), { action, payload });
    },

    /**
     * Список отчётов для вкладки «Отчёты». GET /reports
     * Форма ответа: Массив Из { id, name, meta, kind? }.
     */
    async getReports() {
      return getJSON(apiUrl('reports'));
    },

    /**
     * Данные одного отчёта. GET /report/{id}
     * Форма ответа зависит от kind в описании отчёта (см. getReports):
     *  - kind не задан/"table": { id, title, generatedAt, period:{begin,end},
     *    columns:[{key,label}], rows:[{...}], rowCount } — колонки/строки общие
     *    для любого такого отчёта (см. js/reports.js: рендер таблицы по columns,
     *    не по захардкоженным полям).
     *  - kind="rich": { id, kind:"rich", title, generatedAt, period:{begin,end},
     *    sections:[{ title, cards:[{ title, notes, elements:[...] }] }] } —
     *    карточный отчёт с таблицами/графиками вперемешку, см. js/rich-report.js.
     * Фильтры берутся из сохранённых настроек отчёта пользователя на сервере
     * (см. getReportSettings/saveReportSettings), а не из query-параметров —
     * тем же принципом, что и getDashboard().
     */
    async getReport(id) {
      return getJSON(apiUrl(`report/${encodeURIComponent(id)}`));
    },

    /**
     * Форма фильтров отчёта для модального окна. GET /report/{id}/settings
     * Форма ответа: { title, html } — см. getLayerSettings.
     */
    async getReportSettings(id) {
      return getJSON(apiUrl(`report/${encodeURIComponent(id)}/settings`));
    },

    /**
     * Сохранить фильтры отчёта. POST /report/{id}/settings body: { values: {...} }
     */
    async saveReportSettings(id, values) {
      return postJSON(apiUrl(`report/${encodeURIComponent(id)}/settings`), { values });
    },

    // apiUrl/getJSON/postJSON — общие примитивы транспорта, наружу для BackendPlugin'ов,
    // которым нужен собственный эндпоинт вне именованных методов выше (см. CLAUDE.md,
    // «Команды карты» — mapCommands: плагин сам полностью владеет своим HTTP-вызовом
    // (URL, payload), пользуясь той же авторизацией/401-обработкой, что и весь остальной
    // клиент, вместо дублирования fetch с нуля).
    apiUrl,
    getJSON,
    postJSON
  };
})();

window.MapAPI = MapAPI;
