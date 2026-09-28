/* =====================================================================
   API-слой карты.

   Весь обмен с 1С сосредоточен здесь. Ходит в реальные HTTP-сервисы 1С
   (см. src/HTTPServices/API.xml + src/CommonModules/АнгелКартографияВнешнееAPI
   в конфигурации «Ангел»). Контракт (форма аргументов и ответа) — то, на чём
   завязан map.js — соответствует тому, что реально отдают эти сервисы.

   Соответствие с реализацией в конфигурации «Ангел»:
     getLayers()        ~ АнгелКартографияВнешнееAPI.ПолучитьСлои
     getLayerData()      ~ АнгелКартографияВнешнееAPI.ПолучитьДанныеСлоя
     getHeatmap()        ~ АнгелКартографияВнешнееAPI.ПолучитьТепловуюКарту (Безбилетники.ДанныеДляСлоя)
     getObjectDetails()  ~ АнгелКартографияВнешнееAPI.ПолучитьДетали
     getLayerSettings()  ~ АнгелКартографияВнешнееAPI.ПолучитьНастройкиСлоя (ещё не реализовано в 1С)
     saveLayerSettings() ~ АнгелКартографияВнешнееAPI.СохранитьНастройкиСлоя (ещё не реализовано в 1С)
     sendAction()        ~ АнгелКартографияВнешнееAPI.ВыполнитьДействие
     getReports()        ~ ААКартографияВнешнееAPI.ПолучитьОтчеты (АА-проект, map-api/)
     getReport()         ~ ААКартографияВнешнееAPI.ПолучитьДанныеОтчета
     getReportSettings() ~ ААКартографияВнешнееAPI.ПолучитьНастройкиОтчета
     saveReportSettings()~ ААКартографияВнешнееAPI.СохранитьНастройкиОтчета

   apiUrl/getJSON/postJSON экспортированы наружу (см. низ файла) сверх именованных
   методов выше — не для общего пользования, а специально для BackendPlugin.mapCommands
   (см. CLAUDE.md, "Backend plugins"/"Маршрут с очагами аварийности"): у команды карты
   может быть собственный эндпоинт, специфичный ровно одному бэкенду, которому не место
   в общей таблице методов этого файла — так плагин ходит по HTTP сам, без дублирования
   auth/401-логики.
   ===================================================================== */

const MapAPI = (function () {

  // Настройки — baseUrl/страховочные center/zoom в window.BackendPlugin
  // (js/backends/<id>.js, конкретный бэкенд), рендер-тюнинг в js/config.js
  // (MapConfig, общий для любого бэкенда). api.js отвечает только за обмен
  // с 1С, не за хранение конфигурации.

  // ------------------------------------------------------------- auth
  // Публикация 1С аутентифицирует запросы стандартным HTTP Basic-auth по
  // реальным пользователям информационной базы (а не единым техническим
  // APIUser, как раньше) — благодаря этому сервер сам резолвит
  // ТекущийПользователь(), и все фильтры слоёв (ХранилищеОбщихНастроек, см.
  // АнгелКартографияВнешнееAPI) читаются/пишутся уже для конкретного
  // залогинившегося пользователя. Заголовок хранится в localStorage —
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

  function authHeaders() {
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

  // Сервер отдаёт данные слоя в естественной форме, не сводя её к одной (см. map-api,
  // ААКартографияВнешнееAPI.ПодготовитьДанныеСлоя): у части слоёв это готовый массив
  // объектов, у точечных (ДТП/Дислокации/знаки/…) — объект { key, date: [...] }, где
  // сами объекты лежат в .date. Клиент сам определяет, что пришло, и достаёт из этого
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

  // credentials: 'omit' на каждом запросе — иначе браузер (замечено в Chrome)
  // сам показывает нативное окно "Войдите в систему" поверх нашей формы
  // логина при любом 401 + WWW-Authenticate: Basic, даже когда Authorization
  // уже выставлен вручную в заголовках. С 'omit' браузер не пытается сам
  // разруливать аутентификацию — 401 просто долетает до кода как обычный ответ.
  async function getJSON(url) {
    const r = await fetch(url, { headers: authHeaders(), credentials: 'omit' });
    if (r.status === 401) dropAuth();
    if (!r.ok) throw httpError(url, r);
    return r.json();
  }

  async function postJSON(url, body) {
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

  // Сырое бинарное тело (File/Blob), не JSON — для эндпоинтов вроде
  // /import/dtp-insurance, где сервер и разбирает, и валидирует файл целиком
  // сам (см. uploadInsuranceRegistry ниже). Отличается от postJSON тем, что
  // ответ читается как JSON НЕЗАВИСИМО от r.ok: сервер может вернуть
  // { ok:false, error } как структурную ошибку с кодом 200, так и с не-2xx
  // статусом — вызывающему коду нужно тело в обоих случаях, а не только при
  // успехе. Бросает исключение только когда тело вообще не JSON (настоящая
  // сетевая/HTTP ошибка без осмысленного ответа сервиса).
  async function postBinary(url, file, extraHeaders) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...(extraHeaders || {}), ...authHeaders() },
      credentials: 'omit',
      body: file
    });
    if (r.status === 401) dropAuth();
    try {
      return await r.json();
    } catch (e) {
      if (!r.ok) throw httpError(url, r);
      throw e;
    }
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
     * Форма ответа: { center: [широта, долгота], zoom }. См. map-api,
     * ААКартографияВнешнееAPI.ПолучитьНастройкиКарты — источник координат тот же,
     * что использует нативная карта 1С при сборке своей страницы.
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
     * объектом { key, date: [...] } у точечных слоёв (сервер её не сводит, см. map-api,
     * ААКартографияВнешнееAPI.ПодготовитьДанныеСлоя). extractFeatures определяет форму и
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

    /** Тепловой слой пассажиропотока. GET /heatmap */
    async getHeatmap(params = {}) {
      const qs = new URLSearchParams(params).toString();
      const url = apiUrl('heatmap') + (qs ? `?${qs}` : '');
      return getJSON(url);
    },

    /**
     * Сводка для экрана «Дашборд». GET /dashboard
     * Форма ответа: { id, title, region, period:{begin,end}, appg, onlyRegistered,
     * generatedAt, data:{ kpi, dyn, vidy, narush, mesto, osvet, doroga, factors } } —
     * см. map-api, ААКартографияВнешнееAPI.ПолучитьДашборд. Фильтры (период/учётные)
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

    /**
     * Перевести карту в срез дашборда. POST /dashboard/focus
     * body: { contractorId } либо { adminUnitId }
     * Сервер делает MERGE переданного ключа в уже сохранённый фильтр слоя
     * «ТранспортныеСредства», в отличие от saveLayerSettings(), который пишет
     * форму целиком и обнулил бы непереданные поля (ГРЗ, тип ТС, марка…).
     * Поэтому переход «клик по строке дашборда → карта с отбором» идёт именно
     * сюда, а не в saveLayerSettings (см. js/backends/clean-roads.js, focusOnMap()).
     */
    async focusDashboard(params) {
      return postJSON(apiUrl('dashboard/focus'), params);
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
     * Форма ответа: Массив Из { id, name, meta } — см. map-api,
     * ААКартографияВнешнееAPI.ПолучитьОтчеты.
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

    /**
     * Загрузка реестра страхования (xlsx) — тело запроса сырые байты выбранного
     * пользователем файла (объект File из <input type="file">), без Base64/
     * FormData-обёртки; весь разбор и запись в базу происходят на сервере.
     * POST /import/dtp-insurance, заголовки Content-Type: application/octet-stream +
     * X-Filename (для сообщений об ошибках/логов на сервере, на поведение не влияет).
     * Ответ — { ok:true, summary:{total,created,duplicates,errors}, rows:[{row,
     * status,comment,dtpRef}] } либо { ok:false, error } (см. postBinary — тело
     * читается как JSON независимо от HTTP-статуса, вызывающий код сам проверяет
     * body.ok, а не полагается на r.ok).
     */
    async uploadInsuranceRegistry(file) {
      return postBinary(apiUrl('import/dtp-insurance'), file, {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name)
      });
    },

    // apiUrl/getJSON/postJSON — общие примитивы транспорта, наружу для BackendPlugin'ов,
    // которым нужен собственный эндпоинт вне именованных методов выше (см. CLAUDE.md,
    // "Backend plugins" — mapCommands: плагин сам полностью владеет своим HTTP-вызовом
    // (URL, payload), пользуясь той же авторизацией/401-обработкой, что и весь остальной
    // клиент, вместо дублирования fetch с нуля).
    apiUrl,
    getJSON,
    postJSON
  };
})();

window.MapAPI = MapAPI;
