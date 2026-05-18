// ── Types ──────────────────────────────────────────────────────────────────────

export interface StateKeepConfig {
  baseUrl: string;
  apiKey: string;
  /** Timeout in milliseconds for each request (default: 30000) */
  timeoutMs?: number;
}

export interface Actor {
  id: string;
  definitionId: string;
  orgId: string;
  status: 'active' | 'archived' | 'needs_rescue';
  currentState: string;
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ActorEvent {
  id: number;
  actorId: string;
  eventType: string;
  eventPayload: Record<string, unknown> | null;
  tick: number;
  processedAt: string;
}

export interface SpawnActorOptions {
  definitionId: string;
  initialContext?: Record<string, unknown>;
  id?: string;
}

export interface SendEventOptions {
  type: string;
  payload?: Record<string, unknown>;
}

export interface ListActorEventsOptions {
  limit?: number;
  afterId?: number;
}

export interface ListActorEventsResult {
  actorId: string;
  events: ActorEvent[];
  limit: number;
  afterId: number;
  nextCursor: number | null;
}

export interface BulkSpawnOptions {
  actors: Array<{ definitionId: string; initialContext?: Record<string, unknown> }>;
}

export interface BulkSpawnResult {
  created: Actor[];
  failed: Array<{ input: unknown; error: string }>;
  total: number;
}

export interface StateMachineDefinition {
  id: string;
  orgId: string;
  parentId: string | null;
  machineDefinition: Record<string, unknown>;
  stateMapping?: Record<string, string>;
  historyRegions?: string[];
  createdAt: string;
}

export interface DeployDefinitionOptions {
  id: string;
  parentId?: string;
  machineDefinition: Record<string, unknown>;
  stateMapping?: Record<string, string>;
  historyRegions?: string[];
}

export interface Webhook {
  id: string;
  orgId: string;
  url: string;
  events: string[];
  active: boolean;
  secret: string | null;
  createdAt: string;
}

export interface CreateWebhookOptions {
  url: string;
  events: string[];
  secret?: string;
}

export interface UpdateWebhookOptions {
  url?: string;
  events?: string[];
  active?: boolean;
}

export interface ListWebhooksResult {
  webhooks: Webhook[];
  total: number;
}

export interface StateKeepError {
  statusCode: number;
  error: string;
  message: string;
}

// ── Client ─────────────────────────────────────────────────────────────────────

export class StateKeepRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: StateKeepError,
    message: string,
  ) {
    super(message);
    this.name = 'StateKeepRequestError';
  }
}

export class StateKeepClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: StateKeepConfig) {
    this.baseUrl   = config.baseUrl.replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.headers   = {
      'Content-Type':  'application/json',
      'X-API-Key':     config.apiKey,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers,
        body:    body !== undefined ? JSON.stringify(body) : undefined,
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorBody: StateKeepError;
      try {
        errorBody = await response.json() as StateKeepError;
      } catch {
        errorBody = { statusCode: response.status, error: 'Unknown', message: response.statusText };
      }
      throw new StateKeepRequestError(response.status, errorBody, errorBody.message);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // ── Actors ──────────────────────────────────────────────────────────────────

  async spawnActor(options: SpawnActorOptions): Promise<Actor> {
    return this.request<Actor>('POST', '/v1/actors', options);
  }

  async getActor(actorId: string): Promise<Actor> {
    return this.request<Actor>('GET', `/v1/actors/${encodeURIComponent(actorId)}`);
  }

  async sendEvent(actorId: string, options: SendEventOptions): Promise<Actor> {
    return this.request<Actor>('POST', `/v1/actors/${encodeURIComponent(actorId)}/events`, options);
  }

  async listActorEvents(actorId: string, options: ListActorEventsOptions = {}): Promise<ListActorEventsResult> {
    const params = new URLSearchParams();
    if (options.limit   !== undefined) params.set('limit',   String(options.limit));
    if (options.afterId !== undefined) params.set('afterId', String(options.afterId));
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    return this.request<ListActorEventsResult>('GET', `/v1/actors/${encodeURIComponent(actorId)}/events${qs}`);
  }

  async bulkSpawnActors(options: BulkSpawnOptions): Promise<BulkSpawnResult> {
    return this.request<BulkSpawnResult>('POST', '/v1/actors/bulk', options);
  }

  // ── Definitions ─────────────────────────────────────────────────────────────

  async deployDefinition(options: DeployDefinitionOptions): Promise<StateMachineDefinition> {
    return this.request<StateMachineDefinition>('PUT', '/v1/definitions', options);
  }

  async getDefinition(definitionId: string): Promise<StateMachineDefinition> {
    return this.request<StateMachineDefinition>('GET', `/v1/definitions/${encodeURIComponent(definitionId)}`);
  }

  // ── Webhooks ────────────────────────────────────────────────────────────────

  async listWebhooks(): Promise<ListWebhooksResult> {
    return this.request<ListWebhooksResult>('GET', '/v1/webhooks');
  }

  async getWebhook(webhookId: string): Promise<Webhook> {
    return this.request<Webhook>('GET', `/v1/webhooks/${encodeURIComponent(webhookId)}`);
  }

  async createWebhook(options: CreateWebhookOptions): Promise<Webhook> {
    return this.request<Webhook>('POST', '/v1/webhooks', options);
  }

  async updateWebhook(webhookId: string, options: UpdateWebhookOptions): Promise<Webhook> {
    return this.request<Webhook>('PATCH', `/v1/webhooks/${encodeURIComponent(webhookId)}`, options);
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    return this.request<void>('DELETE', `/v1/webhooks/${encodeURIComponent(webhookId)}`);
  }
}
