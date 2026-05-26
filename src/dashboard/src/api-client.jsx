/* global React */

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelTime(ts) {
  if (!ts) return '—';
  const diffMs = Date.now() - ts * 1000;
  const s = Math.floor(diffMs / 1000);
  if (s < 5)   return 'just now';
  if (s < 60)  return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function extractState(stateValue) {
  if (!stateValue) return 'unknown';
  if (typeof stateValue === 'string') return stateValue;
  if (stateValue.value) return stateValue.value;
  if (stateValue.state) return stateValue.state;
  const keys = Object.keys(stateValue);
  return keys.length > 0 ? Object.values(stateValue)[0] || keys[0] : 'unknown';
}

function extractVersion(definitionId) {
  const parts = definitionId.split('-');
  const last = parts[parts.length - 1];
  return /^v\d+/.test(last) ? last : '';
}

// ── API client singleton ──────────────────────────────────────────────────────

const Api = (() => {
  const STORE_KEY = 'sk_api_key';
  let _key = localStorage.getItem(STORE_KEY) || '';
  let _listeners = [];

  const self = {
    get key() { return _key; },

    setKey(k) {
      _key = k;
      if (k) localStorage.setItem(STORE_KEY, k);
      else localStorage.removeItem(STORE_KEY);
      _listeners.forEach(fn => fn(k));
    },

    onChange(fn) {
      _listeners.push(fn);
      return () => { _listeners = _listeners.filter(l => l !== fn); };
    },

    async request(method, path, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (_key) headers['X-Api-Key'] = _key;
      const res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401) {
        // Stale or revoked key — clear it so the login page re-appears
        self.setKey('');
        const err = new Error('Session expired — please sign in again');
        err.status = 401;
        throw err;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = 'HTTP ' + res.status;
        try { msg = JSON.parse(text).error || msg; } catch {}
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },

    get:   (path)        => self.request('GET',   path),
    post:  (path, body)  => self.request('POST',  path, body),
    put:   (path, body)  => self.request('PUT',   path, body),
    patch: (path, body)  => self.request('PATCH', path, body),

    // ── Data mappers ─────────────────────────────────────────────────────────

    mapActor(a) {
      const defId = a.definitionId || '';
      return {
        id:        a.id,
        machine:   defId,
        version:   extractVersion(defId),
        state:     extractState(a.stateValue),
        status:    a.status,
        lastEvt:   a.lastEventTick != null ? 'tick ' + a.lastEventTick : '—',
        lastTime:  formatRelTime(a.updatedAt),
        age:       formatRelTime(a.createdAt),
        _raw:      a,
      };
    },

    mapWebhook(w) {
      return {
        id:           w.id,
        url:          w.url,
        events:       w.events || [],
        active:       w.active,
        failures:     w.failures || 0,
        lastDelivery: w.lastFiredAt ? formatRelTime(w.lastFiredAt) : 'never',
        _raw:         w,
      };
    },
  };

  return self;
})();

window.Api = Api;
window.formatRelTime = formatRelTime;
