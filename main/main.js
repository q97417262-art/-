/**
 * Главный процесс Electron.
 * Окно приложения, настройки, мониторинг. Данные Playerok приложение
 * получает из отдельного окна сайта (см. siteBrowser.js) — без ручных
 * cookie и собственных запросов к API.
 */
const { app, BrowserWindow, ipcMain, Notification, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const Monitor = require('./monitor');
const { SiteBrowser } = require('./siteBrowser');
const Delivery = require('./delivery');

const DEFAULTS = {
  interval: 30,
  theme: 'dark',
  lastUsername: null,
  autoDeliver: false,   // автовыдача новых оплаченных заказов
  checkNick: true,      // сверять ник в трейде с покупателем
  petThreshold: 0.8,    // насколько точно картинка питомца должна совпасть
  requestTimeoutMin: 10,
  pythonPath: '',
};

// Сумма заказа для уведомлений: 1500 → «1 500 ₽», нет данных → «—»
function formatPrice(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toLocaleString('ru-RU')} ₽`;
}

let settings = { ...DEFAULTS };
let win = null;
let site = null;
let monitor = null;
let currentUser = null;
let lastOrders = [];
let delivery = null;

// Заказы для интерфейса + статус выдачи у каждого.
const withDelivery = (orders) => orders.map((o) => ({ ...o, delivery: delivery ? delivery.status(o) : { state: 'none' } }));
const pushOrders = () => win?.webContents.send('monitor:orders', withDelivery(lastOrders));

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    /* первый запуск — значения по умолчанию */
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить настройки:', e.message);
  }
}

// ── Окно приложения ────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 920,
    minHeight: 620,
    frame: false,
    backgroundColor: '#191919',
    title: 'Playerok Bot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
    monitor?.stop();
    site?.dispose();
    app.quit();
  });
}

app.whenReady().then(() => {
  loadSettings();
  site = new SiteBrowser({ userDataDir: app.getPath('userData'), getParent: () => win });
  site.on('status', (text) => win?.webContents.send('app:info', text));
  delivery = new Delivery({ userDataDir: app.getPath('userData'), getSettings: () => settings });
  delivery.on('update', (snap) => { win?.webContents.send('delivery:update', snap); pushOrders(); });
  delivery.on('log', (line) => win?.webContents.send('delivery:log', line));
  delivery.on('delivered', (job) => new Notification({ title: '🎁 Выдано', body: `${job.buyer}: ${job.title || ''}` }).show());
  delivery.on('failed', (job) => new Notification({ title: '⚠️ Выдача остановлена — нужен ты', body: `${job.buyer}: ${job.msg}` }).show());
  console.log('[site] журнал:', site.logFile);
  // Когда окну Playerok нужен человек (войти / открыть чат с заказом) —
  // объясняем это и в основном окне.
  site.on('prompt', (title) => {
    if (title !== 'Playerok') win?.webContents.send('app:info', title.replace(/^Playerok Bot — /, 'Окно Playerok: '));
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { site?.dispose(); delivery?.dispose(); });

// ── Управление окном (кастомный тайтлбар) ─────────────────────
ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
ipcMain.on('window:close', () => win?.close());

// ── Состояние для интерфейса ──────────────────────────────────
ipcMain.handle('state:get', async () => ({
  cookieSet: await site.hasSession(), // «есть сохранённый вход в окне Playerok»
  interval: settings.interval,
  theme: settings.theme,
  username: currentUser?.username || settings.lastUsername || null,
  monitoring: Boolean(monitor),
  orders: withDelivery(lastOrders),
  autoDeliver: settings.autoDeliver,
  checkNick: settings.checkNick,
  petThreshold: settings.petThreshold,
}));

ipcMain.handle('settings:setTheme', (_e, theme) => {
  settings.theme = theme;
  saveSettings();
  return true;
});

ipcMain.handle('settings:setInterval', (_e, sec) => {
  settings.interval = Math.max(10, Number(sec) || 30);
  saveSettings();
  return settings.interval;
});

// ── Вход ──────────────────────────────────────────────────────
function rememberUser(user) {
  currentUser = user;
  if (user?.username) {
    settings.lastUsername = user.username;
    saveSettings();
  }
  win?.webContents.send('monitor:profile', user);
}

ipcMain.handle('auth:loginWindow', async () => {
  try {
    const user = await site.login({ showNow: true });
    rememberUser(user);
    return { ok: true, username: user.username };
  } catch (err) {
    site.hideWindow();
    // Человек просто закрыл окно — это не ошибка
    if (/закрыто до завершения|Отменено/.test(err.message)) return { ok: false, cancelled: true };
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:logout', async () => {
  if (monitor) stopMonitor();
  await site.logout();
  currentUser = null;
  lastOrders = [];
  settings.lastUsername = null;
  saveSettings();
  return true;
});

// ── Мониторинг ────────────────────────────────────────────────
function stopMonitor() {
  monitor?.stop();
  monitor = null;
  win?.webContents.send('monitor:status', { running: false });
}

ipcMain.handle('monitor:start', async () => {
  if (monitor) return { ok: true };

  try {
    rememberUser(await site.login());  // войти, если ещё не вошли
    await site.prepareDeals();         // один раз открыть чат с заказом
  } catch (err) {
    site.hideWindow();
    if (/закрыто до завершения|Отменено/.test(err.message)) return { ok: false, cancelled: true };
    return { ok: false, error: err.message };
  }

  monitor = new Monitor({
    site,
    interval: settings.interval,
    onOrders: (orders) => {
      lastOrders = orders;
      pushOrders();
    },
    onNewOrder: (order) => {
      win?.webContents.send('monitor:newOrder', order);
      delivery.onNewOrder(order);
      new Notification({
        title: '🛒 Новый оплаченный заказ!',
        body: `${order.item?.name || 'Товар'} — ${formatPrice(order.item?.price)}\nПокупатель: ${order.buyer?.username || '—'}`,
      }).show();
    },
    onError: (message) => win?.webContents.send('monitor:error', message),
    onStopped: () => stopMonitor(),
  });

  const started = monitor;
  await started.start();
  if (monitor !== started) {
    // первая загрузка не удалась — монитор уже остановлен
    return { ok: false, error: 'Не удалось получить заказы. Открой «Войти через окно», открой «Чаты» → чат с заказом и повтори.' };
  }
  win?.webContents.send('monitor:status', { running: true });
  return { ok: true };
});

// Отмена долгого ожидания (вход / открытие чата)
ipcMain.handle('auth:cancel', () => {
  site?.cancel();
  return true;
});

ipcMain.handle('monitor:stop', () => {
  stopMonitor();
  return true;
});

// ── Автовыдача Adopt Me ───────────────────────────────────────
const safe = (fn) => async (...a) => {
  try { return { ok: true, data: await fn(...a) }; } catch (err) { return { ok: false, error: err.message }; }
};

ipcMain.handle('pets:list', () => delivery.listPets());
ipcMain.handle('pets:save', safe((_e, data) => delivery.savePet(data)));
ipcMain.handle('pets:remove', (_e, id) => { delivery.removePet(id); return true; });
// Картинка из буфера обмена: Win+Shift+S → выделить питомца → «Вставить».
ipcMain.handle('pets:paste', () => {
  const img = clipboard.readImage();
  return img.isEmpty() ? null : img.toDataURL();
});
ipcMain.handle('pets:pickFile', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Картинки', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const f = r.filePaths[0];
  const ext = path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return `data:image/${ext};base64,${fs.readFileSync(f).toString('base64')}`;
});

ipcMain.handle('delivery:state', () => delivery.snapshot());
ipcMain.handle('delivery:settings', (_e, patch) => {
  for (const k of ['autoDeliver', 'checkNick', 'petThreshold', 'requestTimeoutMin', 'pythonPath']) {
    if (patch && k in patch) settings[k] = patch[k];
  }
  saveSettings();
  pushOrders();
  return settings;
});
ipcMain.handle('delivery:deliver', safe((_e, orderId) => {
  const order = lastOrders.find((o) => o.id === orderId);
  if (!order) throw new Error('Заказ не найден');
  return delivery.enqueue(order);
}));
ipcMain.handle('delivery:markDone', (_e, id) => { delivery.markDone(id); return true; });
ipcMain.handle('delivery:test', safe((_e, buyer, petId) => delivery.test(buyer, petId)));
ipcMain.handle('delivery:stop', () => { delivery.stop(); return true; });
ipcMain.handle('delivery:check', () => {
  if (!delivery.proc) delivery.startHelper(); else delivery.send({ cmd: 'check' });
  return true;
});
