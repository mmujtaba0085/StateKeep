/**
 * benchmarks/shared/client.js
 *
 * Thin HTTP client around fetch. Each method returns { status, body }.
 * Accepts an optional adminKey for endpoints that require x-admin-key.
 */

export class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async _req(method, path, body, apiKey, adminKey) {
    const headers = {};
    if (apiKey)   headers['x-api-key']   = apiKey;
    if (adminKey) headers['x-admin-key'] = adminKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  }

  get(path, apiKey, adminKey)         { return this._req('GET',    path, undefined, apiKey, adminKey); }
  post(path, body, apiKey, adminKey)  { return this._req('POST',   path, body,      apiKey, adminKey); }
  put(path, body, apiKey, adminKey)   { return this._req('PUT',    path, body,      apiKey, adminKey); }
  delete(path, apiKey, adminKey)      { return this._req('DELETE', path, undefined, apiKey, adminKey); }
}
