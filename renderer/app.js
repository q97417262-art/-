/**
 * Логика интерфейса Playerok Bot.
 * Если приложение открыто не в Electron (window.api нет) —
 * включается демо-режим с тестовыми данными (удобно для предпросмотра).
 *
 * ВАЖНО: переменная называется bridge, а не api —
 * имя «api» в Electron уже занято мостом window.api и вызывает
 * SyntaxError: Identifier 'api' has already been declared.
 */

// ── Темы ──────────────────────────────────────────────────────
const THEMES = [
  { id: 'dark', name: 'Ночь', dots: ['#191919', '#2a2a2a', '#5e9fe8', '#7b6ff0'] },
  { id: 'light', name: 'День', dots: ['#f7f6f4', '#ffffff', '#2783de', '#6a5ae0'] },
  { id: 'ocean', name: 'Океан', dots: ['#0e1a2c', '#1d3049', '#4fb9c9', '#5e9fe8'] },
  { id: 'purple', name: 'Фиалка', dots: ['#1c1526', '#2f2440', '#bf8eda', '#8b7ff0'] },
  { id: 'sunset', name: 'Закат', dots: ['#221915', '#3a2b23', '#de9255', '#e97366'] },
  { id: 'forest', name: 'Лес', dots: ['#14201a', '#24382c', '#72bc8f', '#4fb9c9'] },
  { id: 'sakura', name: 'Сакура', dots: ['#211420', '#372233', '#df84a8', '#bf8eda'] },
  { id: 'neon', name: 'Неон', dots: ['#0a0a12', '#1b1b29', '#22d3ee', '#e879f9'] },
  { id: 'graphite', name: 'Графит', dots: ['#1c1c1f', '#303037', '#9aa0ff', '#22d3ee'] },
  { id: 'mint', name: 'Мята', dots: ['#f1f7f4', '#ffffff', '#34a47c', '#4fb9c9'] },
  { id: 'sand', name: 'Песок', dots: ['#f7f2ea', '#ffffff', '#c2904f', '#d5803b'] },
  { id: 'nord', name: 'Север', dots: ['#edf1f7', '#ffffff', '#5b7fbf', '#4fb9c9'] },
];

const STATUS_LABELS = {
  PAID: ['Оплачен', 'status-paid'],
  PENDING: ['Оплачен', 'status-paid'],
  SENT: ['Передан', 'status-sent'],
  CONFIRMED: ['Завершён', 'status-done'],
  ROLLED_BACK: ['Возврат', 'status-other'],
};

const $ = (sel) => document.querySelector(sel);
const bridge = window.api || null;

let monitoring = false;
let orders = [];
let freshIds = new Set();
let newCount = 0;

// ── Демо-режим (без Electron, для предпросмотра) ──────────────
const DEMO = {
  user: { id: 'demo-1', username: 'DemoSeller' },
  orders: [
    { id: 'DEAL-1003', status: 'PAID', createdAt: Date.now() - 40 * 60e3, buyer: { username: 'memeVVV' }, item: { name: 'FAIRYTALE EGG x99', price: 90 } },
    { id: 'DEAL-1002', status: 'CONFIRMED', createdAt: Date.now() - 5 * 3600e3, buyer: { username: 'addict31' }, item: { name: 'Аккаунт Steam (CS2, Prime)', price: 499 } },
    { id: 'DEAL-1001', status: 'CONFIRMED', createdAt: Date.now() - 26 * 3600e3, buyer: { username: 'Mxstty' }, item: { name: '1000 Robux (через Gamepass)', price: 350 } },
  ],
};

// ── Инициализация ─────────────────────────────────────────────
async function init() {
  buildThemeGrid();
  bindNav();
  bindWindowButtons();
  bindSettings();
  bindMonitorButton();
  bindDelivery();

  // Deep-link: index.html#view=settings&theme=ocean (приоритет выше сохранённой темы)
  const params = new URLSearchParams(location.hash.slice(1));
  const hashTheme = THEMES.some((t) => t.id === params.get('theme')) ? params.get('theme') : null;

  if (bridge) {
    const state = await bridge.getState();
    applyTheme(hashTheme || state.theme || 'dark', false);
    selectInterval(state.interval || 30);
    updateAuthUI(state.cookieSet, state.username);
    if (state.orders?.length) { orders = state.orders; renderOrders(); }
    if (state.monitoring) setMonitoringUI(true);
    $('#opt-auto').checked = !!state.autoDeliver;
    $('#opt-nick').checked = state.checkNick !== false;
    subscribeEvents();
    await loadPets();
    renderDelivery(await bridge.deliveryState());
  } else {
    // демо-предпросмотр (открыто не через Electron)
    $('#demo-banner').classList.remove('hidden');
    applyTheme(hashTheme || 'dark', false);
    updateAuthUI(true, DEMO.user.username);
    orders = params.get('empty') ? [] : DEMO.orders;
    renderOrders();
    $('#orders-subtitle').textContent = 'Демо-режим • предпросмотр интерфейса';
  }

  if (params.get('view')) {
    document.querySelector(`[data-view="${params.get('view')}"]`)?.click();
  }
}

// ── Темы ──────────────────────────────────────────────────────
function buildThemeGrid() {
  const grid = $('#theme-grid');
  for (const theme of THEMES) {
    const btn = document.createElement('button');
    btn.className = 'theme-swatch';
    btn.dataset.theme = theme.id;
    btn.innerHTML = `
      <div class="swatch-colors">
        ${theme.dots.map((c) => `<div class="swatch-dot" style="background:${c}"></div>`).join('')}
      </div>
      <div class="swatch-name">${theme.name}</div>`;
    btn.addEventListener('click', () => {
      applyTheme(theme.id, true);
      toast(`Тема «${theme.name}» применена`, 'success');
    });
    grid.appendChild(btn);
  }
}

function applyTheme(id, persist) {
  document.documentElement.dataset.theme = id;
  document.querySelectorAll('.theme-swatch').forEach((el) => {
    el.classList.toggle('active', el.dataset.theme === id);
  });
  if (persist && bridge) bridge.setTheme(id);
}

// ── Навигация ─────────────────────────────────────────────────
function bindNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      $(`#view-${btn.dataset.view}`).classList.add('active');
      if (btn.dataset.view === 'orders') {
        newCount = 0;
        updateBadge();
        freshIds.clear();
        renderOrders();
      }
    });
  });
}

function updateBadge() {
  const badge = $('#nav-badge');
  badge.classList.toggle('hidden', newCount === 0);
  badge.textContent = newCount;
}

// ── Кнопки окна ───────────────────────────────────────────────
function bindWindowButtons() {
  $('#btn-min').addEventListener('click', () => bridge?.minimize());
  $('#btn-max').addEventListener('click', () => bridge?.maximize());
  $('#btn-close').addEventListener('click', () => bridge?.closeWindow());
}

// ── Мониторинг ────────────────────────────────────────────────
function bindMonitorButton() {
  let starting = false;
  $('#btn-toggle-monitor').addEventListener('click', async () => {
    if (!bridge) {
      toast('Демо-режим: мониторинг недоступен', 'error');
      return;
    }
    const btn = $('#btn-toggle-monitor');
    if (starting) { // повторное нажатие во время запуска — отмена
      await bridge.cancelAuth();
      return;
    }
    try {
      if (monitoring) {
        btn.disabled = true;
        await bridge.stopMonitor();
        setMonitoringUI(false);
        btn.disabled = false;
      } else {
        starting = true;
        btn.textContent = '✕ Отмена';
        toast('Подключаюсь к Playerok…', 'info');
        const res = await bridge.startMonitor();
        starting = false;
        if (res.ok) {
          setMonitoringUI(true);
        } else {
          btn.textContent = '▶ Запустить';
          if (res.cancelled) {
            toast('Запуск отменён', 'info');
          } else {
            toast(res.error || 'Не удалось запустить мониторинг', 'error');
            switchToSettings();
          }
        }
      }
    } catch (err) {
      starting = false;
      btn.disabled = false;
      btn.textContent = monitoring ? '⏸ Остановить' : '▶ Запустить';
      toast('Ошибка: ' + err.message, 'error');
    }
  });
}

function setMonitoringUI(on) {
  monitoring = on;
  const btn = $('#btn-toggle-monitor');
  swapButtonLabel(btn, on ? '⏸ Остановить' : '▶ Запустить');
  btn.classList.toggle('running', on);
  $('#status-dot').className = `dot ${on ? 'dot-on' : 'dot-off'}`;
  $('#status-text').textContent = on ? 'Онлайн' : 'Оффлайн';
  $('#orders-subtitle').textContent = on
    ? 'Мониторинг активен — новые заказы появятся автоматически'
    : 'Мониторинг не запущен';
}

// Плавная смена текста кнопки: затухание → замена → появление
function swapButtonLabel(btn, text) {
  btn.style.opacity = '0';
  btn.style.transform = 'scale(0.96)';
  setTimeout(() => {
    btn.textContent = text;
    btn.style.opacity = '1';
    btn.style.transform = '';
  }, 220);
}

function switchToSettings() {
  document.querySelector('[data-view="settings"]').click();
}

// ── События от главного процесса ──────────────────────────────
function subscribeEvents() {
  bridge.on('monitor:profile', (user) => {
    updateAuthUI(true, user.username);
    toast(`Подключён аккаунт ${user.username}`, 'success');
  });

  bridge.on('monitor:orders', (list) => {
    orders = list;
    renderOrders();
  });

  bridge.on('monitor:newOrder', (order) => {
    freshIds.add(order.id);
    newCount++;
    updateBadge();
    toast(`🛒 Новый заказ: ${order.item?.name || 'товар'} — ${formatPrice(order.item?.price)} — ${order.buyer?.username || ''}`, 'order');
  });

  bridge.on('monitor:error', (msg) => toast(msg, 'error'));
  bridge.on('monitor:status', ({ running }) => setMonitoringUI(running));
  bridge.on('app:info', (msg) => toast(msg, 'info'));
  bridge.on('delivery:update', (snap) => renderDelivery(snap));
  bridge.on('delivery:log', (line) => {
    const log = $('#delivery-log');
    log.textContent += line + '\n';
    log.scrollTop = log.scrollHeight;
  });
}

// ── Рендер заказов ────────────────────────────────────────────
function renderOrders() {
  const list = $('#orders-list');
  const empty = $('#empty-state');
  list.innerHTML = '';
  empty.classList.toggle('hidden', orders.length > 0);

  for (const order of orders) {
    const [label, cls] = STATUS_LABELS[order.status] || ['Другое', 'status-other'];
    const card = document.createElement('div');
    card.className = `order-card ${freshIds.has(order.id) ? 'fresh' : ''}`;
    card.innerHTML = `
      <div class="order-avatar">${escapeHtml((order.buyer?.username || '?')[0].toUpperCase())}</div>
      <div class="order-info">
        <div class="order-name">${escapeHtml(order.item?.name || 'Товар')}</div>
        <div class="order-meta">${escapeHtml(order.buyer?.username || '—')} • ${formatTime(order.createdAt)}</div>
      </div>
      <div class="order-right">
        <div class="order-price">${formatPrice(order.item?.price)}</div>
        <span class="order-status ${cls}">${label}</span>${deliveryBadge(order)}
        ${deliveryButtons(order)}
      </div>`;
    card.querySelector('[data-deliver]')?.addEventListener('click', async () => {
      const r = await bridge.deliver(order.id);
      toast(r.ok ? `В очередь выдачи: ${order.buyer?.username}` : r.error, r.ok ? 'success' : 'error');
    });
    card.querySelector('[data-mark]')?.addEventListener('click', async () => {
      await bridge.markDelivered(order.id);
      toast('Отмечено как выданное', 'success');
    });
    list.appendChild(card);
  }
}

// Сумма заказа: 1500 → «1 500 ₽», пусто/не число → «—»
function formatPrice(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toLocaleString('ru-RU')} ₽`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 60e3) return 'только что';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} мин назад`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} ч назад`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Настройки ─────────────────────────────────────────────────
function bindSettings() {
  let loginPending = false;
  $('#btn-login-window').addEventListener('click', async () => {
    if (!bridge) return toast('Демо-режим', 'error');
    const btn = $('#btn-login-window');
    if (loginPending) { // повторное нажатие во время ожидания — отмена
      await bridge.cancelAuth();
      return;
    }
    loginPending = true;
    btn.innerHTML = '<span class="btn-icon">⏳</span> Ожидание входа… <span class="btn-hint">нажми ещё раз, чтобы отменить</span>';
    try {
      const res = await bridge.loginViaWindow();
      if (res.ok) {
        updateAuthUI(true, res.username);
        toast('Вход выполнен ✅', 'success');
      } else if (res.cancelled) {
        toast('Вход отменён', 'info');
      } else {
        toast(res.error || 'Не удалось войти', 'error');
      }
    } catch (err) {
      toast('Ошибка: ' + err.message, 'error');
    }
    loginPending = false;
    btn.innerHTML = '<span class="btn-icon">🔑</span> Войти через окно <span class="btn-hint">откроется сайт — войди как обычно</span>';
  });

  $('#interval-segmented').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-interval]');
    if (!btn) return;
    selectInterval(Number(btn.dataset.interval));
    bridge?.setInterval(Number(btn.dataset.interval));
    toast(`Интервал: ${btn.dataset.interval} сек`, 'success');
  });

  $('#btn-logout').addEventListener('click', async () => {
    if (!bridge) return;
    await bridge.logout();
    updateAuthUI(false);
    setMonitoringUI(false);
    orders = [];
    renderOrders();
    toast('Вы вышли из аккаунта', 'success');
  });
}

function selectInterval(sec) {
  document.querySelectorAll('#interval-segmented button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.interval) === sec);
  });
}

function updateAuthUI(cookieSet, username) {
  $('#auth-dot').className = `dot ${cookieSet ? 'dot-on' : 'dot-off'}`;
  $('#auth-text').textContent = cookieSet ? 'Вход выполнен — можно запускать мониторинг' : 'Вход не выполнен';
  $('#profile-chip').classList.toggle('hidden', !username);
  if (username) {
    $('#profile-name').textContent = username;
    $('#profile-avatar').textContent = username[0].toUpperCase();
  }
}

// ── Тосты ─────────────────────────────────────────────────────
const TOAST_DURATION = 5200; // мс — жизнь уведомления

function toast(text, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;

  const label = document.createElement('span');
  label.textContent = text;
  el.appendChild(label);

  // Прогресс-бар: показывает, сколько уведомление пробудет на экране
  const progress = document.createElement('div');
  progress.className = 'toast-progress';
  const bar = document.createElement('i');
  bar.style.animationDuration = `${TOAST_DURATION}ms`;
  progress.appendChild(bar);
  el.appendChild(progress);

  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  }, TOAST_DURATION);
}

init();

// ── Автовыдача ────────────────────────────────────────────────
const D_LABELS = { queued: 'в очереди', running: 'выдаю…', done: 'выдано', error: 'ошибка' };
let pets = [];
let editingPet = null;
let petImage = null;

function deliveryBadge(order) {
  const st = order.delivery?.state;
  if (!D_LABELS[st]) return '';
  return `<span class="d-badge d-${st}" title="${escapeHtml(order.delivery.msg || '')}">🎁 ${D_LABELS[st]}</span>`;
}

function deliveryButtons(order) {
  if (!bridge) return '';
  const st = order.delivery?.state;
  const paid = order.status === 'PAID' || order.status === 'PENDING';
  if (!paid || st === 'done' || st === 'running' || st === 'queued') return '';
  const canAuto = st === 'ready' || st === 'error';
  return `<div class="deliver-row">
    ${canAuto ? '<button class="btn btn-primary" data-deliver>🎁 Выдать</button>' : ''}
    <button class="btn btn-ghost" data-mark title="Уже выдал руками">✓</button>
  </div>`;
}

function bindDelivery() {
  if (!bridge) return;
  $('#opt-auto').addEventListener('change', async (e) => {
    await bridge.deliverySettings({ autoDeliver: e.target.checked });
    toast(e.target.checked ? 'Автовыдача включена' : 'Автовыдача выключена', 'success');
    if (e.target.checked) bridge.checkHelper();
  });
  $('#opt-nick').addEventListener('change', async (e) => {
    if (!e.target.checked && !confirm('Без проверки ника бот примет трейд от кого угодно. Точно выключить?')) {
      e.target.checked = true;
      return;
    }
    await bridge.deliverySettings({ checkNick: e.target.checked });
  });
  $('#btn-check-helper').addEventListener('click', () => { bridge.checkHelper(); toast('Проверяю помощника…', 'info'); });
  $('#btn-stop-delivery').addEventListener('click', async () => { await bridge.stopDelivery(); toast('Выдача остановлена', 'info'); });

  const setImg = (url) => {
    petImage = url;
    const el = $('#pet-img');
    el.classList.toggle('has', !!url);
    el.style.backgroundImage = url ? `url("${url}")` : '';
  };
  $('#btn-pet-paste').addEventListener('click', async () => {
    const url = await bridge.pastePetImage();
    if (!url) return toast('В буфере нет картинки. Нажми Win+Shift+S и выдели питомца', 'error');
    setImg(url);
  });
  $('#btn-pet-file').addEventListener('click', async () => { const url = await bridge.pickPetImage(); if (url) setImg(url); });
  $('#pet-img').addEventListener('click', () => $('#btn-pet-paste').click());
  // Ctrl+V прямо на вкладке — тоже вставляет картинку
  document.addEventListener('paste', (e) => {
    if (!$('#view-pets').classList.contains('active')) return;
    const file = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    const r = new FileReader();
    r.onload = () => setImg(r.result);
    r.readAsDataURL(file);
  });

  const resetForm = () => {
    editingPet = null;
    ['#pet-name', '#pet-search', '#pet-match'].forEach((id) => { $(id).value = ''; });
    $('#pet-count').value = 1;
    setImg(null);
    $('#btn-pet-cancel').classList.add('hidden');
    $('#btn-pet-save').textContent = 'Сохранить';
  };
  $('#btn-pet-cancel').addEventListener('click', resetForm);
  $('#btn-pet-save').addEventListener('click', async () => {
    const name = $('#pet-name').value.trim();
    const r = await bridge.savePet({
      id: editingPet?.id,
      name,
      search: $('#pet-search').value.trim() || name,
      match: $('#pet-match').value.trim() || name,
      count: Number($('#pet-count').value) || 1,
      enabled: editingPet ? editingPet.enabled : true,
      imageDataUrl: petImage && petImage !== editingPet?.img ? petImage : null,
    });
    if (!r.ok) return toast(r.error, 'error');
    toast(`Питомец «${name}» сохранён`, 'success');
    resetForm();
    loadPets();
  });

  $('#pets-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const pet = pets.find((p) => p.id === btn.dataset.id);
    if (!pet) return;
    if (btn.dataset.act === 'del') {
      if (!confirm(`Удалить «${pet.name}»?`)) return;
      await bridge.removePet(pet.id);
      loadPets();
    } else if (btn.dataset.act === 'toggle') {
      await bridge.savePet({ ...pet, enabled: !pet.enabled, imageDataUrl: null });
      loadPets();
    } else if (btn.dataset.act === 'edit') {
      editingPet = pet;
      $('#pet-name').value = pet.name;
      $('#pet-search').value = pet.search;
      $('#pet-match').value = pet.match;
      $('#pet-count').value = pet.count;
      setImg(pet.img);
      $('#btn-pet-cancel').classList.remove('hidden');
      $('#btn-pet-save').textContent = 'Обновить';
      $('#pet-name').focus();
    }
  });

  $('#btn-test').addEventListener('click', async () => {
    const r = await bridge.testDelivery($('#test-nick').value, $('#test-pet').value);
    toast(r.ok ? 'Тест запущен. Переключись в Roblox и попроси друга кинуть трейд' : r.error, r.ok ? 'success' : 'error');
  });
}

async function loadPets() {
  pets = await bridge.listPets();
  const grid = $('#pets-grid');
  grid.innerHTML = pets.length ? '' : '<div class="card-note" style="margin:0">Пока ни одного. Добавь питомца ниже 👇</div>';
  for (const p of pets) {
    const el = document.createElement('div');
    el.className = `pet-card ${p.enabled ? '' : 'off'}`;
    el.innerHTML = `
      ${p.img ? `<img src="${p.img}" alt="">` : '<div></div>'}
      <div class="pet-meta">
        <div class="pet-title">${escapeHtml(p.name)} ×${p.count}</div>
        <div>поиск: ${escapeHtml(p.search || '—')}</div>
        <div title="${escapeHtml(p.match)}">товар: ${escapeHtml(p.match)}</div>
      </div>
      <div class="pet-actions">
        <button class="icon-btn" data-act="toggle" data-id="${p.id}" title="${p.enabled ? 'Выключить' : 'Включить'}">${p.enabled ? '⏸' : '▶'}</button>
        <button class="icon-btn" data-act="edit" data-id="${p.id}" title="Изменить">✏️</button>
        <button class="icon-btn" data-act="del" data-id="${p.id}" title="Удалить">🗑</button>
      </div>`;
    grid.appendChild(el);
  }
  $('#test-pet').innerHTML = pets.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('') || '<option value="">нет питомцев</option>';
}

function renderDelivery(snap) {
  if (!snap) return;
  const h = snap.helper || {};
  $('#helper-status').textContent = h.error
    ? '⚠️ ' + h.error
    : h.ready
      ? `Помощник готов • распознавание ника: ${h.ocr === 'windows' ? 'Windows' : h.ocr || 'нет!'}${snap.busy ? ' • идёт выдача' : ''}`
      : 'Помощник не запущен (запустится сам при первой выдаче)';
  $('#queue').innerHTML = (snap.queue || []).slice().reverse().map((j) => `
    <div class="queue-item">
      <span><span class="d-badge d-${j.state}">${D_LABELS[j.state] || j.state}</span> <b>${escapeHtml(j.buyer)}</b> • ${escapeHtml(j.title || '')}</span>
      <span class="q-msg">${escapeHtml(j.msg || '')}</span>
    </div>`).join('') || '<div class="card-note" style="margin:0">Очередь пуста</div>';
  const log = $('#delivery-log');
  if (!log.textContent && snap.logs?.length) log.textContent = snap.logs.join('\n') + '\n';
}
