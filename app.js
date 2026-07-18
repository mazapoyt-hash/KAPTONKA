import { CONFIG } from './config.js';

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

const STATUS = {
  open: { label: 'Потрібно', className: 'open' },
  urgent: { label: 'Терміново', className: 'urgent' },
  onway: { label: 'Вже їде', className: 'onway' },
  done: { label: 'Закрито', className: 'done' },
};

const state = {
  route: 'home',
  needs: [],
  points: [],
  updates: [],
  category: 'all',
  city: CONFIG.defaultCity,
  search: '',
  coords: null,
  loading: true,
  actions: readLocal('kartonka-actions', []),
};

const root = document.querySelector('#main-content');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');
const tg = window.Telegram?.WebApp;
let generatedRequestText = '';

init();

async function init() {
  setupTelegram();
  bindGlobalEvents();
  render();

  try {
    const stamp = encodeURIComponent(CONFIG.dataVersion || '2');
    const [needs, points, updates] = await Promise.all([
      fetch(`./data/needs.json?v=${stamp}`).then(assertJson),
      fetch(`./data/points.json?v=${stamp}`).then(assertJson),
      fetch(`./data/updates.json?v=${stamp}`).then(assertJson),
    ]);
    state.needs = Array.isArray(needs) ? needs : [];
    state.points = Array.isArray(points) ? points : [];
    state.updates = Array.isArray(updates) ? updates : [];
  } catch (error) {
    console.error(error);
    showToast('Не вдалося оновити дані. Показуємо збережену версію, якщо вона є.');
  } finally {
    state.loading = false;
    render();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=2.1.0').then((registration) => registration.update()).catch(console.error);
  }
}

function setupTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('secondary_bg_color');
  tg.setBackgroundColor?.('bg_color');
  document.documentElement.dataset.theme = tg.colorScheme === 'dark' ? 'dark' : 'light';
  tg.onEvent?.('themeChanged', () => {
    document.documentElement.dataset.theme = tg.colorScheme === 'dark' ? 'dark' : 'light';
  });
}

function bindGlobalEvents() {
  document.addEventListener('click', (event) => {
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
    if (target.dataset.action) handleAction(target.dataset.action, target);
  });

  document.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    if (event.target.id === 'report-form') {
      event.preventDefault();
      submitReport();
    }
    if (event.target.id === 'point-form') {
      event.preventDefault();
      submitPoint();
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

  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-city]')) {
      state.city = event.target.value;
      render();
    }
  });
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
    actions: renderActions,
  };
  root.innerHTML = (pages[state.route] || renderHome)();
}

function renderHome() {
  const activeNeeds = filterNeeds(state.needs).filter((item) => item.status !== 'done').slice(0, 3);
  const latestUpdates = [...state.updates].sort(sortByDateDesc).slice(0, 2);

  return `
    <section class="hero">
      <span class="hero-badge">🇺🇦 Взаємодопомога на мирних акціях</span>
      <h1>Що потрібно людям просто зараз?</h1>
      <p>${escapeHtml(CONFIG.description)}</p>
      <div class="hero-actions">
        <button class="btn btn-primary" data-route="needs">Допомогти зараз</button>
        <button class="btn btn-soft" data-route="points">Знайти поруч</button>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div><h2>Я на акції</h2><p>Знайди необхідне за кілька секунд</p></div>
      </div>
      <div class="quick-grid">
        ${Object.entries(CATEGORY).slice(0, 6).map(([key, item]) => `
          <button class="quick-card" data-action="quick-category" data-value="${key}">
            <span class="emoji">${item.icon}</span>
            <strong>${item.label}</strong>
            <small>Показати точки</small>
          </button>`).join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div><h2>Потрібно зараз</h2><p>Конкретні запити від перевірених координаторів</p></div>
        <button class="text-link" data-route="needs">Усі</button>
      </div>
      <div class="card-list">
        ${state.loading ? skeletons(2) : activeNeeds.length ? activeNeeds.map(renderNeedCard).join('') : emptyState('🤝', 'Поки немає перевірених потреб', 'Нові запити з’являться тут після підтвердження координаторами.')}
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div><h2>Повідомити про потребу</h2><p>Якщо щось закінчується або потрібна допомога</p></div>
      </div>
      <button class="btn btn-blue btn-wide" data-action="report-need">Створити повідомлення координаторам</button>
    </section>

    ${latestUpdates.length ? `
    <section class="section">
      <div class="section-header"><div><h2>Актуальне</h2><p>Важливі зміни та оголошення</p></div></div>
      <div class="card-list">${latestUpdates.map(renderUpdateCard).join('')}</div>
    </section>` : ''}

    <section class="section">
      <div class="info-box"><strong>Приватність.</strong> ${escapeHtml(CONFIG.privacyNote)}</div>
    </section>
  `;
}

function renderNeeds() {
  const cities = unique(['Усі міста', ...state.needs.map((item) => item.city).filter(Boolean)]);
  const items = filterNeeds(state.needs);

  return `
    <div class="page-heading">
      <p class="eyebrow">Допомогти дистанційно</p>
      <h1>Потреби акцій</h1>
      <p>Обери конкретний запит, підтвердь допомогу та зв’яжись із координатором.</p>
    </div>
    <div class="section-header">
      <div class="filter-row">
        <button class="chip ${state.category === 'all' ? 'active' : ''}" data-category="all">Усе</button>
        ${Object.entries(CATEGORY).map(([key, item]) => `<button class="chip ${state.category === key ? 'active' : ''}" data-category="${key}">${item.icon} ${item.label}</button>`).join('')}
      </div>
    </div>
    <div class="section-header">
      <select class="chip" data-city aria-label="Фільтр за містом">
        ${cities.map((city) => `<option ${city === state.city ? 'selected' : ''}>${escapeHtml(city)}</option>`).join('')}
      </select>
      <button class="text-link" data-action="report-need">Повідомити про потребу</button>
    </div>
    <div class="card-list">
      ${state.loading ? skeletons(3) : items.length ? items.map(renderNeedCard).join('') : emptyState('🤝', 'Поки немає перевірених потреб', 'Повідом про потребу — після перевірки координаторами вона з’явиться у списку.')}
    </div>
  `;
}

function renderPoints() {
  const cities = unique(['Усі міста', ...state.points.map((item) => item.city).filter(Boolean)]);
  const points = filterPoints(state.points);

  return `
    <div class="page-heading">
      <p class="eyebrow">Підтримка поруч</p>
      <h1>Живі точки допомоги</h1>
      <p>Вода, зарядка, туалет, медична допомога, картон та інші ресурси поблизу.</p>
    </div>
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
      <button class="chip ${state.category === 'all' ? 'active' : ''}" data-category="all">Усі послуги</button>
      ${Object.entries(CATEGORY).map(([key, item]) => `<button class="chip ${state.category === key ? 'active' : ''}" data-category="${key}">${item.icon} ${item.label}</button>`).join('')}
    </div>
    <div class="card-list">
      ${state.loading ? skeletons(3) : points.length ? points.map(renderPointCard).join('') : emptyState('📍', 'Поки немає перевірених точок', 'Запропонуй точку підтримки — після перевірки вона з’явиться у списку.')}
    </div>
    <section class="section">
      <button class="btn btn-blue btn-wide" data-action="add-point">Запропонувати точку підтримки</button>
    </section>
  `;
}

function renderActions() {
  return `
    <div class="page-heading">
      <p class="eyebrow">Збережено на цьому пристрої</p>
      <h1>Мої дії</h1>
      <p>Запити, які ти пообіцяв допомогти закрити. Цей список нікуди не передається.</p>
    </div>
    <div class="card-list">
      ${state.actions.length ? state.actions.map(renderActionCard).join('') : emptyState('💛', 'Поки немає збережених дій', 'Обери потребу та натисни «Я допоможу».')}
    </div>
    <section class="section">
      <div class="form-card">
        <h2 style="margin-top:0">Інші способи допомогти</h2>
        <div class="form-grid">
          <button class="btn btn-soft btn-wide" data-action="report-need">Повідомити про потребу</button>
          <button class="btn btn-soft btn-wide" data-action="add-point">Запропонувати точку підтримки</button>
          <button class="btn btn-danger btn-wide" data-action="clear-actions">Очистити мої дії</button>
        </div>
      </div>
    </section>
  `;
}

function renderNeedCard(item) {
  const category = CATEGORY[item.category] || CATEGORY.other;
  const status = STATUS[item.status] || STATUS.open;
  const percent = Math.min(100, Math.max(0, Number(item.progress || 0)));
  const saved = state.actions.some((action) => action.needId === item.id && action.status !== 'done');
  return `
    <article class="need-card" data-need="${escapeAttr(item.id)}">
      <div class="card-top">
        <div class="card-title-wrap">
          <span class="category-icon">${category.icon}</span>
          <div>
            <h3>${escapeHtml(item.title)}</h3>
            <div class="meta"><span>${escapeHtml(item.city || '')}</span><span>•</span><span>${formatRelative(item.updatedAt)}</span></div>
          </div>
        </div>
        <span class="status ${status.className}">${status.label}</span>
      </div>
      <p class="card-description">${escapeHtml(item.description || '')}</p>
      <div class="progress-track"><span style="width:${percent}%"></span></div>
      <div class="progress-meta"><span>${escapeHtml(item.progressText || `${percent}% закрито`)}</span><strong>${percent}%</strong></div>
      <div class="card-actions">
        <button class="btn ${saved ? 'btn-soft' : 'btn-primary'}" data-action="help-need" data-id="${escapeAttr(item.id)}" ${item.status === 'done' ? 'disabled' : ''}>
          ${item.status === 'done' ? 'Потребу закрито' : saved ? 'Збережено ✓' : 'Я допоможу'}
        </button>
        <button class="btn btn-soft" data-action="share-need" data-id="${escapeAttr(item.id)}" aria-label="Поділитися">↗</button>
      </div>
    </article>
  `;
}

function renderPointCard(point) {
  const distance = Number.isFinite(point.distance) ? `<span class="distance">${formatDistance(point.distance)}</span>` : '';
  return `
    <article class="point-card" data-point="${escapeAttr(point.id)}">
      <div class="card-top">
        <div>
          <h3 style="margin:0 0 6px">${escapeHtml(point.name)}</h3>
          <div class="meta"><span>${escapeHtml(point.city || '')}</span><span>•</span><span>${escapeHtml(point.address || '')}</span></div>
        </div>
        ${distance}
      </div>
      <div class="point-services">
        ${(point.services || []).map((key) => `<span class="service-tag">${(CATEGORY[key] || CATEGORY.other).icon} ${(CATEGORY[key] || CATEGORY.other).label}</span>`).join('')}
      </div>
      <p class="card-description">${escapeHtml(point.note || '')}</p>
      <div class="card-actions">
        <button class="btn btn-blue" data-action="open-map" data-id="${escapeAttr(point.id)}">Прокласти маршрут</button>
        <button class="btn btn-soft" data-action="share-point" data-id="${escapeAttr(point.id)}">↗</button>
      </div>
    </article>
  `;
}

function renderUpdateCard(item) {
  return `
    <article class="update-card">
      <div class="meta"><span>${formatDate(item.publishedAt)}</span>${item.city ? `<span>•</span><span>${escapeHtml(item.city)}</span>` : ''}</div>
      <h3 style="margin:8px 0 7px">${escapeHtml(item.title)}</h3>
      <p class="card-description" style="margin:0">${escapeHtml(item.text)}</p>
    </article>
  `;
}

function renderActionCard(action) {
  const item = state.needs.find((need) => need.id === action.needId);
  return `
    <article class="action-card">
      <div class="card-top">
        <div>
          <div class="meta"><span>${formatDate(action.createdAt)}</span></div>
          <h3 style="margin:7px 0">${escapeHtml(item?.title || action.title || 'Допомога') }</h3>
          <p class="card-description" style="margin:0">${escapeHtml(item?.city || action.city || '')}</p>
        </div>
        <span class="status ${action.status === 'done' ? 'done' : 'onway'}">${action.status === 'done' ? 'Виконано' : 'Заплановано'}</span>
      </div>
      <div class="card-actions" style="margin-top:14px">
        <button class="btn btn-primary" data-action="toggle-action" data-id="${escapeAttr(action.id)}">${action.status === 'done' ? 'Повернути' : 'Позначити виконаним'}</button>
        <button class="btn btn-soft" data-action="remove-action" data-id="${escapeAttr(action.id)}">Видалити</button>
      </div>
    </article>
  `;
}

function filterNeeds(items) {
  return [...items]
    .filter((item) => state.category === 'all' || item.category === state.category)
    .filter((item) => state.city === 'Усі міста' || item.city === state.city)
    .sort((a, b) => {
      const priority = { urgent: 0, open: 1, onway: 2, done: 3 };
      return (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || sortByDateDesc(a, b);
    });
}

function filterPoints(items) {
  const q = state.search.trim().toLowerCase();
  return [...items]
    .map((item) => state.coords && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng)) ? { ...item, distance: haversine(state.coords.lat, state.coords.lng, Number(item.lat), Number(item.lng)) } : item)
    .filter((item) => state.category === 'all' || (item.services || []).includes(state.category))
    .filter((item) => state.city === 'Усі міста' || item.city === state.city)
    .filter((item) => !q || `${item.name} ${item.address} ${item.city}`.toLowerCase().includes(q))
    .sort((a, b) => Number.isFinite(a.distance) && Number.isFinite(b.distance) ? a.distance - b.distance : String(a.name).localeCompare(String(b.name), 'uk'));
}

function handleAction(action, target) {
  const handlers = {
    home: () => navigate('home'),
    'share-app': shareApp,
    'quick-category': () => { state.category = target.dataset.value; navigate('points'); },
    'report-need': openReportNeed,
    'add-point': openAddPoint,
    nearby: requestLocation,
    'help-need': () => helpNeed(target.dataset.id),
    'share-need': () => shareNeed(target.dataset.id),
    'open-map': () => openMap(target.dataset.id),
    'share-point': () => sharePoint(target.dataset.id),
    'toggle-action': () => toggleAction(target.dataset.id),
    'remove-action': () => removeAction(target.dataset.id),
    'clear-actions': clearActions,
    'close-modal': closeModal,
    'submit-report': submitReport,
    'submit-point': submitPoint,
    'copy-generated': copyGeneratedRequest,
    'share-generated': shareGeneratedRequest,
    'contact-coordinator': () => openExternal(CONFIG.coordinatorTelegram),
  };
  handlers[action]?.();
}

function openNeed(id) {
  const item = state.needs.find((need) => need.id === id);
  if (!item) return;
  const category = CATEGORY[item.category] || CATEGORY.other;
  const status = STATUS[item.status] || STATUS.open;
  openModal(`
    <div class="modal-header">
      <div><span class="category-icon">${category.icon}</span><h2 style="margin-top:12px">${escapeHtml(item.title)}</h2></div>
      <button type="button" class="modal-close" data-action="close-modal" aria-label="Закрити">×</button>
    </div>
    <span class="status ${status.className}">${status.label}</span>
    <p class="card-description">${escapeHtml(item.description || '')}</p>
    <div class="info-box">
      <strong>Місто:</strong> ${escapeHtml(item.city || '—')}<br />
      <strong>Координатор:</strong> ${escapeHtml(item.coordinator || 'Перевірений координатор')}<br />
      <strong>Оновлено:</strong> ${formatDate(item.updatedAt)}
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary btn-wide" data-action="help-need" data-id="${escapeAttr(item.id)}">Я допоможу</button>
      ${item.actionUrl ? `<a class="btn btn-blue btn-wide" href="${escapeAttr(item.actionUrl)}" target="_blank" rel="noopener">Перейти до виконання</a>` : ''}
      <button class="btn btn-soft btn-wide" data-action="share-need" data-id="${escapeAttr(item.id)}">Поділитися запитом</button>
    </div>
  `);
}

function openPoint(id) {
  const point = state.points.find((item) => item.id === id);
  if (!point) return;
  openModal(`
    <div class="modal-header">
      <div><p class="eyebrow" style="margin:0 0 6px">Точка підтримки</p><h2>${escapeHtml(point.name)}</h2></div>
      <button type="button" class="modal-close" data-action="close-modal" aria-label="Закрити">×</button>
    </div>
    <p class="card-description">${escapeHtml(point.note || '')}</p>
    <div class="info-box"><strong>${escapeHtml(point.address || '')}</strong><br />${escapeHtml(point.city || '')}</div>
    <div class="point-services">${(point.services || []).map((key) => `<span class="service-tag">${(CATEGORY[key] || CATEGORY.other).icon} ${(CATEGORY[key] || CATEGORY.other).label}</span>`).join('')}</div>
    <div class="modal-actions">
      <button class="btn btn-blue btn-wide" data-action="open-map" data-id="${escapeAttr(point.id)}">Прокласти маршрут</button>
      ${point.contactUrl ? `<a class="btn btn-soft btn-wide" href="${escapeAttr(point.contactUrl)}" target="_blank" rel="noopener">Зв’язатися</a>` : ''}
    </div>
  `);
}

function helpNeed(id) {
  const item = state.needs.find((need) => need.id === id);
  if (!item || item.status === 'done') return;
  const existing = state.actions.find((action) => action.needId === id && action.status !== 'done');
  if (!existing) {
    state.actions.unshift({ id: crypto.randomUUID?.() || String(Date.now()), needId: id, title: item.title, city: item.city, status: 'planned', createdAt: new Date().toISOString() });
    saveActions();
    tg?.HapticFeedback?.notificationOccurred?.('success');
    showToast('Дію збережено. Тепер зв’яжися з координатором та підтвердь деталі.');
  } else {
    showToast('Ця потреба вже є у твоєму списку.');
  }
  closeModal();
  render();
  const url = item.contactUrl || CONFIG.coordinatorTelegram;
  if (url && url !== 'https://t.me/') setTimeout(() => openExternal(url), 350);
}

function shareNeed(id) {
  const item = state.needs.find((need) => need.id === id);
  if (!item) return;
  shareContent(`${(CATEGORY[item.category] || CATEGORY.other).icon} ${item.title}\n${item.city}\n${item.description}\n\nДопомогти через КАРТОНКУ:`, getAppUrl());
}

function sharePoint(id) {
  const point = state.points.find((item) => item.id === id);
  if (!point) return;
  shareContent(`📍 ${point.name}\n${point.address}, ${point.city}\nДоступно: ${(point.services || []).map((key) => (CATEGORY[key] || CATEGORY.other).label).join(', ')}\n\nКАРТОНКА:`, getAppUrl());
}

function shareApp() {
  shareContent(`${CONFIG.appName} — ${CONFIG.tagline}\n${CONFIG.description}`, getAppUrl());
}

async function shareContent(text, url) {
  if (navigator.share) {
    try { await navigator.share({ title: CONFIG.appName, text, url }); return; } catch {}
  }
  openExternal(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
}

function openMap(id) {
  const point = state.points.find((item) => item.id === id);
  if (!point) return;
  const url = point.mapUrl || (Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)) ? `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${point.address}, ${point.city}`)}`);
  openExternal(url);
}

function requestLocation() {
  if (!navigator.geolocation) return showToast('Геолокація не підтримується на цьому пристрої.');
  showToast('Визначаємо точки поруч…');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => { state.coords = { lat: coords.latitude, lng: coords.longitude }; render(); showToast('Точки відсортовано за відстанню.'); },
    () => showToast('Не вдалося отримати геолокацію. Перевір дозвіл у налаштуваннях.'),
    { enableHighAccuracy: false, timeout: 9000, maximumAge: 120000 },
  );
}

function openReportNeed() {
  openModal(`
    <div class="modal-header"><div><p class="eyebrow" style="margin:0 0 6px">Повідомлення координаторам</p><h2>Чого не вистачає?</h2></div><button type="button" class="modal-close" data-action="close-modal" aria-label="Закрити">×</button></div>
    <form id="report-form" class="form-grid">
      <div class="field"><label>Місто</label><input name="city" required placeholder="Наприклад, Київ" /></div>
      <div class="field"><label>Категорія</label><select name="category">${categoryOptions()}</select></div>
      <div class="field"><label>Що саме потрібно</label><textarea name="description" required placeholder="Коротко опиши потребу, кількість і де її передати"></textarea></div>
      <div class="field"><label>Як із тобою зв’язатися</label><input name="contact" placeholder="Telegram username або контакт координатора" /><small>Не публікуй номер телефону у відкритому доступі без потреби.</small></div>
      <button type="submit" class="btn btn-primary btn-wide">Сформувати запит</button>
    </form>
  `);
}

function submitReport() {
  const form = document.querySelector('#report-form');
  if (!form?.reportValidity()) return;
  const data = new FormData(form);
  const category = CATEGORY[data.get('category')] || CATEGORY.other;
  const text = `Нова потреба для КАРТОНКИ\n\nМісто: ${data.get('city')}\nКатегорія: ${category.label}\nПотреба: ${data.get('description')}\nКонтакт: ${data.get('contact') || 'не вказано'}\n\nПотрібна перевірка координатором перед публікацією.`;
  showGeneratedRequest('Запит сформовано', text);
}

function openAddPoint() {
  openModal(`
    <div class="modal-header"><div><p class="eyebrow" style="margin:0 0 6px">Нова точка</p><h2>Запропонувати підтримку</h2></div><button type="button" class="modal-close" data-action="close-modal" aria-label="Закрити">×</button></div>
    <form id="point-form" class="form-grid">
      <div class="field"><label>Назва місця або організації</label><input name="name" required placeholder="Кав’ярня, офіс, волонтерська точка" /></div>
      <div class="field"><label>Місто та адреса</label><input name="address" required placeholder="Київ, вул. …" /></div>
      <div class="field"><label>Що доступно</label><textarea name="services" required placeholder="Вода, зарядка, туалет, картон…"></textarea></div>
      <div class="field"><label>Контакт</label><input name="contact" placeholder="Telegram або сайт" /></div>
      <button type="submit" class="btn btn-primary btn-wide">Сформувати пропозицію</button>
    </form>
  `);
}

function submitPoint() {
  const form = document.querySelector('#point-form');
  if (!form?.reportValidity()) return;
  const data = new FormData(form);
  const text = `Нова точка підтримки для КАРТОНКИ\n\nНазва: ${data.get('name')}\nАдреса: ${data.get('address')}\nДоступно: ${data.get('services')}\nКонтакт: ${data.get('contact') || 'не вказано'}\n\nПотрібна перевірка координатором перед публікацією.`;
  showGeneratedRequest('Пропозицію сформовано', text);
}

function showGeneratedRequest(title, text) {
  generatedRequestText = text;
  openModal(`
    <div class="modal-header">
      <div><p class="eyebrow" style="margin:0 0 6px">Готово до надсилання</p><h2>${escapeHtml(title)}</h2></div>
      <button type="button" class="modal-close" data-action="close-modal" aria-label="Закрити">×</button>
    </div>
    <p class="card-description">Перевір текст. Він не публікується автоматично — ти сам обираєш, куди його надіслати.</p>
    <textarea class="generated-request" readonly aria-label="Сформований текст">${escapeHtml(text)}</textarea>
    <div class="modal-actions">
      <button type="button" class="btn btn-primary btn-wide" data-action="share-generated">Надіслати в Telegram</button>
      <button type="button" class="btn btn-soft btn-wide" data-action="copy-generated">Скопіювати текст</button>
      <button type="button" class="btn btn-soft btn-wide" data-action="close-modal">Закрити</button>
    </div>
  `);
}

async function copyGeneratedRequest() {
  if (!generatedRequestText) return;
  const copied = await copyText(generatedRequestText);
  showToast(copied ? 'Текст скопійовано.' : 'Не вдалося скопіювати текст. Виділи його вручну.');
}

async function shareGeneratedRequest() {
  if (!generatedRequestText) return;

  const coordinator = normalizeUrl(CONFIG.coordinatorTelegram);
  if (coordinator) {
    await copyText(generatedRequestText);
    showToast('Текст скопійовано. Відкриваємо контакт координаторів.');
    openExternal(coordinator);
    return;
  }

  openExternal(`https://t.me/share/url?url=${encodeURIComponent(getAppUrl())}&text=${encodeURIComponent(generatedRequestText)}`);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const success = document.execCommand('copy');
    area.remove();
    return success;
  } catch {
    return false;
  }
}

async function copyAndShare(text) {
  let copied = false;
  try {
    copied = await copyText(text);
  } catch {}

  const coordinator = normalizeUrl(CONFIG.coordinatorTelegram);
  if (coordinator) {
    showToast(copied ? 'Текст скопійовано. Відкриваємо контакт координаторів.' : 'Відкриваємо контакт координаторів.');
    openExternal(coordinator);
    return;
  }

  if (navigator.share) {
    try {
      await navigator.share({ title: CONFIG.appName, text });
      showToast('Повідомлення готове до надсилання.');
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }

  showToast(copied ? 'Текст скопійовано. Обери чат, у який його надіслати.' : 'Обери чат, у який надіслати повідомлення.');
  openExternal(`https://t.me/share/url?url=&text=${encodeURIComponent(text)}`);
}

function toggleAction(id) {
  const action = state.actions.find((item) => item.id === id);
  if (!action) return;
  action.status = action.status === 'done' ? 'planned' : 'done';
  saveActions();
  render();
}

function removeAction(id) {
  state.actions = state.actions.filter((item) => item.id !== id);
  saveActions();
  render();
}

function clearActions() {
  if (!state.actions.length) return;
  if (!confirm('Очистити всі збережені дії на цьому пристрої?')) return;
  state.actions = [];
  saveActions();
  render();
}

function saveActions() {
  localStorage.setItem('kartonka-actions', JSON.stringify(state.actions));
}

function openModal(content) {
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true">${content}</section></div>`;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalRoot.innerHTML = '';
  document.body.style.overflow = '';
  generatedRequestText = '';
}

function showToast(message) {
  toastRoot.innerHTML = `<div class="toast">${escapeHtml(message)}</div>`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toastRoot.innerHTML = ''; }, 3200);
}


function skeletons(count) { return Array.from({ length: count }, () => '<div class="skeleton"></div>').join(''); }
function emptyState(icon, title, text) { return `<div class="empty-state"><span class="emoji">${icon}</span><strong>${title}</strong><span>${text}</span></div>`; }
function categoryOptions() { return Object.entries(CATEGORY).map(([key, item]) => `<option value="${key}">${item.icon} ${item.label}</option>`).join(''); }
function getAppUrl() { return CONFIG.publicAppUrl || window.location.href.split('#')[0]; }
function openExternal(url) { const safeUrl = normalizeUrl(url); if (!safeUrl) return showToast('Посилання поки не налаштоване.'); const parsed = new URL(safeUrl); if ((parsed.hostname === 't.me' || parsed.protocol === 'tg:') && tg?.openTelegramLink) { tg.openTelegramLink(safeUrl); return; } tg?.openLink ? tg.openLink(safeUrl) : window.open(safeUrl, '_blank', 'noopener,noreferrer'); }
function normalizeUrl(value='') { const text = String(value).trim(); if (!text) return ''; try { const url = new URL(text, window.location.href); return ['http:', 'https:', 'tg:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
function assertJson(response) { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }
function readLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function unique(items) { return [...new Set(items)]; }
function sortByDateDesc(a, b) { return +new Date(b.updatedAt || b.publishedAt || 0) - +new Date(a.updatedAt || a.publishedAt || 0); }
function formatDate(value) { if (!value) return '—'; const date = new Date(value); if (Number.isNaN(date.getTime())) return '—'; return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date); }
function formatRelative(value) { if (!value) return 'щойно'; const minutes = Math.max(0, Math.round((Date.now() - +new Date(value)) / 60000)); if (minutes < 1) return 'щойно'; if (minutes < 60) return `${minutes} хв тому`; const hours = Math.round(minutes / 60); if (hours < 24) return `${hours} год тому`; return formatDate(value); }
function formatDistance(km) { return km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(1)} км`; }
function haversine(lat1, lon1, lat2, lon2) { const r = 6371; const dLat = toRad(lat2-lat1); const dLon = toRad(lon2-lon1); const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2; return 2*r*Math.asin(Math.sqrt(a)); }
function toRad(value) { return value * Math.PI / 180; }
function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
function escapeAttr(value='') { return escapeHtml(value); }
