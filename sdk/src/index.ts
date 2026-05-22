// ── Error type ────────────────────────────────────────────────────────────────

export class StateKeepError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'StateKeepError';
  }
}

// ── Response types ────────────────────────────────────────────────────────────

export interface Actor {
  actorId:            string;
  definitionId:       string;
  machineId?:         string;
  stateValue:         string | Record<string, unknown>;
  context:            Record<string, unknown>;
  status:             'active' | 'migrating' | 'needs_rescue' | 'terminated' | 'archived';
  historyFingerprint: string;
  logicalStartTick:   number;
  done:               boolean;
  migratedTo?:        string;
  idempotent?:        boolean;
}

export interface DeployResult {
  id:              string;
  parentId:        string | null;
  deployedAt:      number;
  deploymentId:    string | null;
  affectedActors:  number;
  idempotent:      boolean;
  engineAvailable: boolean;
  warnings:        Warning[];
}

export interface ConfirmationRequired {
  status:         'requires_confirmation';
  confirmToken:   string;
  strandedActors: Array<{ currentState: string; count: number }>;
  safeActors:     number;
  expiresIn:      number;
  warnings:       Warning[];
}

export interface Warning {
  type:     string;
  severity: string;
  message:  string;
}

export interface PreviewResult {
  wouldDeploy:    boolean;
  warnings:       Warning[];
  strandedActors: Array<{ currentState: string; count: number }>;
  migration: {
    eligible:        number;
    wouldMigrate:    Array<{ actorId: string; currentState: string; targetDefinitionId: string }>;
    wouldStay:       Array<{ actorId: string; currentState: string; reason: string }>;
    engineAvailable: boolean;
  };
}

export interface ActorEvent {
  id:          number;
  type:        string;
  payload:     Record<string, unknown> | null;
  tick:        number;
  processedAt: number;
}

export interface EventsResult {
  events:     ActorEvent[];
  count:      number;
  hasMore:    boolean;
  nextCursor: number | null;
}

export interface ScheduledEvent {
  id:        string;
  actorId:   string;
  eventType: string;
  fireAt:    number;
  status:    'pending' | 'fired' | 'failed' | 'cancelled';
}

export interface ValidationResult {
  valid:        boolean;
  initialState: string;
  stateCount:   number;
  states:       string[];
  finalStates:  string[];
  errors:       Warning[];
  warnings:     Warning[];
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface StateKeepConfig {
  baseUrl: string;
  apiKey:  string;
}

export interface DeployOptions {
  parentId?:         string;
  historyPath?:      string[];
  stateMapping?:     Record<string, string>;
  contextTransform?: Record<string, string>;
  confirmToken?:     string;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class StateKeepClient {
  private readonly base: string;
  private readonly key:  string;

  constructor(config: StateKeepConfig) {
    this.base = config.baseUrl.replace(/\/$/, '');
    this.key  = config.apiKey;
  }

  private headers(withBody = true): Record<string, string> {
    const h: Record<string, string> = { 'X-API-Key': this.key };
    if (withBody) h['Content-Type'] = 'application/json';
    return h;
  }

  private async req<T>(
    method:   string,
    path:     string,
    body?:    unknown,
    query?:   Record<string, string | number | boolean | undefined>,
    options?: { soft400?: boolean },
  ): Promise<T> {
    let url = `${this.base}${path}`;
    if (query) {
      const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      if (qs.length) url += '?' + qs.join('&');
    }

    const hasBody = body != null;
    const res = await fetch(url, {
      method,
      headers: this.headers(hasBody),
      body:    hasBody ? JSON.stringify(body) : undefined,
    });

    let data: unknown;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      if (options?.soft400 && res.status === 400 && (data as any)?.valid === false) return data as T;
      const msg  = (data as any)?.error ?? `HTTP ${res.status}`;
      const code = (data as any)?.code  ?? String(res.status);
      throw new StateKeepError(msg, res.status, code, data);
    }

    if ((data as any)?.status === 'requires_confirmation') {
      throw new StateKeepError(
        'Deployment requires confirmation due to stranded actors',
        200,
        'REQUIRES_CONFIRMATION',
        data,
      );
    }

    return data as T;
  }

  // ── Definitions ───────────────────────────────────────────────────────────

  async validate(definition: object): Promise<ValidationResult> {
    return this.req('POST', '/v1/definitions/validate', { definition }, undefined, { soft400: true });
  }

  async deploy(
    id:         string,
    definition: object,
    options:    DeployOptions = {},
  ): Promise<DeployResult> {
    return this.req('PUT', '/v1/definitions', { id, definition, ...options });
  }

  async preview(
    id:         string,
    definition: object,
    options:    Omit<DeployOptions, 'confirmToken'> = {},
  ): Promise<PreviewResult> {
    return this.req('POST', '/v1/definitions/preview', { id, definition, ...options });
  }

  async getDefinition(id: string): Promise<object> {
    return this.req('GET', `/v1/definitions/${id}`);
  }

  async getDefinitionStatus(id: string): Promise<object> {
    return this.req('GET', `/v1/definitions/${id}/status`);
  }

  async getDefinitionDiff(id: string): Promise<object> {
    return this.req('GET', `/v1/definitions/${id}/diff`);
  }

  async getDefinitionStats(id: string): Promise<object> {
    return this.req('GET', `/v1/definitions/${id}/stats`);
  }

  async getMachineStats(machineId: string): Promise<object> {
    return this.req('GET', `/v1/machines/${machineId}/stats`);
  }

  async listDefinitions(opts: { limit?: number; offset?: number } = {}): Promise<object> {
    return this.req('GET', '/v1/definitions', undefined, opts);
  }

  // ── Actors ────────────────────────────────────────────────────────────────

  async spawn(
    definitionId:   string,
    initialContext: Record<string, unknown> = {},
  ): Promise<Actor> {
    const res = await this.req<any>('POST', '/v1/actors', { definitionId, initialContext });
    // Spawn response uses { id } — normalize to { actorId } for consistent interface
    if (res?.id && !res.actorId) res.actorId = res.id;
    return res as Actor;
  }

  async send(
    actorId:         string,
    eventType:       string,
    payload:         Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<Actor> {
    const body: Record<string, unknown> = { type: eventType, payload };
    if (idempotencyKey) body.idempotencyKey = idempotencyKey;
    return this.req('POST', `/v1/actors/${actorId}/event`, body);
  }

  async getState(actorId: string): Promise<Actor> {
    return this.req('GET', `/v1/actors/${actorId}`);
  }

  async getEvents(
    actorId: string,
    opts:    { limit?: number; after?: number } = {},
  ): Promise<EventsResult> {
    return this.req('GET', `/v1/actors/${actorId}/events`, undefined, opts);
  }

  async getDecisions(actorId: string): Promise<object> {
    return this.req('GET', `/v1/actors/${actorId}/decisions`);
  }

  async exportActor(actorId: string): Promise<object> {
    return this.req('GET', `/v1/actors/${actorId}/export`);
  }

  async terminate(actorId: string): Promise<void> {
    await this.req('DELETE', `/v1/actors/${actorId}`);
  }

  async rescueActor(actorId: string): Promise<Actor> {
    return this.req('PATCH', `/v1/actors/${actorId}`, { status: 'active' });
  }

  async listActors(opts: {
    status?:    string;
    machineId?: string;
    state?:     string;
    limit?:     number;
    offset?:    number;
  } = {}): Promise<{ actors: Actor[]; count: number }> {
    return this.req('GET', '/v1/actors', undefined, opts);
  }

  async listNeedsRescue(opts: {
    definitionId?: string;
    limit?:        number;
    offset?:       number;
  } = {}): Promise<{ actors: Actor[]; count: number }> {
    return this.req('GET', '/v1/actors/needs-rescue', undefined, opts);
  }

  // ── Scheduled events ──────────────────────────────────────────────────────

  async schedule(
    actorId:   string,
    eventType: string,
    opts:      { delay?: number; fireAt?: number; payload?: Record<string, unknown> },
  ): Promise<ScheduledEvent> {
    const { delay, fireAt, payload } = opts;
    if (!delay && !fireAt) throw new Error('Provide either delay (ms) or fireAt (unix ms timestamp)');
    if (delay && fireAt)   throw new Error('Provide either delay or fireAt, not both');
    const resolvedFireAt = fireAt ?? (Date.now() + delay!);
    const res = await this.req<any>('POST', `/v1/actors/${actorId}/schedule`,
      { type: eventType, payload, fireAt: resolvedFireAt });
    if (res?.type && !res.eventType) res.eventType = res.type;
    return res as ScheduledEvent;
  }

  async listScheduled(
    actorId: string,
    opts:    { status?: string } = {},
  ): Promise<{ scheduled: ScheduledEvent[]; count: number }> {
    return this.req('GET', `/v1/actors/${actorId}/schedule`, undefined, opts);
  }

  async cancelScheduled(actorId: string, scheduleId: string): Promise<void> {
    await this.req('DELETE', `/v1/actors/${actorId}/schedule/${scheduleId}`);
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async createWebhook(opts: {
    url:    string;
    secret: string;
    events: string[];
  }): Promise<object> {
    return this.req('POST', '/v1/webhooks', opts);
  }

  async listWebhooks(): Promise<object> {
    return this.req('GET', '/v1/webhooks');
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.req('DELETE', `/v1/webhooks/${webhookId}`);
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async health(): Promise<{ status: string }> {
    return this.req('GET', '/v1/health');
  }

  async workerHealth(): Promise<object> {
    return this.req('GET', '/v1/health/workers');
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createClient(config: StateKeepConfig): StateKeepClient {
  return new StateKeepClient(config);
}
