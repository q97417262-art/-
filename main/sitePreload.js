/**
 * Preload окна Playerok: второй, независимый от отладчика способ читать
 * ответы сайта. В страницу (основной мир) вставляется тонкая обёртка над
 * fetch: она НИЧЕГО не меняет в запросах, только копирует ответы
 * GraphQL и отдаёт их сюда через postMessage → ipcRenderer → siteBrowser.js.
 */
const { ipcRenderer, webFrame } = require('electron');

const HOOK = `(() => {
  if (window.__plkHooked) return;
  window.__plkHooked = true;
  const post = (m) => { try { window.postMessage(Object.assign({ __plk: 1 }, m), '*'); } catch (e) {} };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return String(u); } };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let info = null;
    try {
      const req = (typeof Request !== 'undefined' && input instanceof Request) ? input : null;
      const url = abs(req ? req.url : input);
      if (/\\/graphql/.test(url)) {
        const headers = {};
        new Headers((init && init.headers) || (req && req.headers) || undefined).forEach((v, k) => { headers[k] = v; });
        info = {
          url,
          method: String((init && init.method) || (req && req.method) || 'GET').toUpperCase(),
          headers,
          body: init && typeof init.body === 'string' ? init.body : null,
        };
      }
    } catch (e) { info = null; }
    const p = origFetch.apply(this, arguments);
    if (info) {
      p.then(
        (res) => res.clone().text().then((text) => post(Object.assign(info, { status: res.status, text }))),
        () => {}
      ).catch(() => {});
    }
    return p;
  };
})();`;

try { webFrame.executeJavaScript(HOOK); } catch (e) { /* без обёртки работает канал DevTools */ }

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__plk !== 1) return;
  const { url, method, headers, body, status, text } = e.data;
  ipcRenderer.send('site:gql', { url, method, headers, body, status, text });
});
