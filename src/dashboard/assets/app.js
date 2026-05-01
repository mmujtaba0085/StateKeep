/**
 * dashboard/assets/app.js — shared dashboard utilities
 * Injected into every dashboard page.
 */

// ── Auth ──────────────────────────────────────────────────────────────────────
function getApiKey() {
  const key = sessionStorage.getItem('sk_apikey');
  if (!key) { window.location.href = '/dashboard/login.html'; return null; }
  return key;
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-API-Key': getApiKey() };
}

async function apiFetch(path, options = {}) {
  const key = getApiKey();
  if (!key) return null;
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key, ...(options.headers ?? {}) },
  });
  if (res.status === 401 || res.status === 403) {
    sessionStorage.removeItem('sk_apikey');
    window.location.href = '/dashboard/login.html';
    return null;
  }
  return res;
}

// ── Formatting ────────────────────────────────────────────────────────────────
function formatState(val) {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function formatDate(ts) {
  if (!ts) return '—';
  // Logical tick (small integer) vs real epoch (large integer > year 2000 in ms)
  if (ts < 1_000_000_000_000) return `Logical Tick #${ts}`;
  return new Date(ts).toLocaleString();
}

function formatContext(ctx) {
  if (!ctx) return '{}';
  return JSON.stringify(ctx, null, 2);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}
