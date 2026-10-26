// ── Error type ────────────────────────────────────────────────────────────────
export class StateKeepError extends Error {
    status;
    code;
    body;
    constructor(message, status, code, body = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.body = body;
        this.name = 'StateKeepError';
    }
}
// ── Client ────────────────────────────────────────────────────────────────────
export class StateKeepClient {
    base;
    key;
    constructor(config) {
        this.base = config.baseUrl.replace(/\/$/, '');
        this.key = config.apiKey;
    }
    headers(withBody = true) {
        const h = { 'X-API-Key': this.key };
        if (withBody)
            h['Content-Type'] = 'application/json';
        return h;
    }
    async req(method, path, body, query, options) {
        let url = `${this.base}${path}`;
        if (query) {
            const qs = Object.entries(query)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
            if (qs.length)
                url += '?' + qs.join('&');
        }
        const hasBody = body != null;
        const res = await fetch(url, {
            method,
            headers: this.headers(hasBody),
            body: hasBody ? JSON.stringify(body) : undefined,
        });
        let data;
        try {
            data = await res.json();
        }
        catch {
            data = null;
        }
        if (!res.ok) {
            if (options?.soft400 && res.status === 400 && data?.valid === false)
                return data;
            const msg = data?.error ?? `HTTP ${res.status}`;
            const code = data?.code ?? String(res.status);
            throw new StateKeepError(msg, res.status, code, data);
        }
        if (data?.status === 'requires_confirmation') {
            throw new StateKeepError('Deployment requires confirmation due to stranded actors', 200, 'REQUIRES_CONFIRMATION', data);
        }
        return data;
    }
    // ── Definitions ───────────────────────────────────────────────────────────
    async validate(definition) {
        return this.req('POST', '/v1/definitions/validate', { definition }, undefined, { soft400: true });
    }
    async deploy(id, definition, options = {}) {
        return this.req('PUT', '/v1/definitions', { id, definition, ...options });
    }
    async preview(id, definition, options = {}) {
        return this.req('POST', '/v1/definitions/preview', { id, definition, ...options });
    }
    async getDefinition(id) {
        return this.req('GET', `/v1/definitions/${id}`);
    }
    async getDefinitionStatus(id) {
        return this.req('GET', `/v1/definitions/${id}/status`);
    }
    async getDefinitionDiff(id) {
        return this.req('GET', `/v1/definitions/${id}/diff`);
    }
    async getDefinitionStats(id) {
        return this.req('GET', `/v1/definitions/${id}/stats`);
    }
    async getMachineStats(machineId) {
        return this.req('GET', `/v1/machines/${machineId}/stats`);
    }
    async listDefinitions(opts = {}) {
        return this.req('GET', '/v1/definitions', undefined, opts);
    }
    // ── Actors ────────────────────────────────────────────────────────────────
    async spawn(definitionId, initialContext = {}) {
        const res = await this.req('POST', '/v1/actors', { definitionId, initialContext });
        // Spawn response uses { id } — normalize to { actorId } for consistent interface
        if (res?.id && !res.actorId)
            res.actorId = res.id;
        return res;
    }
    async send(actorId, eventType, payload = {}, idempotencyKey) {
        const body = { type: eventType, payload };
        if (idempotencyKey)
            body.idempotencyKey = idempotencyKey;
        return this.req('POST', `/v1/actors/${actorId}/event`, body);
    }
    async getState(actorId) {
        return this.req('GET', `/v1/actors/${actorId}`);
    }
    async getEvents(actorId, opts = {}) {
        return this.req('GET', `/v1/actors/${actorId}/events`, undefined, opts);
    }
    async getDecisions(actorId) {
        return this.req('GET', `/v1/actors/${actorId}/decisions`);
    }
    async exportActor(actorId) {
        return this.req('GET', `/v1/actors/${actorId}/export`);
    }
    async terminate(actorId) {
        await this.req('DELETE', `/v1/actors/${actorId}`);
    }
    async rescueActor(actorId) {
        return this.req('PATCH', `/v1/actors/${actorId}`, { status: 'active' });
    }
    async listActors(opts = {}) {
        return this.req('GET', '/v1/actors', undefined, opts);
    }
    async listNeedsRescue(opts = {}) {
        return this.req('GET', '/v1/actors/needs-rescue', undefined, opts);
    }
    // ── Scheduled events ──────────────────────────────────────────────────────
    async schedule(actorId, eventType, opts) {
        const { delay, fireAt, payload } = opts;
        if (!delay && !fireAt)
            throw new Error('Provide either delay (ms) or fireAt (unix ms timestamp)');
        if (delay && fireAt)
            throw new Error('Provide either delay or fireAt, not both');
        const resolvedFireAt = fireAt ?? (Date.now() + delay);
        const res = await this.req('POST', `/v1/actors/${actorId}/schedule`, { type: eventType, payload, fireAt: resolvedFireAt });
        if (res?.type && !res.eventType)
            res.eventType = res.type;
        return res;
    }
    async listScheduled(actorId, opts = {}) {
        return this.req('GET', `/v1/actors/${actorId}/schedule`, undefined, opts);
    }
    async cancelScheduled(actorId, scheduleId) {
        await this.req('DELETE', `/v1/actors/${actorId}/schedule/${scheduleId}`);
    }
    // ── Webhooks ──────────────────────────────────────────────────────────────
    async createWebhook(opts) {
        return this.req('POST', '/v1/webhooks', opts);
    }
    async listWebhooks() {
        return this.req('GET', '/v1/webhooks');
    }
    async deleteWebhook(webhookId) {
        await this.req('DELETE', `/v1/webhooks/${webhookId}`);
    }
    // ── Health ────────────────────────────────────────────────────────────────
    async health() {
        return this.req('GET', '/v1/health');
    }
    async workerHealth() {
        return this.req('GET', '/v1/health/workers');
    }
}
// ── Factory ───────────────────────────────────────────────────────────────────
export function createClient(config) {
    return new StateKeepClient(config);
}
//# sourceMappingURL=index.js.map