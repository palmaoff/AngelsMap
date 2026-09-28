/* =====================================================================
   Экран входа во внешнюю карту.

   Карта отдаёт данные только аутентифицированным пользователям 1С —
   публикация проверяет Basic-auth заголовок против реальных пользователей
   информационной базы (см. api.js). Отдельного эндпоинта логина нет:
   MapAPI.login() просто пробует введённый заголовок на GET /layers и, если
   сервер его принял, сохраняет сессию — до этого момента MapApp вообще не
   инициализируется.
   ===================================================================== */

const MapAuth = (function () {

  // Гасит стартовый экран-заглушку (см. index.html: #bootScreen, css/styles.css:
  // .boot-screen) — статичная разметка, которая видна ещё до выполнения этого
  // скрипта, поэтому вместо пустого экрана на время логина/MapApp.init() видно,
  // что приложение уже загружается. Удаляем узел из DOM только после того, как
  // доиграет transition (а не сразу display:none) — иначе исчезновение было бы
  // резким, без анимации. Идемпотентна: повторный вызов (после того как узел уже
  // убран) просто ничего не делает.
  function hideBootScreen() {
    const el = document.getElementById('bootScreen');
    if (!el) return;
    el.classList.add('is-hidden');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }

  // Название приложения — из плагина (BackendPlugin.appTitle), ядро своего бренда
  // не имеет; тот же текст уходит в document.title (см. init).
  function appTitle() {
    return (window.BackendPlugin && BackendPlugin.appTitle) || 'Карта';
  }

  function renderLoginScreen(onSuccess) {
    document.getElementById('app').insertAdjacentHTML('beforeend', `
      <div class="auth-overlay" id="authOverlay">
        <form class="auth-card" id="authForm">
          <div class="auth-card__title">${appTitle()}</div>
          <div class="auth-card__subtitle">Вход под учётной записью 1С</div>
          <label class="auth-field">
            <span>Логин</span>
            <input type="text" id="authLogin" name="username" autocomplete="username" autofocus required>
          </label>
          <label class="auth-field">
            <span>Пароль</span>
            <input type="password" id="authPassword" name="password" autocomplete="current-password">
          </label>
          <div class="auth-error" id="authError"></div>
          <button type="submit" class="btn btn--primary auth-submit" id="authSubmit">Войти</button>
        </form>
      </div>`);
    hideBootScreen();

    const overlay   = document.getElementById('authOverlay');
    const form      = document.getElementById('authForm');
    const submitBtn = document.getElementById('authSubmit');
    const errorEl   = document.getElementById('authError');

    form.addEventListener('submit', async e => {
      e.preventDefault();

      const login    = document.getElementById('authLogin').value.trim();
      const password = document.getElementById('authPassword').value;
      if (!login) return;

      errorEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Проверка…';

      const result = await MapAPI.login(login, password);

      if (result.ok) {
        overlay.remove();
        onSuccess();
        return;
      }

      errorEl.textContent = result.status === 401
        ? 'Неверный логин или пароль'
        : 'Не удалось подключиться к серверу';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Войти';
    });
  }

  function renderUserBadge() {
    // Вход не требуется (BackendPlugin.requiresAuth === false) — выходить не из
    // чего, в подвале только подпись режима (BackendPlugin.anonymousLabel).
    if (!MapAPI.isAuthRequired()) {
      const label = (window.BackendPlugin && BackendPlugin.anonymousLabel) || 'Без входа';
      document.getElementById('panelLayersFooter').innerHTML = `
        <div class="auth-badge"><span class="auth-badge__login" title="${label}">${label}</span></div>`;
      return;
    }
    const login = MapAPI.getAuthLogin();
    // Живёт внутри panel__footer панели «Слои карты» (см. map.js: buildChrome),
    // а не как отдельный плавающий блок — сворачивается вместе с панелью и не
    // требует резервировать под себя место где-то ещё на экране.
    document.getElementById('panelLayersFooter').innerHTML = `
      <div class="auth-badge" id="authBadge">
        <span class="auth-badge__login" title="${login}">${login}</span>
        <button class="auth-badge__logout" id="authLogout" title="Выйти">Выйти</button>
      </div>`;
    document.getElementById('authLogout').addEventListener('click', () => {
      MapAPI.logout();
      window.location.reload();
    });
  }

  async function startApp() {
    // panelLayersFooter появляется в buildChrome() — дожидаемся, чтобы не
    // промахнуться мимо ещё не созданного узла.
    await MapApp.init();
    // Карта и панель слоёв уже построены — самое время убрать заглушку.
    // Для уже авторизованной сессии (без экрана логина) это первый и
    // единственный момент, когда #bootScreen вообще скрывается.
    hideBootScreen();
    renderUserBadge();
    // Плавающий переключатель экранов и заглушки Дашборда/Отчётов — после
    // карты: тот же принцип, что и раньше не показывать ничего до логина.
    AppShell.init();
  }

  function init() {
    document.title = appTitle();

    // Анонимный бэкенд (requiresAuth === false): ни формы входа, ни перезагрузки
    // по 401 — перезагрузка там ничего бы не изменила и ушла бы в цикл.
    if (!MapAPI.isAuthRequired()) {
      startApp();
      return;
    }

    // Сессия протухла или пароль сменили прямо во время работы с картой —
    // 401 от любого запроса (см. api.js: dropAuth) сбрасывает localStorage.
    // Проще перезагрузить страницу, чем аккуратно останавливать уже
    // инициализированный Leaflet и разбирать частично отрисованные слои.
    window.addEventListener('mapapi:unauthorized', () => window.location.reload());

    if (MapAPI.isAuthenticated()) {
      startApp();
    } else {
      renderLoginScreen(startApp);
    }
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', MapAuth.init);
window.MapAuth = MapAuth;
