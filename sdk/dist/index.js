// ── Types ──────────────────────────────────────────────────────────────────────
// ── Client ─────────────────────────────────────────────────────────────────────
export class StateKeepRequestError extends Error {
    statusCode;
    body;
    constructor(statusCode, body, message) {
        super(message);
        this.statusCode = statusCode;
        this.body = body;
        this.name = 'StateKeepRequestError';
    }
}
export class StateKeepClient {
    baseUrl;
    headers;
    timeoutMs;
    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/$/, '');
        this.timeoutMs = config.timeoutMs ?? 30_000;
        this.headers = {
            'Content-Type': 'application/json',
            'X-API-Key': config.apiKey,
        };
    }
    async request(method, path, body) {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
            response = await fetch(url, {
                method,
                headers: this.headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            let errorBody;
            try {
                errorBody = await response.json();
            }
            catch {
                errorBody = { statusCode: response.status, error: 'Unknown', message: response.statusText };
            }
            throw new StateKeepRequestError(response.status, errorBody, errorBody.message);
        }
        if (response.status === 204)
            return undefined;
        return response.json();
    }
    // ── Actors ──────────────────────────────────────────────────────────────────
    async spawnActor(options) {
        return this.request('POST', '/v1/actors', options);
    }
    async getActor(actorId) {
        return this.request('GET', `/v1/actors/${encodeURIComponent(actorId)}`);
    }
    async sendEvent(actorId, options) {
        return this.request('POST', `/v1/actors/${encodeURIComponent(actorId)}/events`, options);
    }
    async listActorEvents(actorId, options = {}) {
        const params = new URLSearchParams();
        if (options.limit !== undefined)
            params.set('limit', String(options.limit));
        if (options.afterId !== undefined)
            params.set('afterId', String(options.afterId));
        const qs = params.size > 0 ? `?${params.toString()}` : '';
        return this.request('GET', `/v1/actors/${encodeURIComponent(actorId)}/events${qs}`);
    }
    async bulkSpawnActors(options) {
        return this.request('POST', '/v1/actors/bulk', options);
    }
    // ── Definitions ─────────────────────────────────────────────────────────────
    async deployDefinition(options) {
        return this.request('PUT', '/v1/definitions', options);
    }
    async getDefinition(definitionId) {
        return this.request('GET', `/v1/definitions/${encodeURIComponent(definitionId)}`);
    }
    // ── Webhooks ────────────────────────────────────────────────────────────────
    async listWebhooks() {
        return this.request('GET', '/v1/webhooks');
    }
    async getWebhook(webhookId) {
        return this.request('GET', `/v1/webhooks/${encodeURIComponent(webhookId)}`);
    }
    async createWebhook(options) {
        return this.request('POST', '/v1/webhooks', options);
    }
    async updateWebhook(webhookId, options) {
        return this.request('PATCH', `/v1/webhooks/${encodeURIComponent(webhookId)}`, options);
    }
    async deleteWebhook(webhookId) {
        return this.request('DELETE', `/v1/webhooks/${encodeURIComponent(webhookId)}`);
    }
}
//# sourceMappingURL=index.js.map