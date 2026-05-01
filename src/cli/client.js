/**
 * src/cli/client.js
 * Minimal HTTP client for the StateKeep API.
 */

export function createClient({ baseUrl, apiKey } = {}) {
  const url  = (baseUrl ?? process.env.STATEKEEP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const key  = apiKey  ?? process.env.STATEKEEP_API_KEY ?? '';

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['x-api-key'] = key;

    const res = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    return { status: res.status, ok: res.ok, body: json };
  }

  return {
    put:  (path, body) => request('PUT',  path, body),
    post: (path, body) => request('POST', path, body),
    get:  (path)       => request('GET',  path),
  };
}
