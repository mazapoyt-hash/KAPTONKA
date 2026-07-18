import { CONFIG } from './config.js';
import {
  isBackendConfigured,
  listSupportPoints,
  listHelpNeeds,
  createSupportPoint,
  updateSupportPoint,
  getOwnedSupportPoint,
  closeSupportPoint,
  reportPointAbsent,
  confirmPointPresent,
  createHelpNeed,
  updateHelpNeed,
  getOwnedHelpNeed,
  closeHelpNeed,
  claimHelpNeed,
  uploadPointPhoto,
  getPointPhotoUrl,
} from './db.js';

const CATEGORY = {
  water: { label: 'Вода', icon: '💧' },
  cardboard: { label: 'Картон і маркери', icon: '🪧' },
  charging: { label: 'Зарядка', icon: '🔋' },
  toilet: { label: 'Туалет', icon: '🚻' },
  medical: { label: 'Медична допомога', icon: '🩹' },
  transport: { label: 'Транспорт', icon: '🚗' },
  printing: { label: 'Друк', icon: '🖨️' },
  shelter: { label: 'Укриття', icon: '🛡️' },
  other: { label: 'Інше', icon: '🤝' },
};

const state = {
  route: 'home',
  points: [],
  needs: [],
  updates: [],
  ownedPoints: [],
  ownedNeeds: [],
  ownerships: { points: {}, needs: {} },
  category: 'all',
  city: CONFIG.defaultCity,
  search: '',
  coords: null,
  loading: true,
  refreshing: false,
};

const root = document.querySelector('#main-content');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');
const tg = window.Telegram?.WebApp;

let currentMap = null;
let currentMarker = null;
let currentPhotoObjectUrl = '';

init();

async function init() {
  setupTelegram();
  bindGlobalEvents();
  render();
  state.ownerships = await readOwnerships();
  await refreshAll();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(`./sw.js?v=${CONFIG.dataVersion}`).then((registration) => registration.update()).catch(console.error);
  }

  setInterval(() => refreshAll({ quiet: true }), CONFIG.refreshIntervalMs);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll({ quiet: true });
  });
  tg?.onEvent?.('activated', () => refreshAll({ quiet: true }));
}

function setupTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('secondary_bg_color');
  tg.setBackgroundColor?.('bg_color');
  applyTelegramTheme();
  tg.onEvent?.('themeChanged', applyTelegramTheme);
}

function applyTelegramTheme() {
  document.documentElement.dataset.theme = tg?.colorScheme === 'dark' ? 'dark' : 'light';
}

async function refreshAll({ quiet = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  if (!quiet) state.loading = true;
  render();

  try {
    const stamp = encodeURIComponent(CONFIG.dataVersion || '3');
    const updatesPromise = fetch(`./data/updates.json?v=${stamp}`).then(assertJson).catch(() => []);

    if (isBackendConfigured()) {
      const [points, needs, updates] = await Promise.all([
        listSupportPoints(),
        listHelpNeeds(),
        updatesPromise,
      ]);
      state.points = normalizePoints(points);
      state.needs = Array.isArray(needs) ? needs : [];
      state.updates = Array.isArray(updates) ? updates : [];
      await refreshOwnedItems();
    } else {
      state.points = [];
      state.needs = [];
      state.updates = await updatesPromise;
      state.ownedPoints = [];
      state.ownedNeeds = [];
    }
  } catch (error) {
    console.error(error);
    if (!quiet) showToast(readableError(error));
  } finally {
    state.loading = false;
    state.refreshing = false;
    render();
  }
}

async function refreshOwnedItems() {
  const pointEntries = Object.entries(state.ownerships.points || {});
  const needEntries = Object.entries(state.ownerships.needs || {});

  const points = await Promise.all(pointEntries.map(async ([id, secret]) => {
    try {
      const data = await getOwnedSupportPoint(id, secret);
      return firstRow(data);
    } catch {
      return null;
    }
  }));

  const needs = await Promise.all(needEntries.map(async ([id, secret]) => {
    try {
      const data = await getOwnedHelpNeed(id, secret);
      return firstRow(data);
    } catch {
      return null;
    }
  }));

  state.ownedPoints = normalizePoints(points.filter(Boolean));
  state.ownedNeeds = needs.filter(Boolean);
}

function bindGlobalEvents() {
  document.addEventListener('click', async (event) => {
    if (!(event.target instanceof Element)) return;

    if (event.target.classList.contains('modal-backdrop')) {
      closeModal();
      return;
    }

    const target = event.target.closest('[data-route], [data-action], [data-category], [data-need], [data-point]');
    if (!target) return;

    if (target.dataset.route) navigate(target.dataset.route);
    if (target.dataset.category) {
      state.category = target.dataset.category;
      render();
    }
    if (target.dataset.need) openNeed(target.dataset.need);
    if (target.dataset.point) openPoint(target.dataset.point);
    if (target.dataset.action) await handleAction(target.dataset.action, target);
  });

  document.addEventListener('submit', async (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    if (event.target.id === 'point-form') {
      event.preventDefault();
      await submitPointForm(event.target);
    }
    if (event.target.id === 'need-form') {
      event.preventDefault();
      await submitNeedForm(event.target);
    }
    if (event.target.id === 'restore-form') {
      event.preventDefault();
      await submitRestoreControl(event.target);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modalRoot.childElementCount) closeModal();
  });

  document.addEventListener('input', (event) => {
    if (event.target.matches('[data-search]')) {
      const cursor = event.target.selectionStart ?? event.target.value.length;
      state.search = event.target.value;
      renderRouteBody();
      const input = document.querySelector('[data-search]');
      input?.focus();
      input?.setSelectionRange?.(cursor, cursor);
    }
  });

  document.addEventListener('change', async (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.matches('[data-city]')) {
      state.city = event.target.value;
      render();
    }
    if (event.target.matches('input[name="photo"]')) {
      previewPhoto(event.target.files?.[0]);
    }
  });
}

async function handleAction(action, target) {
  const handlers = {
    home: () => navigate('home'),
    'share-app': shareApp,
    'quick-category': () => { state.category = target.dataset.value; navigate('points'); },
    'create-point': () => openPointForm(),
    'edit-point': () => openEditPoint(target.dataset.id),
    'close-point': () => closeOwnedPoint(target.dataset.id),
    'report-absent': () => markPointAbsent(target.dataset.id),
    'confirm-present': () => markPointPresent(target.dataset.id),
    'create-need': () => openNeedForm(),
    'edit-need': () => openEditNeed(target.dataset.id),
    'close-need': () => closeOwnedNeed(target.dataset.id),
    'claim-need': () => claimNeed(target.dataset.id),
    nearby: requestLocationAndSort,
    'use-location': setFormCurrentLocation,
    'add-stock-row': addStockRow,
    'remove-stock-row': () => target.closest('.stock-row')?.remove(),
    'open-map': () => openMap(target.dataset.id),
    'share-point': () => sharePoint(target.dataset.id),
    'share-need': () => shareNeed(target.dataset.id),
    'close-modal': closeModal,
    'copy-control-code': () => copyText(target.dataset.code || ''),
    'open-contact': () => openExternal(target.dataset.url || ''),
    'refresh-data': () => refreshAll(),
    'restore-control': openRestoreControl,
  };
  await handlers[action]?.();
}

function navigate(route) {
  state.route = route;
  state.search = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  tg?.HapticFeedback?.selectionChanged?.();
  render();
}

function render() {
  document.querySelectorAll('[data-route]').forEach((button) => {
    button.classList.toggle('active', button.dataset.route === state.route);
  });
  renderRouteBody();
}

function renderRouteBody() {
  const pages = {
    home: renderHome,
    needs: renderNeeds,
    points: renderPoints,
    actions: renderMyItems,
  };
  root.innerHTML = (pages[state.route] || renderHome)();
}

function renderBackendWarning() {
  if (isBackendConfigured()) return '';
  return `
    <section class="section">
      <div class="setup-warning">
        <strong>Потрібне одноразове налаштування бази.</strong>
        <span>Створи Supabase-проєкт, виконай <code>supabase/setup.sql</code> та встав URL і anon key у <code>config.js</code>.</span>
      </div>
    </section>`;
}

function renderHome() {
  const activeNeeds = filterNeeds(state.needs).slice(0, 3);
  const activePoints = filterPoints(state.points).slice(0, 3);
  const latestUpdates = [...state.updates].sort(sortByDateDesc).slice(0, 2);

  return `
    <section class="hero">
      <span class="hero-badge">🇺🇦 Взаємодопомога на мирних акціях</span>
      <h1>Допомога, яку видно на карті</h1>
      <p>${escapeHtml(CONFIG.description)}</p>
      <div class="hero-actions">
        <button class="btn btn-primary" data-action="create-point">Створити точку</button>
        <button class="btn btn-soft" data-route="points">Знайти поруч</button>
      </div>
    </section>

    ${renderBackendWarning()}

    <section class="section">
      <div class="section-header"><div><h2>Я на акції</h2><p>Знайди необхідне за кілька секунд</p></div></div>
      <div class="quick-grid">
        ${Object.entries(CATEGORY).slice(0, 6).map(([key, item]) => `
          <button class="quick-card" data-action="quick-category" data-value="${key}">
            <span class="emoji">${item.icon}</span><strong>${item.label}</strong><small>Показати точки</small>
          </button>`).join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-header"><div><h2>Живі точки</h2><p>Фото, запаси та час роботи</p></div><button class="text-link" data-route="points">Усі</button></div>
      <div class="card-list">
        ${state.loading ? skeletons(2) : activePoints.length ? activePoints.map(renderPointCard).join('') : emptyState('📍', 'Активних точок поки немає', 'Постав воду, зарядку або матеріали та зареєструй точку за хвилину.')}
      </div>
    </section>

    <section class="section">
      <div class="section-header"><div><h2>Потреби</h2><p>Запити, які можна закрити прямо зараз</p></div><button class="text-link" data-route="needs">Усі</button></div>
      <div class="card-list">
        ${state.loading ? skeletons(2) : activeNeeds.length ? activeNeeds.map(renderNeedCard).join('') : emptyState('🤝', 'Відкритих потреб поки немає', 'Створи потребу всередині застосунку — вона одразу з’явиться у списку.')}
      </div>
      <button class="btn btn-blue btn-wide" data-action="create-need">Створити потребу</button>
    </section>

    ${latestUpdates.length ? `<section class="section"><div class="section-header"><div><h2>Актуальне</h2></div></div><div class="card-list">${latestUpdates.map(renderUpdateCard).join('')}</div></section>` : ''}

    <section class="section"><div class="info-box"><strong>Приватність.</strong> ${escapeHtml(CONFIG.privacyNote)}</div></section>
  `;
}

function renderPoints() {
  const cities = unique(['Усі міста', ...state.points.map((item) => item.city).filter(Boolean)]);
  const points = filterPoints(state.points);

  return `
    <div class="page-heading">
      <p class="eyebrow">Підтримка поруч</p>
      <h1>Живі точки допомоги</h1>
      <p>Кожна точка має фото, точне місце, актуальні запаси та час роботи.</p>
    </div>
    ${renderBackendWarning()}
    <div class="search-box">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 20-5.2-5.2A7.5 7.5 0 1 0 14.4 16L20 21ZM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0Z"/></svg>
      <input data-search value="${escapeAttr(state.search)}" placeholder="Пошук за назвою або адресою" />
    </div>
    <div class="section-header">
      <select class="chip" data-city aria-label="Фільтр за містом">
        ${cities.map((city) => `<option ${city === state.city ? 'selected' : ''}>${escapeHtml(city)}</option>`).join('')}
      </select>
      <button class="btn btn-soft" data-action="nearby">Поруч зі мною</button>
    </div>
    <div class="filter-row" style="margin-bottom:12px">
      <button class="chip ${state.category === 'all' ? 'active' : ''}" data-category="all">Усі</button>
      ${Object.entries(CATEGORY).map(([key, item]) => `<button class="chip ${state.category === key ? 'active' : ''}" data-category="${key}">${item.icon} ${item.label}</button>`).join('')}
    </div>
    <div class="card-list">
      ${state.loading ? skeletons(3) : points.length ? points.map(renderPointCard).join('') : emptyState('📍', 'Нічого не знайдено', 'Створи першу точку підтримки або зміни фільтри.')}
    </div>
    <section class="section"><button class="btn btn-primary btn-wide" data-action="create-point" ${isBackendConfigured() ? '' : 'disabled'}>＋ Створити точку підтримки</button></section>
  `;
}

function renderNeeds() {
  const cities = unique(['Усі міста', ...state.needs.map((item) => item.city).filter(Boolean)]);
  const needs = filterNeeds(state.needs);

  return `
    <div class="page-heading">
      <p class="eyebrow">Допомогти зараз</p>
      <h1>Потреби акцій</h1>
      <p>Запити створюються та закриваються безпосередньо всередині КАРТОНКИ.</p>
    </div>
    ${renderBackendWarning()}
    <div class="section-header">
      <select class="chip" data-city aria-label="Фільтр за містом">
        ${cities.map((city) => `<option ${city === state.city ? 'selected' : ''}>${escapeHtml(city)}</option>`).join('')}
      </select>
      <button class="btn btn-primary" data-action="create-need" ${isBackendConfigured() ? '' : 'disabled'}>Створити</button>
    </div>
    <div class="filter-row" style="margin-bottom:12px">
      <button class="chip ${state.category === 'all' ? 'active' : ''}" data-category="all">Усе</button>
      ${Object.entries(CATEGORY).map(([key, item]) => `<button class="chip ${state.category === key ? 'active' : ''}" data-category="${key}">${item.icon} ${item.label}</button>`).join('')}
    </div>
    <div class="card-list">
      ${state.loading ? skeletons(3) : needs.length ? needs.map(renderNeedCard).join('') : emptyState('🤝', 'Відкритих потреб немає', 'Створи запит — він одразу стане доступним людям поблизу.')}
    </div>
  `;
}

function renderMyItems() {
  return `
    <div class="page-heading">
      <p class="eyebrow">Керування</p>
      <h1>Мої точки й потреби</h1>
      <p>Тут можна оновити запаси, продовжити час роботи або закрити створений запис.</p>
      <button class="btn btn-soft" data-action="restore-control">Відновити доступ за кодом</button>
    </div>
    ${renderBackendWarning()}
    <section class="section">
      <div class="section-header"><div><h2>Мої точки</h2><p>${state.ownedPoints.length} створено на цьому пристрої</p></div><button class="text-link" data-action="create-point">Створити</button></div>
      <div class="card-list">${state.ownedPoints.length ? state.ownedPoints.map(renderOwnedPointCard).join('') : emptyState('📍', 'Ти ще не створював точки', 'Після створення тут з’явиться кнопка редагування.')}</div>
    </section>
    <section class="section">
      <div class="section-header"><div><h2>Мої потреби</h2><p>${state.ownedNeeds.length} створено на цьому пристрої</p></div><button class="text-link" data-action="create-need">Створити</button></div>
      <div class="card-list">${state.ownedNeeds.length ? state.ownedNeeds.map(renderOwnedNeedCard).join('') : emptyState('🤝', 'Ти ще не створював потреб', 'Створи запит і керуй ним прямо в застосунку.')}</div>
    </section>
  `;
}

function renderPointCard(point) {
  const distance = Number.isFinite(point.distance) ? `<span class="distance">${formatDistance(point.distance)}</span>` : '';
  const photo = getPointPhotoUrl(point.photo_path);
  const remaining = formatRemaining(point.controlled_until);
  const owned = Boolean(state.ownerships.points?.[point.id]);

  return `
    <article class="point-card visual-card" data-point="${escapeAttr(point.id)}">
      <div class="point-photo-wrap">
        <img class="point-photo" src="${escapeAttr(photo)}" alt="Фото точки ${escapeAttr(point.name)}" loading="lazy" />
        <span class="live-badge">● Працює ${remaining}</span>
      </div>
      <div class="point-card-body">
        <div class="card-top">
          <div><h3>${escapeHtml(point.name)}</h3><div class="meta"><span>${escapeHtml(point.city)}</span><span>•</span><span>${escapeHtml(point.address)}</span></div></div>
          ${distance}
        </div>
        <div class="point-services">${(point.services || []).map(serviceTag).join('')}</div>
        ${renderStockCompact(point.stock)}
        <div class="freshness-row"><span>Оновлено ${formatRelative(point.updated_at)}</span><span>${point.absence_report_count || 0}/${CONFIG.absenceReportsToHide} повідомлень про відсутність</span></div>
        <div class="card-actions">
          <button class="btn btn-blue" data-action="open-map" data-id="${point.id}">Маршрут</button>
          ${owned ? `<button class="btn btn-soft" data-action="edit-point" data-id="${point.id}">Редагувати</button>` : `<button class="btn btn-soft" data-action="share-point" data-id="${point.id}">↗</button>`}
        </div>
      </div>
    </article>`;
}

function renderOwnedPointCard(point) {
  const active = point.status === 'active' && +new Date(point.controlled_until) > Date.now();
  return `
    <article class="action-card">
      <div class="card-top"><div><h3>${escapeHtml(point.name)}</h3><div class="meta"><span>${escapeHtml(point.city)}</span><span>•</span><span>${escapeHtml(point.address)}</span></div></div><span class="status ${active ? 'open' : 'done'}">${active ? 'Активна' : point.status === 'hidden' ? 'Прихована' : 'Завершена'}</span></div>
      ${renderStockCompact(point.stock)}
      <p class="card-description">Контроль до: <strong>${formatDateTime(point.controlled_until)}</strong></p>
      <div class="card-actions"><button class="btn btn-primary" data-action="edit-point" data-id="${point.id}">Оновити</button><button class="btn btn-danger" data-action="close-point" data-id="${point.id}">Закрити</button></div>
    </article>`;
}

function renderNeedCard(item) {
  const category = CATEGORY[item.category] || CATEGORY.other;
  const owned = Boolean(state.ownerships.needs?.[item.id]);
  return `
    <article class="need-card" data-need="${escapeAttr(item.id)}">
      <div class="card-top"><div class="card-title-wrap"><span class="category-icon">${category.icon}</span><div><h3>${escapeHtml(item.title)}</h3><div class="meta"><span>${escapeHtml(item.city)}</span><span>•</span><span>${formatRelative(item.updated_at)}</span></div></div></div><span class="status open">Потрібно</span></div>
      <p class="card-description">${escapeHtml(item.description)}</p>
      ${item.quantity_text ? `<div class="need-quantity">Потрібно: <strong>${escapeHtml(item.quantity_text)}</strong></div>` : ''}
      <div class="progress-meta"><span>До ${formatDateTime(item.controlled_until)}</span><strong>${item.claimed_count || 0} відгуків</strong></div>
      <div class="card-actions">
        ${owned ? `<button class="btn btn-primary" data-action="edit-need" data-id="${item.id}">Редагувати</button>` : `<button class="btn btn-primary" data-action="claim-need" data-id="${item.id}">Я допоможу</button>`}
        <button class="btn btn-soft" data-action="share-need" data-id="${item.id}">↗</button>
      </div>
    </article>`;
}

function renderOwnedNeedCard(item) {
  const active = item.status === 'open' && +new Date(item.controlled_until) > Date.now();
  return `
    <article class="action-card">
      <div class="card-top"><div><h3>${escapeHtml(item.title)}</h3><div class="meta"><span>${escapeHtml(item.city)}</span><span>•</span><span>${item.claimed_count || 0} відгуків</span></div></div><span class="status ${active ? 'open' : 'done'}">${active ? 'Відкрита' : 'Закрита'}</span></div>
      <p class="card-description">${escapeHtml(item.description)}</p>
      <div class="card-actions"><button class="btn btn-primary" data-action="edit-need" data-id="${item.id}">Редагувати</button><button class="btn btn-danger" data-action="close-need" data-id="${item.id}">Закрити</button></div>
    </article>`;
}

function renderUpdateCard(item) {
  return `<article class="update-card"><div class="meta"><span>${formatDate(item.publishedAt)}</span></div><h3>${escapeHtml(item.title)}</h3><p class="card-description">${escapeHtml(item.text)}</p></article>`;
}

function openPoint(id) {
  const point = state.points.find((item) => item.id === id) || state.ownedPoints.find((item) => item.id === id);
  if (!point) return;
  const owned = Boolean(state.ownerships.points?.[point.id]);
  const photo = getPointPhotoUrl(point.photo_path);

  openModal(`
    <div class="modal-header"><div><p class="eyebrow">Жива точка</p><h2>${escapeHtml(point.name)}</h2></div><button class="modal-close" data-action="close-modal" aria-label="Закрити">×</button></div>
    <img class="modal-point-photo" src="${escapeAttr(photo)}" alt="Фото точки ${escapeAttr(point.name)}" />
    <div class="point-detail-location"><strong>${escapeHtml(point.address)}</strong><span>${escapeHtml(point.city)}</span></div>
    <div class="point-services">${(point.services || []).map(serviceTag).join('')}</div>
    <p class="card-description">${escapeHtml(point.description || 'Без додаткового опису.')}</p>
    <div class="detail-panel"><strong>Що є зараз</strong>${renderStockFull(point.stock)}</div>
    <div class="detail-panel"><strong>Час роботи</strong><span>Під контролем до ${formatDateTime(point.controlled_until)}</span><small>Оновлено ${formatRelative(point.updated_at)}</small></div>
    <div class="modal-actions">
      <button class="btn btn-blue btn-wide" data-action="open-map" data-id="${point.id}">Прокласти маршрут</button>
      ${owned ? `<button class="btn btn-primary btn-wide" data-action="edit-point" data-id="${point.id}">Редагувати точку</button>` : `
        <button class="btn btn-primary btn-wide" data-action="confirm-present" data-id="${point.id}">Точка працює ✓</button>
        <button class="btn btn-danger btn-wide" data-action="report-absent" data-id="${point.id}">Точки більше немає</button>`}
      <button class="btn btn-soft btn-wide" data-action="share-point" data-id="${point.id}">Поділитися</button>
    </div>
    ${!owned ? `<p class="modal-footnote">Після ${CONFIG.absenceReportsToHide} унікальних повідомлень про відсутність точка автоматично зникне зі списку. Власник може оновити дані й повернути її.</p>` : ''}
  `);
}

function openNeed(id) {
  const item = state.needs.find((need) => need.id === id) || state.ownedNeeds.find((need) => need.id === id);
  if (!item) return;
  const category = CATEGORY[item.category] || CATEGORY.other;
  const owned = Boolean(state.ownerships.needs?.[item.id]);

  openModal(`
    <div class="modal-header"><div><span class="category-icon">${category.icon}</span><h2>${escapeHtml(item.title)}</h2></div><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="meta"><span>${escapeHtml(item.city)}</span><span>•</span><span>${escapeHtml(item.meeting_place || '')}</span></div>
    <p class="card-description">${escapeHtml(item.description)}</p>
    ${item.quantity_text ? `<div class="detail-panel"><strong>Кількість</strong><span>${escapeHtml(item.quantity_text)}</span></div>` : ''}
    <div class="detail-panel"><strong>Актуально до</strong><span>${formatDateTime(item.controlled_until)}</span><small>${item.claimed_count || 0} людей уже відгукнулися</small></div>
    <div class="modal-actions">
      ${owned ? `<button class="btn btn-primary btn-wide" data-action="edit-need" data-id="${item.id}">Редагувати</button>` : `<button class="btn btn-primary btn-wide" data-action="claim-need" data-id="${item.id}">Я можу допомогти</button>`}
      <button class="btn btn-soft btn-wide" data-action="share-need" data-id="${item.id}">Поділитися</button>
    </div>
  `);
}

function openPointForm(point = null, secret = '') {
  if (!ensureBackend()) return;
  const isEdit = Boolean(point);
  const defaultUntil = toDateTimeLocal(point?.controlled_until || new Date(Date.now() + 4 * 3600000));
  const stock = Array.isArray(point?.stock) && point.stock.length ? point.stock : [{ label: 'Вода', quantity: '', unit: 'пляшок' }];
  const services = point?.services || ['water'];
  const lat = Number(point?.lat || state.coords?.lat || CONFIG.defaultMapCenter[0]);
  const lng = Number(point?.lng || state.coords?.lng || CONFIG.defaultMapCenter[1]);

  openModal(`
    <div class="modal-header"><div><p class="eyebrow">${isEdit ? 'Керування точкою' : 'Нова точка'}</p><h2>${isEdit ? 'Оновити інформацію' : 'Створити точку підтримки'}</h2></div><button class="modal-close" data-action="close-modal">×</button></div>
    <form id="point-form" class="form-grid" data-mode="${isEdit ? 'edit' : 'create'}" data-id="${point?.id || ''}" data-secret="${escapeAttr(secret)}">
      <div class="field">
        <label>Фото точки ${isEdit ? '(необов’язково змінювати)' : '*'}</label>
        <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" capture="environment" ${isEdit ? '' : 'required'} />
        <small>На фото мають бути видні сам столик або ресурси. Не фотографуй обличчя без згоди.</small>
        <div id="photo-preview" class="photo-preview ${point?.photo_path ? 'has-image' : ''}">${point?.photo_path ? `<img src="${escapeAttr(getPointPhotoUrl(point.photo_path))}" alt="Поточне фото" />` : '<span>Фото ще не вибрано</span>'}</div>
      </div>
      <div class="field"><label>Назва точки *</label><input name="name" required maxlength="100" value="${escapeAttr(point?.name || '')}" placeholder="Наприклад, Столик із водою біля входу" /></div>
      <div class="field two-cols"><div><label>Місто *</label><input name="city" required maxlength="80" value="${escapeAttr(point?.city || '')}" placeholder="Київ" /></div><div><label>Адреса або орієнтир *</label><input name="address" required maxlength="180" value="${escapeAttr(point?.address || '')}" placeholder="Майдан, біля фонтану" /></div></div>
      <div class="field"><label>Точне місце *</label><div id="point-map" class="point-map"></div><input type="hidden" name="lat" value="${lat}" /><input type="hidden" name="lng" value="${lng}" /><div class="map-toolbar"><button type="button" class="btn btn-soft" data-action="use-location">Взяти мою геолокацію</button><span id="coordinate-label">${lat.toFixed(5)}, ${lng.toFixed(5)}</span></div></div>
      <div class="field"><label>Короткий опис</label><textarea name="description" maxlength="1000" placeholder="Як знайти точку, кому звернутися, важливі умови">${escapeHtml(point?.description || '')}</textarea></div>
      <fieldset class="field"><legend>Що доступно *</legend><div class="service-checkbox-grid">${Object.entries(CATEGORY).map(([key, item]) => `<label class="service-check"><input type="checkbox" name="services" value="${key}" ${services.includes(key) ? 'checked' : ''}/><span>${item.icon} ${item.label}</span></label>`).join('')}</div></fieldset>
      <div class="field"><div class="field-heading"><label>Запаси зараз *</label><button type="button" class="text-link" data-action="add-stock-row">＋ Додати</button></div><div id="stock-rows" class="stock-rows">${stock.map(renderStockInputRow).join('')}</div><small>Власник може оновлювати кількість у будь-який момент.</small></div>
      <div class="field"><label>Планую контролювати точку до *</label><input type="datetime-local" name="controlled_until" required value="${defaultUntil}" /></div>
      <button type="submit" class="btn btn-primary btn-wide">${isEdit ? 'Зберегти й оновити точку' : 'Опублікувати точку'}</button>
    </form>
  `);

  setTimeout(() => initPointMap(lat, lng), 50);
}

async function openEditPoint(id) {
  closeModal();
  const secret = state.ownerships.points?.[id];
  if (!secret) return showToast('Код керування цією точкою не знайдено на пристрої.');
  setBusy(true, 'Завантажуємо точку…');
  try {
    const data = await getOwnedSupportPoint(id, secret);
    const point = normalizePoint(firstRow(data));
    if (!point) throw new Error('Точку не знайдено.');
    openPointForm(point, secret);
  } catch (error) {
    showToast(readableError(error));
  } finally {
    setBusy(false);
  }
}

async function submitPointForm(form) {
  if (!form.reportValidity()) return;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = form.dataset.mode === 'edit' ? 'Оновлюємо…' : 'Публікуємо…';

  try {
    const data = new FormData(form);
    const services = data.getAll('services');
    if (!services.length) throw new Error('Обери хоча б один тип допомоги.');
    const stock = collectStockRows(form);
    if (!stock.length) throw new Error('Додай хоча б одну позицію із запасами.');

    const controlledUntil = new Date(data.get('controlled_until'));
    if (!(controlledUntil > new Date())) throw new Error('Час завершення має бути в майбутньому.');

    const payload = {
      name: String(data.get('name')).trim(),
      city: String(data.get('city')).trim(),
      address: String(data.get('address')).trim(),
      lat: Number(data.get('lat')),
      lng: Number(data.get('lng')),
      description: String(data.get('description') || '').trim(),
      services,
      stock,
      controlled_until: controlledUntil.toISOString(),
      creator_label: telegramDisplayName(),
    };

    let photoPath = null;
    const file = data.get('photo');
    if (file instanceof File && file.size > 0) {
      const blob = await compressImage(file);
      photoPath = await uploadPointPhoto(blob);
    }

    if (form.dataset.mode === 'edit') {
      await updateSupportPoint(form.dataset.id, form.dataset.secret, payload, photoPath);
      showToast('Точку оновлено. Лічильник повідомлень про відсутність скинуто.');
    } else {
      if (!photoPath) throw new Error('Фото точки обов’язкове.');
      const secret = generateSecret();
      const pointId = String(await createSupportPoint(payload, secret, photoPath));
      state.ownerships.points[pointId] = secret;
      await saveOwnerships();
      tg?.HapticFeedback?.notificationOccurred?.('success');
      showControlCode('Точку опубліковано', pointId, secret, 'point');
    }

    await refreshAll({ quiet: true });
    if (form.dataset.mode === 'edit') {
      closeModal();
      navigate('actions');
    }
  } catch (error) {
    tg?.HapticFeedback?.notificationOccurred?.('error');
    showToast(readableError(error));
    submit.disabled = false;
    submit.textContent = form.dataset.mode === 'edit' ? 'Зберегти й оновити точку' : 'Опублікувати точку';
  }
}

function openNeedForm(item = null, secret = '') {
  if (!ensureBackend()) return;
  const isEdit = Boolean(item);
  openModal(`
    <div class="modal-header"><div><p class="eyebrow">${isEdit ? 'Керування потребою' : 'Нова потреба'}</p><h2>${isEdit ? 'Оновити запит' : 'Що потрібно людям?'}</h2></div><button class="modal-close" data-action="close-modal">×</button></div>
    <form id="need-form" class="form-grid" data-mode="${isEdit ? 'edit' : 'create'}" data-id="${item?.id || ''}" data-secret="${escapeAttr(secret)}">
      <div class="field two-cols"><div><label>Місто *</label><input name="city" required value="${escapeAttr(item?.city || '')}" placeholder="Київ" /></div><div><label>Категорія *</label><select name="category">${categoryOptions(item?.category)}</select></div></div>
      <div class="field"><label>Короткий заголовок *</label><input name="title" required maxlength="120" value="${escapeAttr(item?.title || '')}" placeholder="Потрібні 100 пляшок води" /></div>
      <div class="field"><label>Опис *</label><textarea name="description" required maxlength="1200" placeholder="Що саме потрібно та за яких умов">${escapeHtml(item?.description || '')}</textarea></div>
      <div class="field"><label>Кількість</label><input name="quantity_text" maxlength="120" value="${escapeAttr(item?.quantity_text || '')}" placeholder="Наприклад, 100 пляшок по 0,5 л" /></div>
      <div class="field"><label>Місце передачі *</label><input name="meeting_place" required maxlength="180" value="${escapeAttr(item?.meeting_place || '')}" placeholder="Біля центрального входу, синій намет" /></div>
      <div class="field"><label>Контакт для того, хто допоможе *</label><input name="contact" required maxlength="120" value="${escapeAttr(item?.contact || '')}" placeholder="@username або посилання" /><small>Контакт відкриється лише після натискання «Я допоможу».</small></div>
      <div class="field"><label>Актуально до *</label><input type="datetime-local" name="controlled_until" required value="${toDateTimeLocal(item?.controlled_until || new Date(Date.now() + 3 * 3600000))}" /></div>
      <button type="submit" class="btn btn-primary btn-wide">${isEdit ? 'Зберегти зміни' : 'Опублікувати потребу'}</button>
    </form>`);
}

async function openEditNeed(id) {
  closeModal();
  const secret = state.ownerships.needs?.[id];
  if (!secret) return showToast('Код керування потребою не знайдено.');
  setBusy(true, 'Завантажуємо потребу…');
  try {
    const data = await getOwnedHelpNeed(id, secret);
    const item = firstRow(data);
    if (!item) throw new Error('Потребу не знайдено.');
    openNeedForm(item, secret);
  } catch (error) {
    showToast(readableError(error));
  } finally {
    setBusy(false);
  }
}

async function submitNeedForm(form) {
  if (!form.reportValidity()) return;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = 'Зберігаємо…';

  try {
    const data = new FormData(form);
    const controlledUntil = new Date(data.get('controlled_until'));
    if (!(controlledUntil > new Date())) throw new Error('Час завершення має бути в майбутньому.');
    const payload = {
      city: String(data.get('city')).trim(),
      category: String(data.get('category')).trim(),
      title: String(data.get('title')).trim(),
      description: String(data.get('description')).trim(),
      quantity_text: String(data.get('quantity_text') || '').trim(),
      meeting_place: String(data.get('meeting_place')).trim(),
      contact: String(data.get('contact')).trim(),
      controlled_until: controlledUntil.toISOString(),
      creator_label: telegramDisplayName(),
    };

    if (form.dataset.mode === 'edit') {
      await updateHelpNeed(form.dataset.id, form.dataset.secret, payload);
      closeModal();
      showToast('Потребу оновлено.');
      navigate('actions');
    } else {
      const secret = generateSecret();
      const needId = String(await createHelpNeed(payload, secret));
      state.ownerships.needs[needId] = secret;
      await saveOwnerships();
      showControlCode('Потребу опубліковано', needId, secret, 'need');
    }
    await refreshAll({ quiet: true });
  } catch (error) {
    showToast(readableError(error));
    submit.disabled = false;
    submit.textContent = form.dataset.mode === 'edit' ? 'Зберегти зміни' : 'Опублікувати потребу';
  }
}

async function claimNeed(id) {
  if (!ensureBackend()) return;
  const item = state.needs.find((need) => need.id === id);
  if (!item) return;
  setBusy(true, 'Фіксуємо відгук…');
  try {
    const result = await claimHelpNeed(id, await getReporterKey());
    const contact = result?.contact || '';
    await refreshAll({ quiet: true });
    openModal(`
      <div class="modal-header"><div><p class="eyebrow">Дякуємо</p><h2>Твій відгук зафіксовано</h2></div><button class="modal-close" data-action="close-modal">×</button></div>
      <p class="card-description">Зв’яжися з автором потреби та домовся про передачу.</p>
      <div class="contact-card"><span>Контакт</span><strong>${escapeHtml(contact || 'Не вказано')}</strong></div>
      <div class="modal-actions">${normalizeUrl(contact) ? `<button class="btn btn-primary btn-wide" data-action="open-contact" data-url="${escapeAttr(normalizeUrl(contact))}">Відкрити контакт</button>` : `<button class="btn btn-primary btn-wide" data-action="copy-control-code" data-code="${escapeAttr(contact)}">Скопіювати контакт</button>`}<button class="btn btn-soft btn-wide" data-action="close-modal">Готово</button></div>`);
  } catch (error) {
    showToast(readableError(error));
  } finally {
    setBusy(false);
  }
}

async function markPointAbsent(id) {
  if (!ensureBackend()) return;
  const accepted = await confirmDialog('Ти зараз на місці й справді не бачиш цієї точки?');
  if (!accepted) return;
  setBusy(true, 'Зберігаємо повідомлення…');
  try {
    const result = await reportPointAbsent(id, await getReporterKey());
    await refreshAll({ quiet: true });
    closeModal();
    if (result?.hidden) showToast('Точку автоматично прибрано зі списку після 20 підтверджень.');
    else if (result?.accepted === false) showToast('Ти вже повідомляв про відсутність цієї точки.');
    else showToast(`Повідомлення враховано: ${result?.count || 1}/${CONFIG.absenceReportsToHide}.`);
  } catch (error) {
    showToast(readableError(error));
  } finally {
    setBusy(false);
  }
}

async function markPointPresent(id) {
  if (!ensureBackend()) return;
  setBusy(true, 'Підтверджуємо точку…');
  try {
    await confirmPointPresent(id, await getReporterKey());
    await refreshAll({ quiet: true });
    closeModal();
    showToast('Дякуємо — ти підтвердив, що точка працює.');
  } catch (error) {
    showToast(readableError(error));
  } finally {
    setBusy(false);
  }
}

async function closeOwnedPoint(id) {
  const secret = state.ownerships.points?.[id];
  if (!secret) return;
  if (!await confirmDialog('Закрити точку та прибрати її з публічного списку?')) return;
  try {
    await closeSupportPoint(id, secret);
    await refreshAll({ quiet: true });
    showToast('Точку закрито.');
  } catch (error) {
    showToast(readableError(error));
  }
}

async function closeOwnedNeed(id) {
  const secret = state.ownerships.needs?.[id];
  if (!secret) return;
  if (!await confirmDialog('Закрити потребу?')) return;
  try {
    await closeHelpNeed(id, secret);
    await refreshAll({ quiet: true });
    showToast('Потребу закрито.');
  } catch (error) {
    showToast(readableError(error));
  }
}

function openRestoreControl() {
  openModal(`
    <div class="modal-header"><div><p class="eyebrow">Відновлення</p><h2>Код керування</h2></div><button class="modal-close" data-action="close-modal">×</button></div>
    <p class="card-description">Встав резервний код, який було показано після створення точки або потреби.</p>
    <form id="restore-form" class="form-grid">
      <div class="field"><label>Резервний код</label><textarea name="code" required placeholder="P-... або N-..."></textarea></div>
      <button class="btn btn-primary btn-wide" type="submit">Відновити доступ</button>
    </form>`);
}

async function submitRestoreControl(form) {
  const code = String(new FormData(form).get('code') || '').trim();
  const match = code.match(/^([PN])-([0-9a-f-]{36})\.([0-9a-f]{40,})$/i);
  if (!match) return showToast('Код має неправильний формат.');
  const [, type, id, secret] = match;
  setBusy(true, 'Перевіряємо код…');
  try {
    if (type.toUpperCase() === 'P') {
      const row = firstRow(await getOwnedSupportPoint(id, secret));
      if (!row) throw new Error('Точку не знайдено.');
      state.ownerships.points[id] = secret;
    } else {
      const row = firstRow(await getOwnedHelpNeed(id, secret));
      if (!row) throw new Error('Потребу не знайдено.');
      state.ownerships.needs[id] = secret;
    }
    await saveOwnerships();
    await refreshAll({ quiet: true });
    closeModal();
    showToast('Доступ відновлено.');
    navigate('actions');
  } catch (error) {
    showToast(readableError(error));
  } finally {
    setBusy(false);
  }
}

function showControlCode(title, id, secret, type) {
  const code = `${type === 'point' ? 'P' : 'N'}-${id}.${secret}`;
  openModal(`
    <div class="modal-header"><div><p class="eyebrow">Готово</p><h2>${escapeHtml(title)}</h2></div><button class="modal-close" data-action="close-modal">×</button></div>
    <p class="card-description">Редагування вже доступне у вкладці «Мої дії» на цьому пристрої. Збережи резервний код на випадок очищення даних Telegram.</p>
    <div class="control-code">${escapeHtml(code)}</div>
    <div class="modal-actions"><button class="btn btn-primary btn-wide" data-action="copy-control-code" data-code="${escapeAttr(code)}">Скопіювати резервний код</button><button class="btn btn-soft btn-wide" data-action="close-modal">Готово</button></div>`);
}

function addStockRow() {
  const container = document.querySelector('#stock-rows');
  if (!container) return;
  if (container.children.length >= 20) return showToast('Максимум 20 позицій.');
  container.insertAdjacentHTML('beforeend', renderStockInputRow({ label: '', quantity: '', unit: '' }));
}

function renderStockInputRow(item = {}) {
  return `<div class="stock-row"><input name="stock_label" maxlength="80" placeholder="Що є" value="${escapeAttr(item.label || '')}" required /><input name="stock_quantity" maxlength="40" placeholder="Кількість" value="${escapeAttr(item.quantity || '')}" required /><input name="stock_unit" maxlength="40" placeholder="Одиниця" value="${escapeAttr(item.unit || '')}" /><button type="button" class="stock-remove" data-action="remove-stock-row" aria-label="Видалити">×</button></div>`;
}

function collectStockRows(form) {
  return [...form.querySelectorAll('.stock-row')].map((row) => ({
    label: row.querySelector('[name="stock_label"]')?.value.trim(),
    quantity: row.querySelector('[name="stock_quantity"]')?.value.trim(),
    unit: row.querySelector('[name="stock_unit"]')?.value.trim(),
  })).filter((item) => item.label && item.quantity);
}

function renderStockCompact(stock = []) {
  if (!Array.isArray(stock) || !stock.length) return '';
  return `<div class="stock-pills">${stock.slice(0, 4).map((item) => `<span><strong>${escapeHtml(item.quantity)}</strong> ${escapeHtml(item.unit || '')} ${escapeHtml(item.label)}</span>`).join('')}${stock.length > 4 ? `<span>＋${stock.length - 4}</span>` : ''}</div>`;
}

function renderStockFull(stock = []) {
  if (!Array.isArray(stock) || !stock.length) return '<span>Кількість не вказана</span>';
  return `<div class="stock-list">${stock.map((item) => `<div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.quantity)} ${escapeHtml(item.unit || '')}</strong></div>`).join('')}</div>`;
}

function serviceTag(key) {
  const item = CATEGORY[key] || CATEGORY.other;
  return `<span class="service-tag">${item.icon} ${item.label}</span>`;
}

function initPointMap(lat, lng) {
  const container = document.querySelector('#point-map');
  if (!container || !window.L) return;
  currentMap?.remove?.();
  currentMap = window.L.map(container, { zoomControl: true }).setView([lat, lng], CONFIG.defaultMapZoom);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(currentMap);
  currentMarker = window.L.marker([lat, lng], { draggable: true }).addTo(currentMap);
  const update = ({ lat: newLat, lng: newLng }) => updateFormCoordinates(newLat, newLng);
  currentMarker.on('dragend', () => update(currentMarker.getLatLng()));
  currentMap.on('click', (event) => {
    currentMarker.setLatLng(event.latlng);
    update(event.latlng);
  });
  setTimeout(() => currentMap.invalidateSize(), 100);
}

function updateFormCoordinates(lat, lng) {
  const form = document.querySelector('#point-form');
  if (!form) return;
  form.elements.lat.value = Number(lat).toFixed(7);
  form.elements.lng.value = Number(lng).toFixed(7);
  const label = document.querySelector('#coordinate-label');
  if (label) label.textContent = `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

async function setFormCurrentLocation() {
  try {
    const coords = await requestCurrentCoordinates();
    state.coords = coords;
    currentMap?.setView([coords.lat, coords.lng], 17);
    currentMarker?.setLatLng([coords.lat, coords.lng]);
    updateFormCoordinates(coords.lat, coords.lng);
    showToast('Місце визначено. Перетягни маркер для точності.');
  } catch (error) {
    showToast(readableError(error));
  }
}

async function requestLocationAndSort() {
  try {
    state.coords = await requestCurrentCoordinates();
    render();
    showToast('Точки відсортовано за відстанню.');
  } catch (error) {
    showToast(readableError(error));
  }
}

function requestCurrentCoordinates() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Геолокація не підтримується.'));
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => reject(new Error('Не вдалося отримати геолокацію. Дозволь доступ у налаштуваннях Telegram.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  });
}

function previewPhoto(file) {
  const preview = document.querySelector('#photo-preview');
  if (!preview || !(file instanceof File)) return;
  if (currentPhotoObjectUrl) URL.revokeObjectURL(currentPhotoObjectUrl);
  currentPhotoObjectUrl = URL.createObjectURL(file);
  preview.classList.add('has-image');
  preview.innerHTML = `<img src="${currentPhotoObjectUrl}" alt="Попередній перегляд фото" />`;
}

async function compressImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('Обери файл зображення.');
  if (file.size > CONFIG.maxPhotoSizeMb * 1024 * 1024 * 4) throw new Error('Фото занадто велике. Обери інше зображення.');

  const source = await loadImageSource(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  if (source.__objectUrl) URL.revokeObjectURL(source.__objectUrl);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error('Не вдалося обробити фото.');
  if (blob.size > CONFIG.maxPhotoSizeMb * 1024 * 1024) throw new Error(`Фото має бути до ${CONFIG.maxPhotoSizeMb} МБ.`);
  return blob;
}

async function loadImageSource(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file); } catch {}
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { image.__objectUrl = url; resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не вдалося прочитати фото.')); };
    image.src = url;
  });
}

function filterPoints(items) {
  const q = state.search.trim().toLowerCase();
  return [...items]
    .map((item) => state.coords && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng)) ? { ...item, distance: haversine(state.coords.lat, state.coords.lng, Number(item.lat), Number(item.lng)) } : item)
    .filter((item) => state.category === 'all' || (item.services || []).includes(state.category))
    .filter((item) => state.city === 'Усі міста' || item.city === state.city)
    .filter((item) => !q || `${item.name} ${item.address} ${item.city}`.toLowerCase().includes(q))
    .sort((a, b) => Number.isFinite(a.distance) && Number.isFinite(b.distance) ? a.distance - b.distance : +new Date(b.updated_at) - +new Date(a.updated_at));
}

function filterNeeds(items) {
  return [...items]
    .filter((item) => state.category === 'all' || item.category === state.category)
    .filter((item) => state.city === 'Усі міста' || item.city === state.city)
    .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at));
}

function normalizePoints(points = []) {
  return points.map(normalizePoint).filter(Boolean);
}

function normalizePoint(point) {
  if (!point) return null;
  return {
    ...point,
    services: Array.isArray(point.services) ? point.services : [],
    stock: Array.isArray(point.stock) ? point.stock : typeof point.stock === 'string' ? safeJson(point.stock, []) : [],
    lat: Number(point.lat),
    lng: Number(point.lng),
  };
}

function openMap(id) {
  const point = state.points.find((item) => item.id === id) || state.ownedPoints.find((item) => item.id === id);
  if (!point) return;
  openExternal(`https://www.openstreetmap.org/?mlat=${encodeURIComponent(point.lat)}&mlon=${encodeURIComponent(point.lng)}#map=18/${encodeURIComponent(point.lat)}/${encodeURIComponent(point.lng)}`);
}

function sharePoint(id) {
  const point = state.points.find((item) => item.id === id) || state.ownedPoints.find((item) => item.id === id);
  if (!point) return;
  const text = `📍 ${point.name}\n${point.city}, ${point.address}\nПрацює до ${formatDateTime(point.controlled_until)}\n\n${getAppUrl()}`;
  shareText(text);
}

function shareNeed(id) {
  const item = state.needs.find((need) => need.id === id) || state.ownedNeeds.find((need) => need.id === id);
  if (!item) return;
  const text = `${(CATEGORY[item.category] || CATEGORY.other).icon} ${item.title}\n${item.city}: ${item.description}\n\n${getAppUrl()}`;
  shareText(text);
}

function shareApp() {
  shareText(`${CONFIG.appName} — ${CONFIG.tagline}\n${getAppUrl()}`);
}

async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ title: CONFIG.appName, text });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  openExternal(`https://t.me/share/url?url=${encodeURIComponent(getAppUrl())}&text=${encodeURIComponent(text)}`);
}

function openModal(content) {
  closeMapOnly();
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true">${content}</section></div>`;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  closeMapOnly();
  modalRoot.innerHTML = '';
  document.body.style.overflow = '';
  if (currentPhotoObjectUrl) URL.revokeObjectURL(currentPhotoObjectUrl);
  currentPhotoObjectUrl = '';
}

function closeMapOnly() {
  currentMap?.remove?.();
  currentMap = null;
  currentMarker = null;
}

function setBusy(active, message = '') {
  let node = document.querySelector('#global-busy');
  if (active && !node) {
    document.body.insertAdjacentHTML('beforeend', `<div id="global-busy" class="global-busy"><div class="spinner"></div><span>${escapeHtml(message)}</span></div>`);
  } else if (!active) {
    node?.remove();
  }
}

function showToast(message) {
  toastRoot.innerHTML = `<div class="toast">${escapeHtml(message)}</div>`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toastRoot.innerHTML = ''; }, 4200);
}

function ensureBackend() {
  if (isBackendConfigured()) return true;
  showToast('Спочатку налаштуй Supabase за інструкцією в README.md.');
  return false;
}

function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getReporterKey() {
  const keyName = 'kartonka_reporter_key_v3';
  let value = await cloudStorageGet(keyName);
  if (!value) {
    value = `reporter:${generateSecret()}`;
    await cloudStorageSet(keyName, value);
  }
  return value;
}

function cloudStorageGet(key) {
  return new Promise((resolve) => {
    if (tg?.CloudStorage?.getItem) {
      tg.CloudStorage.getItem(key, (error, value) => resolve(!error && value ? value : localStorage.getItem(key)));
      return;
    }
    resolve(localStorage.getItem(key));
  });
}

function cloudStorageSet(key, value) {
  localStorage.setItem(key, value);
  return new Promise((resolve) => {
    if (tg?.CloudStorage?.setItem) {
      tg.CloudStorage.setItem(key, value, () => resolve());
      return;
    }
    resolve();
  });
}

async function readOwnerships() {
  const raw = await storageGet('kartonka_ownerships_v3', true);
  return safeJson(raw, { points: {}, needs: {} });
}

async function saveOwnerships() {
  await storageSet('kartonka_ownerships_v3', JSON.stringify(state.ownerships), true);
}

function storageGet(key, secure) {
  return new Promise((resolve) => {
    const storage = secure ? tg?.SecureStorage : tg?.DeviceStorage;
    if (storage?.getItem) {
      storage.getItem(key, (error, value) => {
        if (!error && value != null) resolve(value);
        else resolve(localStorage.getItem(key));
      });
      return;
    }
    resolve(localStorage.getItem(key));
  });
}

function storageSet(key, value, secure) {
  localStorage.setItem(key, value);
  return new Promise((resolve) => {
    const storage = secure ? tg?.SecureStorage : tg?.DeviceStorage;
    if (storage?.setItem) {
      storage.setItem(key, value, () => resolve());
      return;
    }
    resolve();
  });
}

function telegramDisplayName() {
  const user = tg?.initDataUnsafe?.user;
  if (!user) return '';
  return [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 100);
}

function confirmDialog(text) {
  return new Promise((resolve) => {
    if (tg?.showConfirm) tg.showConfirm(text, resolve);
    else resolve(window.confirm(text));
  });
}

function readableError(error) {
  const message = String(error?.message || error || 'Сталася невідома помилка.');
  if (/Failed to fetch|NetworkError/i.test(message)) return 'Немає з’єднання з базою. Перевір інтернет і налаштування Supabase.';
  if (/row-level security|permission denied|403/i.test(message)) return 'База відхилила операцію. Повторно виконай supabase/setup.sql.';
  if (/duplicate key/i.test(message)) return 'Ця дія вже була врахована.';
  return message;
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function formatRemaining(value) {
  const minutes = Math.round((+new Date(value) - Date.now()) / 60000);
  if (minutes <= 0) return 'завершена';
  if (minutes < 60) return `ще ${minutes} хв`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `ще ${hours} год${rest ? ` ${rest} хв` : ''}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatRelative(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'щойно';
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'щойно';
  if (minutes < 60) return `${minutes} хв тому`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} год тому`;
  return formatDateTime(value);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date);
}

function toDateTimeLocal(value) {
  const date = value instanceof Date ? value : new Date(value);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function categoryOptions(selected = '') {
  return Object.entries(CATEGORY).map(([key, item]) => `<option value="${key}" ${selected === key ? 'selected' : ''}>${item.icon} ${item.label}</option>`).join('');
}

function getAppUrl() { return CONFIG.publicAppUrl || window.location.href.split('#')[0]; }
function normalizeUrl(value = '') { const text = String(value).trim(); if (!text) return ''; try { const url = new URL(text.startsWith('@') ? `https://t.me/${text.slice(1)}` : text, window.location.href); return ['http:', 'https:', 'tg:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
function openExternal(url) { const safe = normalizeUrl(url); if (!safe) return showToast('Некоректне посилання.'); const parsed = new URL(safe); if ((parsed.hostname === 't.me' || parsed.protocol === 'tg:') && tg?.openTelegramLink) tg.openTelegramLink(safe); else if (tg?.openLink) tg.openLink(safe); else window.open(safe, '_blank', 'noopener,noreferrer'); }
function assertJson(response) { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }
function unique(items) { return [...new Set(items)]; }
function sortByDateDesc(a, b) { return +new Date(b.updatedAt || b.publishedAt || 0) - +new Date(a.updatedAt || a.publishedAt || 0); }
function formatDistance(km) { return km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(1)} км`; }
function haversine(lat1, lon1, lat2, lon2) { const r = 6371; const dLat = toRad(lat2-lat1); const dLon = toRad(lon2-lon1); const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2; return 2*r*Math.asin(Math.sqrt(a)); }
function toRad(value) { return value * Math.PI / 180; }
function safeJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function skeletons(count) { return Array.from({ length: count }, () => '<div class="skeleton"></div>').join(''); }
function emptyState(icon, title, text) { return `<div class="empty-state"><span class="emoji">${icon}</span><strong>${title}</strong><span>${text}</span></div>`; }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
function escapeAttr(value = '') { return escapeHtml(value); }
async function copyText(text) { try { await navigator.clipboard.writeText(text); showToast('Скопійовано.'); } catch { showToast('Не вдалося скопіювати.'); } }
