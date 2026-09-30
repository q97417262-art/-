/**
 * Окно Playerok — отдельный настоящий браузер внутри приложения.
 *
 * ═══════════════════════════════════════════════════════════════════
 * КАК ЭТО РАБОТАЕТ (и почему больше нет «Something went wrong»)
 *
 * Раньше приложение само слало запросы к https://playerok.com/graphql —
 * с cookie, заголовками и хэшами, собранными вручную. Сервер отвечал
 * «Something went wrong» (HTTP 500), потому что запрос отличался от
 * того, что шлёт сам сайт.
 *
 * Теперь приложение вообще ничего не подделывает:
 *   1. Открывает playerok.com в обычном окне Chromium (сессия
 *      'persist:playerok' — как профиль браузера, вход сохраняется).
 *      Пользователь входит как обычно — никаких cookie руками.
 *   2. Сайт сам делает свои GraphQL-запросы. Через DevTools-протокол
 *      (webContents.debugger, домен Network) приложение ЧИТАЕТ ответы
 *      этих запросов: `viewer` → профиль, `deals` → заказы.
 *   3. Для обновления заказов приложение повторяет в странице тот же
 *      запрос, что сайт уже делал (fetch изнутри страницы — те же
 *      cookie, заголовки и отпечаток браузера), а если не выходит —
 *      просто перезагружает страницу сделок.
 *
 * Окно скрыто и показывается только когда нужно действие человека:
 * войти в аккаунт или один раз открыть «Чаты» и зайти в чат с заказом.
 * ═══════════════════════════════════════════════════════════════════
 */
const { BrowserWindow, session, ipcMain } = require('electron');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:playerok';
const HOME = 'https://playerok.com/';
const TITLE = 'Playerok';
const LOGIN_TITLE = 'Playerok Bot — войди в аккаунт (если уже вошёл — окно закроется само)';
const GQL_URL = /^https:\/\/([a-z0-9-]+\.)?playerok\.com\/graphql/i;
// Заголовки, которые fetch() из страницы ставит сам или запрещает менять.
const SKIP_HEADERS = /^(:.*|host|cookie|user-agent|content-length|connection|accept-encoding|accept-language|origin|referer|priority|sec-.*|upgrade-insecure-requests|cache-control|pragma|dnt)$/i;

const safeJson = (text, fallback) => {
  try { return JSON.parse(text); } catch { return fallback; }
};

// ── Чистые функции (вынесены для тестов) ──────────────────────
// Разбирает GraphQL-запрос сайта → [{ operationName, variables }].
function parseOps(url, method, postData) {
  if (method === 'GET') {
    const u = new URL(url);
    return [{
      operationName: u.searchParams.get('operationName'),
      variables: safeJson(u.searchParams.get('variables') || '{}', {}),
    }];
  }
  const parsed = safeJson(postData, null);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter((o) => o && typeof o === 'object')
    .map((o) => ({ operationName: o.operationName, variables: o.variables || {} }));
}

// Просим у сервера страницу побольше (максимум, который он принимает, — 24).
function patchVariables(vars) {
  const v = structuredClone(vars || {});
  if (v.pagination && typeof v.pagination === 'object') {
    v.pagination.first = 24;
    delete v.pagination.after;
  } else if ('first' in v) {
    v.first = 24;
    delete v.after;
  }
  return v;
}

// Копия шаблона запроса сайта с увеличенным размером страницы.
function patchTemplate(tpl) {
  if (tpl.method === 'GET') {
    const u = new URL(tpl.url);
    const vars = safeJson(u.searchParams.get('variables') || '{}', {});
    u.searchParams.set('variables', JSON.stringify(patchVariables(vars)));
    return { ...tpl, url: u.toString() };
  }
  const parsed = safeJson(tpl.postData, null);
  if (!parsed) return tpl;
  const patch = (o) => (o && typeof o === 'object' ? { ...o, variables: patchVariables(o.variables) } : o);
  return { ...tpl, postData: JSON.stringify(Array.isArray(parsed) ? parsed.map(patch) : patch(parsed)) };
}

// Название и сумма заказа. В списке чатов Playerok их НЕ присылает (там у
// товара только id), они приходят из страницы самого чата — поэтому
// проверяем все места, где они могут лежать.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return num(v.value ?? v.amount ?? v.price);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function dealName(node) {
  const it = node.item || node.product || {};
  return it.name || it.title || node.name || node.title || node.itemName || null;
}
function dealPrice(node) {
  const it = node.item || node.product || {};
  for (const v of [node.transaction?.value, node.totalPrice, node.amount, node.price, it.price, it.rawPrice]) {
    const n = num(v);
    if (n !== null) return n;
  }
  return null;
}
const hasDetails = (d) => !!dealName(d) && dealPrice(d) !== null;

// Ответ сайта → заказы для интерфейса. Набор полей зависит от того, что
// запрашивает сам сайт, поэтому берём первое подходящее.
function mapDeals(nodes) {
  return nodes.filter(Boolean).map((node) => {
    const item = node.item || node.product || null;
    return {
      id: node.id,
      status: node.status,
      createdAt: node.createdAt || node.created_at || null,
      updatedAt: node.updatedAt || null,
      buyer: node.user || node.buyer || node.counterparty || node.customer || null,
      item: { ...(item || {}), name: dealName(node), price: dealPrice(node) },
      chatId: node.chat?.id || null,
    };
  });
}

// ── Поиск заказов в ЛЮБОМ ответе сайта ────────────────────────
// Заказ в Playerok живёт внутри чата (страница /chats/<id>): он может
// прийти в списке чатов, в самом чате, в сообщениях. Поэтому ищем не по
// имени операции, а по виду объекта: тип Deal/ItemDeal, либо id + известный
// статус сделки + вложенный товар.
const DEAL_STATUSES = new Set(['PAID', 'PENDING', 'SENT', 'CONFIRMED', 'ROLLED_BACK', 'PROCESSING', 'COMPLETED', 'CANCELLED']);

function looksLikeDeal(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.id !== 'string') return false;
  if (typeof o.__typename === 'string') return /^(Item)?Deal$/i.test(o.__typename);
  return typeof o.status === 'string' && DEAL_STATUSES.has(o.status) && o.item && typeof o.item === 'object';
}

function extractDeals(data) {
  const out = new Map();
  const isChat = (o) => typeof o.id === 'string' && (/Chat$/.test(o.__typename || '') || ('participants' in o && 'lastMessage' in o));
  (function walk(v, depth, chatId) {
    if (depth > 12 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1, chatId)); return; }
    if (isChat(v)) chatId = v.id;
    if (looksLikeDeal(v)) out.set(v.id, v.chat?.id || !chatId ? v : { ...v, chat: { id: chatId } });
    for (const k of Object.keys(v)) walk(v[k], depth + 1, chatId);
  })(data, 0, null);
  return [...out.values()];
}

// Новые данные дополняют старые, но пустые значения не затирают известные
// (в одном ответе у заказа может быть только id+status, в другом — всё).
function mergeDeal(oldDeal, newDeal) {
  const merged = { ...(oldDeal || {}) };
  const plain = (x) => x && typeof x === 'object' && !Array.isArray(x);
  for (const [k, v] of Object.entries(newDeal)) {
    if (v === null || v === undefined) continue;
    // Вложенные объекты (товар, покупатель) сливаем, а не заменяем: иначе
    // короткий «товар» из списка чатов затирал бы название и цену из чата.
    merged[k] = plain(v) && plain(merged[k]) ? mergeDeal(merged[k], v) : v;
  }
  return merged;
}

// Только СТРУКТУРА ответа (пути ключей, без значений) — для диагностики.
function collectPaths(v, prefix, set, depth = 0) {
  if (depth > 9 || set.size > 500 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) { v.slice(0, 3).forEach((x) => collectPaths(x, `${prefix}[]`, set, depth + 1)); return; }
  for (const [k, val] of Object.entries(v)) {
    const path = prefix ? `${prefix}.${k}` : k;
    set.add(path);
    collectPaths(val, path, set, depth + 1);
  }
}

function cleanUserAgent(ua) {
  // Без «Electron/…» и имени приложения — как обычный Chrome.
  return ua.replace(/\s(Electron|playerok-desktop)\/\S+/gi, '');
}

class SiteBrowser extends EventEmitter {
  constructor({ userDataDir, getParent }) {
    super();
    this.dir = userDataDir;
    this.getParent = getParent || (() => null); // главное окно: окно Playerok всегда поверх него
    this.logFile = path.join(userDataDir, 'site.log');
    this.lastLoadError = null;
    this.loginPromise = null;
    this.noViewerGraceMs = 12000;
    this.recent = new Map(); // ключ ответа -> время (дедупликация двух каналов чтения)
    this.cdpReady = false;
    // Второй канал чтения ответов: скрипт внутри страницы (sitePreload.js)
    // присылает то, что получил fetch. Работает независимо от отладчика.
    ipcMain.on('site:gql', (event, p) => {
      if (!this.win || this.win.isDestroyed() || event.sender !== this.win.webContents) return;
      try { this.onInjected(p); } catch (err) { this.log('site:gql:', err.message); }
    });
    this.dealsPromise = null;
    this.stateFile = path.join(userDataDir, 'site-state.json');
    this.state = safeJson(this.readFile(this.stateFile), {}) || {}; // { dealsUrl }
    this.win = null;
    this.dbg = null;
    this.reqs = new Map();      // requestId -> запрос сайта
    this.templates = new Map(); // операция -> запрос сайта, из ответа которого достали заказы
    this.deals = new Map();     // id заказа -> данные (копятся из всех ответов)
    this.shapes = new Map();    // операция -> набор путей ключей (диагностика)
    this.shapeTimer = null;
    this.user = null;           // профиль из ответа viewer
    this.seen = new Set();      // какие операции видели (для диагностики)
    this.lastOpError = null;
    this.replayFails = 0;
    this.disposed = false;
    // Подробности заказов (название, сумма): кэш на диске, чтобы не ходить за ними повторно.
    this.detailsFile = path.join(userDataDir, 'deal-details.json');
    this.details = safeJson(this.readFile(this.detailsFile), {}) || {};
    this.enriching = null;      // id заказа, за подробностями которого сейчас ходим
    this.detailTpl = null;      // запрос сайта, вернувший подробности заказа { tpl, dealId }
    this.detailTries = new Map(); // id заказа -> сколько раз пытались
  }

  // Журнал для диагностики: консоль + site.log в папке данных приложения.
  log(...parts) {
    const line = `${new Date().toISOString()} ${parts.join(' ')}`;
    console.log('[site]', parts.join(' '));
    try { fs.appendFileSync(this.logFile, line + '\n'); } catch { /* не критично */ }
  }

  // Короткое сообщение о том, что сейчас происходит (показывается в интерфейсе).
  status(text) {
    this.log('status:', text);
    this.emit('status', text);
  }

  readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
  saveState() {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2)); } catch { /* не критично */ }
  }

  get session() { return session.fromPartition(PARTITION); }

  async hasSession() {
    const cookies = await this.session.cookies.get({ name: 'token' });
    return cookies.some((c) => /playerok\.com$/.test(c.domain) && c.value);
  }

  // ── Окно ────────────────────────────────────────────────────
  async open() {
    if (this.win && !this.win.isDestroyed()) return;

    try { fs.writeFileSync(this.logFile, ''); } catch { /* журнал начинаем заново */ }
    const win = new BrowserWindow({
      parent: this.getParent() || undefined, // дочернее окно всегда остаётся над главным
      show: false,
      width: 1100,
      height: 800,
      autoHideMenuBar: true,
      title: TITLE,
      backgroundColor: '#191919',
      webPreferences: {
        partition: PARTITION,
        backgroundThrottling: false,
        preload: path.join(__dirname, 'sitePreload.js'),
      },
    });
    this.win = win;
    win.webContents.setUserAgent(cleanUserAgent(win.webContents.getUserAgent()));
    win.on('page-title-updated', (e) => e.preventDefault()); // заголовок окна — наши подсказки
    // Крестик только прячет окно: страница и перехват продолжают работать.
    win.on('close', (e) => { if (!this.disposed) { e.preventDefault(); win.hide(); } });
    win.on('closed', () => { this.win = null; this.dbg = null; });

    const wc = win.webContents;
    wc.on('did-finish-load', () => this.log('загружено:', wc.getURL(), '| заголовок:', wc.getTitle()));
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = отменена самим сайтом/навигацией
      this.lastLoadError = `${desc} (${code})`;
      this.log('ОШИБКА загрузки:', url, this.lastLoadError);
      this.status(`Не удалось открыть Playerok: ${desc}. Проверь интернет / VPN.`);
    });
    wc.on('render-process-gone', (_e, d) => this.log('процесс страницы упал:', d.reason));

    // Канал 1: DevTools-протокол. ВАЖНО: ответ на Network.enable приходит,
    // только когда у окна есть загружаемая страница, поэтому его нельзя
    // ждать ДО loadURL (именно так окно раньше зависало и не открывалось).
    try {
      this.dbg = wc.debugger;
      this.dbg.attach('1.3');
      this.dbg.on('message', (_e, method, params) => {
        this.onCdp(method, params).catch((err) => this.log('CDP:', err.message));
      });
      this.dbg.sendCommand('Network.enable')
        .then(() => { this.cdpReady = true; this.log('CDP: Network включён'); })
        .catch((err) => this.log('CDP: не удалось включить Network:', err.message));
    } catch (err) {
      this.dbg = null;
      this.log('CDP: не удалось подключиться:', err.message);
    }

    this.log('окно создано, открываю', HOME);
    win.loadURL(HOME).catch((e) => this.log('loadURL:', e.message));
  }

  prompt(title) {
    if (!this.win || this.win.isDestroyed()) return;
    const win = this.win;
    win.setTitle(title);
    if (win.isMinimized()) win.restore();
    win.show();
    // Windows не даёт приложению «отобрать» фокус — на секунду делаем окно поверх всех.
    win.setAlwaysOnTop(true);
    win.moveTop();
    win.focus();
    setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(false); }, 1000);
    this.log('окно показано:', title);
    this.emit('prompt', title);
  }

  hideWindow() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.setTitle(TITLE);
      this.win.hide();
    }
  }

  showWindow() {
    this.prompt(TITLE);
  }

  // ── Чтение сетевых событий ──────────────────────────────────
  async onCdp(method, p) {
    if (method === 'Network.requestWillBeSent') {
      const r = p.request;
      if (!GQL_URL.test(r.url)) return;
      let postData = r.postData;
      if (!postData && r.hasPostData) {
        try { postData = (await this.dbg.sendCommand('Network.getRequestPostData', { requestId: p.requestId })).postData; } catch { /* нет тела */ }
      }
      this.reqs.set(p.requestId, {
        url: r.url,
        method: r.method,
        headers: r.headers,
        postData,
        ops: parseOps(r.url, r.method, postData),
        pageUrl: this.win?.webContents.getURL() || '',
      });
    } else if (method === 'Network.responseReceived') {
      const q = this.reqs.get(p.requestId);
      if (q) q.status = p.response.status;
    } else if (method === 'Network.loadingFinished') {
      const q = this.reqs.get(p.requestId);
      if (!q) return;
      this.reqs.delete(p.requestId);
      const { body, base64Encoded } = await this.dbg.sendCommand('Network.getResponseBody', { requestId: p.requestId });
      this.dispatch(q, base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body, 'cdp');
    } else if (method === 'Network.loadingFailed') {
      this.reqs.delete(p.requestId);
    }
  }

  // Оба канала чтения (DevTools и скрипт в странице) приходят сюда. Один и тот же
  // ответ, пришедший по ДВУМ разным каналам подряд, обрабатываем один раз.
  // Повторные одинаковые ответы по одному каналу — это разные запросы, их не трогаем.
  dispatch(q, text, channel) {
    const key = `${q.method} ${q.url} ${q.postData || ''} ${q.status} ${String(text).length}`;
    const now = Date.now();
    const prev = this.recent.get(key);
    if (prev && prev.channel !== channel && now - prev.time < 2500) return;
    this.recent.set(key, { channel, time: now });
    for (const [k, v] of this.recent) if (now - v.time > 10000) this.recent.delete(k);
    this.handleResponse(q, text);
  }

  onInjected(p) {
    if (!p || typeof p.url !== 'string' || !GQL_URL.test(p.url)) return;
    const method = String(p.method || 'GET').toUpperCase();
    this.dispatch({
      url: p.url,
      method,
      headers: p.headers || {},
      postData: p.body || undefined,
      status: p.status,
      ops: parseOps(p.url, method, p.body || undefined),
      pageUrl: this.win?.webContents.getURL() || '',
    }, String(p.text || ''), 'inject');
  }

  handleResponse(q, text) {
    const json = safeJson(text, null);
    if (!json) {
      console.error(`[site] HTTP ${q.status}: ответ не JSON: ${String(text).slice(0, 150)}`);
      return;
    }
    (Array.isArray(json) ? json : [json]).forEach((item, i) => {
      const name = (q.ops[i] || q.ops[0] || {}).operationName || '?';
      const data = item?.data;
      const errors = item?.errors;
      this.seen.add(name);
      console.log(`[site] ${name} HTTP ${q.status}${errors?.length ? ` — ошибка: ${errors[0].message}` : ''}`);

      if (errors?.length && !data?.viewer && !data?.deals) {
        this.lastOpError = `${name}: ${errors[0].message}`;
        this.emit('opError', { name, message: errors[0].message, status: q.status });
      }

      // Профиль
      if (data?.viewer?.id) {
        this.user = data.viewer;
        this.emit('viewer', data.viewer);
      } else if (/^viewer$/i.test(name) && data && data.viewer === null) {
        this.user = null;
        this.emit('loggedOut');
      }

      // Структура ответа — для диагностики (без значений)
      if (data) this.recordShape(name, data, q.status);

      // Заказы: ищем в любом ответе (список чатов, чат, сообщения, сделки)
      const conn = data?.deals;
      const listed = conn?.edges ? conn.edges.map((e) => e?.node) : conn?.nodes;
      const found = extractDeals(data);
      if (Array.isArray(listed)) {
        for (const d of listed) if (d && typeof d.id === 'string' && !found.some((f) => f.id === d.id)) found.push(d);
      }
      if (found.length) {
        for (const d of found) {
          const merged = mergeDeal(this.deals.get(d.id), d);
          this.deals.set(d.id, merged);
          if (hasDetails(merged)) this.rememberDetails(merged);
        }
        const target = this.enriching && found.find((d) => d.id === this.enriching && hasDetails(d));
        if (target && q.ops.length === 1) {
          // Этот запрос сайта отдаёт название и сумму заказа — запомним его как шаблон.
          this.detailTpl = { tpl: { url: q.url, method: q.method, headers: q.headers, postData: q.postData }, dealId: target.id, name };
          this.log('подробности заказа приходят из операции', name);
          this.emit('dealDetails', target.id);
        } else if (target) {
          this.emit('dealDetails', target.id);
        }
        if (q.ops.length === 1 && !this.enriching) {
          this.templates.set(name.toLowerCase(), { url: q.url, method: q.method, headers: q.headers, postData: q.postData });
          if (/^https:\/\/([a-z0-9-]+\.)?playerok\.com\//i.test(q.pageUrl) && !GQL_URL.test(q.pageUrl)) {
            if (this.state.dealsUrl !== q.pageUrl) { this.state.dealsUrl = q.pageUrl; this.saveState(); }
          }
        }
        this.lastOpError = null;
        this.dumpDebug(name, q, found);
        this.emit('deals', { name, count: found.length });
      }
    });
  }

  recordShape(name, data, status) {
    const set = this.shapes.get(name) || new Set();
    collectPaths(data, 'data', set);
    this.shapes.set(name, set);
    clearTimeout(this.shapeTimer);
    this.shapeTimer = setTimeout(() => {
      try {
        const out = {};
        for (const [op, paths] of this.shapes) out[op] = [...paths].sort();
        fs.writeFileSync(path.join(this.dir, 'ops-shape.json'), JSON.stringify(out, null, 2));
      } catch { /* не критично */ }
    }, 1500);
  }

  // Для диагностики: что именно вернул сайт (первые заказы).
  dumpDebug(name, q, nodes) {
    try {
      fs.writeFileSync(
        path.join(this.dir, 'last-deals.json'),
        JSON.stringify({ operation: name, page: q.pageUrl, variables: q.ops[0]?.variables, count: nodes.length, sample: nodes.slice(0, 3) }, null, 2)
      );
    } catch { /* не критично */ }
  }

  // ── Ожидание событий ────────────────────────────────────────
  waitFor(events, timeout, { cancelOnHide = false } = {}) {
    return new Promise((resolve, reject) => {
      const cleanups = [];
      const done = (fn, v) => { cleanups.forEach((c) => { try { c(); } catch { /* окно уже уничтожено */ } }); fn(v); };
      const timer = setTimeout(() => done(reject, new Error('Время ожидания истекло')), timeout);
      cleanups.push(() => clearTimeout(timer));
      for (const ev of events) {
        const h = (value) => done(resolve, { event: ev, value });
        this.on(ev, h);
        cleanups.push(() => this.off(ev, h));
      }
      const onCancel = () => done(reject, new Error('Отменено'));
      this.on('cancel', onCancel);
      cleanups.push(() => this.off('cancel', onCancel));
      if (cancelOnHide && this.win && !this.win.isDestroyed()) {
        const win = this.win;
        const h = () => done(reject, new Error('Окно Playerok закрыто до завершения'));
        win.on('hide', h);
        cleanups.push(() => win.removeListener('hide', h));
      }
    });
  }

  // ── Вход ────────────────────────────────────────────────────
  // Возвращает профиль. `showNow: true` — человек сам нажал «Войти», окно
  // показываем сразу; иначе окно сначала скрыто и показывается, только если
  // за несколько секунд не удалось понять, что мы уже вошли.
  // Параллельные вызовы делят один и тот же процесс входа.
  login({ showNow = false } = {}) {
    if (!this.loginPromise) {
      // raceCancel: «Отмена» срабатывает мгновенно, даже если процесс на чём-то застрял.
      this.loginPromise = this.raceCancel(this.doLogin(showNow)).finally(() => { this.loginPromise = null; });
    } else if (showNow) {
      this.prompt(LOGIN_TITLE);
    }
    return this.loginPromise;
  }

  async doLogin(showNow) {
    this.status('Открываю Playerok…');
    await this.open();
    this.status('Жду ответ сайта…');
    if (showNow) this.prompt(LOGIN_TITLE);

    if (!this.user) {
      try {
        await this.waitFor(['viewer', 'loggedOut'], showNow ? 15000 : 6000, { cancelOnHide: showNow });
      } catch (err) {
        if (/Отменено|закрыто до завершения/.test(err.message)) { this.hideWindow(); throw err; }
        this.log('за отведённое время профиль не получен (viewer не пришёл)');
      }
    }
    if (this.user) {
      this.log('вход подтверждён:', this.user.username);
      this.finishLogin();
      return this.user;
    }

    // Не удалось понять, вошли ли мы, — нужен человек: вход или проверка «я не робот».
    this.status('Нужен вход в Playerok — открыл окно. Если там проверка «я не робот», пройди её, затем войди.');
    this.prompt(LOGIN_TITLE);

    const t0 = Date.now();
    let reloaded = false;
    const poll = setInterval(async () => {
      try {
        const hasToken = await this.hasSession();
        // После входа сайт не всегда сам перезапрашивает профиль — помогаем.
        if (!this.user && !reloaded && hasToken) {
          reloaded = true;
          setTimeout(() => this.win?.webContents.reload(), 1500);
        }
        // Сайт грузится, вход есть, но профиль мы так и не увидели (другое имя
        // операции?) — не держим человека вечно, работаем без имени.
        if (!this.user && hasToken && Date.now() - t0 > this.noViewerGraceMs && this.seen.size > 0 && !this.seen.has('viewer')) {
          this.log('viewer не встречен, но сессия есть — продолжаю без имени');
          this.user = { id: null, username: this.state.username || 'Playerok' };
          this.emit('viewer', this.user);
        }
      } catch { /* окно могли закрыть */ }
    }, 2000);
    try {
      await this.waitFor(['viewer'], 5 * 60 * 1000, { cancelOnHide: true });
    } finally {
      clearInterval(poll);
      this.hideWindow();
    }
    this.finishLogin();
    return this.user;
  }

  finishLogin() {
    this.hideWindow();
    if (this.user?.username) {
      this.state.username = this.user.username;
      this.saveState();
    }
  }

  raceCancel(promise) {
    return new Promise((resolve, reject) => {
      const onCancel = () => reject(new Error('Отменено'));
      this.once('cancel', onCancel);
      promise.then(
        (v) => { this.off('cancel', onCancel); resolve(v); },
        (e) => { this.off('cancel', onCancel); reject(e); }
      );
    });
  }

  // Отмена ожидания (кнопка в интерфейсе).
  cancel() {
    this.log('отмена пользователем');
    this.emit('cancel');
    this.hideWindow();
  }

  // ── Страница сделок ─────────────────────────────────────────
  // Один раз просим человека открыть «Чаты» → чат с заказом; адрес запоминаем.
  prepareDeals() {
    if (!this.dealsPromise) {
      this.dealsPromise = this.raceCancel(this.doPrepareDeals()).finally(() => { this.dealsPromise = null; });
    }
    return this.dealsPromise;
  }

  async doPrepareDeals() {
    await this.open();

    if (this.state.dealsUrl) {
      this.status('Загружаю заказы…');
      const wait = this.waitFor(['deals'], 30000);
      this.win.loadURL(this.state.dealsUrl).catch(() => {});
      try { await wait; return; } catch (err) {
        if (/Отменено/.test(err.message)) throw err;
        /* адрес устарел — спросим заново */
      }
    }

    this.prompt('Playerok Bot — открой «Чаты» и зайди в чат с заказом, окно закроется само');
    try {
      await this.waitFor(['deals'], 5 * 60 * 1000, { cancelOnHide: true });
    } finally {
      this.hideWindow();
    }
  }

  // Свежий список заказов.
  async fetchDeals() {
    if (!this.win || this.win.isDestroyed()) throw new Error('Окно Playerok не запущено');
    this.lastOpError = null;

    // 1) Повторяем в странице те же запросы, из ответов которых уже доставали
    //    заказы (список чатов, чат…): те же cookie, заголовки, отпечаток.
    if (this.templates.size && this.replayFails < 2) {
      const templates = [...this.templates.values()].slice(-3);
      try {
        const done = this.waitForCount('deals', templates.length, 15000);
        for (const tpl of templates) await this.replay(tpl);
        await done;
        this.replayFails = 0;
        await this.enrichDeals();
        return this.snapshot();
      } catch {
        this.replayFails += 1;
      }
    }

    // 2) Запасной путь — перезагрузить страницу: сайт запросит всё сам.
    const wait = this.waitFor(['deals'], 30000);
    const target = this.state.dealsUrl || this.win.webContents.getURL();
    this.win.loadURL(target).catch(() => {});
    try {
      await wait;
      await new Promise((r) => setTimeout(r, 1200)); // дать долететь остальным ответам страницы
      await this.enrichDeals();
      return this.snapshot();
    } catch {
      throw new Error(this.lastOpError
        ? `Playerok вернул ошибку (${this.lastOpError})`
        : 'Playerok не вернул заказы — проверь, что вход выполнен и открыт чат с заказом');
    }
  }

  // Ждёт `count` событий (или хотя бы одного к концу таймаута).
  waitForCount(event, count, timeout) {
    return new Promise((resolve, reject) => {
      let got = 0;
      const h = () => { got += 1; if (got >= count) finish(true); };
      const finish = (ok) => { clearTimeout(timer); this.off(event, h); if (ok || got > 0) resolve(); else reject(new Error('Время ожидания истекло')); };
      const timer = setTimeout(() => finish(false), timeout);
      this.on(event, h);
    });
  }

  // Накопленные заказы, свежие сверху (храним не больше 100).
  snapshot() {
    const ts = (d) => Date.parse(d.createdAt || d.updatedAt || '') || 0;
    const list = [...this.deals.values()].sort((a, b) => ts(b) - ts(a)).slice(0, 100);
    return mapDeals(list).map((o) => {
      const c = this.details[o.id];
      if (!c) return o;
      return { ...o, item: { ...o.item, name: o.item.name || c.name, price: o.item.price ?? c.price } };
    });
  }

  // ── Подробности заказа (что купили и за сколько) ────────────
  rememberDetails(d) {
    const name = dealName(d);
    const price = dealPrice(d);
    const old = this.details[d.id];
    if (old && old.name === name && old.price === price) return;
    this.details[d.id] = { name, price, at: Date.now() };
    const ids = Object.keys(this.details);
    if (ids.length > 500) { // кэш не разрастается бесконечно
      ids.sort((a, b) => this.details[a].at - this.details[b].at).slice(0, ids.length - 500).forEach((id) => delete this.details[id]);
    }
    try { fs.writeFileSync(this.detailsFile, JSON.stringify(this.details, null, 2)); } catch { /* не критично */ }
  }

  // Заказы без названия/суммы: сначала оплаченные и свежие.
  missingDetails(limit) {
    const rank = (d) => (d.status === 'PAID' || d.status === 'PENDING' ? 0 : 1);
    return [...this.deals.values()]
      .filter((d) => !hasDetails(d) && !this.details[d.id] && (this.detailTries.get(d.id) || 0) < 2)
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, limit);
  }

  // Дотягиваем название и сумму. Способ 1: повторить запрос сайта, который
  // уже однажды вернул подробности, подставив id другого заказа. Способ 2
  // (нужен только первый раз, чтобы узнать этот запрос): тихо открыть в
  // скрытом окне чат с заказом — сайт сам запросит подробности.
  async enrichDeals(limit = 5, budgetMs = 25000) {
    const t0 = Date.now();
    const todo = this.missingDetails(limit);
    if (!todo.length) return;
    const backUrl = this.win.webContents.getURL();
    let navigated = false;
    for (const d of todo) {
      if (Date.now() - t0 > budgetMs || !this.win || this.win.isDestroyed()) break;
      this.detailTries.set(d.id, (this.detailTries.get(d.id) || 0) + 1);
      this.enriching = d.id;
      try {
        if (this.detailTpl) {
          const { tpl, dealId } = this.detailTpl;
          const swap = (x) => (typeof x === 'string' ? x.split(dealId).join(d.id) : x);
          const wait = this.waitForDeal(d.id, 8000);
          await this.replay({ ...tpl, url: swap(tpl.url), postData: swap(tpl.postData) }, { raw: true });
          if (await wait) continue;
        }
        const chatId = d.chat?.id;
        if (!chatId) { this.log('у заказа', d.id, 'нет id чата — подробности взять негде'); continue; }
        const wait = this.waitForDeal(d.id, 15000);
        navigated = true;
        this.win.loadURL(`https://playerok.com/chats/${chatId}`).catch(() => {});
        if (!(await wait)) this.log('в чате', chatId, 'не нашлись название/сумма заказа — смотри ops-shape.json');
      } catch (err) {
        this.log('подробности заказа:', err.message);
      } finally {
        this.enriching = null;
      }
    }
    // Вернуть окно туда, где оно было (страница, с которой обновляем список).
    if (navigated && this.win && !this.win.isDestroyed()) {
      const back = this.state.dealsUrl || backUrl;
      if (back) await this.win.loadURL(back).catch(() => {});
    }
  }

  // true, если за timeout пришли подробности этого заказа.
  waitForDeal(id, timeout) {
    return new Promise((resolve) => {
      const h = (got) => { if (got === id) finish(true); };
      const finish = (ok) => { clearTimeout(timer); this.off('dealDetails', h); resolve(ok); };
      const timer = setTimeout(() => finish(false), timeout);
      this.on('dealDetails', h);
    });
  }

  async replay(template, { raw = false } = {}) {
    const url = this.win.webContents.getURL();
    if (!/^https:\/\/([a-z0-9-]+\.)?playerok\.com\//i.test(url)) throw new Error('страница не на playerok.com');
    const tpl = raw ? template : patchTemplate(template);
    const headers = {};
    for (const [k, v] of Object.entries(tpl.headers || {})) if (!SKIP_HEADERS.test(k)) headers[k] = v;
    const j = JSON.stringify;
    await this.win.webContents.executeJavaScript(
      `fetch(${j(tpl.url)}, { method: ${j(tpl.method)}, headers: ${j(headers)}, ` +
      `body: ${j(tpl.method === 'GET' ? null : tpl.postData || null)}, credentials: 'include' }).then((r) => r.status)`
    );
  }

  // ── Выход и завершение ──────────────────────────────────────
  async logout() {
    this.state = {};
    this.saveState();
    this.user = null;
    this.templates.clear();
    this.deals.clear();
    this.shapes.clear();
    this.details = {};
    this.detailTpl = null;
    this.detailTries.clear();
    try { fs.unlinkSync(this.detailsFile); } catch { /* файла нет */ }
    this.replayFails = 0;
    this.seen.clear();
    if (this.win && !this.win.isDestroyed()) {
      this.disposed = true;
      this.win.destroy();
      this.disposed = false;
    }
    this.win = null;
    this.dbg = null;
    await this.session.clearStorageData();
  }

  dispose() {
    this.disposed = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { SiteBrowser, parseOps, patchVariables, patchTemplate, mapDeals, dealName, dealPrice, cleanUserAgent, extractDeals, mergeDeal, collectPaths, PARTITION };
