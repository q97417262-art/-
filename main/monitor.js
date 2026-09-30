/**
 * Мониторинг новых оплаченных заказов.
 * Каждые N секунд просит у окна Playerok (siteBrowser.js) свежий список
 * сделок и сообщает о новых через колбэки.
 */
const PAID_STATUSES = new Set(['PAID', 'PENDING']);
const MAX_SILENT_ERRORS = 3; // после стольких ошибок подряд — остановиться

class Monitor {
  constructor({ site, interval, onOrders, onNewOrder, onError, onStopped }) {
    this.site = site;
    this.interval = Math.max(10, interval) * 1000;
    this.onOrders = onOrders;
    this.onNewOrder = onNewOrder;
    this.onError = onError;
    this.onStopped = onStopped;
    this.timer = null;
    this.busy = false;
    this.knownIds = new Set();
    this.firstRun = true;
    this.errors = 0;
  }

  async start() {
    await this._tick();
    if (this.errors === 0) this.timer = setInterval(() => this._tick(), this.interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    if (this.busy) return; // предыдущий опрос ещё идёт
    this.busy = true;
    try {
      const orders = await this.site.fetchDeals();
      const paid = orders.filter((o) => PAID_STATUSES.has(o.status));

      if (this.firstRun) {
        // Уже существующие заказы не считаем «новыми»
        paid.forEach((o) => this.knownIds.add(o.id));
        this.firstRun = false;
      } else {
        for (const order of paid) {
          if (!this.knownIds.has(order.id)) {
            this.knownIds.add(order.id);
            this.onNewOrder?.(order);
            // ════════════════════════════════════════════════
            //  ШАГ 3-4 (следующий этап):
            //  поиск товара в локальной БД → «Выдано» →
            //  отправка данных в чат → закрытие сделки
            // ════════════════════════════════════════════════
          }
        }
      }

      this.errors = 0;
      this.onOrders?.(orders);
    } catch (err) {
      this.errors += 1;
      const where = this.firstRun ? 'загрузки заказов' : 'мониторинга';
      this.onError?.(`Ошибка ${where}: ${err.message}`);
      if (this.firstRun || this.errors >= MAX_SILENT_ERRORS) {
        this.stop();
        this.onStopped?.();
      }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = Monitor;
