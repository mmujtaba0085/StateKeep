// StateKeep SDK — plain JavaScript (TypeScript source at index.ts)

export class StateKeepError extends Error {
  constructor(message, status, code, body = null) {
    super(message);
    this.name   = 'StateKeepError';
    this.status = status;
    this.code   = code;
    this.body   = body;
  }
}

export class StateKeepClient {
  constructor(config) {
    this._base = config.baseUrl.replace(/\/$/, '');
    this._key  = config.apiKey;
  }

  _headers(withBody = true) {
    const h = { 'X-API-Key': this._key };
    if (withBody) h['Content-Type'] = 'application/json';
    return h;
  }

  async _req(method, path, body, query, { soft400 = false } = {}) {
    let url = `${this._base}${path}`;
    if (query) {
      const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      if (qs.length) url += '?' + qs.join('&');
    }

    const hasBody = body != null;
    const res = await fetch(url, {
      method,
      headers: this._headers(hasBody),
      body:    hasBody ? JSON.stringify(body) : undefined,
    });

    let data;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      if (soft400 && res.status === 400 && data?.valid === false) return data;
      const msg  = data?.error ?? `HTTP ${res.status}`;
      const code = data?.code  ?? String(res.status);
      throw new StateKeepError(msg, res.status, code, data);
    }

    if (data?.status === 'requires_confirmation') {
      throw new StateKeepError(
        'Deployment requires confirmation due to stranded actors',
        200, 'REQUIRES_CONFIRMATION', data,
      );
    }

    return data;
  }

  // ── Definitions ───────────────────────────────────────────────────────────

  validate(definition) {
    return this._req('POST', '/v1/definitions/validate', { definition }, undefined, { soft400: true });
  }

  deploy(id, definition, options = {}) {
    return this._req('PUT', '/v1/definitions', { id, definition, ...options });
  }

  preview(id, definition, options = {}) {
    return this._req('POST', '/v1/definitions/preview', { id, definition, ...options });
  }

  getDefinition(id) {
    return this._req('GET', `/v1/definitions/${id}`);
  }

  getDefinitionStatus(id) {
    return this._req('GET', `/v1/definitions/${id}/status`);
  }

  getDefinitionDiff(id) {
    return this._req('GET', `/v1/definitions/${id}/diff`);
  }

  getDefinitionStats(id) {
    return this._req('GET', `/v1/definitions/${id}/stats`);
  }

  getMachineStats(machineId) {
    return this._req('GET', `/v1/machines/${machineId}/stats`);
  }

  listDefinitions(opts = {}) {
    return this._req('GET', '/v1/definitions', undefined, opts);
  }

  // ── Actors ────────────────────────────────────────────────────────────────

  async spawn(definitionId, initialContext = {}) {
    const res = await this._req('POST', '/v1/actors', { definitionId, initialContext });
    // Spawn response uses { id } — normalize to { actorId } for consistent interface
    if (res?.id && !res.actorId) res.actorId = res.id;
    return res;
  }

  send(actorId, eventType, payload = {}, idempotencyKey) {
    const body = { type: eventType, payload };
    if (idempotencyKey) body.idempotencyKey = idempotencyKey;
    return this._req('POST', `/v1/actors/${actorId}/event`, body);
  }

  getState(actorId) {
    return this._req('GET', `/v1/actors/${actorId}`);
  }

  getEvents(actorId, opts = {}) {
    return this._req('GET', `/v1/actors/${actorId}/events`, undefined, opts);
  }

  getDecisions(actorId) {
    return this._req('GET', `/v1/actors/${actorId}/decisions`);
  }

  exportActor(actorId) {
    return this._req('GET', `/v1/actors/${actorId}/export`);
  }

  async terminate(actorId) {
    await this._req('DELETE', `/v1/actors/${actorId}`);
  }

  rescueActor(actorId) {
    return this._req('PATCH', `/v1/actors/${actorId}`, { status: 'active' });
  }

  listActors(opts = {}) {
    return this._req('GET', '/v1/actors', undefined, opts);
  }

  listNeedsRescue(opts = {}) {
    return this._req('GET', '/v1/actors/needs-rescue', undefined, opts);
  }

  // ── Scheduled events ──────────────────────────────────────────────────────

  async schedule(actorId, eventType, opts) {
    const { delay, fireAt, payload } = opts;
    if (!delay && !fireAt) throw new Error('Provide either delay (ms) or fireAt (unix ms timestamp)');
    if (delay && fireAt)   throw new Error('Provide either delay or fireAt, not both');
    const resolvedFireAt = fireAt ?? (Date.now() + delay);
    const res = await this._req('POST', `/v1/actors/${actorId}/schedule`,
      { type: eventType, payload, fireAt: resolvedFireAt });
    if (res?.type && !res.eventType) res.eventType = res.type;
    return res;
  }

  listScheduled(actorId, opts = {}) {
    return this._req('GET', `/v1/actors/${actorId}/schedule`, undefined, opts);
  }

  cancelScheduled(actorId, scheduleId) {
    return this._req('DELETE', `/v1/actors/${actorId}/schedule/${scheduleId}`);
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  createWebhook(opts) {
    return this._req('POST', '/v1/webhooks', opts);
  }

  listWebhooks() {
    return this._req('GET', '/v1/webhooks');
  }

  deleteWebhook(webhookId) {
    return this._req('DELETE', `/v1/webhooks/${webhookId}`);
  }

  // ── Health ────────────────────────────────────────────────────────────────

  health() {
    return this._req('GET', '/v1/health');
  }

  workerHealth() {
    return this._req('GET', '/v1/health/workers');
  }
}

export function createClient(config) {
  return new StateKeepClient(config);
}
