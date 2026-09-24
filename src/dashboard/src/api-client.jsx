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
  return new Date(ts * 1000).toLocaleString();
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
  const self = {
    async request(method, path, body, opts = {}, _retried = false) {
      const headers = { 'Content-Type': 'application/json' };
      if (opts.priority) headers['X-Priority'] = opts.priority;
      // API key (only needed when the server sets STATEKEEP_API_KEY). Kept for this tab only.
      let key = null;
      try { key = sessionStorage.getItem('statekeep_api_key'); } catch {}
      if (key) headers['X-API-Key'] = key;
      const res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 401 || res.status === 403) && !_retried && path.startsWith('/v1/')
          && !path.startsWith('/v1/admin/') && !path.startsWith('/v1/internal/')) {
        const entered = window.prompt('This StateKeep server requires an API key:');
        if (entered) {
          try { sessionStorage.setItem('statekeep_api_key', entered.trim()); } catch {}
          return self.request(method, path, body, opts, true);
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = 'HTTP ' + res.status;
        try { msg = JSON.parse(text).error || msg; } catch {}
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      if (res.status === 204 || res.headers.get('content-length') === '0') return null;
      return res.json();
    },

    get:    (path, opts)        => self.request('GET',    path, undefined, opts),
    post:   (path, body, opts) => self.request('POST',   path, body,      opts),
    put:    (path, body, opts) => self.request('PUT',    path, body,      opts),
    patch:  (path, body, opts) => self.request('PATCH',  path, body,      opts),
    delete: (path, opts)       => self.request('DELETE', path, undefined, opts),

    // ── Data mappers ─────────────────────────────────────────────────────────

    mapActor(a) {
      const defId = a.definitionId || '';
      return {
        id:       a.id,
        defId,
        machine:  defId,
        version:  extractVersion(defId),
        state:    extractState(a.stateValue),
        status:   a.status,
        lastEvt:  a.lastEventTick != null ? 'tick ' + a.lastEventTick : '—',
        lastTime: formatRelTime(a.updatedAt),
        age:      formatRelTime(a.createdAt),
        _raw:     a,
      };
    },

    mapWebhook(w) {
      return {
        id:           w.id,
        url:          w.url,
        events:       w.events || [],
        active:       w.active,
        failures:     w.failureCount || w.failures || 0,
        lastDelivery: w.lastFiredAt ? formatRelTime(w.lastFiredAt) : 'never',
        _raw:         w,
      };
    },
  };

  return self;
})();

window.Api = Api;
window.formatRelTime = formatRelTime;
