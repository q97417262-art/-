/**
 * Автовыдача Adopt Me.
 * Хранит список питомцев на продажу, ставит оплаченные заказы в очередь
 * и по одному отдаёт их помощнику trader/trader.py (он смотрит на экран и
 * кликает трейд как человек).
 */
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRADER = path.join(__dirname, '..', '..', 'trader', 'trader.py');

class Delivery extends EventEmitter {
  constructor({ userDataDir, getSettings }) {
    super();
    this.dir = userDataDir;
    this.getSettings = getSettings;
    this.petsDir = path.join(userDataDir, 'pets');
    this.petsFile = path.join(userDataDir, 'pets.json');
    this.doneFile = path.join(userDataDir, 'delivered.json');
    fs.mkdirSync(this.petsDir, { recursive: true });
    this.pets = this.read(this.petsFile, []);
    this.delivered = new Set(this.read(this.doneFile, []));
    this.queue = [];      // { id, buyer, title, pets, state, msg }
    this.current = null;
    this.proc = null;
    this.helper = { ready: false, ocr: null, missing: [], error: null };
    this.logs = [];
  }

  read(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
  write(f, v) { try { fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch { /* не критично */ } }

  log(msg) {
    const line = `${new Date().toLocaleTimeString('ru-RU')} ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.emit('log', line);
  }

  // ── Питомцы ────────────────────────────────────────────────
  listPets() {
    return this.pets.map((p) => {
      let img = null;
      try { img = 'data:image/png;base64,' + fs.readFileSync(p.image).toString('base64'); } catch { /* картинки нет */ }
      return { ...p, img };
    });
  }

  savePet(data) {
    const id = data.id || crypto.randomUUID();
    const old = this.pets.find((p) => p.id === id) || {};
    let image = old.image;
    if (data.imageDataUrl) {
      const b64 = String(data.imageDataUrl).replace(/^data:image\/\w+;base64,/, '');
      image = path.join(this.petsDir, `${id}.png`);
      fs.writeFileSync(image, Buffer.from(b64, 'base64'));
    }
    if (!image) throw new Error('Добавь картинку питомца');
    if (!String(data.name || '').trim()) throw new Error('Укажи название питомца');
    const pet = {
      id,
      name: String(data.name).trim(),
      search: String(data.search ?? data.name).trim(),
      match: String(data.match || data.name).trim(),
      count: Math.min(9, Math.max(1, Number(data.count) || 1)),
      enabled: data.enabled !== false,
      image,
    };
    this.pets = old.id ? this.pets.map((p) => (p.id === id ? pet : p)) : [...this.pets, pet];
    this.write(this.petsFile, this.pets);
    return pet;
  }

  removePet(id) {
    const p = this.pets.find((x) => x.id === id);
    if (p) { try { fs.unlinkSync(p.image); } catch { /* уже нет */ } }
    this.pets = this.pets.filter((x) => x.id !== id);
    this.write(this.petsFile, this.pets);
  }

  // Какие питомцы относятся к заказу: ключевые слова из поля «Слова в названии товара».
  petsFor(order) {
    const title = String(order.item?.name || '').toLowerCase();
    if (!title) return [];
    return this.pets.filter((p) => p.enabled && p.match.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean).some((w) => title.includes(w)));
  }

  // ── Заказы ─────────────────────────────────────────────────
  status(order) {
    if (this.delivered.has(order.id)) return { state: 'done' };
    const q = this.queue.find((j) => j.id === order.id);
    if (q) return { state: q.state, msg: q.msg };
    return { state: this.petsFor(order).length ? 'ready' : 'none' };
  }

  // Новый оплаченный заказ из мониторинга.
  onNewOrder(order) {
    if (!this.getSettings().autoDeliver) return;
    if (!this.petsFor(order).length) { this.log(`«${order.item?.name}» — нет подходящего питомца, выдай вручную`); return; }
    this.enqueue(order);
  }

  enqueue(order) {
    if (this.delivered.has(order.id) || this.queue.some((j) => j.id === order.id && j.state !== 'error')) return false;
    const pets = this.petsFor(order);
    if (!pets.length) throw new Error('К этому товару не привязан ни один питомец');
    if (!order.buyer?.username) throw new Error('Не знаю ник покупателя');
    this.queue = this.queue.filter((j) => j.id !== order.id);
    this.queue.push({ id: order.id, buyer: order.buyer.username, title: order.item?.name, pets, state: 'queued', msg: 'в очереди' });
    this.log(`в очередь: ${order.buyer.username} — ${pets.map((p) => `${p.name}×${p.count}`).join(', ')}`);
    this.changed();
    this.next();
    return true;
  }

  test(buyer, petId) {
    const pet = this.pets.find((p) => p.id === petId);
    if (!pet) throw new Error('Выбери питомца');
    if (!String(buyer || '').trim()) throw new Error('Укажи ник в Roblox');
    const id = `test-${Date.now()}`;
    this.queue.push({ id, test: true, buyer: buyer.trim(), title: `Тест: ${pet.name}`, pets: [pet], state: 'queued', msg: 'в очереди' });
    this.changed();
    this.next();
  }

  stop() {
    this.send({ cmd: 'stop' });
    for (const j of this.queue) if (j.state === 'queued') { j.state = 'error'; j.msg = 'отменено'; }
    this.changed();
  }

  markDone(id) {
    this.delivered.add(id);
    this.write(this.doneFile, [...this.delivered].slice(-2000));
    this.changed();
  }

  snapshot() {
    return { queue: this.queue.slice(-30), helper: this.helper, busy: Boolean(this.current), logs: this.logs.slice(-80) };
  }

  changed() { this.emit('update', this.snapshot()); }

  // ── Помощник на Python ─────────────────────────────────────
  startHelper(pyOverride) {
    if (this.proc) return;
    const s = this.getSettings();
    const py = pyOverride || s.pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
    this.helper = { ready: false, ocr: null, missing: [], error: null };
    let proc;
    try {
      proc = spawn(py, ['-u', TRADER], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
    } catch (err) {
      this.helper.error = `Не запустился Python (${err.message})`;
      this.changed();
      return;
    }
    this.proc = proc;
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onHelper(line);
      }
    });
    proc.stderr.on('data', (d) => this.log('python: ' + d.toString('utf8').trim().slice(0, 300)));
    proc.on('error', (err) => {
      if (err.code === 'ENOENT' && py === 'python' && process.platform === 'win32') {
        this.proc = null;
        this.startHelper('py'); // лаунчер Python для Windows
        return;
      }
      this.helper.error = err.code === 'ENOENT'
        ? 'Python не найден. Установи Python 3.10+ с python.org (галочка «Add to PATH»)'
        : `Python: ${err.message}`;
      this.log(this.helper.error);
      this.changed();
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return; // это был неудачный запуск, уже перезапустили
      this.proc = null;
      this.helper.ready = false;
      if (this.current) this.finish(false, 'помощник завершился');
      if (code) this.log(`помощник завершился (код ${code})`);
      this.changed();
    });
  }

  send(obj) {
    if (!this.proc) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  onHelper(line) {
    let m;
    try { m = JSON.parse(line); } catch { this.log(line); return; }
    if (m.type === 'ready' || m.type === 'check') {
      this.helper = { ready: !(m.missing || []).length, ocr: m.ocr, missing: m.missing || [], error: null };
      if (m.missing?.length) this.helper.error = `Не хватает библиотек: pip install ${m.missing.join(' ')}`;
      this.changed();
      this.next();
    } else if (m.type === 'log') {
      this.log(m.msg);
    } else if (m.type === 'step') {
      if (this.current) { this.current.msg = m.msg; this.changed(); }
      this.log('▸ ' + m.msg);
    } else if (m.type === 'done') {
      this.finish(true, m.msg);
    } else if (m.type === 'error') {
      if (m.fatal) { this.helper.error = m.msg; this.changed(); }
      if (this.current) this.finish(false, m.msg); else this.log('⚠ ' + m.msg);
    }
  }

  finish(ok, msg) {
    const job = this.current;
    this.current = null;
    if (!job) return;
    job.state = ok ? 'done' : 'error';
    job.msg = msg;
    this.log(`${ok ? '✅' : '❌'} ${job.buyer}: ${msg}`);
    if (ok && !job.test) this.markDone(job.id);
    this.emit(ok ? 'delivered' : 'failed', job);
    this.changed();
    setTimeout(() => this.next(), 1500);
  }

  next() {
    if (this.current) return;
    const job = this.queue.find((j) => j.state === 'queued');
    if (!job) return;
    if (!this.proc) { this.startHelper(); return; } // продолжим, когда помощник скажет «ready»
    if (!this.helper.ready) return;
    const s = this.getSettings();
    this.current = job;
    job.state = 'running';
    job.msg = 'начинаю';
    this.changed();
    this.send({
      cmd: 'deliver',
      id: job.id,
      buyer: job.buyer,
      pets: job.pets.map((p) => ({ name: p.name, search: p.search, image: p.image, count: p.count })),
      opts: {
        checkNick: s.checkNick !== false,
        petThreshold: s.petThreshold || 0.8,
        requestTimeout: (s.requestTimeoutMin || 10) * 60,
        confirmTimeout: 180,
      },
    });
  }

  dispose() {
    try { this.proc?.kill(); } catch { /* уже закрыт */ }
  }
}

module.exports = Delivery;
